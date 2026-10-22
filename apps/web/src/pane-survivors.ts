/**
 * @fileoverview Which processes of a replaced pane command are still alive.
 *
 * `respawn-pane -k` replaces the pane command, but a CLI that ignores SIGHUP/SIGTERM
 * (OpenCode did, live) can outlive it, detached from the pane. The mode switch takes a
 * snapshot of the old pane tree (pid + start time, so pid reuse never matches) before the
 * restart and checks it after. It only REPORTS: nothing here sends a signal.
 *
 * @module pane-survivors
 */
import { readdirSync } from 'node:fs';
import { collectDescendants } from './proc-tree.js';
import { readProcStat, type ProcStat } from './signal-target.js';

export interface TreeProcess {
  pid: number;
  startTime: number;
}

export interface ProcAccess {
  /** Every pid in the process table right now. */
  pids: () => number[];
  stat: (pid: number) => ProcStat | null;
}

export const realProcAccess: ProcAccess = {
  pids: () => {
    try {
      return readdirSync('/proc')
        .filter((n) => /^\d+$/.test(n))
        .map(Number);
    } catch {
      return [];
    }
  },
  stat: readProcStat,
};

/** The pane process and its descendants, from one /proc scan. Empty when the root is gone or unreadable. */
export function snapshotPaneTree(rootPid: number | null | undefined, proc: ProcAccess = realProcAccess): TreeProcess[] {
  if (typeof rootPid !== 'number' || !Number.isInteger(rootPid) || rootPid <= 1) return [];
  const rootStat = proc.stat(rootPid);
  if (!rootStat) return [];
  const stats = new Map<number, ProcStat>();
  const byParent = new Map<number, number[]>();
  for (const pid of proc.pids()) {
    const st = proc.stat(pid);
    if (!st) continue;
    stats.set(pid, st);
    const list = byParent.get(st.ppid);
    if (list) list.push(pid);
    else byParent.set(st.ppid, [pid]);
  }
  const tree: TreeProcess[] = [{ pid: rootPid, startTime: rootStat.startTime }];
  for (const pid of collectDescendants(rootPid, byParent)) {
    const st = stats.get(pid);
    if (st) tree.push({ pid, startTime: st.startTime });
  }
  return tree;
}

/** The snapshot processes that still exist as the SAME process (same pid and start time). */
export function survivors(tree: readonly TreeProcess[], proc: ProcAccess = realProcAccess): TreeProcess[] {
  return tree.filter((p) => proc.stat(p.pid)?.startTime === p.startTime);
}
