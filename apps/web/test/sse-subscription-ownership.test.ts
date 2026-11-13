/** Trusted live-stream binding component controls; no session/native authority. */
import type { FastifyReply } from 'fastify';
import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { SseEvent } from '../src/web/sse-events.js';
import { CleanupManager } from '../src/utils/index.js';
import type { AuthSessionRecord } from '../src/web/ports/auth-port.js';
import { SseStreamManager, type SseSubscriptionBinding } from '../src/web/sse-stream-manager.js';
function client() {
  const frames: string[] = [];
  return {
    frames,
    reply: {
      raw: {
        write: (data: string) => {
          frames.push(data);
          return true;
        },
        end: vi.fn(),
      },
    } as unknown as FastifyReply,
  };
}
function record(username: string): AuthSessionRecord {
  return { ip: '127.0.0.1', ua: 'synthetic', createdAt: 1, method: 'basic', username };
}
it('requires the original private auth record and frozen identity for filter mutation', () => {
  const cleanup = new CleanupManager(),
    manager = new SseStreamManager({ getSessionStateWithRespawn: () => null }, cleanup);
  const target = client(),
    original = record('alice');
  const user = { username: 'alice', role: 'user' as const };
  const binding: SseSubscriptionBinding = { kind: 'browser', record: original, identity: user };
  try {
    manager.addBoundClient(target.reply, new Set(['original-filter']), false, 'original-stream-key', binding);
    const before = manager['sseClients'].get(target.reply);
    for (const denied of [
      { kind: 'unverified' } as const,
      { kind: 'browser', record: record('alice'), identity: user } as const,
      { kind: 'browser', record: original, identity: { username: 'bob', role: 'user' } } as const,
      { kind: 'browser', record: original, identity: { username: 'alice', role: 'admin' } } as const,
    ]) {
      expect(manager.updateClientFilter('original-stream-key', ['changed-filter'], denied)).toBe(false);
      expect(manager['sseClients'].get(target.reply)).toBe(before);
    }
    user.username = 'bob'; // A later mutation cannot rewrite the registered stream's original identity.
    expect(manager.updateClientFilter('original-stream-key', null, binding)).toBe(false);
    expect(
      manager.updateClientFilter('original-stream-key', null, {
        kind: 'browser',
        record: original,
        identity: { username: 'alice', role: 'user' },
      })
    ).toBe(true);
    expect(manager['sseClients'].get(target.reply)).toBeNull();
    expect(manager.updateClientFilter('missing-stream-key', null, binding)).toBe(false);
  } finally {
    manager.stop();
    cleanup.dispose();
  }
});
it('a conflicting foreign GET key and its cleanup never evict or retarget the original stream', () => {
  const cleanup = new CleanupManager(),
    manager = new SseStreamManager({ getSessionStateWithRespawn: () => null }, cleanup);
  const alice = client(),
    bob = client();
  const first: SseSubscriptionBinding = {
    kind: 'browser',
    record: record('alice'),
    identity: { username: 'alice', role: 'user' },
  };
  const other: SseSubscriptionBinding = {
    kind: 'browser',
    record: record('bob'),
    identity: { username: 'bob', role: 'user' },
  };
  try {
    manager.addBoundClient(alice.reply, new Set(['original-filter']), false, 'shared-guessed-key', first);
    manager.addBoundClient(bob.reply, null, false, 'shared-guessed-key', other);
    expect(alice.reply.raw.end).not.toHaveBeenCalled();
    expect(manager.updateClientFilter('shared-guessed-key', null, other)).toBe(false);
    expect(manager['sseClients'].get(alice.reply)).toEqual(new Set(['original-filter']));
    manager.broadcast('owned-test-frame', {}, { owner: 'alice', sessionScoped: true });
    expect(alice.frames).toHaveLength(1);
    expect(bob.frames).toEqual([]);
    manager.removeClient(bob.reply);
    expect(manager.updateClientFilter('shared-guessed-key', null, first)).toBe(true);
    expect(manager['sseClients'].has(alice.reply)).toBe(true);
    manager.removeClient(alice.reply);
    manager.addBoundClient(bob.reply, null, false, 'shared-guessed-key', other);
    expect(manager.updateClientFilter('shared-guessed-key', [], other)).toBe(true);
  } finally {
    manager.stop();
    cleanup.dispose();
  }
});
it('ends only an authorized superseded reply and rejects every predecessor nonce', () => {
  const cleanup = new CleanupManager(),
    manager = new SseStreamManager({ getSessionStateWithRespawn: () => null }, cleanup);
  const original = client(),
    successor = client();
  const binding: SseSubscriptionBinding = {
    kind: 'browser',
    record: record('alice'),
    identity: { username: 'alice', role: 'user' },
  };
  try {
    manager.addBoundClient(original.reply, null, false, 'same-owner-stream', binding, 'original-nonce');
    manager.addBoundClient(
      successor.reply,
      new Set(['successor-filter']),
      false,
      'same-owner-stream',
      binding,
      'successor-nonce'
    );
    expect(original.reply.raw.end).toHaveBeenCalledExactlyOnceWith();
    expect(successor.reply.raw.end).not.toHaveBeenCalled();
    expect(manager.clientCount).toBe(1);
    for (const nonce of [undefined, 'original-nonce', 'foreign-nonce']) {
      expect(manager.updateClientFilter('same-owner-stream', null, binding, nonce)).toBe(false);
      expect(manager['sseClients'].get(successor.reply)).toEqual(new Set(['successor-filter']));
    }
    manager.removeClient(original.reply); // Delayed original cleanup cannot erase its successor mapping.
    expect(manager.updateClientFilter('same-owner-stream', null, binding, 'successor-nonce')).toBe(true);
  } finally {
    manager.stop();
    cleanup.dispose();
  }
});
it('legacy read-only client fixtures confer no filter mutation authority', () => {
  const cleanup = new CleanupManager(),
    manager = new SseStreamManager({ getSessionStateWithRespawn: () => null }, cleanup);
  const target = client();
  try {
    manager.addClient(target.reply, null, false, 'legacy-read-key', { username: 'alice', role: 'user' });
    expect(manager.updateClientFilter('legacy-read-key', ['changed'], { kind: 'unverified' })).toBe(false);
    expect(
      manager.updateClientFilter('legacy-read-key', ['changed'], { kind: 'owner', cookieDigest: 'a'.repeat(64) })
    ).toBe(false);
    expect(manager['sseClients'].get(target.reply)).toBeNull();
  } finally {
    manager.stop();
    cleanup.dispose();
  }
});

