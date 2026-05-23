import { getBotClient } from "./slack";
import { env } from "./env";
import { identifyRecipient } from "./recipient";
import { STAFF, findStaffById, type StaffMember } from "./roster";
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
 * Top-level DM handler. The decision tree:
 *
 *   1. Find all outstanding drafts in the recent DM history.
 *   2. Ask the LLM to classify: is this new feedback, or a revision of
 *      one of the outstanding drafts? If revise, which one?
 *   3. Route to the appropriate flow.
 *
 * Multiple outstanding drafts can coexist — we don't supersede them
 * just because a new request came in. The owner can keep multiple
 * drafts in flight (e.g. one for Brendy, one for Patricia) and we
 * route revisions to the right one.
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

  // Classify intent. If there are no outstanding drafts, the classifier
  // short-circuits to "new" without making an LLM call.
  const intent = await classifyIntent({
    text,
    outstandingDrafts: outstandingDrafts.map((d) => ({
      recipientName: d.recipientName,
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
    // Fall through to the new-feedback path if the target index was bad.
    console.warn(
      "[slack] intent said revise draftIndex=%d but only %d outstanding — falling through to new",
      intent.draftIndex,
      outstandingDrafts.length,
    );
  }

  // New feedback. Now we need to figure out who it's for.
  const recipientMatch = identifyRecipient(text);
  if (recipientMatch.kind === "found") {
    await handleFreshDraft({
      event,
      text,
      fileCount,
      recipient: recipientMatch.person,
    });
    return;
  }

  await postPlain({
    channel: event.channel,
    text: buildClarifyReply({ match: recipientMatch, fileCount }),
  });
}

async function handleFreshDraft({
  event,
  text,
  fileCount,
  recipient,
}: {
  event: SlackMessageEvent;
  text: string;
  fileCount: number;
  recipient: StaffMember;
}) {
  await postPlain({
    channel: event.channel,
    text: `:writing_hand: Drafting a message for *${recipient.name}*...`,
  });

  let draft: string;
  try {
    draft = await draftMessage({
      rawInput: text,
      recipient,
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
    recipient,
    originalInput: text,
    draft,
    attachmentCount: fileCount,
  });
}

async function markDraftSuperseded({
  channel,
  ts,
  recipientName,
}: {
  channel: string;
  ts: string;
  recipientName: string;
}): Promise<void> {
  try {
    await getBotClient().chat.update({
      channel,
      ts,
      text: `~Earlier draft to ${recipientName}~ — superseded.`,
      blocks: buildSupersededBlocks({ recipientName }),
    });
  } catch (err) {
    console.error("[slack] failed to supersede earlier draft", err);
    // Don't throw — superseding is housekeeping, not critical-path.
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
    // E.g. the owner sent only a photo with no text. Treat as a new
    // request rather than a revision — we have no instructions to apply.
    await postPlain({
      channel: event.channel,
      text:
        ":thinking_face: I see an attachment but no instructions. " +
        "If you want to revise the previous draft, tell me what to change.",
    });
    return;
  }

  const recipient = findStaffById(outstanding.recipientId);
  if (!recipient) {
    // Should be impossible, but be safe.
    await postPlain({
      channel: event.channel,
      text:
        ":warning: Couldn't find that staff member in the roster anymore. " +
        "Start a new draft and mention them by name.",
    });
    return;
  }

  await postPlain({
    channel: event.channel,
    text: `:writing_hand: Revising the draft for *${recipient.name}*...`,
  });

  let newDraft: string;
  try {
    newDraft = await draftMessage({
      rawInput: outstanding.originalInput,
      recipient,
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

  // Visually retire the prior draft message. This update removes its
  // send_draft action button, so subsequent history scans won't pick
  // this message up as outstanding.
  await markDraftSuperseded({
    channel: event.channel,
    ts: outstanding.messageTs,
    recipientName: recipient.name,
  });

  await postDraftWithButtons({
    channel: event.channel,
    recipient,
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

/**
 * Look at the recent DM history and find ALL outstanding drafts (i.e.,
 * bot messages still showing send_draft buttons). Returned newest-first.
 *
 * Multiple drafts can be in flight at once: e.g., the owner drafted a
 * Brendy message, then started a Patricia message before sending the
 * Brendy one. The classifier (lib/intent.ts) decides which one — if any
 * — a new owner message refers to.
 */
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
      // Look back further than the single-draft logic did, since multiple
      // drafts can pile up. We still cap to keep latency low and avoid
      // bloating the classifier prompt.
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
    // On failure, fall back to "no outstanding drafts" so we never block
    // the owner. Worst case: they need to re-mention the recipient.
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
  recipient,
  originalInput,
  draft,
  attachmentCount,
}: {
  channel: string;
  recipient: StaffMember;
  originalInput: string;
  draft: string;
  attachmentCount: number;
}): Promise<void> {
  const state: DraftState = {
    recipientId: recipient.slackUserId,
    recipientName: recipient.name,
    originalInput,
    draft,
    attachmentCount,
  };

  await getBotClient().chat.postMessage({
    channel,
    text: `Draft to ${recipient.name}: ${draft}`, // fallback for notifications
    blocks: buildDraftBlocks({ state }),
  });
}

function buildClarifyReply({
  match,
  fileCount,
}: {
  match: ReturnType<typeof identifyRecipient>;
  fileCount: number;
}): string {
  const attachmentNote =
    fileCount > 0
      ? `_(${fileCount} attachment${
          fileCount === 1 ? "" : "s"
        } noted — I'll include them when sending.)_`
      : "";

  if (match.kind === "ambiguous") {
    const names = match.candidates.map((c) => `*${c.name}*`).join(", ");
    return [
      `:thinking_face: I matched more than one person: ${names}.`,
      "",
      "Reply with just the first name and I'll draft.",
      attachmentNote,
    ]
      .filter(Boolean)
      .join("\n");
  }

  const allNames = STAFF.map((s) => `*${s.name}*`).join(", ");
  return [
    ":question: I'm not sure who this is for.",
    "",
    `Staff I know: ${allNames}.`,
    "",
    "Mention one of them by name (or @-mention them) and I'll draft.",
    attachmentNote,
  ]
    .filter(Boolean)
    .join("\n");
}
