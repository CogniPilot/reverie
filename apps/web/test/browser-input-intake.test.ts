import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { browserInputFixture, type InputApp, type IntakeSnapshot } from './helpers/browser-input-fixture.js';

type Intake = {
  bind(journal: object): void;
  reserve(sid: string, chars: number, units?: number): object | null;
  transfer(tokens: object[], sid: string, chars: number, units: number): object | null;
  release(token: object): boolean;
  begin(token: object): boolean;
  batch(sid: string, chars: number, units: number, raw?: object): object | null;
  queue(sid: string, chars: number, units: number, prepared?: object, raw?: object): object | null;
  finish(token: object, accepted: boolean): void;
  rawBlocked(sid: string): boolean;
  raw(sid: string, value: string): object | null;
  rawBuffer(tokens: object[], sid: string, value: string): object | null;
  completeRaw(group: object, accepted: boolean): void;
  performRaw(sid: string, value: string, action: (raw: object) => Promise<boolean>): Promise<boolean>;
  snapshot(): IntakeSnapshot;
};
const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/browser-input-journal.js'), 'utf8');
function pageIntake(now = () => performance.now()): Intake {
  return new Function('window', 'performance', `${source}\nreturn window.ReverieInputJournal.intake;`)(
    {},
    { now }
  ) as Intake;
}
afterEach(() => vi.useRealTimers());

it('binds one canonical page owner once; local reservation handles grant no second journal binding', () => {
  const owner = pageIntake(),
    journal = {};
  owner.bind(journal);
  owner.bind(journal);
  expect(() => owner.bind({})).toThrow('intake-already-bound');
  expect(Reflect.get(owner, 'claimStorage')).toBeUndefined();
  expect(Reflect.get(owner, 'storageSettled')).toBeUndefined();
});

it('transfers capacity without a free interval and rejects stale, duplicate, forged or wrong-SID handles', () => {
  const owner = pageIntake(),
    first = owner.reserve('a', 32)!;
  const current = owner.transfer([first], 'a', 64, 1)!;
  expect(owner.snapshot().chars).toBe(64);
  expect(owner.release(first)).toBe(false);
  expect(owner.release({})).toBe(false);
  expect(owner.transfer([current, current], 'a', 128, 2)).toBeNull();
  expect(owner.transfer([current], 'b', 64, 1)).toBeNull();
  expect(owner.snapshot().chars).toBe(64);
  expect(owner.reserve('b', 4 * 1024 * 1024 - 63)).toBeNull();
  const remaining = owner.reserve('b', 4 * 1024 * 1024 - 64)!;
  expect(remaining).not.toBeNull();
  expect(owner.release(current)).toBe(true);
  expect(owner.release(current)).toBe(false);
  expect(owner.snapshot().chars).toBe(4 * 1024 * 1024 - 64);
  owner.release(remaining);
});

it('the original pending notice survives raw-to-acceptance transfer and never settles or refunds the promise', async () => {
  vi.useFakeTimers();
  let elapsed = 0;
  const owner = pageIntake(() => elapsed);
  let finish!: (accepted: boolean) => void,
    raw!: object,
    settled = false;
  const task = owner
    .performRaw('original', 'A', (group) => {
      raw = group;
      return new Promise<boolean>((done) => {
        finish = done;
      });
    })
    .then((value) => {
      settled = true;
      return value;
    });
  await vi.advanceTimersByTimeAsync(9000);
  elapsed = 9000;
  const batch = owner.batch('original', 3, 2, raw)!;
  expect(batch).not.toBeNull();
  expect(owner.batch('original', 3, 2, raw)).toBeNull();
  expect(owner.release(batch)).toBe(false);
  elapsed = 10000;
  await vi.advanceTimersByTimeAsync(1000);
  expect(owner.snapshot()).toMatchObject({ chars: 3, pending: [{ sid: 'original', accepted: false }] });
  expect(settled).toBe(false);
  finish(true);
  expect(await task).toBe(true);
  expect(owner.snapshot()).toMatchObject({ chars: 0, pending: [] });
  const successor = owner.reserve('original', 7)!;
  owner.completeRaw(raw, false);
  owner.finish(batch, false);
  expect(owner.snapshot().chars).toBe(7);
  owner.release(successor);
});

