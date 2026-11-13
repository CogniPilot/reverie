/**
 * `WebServer.discardPartiallyBuiltSession()` against the real server object.
 *
 * The reboot-restore route calls this when a rebuild registers a session and
 * then fails to start its pane. It has to be the exact inverse of
 * `registerSessionWithLayout()` plus `setupSessionListeners()`, and it must NOT
 * be the user-initiated delete: banking the session's token totals, demoting a
 * pinned record or deleting the workspace's files would all be wrong for a
 * session that never ran.
 *
 * These tests drive the real method rather than the route, because the route
 * tests run against a mock context whose `discardPartiallyBuiltSession` is a
 * one-line stub — an earlier version of this function left four registrations
 * behind and every route test still passed.
 *
 * The retry assertion is the important one. `setupSessionListeners()` returns
 * early when `sessionListenerRefs` still holds the session id, so a discard that
 * leaves that entry makes the next attempt wire nothing at all, and the user
 * gets a tab that never shows output.
 */
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { safeRmHomeTree } from './mocks/test-helpers.js';

import { WebServer } from '../src/web/server.js';
import { Session } from '../src/session.js';
import { TmuxManager } from '../src/tmux-manager.js';
import { SINGLE_USER_LAYOUT_OWNER, type TabLayoutWebviewRecord } from '../src/tab-layout-persistence.js';
import { StateStore } from '../src/state-store.js';
import { readProcStat } from '../src/signal-target.js';
import * as signalTarget from '../src/signal-target.js';
import * as processExitWait from '../src/utils/process-exit-wait.js';

/** Reach the private collections the discard is responsible for emptying. */
interface ServerInternals {
  sessions: Map<string, Session>;
  tabLayouts: {
    markRestorationComplete(): void;
    withOwner<T>(owner: string, action: () => Promise<T>): Promise<T>;
    deps: { readWebviews(): Promise<readonly TabLayoutWebviewRecord[]> };
  };
  store: Pick<StateStore, 'getTabLayout' | 'commitTabLayoutProjection'>;
  sessionListenerRefs: Map<string, unknown>;
  runSummaryTrackers: Map<string, unknown>;
  registerSessionWithLayout(session: Session): Promise<void>;
  setupSessionListeners(session: Session): Promise<void>;
  discardPartiallyBuiltSession(sessionId: string): Promise<void>;
  cleanupSession(sessionId: string, killMux: boolean): Promise<void>;
  isImageWatcherEnabled(): Promise<boolean>;
}

const WORKSPACE = join(homedir(), '.reverie-test-discard');
const SESSION_ID = 'a1b2c3d4e5f60718';

let server: WebServer;
let internals: ServerInternals;
let mux: TmuxManager;

function buildSession(): Session {
  return new Session({
    id: SESSION_ID,
    workingDir: WORKSPACE,
    mode: 'claude',
    name: 'rebuilt session',
    mux,
    useMux: true,
  });
}

beforeAll(() => {
  mkdirSync(WORKSPACE, { recursive: true });
  // Test mode: no port is opened and no CLI is launched. One server for the file,
  // stopped at the end: the constructor registers handlers on the module-level
  // image, subagent, team and workflow watchers, and only stop() removes them.
  server = new WebServer(0, false, true);
  internals = server as unknown as ServerInternals;
  mux = new TmuxManager();
});

afterEach(async () => {
  await internals.discardPartiallyBuiltSession(SESSION_ID).catch(() => {});
});

afterAll(async () => {
  await server.stop().catch(() => {});
  safeRmHomeTree(WORKSPACE);
});

