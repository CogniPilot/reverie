/**
 * A write that owns the composer (an agent wake, a capacity retry) presses Enter only while the composer holds exactly its own
 * text, in every harness. Codex already had this; Claude Code did not, so a person typing between the text and its Enter had
 * their keys submitted with it. Refused, the text stays in the composer, typed but unsent.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { typeAndSubmit, withWriteGate, writeGateActive } from '../src/submit-settle.js';
import { Session } from '../src/session.js';
import type { MuxSession, TerminalMultiplexer } from '../src/mux-interface.js';

const CLAUDE = { glyph: '❯', workingLine: '[Ee]sc to interrupt' };
const WAKE = 'Check your rooms: you have unread messages.';
const claude = (body: string) => [
  '● earlier answer',
  '────────────────────────────────────────────',
  `❯ ${body}`.trimEnd(),
  '────────────────────────────────────────────',
  '  Opus 5 (1M context)  in:0 out:0',
].join('\n');

/** A fake pane: empty before typing, then `afterTyping` until the first Enter, then `afterEnter`. */
function pane(afterTyping: string, afterEnter: string) {
  let typed = false;
  let enters = 0;
  const io = {
    typeText: async () => { typed = true; },
    sendEnter: async () => { enters++; },
    capture: () => (!typed ? claude('') : enters === 0 ? afterTyping : afterEnter),
    sleep: async () => {},
    log: () => {},
  };
  return { io, enters: () => enters };
}

describe('idle-only writes own the Claude Code composer before Enter', () => {
  it('a wake whose text is exactly in the composer is submitted', async () => {
    const p = pane(claude(WAKE), claude(''));
    expect(await typeAndSubmit(p.io, WAKE, CLAUDE, 'wake', true, () => true)).toBe('started');
    expect(p.enters()).toBe(1);
  });

  it('a person typing after the wake text: no Enter is pressed, and the wake text stays unsent beside theirs', async () => {
    const p = pane(claude(`${WAKE} and also please look at`), claude(''));
    expect(await typeAndSubmit(p.io, WAKE, CLAUDE, 'wake', true, () => true)).toBe('unverified');
    expect(p.enters()).toBe(0);
  });

  it('the retry Enter also requires the composer to still hold exactly the wake text', async () => {
    let enters = 0;
    let typed = false;
    const io = {
      typeText: async () => { typed = true; },
      sendEnter: async () => { enters++; },
      // Enter is ignored (the composer still shows the wake), then a person adds text before the retry.
      capture: () => (!typed ? claude('') : enters === 0 ? claude(WAKE) : claude(`${WAKE} hold on`)),
      sleep: async () => {},
      log: () => {},
    };
    expect(await typeAndSubmit(io, WAKE, CLAUDE, 'wake', true, () => true)).toBe('unverified');
    expect(enters).toBe(1);
  });

  it('an ordinary (not idle-only) send keeps its old behaviour', async () => {
    const p = pane(claude(`${WAKE} and more`), claude(''));
    // No ownership check for an ordinary send: Enter is pressed as before (outcome reporting is unchanged too).
    expect(await typeAndSubmit(p.io, WAKE, CLAUDE, 'send')).not.toBe('unverified');
    expect(p.enters()).toBeGreaterThanOrEqual(1);
  });
});

/** The capacity retry's real shape: the session's write gate and an empty-composer requirement, no idle callback. */
const RETRY = 'Continue';
const capacity = (io: Parameters<typeof typeAndSubmit>[0]) =>
  withWriteGate(() => true, () => typeAndSubmit(io, RETRY, CLAUDE, 'capacity retry', true));

describe('a capacity retry owns the Claude Code composer before Enter', () => {
  it('its text exactly in the composer is submitted once', async () => {
    const p = pane(claude(RETRY), claude(''));
    const { result, typedUnsent } = await capacity(p.io);
    expect(result).toBe('started');expect(typedUnsent).toBe(false);expect(p.enters()).toBe(1);
  });

  it('a person adding text before Enter: no Enter, and the retry is recorded as typed but unsent', async () => {
    const p = pane(claude(`${RETRY} wait, not yet`), claude(''));
    const { result, typedUnsent } = await capacity(p.io);
    expect(result).toBe('unverified');expect(typedUnsent).toBe(true);expect(p.enters()).toBe(0);
  });

  it('a composer it cannot read: nothing is typed and no Enter is pressed', async () => {
    let typed = false;
    let enters = 0;
    const io = { typeText: async () => { typed = true; }, sendEnter: async () => { enters++; }, capture: () => null, sleep: async () => {}, log: () => {} };
    const { result } = await capacity(io);
    expect(result).toBe('not-written');expect(typed).toBe(false);expect(enters).toBe(0);
  });

  it('a person editing before the retry Enter: no retry, typed but unsent', async () => {
    let enters = 0;
    let typed = false;
    const io = {
      typeText: async () => { typed = true; },
      sendEnter: async () => { enters++; },
      capture: () => (!typed ? claude('') : enters === 0 ? claude(RETRY) : claude(`${RETRY} hold on`)),
      sleep: async () => {},
      log: () => {},
    };
    const { result, typedUnsent } = await capacity(io);
    expect(result).toBe('unverified');expect(typedUnsent).toBe(true);expect(enters).toBe(1);
  });
});

describe('the session runs exactly the writes that own the composer under their gate', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });

  async function claudeSession() {
    const dir = await mkdtemp(join(tmpdir(), 'wake-ownership-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const calls: Array<{ options?: Record<string, unknown>; gated: boolean }> = [];
    const mux = {
      isAvailable: () => true,
      muxSessionExists: () => true,
      isPaneDead: () => false,
      capturePaneText: () => claude(''),
      sendInput: vi.fn(async (_id: string, _text: string, options?: Record<string, unknown>) => { calls.push({ options, gated: writeGateActive() }); return true; }),
    };
    const session = new Session({ workingDir: dir, mode: 'claude', useMux: true, mux: mux as unknown as TerminalMultiplexer,
      muxSession: { sessionId: 'owned', muxName: 'reverie-owned', pid: 41 } as MuxSession });
    cleanups.push(async () => { Object.assign(session, { ptyProcess: null, _muxSession: null }); await session.stop(false); });
    return { session, calls };
  }

  it('the capacity retry caller shape (no idle check) types under its gate with an empty-composer requirement', async () => {
    const { session, calls } = await claudeSession();
    await session.writeViaMux(`${RETRY}\r`, { requireEmptyComposer: true, capacityRetry: true, writeGate: () => true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ gated: true, options: { requireEmptyComposer: true } });
    expect(calls[0]?.options?.stillIdle).toBeUndefined();
  });

  it('an ordinary chat delivery runs with no gate, so it does not own the composer', async () => {
    const { session, calls } = await claudeSession();
    await session.writeViaMux('hello\r', { requireEmptyComposer: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.gated).toBe(false);
  });
});
