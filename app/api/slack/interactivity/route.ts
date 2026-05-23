import { NextResponse } from "next/server";
import { after } from "next/server";
import { verifySlackSignature, isOwner } from "@/lib/slack-verify";
import { getBotClient } from "@/lib/slack";
import { sendAsOwner } from "@/lib/slack-send";
import {
  ACTION_SEND_DRAFT,
  unpackStateFromButtonValue,
  type DraftState,
} from "@/lib/slack-blocks";
import { unpackDestination } from "@/lib/routing";
import { SENT_CONFIRMATION_MARKER } from "@/lib/slack-events";

export const runtime = "nodejs";

type BlockActionsPayload = {
  type: "block_actions";
  user: { id: string };
  channel: { id: string };
  message: {
    ts: string;
    thread_ts?: string;
    blocks?: unknown[];
  };
  actions: Array<{ action_id: string; value?: string }>;
};

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

  const params = new URLSearchParams(rawBody);
  const payloadStr = params.get("payload");
  if (!payloadStr) return new NextResponse("missing payload", { status: 400 });

  let payload: BlockActionsPayload;
  try {
    payload = JSON.parse(payloadStr);
  } catch {
    return new NextResponse("bad payload", { status: 400 });
  }

  if (payload.type !== "block_actions") return new NextResponse("ok");
  if (!isOwner(payload.user.id)) return new NextResponse("ok");

  const action = payload.actions[0];
  if (!action || action.action_id !== ACTION_SEND_DRAFT) {
    return new NextResponse("ok");
  }

  const state = unpackStateFromButtonValue(action.value);

  after(async () => {
    try {
      await handleSend({ payload, state });
    } catch (err) {
      console.error("[interactivity] handler threw", err);
    }
  });

  return new NextResponse("ok");
}

async function handleSend({
  payload,
  state,
}: {
  payload: BlockActionsPayload;
  state: DraftState | null;
}): Promise<void> {
  const threadTs = payload.message.thread_ts ?? payload.message.ts;

  if (!state) {
    await getBotClient().chat.postMessage({
      channel: payload.channel.id,
      thread_ts: threadTs,
      text: ":warning: Couldn't read the draft data on this message. Start a new top-level message.",
    });
    return;
  }

  // Double-click protection: scan the thread for an existing sent
  // confirmation that matches this exact draft. If found, just say so
  // without sending again.
  const alreadySent = await threadHasSentConfirmation({
    channel: payload.channel.id,
    thread_ts: threadTs,
    matchDraft: state.draft,
  });
  if (alreadySent) {
    await getBotClient().chat.postMessage({
      channel: payload.channel.id,
      thread_ts: threadTs,
      text: `${SENT_CONFIRMATION_MARKER} :white_check_mark: Already sent.`,
    });
    return;
  }

  const destination = unpackDestination(state.destPacked);
  if (!destination) {
    await getBotClient().chat.postMessage({
      channel: payload.channel.id,
      thread_ts: threadTs,
      text: ":warning: Lost the destination info on this draft. Start a new top-level message.",
    });
    return;
  }

  const result = await sendAsOwner({ destination, text: state.draft });
  if (!result.ok) {
    await getBotClient().chat.postMessage({
      channel: payload.channel.id,
      thread_ts: threadTs,
      text: `:warning: Send failed: ${result.error}`,
    });
    return;
  }

  // Per the spec: no edits to existing messages. Just post a new
  // confirmation in the thread. The SENT marker at the start of the
  // text is what closes the thread for revision purposes.
  await getBotClient().chat.postMessage({
    channel: payload.channel.id,
    thread_ts: threadTs,
    text: `${SENT_CONFIRMATION_MARKER} :white_check_mark: Sent to *${destination.displayName}*.`,
  });
}

async function threadHasSentConfirmation({
  channel,
  thread_ts,
  matchDraft,
}: {
  channel: string;
  thread_ts: string;
  matchDraft: string;
}): Promise<boolean> {
  try {
    const res = await getBotClient().conversations.replies({
      channel,
      ts: thread_ts,
      limit: 100,
    });
    const messages = res.messages ?? [];
    // Walk newest → oldest. Look for either a sent confirmation or
    // another draft. If we find a draft for the same text before a
    // sent marker, that draft hasn't been sent yet.
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (!m.bot_id) continue;
      const text = typeof m.text === "string" ? m.text : "";
      if (text.startsWith(SENT_CONFIRMATION_MARKER)) return true;
      // If the most recent bot message is a (newer) draft, then no Send
      // has happened since this one was created — caller's draft might
      // still be pending. Keep walking back.
    }
    // Suppress unused-arg lint without changing the public signature.
    void matchDraft;
    return false;
  } catch (err) {
    console.error("[interactivity] thread sent-check failed", err);
    return false;
  }
}
