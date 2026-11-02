/**
 * Claude Code folds a long or multi-line paste into an indexed chip, `[Pasted text #1 +3 lines]`, with no length. The chip
 * binds a delivery only as the whole composer, after a write observed from an empty composer, by its line-break count.
 */
import { describe, expect, it } from 'vitest';
import { claudeChipHoldsPrompt, promptStillInComposer } from '../src/session-submit-verifier.js';
import { submitAndConfirm } from '../src/submit-settle.js';

const CLAUDE = { glyph: '❯', workingLine: String.raw`…\s*\((?:\d+h\s+)?(?:\d+m\s+)?\d+s\b|esc to interrupt` };
const pane = (composer: string) => [
  '● Earlier answer.',
  '',
  '────────────────────────────────────────',
  `❯ ${composer}`,
  '────────────────────────────────────────',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n');
const FOUR_LINES = 'line one\nline two\nline three\nline four';
const LONG_ONE_LINE = 'x'.repeat(801);

describe('Claude indexed paste chips', () => {
  it('binds a whole-composer chip by its line breaks after a write from an empty composer', () => {
    expect(promptStillInComposer(pane('[Pasted text #1 +3 lines]'), FOUR_LINES, '❯', true)).toBe(true);
    expect(promptStillInComposer(pane('[Pasted text #7 +3 lines]'), FOUR_LINES + '\n', '❯', true)).toBe(true);
    expect(promptStillInComposer(pane('[Pasted text #2]'), LONG_ONE_LINE, '❯', true)).toBe(true);
  });

  it('never binds without an observed empty composer, by a different count, or a paste Claude would not fold', () => {
    expect(promptStillInComposer(pane('[Pasted text #1 +3 lines]'), FOUR_LINES, '❯', false)).toBeUndefined();
    expect(promptStillInComposer(pane('[Pasted text #1 +4 lines]'), FOUR_LINES, '❯', true)).toBeUndefined();
    expect(promptStillInComposer(pane('[Pasted text #1 +2 lines]'), 'a\nb\nc', '❯', true)).toBeUndefined();
    expect(promptStillInComposer(pane('[Pasted text #1]'), 'short line', '❯', true)).toBeUndefined();
  });

  it('refuses a chip mixed with typed text, two chips, or other chip kinds', () => {
    expect(promptStillInComposer(pane('note [Pasted text #1 +3 lines]'), FOUR_LINES, '❯', true)).toBeUndefined();
    expect(promptStillInComposer(pane('[Pasted text #1 +3 lines][Pasted text #2 +3 lines]'), FOUR_LINES, '❯', true)).toBeUndefined();
    expect(promptStillInComposer(pane('[...Truncated text #1 +3 lines...]'), FOUR_LINES, '❯', true)).toBeUndefined();
    expect(promptStillInComposer(pane('[Image #1]'), FOUR_LINES, '❯', true)).toBeUndefined();
    expect(claudeChipHoldsPrompt('[Pasted Content 1801 chars]', 'x'.repeat(1801), true)).toBeUndefined();
  });

  it('still reads an empty composer as taken', () => {
    expect(promptStillInComposer(pane(''), FOUR_LINES, '❯', true)).toBe(false);
  });

  it('a write that owns the composer presses Enter for its own chip and confirms when the composer empties', async () => {
    for (const requireOwnership of [false, true]) {
      let enters = 0;
      const outcome = await submitAndConfirm({ capture: () => enters ? pane('') : pane('[Pasted text #1 +3 lines]'),
        sleep: async () => {}, sendEnter: async () => { enters++; } }, FOUR_LINES, CLAUDE, 'owned fixture', true,
      requireOwnership, () => true);
      expect(outcome).toBe('started');
      expect(enters).toBe(1);
    }
  });

  it('a chip still drawn after both Enters stays not-started, never confirmed', async () => {
    let enters = 0;
    const outcome = await submitAndConfirm({ capture: () => pane('[Pasted text #1 +3 lines]'),
      sleep: async () => {}, sendEnter: async () => { enters++; } }, FOUR_LINES, CLAUDE, 'owned fixture', true);
    expect(outcome).toBe('not-started');
    expect(enters).toBe(2);
  });

  it('a chip that does not match the delivery gets no Enter at all', async () => {
    let enters = 0;
    const outcome = await submitAndConfirm({ capture: () => pane('[Pasted text #1 +9 lines]'),
      sleep: async () => {}, sendEnter: async () => { enters++; } }, FOUR_LINES, CLAUDE, 'owned fixture', true, true, () => true);
    expect(outcome).not.toBe('started');
    expect(enters).toBe(0);
  });
});
