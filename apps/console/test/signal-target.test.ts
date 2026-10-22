/**
 * @fileoverview Session teardown may signal only a verified pane of our own tmux server.
 *
 * Regression for the 2026-10-20 01:44Z outage: one session's cleanup coincided with
 * the shared tmux server and every pane dying. killSession used to fall back to the
 * stored session.pid; with that equal to the server pid it signalled every pane and
 * then the server's group, and with 0 the descendant walk covered every process.
 *
 * Port: N/A (no server needed)
 */

import { describe, it, expect } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import {
  isSameProcess,
  PANE_LIVENESS_FORMAT,
  parseLivePane,
  parseProcStat,
  readProcStat,
  resolveLivePaneTarget,
  signalDescendants,
  stopPtyChild,
  verifyPaneTarget,
  type ProcStat,
  type SignalDeps,
} from '../src/signal-target.js';

const SERVER = 5400;
const SELF = 9000;
const SELF_PGID = 8990;

function ctx(table: Record<number, ProcStat>, serverPid: number | null = SERVER) {
  return { serverPid, selfPid: SELF, selfPgid: SELF_PGID, stat: (pid: number) => table[pid] ?? null };
}

const pane: ProcStat = { ppid: SERVER, pgid: 7001, startTime: 111 };

describe('verifyPaneTarget', () => {
  it('accepts a live pane that is a child of our server and leads its own group', () => {
    expect(verifyPaneTarget(7001, ctx({ 7001: pane }))).toEqual({ pid: 7001, startTime: 111, ownGroup: true });
  });

  it('never targets the tmux server itself (the outage shape)', () => {
    const table = { [SERVER]: { ppid: 1, pgid: SERVER, startTime: 5 } };
    expect(verifyPaneTarget(SERVER, ctx(table))).toBeNull();
  });

  it.each([0, 1, -1, NaN, null, undefined])('never targets pid %s', (pid) => {
    expect(verifyPaneTarget(pid as number, ctx({ 0: pane, 1: pane }))).toBeNull();
  });

  it('never targets the console itself or its own process group', () => {
    const table = { [SELF]: { ...pane }, [SELF_PGID]: { ...pane } };
    expect(verifyPaneTarget(SELF, ctx(table))).toBeNull();
    expect(verifyPaneTarget(SELF_PGID, ctx(table))).toBeNull();
  });

  it('rejects a dead pane pid (no /proc entry)', () => {
    expect(verifyPaneTarget(7001, ctx({}))).toBeNull();
  });

  it('rejects a reused pid that is no longer a child of our server', () => {
    expect(verifyPaneTarget(7001, ctx({ 7001: { ppid: 4321, pgid: 7001, startTime: 999 } }))).toBeNull();
  });

  it('rejects everything when the server pid could not be read', () => {
    expect(verifyPaneTarget(7001, ctx({ 7001: pane }, null))).toBeNull();
  });

  it('marks a pane that does not lead its group as ownGroup=false (no group kill)', () => {
    const shared = { ppid: SERVER, pgid: SERVER, startTime: 111 };
    expect(verifyPaneTarget(7001, ctx({ 7001: shared }))?.ownGroup).toBe(false);
  });
});

describe('isSameProcess', () => {
  it('detects pid reuse by start time', () => {
    const target = { pid: 7001, startTime: 111, ownGroup: true };
    expect(isSameProcess(target, (p) => (p === 7001 ? pane : null))).toBe(true);
    expect(isSameProcess(target, (p) => (p === 7001 ? { ...pane, startTime: 222 } : null))).toBe(false);
    expect(isSameProcess(target, () => null)).toBe(false);
  });
});

describe('parseProcStat / readProcStat', () => {
  it('parses a comm containing spaces and parentheses', () => {
    const fields = Array.from({ length: 50 }, (_, i) => String(i));
    // state, ppid=42, pgrp=43, ..., starttime at offset 19
    fields[0] = 'S';
    fields[1] = '42';
    fields[2] = '43';
    fields[19] = '123456';
    expect(parseProcStat(`77 (tmux: a) b)) ${fields.join(' ')}`)).toEqual({ ppid: 42, pgid: 43, startTime: 123456 });
  });

  it('returns null for garbage', () => {
    expect(parseProcStat('nonsense')).toBeNull();
  });

  it('reads a real child of this process', async () => {
    const child = spawn('sleep', ['5'], { detached: true, stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 50));
      const st = readProcStat(child.pid!);
      expect(st?.ppid).toBe(process.pid);
      expect(st?.pgid).toBe(child.pid);
      expect(readProcStat(0)).toBeNull();
    } finally {
      child.kill('SIGKILL');
    }
  });
});

