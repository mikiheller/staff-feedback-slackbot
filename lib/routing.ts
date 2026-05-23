/**
 * Routes a set of recipient names to a Slack destination — a public
 * channel, a private channel, a multi-person DM, or a 1:1 DM.
 *
 * The owner's stated rules:
 *   Samantha          → #food
 *   Brendy            → #brendy-jake-miki
 *   Patricia          → DM with [Patricia + Jake]
 *   Giuliane          → DM with [Giuliane + Jake]
 *   Sheryl            → DM with [Sheryl + Jake]
 *   {Patricia,Giuliane} → #rota
 *   anyone else       → 1:1 DM with that person
 *   ambiguous combos  → no routable destination → bot asks
 */

import { STAFF, type StaffMember } from "./roster";

/* -------------------------------------------------------------------------- */
/*                              Configuration                                 */
/* -------------------------------------------------------------------------- */

// Replace these with your actual channel IDs (start with C... for public,
// G... for private). To find a channel ID: open the channel in Slack →
// click the channel name at the top → scroll to the very bottom of the
// info panel → copy "Channel ID".
//
// Until these are filled in, sending to #food / #brendy-jake-miki /
// #rota will return a clear error to the owner so it's obvious what's
// blocking.
export const FOOD_CHANNEL_ID = "C07TE35FEAK";
export const BRENDY_CHANNEL_ID = "C0AAA695CKC";
export const ROTA_CHANNEL_ID = "C0ADF52JLF7";

// Jake — automatic +1 on Patricia / Giuliane / Sheryl mpims.
const JAKE_USER_ID = "U07PP9G968M";

/* -------------------------------------------------------------------------- */
/*                                 Types                                      */
/* -------------------------------------------------------------------------- */

export type Destination =
  | {
      kind: "channel";
      channelId: string;
      /** Display label like "#food" used in the Send button. */
      displayName: string;
    }
  | {
      kind: "mpim";
      /** Slack user IDs of the OTHER people in the mpim (not the owner). */
      otherUserIds: string[];
      /** Display label like "Patricia + Jake" used in the Send button. */
      displayName: string;
    }
  | {
      kind: "dm";
      /** Slack user ID of the single other party. */
      userId: string;
      /** Display label like "Grace" used in the Send button. */
      displayName: string;
    };

export type RoutingResult =
  | { ok: true; destination: Destination }
  | {
      ok: false;
      reason: "no_recipients" | "unknown_combo" | "destination_unconfigured";
      message: string;
    };

/* -------------------------------------------------------------------------- */
/*                              Resolution                                    */
/* -------------------------------------------------------------------------- */

function setOf(recipients: StaffMember[]): Set<string> {
  return new Set(recipients.map((r) => r.name));
}

function isPlaceholder(id: string): boolean {
  return id.startsWith("PLACEHOLDER_");
}

export function resolveDestination(
  recipients: StaffMember[],
): RoutingResult {
  if (recipients.length === 0) {
    return {
      ok: false,
      reason: "no_recipients",
      message: "I'm not sure who this is for — tell me by name.",
    };
  }

  const names = setOf(recipients);

  // ---- multi-recipient routes (special-cased) ----
  if (names.size === 2 && names.has("Patricia") && names.has("Giuliane")) {
    return channelDestination(ROTA_CHANNEL_ID, "#rota");
  }

  if (recipients.length > 1) {
    return {
      ok: false,
      reason: "unknown_combo",
      message:
        `I don't have a routing rule for messages to ${[...names].join(
          " + ",
        )}. Tell me where it should go, or send them separately.`,
    };
  }

  // ---- single-recipient routes ----
  const r = recipients[0];

  switch (r.name) {
    case "Samantha":
      return channelDestination(FOOD_CHANNEL_ID, "#food");
    case "Brendy":
      return channelDestination(BRENDY_CHANNEL_ID, "#brendy-jake-miki");
    case "Patricia":
    case "Giuliane":
    case "Sheryl":
      if (isPlaceholder(r.slackUserId)) {
        return {
          ok: false,
          reason: "destination_unconfigured",
          message: `${r.name}'s Slack user ID isn't set in the roster yet, so I can't open the chat.`,
        };
      }
      return {
        ok: true,
        destination: {
          kind: "mpim",
          otherUserIds: [r.slackUserId, JAKE_USER_ID],
          displayName: `${r.name} + Jake`,
        },
      };
    default:
      // anyone else → 1:1 DM
      if (isPlaceholder(r.slackUserId)) {
        return {
          ok: false,
          reason: "destination_unconfigured",
          message: `${r.name}'s Slack user ID isn't set in the roster yet, so I can't open the chat.`,
        };
      }
      return {
        ok: true,
        destination: {
          kind: "dm",
          userId: r.slackUserId,
          displayName: r.name,
        },
      };
  }
}

function channelDestination(
  channelId: string,
  displayName: string,
): RoutingResult {
  if (isPlaceholder(channelId)) {
    return {
      ok: false,
      reason: "destination_unconfigured",
      message: `The Slack channel ID for ${displayName} isn't filled in yet (lib/routing.ts). Once you give me the channel ID I'll wire it up.`,
    };
  }
  return {
    ok: true,
    destination: { kind: "channel", channelId, displayName },
  };
}

/**
 * Compact representation of a destination, suitable for stuffing into a
 * Slack button `value` (~2KB). We avoid storing the displayName a second
 * time since it's already in the button label.
 */
export function packDestination(d: Destination): string {
  switch (d.kind) {
    case "channel":
      return JSON.stringify({ k: "c", id: d.channelId, n: d.displayName });
    case "mpim":
      return JSON.stringify({ k: "m", u: d.otherUserIds, n: d.displayName });
    case "dm":
      return JSON.stringify({ k: "d", u: d.userId, n: d.displayName });
  }
}

export function unpackDestination(value: string): Destination | null {
  try {
    const p = JSON.parse(value) as {
      k?: string;
      id?: string;
      u?: string | string[];
      n?: string;
    };
    if (p.k === "c" && typeof p.id === "string" && typeof p.n === "string") {
      return { kind: "channel", channelId: p.id, displayName: p.n };
    }
    if (p.k === "m" && Array.isArray(p.u) && typeof p.n === "string") {
      return {
        kind: "mpim",
        otherUserIds: p.u as string[],
        displayName: p.n,
      };
    }
    if (p.k === "d" && typeof p.u === "string" && typeof p.n === "string") {
      return { kind: "dm", userId: p.u, displayName: p.n };
    }
    return null;
  } catch {
    return null;
  }
}

/** Used by the LLM-based recipient resolver to know which names are
 * legitimate routing targets. */
export function isInRoster(name: string): boolean {
  return STAFF.some(
    (s) =>
      s.name.toLowerCase() === name.toLowerCase() ||
      s.aliases.some((a) => a.toLowerCase() === name.toLowerCase()),
  );
}
