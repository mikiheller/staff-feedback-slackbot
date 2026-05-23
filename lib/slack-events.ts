import { getBotClient } from "./slack";
import { env } from "./env";
import { STAFF, type StaffMember } from "./roster";
import { draftMessage } from "./draft";
import {
  buildDraftBlocks,
  buildSupersededBlocks,
  extractDraftStateFromBlocks,
  type DraftState,
} from "./slack-blocks";
import { classifyIntent } from "./intent";

type SlackMessageEvent = {
  type: "message";
  channel: string;
  channel_type?: string;
  user?: string;
  text?: string;
  ts: string;
  bot_id?: string;
  subtype?: string;
  files?: Array<{ id: string; name?: string; mimetype?: string }>;
};

type SlackEventEnvelope = {
  type: "event_callback";
  event_id: string;
  event: SlackMessageEvent;
};

export function pickActionableMessage(
  envelope: SlackEventEnvelope,
): SlackMessageEvent | null {
  const event = envelope.event;

  if (event.type !== "message") {
    console.log("[slack] skip: not a message event, type=%s", event.type);
    return null;
  }
  if (event.channel_type !== "im") {
    console.log("[slack] skip: not a DM, channel_type=%s", event.channel_type);
    return null;
  }
  if (event.bot_id) {
    console.log("[slack] skip: bot_id present (%s)", event.bot_id);
    return null;
  }
  if (event.user !== env.OWNER_SLACK_USER_ID) {
    console.log(
      "[slack] skip: user mismatch — got=%s expected=%s",
      event.user,
      env.OWNER_SLACK_USER_ID,
    );
    return null;
  }

  const allowedSubtypes = new Set([undefined, "file_share"]);
  if (!allowedSubtypes.has(event.subtype)) {
    console.log("[slack] skip: unwanted subtype=%s", event.subtype);
    return null;
  }

  console.log(
    "[slack] accept: message from owner channel=%s ts=%s len=%d files=%d",
    event.channel,
    event.ts,
    (event.text ?? "").length,
    event.files?.length ?? 0,
  );
  return event;
}

/**
 * Top-level DM handler.
 *
 *   1. Find all outstanding drafts in the recent DM history.
 *   2. Ask the LLM to classify the message as either new feedback (and
 *      identify the intended recipients) or a revision of one of the
 *      outstanding drafts.
 *   3. Route to the appropriate flow.
 *
 * Multiple outstanding drafts can coexist — we don't supersede them
 * just because a new request came in. The owner can have a Brendy and
 * a Patricia draft both in flight.
 */
export async function handleOwnerMessage(
  event: SlackMessageEvent,
): Promise<void> {
  const text = (event.text ?? "").trim();
  const fileCount = event.files?.length ?? 0;

  const outstandingDrafts = await findOutstandingDrafts({
    channel: event.channel,
    currentMessageTs: event.ts,
  });

  const intent = await classifyIntent({
    text,
    outstandingDrafts: outstandingDrafts.map((d) => ({
      recipientNames: d.recipientNames,
      draft: d.draft,
      originalInput: d.originalInput,
    })),
  });

  if (intent.kind === "revise") {
    const target = outstandingDrafts[intent.draftIndex - 1];
    if (target) {
      await handleRevision({
        event,
        revisionText: text,
        outstanding: target,
      });
      return;
    }
    console.warn(
      "[slack] intent said revise draftIndex=%d but only %d outstanding — falling through",
      intent.draftIndex,
      outstandingDrafts.length,
    );
  }

  // New feedback path.
  if (intent.kind === "new" && intent.recipients.length > 0) {
    await handleFreshDraft({
      event,
      text,
      fileCount,
      recipients: intent.recipients,
    });
    return;
  }

  // No intended recipients identified.
  await postPlain({
    channel: event.channel,
    text: buildClarifyReply({ fileCount }),
  });
}

async function handleFreshDraft({
  event,
  text,
  fileCount,
  recipients,
}: {
  event: SlackMessageEvent;
  text: string;
  fileCount: number;
  recipients: StaffMember[];
}) {
  const namesJoined = formatNames(recipients.map((r) => r.name));
  await postPlain({
    channel: event.channel,
    text: `:writing_hand: Drafting a message for *${namesJoined}*...`,
  });

  let draft: string;
  try {
    draft = await draftMessage({
      rawInput: text,
      recipients,
    });
  } catch (err) {
    console.error("[draft] generation failed", err);
    await postPlain({
      channel: event.channel,
      text: `:warning: Sorry, I couldn't generate the draft. ${
        err instanceof Error ? `(${err.message})` : ""
      }`,
    });
    return;
  }

  await postDraftWithButtons({
    channel: event.channel,
    recipients,
    originalInput: text,
    draft,
    attachmentCount: fileCount,
  });
}

