import { WebClient } from "@slack/web-api";
import { env } from "./env";

/**
 * Two separate clients on purpose:
 *
 * - `getBotClient()` posts messages from the bot user (drafts, control
 *   buttons, acknowledgements — everything the owner sees in their DM
 *   with the bot).
 *
 * - `getUserClient()` posts messages AS the owner. The final, polished
 *   message to a staff member goes out through this client so it appears
 *   as a normal DM from the owner with no bot footprint.
 *
 * Both clients are lazily constructed so that `next build` (which
 * evaluates module-level code while collecting page data) doesn't trip
 * over missing env vars in CI or local builds.
 */

let _botClient: WebClient | undefined;
let _userClient: WebClient | undefined;

export function getBotClient(): WebClient {
  if (!_botClient) _botClient = new WebClient(env.SLACK_BOT_TOKEN);
  return _botClient;
}

export function getUserClient(): WebClient {
  if (!_userClient) _userClient = new WebClient(env.SLACK_USER_TOKEN);
  return _userClient;
}
