/** Actual async journal/mixin routes each original input through its session socket. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserInputFixture } from './helpers/browser-input-fixture.js';
type Frame = { t: string; d: string; seq?: number; cid?: string };
const socket = (frames: Frame[]) => ({
  readyState: 1,
  send: (data: string) => frames.push(JSON.parse(data)),
  close: vi.fn(),
});
let fixture: ReturnType<typeof browserInputFixture>;
afterEach(async () => {
  await fixture?.close();
});

describe('registered socket routing after committed acceptance', () => {
  it('uses the registered session socket and original journal issuer in order, without leaking onto primary', async () => {
    fixture = browserInputFixture();
    const app = await fixture.page(),
      primary: Frame[] = [],
      other: Frame[] = [];
    app._ws = socket(primary);
    app._wsSessionId = 'primary';
    app._registerInputSocket('other', { ws: socket(other), lastRecvAt: 0 });
    await app._sendInputAsync('other', 'x');
    await app._sendInputAsync('other', 'y');
    await expect.poll(() => other.length).toBe(1);
    await app._onWsInputAck(1, { t: 'ia', seq: 1, confirmed: true }, 'other');
    await expect.poll(() => other.length).toBe(2);
    expect(other.map((row) => [row.d, row.seq, row.cid])).toEqual([
      ['x', 1, app._inputJournal.issuer],
      ['y', 2, app._inputJournal.issuer],
    ]);
    expect(primary).toEqual([]);
    await app._onWsInputAck(2, { t: 'ia', seq: 2, confirmed: true }, 'other');
  });
  it('prefers primary for its session over a second registration and defaults ACKs to that session', async () => {
    fixture = browserInputFixture();
    const app = await fixture.page(),
      primary: Frame[] = [],
      other: Frame[] = [];
    app._ws = socket(primary);
    app._wsSessionId = 'primary';
    app._registerInputSocket('primary', { ws: socket(other), lastRecvAt: 0 });
    await app._sendInputAsync('primary', 'a');
    await expect.poll(() => primary.length).toBe(1);
    await app._onWsInputAck(1, { t: 'ia', seq: 1, confirmed: true });
    expect(other).toEqual([]);
    expect(app._pendingDeliveries.has('primary')).toBe(false);
  });
  it('a closed registration falls back to a single tagged protocol2 POST', async () => {
    fixture = browserInputFixture();
    const posts: object[] = [];
    const app = await fixture.page(async (_url, options) => {
      expect(new Headers(options?.headers).get('X-Reverie-Input-Protocol')).toBe('2');
      posts.push(JSON.parse(String(options?.body)));
      return Response.json({ success: true, data: {} });
    });
    app._registerInputSocket('other', { ws: { ...socket([]), readyState: 3 }, lastRecvAt: 0 });
    expect(app._inputSocketFor('other')).toBeNull();
    await app._sendInputAsync('other', 'z');
    await expect.poll(() => posts).toEqual([{ input: 'z', seq: 1, clientId: app._inputJournal.issuer }]);
  });
  it('ephemeral mouse/focus events use that socket without sequence or journal records', async () => {
    fixture = browserInputFixture();
    const app = await fixture.page(),
      frames: Frame[] = [];
    app._registerInputSocket('other', { ws: socket(frames), lastRecvAt: 0 });
    for (const data of ['\x1b[<64;1;1M', '\x1b[I']) app._sendInputEphemeral('other', data);
    expect(frames).toEqual([
      { t: 'i', d: '\x1b[<64;1;1M' },
      { t: 'i', d: '\x1b[I' },
    ]);
    expect((await app._inputJournal.snapshot()).records).toEqual([]);
  });
  it('a confirmed ACK settles only its socket session even when both sequences equal1', async () => {
    fixture = browserInputFixture();
    const app = await fixture.page(),
      primary: Frame[] = [],
      other: Frame[] = [];
    app._ws = socket(primary);
    app._wsSessionId = 'primary';
    app._registerInputSocket('other', { ws: socket(other), lastRecvAt: 0 });
    await app._sendInputAsync('primary', 'p');
    await app._sendInputAsync('other', 'o');
    await expect.poll(() => [primary.length, other.length]).toEqual([1, 1]);
    await app._onWsInputAck(1, { t: 'ia', seq: 1, confirmed: true }, 'other');
    expect(app._pendingDeliveries.has('other')).toBe(false);
    expect(app._pendingDeliveries.get('primary')?.map((row) => row.data)).toEqual(['p']);
    await app._onWsInputAck(1, { t: 'ia', seq: 1, confirmed: true }, 'primary');
  });
});

describe('registration identity and uncertainty', () => {
  it('a stale close cannot unregister its successor; only the exact owning handle removes it', async () => {
    fixture = browserInputFixture();
    const app = await fixture.page(),
      frames: Frame[] = [],
      old = { ws: socket([]), lastRecvAt: 0 },
      current = { ws: socket(frames), lastRecvAt: 0 };
    app._registerInputSocket('other', old);
    const before = Date.now();
    app._registerInputSocket('other', current);
    expect(current.lastRecvAt).toBeGreaterThanOrEqual(before);
    app._unregisterInputSocket('other', old);
    await app._sendInputAsync('other', 'still here');
    await expect.poll(() => frames.length).toBe(1);
    await app._onWsInputAck(1, { t: 'ia', seq: 1, confirmed: true }, 'other');
    app._unregisterInputSocket('other', current);
    expect(app._inputSocketFor('other')).toBeNull();
  });
  it.each([false, true])(
    'a replacement socket never replays possibly-issued input, old socket chatty=%s',
    async (chatty) => {
      fixture = browserInputFixture();
      const reads: string[] = [];
      const app = await fixture.page(async (url) => {
        reads.push(url);
        const query = new URL(url, 'http://fixture').searchParams;
        return Response.json({
          success: true,
          data: {
            version: 1,
            clientId: query.get('clientId'),
            seq: Number(query.get('seq')),
            fingerprint: query.get('fingerprint'),
            state: 'unknown',
          },
        });
      });
      const first: Frame[] = [],
        second: Frame[] = [],
        old = { ws: socket(first), lastRecvAt: chatty ? Date.now() : 0 };
      app._registerInputSocket('other', old);
      await app._sendInputAsync('other', 'possible effect');
      await expect.poll(() => first.length).toBe(1);
      old.ws.readyState = 3;
      const next = { ws: socket(second), lastRecvAt: 0 };
      app._registerInputSocket('other', next);
      app._inputRetryAt.set('other', 0);
      app._onWsReady('other');
      await app._drainSession('other');
      expect(reads).toHaveLength(1);
      expect(reads[0]).toContain('/input-receipt?');
      expect(second).toEqual([]);
      expect(app._inputRecoveryHolds?.has('other')).toBe(true);
      expect(first).toHaveLength(1);
      expect(next.ws.close).not.toHaveBeenCalled();
    }
  );
});
