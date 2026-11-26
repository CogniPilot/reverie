/** Owner decision and read-only status for the CPUs kept free of every
 * employee laptop. The reservation is applied to the resource policy of each
 * NEW laptop operation (a new employee, a rebuilt laptop, a plan move): the
 * owner sees the resulting policy digest before continuing, and the Engine
 * readback confirms the container cpuset. A laptop operation already on
 * record keeps the CPU set its owner approved. Nothing here writes a cgroup. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CompanyService } from './company-service.js';
import type { CompanyState } from './company-types.js';
import { DockerEmployeeContinuationError } from './docker-employee-continuation.js';
import type { DockerEmployeeResourcePolicy } from './docker-employee-continuation-data.js';
import {
  DockerCpuReservationApproval,
  dockerCpuReservationDefault,
  dockerCpuReservationRefusal,
  dockerCpuReservedPolicy,
  parseKernelCpuList,
  type DockerCpuList,
  type DockerCpuReservationInForce,
  type DockerCpuTopology,
} from './docker-cpu-reservation-data.js';
import { DockerOwnerDecisionJournal } from './docker-owner-decision-journal.js';

/** Fresh read of the host CPU topology the office container sees. */
export function readHostCpuTopology(root = '/sys/devices/system/cpu'): DockerCpuTopology {
  const read = (path: string) => readFileSync(join(root, path), { encoding: 'utf8', flag: 'r' }).slice(0, 4097);
  return {
    online: parseKernelCpuList(read('online')),
    firstCore: parseKernelCpuList(read('cpu0/topology/thread_siblings_list')),
  };
}

export type DockerCpuReservationEmployeeState =
  /** The laptop on record already runs on the CPU set a new operation would get. */
  | 'applied'
  /** No laptop operation is on record; the next start takes the new CPU set. */
  | 'next-start'
  /** The laptop on record keeps its approved CPU set until it is rebuilt. */
  | 'rebuild-required'
  /** The reservation cannot be applied to this employee's policy (`code`). */
  | 'refused';

export interface DockerCpuReservationEmployee {
  readonly employeeId: string;
  readonly name: string;
  /** CPU set of the laptop operation on record, or null when there is none. */
  readonly operationCpus: DockerCpuList | null;
  /** CPU set a new laptop operation of this employee would get. */
  readonly nextCpus: DockerCpuList | null;
  readonly state: DockerCpuReservationEmployeeState;
  readonly code?: string;
}

export interface DockerCpuReservationStatus {
  readonly boxId: string;
  readonly scope: 'all-employees';
  readonly topology: { onlineCpus: DockerCpuList; firstCoreCpus: DockerCpuList } | null;
  /** Derived from the topology: the first physical core. Applies until the owner decides. */
  readonly defaultReservedCpus: DockerCpuList;
  readonly approved: { revision: string; reservedCpus: DockerCpuList } | null;
  /** What new laptop operations get now. */
  readonly reservedCpus: DockerCpuList;
  readonly source: 'owner' | 'default';
  /** The shared pool CPU set from the approved employee policies (never changed here). */
  readonly poolCpus: DockerCpuList | null;
  readonly employees: readonly DockerCpuReservationEmployee[];
  readonly code?: string;
  readonly allowedActions: readonly 'approve'[];
}

function refuse(code: string): never {
  throw new DockerEmployeeContinuationError(code);
}
function sameCpus(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((cpu, index) => right[index] === cpu);
}
function codeOf(cause: unknown): string {
  if (cause instanceof DockerEmployeeContinuationError) return cause.code;
  throw cause;
}

export class DockerCpuReservation {
  readonly #journal: DockerOwnerDecisionJournal<DockerCpuReservationApproval>;
  constructor(
    private readonly company: Pick<CompanyService, 'store'>,
    path: string,
    private readonly boxId: string,
    private readonly runtimeCurrent: () => void,
    private readonly topology: () => DockerCpuTopology = readHostCpuTopology
  ) {
    this.#journal = new DockerOwnerDecisionJournal(path, boxId, DockerCpuReservationApproval, 'DOCKER_CPU_RESERVATION');
  }

