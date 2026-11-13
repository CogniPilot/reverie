/** Actual policy change and original HTTP stream; no provider or session starts. */
import { randomBytes } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { SseEvent } from '../src/web/sse-events.js';
import { createIsolatedOffice } from './helpers/isolated-office.js';

it('stops an original anonymous stream from receiving messages after owner enforcement is enabled', async () => {
  const office = await createIsolatedOffice();
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 10_000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const origin = office.origin();
    const password = 'Synthetic-' + randomBytes(18).toString('hex');
    const claim = await fetch(origin + '/api/owner/setup', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'fixture-owner', password, confirmation: password }),
    });
    expect(claim.status).toBe(200);
    const cookie = claim.headers.get('set-cookie')!.split(';')[0];
    const room = await fetch(origin + '/api/chatrooms', {
      method: 'POST',
      headers: { origin, cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Synthetic private room', members: [] }),
    });
    expect(room.status).toBe(200);
    const roomBody = z.object({ data: z.object({ id: z.string() }) }).parse(await room.json());
    const roomId = roomBody.data.id;
    expect(typeof roomId).toBe('string');
    const { OwnerAuthStore } = await import('../src/owner-auth/store.js');
    const { setPolicy } = await import('../src/owner-auth/admin.js');
    const { dataPath } = await import('../src/config/instance.js');
    const store = new OwnerAuthStore(dataPath('owner-auth.json'));
    await setPolicy(store, 'off');
    expect((await fetch(origin + '/api/status')).status).toBe(200);
    const response = await fetch(origin + '/api/events', { signal: abort.signal });
    expect(response.status).toBe(200);
    reader = response.body!.getReader();
    let init = '';
    while (!init.includes('event: init\n')) {
      const part = await reader.read();
      if (part.done) throw new Error('Original public stream closed before its initial state');
      init += new TextDecoder().decode(part.value);
    }
    await setPolicy(store, 'enforce', { forceLockoutRisk: true });
    expect((await fetch(origin + '/api/status')).status).toBe(401);
    const marker = 'SYNTHETIC_AFTER_ENFORCEMENT_' + randomBytes(12).toString('hex');
    const post = await fetch(origin + '/api/chatrooms/' + roomId + '/messages', {
      method: 'POST',
      headers: { origin, cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ text: marker }),
    });
    expect(post.status).toBe(200);
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      expect(new TextDecoder().decode(part.value)).not.toContain(marker);
    }
    await office.assertNoRunningIntent();
  } finally {
    await reader?.cancel().catch(() => {});
    abort.abort();
    clearTimeout(timeout);
    await office.close();
  }
}, 20_000);

it.each(['revoked', 'unreadable'])(
  'closes only the original %s reader before draining queued data',
  async (failure) => {
    const { SseStreamManager } = await import('../src/web/sse-stream-manager.js');
    const { CleanupManager } = await import('../src/utils/cleanup-manager.js');
    const cleanup = new CleanupManager();
    const manager = new SseStreamManager({ getSessionStateWithRespawn: () => undefined }, cleanup);
    const raw = Object.assign(new EventEmitter(), { write: vi.fn(() => false), end: vi.fn() });
    const original = { raw } as unknown as FastifyReply;
    const binding = { kind: 'owner' as const, cookieDigest: 'synthetic-original-owner' };
    let current = true;
    try {
      manager.addBoundClient(original, null, false, 'original', binding, 'original-connection', {
        current: () => {
          if (!current && failure === 'unreadable') throw new Error('SYNTHETIC_PRIVATE_POLICY_FAILURE');
          return current;
        },
      });
      manager.broadcast('fixture:before', { observedBeforeRevocation: true });
      expect(raw.write).toHaveBeenCalledTimes(1);
      manager.broadcast(SseEvent.StatePublicationHeld, { version: 1, kind: 'unconfirmed' });
      expect(raw.write).toHaveBeenCalledTimes(1);
      current = false;
      raw.emit('drain');
      expect(raw.end).toHaveBeenCalledTimes(1);
      expect(manager.clientCount).toBe(0);
      expect(manager.updateClientFilter('original', null, binding, 'original-connection')).toBe(false);
      manager.sendSSE(original, 'fixture:stale-callback', { mustNotBeWritten: true });
      manager.sendPadding(original);
      raw.emit('drain');
      expect(raw.write).toHaveBeenCalledTimes(1);
      const successorRaw = Object.assign(new EventEmitter(), { write: vi.fn(() => true), end: vi.fn() });
      const successor = { raw: successorRaw } as unknown as FastifyReply;
      manager.addBoundClient(successor, null, false, 'original', binding, 'successor-connection', {
        current: () => true,
      });
      manager.sendSSE(original, 'fixture:stale-original', {});
      manager.broadcast('fixture:current', { originalReaderWasNotAdopted: true });
      expect(successorRaw.write).toHaveBeenCalledOnce();
      expect(successorRaw.end).not.toHaveBeenCalled();
      expect(manager.clientCount).toBe(1);
    } finally {
      manager.stop();
      cleanup.dispose();
    }
  }
);
