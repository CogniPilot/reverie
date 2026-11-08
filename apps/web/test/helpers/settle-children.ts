/**
 * @fileoverview Waiting for this process's spawned children before deleting what they may still write into.
 *
 * A test file's teardown removes its per-file temp directory. A child a test spawned (a language server being killed,
 * a git or node helper) can still be writing into it at that moment, and a recursive removal racing a writer fails with
 * ENOTEMPTY after every test has passed. Waiting for the children to exit first removes the race at its source.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';

/** The live (not yet exited) child processes of `pid`. Linux reads /proc; elsewhere `pgrep -P`. */
export function liveChildren(pid: number = process.pid): number[] {
  if (process.platform === 'linux') {
    const children: number[] = [];
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
      if (Number(parent) === pid && state !== 'Z') children.push(Number(entry));
    }
    return children;
  }
  try {
    return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map(Number);
  } catch {
    return []; // pgrep exits 1 when there are none
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