it.each([-3600000, 3600000])(
  'wall-clock change %sms cannot renew or prematurely expire the original elapsed notice',
  async (wallShift) => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    let elapsed = 0,
      finish!: (accepted: boolean) => void,
      raw!: object,
      settled = false;
    const owner = pageIntake(() => elapsed);
    const task = owner
      .performRaw('original', 'A', (group) => {
        raw = group;
        return new Promise<boolean>((done) => {
          finish = done;
        });
      })
      .then((value) => {
        settled = true;
        return value;
      });
    try {
      elapsed = 8000;
      await vi.advanceTimersByTimeAsync(8000);
      vi.setSystemTime(Date.now() + wallShift);
      expect(owner.batch('original', 2, 1, raw)).not.toBeNull();
      elapsed = 9999;
      await vi.advanceTimersByTimeAsync(1999);
      expect(owner.snapshot().pending).toEqual([]);
      expect(settled).toBe(false);
      elapsed = 10000;
      await vi.advanceTimersByTimeAsync(1);
      expect(owner.snapshot()).toMatchObject({ chars: 2, pending: [{ sid: 'original', accepted: false }] });
      expect(settled).toBe(false);
    } finally {
      finish(true);
      expect(await task).toBe(true);
    }
    expect(owner.snapshot()).toMatchObject({ chars: 0, pending: [] });
  }
);

it('a delayed transfer whose monotonic notice budget is exhausted cannot start a fresh wait window', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  let elapsed = 0,
    finish!: (accepted: boolean) => void,
    raw!: object;
  const owner = pageIntake(() => elapsed);
  const task = owner.performRaw('original', 'A', (group) => {
    raw = group;
    return new Promise<boolean>((done) => {
      finish = done;
    });
  });
  try {
    // Model elapsed work before the event loop could run the original timer callback.
    elapsed = 12000;
    expect(owner.batch('original', 2, 1, raw)).not.toBeNull();
    expect(owner.snapshot()).toMatchObject({ chars: 2, pending: [{ sid: 'original', accepted: false }] });
    await vi.advanceTimersByTimeAsync(0);
    expect(owner.snapshot()).toMatchObject({ chars: 2, pending: [{ sid: 'original', accepted: false }] });
  } finally {
    finish(true);
    await task;
  }
  expect(owner.snapshot().chars).toBe(0);
});

it('cross-raw sources share the cap and freeze before the one overflow event is copied', async () => {
  const owner = pageIntake(),
    half = 'a'.repeat(2 * 1024 * 1024);
  const a = owner.reserve('a', half.length, 32)!,
    b = owner.reserve('b', half.length, 32)!;
  const effect = vi.fn(async () => true);
  expect(await owner.performRaw('overflow-original', '界🙂', effect)).toBe(false);
  expect(await owner.performRaw('other', 'must not be captured', effect)).toBe(false);
  expect(effect).not.toHaveBeenCalled();
  const aRaw = owner.rawBuffer([a], 'a', half)!,
    bRaw = owner.rawBuffer([b], 'b', half)!;
  owner.completeRaw(aRaw, false);
  owner.completeRaw(bRaw, false);
  const state = owner.snapshot();
  expect(state.chars).toBe(4 * 1024 * 1024);
  expect(state.rawPaused).toBe(true);
  expect(state.copies.map((row) => [row.sid, row.text.length])).toEqual([
    ['a', half.length],
    ['b', half.length],
    ['overflow-original', 3],
  ]);
  expect(state.copies[2].text).toBe('界🙂');
  expect(owner.release(a)).toBe(false);
  expect(owner.release(b)).toBe(false);
});

it('a refused expanded raw batch retains only its original event once and cannot release a successor', () => {
  const owner = pageIntake(),
    raw = owner.raw('original', '\r')!;
  const batch = owner.batch('original', 100, 2, raw)!;
  owner.finish(batch, false);
  owner.completeRaw(raw, false);
  owner.finish(batch, false);
  expect(owner.release(batch)).toBe(false);
  expect(owner.snapshot()).toMatchObject({ chars: 1, copies: [{ sid: 'original', text: '\r' }] });
  expect(owner.rawBlocked('original')).toBe(true);
  expect(owner.rawBlocked('successor')).toBe(false);
  const successor = owner.reserve('successor', 8)!;
  owner.completeRaw(raw, true);
  expect(owner.snapshot().chars).toBe(9);
  owner.release(successor);
});

it('frame reservations share a bounded unit budget even when the character budget remains available', () => {
  const owner = pageIntake(),
    all = owner.reserve('a', 4096, 4096)!;
  expect(owner.reserve('b', 1, 1)).toBeNull();
  expect(owner.transfer([all], 'a', 4096, 4097)).toBeNull();
  expect(owner.snapshot()).toMatchObject({ chars: 4096, units: 4096 });
  owner.release(all);
});

