import { NextResponse } from "next/server";
import { verifySlackSignature } from "@/lib/slack-verify";

// Placeholder Events API endpoint. In step 2 we'll wire this up to handle
// `message.im` (DM) events from the owner.
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

  // Slack URL verification handshake (one-time, when you point the app
  // at this URL in the Slack admin).
  if (payload.type === "url_verification") {
    return NextResponse.json({ challenge: payload.challenge });
  }

  // Real events come in here. We'll handle them in step 2.
  return new NextResponse("ok");
}
