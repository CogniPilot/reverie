/** Actual Chromium IndexedDB/Web Locks; synthetic local origin, no providers. */
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';

type Row = {
  key: string;
  sid: string;
  issuer: string;
  seq: number;
  data: string;
  useMux: boolean | null;
  revision: number;
  phase: string;
  fingerprint: string;
};
type Snapshot = { records: Row[]; retained: Row[]; holds: Array<{ sid: string; reason: string }> };
type Journal = {
  issuer: string;
  descriptor: object;
  accept(
    sid: string,
    frames: string[],
    useMux?: boolean | null
  ): Promise<{ kind: string; reason?: string; records?: Row[] }>;
  claim(row: Row): Promise<Row | null>;
  settle(row: Row, phase: string): Promise<Row | null>;
  snapshot(): Promise<Snapshot>;
  admitted(row: Row): boolean;
  dispatch(row: Row, effect: (row: Row) => void): Promise<boolean>;
  hold(sid: string): Promise<void>;
  close(): void;
};
type Scope = {
  ReverieInputJournal: { open(identity: object, options?: object): Promise<Journal> };
  reviewJournal: Journal;
  reviewRow: Row;
  reviewPending: Row;
};
const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/browser-input-journal.js'), 'utf8');
let browser: Browser, server: Server, origin: string;
const identity = { version: 1, kind: 'session', scopeId: 'synthetic-current-auth-session', epoch: 1 };
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/journal.js') {
      res.setHeader('content-type', 'text/javascript');
      res.end(source);
      return;
    }
    if (req.url !== '/') {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><script src="/journal.js"></script>');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({
    headless: true,
    chromiumSandbox: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {}),
  });
});
afterAll(async () => {
  await browser?.close();
  if (server) await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
});
async function page(context: BrowserContext, descriptor: object = identity, legacy?: object): Promise<Page> {
  const page = await context.newPage();
  await page.goto(origin);
  await page.evaluate(
    async ({ descriptor, legacy }) => {
      const scope = window as unknown as Scope;
      scope.reviewJournal = await scope.ReverieInputJournal.open(descriptor, { legacy });
    },
    { descriptor, legacy }
  );
  return page;
}
const snapshot = (page: Page) => page.evaluate(() => (window as unknown as Scope).reviewJournal.snapshot());
async function accept(page: Page, value: string) {
  return page.evaluate(async (value) => {
    const scope = window as unknown as Scope,
      result = await scope.reviewJournal.accept('same-session', [value]);
    if (result.records) scope.reviewRow = result.records[0];
    return result;
  }, value);
}

it.each([false, true])(
  'two preloaded pages retain independent original tags and durable rows, same text=%s',
  async (same) => {
    const context = await browser.newContext();
    try {
      const [a, b] = await Promise.all([page(context), page(context)]);
      const left = await accept(a, 'first intent'),
        right = await accept(b, same ? 'first intent' : 'second intent');
      expect(left.kind).toBe('accepted');
      expect(right.kind).toBe('accepted');
      expect(left.records![0].seq).toBe(1);
      expect(right.records![0].seq).toBe(1);
      expect(left.records![0].issuer).not.toBe(right.records![0].issuer);
      expect((await snapshot(a)).records.map((row) => row.data)).toEqual(['first intent']);
      expect((await snapshot(b)).records.map((row) => row.data)).toEqual([same ? 'first intent' : 'second intent']);
      await a.reload();
      // Reload does not mutate another live page's actual lease or snapshot.
      expect((await snapshot(b)).records.map((row) => row.data)).toEqual([same ? 'first intent' : 'second intent']);
    } finally {
      await context.close();
    }
  }
);

it('a reload holds may-issued input without retagging or interpreting it as prepared', async () => {
  const context = await browser.newContext();
  try {
    const a = await page(context);
    const original = await accept(a, 'possible effect');
    const claimed = await a.evaluate(async () => {
      const s = window as unknown as Scope;
      const row = await s.reviewJournal.claim(s.reviewRow);
      return { row, admitted: !!row && s.reviewJournal.admitted(row) };
    });
    expect(claimed.admitted).toBe(true);
    expect(claimed.row?.phase).toBe('may-issued');
    await a.close();
    const restored = await page(context);
    const state = await snapshot(restored);
    expect(state.records).toEqual([]);
    expect(state.retained).toHaveLength(1);
    expect(state.retained[0]).toMatchObject({
      issuer: original.records![0].issuer,
      seq: 1,
      data: 'possible effect',
      phase: 'unconfirmed',
    });
    expect(state.holds).toEqual([{ sid: 'same-session', reason: 'restored-unconfirmed' }]);
    expect(await accept(restored, 'new text')).toEqual({ kind: 'not-queued', reason: 'input-held' });
  } finally {
    await context.close();
  }
});