async function markDraftSuperseded({
  channel,
  ts,
  recipientNames,
  draft,
}: {
  channel: string;
  ts: string;
  recipientNames: string[];
  draft: string;
}): Promise<void> {
  try {
    await getBotClient().chat.update({
      channel,
      ts,
      text: `Earlier draft to ${formatNames(recipientNames)} — revised below.`,
      blocks: buildSupersededBlocks({ recipientNames, draft }),
    });
  } catch (err) {
    console.error("[slack] failed to supersede earlier draft", err);
  }
}

async function handleRevision({
  event,
  revisionText,
  outstanding,
}: {
  event: SlackMessageEvent;
  revisionText: string;
  outstanding: OutstandingDraft;
}) {
  if (!revisionText) {
    await postPlain({
      channel: event.channel,
      text:
        ":thinking_face: I see an attachment but no instructions. " +
        "If you want to revise the previous draft, tell me what to change.",
    });
    return;
  }

  // Resolve recipientIds back to StaffMember entries.
  const recipients: StaffMember[] = [];
  for (const id of outstanding.recipientIds) {
    const m = STAFF.find((s) => s.slackUserId === id);
    if (m) recipients.push(m);
  }
  if (recipients.length === 0) {
    await postPlain({
      channel: event.channel,
      text:
        ":warning: Couldn't find those recipients in the roster anymore. " +
        "Start a new draft and mention them by name.",
    });
    return;
  }

  const namesJoined = formatNames(recipients.map((r) => r.name));
  await postPlain({
    channel: event.channel,
    text: `:writing_hand: Revising the draft for *${namesJoined}*...`,
  });

  let newDraft: string;
  try {
    newDraft = await draftMessage({
      rawInput: outstanding.originalInput,
      recipients,
      previousDraft: outstanding.draft,
      revisionInstructions: revisionText,
    });
  } catch (err) {
    console.error("[draft] revision failed", err);
    await postPlain({
      channel: event.channel,
      text: `:warning: Sorry, couldn't revise the draft. ${
        err instanceof Error ? `(${err.message})` : ""
      }`,
    });
    return;
  }

  await markDraftSuperseded({
    channel: event.channel,
    ts: outstanding.messageTs,
    recipientNames: outstanding.recipientNames,
    draft: outstanding.draft,
  });

  await postDraftWithButtons({
    channel: event.channel,
    recipients,
    originalInput: outstanding.originalInput,
    draft: newDraft,
    attachmentCount: outstanding.attachmentCount,
  });
}

/* -------------------------------------------------------------------------- */
/*                          History lookup for revisions                      */
/* -------------------------------------------------------------------------- */

type OutstandingDraft = DraftState & {
  messageTs: string;
};

async function findOutstandingDrafts({
  channel,
  currentMessageTs,
}: {
  channel: string;
  currentMessageTs: string;
}): Promise<OutstandingDraft[]> {
  const drafts: OutstandingDraft[] = [];
  try {
    const history = await getBotClient().conversations.history({
      channel,
      limit: 30,
    });

    for (const msg of history.messages ?? []) {
      if (msg.ts === currentMessageTs) continue;
      if (!msg.bot_id) continue;
      const state = extractDraftStateFromBlocks(msg.blocks);
      if (state) {
        drafts.push({ ...state, messageTs: msg.ts! });
      }
    }
  } catch (err) {
    console.error("[slack] conversations.history failed", err);
  }
  return drafts;
}

/* -------------------------------------------------------------------------- */
/*                                  Posting                                   */
/* -------------------------------------------------------------------------- */

async function postPlain({
  channel,
  text,
}: {
  channel: string;
  text: string;
}): Promise<void> {
  await getBotClient().chat.postMessage({ channel, text });
}

async function postDraftWithButtons({
  channel,
  recipients,
  originalInput,
  draft,
  attachmentCount,
}: {
  channel: string;
  recipients: StaffMember[];
  originalInput: string;
  draft: string;
  attachmentCount: number;
}): Promise<void> {
  const state: DraftState = {
    recipientIds: recipients.map((r) => r.slackUserId),
    recipientNames: recipients.map((r) => r.name),
    originalInput,
    draft,
    attachmentCount,
  };

  const namesJoined = formatNames(state.recipientNames);
  await getBotClient().chat.postMessage({
    channel,
    text: `Draft to ${namesJoined}: ${draft}`, // notification fallback
    blocks: buildDraftBlocks({ state }),
  });
}

function formatNames(names: string[]): string {
  if (names.length === 0) return "(unknown)";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function buildClarifyReply({ fileCount }: { fileCount: number }): string {
  const attachmentNote =
    fileCount > 0
      ? `_(${fileCount} attachment${
          fileCount === 1 ? "" : "s"
        } noted — I'll include them when sending.)_`
      : "";
  const allNames = STAFF.map((s) => `*${s.name}*`).join(", ");
  return [
    ":question: I'm not sure who this is for.",
    "",
    `Staff I know: ${allNames}.`,
    "",
    "Mention them by name (or @-mention) and I'll draft.",
    attachmentNote,
  ]
    .filter(Boolean)
    .join("\n");
}
