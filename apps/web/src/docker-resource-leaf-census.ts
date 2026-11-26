/** Denial-only parsing of fixed terminal leaf-writer configuration DATA.
 * These values confer no native ACK, write permission or current-worker proof.
 */
import { DockerEmployeeContinuationError } from './docker-employee-continuation.js';

const fields = [
  '--box-id',
  '--anchor-id',
  '--anchor-pid',
  '--anchor-start',
  '--worker-id',
  '--worker-pid',
  '--worker-start',
  '--leaf-dev',
  '--leaf-ino',
  '--memory-max',
  '--swap-max',
  '--pids-max',
  '--memory-high',
  '--cpu-weight',
] as const;
const cid = /^[a-f0-9]{64}$/;
function refuse(): never {
  throw new DockerEmployeeContinuationError('DOCKER_RESOURCE_LEAF_WRITER_UNCONFIRMED');
}
function unsigned(value: string | undefined, positive = false): bigint {
  if (!value || !/^(0|[1-9][0-9]{0,19})$/.test(value)) refuse();
  const parsed = BigInt(value);
  if (parsed > 18446744073709551615n || (positive && parsed === 0n)) refuse();
  return parsed;
}
export function parseDockerLeafWriterArguments(args: readonly string[], boxId: string) {
  const mode = args[0];
  // `restore-high` takes exactly the arguments of `configure-high`.
  if (
    !['configure-high', 'restore-high', 'configure-memory-high'].includes(mode ?? '') ||
    args.length > 512 ||
    args.length % 2 !== 1
  )
    refuse();
  const values = new Map<string, string>(),
    scopeArguments = [mode!],
    members: string[][] = [];
  for (let index = 1; index < args.length; index += 2) {
    const key = args[index]!,
      value = args[index + 1]!;
    if (key === '--member') {
      const member = value.split(':');
      if (member.length !== 3 || !cid.test(member[0]!) || unsigned(member[1], true) > 2147483647n) refuse();
      unsigned(member[2], true);
      members.push(member);
      continue;
    }
    if (
      (!fields.includes(key as (typeof fields)[number]) &&
        !(mode === 'configure-memory-high' && key === '--cpuset-cpus')) ||
      values.has(key)
    )
      refuse();
    values.set(key, value);
    scopeArguments.push(key, value);
  }
  if (fields.some((field) => !values.has(field)) || values.get('--box-id') !== boxId || members.length > 64) refuse();
  const anchor = values.get('--anchor-id')!,
    worker = values.get('--worker-id')!;
  if (!cid.test(anchor) || !cid.test(worker) || anchor === worker) refuse();
  const anchorPid = unsigned(values.get('--anchor-pid'), true),
    workerPid = unsigned(values.get('--worker-pid'), true);
  if (anchorPid > 2147483647n || workerPid > 2147483647n || anchorPid === workerPid) refuse();
  for (const key of ['--anchor-start', '--worker-start', '--memory-max', '--pids-max', '--memory-high'])
    unsigned(values.get(key), true);
  for (const key of ['--leaf-dev', '--leaf-ino', '--swap-max']) unsigned(values.get(key));
  const weight = unsigned(values.get('--cpu-weight'), true);
  if (weight > 10000n) refuse();
  const ids = [anchor, worker, ...members.map((member) => member[0]!)];
  const pids = [anchorPid.toString(), workerPid.toString(), ...members.map((member) => member[1]!)];
  if (new Set(ids).size !== ids.length || new Set(pids).size !== pids.length) refuse();
  const cpus = values.get('--cpuset-cpus');
  if (mode === 'configure-memory-high' && !cpus) refuse();
  return { mode, workerId: worker, cpus, scopeArguments };
}