/** A fake /proc whose entries a test may change mid-run; every signal is recorded, none is sent. */
function fakeProc(table: Record<number, ProcStat>, onKill?: (pid: number, sig: string) => void) {
  const calls: Array<[number, string]> = [];
  const deps: SignalDeps = {
    stat: (pid) => table[pid] ?? null,
    kill: (pid, sig) => {
      calls.push([pid, sig]);
      onKill?.(pid, sig);
    },
    selfPid: SELF,
    selfPgid: SELF_PGID,
  };
  return { deps, calls, table };
}

describe('signalDescendants', () => {
  const root = { pid: 7001, startTime: 111, ownGroup: true };
  const tree = (): Record<number, ProcStat> => ({
    7001: pane,
    8001: { ppid: 7001, pgid: 7001, startTime: 200 },
    8002: { ppid: 8001, pgid: 7001, startTime: 201 },
  });

  it('signals verified descendants, deepest first', () => {
    const p = fakeProc(tree());
    const r = signalDescendants(root, [8001, 8002], 'SIGTERM', p.deps);
    expect(p.calls).toEqual([
      [8002, 'SIGTERM'],
      [8001, 'SIGTERM'],
    ]);
    expect(r.skipped).toBe(0);
  });

  it('TG-K2: never signals a snapshot pid that now belongs to an unrelated parent', () => {
    const t = tree();
    t[8001] = { ppid: 2222, pgid: 2222, startTime: 999 };
    const p = fakeProc(t);
    const r = signalDescendants(root, [8001], 'SIGTERM', p.deps);
    expect(p.calls).toEqual([]);
    expect(r.skipped).toBe(1);
  });

  it('TG-K2: skips a child reused between bind and its signal, and its orphaned subtree', () => {
    const t = tree();
    // 8002 is signalled first (deepest); that signal "reuses" 8001 for another process.
    const p = fakeProc(t, (pid) => {
      if (pid === 8002) t[8001] = { ppid: 7001, pgid: 7001, startTime: 555 };
    });
    signalDescendants(root, [8001, 8002], 'SIGTERM', p.deps);
    expect(p.calls).toEqual([[8002, 'SIGTERM']]);
  });

  it('skips a grandchild whose parent was reused, even though the grandchild itself is unchanged', () => {
    const t = tree();
    const p = fakeProc(t);
    let reads = 0;
    const stat = (pid: number): ProcStat | null => {
      reads += 1;
      if (reads === 3) t[8001] = { ...t[8001], startTime: 777 }; // after bind's two reads
      return t[pid] ?? null;
    };
    signalDescendants(root, [8001, 8002], 'SIGTERM', { ...p.deps, stat });
    expect(p.calls).toEqual([]);
  });

  it('signals nothing once the root itself is no longer the same process', () => {
    const t = tree();
    t[7001] = { ...pane, startTime: 4242 };
    const p = fakeProc(t);
    expect(signalDescendants(root, [8001, 8002], 'SIGKILL', p.deps).signalled).toEqual([]);
    expect(p.calls).toEqual([]);
  });

  it('never signals init, pid 0, the console or its group even if a snapshot lists them', () => {
    const t = tree();
    t[1] = { ppid: 7001, pgid: 1, startTime: 1 };
    t[SELF] = { ppid: 7001, pgid: SELF_PGID, startTime: 3 };
    t[SELF_PGID] = { ppid: 7001, pgid: SELF_PGID, startTime: 4 };
    const p = fakeProc(t);
    signalDescendants(root, [0, 1, -1, SELF, SELF_PGID], 'SIGKILL', p.deps);
    expect(p.calls).toEqual([]);
  });

  it('second phase: a stale re-scan entry reused under another parent is skipped', () => {
    const t = tree();
    const p = fakeProc(t);
    signalDescendants(root, [8001, 8002], 'SIGTERM', p.deps);
    // Both exit; 8002 is reused by an unrelated process before the KILL phase.
    delete t[8001];
    t[8002] = { ppid: 3333, pgid: 3333, startTime: 900 };
    p.calls.length = 0;
    signalDescendants(root, [8001, 8002], 'SIGKILL', p.deps);
    expect(p.calls).toEqual([]);
  });
});

