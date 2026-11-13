/** Real owner-authenticated status and SSE from an isolated empty office; no workers. */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as asyncFs from 'node:fs/promises';
import { beforeEach, expect, it, vi } from 'vitest';
import { createIsolatedOffice } from './helpers/isolated-office.js';

const subscriptions = vi.hoisted(() => ({ stops: [] as Array<ReturnType<typeof vi.fn>> }));
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

beforeEach(async () => {
  const sync = await vi.importActual<typeof import('node:fs')>('node:fs');
  const asynchronous = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(fs.renameSync).mockReset().mockImplementation(sync.renameSync);
  vi.mocked(asyncFs.rename).mockReset().mockImplementation(asynchronous.rename);
});

it('projects an actual publication hold immediately through authenticated status, SSE, and reconnect init', async () => {
  let pause: { entered(): void; wait: Promise<void> } | undefined;
  const office = await createIsolatedOffice({
    beforeStart: (server) => {
      const store = server['store'];
      const subscribe = store.onStatePublicationHold.bind(store);
      vi.spyOn(store, 'onStatePublicationHold').mockImplementation((listener) => {
        const stop = vi.fn(subscribe(listener));
        subscriptions.stops.push(stop);
        return stop;
      });
      server['app'].addHook('preHandler', async (req) => {
        if (req.method === 'POST' && req.routeOptions.url === '/api/events/subscribe' && pause) {
          const original = pause;
          pause = undefined;
          original.entered();
          await original.wait;
        }
      });
    },
  });
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 10_000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const original = (await vi.importActual<typeof import('node:fs')>('node:fs')).renameSync;
  try {
    const origin = office.origin();
    expect((await fetch(origin + '/api/status')).status).toBe(401);
    const password = 'Synthetic-' + randomBytes(18).toString('hex');
    const claim = await fetch(origin + '/api/owner/setup', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'fixture-owner', password, confirmation: password }),
    });
    expect(claim.status).toBe(200);
    const cookie = claim.headers.get('set-cookie')!.split(';')[0];
    const status = async () => {
      const response = await fetch(origin + '/api/status', { headers: { cookie } });
      expect(response.status).toBe(200);
      const body = await response.json();
      return body.data ?? body;
    };
    const before = await status();
    const streamKey = randomBytes(18).toString('hex');
    const stream = await fetch(origin + '/api/events?clientId=' + streamKey, {
      headers: { cookie, accept: 'text/event-stream' },
      signal: controller.signal,
    });
    expect(stream.status).toBe(200);
    reader = stream.body!.getReader();
    let buffer = '';
    const frames: Array<{ event: string; data: unknown }> = [];
    const next = async (event: string): Promise<unknown> => {
      for (;;) {
        const index = frames.findIndex((frame) => frame.event === event);
        if (index !== -1) return frames.splice(index, 1)[0].data;
        const part = await reader!.read();
        if (part.done) throw new Error('Original event stream closed before expected frame');
        buffer += new TextDecoder().decode(part.value);
        let end: number;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const name = /^event: (.+)$/m.exec(frame)?.[1],
            data = /^data: (.+)$/m.exec(frame)?.[1];
          if (name && data) frames.push({ event: name, data: JSON.parse(data) });
        }
      }
    };
    const init = await next('init');
    const subscribe = (token: string | undefined, key = streamKey, streamNonce?: string) =>
      fetch(origin + '/api/events/subscribe', {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json', ...(token ? { cookie: token } : {}) },
        signal: controller.signal,
        body: JSON.stringify({ clientId: key, sessions: null, ...(streamNonce ? { streamNonce } : {}) }),
      });
    const login = await fetch(origin + '/api/owner/login', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'fixture-owner', password }),
    });
    expect(login.status).toBe(200);
    const otherCookie = login.headers.get('set-cookie')!.split(';')[0];
    expect(otherCookie).not.toBe(cookie);
    expect((await subscribe(otherCookie)).status).toBe(404);
    expect((await subscribe(otherCookie, 'missing-selector')).status).toBe(404);
    expect((await subscribe(undefined)).status).toBe(401);
    expect((await subscribe(cookie)).status).toBe(204);
    const conflictController = new AbortController();
    const conflict = await fetch(origin + '/api/events?clientId=' + streamKey, {
      headers: { cookie: otherCookie, accept: 'text/event-stream' },
      signal: conflictController.signal,
    });
    expect(conflict.status).toBe(200);
    expect((await subscribe(otherCookie)).status).toBe(404);
    await conflict.body!.cancel();
    conflictController.abort();
    expect((await subscribe(cookie)).status).toBe(204); // Foreign close cannot remove the original selector.
    const mixed = await fetch(origin + '/api/events/subscribe', {
      method: 'POST',
      headers: { origin, cookie, 'content-type': 'application/json', 'x-reverie-parent-session': '' },
      body: JSON.stringify({ clientId: streamKey, sessions: null }),
    });
    expect(mixed.ok).toBe(false);

    // Pause the REAL handler after current auth+body parse, then register a successor.
    const nonceKey = randomBytes(18).toString('hex'),
      oldNonce = randomBytes(18).toString('hex'),
      newNonce = randomBytes(18).toString('hex');
    const oldStream = await fetch(origin + '/api/events?clientId=' + nonceKey + '&streamNonce=' + oldNonce, {
      headers: { cookie },
      signal: controller.signal,
    });
    const oldReader = oldStream.body!.getReader();
    let release = () => {};
    const entered = new Promise<void>((resolve) => {
      pause = {
        entered: resolve,
        wait: new Promise<void>((done) => {
          release = done;
        }),
      };
    });
    const delayed = subscribe(cookie, nonceKey, oldNonce);
    let newer: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      await entered;
      const successor = await fetch(
        origin + '/api/events?clientId=' + nonceKey + '&streamNonce=' + newNonce + '&sessions=successor-session',
        { headers: { cookie }, signal: controller.signal }
      );
      newer = successor.body!.getReader();
      let pending = '';
      const terminalIds: string[] = [];
      const untilFrame = async (event: string) => {
        for (;;) {
          let end: number;
          while ((end = pending.indexOf('\n\n')) !== -1) {
            const frame = pending.slice(0, end);
            pending = pending.slice(end + 2);
            const name = /^event: (.+)$/m.exec(frame)?.[1],
              raw = /^data: (.+)$/m.exec(frame)?.[1];
            if (name === 'session:terminal' && raw) terminalIds.push(JSON.parse(raw).id);
            if (name === event) return;
          }
          const chunk = await newer!.read();
          if (chunk.done) throw new Error('Original successor stream closed before its frame');
          pending += new TextDecoder().decode(chunk.value);
        }
      };
      await untilFrame('init');
      // Authorized supersession must close the actual original HTTP stream,
      // rather than leaving an untracked OPEN response behind.
      while (!(await oldReader.read()).done) {
        /* Drain only the original stream's already-issued frames to EOF. */
      }
      release();
      expect((await delayed).status).toBe(404);
      expect((await subscribe(cookie, nonceKey)).status).toBe(404); // Legacy omission cannot mutate a nonce-bearing successor.
      expect((await subscribe(cookie, nonceKey, oldNonce)).status).toBe(404);
      const transport = office.currentServer()['sse'];
      transport.batchTerminalData('wrong-session', 'synthetic excluded frame');
      transport['flushSessionTerminalBatch']('wrong-session');
      transport.batchTerminalData('successor-session', 'synthetic current frame');
      transport['flushSessionTerminalBatch']('successor-session');
      await untilFrame('session:terminal');
      expect(terminalIds).toEqual(['successor-session']);
      expect((await subscribe(cookie, nonceKey, newNonce)).status).toBe(204);
    } finally {
      release();
      await delayed.catch(() => {});
      await oldReader.cancel().catch(() => {});
      await newer?.cancel().catch(() => {});
    }

    const { getStore } = await import('../src/state-store.js');
    const store = getStore();
    const privateMarker = 'PRIVATE_STATE_EVIDENCE_' + randomBytes(8).toString('hex');
    store.setConfig({ stateFilePath: privateMarker });
    vi.mocked(fs.renameSync).mockImplementationOnce((from, to) => {
      original(from, to);
      throw new Error(privateMarker);
    });
    await expect(store.commitCronWatch(() => {})).rejects.toMatchObject({ code: 'STATE_PUBLICATION_UNCONFIRMED' });
    const held = { version: 1, kind: 'unconfirmed' };
    const after = await status();
    expect(after.statePublication).toEqual(held);
    expect(before.statePublication).toEqual({ version: 1, kind: 'no-hold-observed' });
    expect(init).toMatchObject({ statePublication: { version: 1, kind: 'no-hold-observed' } });
    const event = await next('state:publicationHeld');
    expect(event).toEqual(held);
    expect(JSON.stringify({ after, event })).not.toContain(privateMarker);
    expect(JSON.stringify({ after, event })).not.toContain(office.workspace);
    await office.assertNoRunningIntent();
    await reader.cancel();
    reader = undefined;
    const reconnect = await fetch(origin + '/api/events', { headers: { cookie }, signal: controller.signal });
    reader = reconnect.body!.getReader();
    buffer = '';
    frames.length = 0;
    expect(await next('init')).toMatchObject({ statePublication: held });
    expect((await fetch(origin + '/api/status')).status).toBe(401);
    await reader.cancel();
    reader = undefined;
    const logout = await fetch(origin + '/api/owner/logout', { method: 'POST', headers: { origin, cookie } });
    expect(logout.status).toBe(200);
    expect((await subscribe(cookie)).status).toBe(401);
    const freshKey = randomBytes(18).toString('hex');
    const fresh = await fetch(origin + '/api/events?clientId=' + freshKey, {
      headers: { cookie: otherCookie, accept: 'text/event-stream' },
      signal: controller.signal,
    });
    reader = fresh.body!.getReader();
    buffer = '';
    frames.length = 0;
    expect(await next('init')).toMatchObject({ statePublication: held });
    expect((await subscribe(otherCookie, freshKey)).status).toBe(204);
    expect((await subscribe(cookie, freshKey)).status).toBe(401);
  } finally {
    vi.mocked(fs.renameSync).mockImplementation(original);
    await reader?.cancel().catch(() => {});
    controller.abort();
    clearTimeout(deadline);
    await office.close();
  }
  expect(subscriptions.stops.length).toBeGreaterThan(0);
  expect(subscriptions.stops.every((stop) => stop.mock.calls.length === 1)).toBe(true);
}, 30_000);

