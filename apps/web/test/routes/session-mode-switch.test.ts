import { trustedFixtureOwner } from '../helpers/trusted-owner-fixture.js';
/**
 * POST /api/sessions/:id/mode: the owner switches a pinned session's CLI and the pane restarts IN PLACE.
 * Owner only, pinned only, local only, an enabled registry CLI only, never while busy or mid-switch.
 * The audit line comes first; a failed restart puts the old mode back on the session and the mux record;
 * processes of the old command that outlive the restart are reported and never signalled.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const log = vi.fn();
vi.mock('../../src/session-lifecycle-log.js', async (orig) => {
  const actual = await orig<typeof import('../../src/session-lifecycle-log.js')>();
  return { ...actual, getLifecycleLog: () => ({ log, query: async () => [] }) };
});
const tree = { snapshot: vi.fn(() => [] as { pid: number; startTime: number }[]), left: vi.fn(() => [] as { pid: number; startTime: number }[]) };
vi.mock('../../src/pane-survivors.js', () => ({
  snapshotPaneTree: (pid: unknown) => tree.snapshot(pid as never),
  survivors: (t: unknown) => tree.left(t as never),
}));
const disabled = new Set<string>();
vi.mock('../../src/config/cli-registry/registry.js', async (orig) => {
  const actual = await orig<typeof import('../../src/config/cli-registry/registry.js')>();
  return {
    ...actual,
    getCli: (id: string) => {
      const e = actual.getCli(id);
      return e && disabled.has(id) ? { ...e, enabled: false } : e;
    },
  };
});

import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';

const url = '/api/sessions/test-session-1/mode';

describe('POST /api/sessions/:id/mode', () => {
  let h: RouteTestHarness;
  let muxPid: number;

  beforeEach(async () => {
    log.mockClear();
    tree.snapshot.mockReset().mockReturnValue([{ pid: 100, startTime: 7 }, { pid: 101, startTime: 8 }]);
    tree.left.mockReset().mockReturnValue([]);
    disabled.clear();
    h = await createRouteTestHarness((app, ctx) => registerSessionRoutes(app, ctx, { verifiedOwner: trustedFixtureOwner }));
    h.ctx._session.mode = 'opencode';
    h.ctx._session.pinned = true;
    muxPid = 100;
    (h.ctx.mux.getSession as ReturnType<typeof vi.fn>).mockImplementation(() => ({ pid: muxPid }));
    h.ctx._session.restartCli.mockImplementation(async () => {
      muxPid = 200;
      return true;
    });
  });

  afterEach(async () => {
    await h.app.close();
  });

  const post = (payload: unknown, headers: Record<string, string> = {}) =>
    h.app.inject({ method: 'POST', url, payload: payload as never, headers });
  const untouched = () => {
    expect(h.ctx._session.mode).toBe('opencode');
    expect(h.ctx._session.restartCli).not.toHaveBeenCalled();
    expect(h.ctx.mux.updateSessionMode).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  };

  it('switches, restarts the pane in place once, persists, and audits before and after', async () => {
    const res = await post({ mode: 'claude' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ from: 'opencode', to: 'claude', oldPid: 100, newPid: 200, survivors: [] });
    expect(h.ctx._session.mode).toBe('claude');
    expect(h.ctx.mux.updateSessionMode).toHaveBeenCalledWith('test-session-1', 'claude');
    expect(h.ctx._session.restartCli).toHaveBeenCalledTimes(1);
    expect(h.ctx.mux.killSession).not.toHaveBeenCalled();
    expect(h.ctx.persistSessionState).toHaveBeenCalled();
    expect(tree.snapshot).toHaveBeenCalledWith(100);
    expect(log.mock.calls.map((c) => c[0].reason)).toEqual(['requested', 'switched']);
    expect(log.mock.calls[0][0]).toMatchObject({ event: 'mode_set', mode: 'opencode', extra: { from: 'opencode', to: 'claude', by: 'owner', oldPid: 100 } });
    // The audit line is written before anything changes.
    expect(log.mock.invocationCallOrder[0]).toBeLessThan(h.ctx._session.setMode.mock.invocationCallOrder[0]);
    expect(log.mock.calls[1][0]).toMatchObject({ mode: 'claude', extra: { newPid: 200, survivors: [] } });
  });

  it('switches back the same way', async () => {
    await post({ mode: 'claude' });
    const res = await post({ mode: 'opencode' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ from: 'claude', to: 'opencode' });
    expect(h.ctx._session.mode).toBe('opencode');
  });

  it('refuses an agent caller, whoever it is, and changes nothing', async () => {
    for (const who of ['test-session-1', 'someone-else', '']) {
      expect((await post({ mode: 'claude' }, { 'x-reverie-parent-session': who })).statusCode, who).toBe(403);
    }
    untouched();
  });

  it('refuses a malformed body', async () => {
    for (const body of [{}, { mode: '' }, { mode: 'Claude' }, { mode: '../x' }, { mode: '-x' }, { mode: 'a'.repeat(65) },
      { mode: 42 }, { mode: 'claude', force: true }]) {
      expect((await post(body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    untouched();
  });

  it('refuses an unpinned, remote, Docker or busy session, the same mode, and an unknown or disabled CLI', async () => {
    h.ctx._session.pinned = false;
    expect((await post({ mode: 'claude' })).statusCode).toBe(409);
    h.ctx._session.pinned = true;
    h.ctx._session.remote = { host: 'x' };
    expect((await post({ mode: 'claude' })).statusCode).toBe(400);
    h.ctx._session.remote = undefined;
    h.ctx._session.docker = { image: 'x' };
    expect((await post({ mode: 'claude' })).statusCode).toBe(400);
    h.ctx._session.docker = undefined;
    expect((await post({ mode: 'opencode' })).statusCode).toBe(400);
    expect((await post({ mode: 'no-such-cli' })).statusCode).toBe(400);
    disabled.add('claude');
    expect((await post({ mode: 'claude' })).statusCode).toBe(400);
    disabled.clear();
    h.ctx._session.isBusy.mockReturnValue(true);
    expect((await post({ mode: 'claude' })).statusCode).toBe(409);
    untouched();
  });

  it('refuses a session without a pane record', async () => {
    (h.ctx.mux.getSession as ReturnType<typeof vi.fn>).mockImplementation(() => null);
    expect((await post({ mode: 'claude' })).statusCode).toBe(409);
    untouched();
  });

  it('a restart that fails or throws puts the old mode back on the session and the mux record', async () => {
    for (const fail of [async () => false, async () => { throw new Error('tmux gone'); }]) {
      log.mockClear();
      (h.ctx.mux.updateSessionMode as ReturnType<typeof vi.fn>).mockClear();
      h.ctx._session.restartCli.mockImplementation(fail);
      const res = await post({ mode: 'claude' });
      expect(res.statusCode).toBe(500);
      expect(h.ctx._session.mode).toBe('opencode');
      expect((h.ctx.mux.updateSessionMode as ReturnType<typeof vi.fn>).mock.calls).toEqual([
        ['test-session-1', 'claude'],
        ['test-session-1', 'opencode'],
      ]);
      expect(log.mock.calls.map((c) => c[0].reason)).toEqual(['requested', 'restart_failed']);
    }
  });

  it('a second switch while one is running is refused', async () => {
    let release: (v: boolean) => void = () => {};
    h.ctx._session.restartCli.mockImplementation(() => new Promise<boolean>((r) => (release = r)));
    // inject() is lazy until awaited; Promise.resolve starts it now.
    const first = Promise.resolve(post({ mode: 'claude' }));
    await vi.waitFor(() => expect(h.ctx._session.restartCli).toHaveBeenCalled());
    const second = await post({ mode: 'shell' });
    expect(second.statusCode).toBe(409);
    release(true);
    expect((await first).statusCode).toBe(200);
    expect(h.ctx._session.restartCli).toHaveBeenCalledTimes(1);
    expect(h.ctx._session.mode).toBe('claude');
    // Released after the first finishes.
    h.ctx._session.restartCli.mockImplementation(async () => true);
    expect((await post({ mode: 'opencode' })).statusCode).toBe(200);
  });

  it('reports old processes that outlived the restart, and signals nothing', async () => {
    const kill = vi.spyOn(process, 'kill');
    tree.left.mockReturnValue([{ pid: 101, startTime: 8 }]);
    const res = await post({ mode: 'claude' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.survivors).toEqual([101]);
    expect(tree.left).toHaveBeenCalledWith([{ pid: 100, startTime: 7 }, { pid: 101, startTime: 8 }]);
    expect(log.mock.calls[1][0]).toMatchObject({ reason: 'switched_with_survivors', extra: { survivors: [101] } });
    expect(kill).not.toHaveBeenCalled();
    kill.mockRestore();
  });
});

describe('Session.setMode', () => {
  it('changes the mode for the next launch and keeps the OpenCode thread in the saved state', async () => {
    const { Session } = await vi.importActual<typeof import('../../src/session.js')>('../../src/session.js');
    const { nativeOpenCodeThread } = await import('../../src/reboot-restore.js');
    const s = new Session({ workingDir: '/tmp', mode: 'opencode', openCodeConfig: { continueSession: 'ses_kept00000' } } as ConstructorParameters<typeof Session>[0]);
    s.setMode('shell');
    expect(s.mode).toBe('shell');
    expect(s.toState().mode).toBe('shell');
    expect(s.toState().openCodeConfig).toEqual({ continueSession: 'ses_kept00000' });
    s.setMode('opencode');
    expect(nativeOpenCodeThread(s.toState())).toBe('ses_kept00000');
  });

  it('refuses an unknown CLI and keeps its mode', async () => {
    const { Session } = await vi.importActual<typeof import('../../src/session.js')>('../../src/session.js');
    const s = new Session({ workingDir: '/tmp', mode: 'opencode' } as ConstructorParameters<typeof Session>[0]);
    expect(() => s.setMode('no-such-cli' as never)).toThrow(/No CLI registry entry/);
    expect(s.mode).toBe('opencode');
  });
});

describe('Session.setMode and typed prompts', () => {
  it('follows the new CLI: a shell takes no prompts, a prompt CLI does', async () => {
    const { Session } = await vi.importActual<typeof import('../../src/session.js')>('../../src/session.js');
    const s = new Session({ workingDir: '/tmp', mode: 'opencode' } as ConstructorParameters<typeof Session>[0]);
    const seen: string[] = [];
    s.on('promptSubmitted', (p: string) => seen.push(p));
    s.trackUserInput('first\r');
    s.setMode('shell');
    s.trackUserInput('second\r');
    s.setMode('claude');
    s.trackUserInput('third\r');
    expect(seen).toEqual(['first', 'third']);
  });
});
