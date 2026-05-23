import type { KnownBlock } from "@slack/web-api";

/**
 * State carried inside a draft message — what we need to know to send,
 * cancel, or revise it later. We encode this as JSON inside the
 * action buttons' `value` fields, which Slack preserves and sends back
 * to us in the interactivity payload. (We previously tried Slack
 * message metadata for this, but it silently requires the
 * `metadata.message:write` scope, which we don't have — and not having
 * it just makes Slack drop the metadata without erroring.)
 */
export type DraftState = {
  recipientId: string;
  recipientName: string;
  /** The owner's original, unpolished input. */
  originalInput: string;
  /** The latest polished draft we're proposing. */
  draft: string;
  attachmentCount: number;
};

export const ACTION_SEND_DRAFT = "send_draft";
export const ACTION_CANCEL_DRAFT = "cancel_draft";

// Slack caps button `value` at 2000 chars. We truncate the original input
// (used only when revising) to leave room for everything else. The draft
// itself is always preserved verbatim because we use it to actually send.
const MAX_BUTTON_VALUE_BYTES = 1900; // small safety margin
const MAX_ORIGINAL_INPUT_CHARS_WHEN_PACKING = 1200;

function packState(state: DraftState): string {
  const compact = {
    rId: state.recipientId,
    rN: state.recipientName,
    oI:
      state.originalInput.length > MAX_ORIGINAL_INPUT_CHARS_WHEN_PACKING
        ? state.originalInput.slice(0, MAX_ORIGINAL_INPUT_CHARS_WHEN_PACKING)
        : state.originalInput,
    d: state.draft,
    a: state.attachmentCount,
  };
  let json = JSON.stringify(compact);
  if (json.length > MAX_BUTTON_VALUE_BYTES) {
    // Last-resort truncation: trim the original input further.
    const overshoot = json.length - MAX_BUTTON_VALUE_BYTES;
    compact.oI = compact.oI.slice(0, Math.max(0, compact.oI.length - overshoot - 10));
    json = JSON.stringify(compact);
  }
  return json;
}

export function unpackStateFromButtonValue(
  value: string | undefined,
): DraftState | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as {
      rId?: string;
      rN?: string;
      oI?: string;
      d?: string;
      a?: number;
    };
    if (!parsed.rId || !parsed.rN || typeof parsed.d !== "string") {
      return null;
    }
    return {
      recipientId: parsed.rId,
      recipientName: parsed.rN,
      originalInput: parsed.oI ?? "",
      draft: parsed.d,
      attachmentCount: parsed.a ?? 0,
    };
  } catch {
    return null;
  }
}

/**
 * The message the owner sees in their DM with the bot. Includes the
 * draft text, the action buttons, and a hint about how to revise.
 * Both buttons carry the full state as JSON so we can recover it
 * whichever one is clicked, and so the revision flow can find it by
 * scanning recent message blocks.
 */
export function buildDraftBlocks({
  state,
}: {
  state: DraftState;
}): KnownBlock[] {
  const attachmentNote =
    state.attachmentCount > 0
      ? `\n\n_${state.attachmentCount} attachment${
          state.attachmentCount === 1 ? "" : "s"
        } will be included when sending._`
      : "";

  const packedValue = packState(state);

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Draft to ${state.recipientName}:*`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        // Use a quote block so the draft visually reads like the message
        // it'll become. Easier to eyeball at a glance.
        text: `> ${state.draft.replace(/\n/g, "\n> ")}${attachmentNote}`,
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
            text: `Send to ${state.recipientName}`,
            emoji: true,
          },
          style: "primary",
          action_id: ACTION_SEND_DRAFT,
          value: packedValue,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Cancel" },
          style: "danger",
          action_id: ACTION_CANCEL_DRAFT,
          value: packedValue,
        },
      ],
    },
  ];
}

/**
 * Find a draft state inside the message blocks (used by the revision
 * flow, which scans recent DM history for an outstanding draft). Returns
 * null if the message isn't a draft.
 */
export function extractDraftStateFromBlocks(
  blocks: unknown[] | undefined,
): DraftState | null {
  if (!Array.isArray(blocks)) return null;
  for (const block of blocks) {
    if (
      typeof block === "object" &&
      block !== null &&
      "type" in block &&
      block.type === "actions" &&
      "elements" in block &&
      Array.isArray((block as { elements?: unknown[] }).elements)
    ) {
      const elements = (block as { elements: unknown[] }).elements;
      for (const el of elements) {
        if (
          typeof el === "object" &&
          el !== null &&
          "action_id" in el &&
          el.action_id === ACTION_SEND_DRAFT &&
          "value" in el &&
          typeof (el as { value?: unknown }).value === "string"
        ) {
          return unpackStateFromButtonValue(
            (el as { value: string }).value,
          );
        }
      }
    }
  }
  return null;
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
  draft,
}: {
  recipientName: string;
  draft: string;
}): KnownBlock[] {
  // Wrap each line in `~...~` so Slack renders the prior draft as
  // struck-through. Tildes inside the draft itself are uncommon in
  // English text; we accept that breaking edge case for simplicity.
  const struckDraft = draft
    .split("\n")
    .map((line) => (line.length > 0 ? `> ~${line}~` : ">"))
    .join("\n");

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `_Earlier draft to ${recipientName} — revised below:_`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: struckDraft,
      },
    },
  ];
}
