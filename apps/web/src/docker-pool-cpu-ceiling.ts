/** Owner decision and read-only status for the employee group CPU ceiling.
 * Approving records the owner's value. It issues no helper and changes no
 * kernel limit; the status reports what a fresh pool observation shows. */
import type { CompanyService } from './company-service.js';
import { DockerEmployeeContinuationError, dockerContinuationDigest } from './docker-employee-continuation.js';
import {
  DockerPoolCpuCeilingApproval,
  dockerPoolCpuCeilingDefault,
  dockerPoolCpuCeilingObserved,
  dockerPoolCpuCeilingState,
  dockerPoolCpuMax,
  type DockerPoolCpuCeilingState,
} from './docker-pool-cpu-ceiling-data.js';
import type { DockerPoolCpuCeilingStore } from './docker-pool-cpu-ceiling-store.js';

export interface DockerPoolCpuObserver {
  /** Fresh native pool observation. Read-only. */
  observePoolCpu(current: () => void): Promise<{ cpuMax: string; cpus: number }>;
}
export interface DockerPoolCpuCeilingStatus {
  readonly boxId: string;
  readonly scope: 'all-employees';
  readonly approved: { revision: string; cpuCores: number | null; cpuMax: string } | null;
  /** Suggested value for the approved pool CPU set. Never applied by itself. */
  readonly proposed: { cpuCores: number; poolCpus: number } | null;
  /** What a fresh pool observation shows: the kernel value and the CPUs the pool runs on. */
  readonly effective: { cpuMax: string; cpuCores: number | null; poolCpus: number } | null;
  readonly state: DockerPoolCpuCeilingState;
  readonly code?: string;
  readonly enforcement: 'observed' | 'not-observed';
  readonly allowedActions: readonly 'approve'[];
}
function refuse(code: string): never {
  throw new DockerEmployeeContinuationError(code);
}
function approvedView(value: DockerPoolCpuCeilingApproval | undefined) {
  return value
    ? { revision: value.revision, cpuCores: value.cpuCores, cpuMax: dockerPoolCpuMax(value.cpuCores) }
    : null;
}
export class DockerPoolCpuCeiling {
  constructor(
    private readonly company: Pick<CompanyService, 'store'>,
    private readonly store: DockerPoolCpuCeilingStore,
    private readonly resources: DockerPoolCpuObserver,
    private readonly boxId: string,
    private readonly runtimeCurrent: () => void
  ) {}

  /** CPUs in the one pool CPU set the owner approved for the employees.
   * Undefined before any resource policy is approved. */
  #poolCpus(): number | undefined {
    const pools = this.company.store
      .snapshot()
      .employees.flatMap((employee) => (employee.dockerResourcePolicy ? [employee.dockerResourcePolicy.pool] : []));
    if (!pools.length) return undefined;
    const first = dockerContinuationDigest(pools[0]);
    if (pools.some((pool) => dockerContinuationDigest(pool) !== first))
      refuse('DOCKER_POOL_CPU_CEILING_POOL_POLICY_CHANGED');
    return pools[0]!.allowedCpus.length;
  }

  async status(authority: () => void): Promise<DockerPoolCpuCeilingStatus> {
    const current = () => {
      this.runtimeCurrent();
      authority();
    };
    current();
    const approved = this.store.approved(),
      earlier = this.store.recentCpuMax();
    let poolCpus: number | undefined, code: string | undefined;
    try {
      poolCpus = this.#poolCpus();
    } catch (cause) {
      if (!(cause instanceof DockerEmployeeContinuationError)) throw cause;
      code = cause.code;
    }
    let effective: DockerPoolCpuCeilingStatus['effective'] = null;
    try {
      const seen = await this.resources.observePoolCpu(current);
      effective = { ...dockerPoolCpuCeilingObserved(seen.cpuMax), poolCpus: seen.cpus };
    } catch (cause) {
      // Revoked authority is never reported as a failed native read.
      current();
      code ??=
        cause instanceof DockerEmployeeContinuationError ? cause.code : 'DOCKER_POOL_CPU_OBSERVATION_UNCONFIRMED';
    }
    current();
    return {
      boxId: this.boxId,
      scope: 'all-employees',
      approved: approvedView(approved),
      proposed: poolCpus === undefined ? null : { cpuCores: dockerPoolCpuCeilingDefault(poolCpus), poolCpus },
      effective,
      state: dockerPoolCpuCeilingState(approved, earlier, effective?.cpuMax),
      ...(code ? { code } : {}),
      enforcement: effective ? 'observed' : 'not-observed',
      allowedActions: poolCpus === undefined ? [] : ['approve'],
    };
  }

  /** Durable owner decision. The caller has already proven a human owner. */
  async approve(
    input: { revision: string; expectedRevision: string | null; cpuCores: number | null },
    owner: string | undefined,
    authority: () => void
  ) {
    const current = () => {
      this.runtimeCurrent();
      authority();
    };
    current();
    const poolCpus = this.#poolCpus();
    if (poolCpus === undefined) refuse('DOCKER_POOL_CPU_CEILING_POOL_POLICY_REQUIRED');
    if (input.cpuCores !== null && input.cpuCores > poolCpus) refuse('DOCKER_POOL_CPU_CEILING_EXCEEDS_POOL');
    const saved = await this.store.approve(
      DockerPoolCpuCeilingApproval.parse({
        version: 1,
        purpose: 'reverie-boxed-pool-cpu-ceiling-v1',
        revision: input.revision,
        owner: owner ?? null,
        boxId: this.boxId,
        scope: 'all-employees',
        cpuCores: input.cpuCores,
        poolCpus,
      }),
      input.expectedRevision,
      current
    );
    current();
    return { approved: approvedView(saved)!, state: 'approval-saved' as const, enforcement: 'not-observed' as const };
  }
}
