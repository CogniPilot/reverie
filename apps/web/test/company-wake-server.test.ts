import { describe, it, expect, vi } from 'vitest';
import { WebServer } from '../src/web/server.js';
import { SseEvent } from '../src/web/sse-events.js';
import type { Session } from '../src/session.js';
import type { StateStore } from '../src/state-store.js';
import type { TabLayoutService } from '../src/tab-layout-service.js';
import type { FastifyInstance } from 'fastify';

type CleanupServer = {
  app: FastifyInstance;
  sessions: Map<string, Session>;
  store: StateStore;
  cleaningUp: Set<string>;
  companyService: {setDesiredRunning: (...args: unknown[]) => Promise<void>};
  tabLayouts: Pick<TabLayoutService, 'markRestorationComplete'> & {withOwner: (owner: string, task: () => Promise<void>) => Promise<void>};
  cleanupSession: (id: string, kill: boolean, reason: string, expected: {session: Session; owner: string | undefined}) => Promise<void>;
  _doCleanupSession: (...args: unknown[]) => Promise<void>;
  broadcast: (event: string, data: unknown) => void;
};

function serverFixture() {
  const markClosing = vi.fn();
  const save = vi.fn(async () => {});
  const stop = vi.fn(async () => {});
  const runtime = { markClosing };
  const server = Object.assign(Object.create(WebServer.prototype), {
    cleaningUp: new Set(),
    killingSessions: new Set(),
    sessions: new Map([['runtime', runtime]]),
    companyService: { setDesiredRunning: save },
    _doCleanupSession: stop,
  });
  return { server, save, stop, markClosing };
}
describe('company recovery server stop boundary', () => {
  it('durably commits intentional stop before any process termination', async () => {
    const f = serverFixture();
    const order: string[] = [];
    f.save.mockImplementation(async () => {
      order.push('saved');
    });
    f.stop.mockImplementation(async () => {
      order.push('terminated');
    });
    await f.server.cleanupSession('runtime', true);
    expect(order).toEqual(['saved', 'terminated']);
    expect(f.save).toHaveBeenCalledWith('runtime', false);
  });
  it('refuses process termination if the stop ledger cannot be committed', async () => {
    const f = serverFixture();
    f.save.mockRejectedValue(new Error('disk full'));
    await expect(f.server.cleanupSession('runtime', true)).rejects.toThrow('disk full');
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.server.cleaningUp.size).toBe(0);
    expect(f.markClosing).toHaveBeenLastCalledWith(false);
  });
  it('normal console shutdown preserves running intent for the next outer-supervisor start', async () => {
    const f = serverFixture();
    await f.server.cleanupSession('runtime', false);
    expect(f.save).not.toHaveBeenCalled();
    expect(f.stop).toHaveBeenCalledWith('runtime', false, undefined);
  });
});