describe('discarding a session whose pane never started', () => {
  it('takes the session back out of the server', async () => {
    const session = buildSession();
    await internals.registerSessionWithLayout(session);
    await internals.setupSessionListeners(session);
    expect(internals.sessions.has(SESSION_ID)).toBe(true);

    await internals.discardPartiallyBuiltSession(SESSION_ID);
    expect(internals.sessions.has(SESSION_ID)).toBe(false);
  });

  it('releases the listener registration, so a retry can wire itself again', async () => {
    const first = buildSession();
    await internals.registerSessionWithLayout(first);
    await internals.setupSessionListeners(first);
    expect(internals.sessionListenerRefs.has(SESSION_ID)).toBe(true);

    const firstRefs = internals.sessionListenerRefs.get(SESSION_ID);
    await internals.discardPartiallyBuiltSession(SESSION_ID);
    expect(internals.sessionListenerRefs.has(SESSION_ID)).toBe(false);

    // The retry reuses the id by design. `setupSessionListeners()` returns early
    // while the refs are still there, so a session built now would run blind: no
    // terminal output, no status updates, no exit broadcast. Asserting a DIFFERENT
    // refs object is what distinguishes wiring the retry from finding the corpse
    // of the first attempt still in place.
    const retry = buildSession();
    await internals.registerSessionWithLayout(retry);
    await internals.setupSessionListeners(retry);
    const retryRefs = internals.sessionListenerRefs.get(SESSION_ID);
    expect(retryRefs).toBeDefined();
    expect(retryRefs).not.toBe(firstRefs);
  });

  it('stops the run-summary tracker, whose interval would otherwise keep firing', async () => {
    const session = buildSession();
    await internals.registerSessionWithLayout(session);
    await internals.setupSessionListeners(session);
    const tracker = internals.runSummaryTrackers.get(SESSION_ID) as { stop: () => void };
    expect(tracker).toBeDefined();
    // Dropping the map entry is not enough: the tracker arms a setInterval in its
    // constructor, and only stop() clears it, so a discard that merely forgot the
    // entry would leave the timer running for the life of the process.
    const stopped = vi.spyOn(tracker, 'stop');

    await internals.discardPartiallyBuiltSession(SESSION_ID);
    expect(stopped).toHaveBeenCalled();
    expect(internals.runSummaryTrackers.has(SESSION_ID)).toBe(false);
  });

  it('does nothing at all for a session it never registered', async () => {
    await expect(internals.discardPartiallyBuiltSession('never-existed')).resolves.toBeUndefined();
  });

  it('retains a native attempt and its observers when generic cleanup has no original stop authority', async () => {
    vi.stubEnv('REVERIE_WORKER_SOCKET', '/run/synthetic-discard-worker.sock');
    const session = buildSession();
    await internals.registerSessionWithLayout(session);
    await internals.setupSessionListeners(session);
    const refs = internals.sessionListenerRefs.get(SESSION_ID);
    const tracker = internals.runSummaryTrackers.get(SESSION_ID);
    const stop = vi.spyOn(session, 'stop');
    const kill = vi.spyOn(mux, 'killSession');
    try {
      await expect(internals.discardPartiallyBuiltSession(SESSION_ID)).rejects.toThrow(
        /original provider stop authority/
      );
      expect(stop).not.toHaveBeenCalled();
      expect(kill).not.toHaveBeenCalled();
      expect(internals.sessions.get(SESSION_ID)).toBe(session);
      expect(internals.sessionListenerRefs.get(SESSION_ID)).toBe(refs);
      expect(internals.runSummaryTrackers.get(SESSION_ID)).toBe(tracker);
    } finally {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
      await internals.cleanupSession(SESSION_ID, false);
      await session.stop(false);
    }
  });

  it('does not fall back to a SID kill or discard observers after an uncertain original stop', async () => {
    const session = buildSession();
    await internals.registerSessionWithLayout(session);
    await internals.setupSessionListeners(session);
    const refs = internals.sessionListenerRefs.get(SESSION_ID);
    const tracker = internals.runSummaryTrackers.get(SESSION_ID);
    const stop = vi.spyOn(session, 'stop').mockRejectedValueOnce(new Error('Synthetic original stop outcome unknown'));
    const kill = vi.spyOn(mux, 'killSession');
    try {
      await expect(internals.discardPartiallyBuiltSession(SESSION_ID)).rejects.toThrow(/stop outcome unknown/);
      expect(stop).toHaveBeenCalledOnce();
      expect(kill).not.toHaveBeenCalled();
      expect(internals.sessions.get(SESSION_ID)).toBe(session);
      expect(internals.sessionListenerRefs.get(SESSION_ID)).toBe(refs);
      expect(internals.runSummaryTrackers.get(SESSION_ID)).toBe(tracker);
    } finally {
      vi.restoreAllMocks();
      await internals.cleanupSession(SESSION_ID, false);
      await session.stop(false);
    }
  });

  it('blocks replacement registration until the original cleanup finishes', async () => {
    const original = buildSession();
    const replacement = buildSession();
    await internals.registerSessionWithLayout(original);
    await internals.setupSessionListeners(original);
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const actualStop = original.stop.bind(original);
    const stopped = vi.spyOn(original, 'stop').mockImplementationOnce(async (...args) => {
      started();
      await gate;
      await actualStop(...args);
    });
    const cleanup = internals.discardPartiallyBuiltSession(SESSION_ID);
    try {
      await entered;
      await expect(internals.registerSessionWithLayout(replacement)).rejects.toThrow(/cleanup is in progress/);
      expect(internals.sessions.get(SESSION_ID)).toBe(original);
      release();
      await cleanup;
      await internals.registerSessionWithLayout(replacement);
      await internals.setupSessionListeners(replacement);
      expect(internals.sessions.get(SESSION_ID)).toBe(replacement);
      expect(internals.sessionListenerRefs.has(SESSION_ID)).toBe(true);
      expect(stopped).toHaveBeenCalledOnce();
    } finally {
      release();
      await cleanup.catch(() => {});
      stopped.mockRestore();
    }
  });

  it('retains a same-ID successor if it appears while the original transport stop is pending', async () => {
    const original = buildSession();
    const replacement = buildSession();
    await internals.registerSessionWithLayout(original);
    await internals.setupSessionListeners(original);
    const refs = internals.sessionListenerRefs.get(SESSION_ID);
    const tracker = internals.runSummaryTrackers.get(SESSION_ID);
    const stop = vi.spyOn(original, 'stop').mockImplementationOnce(async () => {
      // Simulate another producer publishing while the original I/O is pending.
      internals.sessions.set(SESSION_ID, replacement);
    });
    const replacementStop = vi.spyOn(replacement, 'stop');
    const kill = vi.spyOn(mux, 'killSession');
    try {
      await expect(internals.discardPartiallyBuiltSession(SESSION_ID)).rejects.toThrow(/original session changed/);
      expect(stop).toHaveBeenCalledOnce();
      expect(replacementStop).not.toHaveBeenCalled();
      expect(kill).not.toHaveBeenCalled();
      expect(internals.sessions.get(SESSION_ID)).toBe(replacement);
      expect(internals.sessionListenerRefs.get(SESSION_ID)).toBe(refs);
      expect(internals.runSummaryTrackers.get(SESSION_ID)).toBe(tracker);
    } finally {
      vi.restoreAllMocks();
      // Only the fixture restores its original object to detach its observers.
      internals.sessions.set(SESSION_ID, original);
      await internals.discardPartiallyBuiltSession(SESSION_ID);
      await replacement.stop(false);
    }
  });

  it('does not install stale observers after an asynchronous setting read', async () => {
    const original = buildSession();
    const replacement = buildSession();
    await internals.registerSessionWithLayout(original);
    let release!: (enabled: boolean) => void;
    const gate = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    const setting = vi.spyOn(internals, 'isImageWatcherEnabled').mockReturnValueOnce(gate);
    const wiring = internals.setupSessionListeners(original);
    try {
      internals.sessions.set(SESSION_ID, replacement);
      release(false);
      await wiring;
      expect(internals.sessionListenerRefs.has(SESSION_ID)).toBe(false);
      expect(internals.runSummaryTrackers.has(SESSION_ID)).toBe(false);
      expect(original.listenerCount('data')).toBe(0);
      await internals.setupSessionListeners(replacement);
      expect(internals.sessionListenerRefs.has(SESSION_ID)).toBe(true);
    } finally {
      release(false);
      await wiring;
      setting.mockRestore();
      await original.stop(false);
    }
  });

  it('also removes the original session after startup layout reconciliation has completed', async () => {
    internals.tabLayouts.markRestorationComplete();
    const session = buildSession();
    await internals.registerSessionWithLayout(session);
    await internals.setupSessionListeners(session);

    await internals.discardPartiallyBuiltSession(SESSION_ID);

    expect(internals.sessions.has(SESSION_ID)).toBe(false);
    expect(internals.sessionListenerRefs.has(SESSION_ID)).toBe(false);
    expect(internals.runSummaryTrackers.has(SESSION_ID)).toBe(false);
  });

  it('removes the tab when startup completes while rollback is waiting for the owner lock', async () => {
    const pendingServer = new WebServer(0, false, true);
    const pending = pendingServer as unknown as ServerInternals;
    const session = buildSession();
    await pending.registerSessionWithLayout(session);
    let entered!: () => void;
    let release!: () => void;
    const acquired = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lock = pending.tabLayouts.withOwner(SINGLE_USER_LAYOUT_OWNER, async () => {
      entered();
      await gate;
    });
    let cleanup: Promise<void> | undefined;
    try {
      await acquired;
      cleanup = pending.discardPartiallyBuiltSession(SESSION_ID);
      pending.tabLayouts.markRestorationComplete();
      release();
      await lock;
      await cleanup;
      expect(pending.sessions.has(SESSION_ID)).toBe(false);
      const layout = pending.store.getTabLayout(SINGLE_USER_LAYOUT_OWNER);
      expect(layout?.ungrouped.some((ref) => ref.id === SESSION_ID)).toBe(false);
    } finally {
      release();
      await lock;
      await cleanup?.catch(() => {});
      await pendingServer.stop();
    }
  });

  it('refuses stale registration before publishing its tab after an asynchronous fact read', async () => {
    const original = buildSession();
    const successor = buildSession();
    let entered!: () => void;
    let release!: () => void;
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const readWebviews = internals.tabLayouts.deps.readWebviews.bind(internals.tabLayouts.deps);
    const read = vi.spyOn(internals.tabLayouts.deps, 'readWebviews').mockImplementationOnce(async () => {
      entered();
      await gate;
      return readWebviews();
    });
    const publication = vi.spyOn(internals.store, 'commitTabLayoutProjection');
    const registration = internals.registerSessionWithLayout(original);
    try {
      await reading;
      expect(internals.sessions.get(SESSION_ID)).toBe(original);
      internals.sessions.set(SESSION_ID, successor);
      release();
      await expect(registration).rejects.toThrow(/registration changed/);
      expect(internals.sessions.get(SESSION_ID)).toBe(successor);
      expect(publication).not.toHaveBeenCalled();
    } finally {
      release();
      await registration.catch(() => {});
      read.mockRestore();
      publication.mockRestore();
      await original.stop(false);
    }
  });

  it.skipIf(process.platform !== 'linux')(
    'joins the original owned PTY exit even when the liveness wait finishes before its callback',
    async () => {
      vi.stubEnv('REVERIE_WORKER_SOCKET', '');
      // Node's REPL is the disposable shell: no user shell startup files or model
      // provider is run. The actual Session/Store/PTY and exit callback are used.
      vi.stubEnv('SHELL', process.execPath);
      const publicationStore = new StateStore(join(WORKSPACE, `original-pty-${randomUUID()}.json`));
      const session = new Session({
        id: 'original-local-cleanup',
        mode: 'shell',
        workingDir: WORKSPACE,
        useMux: false,
        publicationStore,
      });
      let callbackObserved = false;
      const exited = vi.fn(() => { callbackObserved = true; });
      session.on('exit', exited);
      let restoreWait: (() => void) | undefined;
      let restoreStat: (() => void) | undefined;
      try {
        await session.startShell();
        const pid = session.pid;
        expect(pid).not.toBeNull();
        const original = readProcStat(pid!);
        expect(original?.ppid).toBe(process.pid);
        const readKernelStat = signalTarget.readProcStat;
        let waits = 0;
        const wait = vi.spyOn(processExitWait, 'waitForProcessesExit').mockImplementation(async () => {
          // The second wait follows the final signal. Model the zombie interval:
          // liveness has ended, but the original PID metadata remains until the
          // actual node-pty exit callback arrives. Signal verification itself
          // always reads the real kernel metadata for this owned child.
          if (++waits === 2) {
            const stat = vi.spyOn(signalTarget, 'readProcStat').mockImplementation((subject) =>
              subject === pid && !callbackObserved ? original : readKernelStat(subject));
            restoreStat = () => stat.mockRestore();
          }
          return [];
        });
        restoreWait = () => wait.mockRestore();

        await expect(session.captureCleanupStop(() => true).stop()).resolves.toBeUndefined();

        expect(readProcStat(pid!)?.startTime).not.toBe(original!.startTime);
        expect(exited).toHaveBeenCalledOnce();
        expect(wait).toHaveBeenCalled();
        expect(session.pid).toBeNull();
      } finally {
        restoreStat?.();
        restoreWait?.();
        await session.stop(true);
        await publicationStore.saveNowAsync();
        vi.unstubAllEnvs();
      }
    }
  );
});
