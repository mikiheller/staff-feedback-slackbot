import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "./env";

/**
 * Verifies that a Slack request actually came from Slack.
 * https://api.slack.com/authentication/verifying-requests-from-slack
 *
 * We must work with the raw request body string — JSON.parse first would lose
 * exact byte fidelity and break the signature.
 */
export function verifySlackSignature({
  rawBody,
  signature,
  timestamp,
}: {
  rawBody: string;
  signature: string | null;
  timestamp: string | null;
}): boolean {
  if (!signature || !timestamp) return false;

  // Reject anything older than 5 minutes (replay protection)
  const fiveMinutes = 60 * 5;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > fiveMinutes) return false;

  const baseString = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${createHmac("sha256", env.SLACK_SIGNING_SECRET)
    .update(baseString)
    .digest("hex")}`;

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return false;
  return timingSafeEqual(sigBuf, expBuf);
}

export function isOwner(userId: string | undefined | null): boolean {
  if (!userId) return false;
  return userId === env.OWNER_SLACK_USER_ID;
}