it('only one of two pages acquires prepared orphan custody, preserving its original issuer and tag', async () => {
  const context = await browser.newContext();
  try {
    const a = await page(context);
    const original = await accept(a, 'never dispatched');
    await a.close();
    const [b, c] = await Promise.all([page(context), page(context)]);
    const snapshots = await Promise.all([snapshot(b), snapshot(c)]);
    expect(snapshots.map((state) => state.records.length).sort()).toEqual([0, 1]);
    const adopted = snapshots.flatMap((state) => state.records);
    expect(adopted[0]).toMatchObject({
      issuer: original.records![0].issuer,
      seq: 1,
      data: 'never dispatched',
      phase: 'prepared',
    });
    const newIssuers = await Promise.all(
      [b, c].map((p) => p.evaluate(() => (window as unknown as Scope).reviewJournal.issuer))
    );
    expect(newIssuers).not.toContain(adopted[0].issuer);
  } finally {
    await context.close();
  }
});

it('anonymous mode never adopts prior-page prepared input', async () => {
  const context = await browser.newContext();
  const anonymous = { ...identity, kind: 'anonymous', scopeId: 'synthetic-actual-anonymous-access' };
  try {
    const a = await page(context, anonymous);
    await accept(a, 'unattributed original');
    await a.close();
    const b = await page(context, anonymous),
      state = await snapshot(b);
    expect(state.records).toEqual([]);
    expect(state.retained[0]).toMatchObject({ phase: 'unconfirmed', data: 'unattributed original' });
    expect(state.holds).toEqual([{ sid: 'same-session', reason: 'anonymous-restored' }]);
  } finally {
    await context.close();
  }
});

it('copies legacy bytes under the migration lock without deleting, retagging or replaying them', async () => {
  const context = await browser.newContext();
  const raw = JSON.stringify({
    seqs: { 'same-session': 7 },
    pending: { 'same-session': [{ seq: 7, data: 'legacy uncertain', useMux: false }] },
    heldSessions: [],
  });
  try {
    await context.addInitScript((raw) => {
      localStorage.setItem('reverie:pendingInput', raw);
      localStorage.setItem('reverie:clientId', 'legacy-original-client');
    }, raw);
    const legacy = { raw, clientId: 'legacy-original-client' };
    const [a, b] = await Promise.all([page(context, identity, legacy), page(context, identity, legacy)]);
    for (const p of [a, b]) {
      expect((await snapshot(p)).holds).toEqual([{ sid: 'same-session', reason: 'legacy-unconfirmed' }]);
      expect(await accept(p, 'do not append')).toEqual({ kind: 'not-queued', reason: 'input-held' });
      expect(await p.evaluate(() => localStorage.getItem('reverie:pendingInput'))).toBe(raw);
      expect(await p.evaluate(() => localStorage.getItem('reverie:clientId'))).toBe('legacy-original-client');
    }
  } finally {
    await context.close();
  }
});

it('rejects stale settlement and preserves a subsequent unknown hold', async () => {
  const context = await browser.newContext();
  try {
    const a = await page(context);
    await accept(a, 'original');
    const result = await a.evaluate(async () => {
      const s = window as unknown as Scope,
        claimed = await s.reviewJournal.claim(s.reviewRow);
      if (!claimed) throw new Error('No original claim');
      if (!(await s.reviewJournal.dispatch(claimed, () => {}))) throw new Error('No original dispatch');
      const pending = await s.reviewJournal.settle(claimed, 'pending');
      const stale = await s.reviewJournal.settle(claimed, 'confirmed');
      const unknown = pending && (await s.reviewJournal.settle(pending, 'unconfirmed'));
      const late = unknown && (await s.reviewJournal.settle(unknown, 'confirmed'));
      return { stale, late, snapshot: await s.reviewJournal.snapshot() };
    });
    expect(result.stale).toBeNull();
    expect(result.late).toBeNull();
    expect(result.snapshot.holds).toEqual([{ sid: 'same-session', reason: 'input-unconfirmed' }]);
    expect(result.snapshot.records[0].phase).toBe('unconfirmed');
  } finally {
    await context.close();
  }
});

it('an actual IDB transaction abort returns known not queued with no record admitted', async () => {
  const context = await browser.newContext();
  try {
    const a = await page(context);
    const result = await a.evaluate(async () => {
      const s = window as unknown as Scope,
        original = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (...args: Parameters<typeof original>) {
        const tx = original.apply(this, args);
        if (args[1] === 'readwrite') queueMicrotask(() => tx.abort());
        return tx;
      };
      try {
        return await s.reviewJournal.accept('same-session', ['unsaved draft']);
      } finally {
        IDBDatabase.prototype.transaction = original;
      }
    });
    expect(result).toEqual({ kind: 'not-queued', reason: 'storage-unavailable' });
    expect((await snapshot(a)).records).toEqual([]);
  } finally {
    await context.close();
  }
});

