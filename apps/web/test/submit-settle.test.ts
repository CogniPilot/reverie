/**
 * A long delivery is a paste to Codex/OpenCode; Enter sent 50 ms after it was folded into the paste and nothing submitted.
 * The submit now waits for the paste to settle, sends Enter as its own tmux call, confirms a turn started, and retries Enter once.
 */
import { describe, expect, it } from 'vitest';
import {
  CONFIRM_WINDOW_MS,
  SETTLE_MAX_MS,
  SETTLE_MIN_MS,
  SHORT_SETTLE_MS,
  settleBudgetMs,
  submitAndConfirm,
  typeAndSubmit,
  waitForPasteSettle,
} from '../src/submit-settle.js';
import { typeIntoOpencode, type OpencodeTypingIo } from '../src/opencode-input.js';

const CODEX = { glyph: '›', workingLine: '[Ee]sc to interrupt' };
const OPENCODE = { glyph: '┃', workingLine: '[⬝■]{8}' };

type Event = { kind: 'text'; text: string } | { kind: 'enter' } | { kind: 'sleep'; ms: number } | { kind: 'capture' };

/**
 * A fake mux. `screen(enters)` is what the pane shows after that many Enters; `changing` makes every read before the first Enter
 * differ (a paste that never settles).
 */
function fakeMux(screen: (enters: number) => string | null, changing = false, emptyBeforeTyping = false) {
  const events: Event[] = [];
  const logs: string[] = [];
  let enters = 0;
  let reads = 0;
  let typed = false;
  const io = {
    typeText: async (text: string) => { typed = true; events.push({ kind: 'text', text }); },
    sendEnter: async () => {
      enters++;
      events.push({ kind: 'enter' });
    },
    capture: () => {
      events.push({ kind: 'capture' });
      const s = emptyBeforeTyping && !typed ? codexComposer('') : screen(enters);
      return changing && enters === 0 && s !== null ? `${s}\n${reads++}` : s;
    },
    sleep: async (ms: number) => void events.push({ kind: 'sleep', ms }),
    log: (m: string) => void logs.push(m),
  };
  const enterCount = () => events.filter((e) => e.kind === 'enter').length;
  /** Total sleep before the first Enter. */
  const waitBeforeEnter = () => {
    let total = 0;
    for (const e of events) {
      if (e.kind === 'enter') break;
      if (e.kind === 'sleep') total += e.ms;
    }
    return total;
  };
  return { io, events, logs, enterCount, waitBeforeEnter };
}

const LONG = 'x'.repeat(1801);
const codexComposer = (body: string) => `• earlier answer\n\n› ${body}\n\nGPT-6.1-Sol high · /owned/fixture`;
const codexWorking = '• earlier answer\n\n› your prompt\n\n• Working (2s • esc to interrupt)\n\n› \n\nGPT-6.1-Sol high · /owned/fixture';

describe('Enter is its own keystroke after the text', () => {
  it('types the text without a carriage return, then sends Enter as a separate call', async () => {
    const m = fakeMux((n) => (n === 0 ? codexComposer('[Pasted Content 1801 chars]') : codexWorking), false, true);
    expect(await typeAndSubmit(m.io, LONG, CODEX)).toBe('started');
    const kinds = m.events.filter((e) => e.kind === 'text' || e.kind === 'enter');
    expect(kinds).toEqual([{ kind: 'text', text: LONG }, { kind: 'enter' }]);
    expect(LONG.includes('\r')).toBe(false);
  });

  it('OpenCode: the text and Enter are separate tmux commands', async () => {
    const calls: string[][] = [];
    let entered = false;
    const io: OpencodeTypingIo = {
      tmux: async (args) => {
        calls.push(args);
        if (args.includes('Enter')) entered = true;
      },
      capture: () => (entered ? '┃ prompt\n  ⬝■■■■■■⬝  esc interrupt' : '┃ [Pasted ~30 lines]\n  tab agents'),
      sleep: async () => undefined,
    };
    await typeIntoOpencode(io, { target: 'p', text: LONG, enter: true, paste: false, buffer: 'b', confirm: OPENCODE });
    expect(calls).toEqual([
      ['send-keys', '-t', 'p', '-l', LONG],
      ['send-keys', '-t', 'p', 'Enter'],
    ]);
  });
});