it('permits only explicitly acknowledged public view filters and revokes them when owner policy activates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sse-public-'));
  vi.stubEnv('REVERIE_MULTIUSER', '0');
  vi.stubEnv('REVERIE_PASSWORD', '');
  vi.stubEnv('REVERIE_OWNER_SETUP', '0');
  vi.stubEnv('REVERIE_DATA_DIR', root);
  const { WebServer } = await import('../src/web/server.js');
  const { OwnerAuthStore } = await import('../src/owner-auth/store.js');
  try {
    for (const [mode, flag, env, expected] of [
      ['unacknowledged', false, '', 404],
      ['captured-cli', true, '', 204],
      ['captured-env', false, '1', 204],
    ] as const) {
      vi.stubEnv('REVERIE_ALLOW_UNAUTHENTICATED_NETWORK', env);
      const server = new WebServer(0, false, true, '127.0.0.1', 'synthetic-public-filter', flag);
      vi.stubEnv('REVERIE_ALLOW_UNAUTHENTICATED_NETWORK', ''); // Constructor captures the operator's setting.
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), 5_000);
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        await server.start();
        const origin = 'http://127.0.0.1:' + server.boundPort;
        const stream = await fetch(origin + '/api/events?clientId=' + mode + '-stream', { signal: deadline.signal });
        expect(stream.status).toBe(200);
        reader = stream.body!.getReader();
        let initial = '';
        while (!initial.includes('event: init')) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error('Original public stream ended before init');
          initial += new TextDecoder().decode(chunk.value);
        }
        const subscribe = () =>
          fetch(origin + '/api/events/subscribe', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            signal: deadline.signal,
            body: JSON.stringify({ clientId: mode + '-stream', sessions: ['tile-grid'] }),
          });
        expect((await subscribe()).status).toBe(expected);
        if (mode === 'captured-env') {
          // The actual canonical policy marker is read again before mutation; no synthetic caller proof.
          const owner = new OwnerAuthStore(join(root, 'owner-auth.json'));
          const { bootstrap, setPolicy } = await import('../src/owner-auth/admin.js');
          await bootstrap(owner, 'synthetic-public-owner');
          await setPolicy(owner, 'off');
          expect((await subscribe()).status).toBe(204); // Deliberately configured off remains the operator's choice.
          await setPolicy(owner, 'log');
          expect((await subscribe()).status).toBe(404);
          await setPolicy(owner, 'enforce', { forceLockoutRisk: true });
          expect((await subscribe()).ok).toBe(false);
        }
      } finally {
        await reader?.cancel().catch(() => {});
        deadline.abort();
        clearTimeout(timer);
        await server.stop();
      }
    }
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it('a public transport scope cannot mutate an authenticated stream or another registration scope', () => {
  const cleanup = new CleanupManager(),
    manager = new SseStreamManager({ getSessionStateWithRespawn: () => null }, cleanup);
  const target = client(),
    authenticated = client(),
    scope = Object.freeze({});
  try {
    manager.addBoundClient(target.reply, new Set(['original-filter']), false, 'public-original', {
      kind: 'public',
      scope,
    });
    manager.addBoundClient(authenticated.reply, null, false, 'authenticated-original', {
      kind: 'owner',
      cookieDigest: 'a'.repeat(64),
    });
    expect(manager.updateClientFilter('public-original', null, { kind: 'public', scope: Object.freeze({}) })).toBe(
      false
    );
    expect(manager.updateClientFilter('authenticated-original', ['changed'], { kind: 'public', scope })).toBe(false);
    expect(manager.updateClientFilter('public-original', null, { kind: 'unverified' })).toBe(false);
    expect(manager['sseClients'].get(target.reply)).toEqual(new Set(['original-filter']));
    expect(manager['sseClients'].get(authenticated.reply)).toBeNull();
    expect(manager.updateClientFilter('public-original', null, { kind: 'public', scope })).toBe(true);
  } finally {
    manager.stop();
    cleanup.dispose();
  }
});

