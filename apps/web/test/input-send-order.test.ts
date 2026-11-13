/** Actual journal/mixin transaction controls; Chromium separately qualifies real Web Locks/IDB. */
import { afterEach, describe, expect, it } from 'vitest';
import { browserInputFixture, FixtureLocks } from './helpers/browser-input-fixture.js';
let fixture: ReturnType<typeof browserInputFixture>;
afterEach(async () => {
  await fixture?.close();
});
const response = (data: object = {}, status = 200) => Response.json({ success: status === 200, data }, { status });
const body = (options?: RequestInit) =>
  JSON.parse(String(options?.body)) as { input: string; seq: number; clientId: string };

describe('committed ordering and original transport ownership', () => {
  it('rapid input retains distinct original-issuer frames and advances only on confirmed ACKs', async () => {
    fixture = browserInputFixture();
    const app = await fixture.page(),
      frames: { t: string; d: string; seq: number; cid: string }[] = [];
    app._ws = { readyState: 1, send: (data) => frames.push(JSON.parse(data)) };
    app._wsSessionId = 'session-1';
    expect(await Promise.all(['a', 'b', 'c'].map((text) => app._sendInputAsync('session-1', text)))).toEqual([
      true,
      true,
      true,
    ]);
    for (let seq = 1; seq <= 3; seq++) {
      await expect.poll(() => frames.length).toBe(seq);
      expect(frames.map((frame) => frame.d)).toEqual(['a', 'b', 'c'].slice(0, seq));
      await app._onWsInputAck(seq, { t: 'ia', seq, confirmed: true }, 'session-1');
    }
    expect(frames.map((frame) => frame.seq)).toEqual([1, 2, 3]);
    expect(frames.every((frame) => frame.t === 'i' && frame.cid === app._inputJournal.issuer)).toBe(true);
    expect(app._clientId).not.toBe(app._inputJournal.issuer);
    await expect.poll(() => app._pendingDeliveries.get('session-1')?.length || 0).toBe(0);
  });

  it('HTTP is serialized until each original response settles and explicitly marks protocol2', async () => {
    fixture = browserInputFixture();
    const calls: ReturnType<typeof body>[] = [],
      completions: (() => void)[] = [];
    const app = await fixture.page(async (_url, options) => {
      expect(new Headers(options?.headers).get('X-Reverie-Input-Protocol')).toBe('2');
      calls.push(body(options));
      await new Promise<void>((resolve) => completions.push(resolve));
      return response();
    });
    await app._sendInputAsync('session-1', 'a');
    await app._sendInputAsync('session-1', 'b');
    await expect.poll(() => calls.length).toBe(1);
    expect(calls.map((row) => row.input)).toEqual(['a']);
    completions.shift()!();
    await expect.poll(() => calls.length).toBe(2);
    expect(calls.map((row) => row.input)).toEqual(['a', 'b']);
    expect(calls.map((row) => row.seq)).toEqual([1, 2]);
    expect(new Set(calls.map((row) => row.clientId))).toEqual(new Set([app._inputJournal.issuer]));
    completions.shift()!();
    await expect.poll(() => app._pendingDeliveries.get('session-1')?.length || 0).toBe(0);
  });

  it.each([400, 401, 403, 404, 409, 413, 422, 503])(
    'ambiguous HTTP%s retains both records, holds visibly and never replays',
    async (status) => {
      fixture = browserInputFixture();
      const calls: ReturnType<typeof body>[] = [];
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const app = await fixture.page(async (_url, options) => {
        calls.push(body(options));
        await gate;
        return response({}, status);
      });
      expect(await app._sendInputAsync('session-1', 'first')).toBe(true);
      expect(await app._sendInputAsync('session-1', 'second')).toBe(true);
      await expect.poll(() => calls.length).toBe(1);
      release();
      await expect.poll(() => app._inputRecoveryHolds?.has('session-1')).toBe(true);
      for (let round = 0; round < 3; round++) {
        app._redeliverSweep();
        await app._drainSession('session-1');
      }
      expect(calls.map((row) => row.input)).toEqual(['first']);
      const state = await app._inputJournal.snapshot();
      expect([...state.records, ...state.retained].map((row) => row.data)).toEqual(['first', 'second']);
      // The actual banner is asserted in Chromium; this DOM-free fixture proves
      // the same persistent hold that drives its visible read-only state.
      expect(state.holds.some((hold) => hold.sid === 'session-1')).toBe(true);
      expect(await app._sendInputAsync('session-1', 'not accepted')).toBe(false);
      expect(app._unsavedInputDrafts).toEqual([]);
    }
  );

  it('correlated typed-unsent removes only that record, warns and advances later input once', async () => {
    fixture = browserInputFixture();
    const calls: string[] = [];
    const app = await fixture.page(async (_url, options) => {
      calls.push(body(options).input);
      return calls.length === 1
        ? Response.json(
            { success: false, errorCode: 'SESSION_BUSY', data: { delivered: false, typedUnsent: true } },
            { status: 409 }
          )
        : response();
    });
    await Promise.all(['first\r', 'second\r'].map((text) => app._sendInputAsync('session-1', text)));
    // This prototype fixture omits the constructor's recurring sweep; drive
    // that real event explicitly instead of relying on one timer tick.
    await expect
      .poll(() => {
        app._redeliverSweep();
        return calls;
      })
      .toEqual(['first\r', 'second\r']);
    await expect.poll(() => app._pendingDeliveries.get('session-1')?.length || 0).toBe(0);
    expect(app.showToast.mock.calls.flat().join(' ')).toMatch(/withheld|unsent/i);
    expect(app._inputRecoveryHolds?.has('session-1')).not.toBe(true);
  });

  it.each(['pending', 'confirmed', 'unknown'])(
    'lost ACK uses receipt GET only; %s never repeats a write',
    async (state) => {
      fixture = browserInputFixture();
      const writes: string[] = [],
        reads: string[] = [];
      const app = await fixture.page(async (url) => {
        reads.push(url);
        const query = new URL(url, 'http://fixture').searchParams;
        return response({
          version: 1,
          clientId: query.get('clientId'),
          seq: Number(query.get('seq')),
          fingerprint: query.get('fingerprint'),
          state,
        });
      });
      app._ws = { readyState: 1, send: (frame) => writes.push(frame) };
      app._wsSessionId = 'session-1';
      await app._sendInputAsync('session-1', 'original');
      await expect.poll(() => writes.length).toBe(1);
      app._inputRetryAt.set('session-1', 0);
      await app._drainSession('session-1');
      expect(reads).toHaveLength(1);
      expect(reads[0]).toContain('/input-receipt?');
      expect(writes).toHaveLength(1);
      if (state === 'confirmed') expect(app._pendingDeliveries.has('session-1')).toBe(false);
      else if (state === 'unknown') expect(app._inputRecoveryHolds?.has('session-1')).toBe(true);
      else expect(app._pendingDeliveries.get('session-1')?.[0].phase).toBe('pending');
    }
  );

  it('known pre-effect refusal retries the exact original tag without new allocation', async () => {
    fixture = browserInputFixture();
    const app = await fixture.page(),
      frames: object[] = [];
    app._ws = { readyState: 1, send: (data) => frames.push(JSON.parse(data)) };
    app._wsSessionId = 'session-1';
    await app._sendInputAsync('session-1', 'original');
    await expect.poll(() => frames.length).toBe(1);
    await app._onWsInputRefusal(1, { t: 'ir', seq: 1, retryable: true, reason: 'capacity' }, 'session-1');
    app._inputRetryAt.set('session-1', 0);
    await app._drainSession('session-1');
    await expect.poll(() => frames.length).toBe(2);
    expect(frames[1]).toEqual(frames[0]);
    await app._onWsInputAck(1, { t: 'ia', seq: 1, confirmed: true }, 'session-1');
  });
});

