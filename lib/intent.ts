import { generateText, Output } from "ai";
import { z } from "zod";

/**
 * Classifier that decides whether the owner's incoming message is:
 *
 *   - "new":    a new piece of feedback that should be drafted from
 *               scratch (recipient identification happens after this)
 *   - "revise": an instruction to edit an existing outstanding draft
 *
 * If "revise", the result also indicates which draft (1-based index in
 * the outstandingDrafts list passed in). Defaults to the most recent
 * draft (index 1) unless the owner makes it obvious they mean another.
 *
 * Run on a small/fast Claude (Haiku) so the extra latency is minimal —
 * usually well under 1s.
 */

export type OutstandingDraftSummary = {
  recipientName: string;
  draft: string;
  /** Original raw input that produced the current draft, helps the
   * classifier decide whether new text is "more of the same" or different. */
  originalInput: string;
};

export type IntentResult =
  | { kind: "new" }
  | { kind: "revise"; draftIndex: number };

const IntentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("new") }),
  z.object({
    kind: z.literal("revise"),
    draftIndex: z.number().int().min(1),
  }),
]);

const SYSTEM_PROMPT = `You are routing messages from a household owner to a draft assistant. The owner sometimes has "outstanding drafts" — messages they've already drafted but haven't yet sent. When they send a new message, your job is to decide:

- "new": a new piece of feedback the owner wants drafted for someone (could be the same person as an outstanding draft, but it's clearly a new specific request, not an edit to an existing draft)
- "revise": an instruction to edit one of the outstanding drafts

If "revise", indicate WHICH draft via the 1-based draftIndex. Default to the most recent draft (1). Only pick a different index if the owner explicitly mentions a recipient whose draft is older (e.g. "make the Brendy one shorter" when an older draft for Brendy exists).

Heuristics:
- Short message with edit-style verbs ("shorter", "warmer", "drop the X", "less Y", "more like Z", "add X") → "revise"
- Short message naming a recipient followed by edit instructions ("for Brendy, drop the sign-off") → "revise"
- A new substantive piece of feedback or a new specific topic, even if it names a person who already has an outstanding draft → "new"
- A long detailed instruction about what they want said → "new"
- If there are no outstanding drafts, the answer is always "new".

Examples:
  Outstanding: [1] To Brendy: "Hey Brendy, just wanted to flag the crumbs..."
  Owner: "shorter please"  →  revise, 1

  Outstanding: [1] To Brendy: "Hey Brendy, just wanted to flag the crumbs..."
  Owner: "Brendy, also tomorrow can you do extra dusting"  →  new

  Outstanding: [1] To Patricia: "Hey Patricia, the chicken's been salty..."
              [2] To Brendy: "Hey Brendy, the bathroom mirror..."
  Owner: "make the Brendy one warmer"  →  revise, 2

  Outstanding: (none)
  Owner: "warmer"  →  new`;

export async function classifyIntent({
  text,
  outstandingDrafts,
}: {
  text: string;
  outstandingDrafts: OutstandingDraftSummary[];
}): Promise<IntentResult> {
  // Trivial path: no outstanding drafts → always new.
  if (outstandingDrafts.length === 0) {
    return { kind: "new" };
  }

  const draftsList = outstandingDrafts
    .map(
      (d, i) =>
        `[${i + 1}] To ${d.recipientName}\n  original_input: "${d.originalInput}"\n  current_draft: "${d.draft}"`,
    )
    .join("\n");

  const userPrompt = `Outstanding drafts (most recent first):\n${draftsList}\n\nThe owner just said:\n"${text}"\n\nClassify.`;

  try {
    const { output } = await generateText({
      model: "anthropic/claude-haiku-4.5",
      system: SYSTEM_PROMPT,
      prompt: userPrompt,
      output: Output.object({ schema: IntentSchema }),
    });
    // Sanity-check the draftIndex against actual outstanding drafts.
    if (output.kind === "revise") {
      if (
        output.draftIndex < 1 ||
        output.draftIndex > outstandingDrafts.length
      ) {
        // out of range → default to most recent
        return { kind: "revise", draftIndex: 1 };
      }
    }
    return output;
  } catch (err) {
    console.error("[intent] classification failed, defaulting to new", err);
    return { kind: "new" };
  }
}