it('retains one unwritten warning through repeated and renewed backpressure, without replaying accepted bytes', () => {
  const cleanup = new CleanupManager(),
    manager = new SseStreamManager({ getSessionStateWithRespawn: () => null }, cleanup);
  const frames: string[] = [],
    decisions = [false, false, true, false, true];
  const raw = Object.assign(new EventEmitter(), {
    write(data: string) {
      frames.push(data);
      return decisions.shift() ?? true;
    },
    end() {},
  });
  const reply = { raw } as unknown as FastifyReply;
  try {
    manager.addClient(reply, null, true);
    manager.setTunnelActive(true);
    manager.broadcast('synthetic-pressure', {});
    for (let n = 0; n < 10; n++) manager.broadcast(SseEvent.StatePublicationHeld, { version: 1, kind: 'unconfirmed' });
    expect(frames).toHaveLength(1);
    expect(manager['pendingPublicationWarningFrames'].size).toBe(1);
    raw.emit('drain'); // Refresh write(false) was accepted; warning is still unwritten.
    expect(frames.filter((frame) => frame.includes('event: ' + SseEvent.StatePublicationHeld))).toEqual([]);
    expect(manager['pendingPublicationWarningFrames'].size).toBe(1);
    raw.emit('drain'); // Refresh accepts, then warning write(false) accepts the warning exactly once.
    const notices = frames.filter((frame) => frame.includes('event: ' + SseEvent.StatePublicationHeld));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('data: {"version":1,"kind":"unconfirmed"}');
    expect(notices[0].length).toBeGreaterThan(1000); // Existing latency-sensitive tunnel flush padding.
    expect(manager['pendingPublicationWarningFrames'].size).toBe(0);
    raw.emit('drain');
    expect(frames.filter((frame) => frame.includes('event: ' + SseEvent.StatePublicationHeld))).toHaveLength(1);
  } finally {
    manager.stop();
    cleanup.dispose();
  }
});
it('keeps independent main and mux warning slots through renewed original transport backpressure', () => {
  const cleanup = new CleanupManager(),
    manager = new SseStreamManager({ getSessionStateWithRespawn: () => null }, cleanup);
  const frames: string[] = [],
    decisions = [false, true, false, true, true];
  const raw = Object.assign(new EventEmitter(), {
    write(data: string) {
      frames.push(data);
      return decisions.shift() ?? true;
    },
    end() {},
  });
  const reply = { raw } as unknown as FastifyReply;
  try {
    manager.addClient(reply, null, true);
    manager.broadcast('synthetic-pressure', {});
    const repaired = {
      version: 1,
      writerId: '10000000-0000-4000-8000-000000000001',
      kind: 'reconciled',
      repairedIncidentId: '10000000-0000-4000-8000-000000000002',
      repairedThrough: '1',
    };
    for (let i = 0; i < 20; i++) {
      manager.broadcast(SseEvent.StatePublicationHeld, { version: 1, kind: 'unconfirmed' });
      manager.broadcast(SseEvent.MuxMetadataPublication, repaired);
    }
    expect(manager['pendingPublicationWarningFrames'].get(reply)?.size).toBe(2);
    raw.emit('drain');
    expect(frames.filter((frame) => frame.includes('event: ' + SseEvent.StatePublicationHeld))).toHaveLength(1);
    expect(frames.filter((frame) => frame.includes('event: ' + SseEvent.MuxMetadataPublication))).toHaveLength(0);
    expect(manager['pendingPublicationWarningFrames'].get(reply)?.size).toBe(1);
    raw.emit('drain');
    expect(frames.filter((frame) => frame.includes('event: ' + SseEvent.StatePublicationHeld))).toHaveLength(1);
    expect(frames.filter((frame) => frame.includes('event: ' + SseEvent.MuxMetadataPublication))).toEqual([
      `event: ${SseEvent.MuxMetadataPublication}\ndata: ${JSON.stringify(repaired)}\n\n`,
    ]);
    expect(manager['pendingPublicationWarningFrames'].size).toBe(0);
    manager.stop();
    raw.emit('drain');
    expect(frames.filter((frame) => frame.includes('event: ' + SseEvent.MuxMetadataPublication))).toHaveLength(1);
  } finally {
    manager.stop();
    cleanup.dispose();
  }
});