it('only the original committed claim can dispatch once; notifications cannot undo publication', async () => {
  const context = await browser.newContext();
  try {
    const a = await page(context);
    const result = await a.evaluate(async () => {
      const s = window as unknown as Scope;
      (s.reviewJournal as Journal & { onChange(): void }).onChange = () => {
        throw new Error('Observer failed after publication');
      };
      const frames = ['captured original'];
      const acceptance = s.reviewJournal.accept('same-session', frames);
      frames[0] = 'changed caller buffer';
      const accepted = await acceptance;
      const original = accepted.records![0];
      const claimed = await s.reviewJournal.claim(original);
      if (!claimed) throw new Error('No actual original claim');
      let effects = 0;
      const forged = await s.reviewJournal.dispatch(structuredClone(claimed), () => {
        effects++;
      });
      const first = await s.reviewJournal.dispatch(claimed, () => {
        effects++;
      });
      const repeated = await s.reviewJournal.dispatch(claimed, () => {
        effects++;
      });
      const pending = await s.reviewJournal.settle(claimed, 'pending');
      const repeatedPending =
        pending &&
        (await s.reviewJournal.dispatch(pending, () => {
          effects++;
        }));
      return { accepted, effects, forged, first, repeated, repeatedPending };
    });
    expect(result.accepted).toMatchObject({ kind: 'accepted', records: [{ data: 'captured original' }] });
    expect(result).toMatchObject({ effects: 1, forged: false, first: true, repeated: false, repeatedPending: false });
  } finally {
    await context.close();
  }
});

it('a committed hold on another page fences an already claimed transport without broadcast notification', async () => {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    Object.defineProperty(window, 'BroadcastChannel', { value: undefined });
  });
  try {
    const a = await page(context),
      b = await page(context);
    await accept(a, 'claimed before another page holds it');
    await a.evaluate(async () => {
      const s = window as unknown as Scope;
      s.reviewPending = (await s.reviewJournal.claim(s.reviewRow))!;
    });
    await b.evaluate(() => (window as unknown as Scope).reviewJournal.hold('same-session'));
    const outcome = await a.evaluate(async () => {
      const s = window as unknown as Scope;
      let effects = 0;
      const dispatched = await s.reviewJournal.dispatch(s.reviewPending, () => {
        effects++;
      });
      const repeated = await s.reviewJournal.dispatch(s.reviewPending, () => {
        effects++;
      });
      return { dispatched, repeated, effects, snapshot: await s.reviewJournal.snapshot() };
    });
    expect(outcome).toMatchObject({ dispatched: false, repeated: false, effects: 0 });
    expect(outcome.snapshot.holds).toEqual([{ sid: 'same-session', reason: 'server-unconfirmed' }]);
    expect(outcome.snapshot.records[0]).toMatchObject({ phase: 'may-issued', seq: 1 });
  } finally {
    await context.close();
  }
});

it('hold capacity preserves every previous uncertainty and reserves a readable deny-all entry', async () => {
  const context = await browser.newContext();
  try {
    const a = await page(context);
    await a.evaluate(async (scopeId) => {
      const request = indexedDB.open('reverie-input-journal-v2', 1);
      const db = await new Promise<IDBDatabase>((done, reject) => {
        request.onsuccess = () => done(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        const tx = db.transaction('holds', 'readwrite'),
          store = tx.objectStore('holds');
        for (let i = 0; i < 4095; i++) {
          const sid = `previous-unknown-${i}`;
          store.put({
            version: 2,
            key: JSON.stringify([scopeId, sid]),
            scope: scopeId,
            sid,
            reason: 'existing-unconfirmed',
          });
        }
        await new Promise<void>((done, reject) => {
          tx.oncomplete = () => done();
          tx.onabort = () => reject(tx.error);
        });
      } finally {
        db.close();
      }
    }, identity.scopeId);
    await a.evaluate(() => (window as unknown as Scope).reviewJournal.hold('another-unknown'));
    const state = await snapshot(a);
    expect(state.holds).toHaveLength(4096);
    expect(state.holds.filter((row) => row.reason === 'existing-unconfirmed')).toHaveLength(4095);
    expect(state.holds).toContainEqual({ sid: '*', reason: 'hold-capacity' });
    expect(await accept(a, 'must not start another effect')).toEqual({ kind: 'not-queued', reason: 'input-held' });
  } finally {
    await context.close();
  }
});