it('one allocation cannot enter concurrent or sequential actual Journal acceptance twice', async () => {
  const fixture = browserInputFixture(),
    app = await fixture.page();
  const owner = fixture.intake(app) as Intake;
  const allocation = owner.batch('session-1', 1, 1)!;
  let settled = false;
  const original = app._inputJournal.accept('session-1', ['x'], null, allocation).then((result) => {
    settled = true;
    return result;
  });
  try {
    expect((await app._inputJournal.accept('session-1', ['x'], null, allocation)).kind).toBe('not-queued');
    expect(settled).toBe(false);
    expect(owner.snapshot().chars).toBe(1);
    owner.finish(allocation, false);
    expect(owner.snapshot().chars).toBe(1); // Unknown native storage cannot be refunded.
    expect((await original).kind).toBe('accepted');
    expect((await app._inputJournal.accept('session-1', ['x'], null, allocation)).kind).toBe('not-queued');
    const state = await app._inputJournal.snapshot();
    expect(state.records.map((row) => ({ data: row.data, seq: row.seq, phase: row.phase }))).toEqual([
      { data: 'x', seq: 1, phase: 'prepared' },
    ]);
    expect(owner.snapshot().chars).toBe(1);
    owner.finish(allocation, true);
    expect(owner.snapshot().chars).toBe(0);
  } finally {
    await original;
    await fixture.close();
  }
});

it('the pending exception spends one live exact-SID budget handle and rejects stale, foreign, forged and reused aliases', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  let elapsed = 0;
  const owner = pageIntake(() => elapsed);
  const original = owner.batch('original', 2, 1)!,
    foreign = owner.batch('foreign', 2, 1)!;
  elapsed = 10000;
  await vi.advanceTimersByTimeAsync(10000);
  expect(owner.queue('original', 2, 1, {})).toBeNull();
  expect(owner.queue('original', 2, 1, foreign)).toBeNull();
  expect(owner.queue('original', 3, 1, original)).toBeNull();
  expect(owner.queue('original', 2, 2, original)).toBeNull();
  expect(owner.queue('original', 2, 1)).toBeNull();
  expect(owner.raw('original', 'fresh')).toBeNull();
  const queued = owner.queue('original', 2, 1, original)!;
  expect(queued).not.toBeNull();
  expect(queued).not.toBe(original);
  expect(owner.queue('original', 2, 1, original)).toBeNull();
  expect(owner.queue('original', 2, 1, queued)).toBeNull();
  owner.finish(original, false);
  expect(owner.release(original)).toBe(false);
  expect(owner.snapshot()).toMatchObject({ chars: 4, copies: [] });
  // No Journal was called in this pure queue control. Actual native commit/abort owns storage settlement below.
  owner.finish(queued, false);
  owner.finish(foreign, false);
  expect(owner.snapshot()).toMatchObject({ chars: 0, pending: [] });
});

it('actual App admission reserves before its queued tail and refuses 100 editable retries without extra copies', async () => {
  const fixture = browserInputFixture(),
    app = await fixture.page();
  const original = app as InputApp & { _inputAcceptTail: Promise<unknown> };
  let release!: () => void;
  original._inputAcceptTail = new Promise<void>((done) => {
    release = done;
  });
  const tasks = Array.from({ length: 4 }, () => app._sendInputAsync('a', 'x'.repeat(1024 * 1024)));
  try {
    expect(fixture.intake(app).snapshot().chars).toBe(4 * 1024 * 1024);
    for (let i = 0; i < 100; i++) expect(await app._sendInputAsync('a', 'editable text')).toBe(false);
    expect(fixture.intake(app).snapshot()).toMatchObject({ chars: 4 * 1024 * 1024, copies: [] });
    expect(app._unsavedInputDrafts).toEqual([]);
    app._inputJournal.close();
  } finally {
    release();
    await Promise.allSettled(tasks);
    await fixture.close();
  }
  expect(fixture.intake(app).snapshot().chars).toBe(0);
});

it('a pending actual acceptance keeps its original promise and rejects duplicate editable gestures without copying', async () => {
  const fixture = browserInputFixture(),
    app = await fixture.page();
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  const original = app as InputApp & { _inputAcceptTail: Promise<unknown> };
  let release!: () => void,
    settled = false;
  original._inputAcceptTail = new Promise<void>((done) => {
    release = done;
  });
  const task = app._sendInputAsync('session-1', 'original draft').then((accepted) => {
    settled = true;
    return accepted;
  });
  try {
    await vi.advanceTimersByTimeAsync(10000);
    expect(settled).toBe(false);
    expect(fixture.intake(app).snapshot()).toMatchObject({
      chars: 14,
      pending: [{ sid: 'session-1', accepted: false }],
    });
    for (let i = 0; i < 100; i++) expect(await app._sendInputAsync('session-1', 'original draft')).toBe(false);
    expect(app._unsavedInputDrafts).toEqual([]);
    expect(fixture.intake(app).snapshot().chars).toBe(14);
    release();
    expect(await task).toBe(true);
    await app._drainSession('session-1');
    expect(fixture.intake(app).snapshot()).toMatchObject({ chars: 0, pending: [] });
    app._redeliverSweep();
    await app._drainSession('session-1');
  } finally {
    release();
    await task;
    await fixture.close();
  }
});

