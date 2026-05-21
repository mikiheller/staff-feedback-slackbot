import { getBotClient } from "./slack";
import { env } from "./env";
import { identifyRecipient } from "./recipient";
import { STAFF } from "./roster";

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
 * Step 3: figure out who the message is for and acknowledge.
 *
 * If a single staff member can be identified (by @-mention or first-name
 * match), tell the owner who we'll draft for. If we can't tell, list the
 * roster and ask. The actual LLM drafting comes in Step 4.
 */
export async function handleOwnerMessage(
  event: SlackMessageEvent,
): Promise<void> {
  const text = (event.text ?? "").trim();
  const fileCount = event.files?.length ?? 0;

  const match = identifyRecipient(text);
  const reply = buildAckReply({ match, fileCount });

  console.log("[slack] posting reply to channel=%s", event.channel);
  try {
    const result = await getBotClient().chat.postMessage({
      channel: event.channel,
      text: reply,
    });
    console.log("[slack] reply posted ok=%s ts=%s", result.ok, result.ts);
  } catch (err) {
    console.error("[slack] chat.postMessage failed", err);
    throw err;
  }
}

function buildAckReply({
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
  const comingSoon =
    "_Drafting and send-as-you come online in the next step._";

  if (match.kind === "found") {
    return [
      `:white_check_mark: Got it — I'll work on this message for *${match.person.name}*.`,
      attachmentNote,
      "",
      comingSoon,
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (match.kind === "ambiguous") {
    const names = match.candidates.map((c) => `*${c.name}*`).join(", ");
    return [
      `:thinking_face: I matched more than one person: ${names}.`,
      "",
      "Reply with just the first name and I'll pick up from there.",
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
    "Mention one of them by name (or @-mention them) and I'll get drafting.",
    attachmentNote,
  ]
    .filter(Boolean)
    .join("\n");
}