describe('stopPtyChild', () => {
  const ptyStat: ProcStat = { ppid: SELF, pgid: 6001, startTime: 50 };
  function run(pid: number, table: Record<number, ProcStat>, afterTerm?: (t: Record<number, ProcStat>) => void) {
    const p = fakeProc(table);
    const ptyKills: string[] = [];
    const pty = { pid, kill: (sig?: string) => void ptyKills.push(sig ?? 'SIGHUP') };
    const result = stopPtyChild(pty, {
      ...p.deps,
      wait: async () => {
        afterTerm?.(table);
      },
    });
    return { result, ptyKills, calls: p.calls };
  }

  it('verified child leading its group: SIGTERM via the pty, then SIGKILL to its group', async () => {
    const r = run(6001, { 6001: { ...ptyStat } });
    expect(await r.result).toBe('stopped');
    expect(r.ptyKills).toEqual(['SIGTERM']);
    expect(r.calls).toEqual([[-6001, 'SIGKILL']]);
  });

  it('verified child not leading its group: SIGKILL to the child alone', async () => {
    const r = run(6001, { 6001: { ...ptyStat, pgid: 5000 } });
    await r.result;
    expect(r.calls).toEqual([[6001, 'SIGKILL']]);
  });

  it.each([
    ['zero', 0],
    ['one', 1],
    ['negative', -1],
    ['NaN', NaN],
    ['the console', SELF],
    ["the console's group", SELF_PGID],
  ])('TG-K1: pid %s gets no signal at all, not even the first', async (_label, pid) => {
    const table = { [pid as number]: { ...ptyStat } };
    const r = run(pid as number, table);
    expect(await r.result).toBe('unverified');
    expect(r.ptyKills).toEqual([]);
    expect(r.calls).toEqual([]);
  });

  it('TG-K1: the tmux server pid (not our child) gets no signal', async () => {
    const r = run(SERVER, { [SERVER]: { ppid: 1, pgid: SERVER, startTime: 5 } });
    expect(await r.result).toBe('unverified');
    expect(r.ptyKills).toEqual([]);
    expect(r.calls).toEqual([]);
  });

  it('TG-K1: a foreign or reused pid (parent is not the console) gets no signal', async () => {
    const r = run(6001, { 6001: { ppid: 4321, pgid: 6001, startTime: 77 } });
    expect(await r.result).toBe('unverified');
    expect(r.ptyKills).toEqual([]);
    expect(r.calls).toEqual([]);
  });

  it('TG-K1: an absent PTY child (no /proc entry) gets no signal', async () => {
    const r = run(6001, {});
    expect(await r.result).toBe('unverified');
    expect(r.ptyKills).toEqual([]);
    expect(r.calls).toEqual([]);
  });

  it('no group SIGKILL once the child has exited (its pgid no longer proves anything)', async () => {
    const r = run(6001, { 6001: { ...ptyStat } }, (t) => delete t[6001]);
    await r.result;
    expect(r.ptyKills).toEqual(['SIGTERM']);
    expect(r.calls).toEqual([]);
  });

  it('no SIGKILL when the pid was reused during the grace wait', async () => {
    const r = run(6001, { 6001: { ...ptyStat } }, (t) => {
      t[6001] = { ...ptyStat, startTime: 51 };
    });
    await r.result;
    expect(r.calls).toEqual([]);
  });
});

describe('parseLivePane', () => {
  const NAME = 'reverie-ab';

  it('returns the pid of the one live pane of the exactly-named session', () => {
    expect(parseLivePane('0 7001 reverie-ab\n0 7002 reverie-cd\n', NAME)).toEqual({ state: 'live', pid: 7001 });
  });

  it('a dead remain-on-exit pane is dead, whatever pid tmux still reports for it', () => {
    expect(parseLivePane('1 7001 reverie-ab\n0 7001 reverie-cd\n', NAME)).toEqual({ state: 'dead' });
  });

  it('ignores sessions whose names only start with the target (tmux -t prefix match)', () => {
    expect(parseLivePane('0 7002 reverie-abcd\n0 7003 reverie-ab-x\n', NAME)).toEqual({ state: 'missing' });
  });

  it('a name with spaces cannot shift the fields onto the target', () => {
    expect(parseLivePane('0 7002 reverie-ab 0 7003\n', NAME)).toEqual({ state: 'missing' });
  });

  it('more than one pane is ambiguous', () => {
    expect(parseLivePane('0 7001 reverie-ab\n0 7004 reverie-ab\n', NAME)).toEqual({ state: 'ambiguous' });
  });

  it.each([
    ['no tmux answer', null],
    ['empty pane_dead', ' 7001 reverie-ab'],
    ['pane_dead not 0/1', '2 7001 reverie-ab'],
    ['pid 0', '0 0 reverie-ab'],
    ['pid not a number', '0 x reverie-ab'],
    ['negative pid', '0 -1 reverie-ab'],
  ])('%s is unreadable', (_label, out) => {
    expect(parseLivePane(out, NAME)).toEqual({ state: 'unreadable' });
  });
});

