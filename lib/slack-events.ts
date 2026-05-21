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
 * Top-level DM handler. Routes to:
 *  - revision flow, if the most recent bot message in the DM is an
 *    outstanding draft
 *  - fresh draft flow, otherwise
 */
export async function handleOwnerMessage(
  event: SlackMessageEvent,
): Promise<void> {
  const text = (event.text ?? "").trim();
  const fileCount = event.files?.length ?? 0;

  const outstandingDraft = await findOutstandingDraft({
    channel: event.channel,
    currentMessageTs: event.ts,
  });

  if (outstandingDraft) {
    await handleRevision({
      event,
      revisionText: text,
      outstanding: outstandingDraft,
    });
    return;
  }

  await handleFreshDraft({ event, text, fileCount });
}

async function handleFreshDraft({
  event,
  text,
  fileCount,
}: {
  event: SlackMessageEvent;
  text: string;
  fileCount: number;
}) {
  const match = identifyRecipient(text);

  if (match.kind !== "found") {
    await postPlain({
      channel: event.channel,
      text: buildClarifyReply({ match, fileCount }),
    });
    return;
  }

  await postPlain({
    channel: event.channel,
    text: `:writing_hand: Drafting a message for *${match.person.name}*...`,
  });

  let draft: string;
  try {
    draft = await draftMessage({
      rawInput: text,
      recipient: match.person,
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
    recipient: match.person,
    originalInput: text,
    draft,
    attachmentCount: fileCount,
  });
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

  // Mark the prior draft message as superseded (visually struck through).
  // Note: this update removes the send_draft action button, so subsequent
  // history scans won't pick this message up as outstanding.
  await getBotClient().chat.update({
    channel: event.channel,
    ts: outstanding.messageTs,
    text: `~Earlier draft to ${recipient.name}~ — revised below.`,
    blocks: buildSupersededBlocks({ recipientName: recipient.name }),
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
 * Look at the recent DM history and find the most recent bot message
 * that is still an outstanding draft (i.e., not yet sent, cancelled, or
 * superseded). If found, the owner's incoming message will be treated as
 * revision instructions for it.
 *
 * We identify a draft message by the presence of a `send_draft` action
 * button in its blocks — and we recover state from that button's `value`.
 */
async function findOutstandingDraft({
  channel,
  currentMessageTs,
}: {
  channel: string;
  currentMessageTs: string;
}): Promise<OutstandingDraft | null> {
  try {
    const history = await getBotClient().conversations.history({
      channel,
      limit: 10,
    });

    // newest first
    for (const msg of history.messages ?? []) {
      if (msg.ts === currentMessageTs) continue; // skip user message
      // Only consider the most recent bot message. If the latest bot
      // message isn't a draft (e.g., it's a "sent" or "cancelled"
      // confirmation, which lacks send_draft buttons), there's no
      // outstanding draft to revise.
      if (!msg.bot_id) continue;
      const state = extractDraftStateFromBlocks(msg.blocks);
      if (state) {
        return { ...state, messageTs: msg.ts! };
      }
      return null;
    }
  } catch (err) {
    console.error("[slack] conversations.history failed", err);
    // On failure, fall back to "no outstanding draft" so we never block
    // the owner. Worst case: they need to re-mention the recipient.
  }
  return null;
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
