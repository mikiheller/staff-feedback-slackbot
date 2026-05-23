/**
 * Household staff roster. Add or change entries here as people come and go.
 *
 * `aliases` is a list of lowercased strings that the recipient parser will
 * try to match against the owner's message. Always include the first name
 * (lowercased). You can add nicknames or role-based aliases too, e.g.
 * `["patricia", "the chef", "chef"]`.
 */

export type StaffMember = {
  name: string;
  slackUserId: string;
  aliases: string[];
};

export const STAFF: readonly StaffMember[] = [
  {
    name: "Patricia",
    slackUserId: "U0AABTKHCCX",
    aliases: ["patricia"],
  },
  {
    name: "Giuliane",
    slackUserId: "U09B5RNRYEP",
    aliases: ["giuliane"],
  },
  {
    name: "Grace",
    slackUserId: "U08157MSVFD",
    aliases: ["grace"],
  },
  {
    name: "Theresa",
    slackUserId: "U07V65V4GGZ",
    aliases: ["theresa"],
  },
  {
    name: "Brendy",
    slackUserId: "U095RC3UK1N",
    aliases: ["brendy"],
  },
  {
    name: "Samantha",
    slackUserId: "U080WKTJMKM",
    aliases: ["samantha"],
  },
  {
    name: "Jake",
    slackUserId: "U07PP9G968M",
    aliases: ["jake"],
  },
  {
    name: "Sheryl",
    slackUserId: "U08FJR00VGR",
    aliases: ["sheryl"],
  },
] as const;

export function findStaffById(slackUserId: string): StaffMember | undefined {
  return STAFF.find((s) => s.slackUserId === slackUserId);
}
