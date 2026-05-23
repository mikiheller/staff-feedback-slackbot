import { getBotClient } from "./slack";
import { env } from "./env";
import { STAFF, type StaffMember } from "./roster";
import { draftMessage } from "./draft";
import {
  buildDraftBlocks,
  destinationFromState,
  extractDraftStateFromBlocks,
  type DraftState,
} from "./slack-blocks";
import { identifyRecipients } from "./intent";
import { resolveDestination } from "./routing";

type SlackMessageEvent = {
  type: "message";
  channel: string;
  channel_type?: string;
  user?: string;
  text?: string;
  ts: string;
  /** Set when the message is part of a thread. If equal to ts, it's the
   * thread parent. If different, it's a reply in the thread. */
  thread_ts?: string;
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
  if (event.type !== "message") return null;
  if (event.channel_type !== "im") return null;
  if (event.bot_id) return null;
  if (event.user !== env.OWNER_SLACK_USER_ID) return null;
  const allowedSubtypes = new Set([undefined, "file_share"]);
  if (!allowedSubtypes.has(event.subtype)) return null;
  return event;
}

/* -------------------------------------------------------------------------- */
/*                            Top-level handler                               */
/* -------------------------------------------------------------------------- */

/**
 * Routes the incoming DM:
 *   - Top-level message → new request flow (start a thread, post draft)
 *   - Thread reply       → revision flow (find prior draft, redraft)
 */
export async function handleOwnerMessage(
  event: SlackMessageEvent,
): Promise<void> {
  const isThreadReply =
    typeof event.thread_ts === "string" && event.thread_ts !== event.ts;

  if (isThreadReply) {
    await handleThreadReply(event);
    return;
  }
  await handleNewRequest(event);
}

/* -------------------------------------------------------------------------- */
/*                          New request (top-level)                           */
/* -------------------------------------------------------------------------- */

async function handleNewRequest(event: SlackMessageEvent): Promise<void> {
  const text = (event.text ?? "").trim();
  const fileCount = event.files?.length ?? 0;

  if (!text) {
    await postInThread({
      channel: event.channel,
      thread_ts: event.ts,
      text: ":thinking_face: I see attachments but no instructions — tell me what to say and who to send it to.",
    });
    return;
  }

  const recipients = await identifyRecipients(text);

  if (recipients.length === 0) {
    await postInThread({
      channel: event.channel,
      thread_ts: event.ts,
      text: ":thinking_face: Who's this for? Tell me the name(s) (e.g. \"Brendy\" or \"Patricia and Giuliane\") and I'll draft.",
    });
    return;
  }

  const routing = resolveDestination(recipients);
  if (!routing.ok) {
    await postInThread({
      channel: event.channel,
      thread_ts: event.ts,
      text: `:warning: ${routing.message}`,
    });
    return;
  }

  let draft: string;
  try {
    draft = await draftMessage({ rawInput: text, recipients });
  } catch (err) {
    console.error("[draft] generation failed", err);
    await postInThread({
      channel: event.channel,
      thread_ts: event.ts,
      text: `:warning: Couldn't generate the draft. ${
        err instanceof Error ? `(${err.message})` : ""
      }`,
    });
    return;
  }

  await postDraftInThread({
    channel: event.channel,
    thread_ts: event.ts,
    draft,
    originalInput: text,
    recipients,
    destination: routing.destination,
    attachmentCount: fileCount,
  });
}

/* -------------------------------------------------------------------------- */
/*                          Thread reply (revisions)                          */
/* -------------------------------------------------------------------------- */

async function handleThreadReply(event: SlackMessageEvent): Promise<void> {
  const revisionText = (event.text ?? "").trim();
  if (!revisionText) {
    await postInThread({
      channel: event.channel,
      thread_ts: event.thread_ts!,
      text: ":thinking_face: I see an attachment but no instructions — tell me what to change.",
    });
    return;
  }

  const last = await findLastDraftInThread({
    channel: event.channel,
    thread_ts: event.thread_ts!,
    excludeTs: event.ts,
  });

  if (!last) {
    // No prior draft in this thread. Likely the bot asked a clarifying
    // question and the owner is answering it — combine the parent
    // message + this reply and try drafting fresh.
    await handleClarifyingAnswer(event);
    return;
  }

  if (last.alreadySent) {
    await postInThread({
      channel: event.channel,
      thread_ts: event.thread_ts!,
      text: ":envelope: This thread was already sent. Start a new top-level message for additional feedback.",
    });
    return;
  }

  // Resolve recipients from names (we packed only names into state).
  const recipients = STAFF.filter((s) =>
    last.state.recipientNames.includes(s.name),
  );
  if (recipients.length === 0) {
    await postInThread({
      channel: event.channel,
      thread_ts: event.thread_ts!,
      text: ":warning: I couldn't resolve the recipients of the prior draft. Start over with a fresh top-level message.",
    });
    return;
  }

  const routing = resolveDestination(recipients);
  if (!routing.ok) {
    await postInThread({
      channel: event.channel,
      thread_ts: event.thread_ts!,
      text: `:warning: ${routing.message}`,
    });
    return;
  }

  let newDraft: string;
  try {
    newDraft = await draftMessage({
      rawInput: last.state.originalInput,
      recipients,
      previousDraft: last.state.draft,
      revisionInstructions: revisionText,
    });
  } catch (err) {
    console.error("[draft] revision failed", err);
    await postInThread({
      channel: event.channel,
      thread_ts: event.thread_ts!,
      text: `:warning: Couldn't revise the draft. ${
        err instanceof Error ? `(${err.message})` : ""
      }`,
    });
    return;
  }

  await postDraftInThread({
    channel: event.channel,
    thread_ts: event.thread_ts!,
    draft: newDraft,
    originalInput: last.state.originalInput,
    recipients,
    destination: routing.destination,
    attachmentCount: last.state.attachmentCount,
  });
}

