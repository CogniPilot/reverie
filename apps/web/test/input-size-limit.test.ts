/**
 * @fileoverview Oversized input must never poison the durable input queue (#484).
 *
 * The failure: a paste over MAX_INPUT_LENGTH was queued for reliable delivery,
 * refused by both transports (the WebSocket silently, the POST with a 400), and
 * never dropped by the client, which treated a 400 like a transient failure. It
 * was re-sent every 2 s forever, blocked every later input for that session
 * behind it, and came back from localStorage on every reload.
 *
 * The fix, pinned here: the client splits a large paste into in-limit frames
 * (one limit, shared with the server), drops a frame the server refused for
 * good, and prunes oversized frames persisted by an older build.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { browserInputFixture } from './helpers/browser-input-fixture.js';
import { MAX_INPUT_LENGTH } from '../src/config/terminal-limits.js';
import { SessionInputWithLimitSchema } from '../src/web/schemas.js';

const pub = (f: string) => readFileSync(resolve(import.meta.dirname, '../src/web/public', f), 'utf8');

type InputLimit = { FRAME_MAX_CHARS: number; PASTE_MAX_CHARS: number; split: (d: string, max?: number) => string[] };

function loadLimit(): InputLimit {
  const context = vm.createContext({ window: {}, globalThis: {} });
  vm.runInContext(pub('constants.js'), context, { filename: 'constants.js' });
  return (context.window as { ReverieInputLimit: InputLimit }).ReverieInputLimit;
}

describe('one input limit on both sides', () => {
  it('the frontend frame limit equals the server MAX_INPUT_LENGTH', () => {
    expect(loadLimit().FRAME_MAX_CHARS).toBe(MAX_INPUT_LENGTH);
  });

  it('the composer budget is derived from the same number', () => {
    expect(pub('keyboard-accessory.js')).toMatch(
      new RegExp(`COMPOSER_INPUT_FRAME_LIMIT = (64 \\* 1024|${MAX_INPUT_LENGTH});`)
    );
    expect(MAX_INPUT_LENGTH).toBe(64 * 1024);
  });

  it('the POST schema caps input at MAX_INPUT_LENGTH, not a second number', () => {
    expect(SessionInputWithLimitSchema.safeParse({ input: 'x'.repeat(MAX_INPUT_LENGTH) }).success).toBe(true);
    expect(SessionInputWithLimitSchema.safeParse({ input: 'x'.repeat(MAX_INPUT_LENGTH + 1) }).success).toBe(false);
  });
});

describe('splitInputFrames', () => {
  const { split } = loadLimit();

  it('returns a short input as one frame and nothing for empty input', () => {
    expect(split('abc')).toEqual(['abc']);
    expect(split('')).toEqual([]);
  });

  it('splits a large paste into in-limit frames that rejoin byte-identically', () => {
    const paste = '\x1b[200~' + 'log line\n'.repeat(15000) + '\x1b[201~';
    const frames = split(paste);
    expect(frames.length).toBeGreaterThan(1);
    for (const f of frames) expect(f.length).toBeLessThanOrEqual(MAX_INPUT_LENGTH);
    expect(frames.join('')).toBe(paste);
  });

  it('never cuts a surrogate pair in half', () => {
    const paste = 'a' + '😀'.repeat(10); // pairs start at odd offsets
    const frames = split(paste, 4);
    expect(frames.join('')).toBe(paste);
    for (const f of frames) {
      const last = f.charCodeAt(f.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
      const first = f.charCodeAt(0);
      expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
    }
  });
});

describe('bounded committed frames and retained uncertain input', () => {
  let fixture: ReturnType<typeof browserInputFixture>;
  afterEach(async () => {
    await fixture?.close();
  });
  it('commits a split paste atomically with bounded frames and preserves Unicode bytes', async () => {
    fixture = browserInputFixture();
    const frames: { seq: number; d: string }[] = [];
    const app = await fixture.page();
    app._ws = { readyState: 1, send: (data) => frames.push(JSON.parse(data)) };
    app._wsSessionId = 'session-1';
    const paste = 'x'.repeat(MAX_INPUT_LENGTH - 1) + '😀' + 'tail';
    expect(await app._sendInputAsync('session-1', paste)).toBe(true);
    const rows = (await app._inputJournal.snapshot()).records;
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.data).join('')).toBe(paste);
    expect(rows.every((row) => row.data.length <= MAX_INPUT_LENGTH && !/[\uD800-\uDBFF]$/.test(row.data))).toBe(true);
    await expect.poll(() => frames.length).toBe(1);
    await app._onWsInputAck(1, { t: 'ia', seq: 1, confirmed: true }, 'session-1');
    await expect.poll(() => frames.length).toBe(2);
    expect(frames.map((frame) => frame.d).join('')).toBe(paste);
    await app._onWsInputAck(2, { t: 'ia', seq: 2, confirmed: true }, 'session-1');
  });
  it.each([true, false])('refuses oversized editable mux=%s before storage/effects without duplicating its draft', async (useMux) => {
    fixture = browserInputFixture();
    let effects = 0;
    const app = await fixture.page(async () => {
      effects++;
      return Response.json({ success: true, data: {} });
    });
    const text = 'x'.repeat((useMux ? MAX_INPUT_LENGTH : loadLimit().PASTE_MAX_CHARS) + 1);
    expect(await app._sendInputAsync('session-1', text, { useMux })).toBe(false);
    expect((await app._inputJournal.snapshot()).records).toEqual([]);
    expect(effects).toBe(0);
    expect(app._unsavedInputDrafts).toEqual([]);
    expect(app.showToast.mock.calls.flat().join(' ')).toMatch(/too large/i);
  });
  it('an invalid WS acknowledgment holds the original frame instead of deleting or reissuing it', async () => {
    fixture = browserInputFixture();
    const frames: string[] = [],
      app = await fixture.page();
    app._ws = { readyState: 1, send: (data) => frames.push(data) };
    app._wsSessionId = 'session-1';
    await app._sendInputAsync('session-1', 'retained');
    await expect.poll(() => frames.length).toBe(1);
    await app._onWsInputAck(1, { t: 'ia', seq: 1, err: 'too large' }, 'session-1');
    await app._drainSession('session-1');
    expect(frames).toHaveLength(1);
    expect(app._inputRecoveryHolds?.has('session-1')).toBe(true);
    const state = await app._inputJournal.snapshot();
    expect([...state.records, ...state.retained].map((row) => row.data)).toEqual(['retained']);
  });
  it('quarantines oversized legacy snapshots without modifying their bytes or replaying them', async () => {
    fixture = browserInputFixture();
    const text = 'x'.repeat(MAX_INPUT_LENGTH + 1),
      raw = JSON.stringify({ pending: { 'session-1': [{ seq: 1, data: text }] } });
    fixture.storage.set('reverie:pendingInput', raw);
    let effects = 0;
    const app = await fixture.page(async () => {
      effects++;
      return Response.json({ success: true, data: {} });
    });
    expect(fixture.storage.get('reverie:pendingInput')).toBe(raw);
    expect(await app._sendInputAsync('session-1', 'new input')).toBe(false);
    expect(effects).toBe(0);
    expect((await app._inputJournal.snapshot()).holds.some((hold) => hold.sid === 'session-1')).toBe(true);
  });
});
