import { NextResponse } from "next/server";
import { after } from "next/server";
import { verifySlackSignature, isOwner } from "@/lib/slack-verify";
import { getBotClient } from "@/lib/slack";
import { sendAsOwner } from "@/lib/slack-send";
import {
  ACTION_CANCEL_DRAFT,
  ACTION_SEND_DRAFT,
  buildCancelledBlocks,
  buildSentBlocks,
  unpackStateFromButtonValue,
  type DraftState,
} from "@/lib/slack-blocks";

export const runtime = "nodejs";

type BlockActionsPayload = {
  type: "block_actions";
  user: { id: string };
  channel: { id: string };
  message: {
    ts: string;
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

  // Interactivity payloads come as form-urlencoded with a single `payload`
  // field containing JSON. (Quirky but that's the Slack API.)
  const params = new URLSearchParams(rawBody);
  const payloadStr = params.get("payload");
  if (!payloadStr) {
    return new NextResponse("missing payload", { status: 400 });
  }

  let payload: BlockActionsPayload;
  try {
    payload = JSON.parse(payloadStr);
  } catch (err) {
    console.error("[interactivity] bad JSON", err);
    return new NextResponse("bad payload", { status: 400 });
  }

  if (payload.type !== "block_actions") {
    console.log("[interactivity] ignoring payload type=%s", payload.type);
    return new NextResponse("ok");
  }

  if (!isOwner(payload.user.id)) {
    console.log(
      "[interactivity] non-owner click user=%s — ignoring",
      payload.user.id,
    );
    return new NextResponse("ok");
  }

  const action = payload.actions[0];
  if (!action) return new NextResponse("ok");

  // The button's `value` is the JSON-encoded draft state we wrote there.
  const state = unpackStateFromButtonValue(action.value);
  console.log(
    "[interactivity] action=%s ts=%s stateOk=%s",
    action.action_id,
    payload.message.ts,
    state !== null,
  );

  // Slack expects a 200 within 3s. Do the actual work via after().
  after(async () => {
    try {
      if (action.action_id === ACTION_SEND_DRAFT) {
        await handleSend({ payload, state });
      } else if (action.action_id === ACTION_CANCEL_DRAFT) {
        await handleCancel({ payload, state });
      } else {
        console.log(
          "[interactivity] unknown action_id=%s",
          action.action_id,
        );
      }
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
  if (!state) {
    await getBotClient().chat.postMessage({
      channel: payload.channel.id,
      thread_ts: payload.message.ts,
      text:
        ":warning: Couldn't read the draft data on this message. " +
        "Start a new draft.",
    });
    return;
  }

  const result = await sendAsOwner({
    recipientId: state.recipientId,
    text: state.draft,
  });

  if (!result.ok) {
    console.error("[interactivity] sendAsOwner failed", result.error);
    await getBotClient().chat.postMessage({
      channel: payload.channel.id,
      text: `:warning: Send failed: ${result.error}`,
      thread_ts: payload.message.ts,
    });
    return;
  }

  // Swap the draft message in the owner's DM for a "sent ✓" version. The
  // new blocks have no action buttons, which is what marks this draft as
  // no longer outstanding for the revision-detection logic.
  await getBotClient().chat.update({
    channel: payload.channel.id,
    ts: payload.message.ts,
    text: `Sent to ${state.recipientName}`,
    blocks: buildSentBlocks({
      recipientName: state.recipientName,
      draft: state.draft,
      sentAt: new Date(),
    }),
  });
}

async function handleCancel({
  payload,
  state,
}: {
  payload: BlockActionsPayload;
  state: DraftState | null;
}): Promise<void> {
  const recipientName = state?.recipientName ?? "the recipient";

  await getBotClient().chat.update({
    channel: payload.channel.id,
    ts: payload.message.ts,
    text: `Draft to ${recipientName} cancelled.`,
    blocks: buildCancelledBlocks({ recipientName }),
  });
}
