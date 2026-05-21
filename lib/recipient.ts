import { STAFF, findStaffById, type StaffMember } from "./roster";

export type RecipientMatch =
  | { kind: "found"; person: StaffMember }
  | { kind: "ambiguous"; candidates: StaffMember[] }
  | { kind: "none" };

// Slack renders user mentions in message text as `<@U01ABC>` or
// `<@U01ABC|displayname>`. We parse those first because they're unambiguous.
const MENTION_REGEX = /<@(U[A-Z0-9]+)(?:\|[^>]+)?>/g;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function identifyRecipient(text: string): RecipientMatch {
  if (!text) return { kind: "none" };

  // 1) Explicit Slack mentions — most reliable.
  const mentionedIds = new Set<string>();
  for (const m of text.matchAll(MENTION_REGEX)) {
    const person = findStaffById(m[1]);
    if (person) mentionedIds.add(person.slackUserId);
  }
  if (mentionedIds.size === 1) {
    const id = [...mentionedIds][0];
    return { kind: "found", person: findStaffById(id)! };
  }
  if (mentionedIds.size > 1) {
    return {
      kind: "ambiguous",
      candidates: [...mentionedIds].map((id) => findStaffById(id)!),
    };
  }

  // 2) Plain-text alias matching, whole word, case-insensitive.
  // Stripped of any Slack mention markup so we don't double-count.
  const cleaned = text.replace(MENTION_REGEX, " ");
  const matchedIds = new Set<string>();
  for (const s of STAFF) {
    for (const alias of s.aliases) {
      const regex = new RegExp(`\\b${escapeRegex(alias)}\\b`, "i");
      if (regex.test(cleaned)) {
        matchedIds.add(s.slackUserId);
        break;
      }
    }
  }

  if (matchedIds.size === 0) return { kind: "none" };
  if (matchedIds.size === 1) {
    const id = [...matchedIds][0];
    return { kind: "found", person: findStaffById(id)! };
  }
  return {
    kind: "ambiguous",
    candidates: [...matchedIds].map((id) => findStaffById(id)!),
  };
}