it('removes pending warning custody on close/stop and never forwards it to a conflicting or replacement selector', () => {
  const cleanup = new CleanupManager(),
    manager = new SseStreamManager({ getSessionStateWithRespawn: () => null }, cleanup);
  const transport = () => {
    const frames: string[] = [];
    let first = true;
    const raw = Object.assign(new EventEmitter(), {
      write(data: string) {
        frames.push(data);
        const accepted = !first;
        first = false;
        return accepted;
      },
      end() {},
    });
    return { frames, raw, reply: { raw } as unknown as FastifyReply };
  };
  const original = transport(),
    foreign = transport(),
    replacement = transport();
  const owner: SseSubscriptionBinding = { kind: 'owner', cookieDigest: 'a'.repeat(64) };
  try {
    manager.addBoundClient(original.reply, null, false, 'original-pressure-key', owner);
    manager.broadcast('synthetic-pressure', {});
    manager.broadcast(SseEvent.StatePublicationHeld, { version: 1, kind: 'unconfirmed' });
    expect(manager['pendingPublicationWarningFrames'].size).toBe(1);
    manager.addBoundClient(foreign.reply, null, false, 'original-pressure-key', {
      kind: 'owner',
      cookieDigest: 'b'.repeat(64),
    });
    manager.removeClient(original.reply);
    manager.addBoundClient(replacement.reply, null, false, 'original-pressure-key', owner);
    expect(manager['pendingPublicationWarningFrames'].size).toBe(0);
    original.raw.emit('drain');
    expect(foreign.frames).toEqual([]);
    expect(replacement.frames).toEqual([]);
    manager.broadcast('synthetic-pressure', {});
    manager.broadcast(SseEvent.StatePublicationHeld, { version: 1, kind: 'unconfirmed' });
    expect(manager['pendingPublicationWarningFrames'].size).toBe(2);
    manager.stop();
    expect(foreign.frames.at(-1)).toContain('event: server:shutdown');
    expect(replacement.frames.at(-1)).toContain('event: server:shutdown');
    const before = [foreign.frames.length, replacement.frames.length];
    expect(manager['pendingPublicationWarningFrames'].size).toBe(0);
    foreign.raw.emit('drain');
    replacement.raw.emit('drain');
    expect([foreign.frames.length, replacement.frames.length]).toEqual(before);
  } finally {
    manager.stop();
    cleanup.dispose();
  }
});