describe('resolveLivePaneTarget (TG-K3)', () => {
  const NAME = 'reverie-ab';
  const SIBLING: ProcStat = { ppid: SERVER, pgid: 7001, startTime: 555 };

  function lister(...outputs: Array<string | null>) {
    let calls = 0;
    const fn = async () => outputs[Math.min(calls++, outputs.length - 1)];
    return { fn, calls: () => calls };
  }

  it("a dead pane whose retained pid is now a live sibling of the same server gets no target (Inspector's TG-K3)", async () => {
    // pane_dead=1, pane_pid=7001 retained; 7001 now a live sibling pane: child of our
    // server, leading its own group. r2 bound this and signalled -7001.
    const stats: number[] = [];
    const l = lister('1 7001 reverie-ab\n0 7001 reverie-cd\n');
    const r = await resolveLivePaneTarget(l.fn, NAME, {
      ...ctx({ 7001: SIBLING }),
      stat: (pid) => (stats.push(pid), SIBLING),
    });
    expect(r).toEqual({ target: null, pane: { state: 'dead' } });
    expect(stats).toEqual([]);
    expect(l.calls()).toBe(1);
  });

  it('a gone session whose name prefixes a live one gets no target', async () => {
    const r = await resolveLivePaneTarget(lister('0 7002 reverie-abcd\n').fn, NAME, ctx({ 7002: pane }));
    expect(r.target).toBeNull();
    expect(r.pane.state).toBe('missing');
  });

  it('binds a live pane that tmux still reports live after the /proc read', async () => {
    const l = lister('0 7001 reverie-ab\n');
    const r = await resolveLivePaneTarget(l.fn, NAME, ctx({ 7001: pane }));
    expect(r.target).toEqual({ pid: 7001, startTime: 111, ownGroup: true });
    expect(l.calls()).toBe(2);
  });

  it('a pane that dies between the two reads gets no target', async () => {
    const r = await resolveLivePaneTarget(lister('0 7001 reverie-ab\n', '1 7001 reverie-ab\n').fn, NAME, ctx({ 7001: pane }));
    expect(r).toEqual({ target: null, pane: { state: 'dead' } });
  });

  it('a pane replaced by another pid between the two reads gets no target', async () => {
    const r = await resolveLivePaneTarget(
      lister('0 7001 reverie-ab\n', '0 7009 reverie-ab\n').fn,
      NAME,
      ctx({ 7001: pane, 7009: pane })
    );
    expect(r.target).toBeNull();
  });

  it('a pid whose start time changed between the reads gets no target', async () => {
    let n = 0;
    const r = await resolveLivePaneTarget(lister('0 7001 reverie-ab\n').fn, NAME, {
      ...ctx({}),
      stat: () => (n++ === 0 ? pane : { ...pane, startTime: 999 }),
    });
    expect(r.target).toBeNull();
  });

  it('tmux not answering the second read gets no target', async () => {
    const r = await resolveLivePaneTarget(lister('0 7001 reverie-ab\n', null).fn, NAME, ctx({ 7001: pane }));
    expect(r).toEqual({ target: null, pane: { state: 'unreadable' } });
  });

  it('a live pane that fails /proc verification (the server pid) gets no target', async () => {
    const r = await resolveLivePaneTarget(lister(`0 ${SERVER} reverie-ab\n`).fn, NAME, ctx({ [SERVER]: pane }));
    expect(r.target).toBeNull();
  });
});

function hasTmux(): boolean {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!hasTmux())('parseLivePane against a private tmux server', () => {
  it('a remain-on-exit pane reads dead with its old pid kept; prefix names do not match', async () => {
    const sock = `signal-target-test-${process.pid}`;
    const tmux = (...a: string[]) => execFileSync('tmux', ['-L', sock, '-f', '/dev/null', ...a], { encoding: 'utf8' });
    try {
      tmux('new-session', '-d', '-s', 'reverie-abcd', 'sleep 30');
      tmux('set-option', '-g', 'remain-on-exit', 'on');
      const original = Number(tmux('new-session', '-d', '-P', '-F', '#{pane_pid}', '-s', 'reverie-ab', 'true').trim());
      const list = () => tmux('list-panes', '-a', '-F', PANE_LIVENESS_FORMAT);
      for (let i = 0; i < 50 && !/^1 \d+ reverie-ab$/m.test(list()); i++) await new Promise((r) => setTimeout(r, 50));
      const out = list();
      const retained = Number(/^1 (\d+) reverie-ab$/m.exec(out)?.[1]);
      expect(original).toBeGreaterThan(1);
      expect(retained).toBe(original);
      expect(parseLivePane(out, 'reverie-ab')).toEqual({ state: 'dead' });
      expect(parseLivePane(out, 'reverie-abcd').state).toBe('live');
      expect(parseLivePane(out, 'reverie-abc')).toEqual({ state: 'missing' });
      // The exact-name kill the teardown uses: =NAME never falls through to a prefix.
      expect(() => tmux('kill-session', '-t', '=reverie-abc')).toThrow();
      expect(parseLivePane(list(), 'reverie-abcd').state).toBe('live');
    } finally {
      try {
        tmux('kill-server');
      } catch {
        // already gone
      }
    }
  });
});
