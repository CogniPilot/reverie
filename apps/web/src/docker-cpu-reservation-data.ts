/** CPUs kept free of every employee laptop for the owner's own system.
 *
 * The default is derived from the host CPU topology: the first physical core,
 * i.e. CPU 0 and its SMT siblings (on a 16-core, 32-thread host "0,16").
 * Laptops may use every other CPU of the approved pool CPU set and have no
 * quota. These values are DATA: the reservation reaches a laptop only through
 * the employee resource policy of a NEW laptop operation, whose digest the
 * owner approves and whose container cpuset the Engine readback confirms. */
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { DockerEmployeeContinuationError } from './docker-employee-continuation.js';
import type { DockerEmployeeResourcePolicy } from './docker-employee-continuation-data.js';

const uuid = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase());
const digest = z.string().regex(/^[a-f0-9]{64}$/);
/** Sorted, unique logical CPU numbers, as in the employee resource policy. */
export const DockerCpuList = z
  .array(z.number().int().nonnegative().max(4095))
  .max(256)
  .refine((values) => values.every((value, index) => index === 0 || values[index - 1]! < value));
export type DockerCpuList = z.infer<typeof DockerCpuList>;

export const DockerCpuReservationApproval = z
  .object({
    version: z.literal(1),
    purpose: z.literal('reverie-boxed-cpu-reservation-v1'),
    revision: uuid,
    owner: z.string().min(1).max(200).nullable(),
    boxId: digest,
    scope: z.literal('all-employees'),
    /** CPUs no laptop may run on. Empty means the owner reserves none. */
    reservedCpus: DockerCpuList,
    /** Host CPUs online when the owner decided, for the record. */
    onlineCpus: DockerCpuList.refine((values) => values.length > 0),
  })
  .strict()
  .refine(
    (value) =>
      value.reservedCpus.every((cpu) => value.onlineCpus.includes(cpu)) &&
      value.onlineCpus.some((cpu) => !value.reservedCpus.includes(cpu))
  );
export type DockerCpuReservationApproval = z.infer<typeof DockerCpuReservationApproval>;

/** What the kernel says about the host CPUs. */
export interface DockerCpuTopology {
  /** `/sys/devices/system/cpu/online`. */
  readonly online: DockerCpuList;
  /** CPU 0 and its SMT siblings: `cpu0/topology/thread_siblings_list`. */
  readonly firstCore: DockerCpuList;
}

function refuse(code: string): never {
  throw new DockerEmployeeContinuationError(code);
}

/** Parse a kernel CPU list such as "0-15,17,20-31" (trailing newline allowed). */
export function parseKernelCpuList(raw: string): DockerCpuList {
  const text = raw.trim();
  if (!text || text.length > 4096) refuse('DOCKER_CPU_TOPOLOGY_UNKNOWN');
  const result: number[] = [];
  for (const segment of text.split(',')) {
    const match = /^(0|[1-9][0-9]{0,3})(?:-(0|[1-9][0-9]{0,3}))?$/.exec(segment);
    if (!match) refuse('DOCKER_CPU_TOPOLOGY_UNKNOWN');
    const first = Number(match[1]),
      last = Number(match[2] ?? match[1]);
    if (last < first || last > 4095 || (result.length && first <= result[result.length - 1]!))
      refuse('DOCKER_CPU_TOPOLOGY_UNKNOWN');
    for (let cpu = first; cpu <= last; cpu++) result.push(cpu);
  }
  return DockerCpuList.parse(result);
}

/** The kernel's compact form of a CPU list, e.g. [0,1,2,16] gives "0-2,16". */
export function formatKernelCpuList(values: readonly number[]): string {
  const ranges: string[] = [];
  for (let index = 0; index < values.length; index++) {
    const first = values[index]!;
    let last = first;
    while (index + 1 < values.length && values[index + 1] === last + 1) last = values[++index]!;
    ranges.push(first === last ? String(first) : `${first}-${last}`);
  }
  return ranges.join(',');
}

function sorted(values: Iterable<number>): DockerCpuList {
  return [...new Set(values)].sort((a, b) => a - b);
}

/** Default reservation: the first physical core, while that leaves CPUs for
 * the laptops. A host whose only core is the first one reserves nothing. */
export function dockerCpuReservationDefault(topology: DockerCpuTopology): DockerCpuList {
  const reserved = topology.firstCore.filter((cpu) => topology.online.includes(cpu));
  return topology.online.some((cpu) => !reserved.includes(cpu)) ? reserved : [];
}

/** The reservation in force and every CPU a reservation ever held back. */
export interface DockerCpuReservationInForce {
  readonly reservedCpus: DockerCpuList;
  readonly source: 'owner' | 'default';
  /** Union of the topology default and every decision on record. Only these
   * CPUs can be given back to a laptop when a reservation shrinks. */
  readonly everReserved: DockerCpuList;
}

/** Laptop CPU set under a reservation. A laptop that may use the whole pool
 * CPU set (apart from CPUs only a reservation ever held back) gets the whole
 * pool CPU set minus the reservation, so shrinking a reservation gives CPUs
 * back. A laptop the owner deliberately limited to fewer CPUs keeps its own
 * set minus the reservation. The pool CPU set is never changed: it is the one
 * live pool cgroup every laptop of the box shares. Idempotent. */
export function dockerCpuReservedPolicy(
  policy: DockerEmployeeResourcePolicy,
  reservation: Pick<DockerCpuReservationInForce, 'reservedCpus' | 'everReserved'>
): DockerEmployeeResourcePolicy {
  const pool = policy.pool.allowedCpus,
    restorable = reservation.everReserved.filter((cpu) => pool.includes(cpu)),
    poolWide = pool.every((cpu) => policy.allowedCpus.includes(cpu) || restorable.includes(cpu)),
    base = poolWide ? pool : policy.allowedCpus,
    allowedCpus = base.filter((cpu) => !reservation.reservedCpus.includes(cpu));
  if (!allowedCpus.length) refuse('DOCKER_CPU_RESERVATION_LEAVES_NO_CPU');
  return { ...structuredClone(policy), allowedCpus: sorted(allowedCpus) };
}

/** Owner input checks that need the live topology. */
export function dockerCpuReservationRefusal(
  reservedCpus: readonly number[],
  topology: DockerCpuTopology
): string | undefined {
  if (reservedCpus.some((cpu) => !topology.online.includes(cpu))) return 'DOCKER_CPU_RESERVATION_CPU_OFFLINE';
  if (!topology.online.some((cpu) => !reservedCpus.includes(cpu))) return 'DOCKER_CPU_RESERVATION_LEAVES_NO_CPU';
  return undefined;
}

/** A laptop operation that replaces an existing one (a plan move) may differ
 * from it only in the owner-approved soft memory limit and the laptop CPU set,
 * which always stays inside the unchanged shared pool CPU set. Every other
 * limit and the whole pool policy must be identical. */
export function dockerReplacementKeepsLimits(
  next: DockerEmployeeResourcePolicy,
  source: DockerEmployeeResourcePolicy
): boolean {
  return (
    isDeepStrictEqual(next, { ...source, memoryHighBytes: next.memoryHighBytes, allowedCpus: next.allowedCpus }) &&
    next.allowedCpus.every((cpu) => source.pool.allowedCpus.includes(cpu))
  );
}
