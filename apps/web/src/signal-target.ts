/**
 * @fileoverview Which pids session teardown may signal.
 *
 * ## The incident this guards against
 *
 * On 2026-10-20 at 01:44:40Z the console cleaned up one exited session, and 290 ms
 * later every pane on the shared `-L reverie` tmux server was gone along with the
 * server itself. The exact pid that teardown signalled was not recoverable, but
 * killSession could reach that outcome: it fell back from tmux's pane pid to the
 * stored `session.pid`, then signalled that pid's descendants and its process group.
 * With the stored pid equal to the tmux server's pid that TERMs every pane, then the
 * server; with it 0 the descendant walk covers every process on the machine.
 *
 * Teardown therefore signals a pid only when it can show the pid is this session's
 * live pane right now: tmux reports it as the one pane of the exactly-named session
 * with pane_dead=0, both before and after /proc shows it as a child of our tmux
 * server, and it is none of the server, init, or the console itself. A dead pane
 * (remain-on-exit keeps its old pane_pid, which may since belong to a live sibling
 * pane of the same server), a missing session, more than one pane, or any tmux
 * answer we cannot read: no pid or group signal at all, only an exact-name
 * `tmux kill-session -t =NAME` (resolveLivePaneTarget). Session names go to tmux
 * with `=` and are compared exactly here, because a bare `-t NAME` matches by
 * prefix: a gone `reverie-ab` resolves to a live `reverie-abcd`. A
 * process group is signalled only when the pane leads it. Before every later signal
 * the start time is re-checked, so a reused pid is never hit. Without a verified pid,
 * `tmux kill-session` alone does the teardown.
 *
 * The same holds below the pane and on the console side:
 *   - a descendant from a process snapshot is signalled only while it is still the
 *     process it was bound to AND its parent chain still runs back to the verified
 *     pane (signalDescendants); a pid that exited, was reparented or reused is skipped;
 *   - the console's own PTY child (the tmux attach client) gets its FIRST signal, not
 *     only its SIGKILL, only once verified as our own live child (stopPtyChild), since
 *     node-pty's kill() is a bare process.kill(pid) and pid 0 there is our own group.
 *
 * What stays unprovable without pidfds: the gap between a check and its signal. Every
 * check sits immediately before its signal, with no await between them. For the pane
 * itself, tmux sets pane_dead from the pane's terminal closing, not from reaping the
 * process, so the two pane_dead=0 reads around the /proc read do not prove the pid
 * was unreaped in between: a pane process that exited, was reaped and had its pid
 * reused, all before tmux saw its terminal close, is the binding this cannot rule
 * out. (Observed on tmux 3.3a: pane_dead=1 while the pane process is still an
 * unreaped zombie, i.e. the usual order is close first.)
 *
 * @module signal-target
 */
import { readFileSync } from 'node:fs';

export interface ProcStat {
  ppid: number;
  pgid: number;
  /** Start time in clock ticks since boot (field 22): identifies one process across pid reuse. */
  startTime: number;
}

/** Parse `/proc/<pid>/stat`. The comm field may contain spaces and ')', so split after the LAST ')'. */
export function parseProcStat(raw: string): ProcStat | null {
  const close = raw.lastIndexOf(')');
  if (close < 0) return null;
  // After ") ": state(3) ppid(4) pgrp(5) ... starttime(22) → offsets 0, 1, 2 ... 19.
  const rest = raw.slice(close + 2).trim().split(' ');
  const ppid = Number(rest[1]);
  const pgid = Number(rest[2]);
  const startTime = Number(rest[19]);
  if (![ppid, pgid, startTime].every(Number.isInteger)) return null;
  return { ppid, pgid, startTime };
}

export function readProcStat(pid: number): ProcStat | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    return parseProcStat(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return null;
  }
}

export interface PaneTargetContext {
  /** The tmux server pid, read from the server just now. Null when it could not be read. */
  serverPid: number | null;
  /** The console's own pid and process group: never a target. */
  selfPid: number;
  selfPgid: number | null;
  stat: (pid: number) => ProcStat | null;
}

export interface PaneTarget {
  pid: number;
  startTime: number;
  /** True only when the pane leads its own process group, so `kill(-pid)` hits nothing else. */
  ownGroup: boolean;
}

/**
 * Verify `pid` as a live pane process of OUR tmux server. Returns null, and teardown
 * then signals nothing, whenever any check fails or cannot be made.
 */
