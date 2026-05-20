import { getBotClient } from "./slack";
import { env } from "./env";

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
 * For Step 2 we just echo what the owner said, plus a note that real
 * drafting features are coming. This proves the round-trip: Slack -> us
 * -> Slack -> the owner's DM with the bot.
 */
export async function handleOwnerMessage(
  event: SlackMessageEvent,
): Promise<void> {
  const text = (event.text ?? "").trim();
  const fileCount = event.files?.length ?? 0;

  const summary = [
    text ? `> ${text.replace(/\n/g, "\n> ")}` : "_(no text)_",
    fileCount > 0
      ? `\n_Got ${fileCount} attachment${fileCount === 1 ? "" : "s"}._`
      : "",
  ]
    .join("")
    .trim();

  const reply = [
    ":white_check_mark: Got it. Here's what I heard:",
    "",
    summary,
    "",
    "_Drafting and send-as-you features come online in the next steps._",
  ].join("\n");

  console.log("[slack] posting reply to channel=%s", event.channel);
  try {
    const result = await getBotClient().chat.postMessage({
      channel: event.channel,
      text: reply,
      // Reply in the same DM (no thread) so the conversation feels natural.
    });
    console.log(
      "[slack] reply posted ok=%s ts=%s",
      result.ok,
      result.ts,
    );
  } catch (err) {
    console.error("[slack] chat.postMessage failed", err);
    throw err;
  }
}