// Actual WebServer cleanup and owner-layout lock; no provider or CLI is started.
describe('candidate cleanup retains its original asynchronous subject', () => {
  it.each(['desired-state', 'layout-lock', 'transport-stop', 'layout-publish'] as const)('rejects a same-SID successor during %s', async (boundary) => {
    const { Session } = await import('../src/session.js');
    const { SINGLE_USER_LAYOUT_OWNER } = await import('../src/tab-layout-persistence.js');
    const server = new WebServer(0, false, true, '127.0.0.1') as unknown as CleanupServer;
    const original = new Session({ id: 'cleanup-original', workingDir: '/synthetic-cleanup', mode: 'claude' });
    const successor = new Session({ id: original.id, workingDir: '/synthetic-successor', mode: 'claude' });
    const oldStop = vi.spyOn(original, 'stop').mockResolvedValue();
    const newStop = vi.spyOn(successor, 'stop').mockResolvedValue();
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    server.sessions.set(original.id, original);
    let lock: Promise<void> | undefined;
    if (boundary === 'desired-state') {
      server.companyService = { setDesiredRunning: vi.fn(async () => { entered(); await held; }) };
    } else if (boundary === 'layout-lock') {
      server.companyService = { setDesiredRunning: vi.fn(async () => {}) };
      server.tabLayouts.markRestorationComplete();
      lock = server.tabLayouts.withOwner(SINGLE_USER_LAYOUT_OWNER, async () => { entered(); await held; });
      await waiting;
    } else {
      server.companyService = {setDesiredRunning: vi.fn(async () => {})};
      if (boundary === 'transport-stop') oldStop.mockImplementation(async () => {entered(); await held;});
      else {
        server.tabLayouts.markRestorationComplete();
        const cleanup = server._doCleanupSession.bind(server);
        vi.spyOn(server, '_doCleanupSession').mockImplementation(async (...args: unknown[]) => {
          const result = await cleanup(...args);
          if (args[3] === false) server.sessions.set(original.id, successor);
          return result;
        });
      }
    }
    const layoutWrite = vi.spyOn(server.store, 'commitTabLayoutProjection');
    const deletion = vi.spyOn(server, 'broadcast');
    try {
      const cleaning = server.cleanupSession(original.id, true, 'spawn_failed', { session: original, owner: original.owner });
      if (boundary === 'desired-state' || boundary === 'transport-stop') await waiting;
      else if (boundary === 'layout-lock') await vi.waitFor(() => expect(server.cleaningUp.has(original.id)).toBe(true));
      if (boundary !== 'layout-publish') server.sessions.set(original.id, successor);
      release();
      await lock;
      await expect(cleaning).rejects.toThrow(/cleanup.*required/i);
      expect(server.sessions.get(original.id)).toBe(successor);
      expect(newStop).not.toHaveBeenCalled();
      expect(oldStop).toHaveBeenCalledTimes(boundary === 'transport-stop' || boundary === 'layout-publish' ? 1 : 0);
      expect(layoutWrite).not.toHaveBeenCalled();
      expect(deletion.mock.calls.filter(([event]: [string]) => event === SseEvent.SessionDeleted))
        .toHaveLength(boundary === 'layout-publish' ? 1 : 0);
    } finally {
      release();
      await lock;
      server.sessions.clear();
      await server.app.close();
      vi.restoreAllMocks();
    }
  });

  it.each(['worker', 'worker-empty', 'unregistered-local'] as const)('refuses unproved %s stop authority before changing running intent or observers', async kind => {
    const { Session } = await import('../src/session.js');
    if (kind.startsWith('worker')) vi.stubEnv('REVERIE_WORKER_SOCKET', '/run/synthetic-worker.sock');
    const server = new WebServer(0, false, true, '127.0.0.1') as unknown as CleanupServer;
    const record = {sessionId: 'native-original', muxName: 'reverie-native', pid: 8001, createdAt: 1,
      workingDir: '/synthetic', mode: 'claude', attached: true};
    const mux = {getSession: () => kind === 'worker' ? record : undefined, killSession: vi.fn(), killSessionIfCurrent: vi.fn()};
    const original = new Session({id: record.sessionId, workingDir: record.workingDir, mode: 'claude',
      ...(kind === 'worker-empty' ? {} : {mux: mux as never, useMux: true, muxSession: record as never})});
    const save = vi.fn(); server.companyService = {setDesiredRunning: save};
    server.sessions.set(original.id, original);
    const stop = vi.spyOn(original, 'stop');
    try {
      await expect(server.cleanupSession(original.id, true, 'spawn_failed', {session: original, owner: undefined}))
        .rejects.toThrow(/original provider stop authority is unavailable/);
      expect(save).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled();
      expect(mux.killSession).not.toHaveBeenCalled(); expect(mux.killSessionIfCurrent).not.toHaveBeenCalled();
      expect(server.sessions.get(original.id)).toBe(original);
      expect(server.cleaningUp.size).toBe(0);
    } finally {
      server.sessions.clear(); await server.app.close(); vi.unstubAllEnvs(); vi.restoreAllMocks();
      await original.stop(false);
    }
  });

  it('cleans an unchanged, unstarted local candidate through the actual canonical path', async () => {
    const { Session } = await import('../src/session.js');
    const server = new WebServer(0, false, true, '127.0.0.1') as unknown as CleanupServer;
    const original = new Session({id: 'unstarted-original', workingDir: '/synthetic', mode: 'claude'});
    const save = vi.fn(async () => {}); server.companyService = {setDesiredRunning: save};
    server.sessions.set(original.id, original);
    const stop = vi.spyOn(original, 'stop');
    try {
      await server.cleanupSession(original.id, true, 'spawn_failed', {session: original, owner: undefined});
      expect(save).toHaveBeenCalledOnce(); expect(stop).toHaveBeenCalledOnce();
      expect(server.sessions.has(original.id)).toBe(false);
      expect(server.cleaningUp.size).toBe(0);
    } finally {server.sessions.clear(); await server.app.close(); vi.restoreAllMocks();}
  });
});
