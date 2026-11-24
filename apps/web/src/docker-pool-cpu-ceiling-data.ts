/** Owner-approved CPU ceiling for every employee of one Docker box together.
 * These values are DATA. They grant no kernel write, launch or resource
 * credit: the fixed Rust helper performs the write and a fresh native
 * observation reports what is enforced. */
import { z } from 'zod';

const uuid = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase());
const digest = z.string().regex(/^[a-f0-9]{64}$/);
/** The bandwidth period the Rust helper always writes, in microseconds. */
const DOCKER_POOL_CPU_PERIOD_MICROS = 100_000;
/** Whole CPUs, the unit the fixed helper accepts. */
export const DockerPoolCpuCores = z.number().int().min(1).max(4096);
export const DockerPoolCpuCeilingApproval = z
  .object({
    version: z.literal(1),
    purpose: z.literal('reverie-boxed-pool-cpu-ceiling-v1'),
    revision: uuid,
    owner: z.string().min(1).max(200).nullable(),
    boxId: digest,
    scope: z.literal('all-employees'),
    /** CPUs all employees may use together. Null removes the ceiling. */
    cpuCores: DockerPoolCpuCores.nullable(),
    /** CPUs in the approved pool CPU set when the owner decided. */
    poolCpus: DockerPoolCpuCores,
  })
  .strict()
  .refine((value) => value.cpuCores === null || value.cpuCores <= value.poolCpus);
export type DockerPoolCpuCeilingApproval = z.infer<typeof DockerPoolCpuCeilingApproval>;

/** The exact kernel cpu.max value for a ceiling. */
export function dockerPoolCpuMax(cpuCores: number | null): string {
  if (cpuCores === null) return 'max ' + DOCKER_POOL_CPU_PERIOD_MICROS;
  return DockerPoolCpuCores.parse(cpuCores) * DOCKER_POOL_CPU_PERIOD_MICROS + ' ' + DOCKER_POOL_CPU_PERIOD_MICROS;
}

/** Suggested ceiling for a pool of this many CPUs: three quarters of them,
 * always leaving at least four for the office and the owner's desktop, and
 * never less than one. A suggestion is not an approval. */
export function dockerPoolCpuCeilingDefault(poolCpus: number): number {
  const cpus = DockerPoolCpuCores.parse(poolCpus);
  return Math.max(1, Math.min(Math.floor((cpus * 3) / 4), cpus - 4));
}

/** What a kernel cpu.max value means in CPUs. Null is "no ceiling". */
export function dockerPoolCpuCeilingObserved(cpuMax: string): { cpuMax: string; cpuCores: number | null } {
  const match = /^(max|[1-9][0-9]{0,15}) ([1-9][0-9]{0,8})$/.exec(cpuMax);
  if (!match) throw Error('Kernel cpu.max value required');
  return { cpuMax, cpuCores: match[1] === 'max' ? null : Number(match[1]) / Number(match[2]) };
}

export type DockerPoolCpuCeilingState =
  /** No ceiling approved and none enforced. */
  | 'unapproved'
  /** The approved ceiling is what the kernel enforces. */
  | 'applied'
  /** A ceiling is approved; the kernel still shows none or an earlier approved one. */
  | 'pending'
  /** The kernel enforces a ceiling the owner never approved. */
  | 'drifted'
  /** The pool could not be observed. Nothing is known about enforcement. */
  | 'unobserved';

/** Pure classification of a fresh observation against the owner's approvals. */
export function dockerPoolCpuCeilingState(
  approved: DockerPoolCpuCeilingApproval | undefined,
  earlier: readonly string[],
  effective: string | undefined
): DockerPoolCpuCeilingState {
  if (effective === undefined) return 'unobserved';
  const unlimited = dockerPoolCpuMax(null);
  if (!approved) return effective === unlimited ? 'unapproved' : 'drifted';
  if (effective === dockerPoolCpuMax(approved.cpuCores)) return 'applied';
  return effective === unlimited || earlier.includes(effective) ? 'pending' : 'drifted';
}
