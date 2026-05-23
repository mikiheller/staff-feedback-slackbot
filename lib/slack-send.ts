import { getUserClient } from "./slack";
import type { Destination } from "./routing";

/**
 * Send a Slack message to a destination AS the owner.
 *
 * Always uses the owner's user token (xoxp-) so messages appear as
 * normal posts authored by the owner — no bot footprint.
 *
 * Handles three destination kinds:
 *   - channel: channelId already known, just postMessage to it
 *   - mpim:    open a multi-person DM with the listed users (the owner
 *              is implicit because the user token IS them), then post
 *   - dm:      open a 1:1 DM with the user, then post
 */

export type SendResult =
  | { ok: true; channel: string; ts: string }
  | { ok: false; error: string };

export async function sendAsOwner({
  destination,
  text,
}: {
  destination: Destination;
  text: string;
}): Promise<SendResult> {
  const user = getUserClient();

  let channelId: string;
  switch (destination.kind) {
    case "channel":
      channelId = destination.channelId;
      break;
    case "mpim":
    case "dm": {
      const users =
        destination.kind === "dm"
          ? destination.userId
          : destination.otherUserIds.join(",");
      try {
        const opened = await user.conversations.open({ users });
        if (!opened.ok || !opened.channel?.id) {
          return {
            ok: false,
            error: `conversations.open failed: ${opened.error ?? "no channel id"}`,
          };
        }
        channelId = opened.channel.id;
      } catch (err) {
        return {
          ok: false,
          error: `conversations.open threw: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
      break;
    }
  }

  try {
    const posted = await user.chat.postMessage({
      channel: channelId,
      text,
    });
    if (!posted.ok || !posted.ts) {
      return {
        ok: false,
        error: `chat.postMessage failed: ${posted.error ?? "no ts"}`,
      };
    }
    return { ok: true, channel: channelId, ts: posted.ts };
  } catch (err) {
    return {
      ok: false,
      error: `chat.postMessage threw: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}