export function verifyPaneTarget(pid: number | null | undefined, ctx: PaneTargetContext): PaneTarget | null {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1) return null;
  const { serverPid, selfPid, selfPgid } = ctx;
  if (serverPid === null || !Number.isInteger(serverPid) || serverPid <= 1) return null;
  if (pid === serverPid || pid === selfPid || pid === selfPgid) return null;
  const st = ctx.stat(pid);
  if (!st || st.ppid !== serverPid) return null;
  const ownGroup = st.pgid === pid && st.pgid !== serverPid && st.pgid !== selfPgid && st.pgid > 1;
  return { pid, startTime: st.startTime, ownGroup };
}

/** True while `target` still names the same process (same pid AND start time). */
export function isSameProcess(target: PaneTarget, stat: (pid: number) => ProcStat | null): boolean {
  const st = stat(target.pid);
  return st !== null && st.startTime === target.startTime;
}

/**
 * tmux `list-panes -a` format for {@link parseLivePane}. The session name comes last
 * so a name with spaces in it can never shift the dead/pid fields.
 */
export const PANE_LIVENESS_FORMAT = '#{pane_dead} #{pane_pid} #{session_name}';

export type PaneLiveness =
  | { state: 'live'; pid: number }
  | { state: 'dead' | 'missing' | 'ambiguous' | 'unreadable' };

/**
 * The live pane of the session named exactly `muxName`, from `list-panes -a` output in
 * {@link PANE_LIVENESS_FORMAT}. Only one pane, pane_dead exactly 0 and an integer pid
 * count as live. Rows for other sessions are ignored, including names that merely
 * start with `muxName`.
 */
export function parseLivePane(output: string | null, muxName: string): PaneLiveness {
  if (output === null) return { state: 'unreadable' };
  const rows: Array<{ dead: string; pid: string }> = [];
  for (const line of output.split('\n')) {
    const a = line.indexOf(' ');
    const b = a < 0 ? -1 : line.indexOf(' ', a + 1);
    if (b < 0) continue;
    if (line.slice(b + 1) !== muxName) continue;
    rows.push({ dead: line.slice(0, a), pid: line.slice(a + 1, b) });
  }
  if (rows.length === 0) return { state: 'missing' };
  if (rows.length > 1) return { state: 'ambiguous' };
  const { dead, pid } = rows[0];
  if (dead === '1') return { state: 'dead' };
  if (dead !== '0' || !/^[1-9][0-9]*$/.test(pid)) return { state: 'unreadable' };
  return { state: 'live', pid: Number(pid) };
}

/**
 * Bind teardown to the session's pane only while tmux says it is LIVE: read the pane,
 * verify its pid against /proc, then read the pane again and require the same live
 * pid and the same start time. A dead, missing, ambiguous or unreadable pane at either
 * read returns `target: null`, and teardown then signals nothing. The remaining gap is
 * described in the module header.
 */
export async function resolveLivePaneTarget(
  listPanes: () => Promise<string | null>,
  muxName: string,
  ctx: PaneTargetContext
): Promise<{ target: PaneTarget | null; pane: PaneLiveness }> {
  const pane = parseLivePane(await listPanes(), muxName);
  if (pane.state !== 'live') return { target: null, pane };
  const target = verifyPaneTarget(pane.pid, ctx);
  if (!target) return { target: null, pane };
  const again = parseLivePane(await listPanes(), muxName);
  if (again.state !== 'live' || again.pid !== pane.pid || !isSameProcess(target, ctx.stat)) {
    return { target: null, pane: again };
  }
  return { target, pane };
}

/** A descendant of a verified pane, bound to the process it was when the snapshot was taken. */
export interface DescendantTarget {
  pid: number;
  /** Parent at bind time: the pane itself or another bound descendant. */
  ppid: number;
  startTime: number;
}

/**
 * Bind snapshot pids (breadth-first, parents before children, as collectDescendants
 * returns them) to their current identity. A pid is kept only when /proc shows its
 * parent to be the verified root or an already-bound descendant; anything else
 * (gone, reparented, reused under another parent, or one of `exclude`) is dropped.
 */