/** Actual Config API: owner auth, canonical StateStore and physical filesystem; no workers. */
async function configOffice(onConfigRequest?: () => void) {
  vi.resetModules();
  const office = await createIsolatedOffice({
    beforeStart: (server) => {
      server['app'].addHook('preHandler', async (request) => {
        if (request.method === 'PUT' && request.routeOptions.url === '/api/config') onConfigRequest?.();
      });
    },
  });
  const origin = office.origin(),
    password = 'Synthetic-' + randomBytes(18).toString('hex');
  const claim = await fetch(origin + '/api/owner/setup', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'fixture-owner', password, confirmation: password }),
  });
  expect(claim.status).toBe(200);
  const cookie = claim.headers.get('set-cookie')!.split(';')[0];
  const { getStore } = await import('../src/state-store.js');
  const store = getStore();
  await store.saveNowAsync();
  const put = (patch: unknown) =>
    fetch(origin + '/api/config', {
      method: 'PUT',
      headers: { origin, cookie, 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
  const disk = () => JSON.parse(fs.readFileSync(store['filePath'], 'utf8')).config;
  const get = () => fetch(origin + '/api/config', { headers: { cookie } });
  return { office, origin, cookie, store, put, disk, get };
}

it('refuses Config before memory mutation when the original state writer is already held', async () => {
  const x = await configOffice();
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  try {
    const before = structuredClone(x.store.getConfig());
    vi.mocked(fs.renameSync).mockImplementationOnce((from, to) => {
      actual.renameSync(from, to);
      throw Error('Synthetic actual main-state rename answer lost');
    });
    await expect(x.store.commitCronWatch(() => {})).rejects.toMatchObject({ code: 'STATE_PUBLICATION_UNCONFIRMED' });
    const renames = vi.mocked(fs.renameSync).mock.calls.length;
    const response = await x.put({ maxConcurrentSessions: before.maxConcurrentSessions + 1 });
    const body = await response.json();
    expect(response.status).toBe(503);
    expect(body.success).toBe(false);
    expect((await x.get()).status).toBe(503);
    const denied = await fetch(x.origin + '/api/config', {
      method: 'PUT',
      headers: { origin: x.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ maxConcurrentSessions: before.maxConcurrentSessions + 2 }),
    });
    expect(denied.status).toBe(401);
    const diagnostic = await fetch(x.origin + '/api/status', { headers: { cookie: x.cookie } });
    expect(diagnostic.status).toBe(200);
    expect((await diagnostic.json()).data.statePublication).toEqual({ version: 1, kind: 'unconfirmed' });
    expect(x.store.getConfig()).toEqual(before);
    expect(x.disk()).toEqual(before);
    expect(vi.mocked(fs.renameSync).mock.calls).toHaveLength(renames);
    await x.office.assertNoRunningIntent();
  } finally {
    vi.mocked(fs.renameSync).mockImplementation(actual.renameSync);
    await x.office.close();
  }
}, 20_000);

it('returns an unconfirmed Config failure for the first actual committed write with a lost acknowledgement', async () => {
  const x = await configOffice();
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const realAsync = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const marker = 'PRIVATE_CONFIG_IO_EVIDENCE_' + randomBytes(12).toString('hex');
  let lost = false;
  const lose = () => {
    if (!lost) {
      lost = true;
      throw Error(marker);
    }
  };
  try {
    const before = structuredClone(x.store.getConfig()),
      requested = before.maxConcurrentSessions + 1;
    vi.mocked(fs.renameSync).mockImplementationOnce((from, to) => {
      actual.renameSync(from, to);
      lose();
    });
    vi.mocked(asyncFs.rename).mockImplementationOnce(async (from, to) => {
      await realAsync.rename(from, to);
      lose();
    });
    const response = await x.put({ maxConcurrentSessions: requested });
    // Join the actual legacy debounced owner too, so the RED demonstrates its
    // real late fault rather than merely racing the 500ms debounce timer.
    await x.store.saveNowAsync().catch(() => {});
    expect(lost).toBe(true);
    expect(x.store.statePublicationHeld).toBe(true);
    expect(x.disk().maxConcurrentSessions).toBe(requested);
    const body = await response.json();
    expect(response.status).toBe(503);
    expect(body.success).toBe(false);
    expect(JSON.stringify(body)).not.toContain(marker);
    expect((await x.get()).status).toBe(503);
    const count = vi.mocked(fs.renameSync).mock.calls.length + vi.mocked(asyncFs.rename).mock.calls.length;
    expect((await x.put({ maxConcurrentSessions: requested + 1 })).status).toBe(503);
    expect(vi.mocked(fs.renameSync).mock.calls.length + vi.mocked(asyncFs.rename).mock.calls.length).toBe(count);
    await x.office.assertNoRunningIntent();
  } finally {
    vi.mocked(fs.renameSync).mockImplementation(actual.renameSync);
    vi.mocked(asyncFs.rename).mockImplementation(realAsync.rename);
    await x.office.close();
  }
}, 20_000);

it('acknowledges Config only with the actual durable file and preserves unrelated configuration', async () => {
  const x = await configOffice();
  try {
    const before = structuredClone(x.store.getConfig());
    const response = await x.put({ maxConcurrentSessions: before.maxConcurrentSessions + 1 });
    expect(response.status).toBe(200);
    const body = await response.json(),
      saved = body.data?.config ?? body.config;
    expect(saved).toEqual({ ...before, maxConcurrentSessions: before.maxConcurrentSessions + 1 });
    expect(fs.existsSync(x.store['filePath'])).toBe(true);
    expect(x.disk()).toEqual(saved);
    const partial = await x.put({ respawn: { enabled: !before.respawn.enabled } });
    expect(partial.status).toBe(200);
    const partialBody = await partial.json(),
      merged = partialBody.data?.config ?? partialBody.config;
    expect(merged).toEqual({ ...saved, respawn: { ...before.respawn, enabled: !before.respawn.enabled } });
    expect(x.disk()).toEqual(merged);
    expect(x.store.statePublicationHeld).toBe(false);
    await x.office.assertNoRunningIntent();
  } finally {
    await x.office.close();
  }
}, 20_000);

it('refuses a queued Config mutation when its original preceding writer becomes held', async () => {
  let received!: () => void;
  const requestReceived = new Promise<void>((resolve) => {
    received = resolve;
  });
  const x = await configOffice(received);
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
      enter = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  const before = structuredClone(x.store.getConfig());
  x.store.setConfig({ pollIntervalMs: before.pollIntervalMs + 1 });
  vi.mocked(asyncFs.rename).mockImplementationOnce(async (from, to) => {
    enter();
    await gate;
    await actual.rename(from, to);
    throw Error('Synthetic preceding writer acknowledgement lost');
  });
  const preceding = x.store.saveNowAsync();
  try {
    await entered;
    const originalFlight = x.store['_saveInFlight'];
    const queued = x.put({ maxConcurrentSessions: before.maxConcurrentSessions + 1 });
    await requestReceived;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(x.store['_saveInFlight']).not.toBe(originalFlight);
    release();
    await expect(preceding).rejects.toMatchObject({ code: 'STATE_PUBLICATION_UNCONFIRMED' });
    expect((await queued).status).toBe(503);
    expect(x.store.getConfig().maxConcurrentSessions).toBe(before.maxConcurrentSessions);
    expect(x.disk().maxConcurrentSessions).toBe(before.maxConcurrentSessions);
    await x.office.assertNoRunningIntent();
  } finally {
    release();
    await preceding.catch(() => {});
    vi.mocked(asyncFs.rename).mockImplementation(actual.rename);
    await x.office.close();
  }
}, 20_000);
