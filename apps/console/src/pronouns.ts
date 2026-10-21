/**
 * @fileoverview An employee's pronouns: one short line of text the owner sets on the employee record
 * (PUT /api/company/employees/:id). An agent never writes them; `reverie agent profile --pronouns`
 * only posts a proposal line in its room, which the owner's member card offers as a one-tap "Set".
 * Dependency-free, so the agent CLI checks a proposal with the same rule the schema enforces.
 */

/** At most this many characters (UTF-16 units, as zod's max counts them). */
export const PRONOUNS_MAX = 24;

/** The fixed part of a proposal line: `<name> proposes pronouns: <text> (<who> can set them on my member card)`. */
export const PRONOUNS_PROPOSAL = ' proposes pronouns: ';
export const PRONOUNS_PROPOSAL_END = ' can set them on my member card)';

/** Control and invisible format characters (bidi overrides, zero-width) and line/paragraph separators: one line of visible text. */
const NOT_ONE_LINE = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

/** Why `text` (already trimmed) is not valid pronouns, or undefined when it is. */
export function pronounsProblem(text: string): string | undefined {
  if (!text) return 'Pronouns are 1 to 24 characters';
  if (text.length > PRONOUNS_MAX) return `Pronouns are at most ${PRONOUNS_MAX} characters`;
  if (NOT_ONE_LINE.test(text)) return 'Pronouns are one line of text';
  return undefined;
}

/** The proposal line an agent posts; `who` is how it addresses the owner (an @mention when the room knows their name). */
export function pronounsProposal(name: string, pronouns: string, who: string): string {
  return `${name}${PRONOUNS_PROPOSAL}${pronouns} (${who}${PRONOUNS_PROPOSAL_END}`;
}