/**
 * The owner replied in a thread that has no prior draft yet — most
 * likely because the bot asked them a clarifying question. Fetch the
 * parent + their reply, combine, and try a fresh draft.
 */
async function handleClarifyingAnswer(
  event: SlackMessageEvent,
): Promise<void> {
  const replies = await fetchThreadReplies({
    channel: event.channel,
    thread_ts: event.thread_ts!,
  });
  const parent = replies[0];
  const parentText = (parent?.text as string | undefined)?.trim() ?? "";
  const replyText = (event.text ?? "").trim();
  // Combine parent and reply so the recipient identifier sees both.
  const combinedText =
    parentText && replyText
      ? `${parentText}\n\nClarification: ${replyText}`
      : parentText || replyText;

  const recipients = await identifyRecipients(combinedText);
  if (recipients.length === 0) {
    await postInThread({
      channel: event.channel,
      thread_ts: event.thread_ts!,
      text: ":thinking_face: Still not sure who this is for. Try mentioning a name (Brendy, Patricia, etc.).",
    });
    return;
  }

  const routing = resolveDestination(recipients);
  if (!routing.ok) {
    await postInThread({
      channel: event.channel,
      thread_ts: event.thread_ts!,
      text: `:warning: ${routing.message}`,
    });
    return;
  }

  let draft: string;
  try {
    draft = await draftMessage({ rawInput: combinedText, recipients });
  } catch (err) {
    console.error("[draft] generation failed", err);
    await postInThread({
      channel: event.channel,
      thread_ts: event.thread_ts!,
      text: `:warning: Couldn't generate the draft. ${
        err instanceof Error ? `(${err.message})` : ""
      }`,
    });
    return;
  }

  await postDraftInThread({
    channel: event.channel,
    thread_ts: event.thread_ts!,
    draft,
    originalInput: combinedText,
    recipients,
    destination: routing.destination,
    attachmentCount: 0,
  });
}

/* -------------------------------------------------------------------------- */
/*                              History helpers                               */
/* -------------------------------------------------------------------------- */

type LastDraftInfo = {
  state: DraftState;
  messageTs: string;
  alreadySent: boolean;
};

const SENT_MARKER = "[sent]";

async function findLastDraftInThread({
  channel,
  thread_ts,
  excludeTs,
}: {
  channel: string;
  thread_ts: string;
  excludeTs: string;
}): Promise<LastDraftInfo | null> {
  const replies = await fetchThreadReplies({ channel, thread_ts });

  // Walk newest-to-oldest looking for a bot draft message. If we
  // encounter a "sent" confirmation before finding the draft, the
  // most recent draft has already been sent.
  let alreadySent = false;
  for (let i = replies.length - 1; i >= 0; i--) {
    const m = replies[i];
    if (m.ts === excludeTs) continue;
    if (!m.bot_id) continue;
    const text = typeof m.text === "string" ? m.text : "";
    if (text.startsWith(SENT_MARKER)) {
      alreadySent = true;
      continue;
    }
    const state = extractDraftStateFromBlocks(m.blocks);
    if (state) {
      return { state, messageTs: m.ts!, alreadySent };
    }
  }
  return null;
}

async function fetchThreadReplies({
  channel,
  thread_ts,
}: {
  channel: string;
  thread_ts: string;
}): Promise<
  Array<{
    ts?: string;
    text?: string;
    bot_id?: string;
    user?: string;
    blocks?: unknown[];
  }>
> {
  try {
    const res = await getBotClient().conversations.replies({
      channel,
      ts: thread_ts,
      limit: 100,
    });
    return (res.messages ?? []) as Array<{
      ts?: string;
      text?: string;
      bot_id?: string;
      user?: string;
      blocks?: unknown[];
    }>;
  } catch (err) {
    console.error("[slack] conversations.replies failed", err);
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/*                                  Posting                                   */
/* -------------------------------------------------------------------------- */

async function postInThread({
  channel,
  thread_ts,
  text,
}: {
  channel: string;
  thread_ts: string;
  text: string;
}): Promise<void> {
  await getBotClient().chat.postMessage({ channel, thread_ts, text });
}

async function postDraftInThread({
  channel,
  thread_ts,
  draft,
  originalInput,
  recipients,
  destination,
  attachmentCount,
}: {
  channel: string;
  thread_ts: string;
  draft: string;
  originalInput: string;
  recipients: StaffMember[];
  destination: import("./routing").Destination;
  attachmentCount: number;
}): Promise<void> {
  const state: DraftState = {
    destPacked: "", // filled in by buildDraftBlocks via the destination arg
    recipientNames: recipients.map((r) => r.name),
    originalInput,
    draft,
    attachmentCount,
  };

  await getBotClient().chat.postMessage({
    channel,
    thread_ts,
    text: draft, // notification fallback
    blocks: buildDraftBlocks({ state, destination }),
  });
}

export const SENT_CONFIRMATION_MARKER = SENT_MARKER;
export type _ExportedDraftState = DraftState;
export { destinationFromState };
