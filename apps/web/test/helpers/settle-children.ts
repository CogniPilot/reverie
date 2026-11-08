/**
 * @fileoverview Waiting for this process's spawned children before deleting what they may still write into.
 *
 * A test file's teardown removes its per-file temp directory. A child a test spawned (a language server being killed,
 * a git or node helper) can still be writing into it at that moment, and a recursive removal racing a writer fails with
 * ENOTEMPTY after every test has passed. Waiting for the children to exit first removes the race at its source. A
 * child still running after the bound is stopped, with its own children, and the directories are removed only once
 * they are gone; one that cannot be stopped keeps the directories and fails the teardown by name.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, rmSync } from 'node:fs';

/** Thrown when a child outlives the bound and cannot be stopped: the directories it may write into are kept. */
export class TeardownLifecycleError extends Error {}

/** Linux: every process's parent and state, from /proc. */
function processTable(): Map<number, { parent: number; state: string }> {
  const table = new Map<number, { parent: number; state: string }>();
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    let stat: string;
    try {
      stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
    } catch {
      continue; // exited while being listed
    }
    // Fields after the parenthesised command name: state, then the parent pid.
    const [state, parent] = stat.slice(stat.lastIndexOf(') ') + 2).split(' ');
    table.set(Number(entry), { parent: Number(parent), state });
  }
  return table;
}

function pgrepChildren(pid: number): number[] {
  try {
    return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map(Number);
  } catch {
    return []; // pgrep exits 1 when there are none
  }
}

/** The live (not yet exited) child processes of `pid`. Linux reads /proc; elsewhere `pgrep -P`. */
export function liveChildren(pid: number = process.pid): number[] {
  if (process.platform !== 'linux') return pgrepChildren(pid);
  return [...processTable()].filter(([, proc]) => proc.parent === pid && proc.state !== 'Z').map(([child]) => child);
}

/** The live descendants of each of `pids`, deepest last. */
function liveDescendants(pids: number[]): number[] {
  const table = process.platform === 'linux' ? processTable() : undefined;
  const childrenOf = (pid: number) =>
    table
      ? [...table].filter(([, proc]) => proc.parent === pid && proc.state !== 'Z').map(([child]) => child)
      : pgrepChildren(pid);
  const found: number[] = [];
  for (let queue = pids.flatMap(childrenOf); queue.length > 0; queue = queue.flatMap(childrenOf)) found.push(...queue);
  return found;
}

function isLive(pid: number): boolean {
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      return stat[stat.lastIndexOf(') ') + 2] !== 'Z';
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Waits until `pid` has no live children, or `timeoutMs` passes. Returns the children still alive then. */
export async function childrenSettled(timeoutMs = 5000, pid: number = process.pid): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let left = liveChildren(pid);
  while (left.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    left = liveChildren(pid);
  }
  return left;
}

export interface TempTeardownOptions {
  /** How long to wait for children to exit on their own. */
  waitMs?: number;
  /** How long to wait for stopped children to be gone. */
  stopWaitMs?: number;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  warn?: (message: string) => void;
}

/**
 * Removal of a test file's temp directories that never deletes under a known live writer.
 *
 * `finish` (the afterAll) waits for this process's children, stops any still running after the bound, and removes the
 * paths once none is live; otherwise it keeps them and throws TeardownLifecycleError naming the children. `backstop`
 * (the exit hook, for a file whose afterAll never ran) removes them only if `finish` did not keep them and no child is
 * live at exit.
 */
export function tempTeardown(paths: string[], options: TempTeardownOptions = {}) {
  const { waitMs = 5000, stopWaitMs = 2000, kill = process.kill.bind(process), warn = console.warn } = options;
  let kept = false;
  const remove = () => {
    for (const path of paths) rmSync(path, { recursive: true, force: true });
  };
  const keep = (live: number[]) => {
    kept = true;
    return `child processes ${live.join(', ')} still running; keeping ${paths.join(' and ')} rather than delete under them`;
  };

  return {
    async finish(): Promise<void> {
      const left = await childrenSettled(waitMs);
      if (left.length > 0) {
        const stopping = [...liveDescendants(left), ...left];
        for (const pid of stopping) {
          try {
            kill(pid, 'SIGKILL');
          } catch {
            // already gone
          }
        }
        warn(`[test setup] stopped child processes still running at teardown: ${stopping.join(', ')}`);
        const deadline = Date.now() + stopWaitMs;
        let live = stopping.filter(isLive);
        while (live.length > 0 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          live = stopping.filter(isLive);
        }
        live = [...new Set([...live, ...liveChildren()])];
        if (live.length > 0) throw new TeardownLifecycleError(`[test setup] ${keep(live)}`);
      }
      remove();
    },

    backstop(): void {
      if (kept) return;
      const live = liveChildren();
      if (live.length > 0) {
        warn(`[test setup] at exit: ${keep(live)}`);
        return;
      }
      remove();
    },
  };
}
