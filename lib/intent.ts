import { generateText, Output } from "ai";
import { z } from "zod";
import { STAFF, type StaffMember } from "./roster";

/**
 * Classifier that decides what the owner wants:
 *
 *   - "new":    a new piece of feedback. Returns the *intended*
 *               recipients (people the message is FOR, not just
 *               anyone mentioned in passing).
 *   - "revise": an instruction to edit an existing outstanding draft,
 *               with a 1-based index into the outstanding-drafts list.
 *
 * Run on Claude Haiku for ~500ms latency.
 */

export type OutstandingDraftSummary = {
  recipientNames: string[];
  draft: string;
  /** Original raw input that produced the current draft, helps the
   * classifier decide whether new text is "more of the same" or different. */
  originalInput: string;
};

export type IntentResult =
  | { kind: "new"; recipients: StaffMember[] }
  | { kind: "revise"; draftIndex: number };

const RawIntentSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("new"),
    recipientNames: z.array(z.string()),
  }),
  z.object({
    kind: z.literal("revise"),
    draftIndex: z.number().int().min(1),
  }),
]);

function buildSystemPrompt(): string {
  const rosterList = STAFF.map((s) => `- ${s.name}`).join("\n");
  return `You are routing messages from a household owner to a draft assistant. The owner has a roster of staff and family members; they sometimes have one or more "outstanding drafts" — messages they've already drafted but haven't yet sent.

Your job, when a new message comes in, is to decide:

1. Is this a NEW piece of feedback the owner wants drafted, or a REVISION of one of the outstanding drafts?

2. If NEW, who are the intended RECIPIENTS — the people the message is being SENT TO. People mentioned for context (e.g. "while Grace is out", "Jake and Miki will pitch in") are NOT recipients. Pick names ONLY from this roster:
${rosterList}

3. If REVISE, which draft (1-based index)? Default to most recent (1) unless the owner clearly names a different one ("make the Brendy one shorter" when Brendy isn't the most recent).

Heuristics:
- Short message with edit-style verbs ("shorter", "warmer", "drop the X", "less Y", "more like Z", "add X") → revise (most recent)
- Short message naming a recipient followed by edit instructions ("for Brendy, drop the sign-off") → revise (Brendy's draft)
- A new substantive piece of feedback or a new specific topic, even if it names a person who already has an outstanding draft → new
- A long detailed instruction about what they want said → new
- "I want to message X and Y about ..." → new, recipients = [X, Y] (and only X and Y; don't include other names mentioned for context)
- If there are no outstanding drafts, the answer is always new.

Output STRICTLY one of these JSON shapes (no extra text):
- {"kind": "new", "recipientNames": ["Patricia", "Giuliane"]}
- {"kind": "revise", "draftIndex": 1}

If you can't tell who a NEW message is for, return {"kind":"new","recipientNames":[]} and the system will ask the owner.`;
}

export async function classifyIntent({
  text,
  outstandingDrafts,
}: {
  text: string;
  outstandingDrafts: OutstandingDraftSummary[];
}): Promise<IntentResult> {
  // No outstanding drafts → can't be a revise. Skip the LLM call only if
  // we don't need recipient identification — but we do, so we still call.
  // The model is cheap and fast.

  const draftsList =
    outstandingDrafts.length === 0
      ? "(none)"
      : outstandingDrafts
          .map(
            (d, i) =>
              `[${i + 1}] To ${d.recipientNames.join(" & ")}\n  original_input: "${d.originalInput}"\n  current_draft: "${d.draft}"`,
          )
          .join("\n");

  const userPrompt = `Outstanding drafts (most recent first):\n${draftsList}\n\nThe owner just said:\n"""\n${text}\n"""\n\nClassify.`;

  let raw: z.infer<typeof RawIntentSchema>;
  try {
    const { output } = await generateText({
      model: "anthropic/claude-haiku-4.5",
      system: buildSystemPrompt(),
      prompt: userPrompt,
      output: Output.object({ schema: RawIntentSchema }),
    });
    raw = output;
  } catch (err) {
    console.error("[intent] classification failed, defaulting to empty new", err);
    return { kind: "new", recipients: [] };
  }

  if (raw.kind === "revise") {
    if (raw.draftIndex < 1 || raw.draftIndex > outstandingDrafts.length) {
      // out-of-range index → fall back to most recent if any
      if (outstandingDrafts.length > 0) {
        return { kind: "revise", draftIndex: 1 };
      }
      // No outstanding drafts to revise → treat as new with no recipients,
      // which makes the bot ask for clarification.
      return { kind: "new", recipients: [] };
    }
    return { kind: "revise", draftIndex: raw.draftIndex };
  }

  // raw.kind === "new" — resolve names against the roster.
  const seen = new Set<string>();
  const resolved: StaffMember[] = [];
  for (const name of raw.recipientNames) {
    const normalized = name.trim().toLowerCase();
    const match = STAFF.find(
      (s) =>
        s.name.toLowerCase() === normalized ||
        s.aliases.some((a) => a.toLowerCase() === normalized),
    );
    if (match && !seen.has(match.slackUserId)) {
      seen.add(match.slackUserId);
      resolved.push(match);
    }
  }

  return { kind: "new", recipients: resolved };
}