describe('the settle wait', () => {
  it('grows with the text length and is bounded', () => {
    expect(settleBudgetMs(10)).toBe(SHORT_SETTLE_MS);
    expect(settleBudgetMs(500)).toBeGreaterThan(SETTLE_MIN_MS);
    expect(settleBudgetMs(1500)).toBeGreaterThan(settleBudgetMs(500));
    expect(settleBudgetMs(1_000_000)).toBe(SETTLE_MAX_MS);
  });

  it('a paste that keeps changing waits the full budget and no longer', async () => {
    const m = fakeMux(() => 'never the same', true);
    const waited = await waitForPasteSettle(m.io, 1_000_000);
    expect(waited).toBe(SETTLE_MAX_MS);
    expect(m.events.filter((e) => e.kind === 'sleep').reduce((n, e) => n + (e as { ms: number }).ms, 0)).toBe(SETTLE_MAX_MS);
  });

  it('a long paste that has stopped changing waits only the minimum plus one read', async () => {
    const m = fakeMux(() => codexComposer('[Pasted Content 1801 chars]'));
    const waited = await waitForPasteSettle(m.io, LONG.length);
    expect(waited).toBeGreaterThanOrEqual(SETTLE_MIN_MS);
    expect(waited).toBeLessThan(settleBudgetMs(LONG.length));
  });

  it('a long paste waits past the paste-burst window before Enter', async () => {
    const m = fakeMux((n) => (n === 0 ? codexComposer('[Pasted Content 1801 chars]') : codexWorking), false, true);
    await typeAndSubmit(m.io, LONG, CODEX);
    expect(m.waitBeforeEnter()).toBeGreaterThanOrEqual(SETTLE_MIN_MS);
  });

  it('a short message keeps the old 50 ms gap and is not read before Enter', async () => {
    const m = fakeMux((n) => (n === 0 ? codexComposer('hi there') : codexWorking), false, true);
    expect(await typeAndSubmit(m.io, 'hi there', CODEX)).toBe('started');
    expect(m.waitBeforeEnter()).toBe(SHORT_SETTLE_MS);
    // One empty-before-write read plus one complete ownership check before Enter; no extra delay.
    const firstEnter = m.events.findIndex((e) => e.kind === 'enter');
    expect(m.events.slice(0, firstEnter).filter((e) => e.kind === 'capture')).toHaveLength(2);
  });
});

describe('confirming the turn', () => {
  it('a turn that starts gets no retry', async () => {
    const m = fakeMux((n) => (n === 0 ? codexComposer('[Pasted Content 1801 chars]') : codexWorking));
    expect(await submitAndConfirm(m.io, LONG, CODEX, 'owned fixture', true)).toBe('started');
    expect(m.enterCount()).toBe(1);
    expect(m.logs.some((l) => l.includes('submit started'))).toBe(true);
  });

  it('a composer that empties counts as a started turn even before the busy line shows', async () => {
    const m = fakeMux((n) => codexComposer(n === 0 ? '[Pasted Content 1801 chars]' : ''));
    expect(await submitAndConfirm(m.io, LONG, CODEX, 'owned fixture', true)).toBe('started');
    expect(m.enterCount()).toBe(1);
  });

  it('no turn start leads to exactly one retry', async () => {
    const m = fakeMux(() => codexComposer('[Pasted Content 1801 chars]'));
    expect(await submitAndConfirm(m.io, LONG, CODEX, 'owned fixture', true)).toBe('not-started');
    expect(m.enterCount()).toBe(2);
    expect(m.logs.some((l) => l.includes('pressing Enter once more'))).toBe(true);
    expect(m.logs.some((l) => l.includes('submit not-started'))).toBe(true);
  });

  it('the retry that starts the turn is reported as such', async () => {
    const m = fakeMux((n) => (n < 2 ? codexComposer('[Pasted Content 1801 chars]') : codexWorking));
    expect(await submitAndConfirm(m.io, LONG, CODEX, 'owned fixture', true)).toBe('started-after-retry');
    expect(m.enterCount()).toBe(2);
  });

  it('the confirm window is bounded', async () => {
    const m = fakeMux(() => codexComposer('[Pasted Content 1801 chars]'));
    await submitAndConfirm(m.io, LONG, CODEX, 'owned fixture', true);
    const slept = m.events.filter((e) => e.kind === 'sleep').reduce((n, e) => n + (e as { ms: number }).ms, 0);
    expect(slept).toBe(2 * CONFIRM_WINDOW_MS);
  });

  it('OpenCode: the spinner says the turn started; without it Enter is pressed once more', async () => {
    const chip = '┃ [Pasted ~30 lines]\n┃  Build  Big Pickle\n  tab agents';
    const started = fakeMux((n) => (n === 0 ? chip : `${chip}\n  ⬝■■■■■■⬝  esc interrupt`));
    expect(await submitAndConfirm(started.io, LONG, OPENCODE)).toBe('started');
    expect(started.enterCount()).toBe(1);
    const mute = fakeMux(() => chip);
    expect(await submitAndConfirm(mute.io, LONG, OPENCODE)).toBe('not-started');
    expect(mute.enterCount()).toBe(2);
  });

  it('a pane nothing can be read from gets no blind retry', async () => {
    const none = fakeMux(() => null);
    expect(await submitAndConfirm(none.io, LONG, CODEX)).toBe('unverified');
    expect(none.enterCount()).toBe(1); // Explicit/manual submission keeps its original first Enter.
    const shell = fakeMux(() => '$ ls');
    expect(await submitAndConfirm(shell.io, 'ls', { glyph: '', workingLine: '' })).toBe('unverified');
    expect(shell.enterCount()).toBe(1);
  });
});
