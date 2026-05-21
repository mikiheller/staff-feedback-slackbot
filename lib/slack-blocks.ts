import type { KnownBlock } from "@slack/web-api";

/**
 * State carried inside a draft message's Slack `metadata` field, so the
 * bot can find it later — when the owner replies with revision
 * instructions, or when a Send/Cancel button is clicked.
 */
export type DraftMetadata = {
  recipientId: string;
  recipientName: string;
  /** The owner's original, unpolished input. */
  originalInput: string;
  /** The latest polished draft we're proposing. */
  draft: string;
  attachmentCount: number;
};

export const DRAFT_METADATA_EVENT_TYPE = "staff_bot.draft";
export const ACTION_SEND_DRAFT = "send_draft";
export const ACTION_CANCEL_DRAFT = "cancel_draft";

/**
 * The message the owner sees in their DM with the bot. Includes the
 * draft text, the action buttons, and a hint about how to revise.
 */
export function buildDraftBlocks({
  recipientName,
  draft,
  attachmentCount,
}: {
  recipientName: string;
  draft: string;
  attachmentCount: number;
}): KnownBlock[] {
  const attachmentNote =
    attachmentCount > 0
      ? `\n\n_${attachmentCount} attachment${
          attachmentCount === 1 ? "" : "s"
        } will be included when sending._`
      : "";

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Draft to ${recipientName}:*`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        // Use a quote block so the draft visually reads like the message
        // it'll become. Easier to eyeball at a glance.
        text: `> ${draft.replace(/\n/g, "\n> ")}${attachmentNote}`,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text:
            "_Reply with changes to revise (e.g. \"shorter\", \"drop the sign-off\"), " +
            "or use the buttons below._",
        },
      ],
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: `Send to ${recipientName}`,
            emoji: true,
          },
          style: "primary",
          action_id: ACTION_SEND_DRAFT,
          // Button value isn't used for state — we read message metadata
          // on click instead — but Slack requires `value` to be set.
          value: "send",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Cancel" },
          style: "danger",
          action_id: ACTION_CANCEL_DRAFT,
          value: "cancel",
        },
      ],
    },
  ];
}

/** Replaces a draft message after the owner clicks Send. */
export function buildSentBlocks({
  recipientName,
  draft,
  sentAt,
}: {
  recipientName: string;
  draft: string;
  sentAt: Date;
}): KnownBlock[] {
  const timeStr = sentAt.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:white_check_mark: *Sent to ${recipientName}* at ${timeStr}`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `> ${draft.replace(/\n/g, "\n> ")}`,
      },
    },
  ];
}

/** Replaces a draft message after the owner clicks Cancel. */
export function buildCancelledBlocks({
  recipientName,
}: {
  recipientName: string;
}): KnownBlock[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:no_entry_sign: Draft to ${recipientName} cancelled.`,
      },
    },
  ];
}

/** Replaces a draft message after the owner asks for a revision. */
export function buildSupersededBlocks({
  recipientName,
}: {
  recipientName: string;
}): KnownBlock[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `_~Earlier draft to ${recipientName}~ — revised below._`,
      },
    },
  ];
}