  #topology(): DockerCpuTopology | undefined {
    try {
      return this.topology();
    } catch {
      return undefined;
    }
  }

  /** The reservation in force. An unreadable journal refuses; it never
   * silently falls back to the default. */
  inForce(): DockerCpuReservationInForce {
    const entries = this.#journal.entries(),
      topology = this.#topology(),
      fallback = topology ? dockerCpuReservationDefault(topology) : [],
      approved = entries.at(-1),
      everReserved = [...new Set([...fallback, ...entries.flatMap((entry) => entry.reservedCpus)])].sort(
        (a, b) => a - b
      );
    return approved
      ? { reservedCpus: approved.reservedCpus, source: 'owner', everReserved }
      : { reservedCpus: fallback, source: 'default', everReserved };
  }

  /** Default-policy hook for NEW laptop operations. */
  policy(policy: DockerEmployeeResourcePolicy): DockerEmployeeResourcePolicy {
    return dockerCpuReservedPolicy(policy, this.inForce());
  }

  #employees(state: CompanyState, reservation: DockerCpuReservationInForce): DockerCpuReservationEmployee[] {
    return state.employees.flatMap((employee): DockerCpuReservationEmployee[] => {
      if (!employee.dockerResourcePolicy) return [];
      const record = state.dockerEmployeeContinuations?.find((row) => row.employeeId === employee.id),
        operationCpus = record ? [...record.policy.allowedCpus] : null,
        base = { employeeId: employee.id, name: employee.name, operationCpus };
      try {
        const nextCpus = dockerCpuReservedPolicy(employee.dockerResourcePolicy, reservation).allowedCpus;
        const state: DockerCpuReservationEmployeeState = !operationCpus
          ? 'next-start'
          : sameCpus(operationCpus, nextCpus)
            ? 'applied'
            : 'rebuild-required';
        return [{ ...base, nextCpus, state }];
      } catch (cause) {
        return [{ ...base, nextCpus: null, state: 'refused', code: codeOf(cause) }];
      }
    });
  }

  #poolCpus(state: CompanyState): DockerCpuList | null {
    const pools = state.employees.flatMap((employee) =>
      employee.dockerResourcePolicy ? [employee.dockerResourcePolicy.pool.allowedCpus] : []
    );
    if (!pools.length) return null;
    if (pools.some((pool) => !sameCpus(pool, pools[0]!))) refuse('DOCKER_CPU_RESERVATION_POOL_POLICY_CHANGED');
    return [...pools[0]!];
  }

  #current(authority: () => void): () => void {
    return () => {
      this.runtimeCurrent();
      authority();
    };
  }

  status(authority: () => void): DockerCpuReservationStatus {
    const current = this.#current(authority);
    current();
    const topology = this.#topology(),
      approved = this.#journal.approved(),
      reservation = this.inForce(),
      state = this.company.store.snapshot();
    let poolCpus: DockerCpuList | null = null,
      code: string | undefined = topology ? undefined : 'DOCKER_CPU_TOPOLOGY_UNKNOWN';
    try {
      poolCpus = this.#poolCpus(state);
    } catch (cause) {
      code ??= codeOf(cause);
    }
    const employees = this.#employees(state, reservation);
    current();
    return {
      boxId: this.boxId,
      scope: 'all-employees',
      topology: topology ? { onlineCpus: [...topology.online], firstCoreCpus: [...topology.firstCore] } : null,
      defaultReservedCpus: topology ? dockerCpuReservationDefault(topology) : [],
      approved: approved ? { revision: approved.revision, reservedCpus: approved.reservedCpus } : null,
      reservedCpus: reservation.reservedCpus,
      source: reservation.source,
      poolCpus,
      employees,
      ...(code ? { code } : {}),
      allowedActions: topology ? ['approve'] : [],
    };
  }

  /** Durable owner decision. The caller has already proven a human owner. */
  async approve(
    input: { revision: string; expectedRevision: string | null; reservedCpus: DockerCpuList },
    owner: string | undefined,
    authority: () => void
  ) {
    const current = this.#current(authority);
    current();
    const topology = this.#topology();
    if (!topology) refuse('DOCKER_CPU_TOPOLOGY_UNKNOWN');
    const refusal = dockerCpuReservationRefusal(input.reservedCpus, topology);
    if (refusal) refuse(refusal);
    const next = DockerCpuReservationApproval.parse({
      version: 1,
      purpose: 'reverie-boxed-cpu-reservation-v1',
      revision: input.revision,
      owner: owner ?? null,
      boxId: this.boxId,
      scope: 'all-employees',
      reservedCpus: input.reservedCpus,
      onlineCpus: topology.online,
    });
    // Every employee must keep at least one CPU under the new decision.
    const everReserved = [...new Set([...this.inForce().everReserved, ...next.reservedCpus])].sort((a, b) => a - b);
    for (const employee of this.company.store.snapshot().employees)
      if (employee.dockerResourcePolicy)
        dockerCpuReservedPolicy(employee.dockerResourcePolicy, { reservedCpus: next.reservedCpus, everReserved });
    const saved = await this.#journal.approve(next, input.expectedRevision, current);
    current();
    return {
      approved: { revision: saved.revision, reservedCpus: saved.reservedCpus },
      state: 'approval-saved' as const,
      appliesTo: 'new-laptop-operations' as const,
    };
  }
}
