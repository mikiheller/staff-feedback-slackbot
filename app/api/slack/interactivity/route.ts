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
  type DraftMetadata,
} from "@/lib/slack-blocks";

export const runtime = "nodejs";

type BlockActionsPayload = {
  type: "block_actions";
  user: { id: string };
  channel: { id: string };
  message: {
    ts: string;
    metadata?: {
      event_type?: string;
      event_payload?: Record<string, unknown>;
    };
  };
  actions: Array<{ action_id: string; value?: string }>;
  response_url?: string;
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

  // Slack expects a 200 within 3s. Do the actual work via after().
  after(async () => {
    try {
      if (action.action_id === ACTION_SEND_DRAFT) {
        await handleSend(payload);
      } else if (action.action_id === ACTION_CANCEL_DRAFT) {
        await handleCancel(payload);
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

function extractDraftMetadata(
  payload: BlockActionsPayload,
): DraftMetadata | null {
  const md = payload.message.metadata;
  if (!md || md.event_type !== "staff_bot.draft" || !md.event_payload) {
    return null;
  }
  return md.event_payload as unknown as DraftMetadata;
}

async function handleSend(payload: BlockActionsPayload): Promise<void> {
  const meta = extractDraftMetadata(payload);
  if (!meta) {
    await postEphemeralLike({
      channel: payload.channel.id,
      messageTs: payload.message.ts,
      text:
        ":warning: Couldn't find the draft data on this message. " +
        "Start a new draft.",
    });
    return;
  }

  const result = await sendAsOwner({
    recipientId: meta.recipientId,
    text: meta.draft,
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

  // Swap the draft message in the owner's DM for a "sent ✓" version, and
  // clear the metadata so future replies don't get treated as revisions.
  await getBotClient().chat.update({
    channel: payload.channel.id,
    ts: payload.message.ts,
    text: `Sent to ${meta.recipientName}`,
    blocks: buildSentBlocks({
      recipientName: meta.recipientName,
      draft: meta.draft,
      sentAt: new Date(),
    }),
    metadata: {
      event_type: "staff_bot.sent",
      event_payload: {
        recipientId: meta.recipientId,
        recipientName: meta.recipientName,
      },
    },
  });
}

async function handleCancel(payload: BlockActionsPayload): Promise<void> {
  const meta = extractDraftMetadata(payload);
  const recipientName = meta?.recipientName ?? "the recipient";

  await getBotClient().chat.update({
    channel: payload.channel.id,
    ts: payload.message.ts,
    text: `Draft to ${recipientName} cancelled.`,
    blocks: buildCancelledBlocks({ recipientName }),
    metadata: {
      event_type: "staff_bot.cancelled",
      event_payload: {},
    },
  });
}

/**
 * Post a contextual note attached to the draft message. We use a regular
 * threaded reply because chat.postEphemeral can be flaky in DMs.
 */
async function postEphemeralLike({
  channel,
  messageTs,
  text,
}: {
  channel: string;
  messageTs: string;
  text: string;
}): Promise<void> {
  await getBotClient().chat.postMessage({
    channel,
    thread_ts: messageTs,
    text,
  });
}
