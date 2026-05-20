import { NextResponse } from "next/server";
import { after } from "next/server";
import { verifySlackSignature } from "@/lib/slack-verify";
import {
  handleOwnerMessage,
  pickActionableMessage,
} from "@/lib/slack-events";

// We must run on Node.js (not Edge) because we use the `crypto` module
// for signature verification, and the Slack SDK is built for Node.
export const runtime = "nodejs";

export async function POST(req: Request) {
  const rawBody = await req.text();

  const valid = verifySlackSignature({
    rawBody,
    signature: req.headers.get("x-slack-signature"),
    timestamp: req.headers.get("x-slack-request-timestamp"),
  });
  if (!valid) {
    return new NextResponse("invalid signature", { status: 401 });
  }

  const payload = JSON.parse(rawBody) as Record<string, unknown>;

  // 1) Slack URL verification handshake (one-time, when you paste the URL
  // into the Slack admin).
  if (payload.type === "url_verification") {
    return NextResponse.json({ challenge: payload.challenge });
  }

  // 2) Slack retries an event if we don't 200 fast enough. Since we're
  // using `after()` to ack immediately, retries shouldn't normally happen,
  // but if they do we just drop them to avoid double-replying.
  const retryNum = req.headers.get("x-slack-retry-num");
  if (retryNum && Number(retryNum) > 0) {
    console.log(
      `[slack] skipping retry #${retryNum} reason=${req.headers.get(
        "x-slack-retry-reason",
      )}`,
    );
    return new NextResponse("ok");
  }

  // 3) Real event callbacks. We ack within 3s by responding immediately
  // and doing the work via `after()`.
  if (payload.type === "event_callback") {
    console.log(
      "[slack] event_callback received event_id=%s",
      (payload as { event_id?: string }).event_id,
    );
    const envelope = payload as Parameters<typeof pickActionableMessage>[0];
    const event = pickActionableMessage(envelope);

    if (event) {
      after(async () => {
        try {
          await handleOwnerMessage(event);
        } catch (err) {
          console.error("[slack] failed to handle owner message", err);
        }
      });
    }
  } else {
    console.log("[slack] unknown payload type=%s", payload.type);
  }

  return new NextResponse("ok");
}
