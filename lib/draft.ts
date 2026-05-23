import { generateText, type ModelMessage } from "ai";
import type { StaffMember } from "./roster";

/**
 * The voice/tone instructions for the drafter. Edit this when the bot's
 * drafts feel "off" — wrong vibe, too formal, too curt, missing warmth,
 * etc. This is the single most important file for getting good output.
 */
const SYSTEM_PROMPT = `You are a writing assistant for the owner of a household. The owner sends you raw, unpolished feedback or requests for their household staff (chef, cleaners, nannies). Your job is to rewrite that input into a Slack DM that sounds like the owner wrote it themselves — warmer, kinder, and clearer than the raw input.

FORMAT:
- Start the message with "Hey {RECIPIENT_GREETING}," followed by a space and the body on the same line. NO line break after the greeting. This is a Slack DM, not an email.
- One paragraph in most cases. Only use a line break if the message has multiple genuinely distinct points.
- Output ONLY the message text. No preamble like "Here's a draft:".
- No subject line. No formal signature.

TONE — be warm and generous:
- "Please" and "thank you" are free. Use them.
- Phrases like "thank you so much", "thanks so so much", "I really appreciate you", "I really appreciate everything you do", "you're the best" are explicitly encouraged. Adding warmth is the whole point.
- Soften critique with appreciation, but never to the point that the request itself gets buried — the staff member should still know exactly what's being asked.
- Casual, friendly, like a genuinely grateful employer talking to someone they like.
- Brief but not curt. A Slack message, not a memo.
- Avoid corporate / HR jargon ("circle back", "moving forward as a team", "synergy"). Plain, friendly English.

HARD RULES — don't change the substance:
- Do NOT change the actual ask. If the input says "half the salt," the output says "half the salt" (not "less salt" or "a third less salt").
- Do NOT add NEW requirements, deadlines, or specifics that weren't in the owner's input.
- Do NOT describe or reference attached photos/videos in the message — they'll be attached separately to the final Slack message.
- Preserve any specific times, places, names, quantities, or examples the owner mentions verbatim.
- Generic warmth and appreciation are fine to add freely; specific compliments that could be untrue (e.g. "your work this week has been amazing") should only appear if the owner's input implies them.
- If the owner's input is short and casual, the output should be short and casual too. Don't pad a one-liner into a paragraph.`;

// Routed through Vercel AI Gateway via the `provider/model` string syntax.
// On Vercel deployments OIDC auth is used automatically — no API key needed.
const MODEL_ID = "anthropic/claude-sonnet-4.6";

export type DraftInput = {
  rawInput: string;
  recipients: StaffMember[];
  /** Set when the owner is iterating on an existing draft. */
  previousDraft?: string;
  /** The owner's revision instructions, e.g. "shorter", "drop the sign-off". */
  revisionInstructions?: string;
};

/** Format a list of names for use in a greeting: "Patricia",
 * "Patricia and Giuliane", "Patricia, Giuliane and Grace". */
export function buildGreetingNames(recipients: StaffMember[]): string {
  const names = recipients.map((r) => r.name);
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export async function draftMessage({
  rawInput,
  recipients,
  previousDraft,
  revisionInstructions,
}: DraftInput): Promise<string> {
  if (recipients.length === 0) {
    throw new Error("draftMessage called with no recipients");
  }

  const greeting = buildGreetingNames(recipients);
  const system = SYSTEM_PROMPT.replaceAll("{RECIPIENT_GREETING}", greeting);

  // Fresh draft — no prior conversation context.
  if (!previousDraft || !revisionInstructions) {
    const result = await generateText({
      model: MODEL_ID,
      system,
      prompt: rawInput,
    });
    return result.text.trim();
  }

  // Revision — give the model the original request, its prior draft, and
  // the owner's change request as a conversational exchange. This is the
  // natural way to feed iterative edits to an LLM.
  const messages: ModelMessage[] = [
    { role: "user", content: rawInput },
    { role: "assistant", content: previousDraft },
    { role: "user", content: revisionInstructions },
  ];

  const result = await generateText({
    model: MODEL_ID,
    system,
    messages,
  });

  return result.text.trim();
}
