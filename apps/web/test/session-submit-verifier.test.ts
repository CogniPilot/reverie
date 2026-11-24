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
import { composerIsEmpty, SubmitVerifier, promptStillInComposer, SUBMIT_VERIFY_DELAYS_MS } from '../src/session-submit-verifier.js';

const PROMPT =
  'Read /home/arkon/.reverie/pr-bot/jobs/pr-439/brief.md and carry out the review it describes. Do not ask questions.';

/** Measured 2026-09-19: typed, wrapped, a no-break space after the glyph, never sent. */
const STRANDED = [
  ' ▐▛███▛█   Claude Code v2.1.278',
  '──────────────────────────────────────── prbot-439 ─',
  '❯ Read /home/arkon/.reverie/pr-bot/jobs/pr-439/brief.md and carry out the review it describes. Do not ask',
  '  questions.',
  '────────────────────────────────────────────────────',
  '  Opus 5 (1M context)  in:0 out:0',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n');

/** The same pane once taken: echoed in the transcript, composer empty. */
const TAKEN = [
  '❯ Read /home/arkon/.reverie/pr-bot/jobs/pr-439/brief.md and carry out the review it describes.',
  '● Reading the brief.',
  '✻ Actioning… (48s · ↓ 6.6k tokens)',
  '──────────────────────────────────────── prbot-439 ─',
  '❯',
  '────────────────────────────────────────────────────',
  '  Opus 5 (1M context)  in:192,963 out:371  ctx:19%',
].join('\n');

describe('promptStillInComposer', () => {
  it('reads Claude’s styled welcome suggestion as empty and preserves real drafts', () => {
    const welcome = ' Claude Code v2.1.308\n';
    const styled = '\x1b[39m❯ \x1b[7mT\x1b[0;2mry\x1b[0m \x1b[2m"create\x1b[0m \x1b[2ma test..."\x1b[0m';
    const chrome = '\n──────────────────\n  ⏵⏵ bypass permissions on (shift+tab to cycle)';
    expect(composerIsEmpty(welcome + styled + chrome, '❯')).toBe(true);
    expect(composerIsEmpty(welcome + '❯ Try "create a test..."' + chrome, '❯')).toBe(false);
    expect(composerIsEmpty(welcome + styled + '\nMore draft text' + chrome, '❯')).toBe(false);
    // Without the welcome banner the same faint row is still nobody's draft: it is read by its style.
    expect(composerIsEmpty(styled + chrome, '❯')).toBe(true);
    expect(composerIsEmpty('❯ Try "create a test..."' + chrome, '❯')).toBe(false);
  });
  describe('Claude’s suggested next prompt', () => {
    /** The pane of a plan-move candidate that had finished a turn (2026-11-24), as a capture without styles shows it. */
    const frame = (composer: string) =>
      [
        '✻ Sautéed for 18s · done 7:35 AM',
        '──────────────────────────────────────────────────── Ada ─',
        composer,
        '────────────────────────────────────────────────────────',
        '  Opus 5.5  in:50,206 out:648  ctx:5%  cache:until 08:35',
        '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
      ].join('\n');
    const words = 'yes, check Vulkan and start the RTX run';
    /** Drawn as Claude Code draws its composer placeholder: the cursor on the first character, the rest faint. */
    const ghost =
      '❯ \x1b[7my\x1b[0;2mes,\x1b[0m ' +
      words
        .split(' ')
        .slice(1)
        .map((word) => `\x1b[2m${word}\x1b[0m`)
        .join(' ');
    it('reads a composer that shows only the faint suggestion as empty', () => {
      expect(composerIsEmpty(frame(ghost), '❯')).toBe(true);
      expect(promptStillInComposer(frame(ghost), 'Continue the work you were handed.', '❯')).toBe(false);
      // No cursor drawn (the terminal is not focused): every character faint.
      expect(composerIsEmpty(frame(`❯ \x1b[2m${words}\x1b[0m`), '❯')).toBe(true);
      // Faint text may carry a foreground colour, and a long suggestion wraps onto a faint second row.
      expect(composerIsEmpty(frame(`❯ \x1b[2;38;5;246m${words}\x1b[0m`), '❯')).toBe(true);
      expect(composerIsEmpty(frame(`${ghost}\n  \x1b[2mand report back\x1b[0m`), '❯')).toBe(true);
      // tmux carries attributes across rows: a faint state opened on an earlier row still applies.
      expect(composerIsEmpty(`\x1b[2m` + frame(`❯ ${words}`), '❯')).toBe(true);
    });
    it('accepts both composer rows captured from live Claude Code 2.1.308 panes with `tmux capture-pane -e -p`', () => {
      // Verbatim: the glyph is followed by a no-break space and a space, the cursor is the inverse first character, the rest
      // is faint, and in the second form the spaces between the faint words are emitted with the attributes reset.
      const wholeRun = '\x1b[39m❯  \x1b[7my\x1b[0;2mes, check Vulkan and start the RTX run\x1b[0m';
      const perWord =
        '\x1b[39m❯  \x1b[7mk\x1b[0;2meep\x1b[0m \x1b[2mgoing\x1b[0m \x1b[2mon\x1b[0m \x1b[2mthe\x1b[0m \x1b[2munowned\x1b[0m \x1b[2missues\x1b[0m';
      for (const row of [wholeRun, perWord]) {
        expect(composerIsEmpty(frame(row), '❯')).toBe(true);
        expect(promptStillInComposer(frame(row), 'Continue the work you were handed.', '❯')).toBe(false);
      }
      // The same two rows with the words typed instead: no faint run, so each is a draft.
      expect(composerIsEmpty(frame('\x1b[39m❯  yes, check Vulkan and start the RTX run\x1b[7m \x1b[0m'), '❯')).toBe(false);
      expect(composerIsEmpty(frame('\x1b[39m❯  \x1b[7mk\x1b[0meep going on the unowned issues'), '❯')).toBe(false);
      // One typed word among the faint ones is enough to keep it a draft.
      expect(composerIsEmpty(frame(perWord.replace('\x1b[2mthe\x1b[0m', 'the')), '❯')).toBe(false);
    });
    it('keeps the very same words a draft when they were typed, or when the capture has no styles', () => {
      // Exactly the screen in the report, as plain text: a suggestion and typed text cannot be told apart, so it is a draft.
      expect(composerIsEmpty(frame(`❯ ${words}`), '❯')).toBe(false);
      expect(promptStillInComposer(frame(`❯ ${words}`), words, '❯')).toBe(true);
      // Typed, with the drawn cursor after it or on its first character.
      expect(composerIsEmpty(frame(`❯ ${words}\x1b[7m \x1b[0m`), '❯')).toBe(false);
      expect(composerIsEmpty(frame(`❯ \x1b[7my\x1b[0mes, check Vulkan`), '❯')).toBe(false);
      // Typed text followed by a faint completion or hint.
      expect(composerIsEmpty(frame(`❯ yes, check\x1b[2m Vulkan and start the RTX run\x1b[0m`), '❯')).toBe(false);
      expect(composerIsEmpty(frame(`❯ /model \x1b[2m[model]\x1b[0m`), '❯')).toBe(false);
      // One typed character under the cursor and nothing faint.
      expect(composerIsEmpty(frame('❯ \x1b[7my\x1b[0m'), '❯')).toBe(false);
      // A faint first row with a typed second row.
      expect(composerIsEmpty(frame(`${ghost}\n  typed below`), '❯')).toBe(false);
    });
    it('keeps a draft for any style it does not model', () => {
      for (const composer of [
        `❯ \x1b[1;2m${words}\x1b[0m`, // bold and faint
        `❯ \x1b[2;4m${words}\x1b[0m`, // underlined
        `❯ \x1b[2;41m${words}\x1b[0m`, // a background
        `❯ \x1b[36m${words}\x1b[0m`, // coloured, not faint
        `❯ \x1b[2m${words}\x1b[K\x1b[0m`, // an escape that is not a style
        `❯ \x1b[2:3m${words}\x1b[0m`, // a sub-parameter form
        `❯ \x1b[2myes\x1b[0m \x1b[7mc\x1b[0;2mheck\x1b[0m`, // the cursor inside the text
        `❯ \x1b[7;31my\x1b[0;2mes, check\x1b[0m`, // a coloured cursor cell
      ])
        expect(composerIsEmpty(frame(composer), '❯')).toBe(false);
      // The composer has to be closed by Claude's own ruler.
      expect(composerIsEmpty(['────────', ghost].join('\n'), '❯')).toBe(false);
      expect(composerIsEmpty([ghost, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n'), '❯')).toBe(false);
      // Only Claude's glyph: a faint Codex row is read by Codex's own rule.
      expect(composerIsEmpty(`› \x1b[2m${words}\x1b[0m\n────────\n`, '›')).toBe(false);
    });
  });
  it('sees the prompt sitting in the composer, no-break space and wrapping included', () => {
    expect(promptStillInComposer(STRANDED, PROMPT, '❯')).toBe(true);
  });
  it('is not fooled by the transcript echo once the composer is empty', () => {
    expect(promptStillInComposer(TAKEN, PROMPT, '❯')).toBe(false);
  });
  it('treats other text in the composer as not ours', () => {
    expect(promptStillInComposer(STRANDED, 'Summarise the changelog', '❯')).toBeUndefined();
  });
  it('answers undefined for a pane with no composer line, or no glyph', () => {
    expect(promptStillInComposer('$ ls\nfoo bar\n$ ', PROMPT, '❯')).toBeUndefined();
    expect(promptStillInComposer(STRANDED, PROMPT, '')).toBeUndefined();
  });
  it('honours the CLI glyph (Codex draws ›)', () => {
    expect(promptStillInComposer('› Reply with PONG\n\nGPT-6.1-Sol high · /owned/fixture', 'Reply with PONG', '›')).toBe(true);
    expect(promptStillInComposer('›\n\nGPT-6.1-Sol high · /owned/fixture', 'Reply with PONG', '›')).toBe(false);
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
