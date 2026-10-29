import { afterEach, describe, expect, it, vi } from 'vitest';
import { CAPACITY_RETRY_PROMPT, CapacityRetry, capacityStallLine, type CapacityRetryEvent } from '../src/capacity-stall.js';

// Rows as `capture-pane -p -e` returned them from codex-cli 0.163.0 after a mock `server_is_overloaded`; synthetic text only.
const ESC = '\u001b';
const ECHO = (text: string) => `${ESC}[1;2m› ${ESC}[0m${text}`;
const ERROR = `${ESC}[38;5;1m■ Selected model is at capacity. Please try a different model.${ESC}[39m`;
const COMPOSER = `${ESC}[1m›${ESC}[0m ${ESC}[2mAsk Codex to do anything${ESC}[0m`;
const FOOTER = `  ${ESC}[38;2;246;226;183mmock-model default${ESC}[39m · ${ESC}[38;2;171;223;167m/owned/fixture${ESC}[39m`;
const STALLED = `${ECHO('do work')}\n\n${ERROR}\n\n${COMPOSER}\n\n${FOOTER}`;
const ANSWERED = `${ECHO('continue')}\n\n${ESC}[2m• ${ESC}[0mmock answer\n\n${COMPOSER}\n\n${FOOTER}`;

afterEach(() => vi.useRealTimers());

describe('capacityStallLine', () => {
  it('finds the capacity error that ended the last turn', () => {
    expect(capacityStallLine(STALLED, '›')).toBe('■ Selected model is at capacity. Please try a different model.');
  });
  it('ignores an answer, a quoted message, older errors, a draft and other CLIs', () => {
    expect(capacityStallLine(ANSWERED, '›')).toBeNull();
    // An agent quoting the message sits under its bullet, indented.
    const quoted = `${ECHO('why')}\n\n• The pane said:\n  ■ Selected model is at capacity.\n\n${COMPOSER}\n\n${FOOTER}`;
    expect(capacityStallLine(quoted, '›')).toBeNull();
    expect(capacityStallLine(`${ERROR}\n\n${ANSWERED}`, '›')).toBeNull();
    expect(capacityStallLine(STALLED.replace(COMPOSER, `${ESC}[1m›${ESC}[0m user draft`), '›')).toBeNull();
    expect(capacityStallLine(STALLED, '❯')).toBeNull();
    expect(capacityStallLine(null, '›')).toBeNull();
  });
});

describe('CapacityRetry', () => {
  function harness(start = STALLED) {
    const state = { screen: start as string | null, working: false, stopped: false, sent: [] as string[], events: [] as CapacityRetryEvent[] };
    const retry = new CapacityRetry({
      capture: () => state.screen, glyph: () => '›', isWorking: () => state.working, isStopped: () => state.stopped,
      send: async (prompt) => { state.sent.push(prompt); return true; },
      onEvent: (event) => state.events.push(event), delaysMs: [1_000, 2_000],
    });
    return { state, retry };
  }

  it('types continue after the backoff, backs off again on a repeat and gives up after the last delay', async () => {
    vi.useFakeTimers();
    const { state, retry } = harness();
    retry.check();
    await vi.advanceTimersByTimeAsync(999);
    expect(state.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.sent).toEqual([CAPACITY_RETRY_PROMPT]);
    retry.check(); // the retried turn failed the same way
    await vi.advanceTimersByTimeAsync(2_000);
    expect(state.sent).toHaveLength(2);
    retry.check();
    retry.check();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.sent).toHaveLength(2);
    expect(state.events.map((e) => e.kind)).toEqual(['scheduled', 'retried', 'scheduled', 'retried', 'gave-up']);
    retry.destroy();
  });

  it('starts afresh once a turn ends normally', async () => {
    vi.useFakeTimers();
    const { state, retry } = harness();
    retry.check();
    await vi.advanceTimersByTimeAsync(1_000);
    state.screen = ANSWERED;
    retry.check();
    state.screen = STALLED;
    retry.check();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(state.sent).toHaveLength(2);
    retry.destroy();
  });

  it('never types when the session is busy, stopped, edited or no longer stalled at fire time', async () => {
    vi.useFakeTimers();
    for (const change of [
      (s: { working: boolean }) => { s.working = true; },
      (s: { stopped: boolean }) => { s.stopped = true; },
      (s: { screen: string | null }) => { s.screen = STALLED.replace(COMPOSER, `${ESC}[1m›${ESC}[0m typed by a person`); },
      (s: { screen: string | null }) => { s.screen = ANSWERED; },
    ]) {
      const { state, retry } = harness();
      retry.check();
      change(state);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(state.sent).toEqual([]);
      retry.destroy();
    }
  });

  it('looks at the screen after capacity output, and only then', async () => {
    vi.useFakeTimers();
    const { state, retry } = harness();
    retry.noteOutput('ordinary output');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.events).toEqual([]);
    retry.noteOutput('■ Selected model is at capacity.');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(state.events.map((e) => e.kind)).toEqual(['scheduled']);
    retry.destroy();
  });
});
