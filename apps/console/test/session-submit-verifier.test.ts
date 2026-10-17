/**
 * @fileoverview A prompt sent through the input route must actually leave the composer.
 *
 * Claude Code 2.1.277 ignores Enter for the first 30 to 50 seconds after the composer
 * paints while still taking typed text, so text+Enter 50 ms apart left every
 * programmatic prompt sitting unsent (measured 2026-09-19). These pin the recovery:
 * the verifier reads the last glyph line, re-sends Enter only while the prompt is
 * verifiably still there, stops the moment it is gone, never acts on a pane with no
 * composer, is capped, and is cancelled by a newer write or teardown.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SubmitVerifier, promptStillInComposer, SUBMIT_VERIFY_DELAYS_MS } from '../src/session-submit-verifier.js';

const PROMPT =
  'Read /home/arkon/.codeman/pr-bot/jobs/pr-439/brief.md and carry out the review it describes. Do not ask questions.';

/** Measured 2026-09-19: typed, wrapped, a no-break space after the glyph, never sent. */
const STRANDED = [
  ' ▐▛███▛█   Claude Code v2.1.278',
  '──────────────────────────────────────── prbot-439 ─',
  '❯ Read /home/arkon/.codeman/pr-bot/jobs/pr-439/brief.md and carry out the review it describes. Do not ask',
  '  questions.',
  '────────────────────────────────────────────────────',
  '  Opus 5 (1M context)  in:0 out:0',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n');

/** The same pane once taken: echoed in the transcript, composer empty. */
const TAKEN = [
  '❯ Read /home/arkon/.codeman/pr-bot/jobs/pr-439/brief.md and carry out the review it describes.',
  '● Reading the brief.',
  '✻ Actioning… (48s · ↓ 6.6k tokens)',
  '──────────────────────────────────────── prbot-439 ─',
  '❯',
  '────────────────────────────────────────────────────',
  '  Opus 5 (1M context)  in:192,963 out:371  ctx:19%',
].join('\n');

describe('promptStillInComposer', () => {
  it('sees the prompt sitting in the composer, no-break space and wrapping included', () => {
    expect(promptStillInComposer(STRANDED, PROMPT, '❯')).toBe(true);
  });
  it('is not fooled by the transcript echo once the composer is empty', () => {
    expect(promptStillInComposer(TAKEN, PROMPT, '❯')).toBe(false);
  });
  it('treats other text in the composer as not ours', () => {
    expect(promptStillInComposer(STRANDED, 'Summarise the changelog', '❯')).toBe(false);
  });
  it('answers undefined for a pane with no composer line, or no glyph', () => {
    expect(promptStillInComposer('$ ls\nfoo bar\n$ ', PROMPT, '❯')).toBeUndefined();
    expect(promptStillInComposer(STRANDED, PROMPT, '')).toBeUndefined();
  });
  it('honours the CLI glyph (Codex draws ›)', () => {
    expect(promptStillInComposer('› Reply with PONG\n', 'Reply with PONG', '›')).toBe(true);
    expect(promptStillInComposer('›\n', 'Reply with PONG', '›')).toBe(false);
  });
  it('reads through ANSI colour codes', () => {
    expect(promptStillInComposer('\x1b[1m❯\x1b[0m \x1b[36mReply with PONG\x1b[0m', 'Reply with PONG', '❯')).toBe(true);
  });
});

describe('SubmitVerifier', () => {
  let screen: string;
  let sends: number;
  let logs: string[];
  const make = (delaysMs?: readonly number[]) =>
    new SubmitVerifier({
      capture: () => screen,
      sendEnter: () => {
        sends++;
      },
      glyph: () => '❯',
      log: (m) => logs.push(m),
      delaysMs,
    });

  beforeEach(() => {
    vi.useFakeTimers();
    screen = STRANDED;
    sends = 0;
    logs = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-sends Enter while the prompt is still there and stops once it is taken', async () => {
    const v = make([1_000, 1_000, 1_000, 1_000]);
    v.arm(PROMPT);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sends).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sends).toBe(2);
    screen = TAKEN; // Claude Code finally honoured one
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sends).toBe(2);
    expect(logs[0]).toContain('still in the composer after 1s');
    expect(logs[1]).toContain('(2/4)');
  });

  it('costs one capture and no Enter when the prompt was taken on the first try', async () => {
    let captures = 0;
    const v = new SubmitVerifier({
      capture: () => {
        captures++;
        return TAKEN;
      },
      sendEnter: () => {
        sends++;
      },
      glyph: () => '❯',
    });
    v.arm(PROMPT);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(captures).toBe(1);
    expect(sends).toBe(0);
  });

  it('never presses Enter into a pane with no composer line', async () => {
    screen = '$ npm test\n... running ...\n';
    const v = make([1_000, 1_000]);
    v.arm(PROMPT);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sends).toBe(0);
  });

  it('is capped at the schedule length when the prompt never leaves', async () => {
    const v = make();
    v.arm(PROMPT);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(sends).toBe(SUBMIT_VERIFY_DELAYS_MS.length);
  });

  it('production schedule reaches past the measured window', () => {
    const total = SUBMIT_VERIFY_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(SUBMIT_VERIFY_DELAYS_MS[0]).toBeLessThanOrEqual(2_000);
    expect(total).toBeGreaterThanOrEqual(60_000);
  });

  it('a newer write replaces the schedule, so an old prompt never submits a new one', async () => {
    const v = make([1_000, 1_000, 1_000]);
    v.arm(PROMPT);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sends).toBe(1);
    screen = '❯ Something the user typed next';
    v.arm('Something the user typed next');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sends).toBe(2); // for the NEW prompt, which is what the composer holds
    screen = '❯';
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sends).toBe(2);
  });

  it('cancel() stops everything', async () => {
    const v = make([1_000, 1_000]);
    v.arm(PROMPT);
    v.cancel();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sends).toBe(0);
  });

  it('keeps checking when sendEnter throws', async () => {
    let calls = 0;
    const v = new SubmitVerifier({
      capture: () => screen,
      sendEnter: () => {
        calls++;
        throw new Error('tmux hiccup');
      },
      glyph: () => '❯',
      delaysMs: [1_000, 1_000],
    });
    v.arm(PROMPT);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(calls).toBe(2);
  });
});
