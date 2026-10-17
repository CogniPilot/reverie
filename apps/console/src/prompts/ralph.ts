/**
 * @fileoverview Ralph Loop prompt construction
 *
 * Builds the full `@ralph_prompt.md` content written for a new Ralph loop
 * session, including the RALPH_STATUS block contract. The contract travels
 * with the loop prompt (not the generated CLAUDE.md) so every Ralph session
 * emits parseable status blocks regardless of the project's CLAUDE.md.
 *
 * @module prompts/ralph
 */

/**
 * Structured status-reporting contract appended to every Ralph loop prompt.
 *
 * `RalphStatusParser` (src/ralph-status-parser.ts) parses this block from
 * session output — keep the field names and enum values in sync with its
 * patterns.
 */
export const RALPH_STATUS_CONTRACT = `## Status Reporting

End EVERY response with exactly this block — Reverie parses it to track the loop:

\`\`\`
---RALPH_STATUS---
STATUS: IN_PROGRESS | COMPLETE | BLOCKED
TASKS_COMPLETED_THIS_LOOP: <number>
FILES_MODIFIED: <number>
TESTS_STATUS: PASSING | FAILING | NOT_RUN
WORK_TYPE: IMPLEMENTATION | TESTING | DOCUMENTATION | REFACTORING
EXIT_SIGNAL: false | true
RECOMMENDATION: <one line: what to do next>
---END_RALPH_STATUS---
\`\`\`

Rules:
- \`EXIT_SIGNAL: true\` only when ALL tasks are verifiably done — then also output the completion phrase
- \`STATUS: BLOCKED\` when you need human input; describe the blocker in RECOMMENDATION
- Never set \`EXIT_SIGNAL: true\` while tests are failing
`;

export interface RalphLoopPromptOptions {
  /** The user's task description (becomes the prompt header) */
  taskDescription: string;
  /** Completion phrase the session must emit inside <promise></promise> */
  completionPhrase: string;
  /** Whether a @fix_plan.md task plan was generated for this loop */
  hasPlan: boolean;
}

/**
 * Builds the full Ralph loop prompt written to `@ralph_prompt.md`.
 */
export function buildRalphLoopPrompt({ taskDescription, completionPhrase, hasPlan }: RalphLoopPromptOptions): string {
  let fullPrompt = taskDescription + '\n\n---\n\n';
  if (hasPlan) {
    fullPrompt += '## Task Plan\n\n';
    fullPrompt += 'A task plan has been written to `@fix_plan.md`. Use this to track progress:\n';
    fullPrompt += '- Reference the plan at the start of each iteration\n';
    fullPrompt += '- Update task checkboxes as you complete items\n';
    fullPrompt += '- Work through items in priority order (P0 > P1 > P2)\n\n';
  }
  fullPrompt += '## Iteration Protocol\n\n';
  fullPrompt += 'This is an autonomous loop. Files from previous iterations persist. On each iteration:\n';
  fullPrompt += '1. Check what work has already been done\n';
  fullPrompt += '2. Make incremental progress toward completion\n';
  fullPrompt += '3. Commit meaningful changes with descriptive messages\n\n';
  fullPrompt += '## Verification\n\n';
  fullPrompt += 'After each significant change:\n';
  fullPrompt += '- Run tests to verify (npm test, pytest, etc.)\n';
  fullPrompt += '- Check for type/lint errors if applicable\n';
  fullPrompt += '- If tests fail, read the error, fix it, and retry\n\n';
  fullPrompt += '## Completion Criteria\n\n';
  fullPrompt += `Output \`<promise>${completionPhrase}</promise>\` when ALL of the following are true:\n`;
  fullPrompt += '- All requirements from the task description are implemented\n';
  fullPrompt += '- All tests pass\n';
  fullPrompt += '- Changes are committed\n\n';
  fullPrompt += '## If Stuck\n\n';
  fullPrompt += 'If you encounter the same error for 3+ iterations:\n';
  fullPrompt += "1. Document what you've tried\n";
  fullPrompt += '2. Identify the specific blocker\n';
  fullPrompt += '3. Try an alternative approach\n';
  fullPrompt += '4. If truly blocked, output `<promise>BLOCKED</promise>` with an explanation\n\n';
  fullPrompt += RALPH_STATUS_CONTRACT;
  return fullPrompt;
}
