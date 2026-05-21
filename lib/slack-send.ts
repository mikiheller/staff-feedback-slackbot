import { getUserClient } from "./slack";

/**
 * Send a DM to a staff member AS the owner.
 *
 * This is the linchpin of the whole bot: by calling chat.postMessage with
 * the owner's *user* token (xoxp-...) instead of the bot token (xoxb-...),
 * the message shows up in the recipient's DM list as if the owner typed
 * it themselves. No "via Staff feedback drafter" footer, no app icon,
 * nothing — indistinguishable from a normal message.
 */
export async function sendAsOwner({
  recipientId,
  text,
}: {
  recipientId: string;
  text: string;
}): Promise<{ ok: true; channel: string; ts: string } | { ok: false; error: string }> {
  const user = getUserClient();

  // Step 1: ensure a DM is open with the recipient (as the owner). This
  // returns the DM channel ID. If a DM already exists this is a no-op.
  let dmChannelId: string;
  try {
    const opened = await user.conversations.open({ users: recipientId });
    if (!opened.ok || !opened.channel?.id) {
      return {
        ok: false,
        error: `conversations.open failed: ${opened.error ?? "no channel id"}`,
      };
    }
    dmChannelId = opened.channel.id;
  } catch (err) {
    return {
      ok: false,
      error: `conversations.open threw: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  // Step 2: post the polished draft AS the owner.
  try {
    const posted = await user.chat.postMessage({
      channel: dmChannelId,
      text,
    });
    if (!posted.ok || !posted.ts) {
      return {
        ok: false,
        error: `chat.postMessage failed: ${posted.error ?? "no ts"}`,
      };
    }
    return { ok: true, channel: dmChannelId, ts: posted.ts };
  } catch (err) {
    return {
      ok: false,
      error: `chat.postMessage threw: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}
