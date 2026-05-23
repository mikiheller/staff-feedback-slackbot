import { generateText, Output } from "ai";
import { z } from "zod";
import { STAFF, type StaffMember } from "./roster";

/**
 * Given a top-level message from the owner, identify the *intended*
 * recipients of the feedback (people the message is FOR), pulling only
 * from the staff roster. People mentioned for context (e.g. "while
 * Grace is out", "Jake will pitch in") must NOT be returned.
 *
 * Returns an empty array if the bot can't tell. The caller should ask.
 *
 * Runs on Claude Haiku for ~500ms latency.
 */

const RecipientNamesSchema = z.object({
  recipientNames: z.array(z.string()),
});

function buildSystemPrompt(): string {
  const rosterList = STAFF.map((s) => `- ${s.name}`).join("\n");
  return `You are helping route a household owner's draft request to the right person.

The owner just typed a note describing some feedback they want to give to one or more people from this roster:
${rosterList}

Your only job: identify the INTENDED recipients — the people the owner wants the message to be SENT TO — by their first name from the roster.

Strict rules:
- Pick names ONLY from the roster above. If a name isn't on the roster, ignore it.
- Distinguish between recipients and context. If the owner says "I want to message Patricia and Giuliane to coordinate while Grace is out", the recipients are [Patricia, Giuliane], NOT Grace. Grace was mentioned for context.
- Multiple recipients are fine when they're explicitly addressed (e.g. "tell Patricia and Giuliane that...").
- If you genuinely cannot tell, return an empty array — the system will ask the owner.

Output STRICTLY this JSON shape (no extra text):
{"recipientNames": ["Patricia", "Giuliane"]}

or, when unsure:
{"recipientNames": []}`;
}

export async function identifyRecipients(
  text: string,
): Promise<StaffMember[]> {
  if (!text.trim()) return [];

  let raw: { recipientNames: string[] };
  try {
    const { output } = await generateText({
      model: "anthropic/claude-haiku-4.5",
      system: buildSystemPrompt(),
      prompt: text,
      output: Output.object({ schema: RecipientNamesSchema }),
    });
    raw = output;
  } catch (err) {
    console.error("[intent] recipient identification failed", err);
    return [];
  }

  const seen = new Set<string>();
  const resolved: StaffMember[] = [];
  for (const name of raw.recipientNames) {
    const norm = name.trim().toLowerCase();
    const match = STAFF.find(
      (s) =>
        s.name.toLowerCase() === norm ||
        s.aliases.some((a) => a.toLowerCase() === norm),
    );
    if (match && !seen.has(match.slackUserId)) {
      seen.add(match.slackUserId);
      resolved.push(match);
    }
  }
  return resolved;
}
