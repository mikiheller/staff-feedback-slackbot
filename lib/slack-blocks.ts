import type { KnownBlock } from "@slack/web-api";

/**
 * State carried inside a draft message — what we need to know to send,
 * cancel, or revise it later. Encoded as JSON inside the action buttons'
 * `value` fields, which Slack preserves and sends back to us in the
 * interactivity payload.
 *
 * Multi-recipient drafts have multiple recipientIds; single-recipient
 * drafts have exactly one. We don't add a Send button when there are
 * multiple recipients (the owner copy-pastes manually).
 */
export type DraftState = {
  recipientIds: string[];
  recipientNames: string[];
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
const MAX_BUTTON_VALUE_BYTES = 1900;
const MAX_ORIGINAL_INPUT_CHARS_WHEN_PACKING = 1200;

function packState(state: DraftState): string {
  const compact = {
    rIds: state.recipientIds,
    rNs: state.recipientNames,
    oI:
      state.originalInput.length > MAX_ORIGINAL_INPUT_CHARS_WHEN_PACKING
        ? state.originalInput.slice(0, MAX_ORIGINAL_INPUT_CHARS_WHEN_PACKING)
        : state.originalInput,
    d: state.draft,
    a: state.attachmentCount,
  };
  let json = JSON.stringify(compact);
  if (json.length > MAX_BUTTON_VALUE_BYTES) {
    const overshoot = json.length - MAX_BUTTON_VALUE_BYTES;
    compact.oI = compact.oI.slice(
      0,
      Math.max(0, compact.oI.length - overshoot - 10),
    );
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
      rIds?: unknown;
      rNs?: unknown;
      oI?: string;
      d?: string;
      a?: number;
      // Tolerate the v1 shape that had single recipientId/recipientName fields.
      rId?: string;
      rN?: string;
    };
    let recipientIds: string[];
    let recipientNames: string[];
    if (Array.isArray(parsed.rIds) && parsed.rIds.every((x) => typeof x === "string")) {
      recipientIds = parsed.rIds as string[];
      recipientNames = Array.isArray(parsed.rNs)
        ? (parsed.rNs as unknown[]).filter((x): x is string => typeof x === "string")
        : [];
    } else if (typeof parsed.rId === "string" && typeof parsed.rN === "string") {
      recipientIds = [parsed.rId];
      recipientNames = [parsed.rN];
    } else {
      return null;
    }
    if (recipientIds.length === 0 || typeof parsed.d !== "string") {
      return null;
    }
    return {
      recipientIds,
      recipientNames,
      originalInput: parsed.oI ?? "",
      draft: parsed.d,
      attachmentCount: parsed.a ?? 0,
    };
  } catch {
    return null;
  }
}

function joinNames(names: string[]): string {
  if (names.length === 0) return "(unknown)";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The active draft message: just the draft text and the action buttons.
 * No quote bar, no "Draft to X:" preamble.
 *
 * - Single recipient → [Send to <name>] [Cancel]
 * - Multiple recipients → [Cancel] only (owner copies/pastes to send)
 */
export function buildDraftBlocks({
  state,
}: {
  state: DraftState;
}): KnownBlock[] {
  const isMultiRecipient = state.recipientIds.length > 1;
  const namesJoined = joinNames(state.recipientNames);
  const packedValue = packState(state);

  const blocks: KnownBlock[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: state.draft },
    },
  ];

  if (state.attachmentCount > 0) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `_${state.attachmentCount} attachment${
            state.attachmentCount === 1 ? "" : "s"
          } will be included when sending._`,
        },
      ],
    });
  }

  if (isMultiRecipient) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `_Multiple recipients (${namesJoined}) — copy and send manually, or reply with changes to revise._`,
        },
      ],
    });
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Cancel" },
          style: "danger",
          action_id: ACTION_CANCEL_DRAFT,
          value: packedValue,
        },
      ],
    });
  } else {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: `Send to ${namesJoined}`,
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
    });
  }

  return blocks;
}

/**
 * Find a draft state inside the message blocks. Used by the revision
 * scanner to locate outstanding drafts in the DM history.
 */
export function extractDraftStateFromBlocks(
  blocks: unknown[] | undefined,
): DraftState | null {
  if (!Array.isArray(blocks)) return null;
  for (const block of blocks) {
    if (
      typeof block !== "object" ||
      block === null ||
      !("type" in block) ||
      block.type !== "actions" ||
      !("elements" in block) ||
      !Array.isArray((block as { elements?: unknown[] }).elements)
    ) {
      continue;
    }
    const elements = (block as { elements: unknown[] }).elements;
    for (const el of elements) {
      if (
        typeof el !== "object" ||
        el === null ||
        !("action_id" in el) ||
        !("value" in el) ||
        typeof (el as { value?: unknown }).value !== "string"
      ) {
        continue;
      }
      const actionId = (el as { action_id: unknown }).action_id;
      if (
        actionId === ACTION_SEND_DRAFT ||
        actionId === ACTION_CANCEL_DRAFT
      ) {
        const state = unpackStateFromButtonValue(
          (el as { value: string }).value,
        );
        if (state) return state;
      }
    }
  }
  return null;
}

/** Replaces a draft message after the owner clicks Send. */
export function buildSentBlocks({
  recipientNames,
  draft,
  sentAt,
}: {
  recipientNames: string[];
  draft: string;
  sentAt: Date;
}): KnownBlock[] {
  const timeStr = sentAt.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return [
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `:white_check_mark: Sent to *${joinNames(
            recipientNames,
          )}* at ${timeStr}`,
        },
      ],
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: draft },
    },
  ];
}

/** Replaces a draft message after the owner clicks Cancel. */
export function buildCancelledBlocks({
  recipientNames,
}: {
  recipientNames: string[];
}): KnownBlock[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:no_entry_sign: Draft to ${joinNames(recipientNames)} cancelled.`,
      },
    },
  ];
}

/** Replaces a draft message after the owner asks for a revision. */
export function buildSupersededBlocks({
  recipientNames,
  draft,
}: {
  recipientNames: string[];
  draft: string;
}): KnownBlock[] {
  const struckDraft = draft
    .split("\n")
    .map((line) => (line.length > 0 ? `~${line}~` : ""))
    .join("\n");

  return [
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `_Earlier draft to ${joinNames(
            recipientNames,
          )} — revised below:_`,
        },
      ],
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: struckDraft },
    },
  ];
}
