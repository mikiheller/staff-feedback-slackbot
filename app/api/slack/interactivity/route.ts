import { NextResponse } from "next/server";
import { verifySlackSignature } from "@/lib/slack-verify";

// Placeholder endpoint for button clicks (Send / Revise / Cancel).
// We'll wire this up in step 5 once the drafting loop exists.
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

  return new NextResponse("ok");
}