describe('test harness page ownership', () => {
  it('exclusive locks retain ownership until settlement, queue competitors and refuse ifAvailable', async () => {
    const locks = new FixtureLocks(),
      order: string[] = [];
    let release!: () => void;
    const first = locks.request('page', {}, async (lock) => {
      expect(lock?.name).toBe('page');
      order.push('first');
      await new Promise<void>((done) => {
        release = done;
      });
    });
    await Promise.resolve();
    const second = locks.request('page', {}, () => {
      order.push('second');
    });
    expect(await locks.request('page', { ifAvailable: true }, (lock) => lock)).toBeNull();
    expect(order).toEqual(['first']);
    release();
    await first;
    await second;
    expect(order).toEqual(['first', 'second']);
  });
  it('independent pages have distinct issuers; transaction abort commits no records and retains the draft', async () => {
    fixture = browserInputFixture();
    const left = await fixture.page(),
      right = await fixture.page();
    expect(left._inputJournal.issuer).not.toBe(right._inputJournal.issuer);
    fixture.abortWrites();
    expect(await left._sendInputAsync('session-1', 'retained draft')).toBe(false);
    expect((await left._inputJournal.snapshot()).records).toEqual([]);
    expect(left._unsavedInputDrafts).toEqual([]);
    expect(left._inputStorageUnavailable).toBe(true);
  });
  it.each(['throw', 'ignored'] as const)(
    'strict durability %s refuses acceptance, retains the draft and never falls back',
    async (mode) => {
      fixture = browserInputFixture();
      let effects = 0;
      const app = await fixture.page(async () => {
        effects++;
        return response();
      });
      fixture.refuseStrict(mode);
      expect(await app._sendInputAsync('session-1', 'strict-only draft')).toBe(false);
      expect(effects).toBe(0);
      expect(app._inputStorageUnavailable).toBe(true);
      expect(app._unsavedInputDrafts).toEqual([]);
      expect(fixture.transactionOptions.every((options) => options?.durability === 'strict')).toBe(true);
    }
  );
});
