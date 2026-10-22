/**
 * @fileoverview Tests for Ralph loop prompt construction
 *
 * Verifies buildRalphLoopPrompt() output, and that the RALPH_STATUS contract
 * embedded in the prompt stays in sync with what RalphStatusParser parses.
 */

import { describe, it, expect } from 'vitest';
import { buildRalphLoopPrompt, RALPH_STATUS_CONTRACT } from '../src/prompts/ralph.js';
import { RalphStatusParser } from '../src/ralph-status-parser.js';

describe('buildRalphLoopPrompt', () => {
  const baseOptions = {
    taskDescription: 'Add CRUD endpoints for todos',
    completionPhrase: 'COMPLETE',
    hasPlan: false,
  };

  it('starts with the task description', () => {
    const prompt = buildRalphLoopPrompt(baseOptions);

    expect(prompt.startsWith('Add CRUD endpoints for todos\n\n---\n\n')).toBe(true);
  });

  it('embeds the completion phrase in the completion criteria', () => {
    const prompt = buildRalphLoopPrompt({ ...baseOptions, completionPhrase: 'ALL_DONE' });

    expect(prompt).toContain('<promise>ALL_DONE</promise>');
    expect(prompt).toContain('## Completion Criteria');
  });

  it('includes the task plan section only when a plan exists', () => {
    const withPlan = buildRalphLoopPrompt({ ...baseOptions, hasPlan: true });
    const withoutPlan = buildRalphLoopPrompt(baseOptions);

    expect(withPlan).toContain('## Task Plan');
    expect(withPlan).toContain('@fix_plan.md');
    expect(withoutPlan).not.toContain('## Task Plan');
  });

  it('always appends the RALPH_STATUS contract', () => {
    const prompt = buildRalphLoopPrompt(baseOptions);

    expect(prompt).toContain(RALPH_STATUS_CONTRACT);
    expect(prompt).toContain('---RALPH_STATUS---');
    expect(prompt).toContain('---END_RALPH_STATUS---');
  });

  it('documents every field RalphStatusParser expects', () => {
    for (const field of [
      'STATUS: IN_PROGRESS | COMPLETE | BLOCKED',
      'TASKS_COMPLETED_THIS_LOOP: <number>',
      'FILES_MODIFIED: <number>',
      'TESTS_STATUS: PASSING | FAILING | NOT_RUN',
      'WORK_TYPE: IMPLEMENTATION | TESTING | DOCUMENTATION | REFACTORING',
      'EXIT_SIGNAL: false | true',
      'RECOMMENDATION:',
    ]) {
      expect(RALPH_STATUS_CONTRACT).toContain(field);
    }
  });

  it('teaches a block format that RalphStatusParser actually parses', () => {
    // A response following the contract to the letter
    const conformingBlock = [
      '---RALPH_STATUS---',
      'STATUS: IN_PROGRESS',
      'TASKS_COMPLETED_THIS_LOOP: 2',
      'FILES_MODIFIED: 5',
      'TESTS_STATUS: PASSING',
      'WORK_TYPE: IMPLEMENTATION',
      'EXIT_SIGNAL: false',
      'RECOMMENDATION: Continue with the next endpoint',
      '---END_RALPH_STATUS---',
    ];

    const parser = new RalphStatusParser();
    for (const line of conformingBlock) {
      parser.processLine(line);
    }

    const block = parser.lastStatusBlock;
    expect(block).not.toBeNull();
    expect(block?.status).toBe('IN_PROGRESS');
    expect(block?.tasksCompletedThisLoop).toBe(2);
    expect(block?.filesModified).toBe(5);
    expect(block?.testsStatus).toBe('PASSING');
    expect(block?.workType).toBe('IMPLEMENTATION');
    expect(block?.exitSignal).toBe(false);
    expect(block?.recommendation).toBe('Continue with the next endpoint');
  });
});
