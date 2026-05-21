import { getBotClient } from "./slack";
import { env } from "./env";
import { identifyRecipient } from "./recipient";
import { STAFF, type StaffMember } from "./roster";
import { draftMessage } from "./draft";

/**
 * Shape of a Slack `message` event we care about. We don't import the full
 * @slack/web-api types here because Events API event payloads aren't quite
 * the same shape as Web API request/response types.
 */
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

/**
 * Decide whether an incoming Slack event should be processed at all.
 * Returns `null` if we should ignore it, otherwise returns the event.
 */
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

  // Allow plain messages and file-share messages. Reject everything else
  // (edits, deletes, channel joins, etc.).
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
 * Step 4: identify recipient, then draft a polished message via Claude
 * (routed through Vercel's AI Gateway). The draft is posted back to the
 * owner's DM with the bot. Iteration buttons (Send / Revise / Cancel)
 * come in the next step.
 */
export async function handleOwnerMessage(
  event: SlackMessageEvent,
): Promise<void> {
  const text = (event.text ?? "").trim();
  const fileCount = event.files?.length ?? 0;

  const match = identifyRecipient(text);

  // No recipient (or ambiguous) — ask the owner to clarify.
  if (match.kind !== "found") {
    await postPlain({
      channel: event.channel,
      text: buildClarifyReply({ match, fileCount }),
    });
    return;
  }

  // Recipient found. Acknowledge immediately so the user knows we're on it.
  await postPlain({
    channel: event.channel,
    text: `:writing_hand: Drafting a message for *${match.person.name}*...`,
  });

  // Generate the draft. If anything blows up, surface a friendly error.
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

  await postDraft({
    channel: event.channel,
    recipient: match.person,
    draft,
    fileCount,
  });
}

async function postPlain({
  channel,
  text,
}: {
  channel: string;
  text: string;
}): Promise<void> {
  await getBotClient().chat.postMessage({ channel, text });
}

async function postDraft({
  channel,
  recipient,
  draft,
  fileCount,
}: {
  channel: string;
  recipient: StaffMember;
  draft: string;
  fileCount: number;
}): Promise<void> {
  const attachmentNote =
    fileCount > 0
      ? `\n\n_(${fileCount} attachment${
          fileCount === 1 ? "" : "s"
        } will be included when sending.)_`
      : "";
  const body = [
    `Here's a draft to *${recipient.name}*:`,
    "",
    "```",
    draft,
    "```",
    attachmentNote,
    "",
    "_(Send / revise buttons come in the next step. For now, reply with feedback and I'll re-draft on the next message.)_",
  ]
    .filter(Boolean)
    .join("\n");

  await getBotClient().chat.postMessage({ channel, text: body });
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
      "Reply with just the first name and I'll re-draft.",
      attachmentNote,
    ]
      .filter(Boolean)
      .join("\n");
  }

  // match.kind === "none"
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
