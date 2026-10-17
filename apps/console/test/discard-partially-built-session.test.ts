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
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { safeRmHomeTree } from './mocks/test-helpers.js';

import { WebServer } from '../src/web/server.js';
import { Session } from '../src/session.js';
import { TmuxManager } from '../src/tmux-manager.js';

/** Reach the private collections the discard is responsible for emptying. */
interface ServerInternals {
  sessions: Map<string, Session>;
  sessionListenerRefs: Map<string, unknown>;
  runSummaryTrackers: Map<string, unknown>;
  registerSessionWithLayout(session: Session): Promise<void>;
  setupSessionListeners(session: Session): Promise<void>;
  discardPartiallyBuiltSession(sessionId: string): Promise<void>;
}

const WORKSPACE = join(homedir(), '.codeman-test-discard');
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
});