export function bindDescendants(
  root: PaneTarget,
  pids: readonly number[],
  stat: (pid: number) => ProcStat | null,
  exclude: ReadonlySet<number> = new Set()
): Map<number, DescendantTarget> {
  const bound = new Map<number, DescendantTarget>();
  for (const pid of pids) {
    if (!Number.isInteger(pid) || pid <= 1 || pid === root.pid || exclude.has(pid) || bound.has(pid)) continue;
    const st = stat(pid);
    if (!st) continue;
    if (st.ppid !== root.pid && !bound.has(st.ppid)) continue;
    bound.set(pid, { pid, ppid: st.ppid, startTime: st.startTime });
  }
  return bound;
}

/**
 * True only while `d` is still the same process, still under the same parent, and
 * every ancestor up to the root still is too. Call it right before each signal.
 */
export function isVerifiedDescendant(
  d: DescendantTarget,
  root: PaneTarget,
  bound: ReadonlyMap<number, DescendantTarget>,
  stat: (pid: number) => ProcStat | null
): boolean {
  const seen = new Set<number>();
  let cur: DescendantTarget | undefined = d;
  while (cur) {
    if (seen.has(cur.pid)) return false; // a cycle cannot be a real ancestry
    seen.add(cur.pid);
    const st = stat(cur.pid);
    if (!st || st.startTime !== cur.startTime || st.ppid !== cur.ppid) return false;
    if (cur.ppid === root.pid) return isSameProcess(root, stat);
    cur = bound.get(cur.ppid);
  }
  return false;
}

/** Process access for the signalling helpers below, injected so tests drive them without real signals. */
export interface SignalDeps {
  stat: (pid: number) => ProcStat | null;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  selfPid: number;
  selfPgid: number | null;
}

/**
 * Send `signal` to each snapshot descendant of `root` whose identity binds now and
 * still verifies (same process, same parent chain up to the root) at the moment of
 * its own signal. Deepest first, so a parent's exit reparents as little as possible.
 */
export function signalDescendants(
  root: PaneTarget,
  pids: readonly number[],
  signal: NodeJS.Signals,
  deps: SignalDeps
): { bound: number[]; signalled: number[]; skipped: number } {
  const exclude = new Set<number>([deps.selfPid, ...(deps.selfPgid !== null ? [deps.selfPgid] : [])]);
  const bound = bindDescendants(root, pids, deps.stat, exclude);
  const signalled: number[] = [];
  let skipped = pids.length - bound.size;
  for (const d of [...bound.values()].reverse()) {
    if (!isVerifiedDescendant(d, root, bound, deps.stat)) {
      skipped += 1;
      continue;
    }
    try {
      deps.kill(d.pid, signal);
      signalled.push(d.pid);
    } catch {
      // Exited between the check and the signal
    }
  }
  return { bound: [...bound.keys()], signalled, skipped };
}

/** The part of a node-pty IPty this needs. Its kill() is a bare process.kill(pid). */
export interface PtyChild {
  pid: number;
  kill(signal?: string): void;
}

/**
 * Stop the console's own PTY child: SIGTERM, a grace wait, then SIGKILL to its
 * group when it leads one (that covers the child too), else to it alone. Every
 * signal, the first included, needs the child verified at that moment: a positive
 * pid, not the console or its group, a child of the console, and the same process
 * (start time) as when first identified. Otherwise nothing is signalled.
 */
export async function stopPtyChild(
  pty: PtyChild,
  deps: SignalDeps & { wait: (pids: number[]) => Promise<unknown>; warn?: (msg: string) => void }
): Promise<'unverified' | 'stopped'> {
  const pid = pty.pid;
  const ok = Number.isInteger(pid) && pid > 1 && pid !== deps.selfPid && pid !== deps.selfPgid;
  const first = ok ? deps.stat(pid) : null;
  const own = first !== null && first.ppid === deps.selfPid ? first : null;
  if (!own) {
    deps.warn?.(`PTY pid ${pid} is not a verified child of this console; not signalling it`);
    return 'unverified';
  }
  const still = (): boolean => {
    const now = deps.stat(pid);
    return now !== null && now.startTime === own.startTime && now.ppid === deps.selfPid;
  };
  try {
    if (still()) pty.kill('SIGTERM');
  } catch {
    // Already gone
  }
  await deps.wait([pid]);
  try {
    if (still()) {
      if (own.pgid === pid) deps.kill(-pid, 'SIGKILL');
      else deps.kill(pid, 'SIGKILL');
    }
  } catch {
    // Exited between the check and the signal
  }
  return 'stopped';
}
