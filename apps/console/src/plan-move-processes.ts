import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';
import { collectDescendants } from './proc-tree.js';

export interface ProcessIdentity {
  pid: number;
  start: string;
}
const execute = promisify(execFile);

export function processIdentity(pid: number, stat: string): ProcessIdentity | undefined {
  const fields = stat
    .slice(stat.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/);
  if (fields.length < 20 || !/^\d+$/.test(fields[19])) throw new Error('Unrecognized process stat record');
  return fields[0] === 'Z' || fields[0] === 'X' ? undefined : { pid, start: fields[19] };
}

async function identity(pid: number): Promise<ProcessIdentity | undefined> {
  try {
    return processIdentity(pid, await fs.readFile(`/proc/${pid}/stat`, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ESRCH')
      return undefined;
    throw error;
  }
}

export async function capturePlanProcesses(roots: number[]): Promise<ProcessIdentity[]> {
  if (!roots.length || roots.some((pid) => !Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid))
    throw new Error('Cannot verify the source process roots');
  const { stdout } = await execute('ps', ['-eo', 'pid=,ppid='], { timeout: 3000, maxBuffer: 2 * 1024 * 1024 });
  const parents = new Map<number, number[]>();
  for (const line of stdout.trim().split('\n')) {
    const [pid, parent] = line.trim().split(/\s+/).map(Number);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parent)) throw new Error('Invalid process tree snapshot');
    const children = parents.get(parent) ?? [];
    children.push(pid);
    parents.set(parent, children);
  }
  const pids = new Set<number>();
  for (const root of roots) {
    pids.add(root);
    for (const pid of collectDescendants(root, parents, {
      onTruncated: () => {
        throw new Error('Source process tree exceeds its safety bound');
      },
    }))
      pids.add(pid);
  }
  if (pids.has(process.pid) || pids.size > 500) throw new Error('Unsafe source process tree');
  const result: ProcessIdentity[] = [];
  for (const pid of pids) {
    const current = await identity(pid);
    if (current) result.push(current);
  }
  if (!result.length) throw new Error('Source process is already gone');
  return result;
}

export async function survivingPlanProcesses(identities: ProcessIdentity[], timeoutMs = 5000): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let remaining = identities;
  do {
    const alive: ProcessIdentity[] = [];
    for (const known of remaining) {
      const current = await identity(known.pid);
      if (current?.start === known.start) alive.push(known);
    }
    remaining = alive;
    if (!remaining.length || Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (remaining.length > 0 && Date.now() < deadline);
  return remaining.map((known) => known.pid);
}
