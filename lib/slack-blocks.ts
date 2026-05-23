import type { KnownBlock } from "@slack/web-api";
import { packDestination, unpackDestination, type Destination } from "./routing";

/**
 * State packed into the Send button so we can recover everything we
 * need on click without external storage.
 *
 * Encoded as JSON in the button's `value` field (Slack caps that at
 * 2000 chars; we truncate the original-input field if needed).
 */
export type DraftState = {
  /** Encoded Destination (channel / mpim / dm). */
  destPacked: string;
  /** First names of intended recipients, for human-readable display. */
  recipientNames: string[];
  /** The owner's original raw input — used to feed the LLM on revisions. */
  originalInput: string;
  /** The exact draft text we'll send. */
  draft: string;
  attachmentCount: number;
};

export const ACTION_SEND_DRAFT = "send_draft";

const MAX_BUTTON_VALUE_BYTES = 1900;
const MAX_ORIGINAL_INPUT_CHARS = 1200;

function packState(state: DraftState): string {
  const compact = {
    dp: state.destPacked,
    rNs: state.recipientNames,
    oI:
      state.originalInput.length > MAX_ORIGINAL_INPUT_CHARS
        ? state.originalInput.slice(0, MAX_ORIGINAL_INPUT_CHARS)
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
    const p = JSON.parse(value) as {
      dp?: string;
      rNs?: unknown;
      oI?: string;
      d?: string;
      a?: number;
    };
    if (typeof p.dp !== "string" || typeof p.d !== "string") return null;
    const rNs = Array.isArray(p.rNs)
      ? (p.rNs as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    return {
      destPacked: p.dp,
      recipientNames: rNs,
      originalInput: p.oI ?? "",
      draft: p.d,
      attachmentCount: p.a ?? 0,
    };
  } catch {
    return null;
  }
}

/** Convenience: gets a Destination object back from a state. */
export function destinationFromState(state: DraftState): Destination | null {
  return unpackDestination(state.destPacked);
}

/**
 * The draft message: just the draft text and a single Send button.
 * No quote bar, no preamble, no extra labels — copy/pasteable as-is.
 */
export function buildDraftBlocks({
  state,
  destination,
}: {
  state: DraftState;
  destination: Destination;
}): KnownBlock[] {
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

  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: {
          type: "plain_text",
          text: `Send to ${destination.displayName}`,
          emoji: true,
        },
        style: "primary",
        action_id: ACTION_SEND_DRAFT,
        value: packState({ ...state, destPacked: packDestination(destination) }),
      },
    ],
  });

  return blocks;
}

/**
 * Locate a draft state by scanning a message's blocks for a Send
 * button. Used when reading thread history to find the most recent
 * draft to revise.
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
      if ((el as { action_id: unknown }).action_id === ACTION_SEND_DRAFT) {
        const state = unpackStateFromButtonValue(
          (el as { value: string }).value,
        );
        if (state) return state;
      }
    }
  }
  return null;
}