it('an overdue original raw gesture continues under its same reservation while fresh gestures stay refused', async () => {
  let elapsed = 0;
  const effects: string[] = [];
  const fixture = browserInputFixture();
  const app = await fixture.page(
    async (_url, options) => {
      if (options?.method === 'POST') effects.push((JSON.parse(String(options.body)) as { input: string }).input);
      return Response.json({ success: true, data: {} });
    },
    [],
    { now: () => elapsed }
  );
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  const current = app as InputApp & {
    _performRawInput(sid: string, value: string, action: (reservation: object) => Promise<boolean>): Promise<boolean>;
    _queueInputFrames(sid: string, frames: string[], mux: null, reservation?: object): Promise<boolean>;
  };
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const task = current._performRawInput('session-1', '\r', async (original) => {
    await gate;
    return current._queueInputFrames('session-1', ['original editable prefix', '\r'], null, original);
  });
  try {
    elapsed = 10000;
    await vi.advanceTimersByTimeAsync(10000);
    expect(fixture.intake(app).snapshot()).toMatchObject({
      chars: 1,
      pending: [{ sid: 'session-1', accepted: false }],
    });
    expect(await current._queueInputFrames('session-1', ['fresh gesture'], null)).toBe(false);
    expect(await app._sendInputAsync('session-1', 'fresh gesture')).toBe(false);
    expect(effects).toEqual([]);
    expect(fixture.intake(app).snapshot().chars).toBe(1);
    release();
    expect(await task).toBe(true);
    await app._drainSession('session-1');
    // The storage batch contains distinct prefix/Enter frames; drive the existing ACK cadence.
    for (let i = 0; i < 2; i++) {
      await vi.advanceTimersByTimeAsync(80);
      await app._drainSession('session-1');
    }
    expect(app._pendingDeliveries.get('session-1')?.length || 0).toBe(0);
    expect(app._inputFlights.has('session-1')).toBe(false);
    app._redeliverSweep();
    await app._drainSession('session-1');
    expect(effects).toEqual(['original editable prefix', '\r']);
    expect(effects.join('')).toBe('original editable prefix\r');
    expect(fixture.intake(app).snapshot()).toMatchObject({ chars: 0, pending: [], copies: [] });
  } finally {
    release();
    await task;
    await fixture.close();
  }
});

it('known storage acceptance is distinguished from a pending refresh without releasing the original promise early', async () => {
  const fixture = browserInputFixture(),
    app = await fixture.page();
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  const current = app as InputApp & { _refreshInputJournal(): Promise<void> };
  const refresh = current._refreshInputJournal.bind(current);
  let entered!: () => void,
    release!: () => void,
    settled = false;
  const began = new Promise<void>((done) => {
    entered = done;
  });
  const gate = new Promise<void>((done) => {
    release = done;
  });
  current._refreshInputJournal = async () => {
    entered();
    await gate;
    await refresh();
  };
  const task = app._sendInputAsync('session-1', 'stored original').then((accepted) => {
    settled = true;
    return accepted;
  });
  try {
    await began;
    await vi.advanceTimersByTimeAsync(10000);
    expect(settled).toBe(false);
    expect(fixture.intake(app).snapshot()).toMatchObject({
      chars: 15,
      pending: [{ sid: 'session-1', accepted: true }],
    });
    expect((await app._inputJournal.snapshot()).records.map((row) => row.data)).toEqual(['stored original']);
    release();
    expect(await task).toBe(true);
    await app._drainSession('session-1');
    expect(fixture.intake(app).snapshot()).toMatchObject({ chars: 0, pending: [] });
  } finally {
    release();
    await task;
    current._refreshInputJournal = refresh;
    await fixture.close();
  }
});

it('malformed frame payloads are refused before they can retain uncharged copied arrays or release another reservation', async () => {
  const fixture = browserInputFixture(),
    app = await fixture.page();
  const send = app as InputApp & {
    _sendInputAsync(sid: string, text: string, options: { frames: string[] }): Promise<boolean>;
  };
  try {
    expect(await send._sendInputAsync('a', 'x', { frames: ['oversized'.repeat(100000)] })).toBe(false);
    expect(await send._sendInputAsync('a', 'x', { frames: Array(4097).fill('x') })).toBe(false);
    expect(await send._sendInputAsync('a', 'xy', { frames: ['x', 'z'] })).toBe(false);
    expect(fixture.intake(app).snapshot()).toMatchObject({ chars: 0, units: 0, copies: [] });
  } finally {
    await fixture.close();
  }
});
