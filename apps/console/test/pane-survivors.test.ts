/**
 * pane-survivors: the old pane tree is the pane process and its descendants (pid + start time) from one scan, and a
 * survivor is a process with the SAME pid and start time afterwards. A reused pid is not a survivor.
 */
import { describe, expect, it } from 'vitest';
import { snapshotPaneTree, survivors, type ProcAccess } from '../src/pane-survivors.js';
import type { ProcStat } from '../src/signal-target.js';

function proc(table: Record<number, [ppid: number, startTime: number]>): ProcAccess {
  return {
    pids: () => Object.keys(table).map(Number),
    stat: (pid: number): ProcStat | null => (table[pid] ? { ppid: table[pid][0], pgid: pid, startTime: table[pid][1] } : null),
  };
}

describe('pane-survivors', () => {
  const before = proc({ 1: [0, 1], 50: [1, 2], 100: [50, 10], 101: [100, 11], 102: [101, 12], 300: [1, 13] });

  it('snapshots the pane process and its whole subtree, nothing else', () => {
    expect(snapshotPaneTree(100, before)).toEqual([
      { pid: 100, startTime: 10 },
      { pid: 101, startTime: 11 },
      { pid: 102, startTime: 12 },
    ]);
  });

  it('a gone, missing or invalid root gives an empty snapshot', () => {
    for (const pid of [999, null, undefined, 0, 1, -5, 1.5]) expect(snapshotPaneTree(pid as never, before)).toEqual([]);
  });

  it('a survivor is the same pid with the same start time; a reused pid is not', () => {
    const tree = snapshotPaneTree(100, before);
    // 100 gone, 101 reparented to init but the same process, 102's pid reused by a new process.
    const after = proc({ 1: [0, 1], 101: [1, 11], 102: [1, 99] });
    expect(survivors(tree, after)).toEqual([{ pid: 101, startTime: 11 }]);
    expect(survivors(tree, proc({}))).toEqual([]);
  });
});
