/**
 * Persistent sessions across a container-only restart: the boot signal, OpenCode's
 * native thread, the pinned-only auto-restore set, duplicate refusal and pinned records
 * surviving the post-restore prune. Pure functions plus a real StateStore on a temp file.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionState } from '../src/types.js';
import {
  autoRestorableEntries,
  initStartedAtFromProc,
  looksLikeHostReboot,
  nativeOpenCodeThread,
  planRebootRestore,
  rejectAlreadyLive,
} from '../src/reboot-restore.js';
import { StateStore } from '../src/state-store.js';

const HOUR = 60 * 60 * 1000;
const NOW = 1_760_000_000_000;

function record(overrides: Partial<SessionState> & { id: string }): SessionState {
  return {
    pid: 4242,
    status: 'busy',
    workingDir: '/tmp',
    currentTaskId: null,
    createdAt: NOW - 4 * HOUR,
    lastActivityAt: NOW - 2 * HOUR,
    mode: 'claude',
    ...overrides,
  } as SessionState;
}

describe('a container-only restart is recognised from PID 1, not host uptime', () => {
  const longHostUptime = 18 * 24 * 60 * 60; // the host itself has been up for weeks
  const base = {
    livePaneCount: 0,
    deadSessionCount: 4,
    uptimeSeconds: longHostUptime,
    newestPersistedActivityAt: NOW - 2 * 60 * 1000,
    now: NOW,
  };

  it('restores when the container started after the last activity, whatever the host uptime', () => {
    expect(looksLikeHostReboot(base)).toBe(false); // the old test can never see it
    expect(looksLikeHostReboot({ ...base, initStartedAt: NOW - 60 * 1000 })).toBe(true);
  });

  it('refuses when PID 1 is older than the last activity: the panes died some other way', () => {
    expect(looksLikeHostReboot({ ...base, initStartedAt: NOW - 3 * HOUR })).toBe(false);
  });

  it('still refuses an ordinary server restart, where panes survived', () => {
    expect(looksLikeHostReboot({ ...base, livePaneCount: 2, initStartedAt: NOW - 60 * 1000 })).toBe(false);
  });

  it('reads PID 1 start time from /proc, robust to a command name with spaces and parentheses', () => {
    // fields 3..22 after "pid (comm) "; field 22 (starttime) = 150000 ticks = 1500 s after boot
    const rest = ['S', ...Array.from({ length: 18 }, (_, i) => String(i + 1)), '150000', '0'].join(' ');
    const stat = `1 (init (container) x) ${rest}`;
    expect(initStartedAtFromProc(stat, '1600.00 9999.00', NOW)).toBe(NOW - 100 * 1000);
    expect(initStartedAtFromProc('garbage', '1600.00 1.00', NOW)).toBeUndefined();
    expect(initStartedAtFromProc(stat, 'not-a-number', NOW)).toBeUndefined();
  });
});

describe('OpenCode sessions are restored on their native thread', () => {
  it('plans an OpenCode record that names its thread, resuming that thread', () => {
    const persisted = {
      oc: record({
        id: 'oc',
        mode: 'opencode',
        openCodeConfig: { model: 'local/model', continueSession: 'ses_native123' },
      }),
    };
    const plan = planRebootRestore(['oc'], persisted, () => true);
    expect(plan.skipped).toEqual([]);
    expect(plan.restore[0]).toMatchObject({ sessionId: 'oc', mode: 'opencode', resumeConversationId: 'ses_native123' });
  });

  it('skips a forking OpenCode launch, which would start a new fork on every restore', () => {
    const persisted = {
      fork: record({ id: 'fork', mode: 'opencode', openCodeConfig: { continueSession: 'ses_parent', forkSession: true } }),
    };
    expect(planRebootRestore(['fork'], persisted, () => true).skipped).toEqual([
      { sessionId: 'fork', reason: 'unsupported-mode' },
    ]);
  });

  it('still skips an OpenCode record without a thread, and other unsupported CLIs', () => {
    const persisted = {
      bare: record({ id: 'bare', mode: 'opencode', openCodeConfig: { model: 'local/model' } }),
      cx: record({ id: 'cx', mode: 'codex' }),
    };
    const plan = planRebootRestore(['bare', 'cx'], persisted, () => true);
    expect(plan.skipped.map((s) => s.reason)).toEqual(['unsupported-mode', 'unsupported-mode']);
    expect(nativeOpenCodeThread({ mode: 'claude', openCodeConfig: { continueSession: 'ses_x' } })).toBeUndefined();
  });
});

describe('only pinned, unintentionally ended sessions come back on their own', () => {
  it('excludes intentional ends even when pinned: a pinned kill (stopped) and a clean /exit', () => {
    const persisted = {
      killed: record({ id: 'killed', pinned: true, status: 'stopped' }),
      exited: record({ id: 'exited', pinned: true, paneExit: { status: 0, at: NOW - HOUR } }),
      crashed: record({ id: 'crashed', pinned: true }),
    };
    const plan = planRebootRestore(['killed', 'exited', 'crashed'], persisted, () => true);
    expect(plan.skipped.map((s) => [s.sessionId, s.reason])).toEqual([
      ['killed', 'intentionally-ended'],
      ['exited', 'agent-exited'],
    ]);
    expect(plan.restore.map((e) => e.sessionId)).toEqual(['crashed']);
  });

  it('leaves a pinned session whose agent had already crashed as a click offer', () => {
    const persisted = {
      crashed: record({ id: 'crashed', pinned: true, paneExit: { status: 1, at: NOW - HOUR } }),
      killedBySignal: record({ id: 'killedBySignal', pinned: true, paneExit: { at: NOW - HOUR } }),
      healthy: record({ id: 'healthy', pinned: true }),
    };
    const plan = planRebootRestore(['crashed', 'killedBySignal', 'healthy'], persisted, () => true);
    expect(plan.restore.map((e) => e.sessionId)).toEqual(['crashed', 'killedBySignal', 'healthy']); // offered
    expect(autoRestorableEntries(plan.restore).map((e) => e.sessionId)).toEqual(['healthy']); // not automatic
  });

  it('auto-restores pinned entries only; the rest stay an offer', () => {
    const persisted = { p: record({ id: 'p', pinned: true }), u: record({ id: 'u' }) };
    const plan = planRebootRestore(['p', 'u'], persisted, () => true);
    expect(autoRestorableEntries(plan.restore).map((e) => e.sessionId)).toEqual(['p']);
  });

  it('refuses a duplicate: the id, the Claude conversation or the OpenCode thread is already live', () => {
    const persisted = {
      oc: record({ id: 'oc', pinned: true, mode: 'opencode', openCodeConfig: { continueSession: 'ses_live' } }),
      cl: record({ id: 'cl', pinned: true }),
    };
    const { restore } = planRebootRestore(['oc', 'cl'], persisted, () => true);
    const byThread = rejectAlreadyLive(restore, new Set(), new Set(['ses_live']));
    expect(byThread.skipped).toEqual([{ sessionId: 'oc', reason: 'already-live' }]);
    const byId = rejectAlreadyLive(restore, new Set(['cl']), new Set());
    expect(byId.skipped).toEqual([{ sessionId: 'cl', reason: 'already-live' }]);
  });
});

describe('pruning is deferred for persistent sessions', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('keeps a pinned dead record (and so its id-keyed bindings) through the post-restore prune', () => {
    dir = mkdtempSync(join(tmpdir(), 'persistent-ids-'));
    const store = new StateStore(join(dir, 'state.json'));
    store.setSession('pinned', record({ id: 'pinned', pinned: true }));
    store.setSession('loose', record({ id: 'loose' }));
    store.cleanupStaleSessions(new Set()); // nothing alive after the restart
    expect(store.getSession('pinned')?.pinned).toBe(true);
    expect(store.getSession('loose')).toBeNull(); // the unpinned one is pruned
    // ...and what survives is still planned for the same-id rebuild.
    expect(planRebootRestore(['pinned'], store.getSessions(), () => true).restore[0].sessionId).toBe('pinned');
  });
});
