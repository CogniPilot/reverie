/**
 * @fileoverview Puts the approved limits of one finished, running laptop back in place, whatever its employee's
 * attendance.
 *
 * A reload of the host's service manager resets the limits that only a helper wrote, on every running laptop. The
 * laptop set-up service (`DockerEmployeeContinuation.repair`) writes them again, but like every step of a set-up it
 * answers `DOCKER_CONTINUATION_OFFICE_CHANGED` for an employee who is out of the office or stopped, before it reads
 * the laptop. That is right for a set-up, whose steps start things. A laptop that keeps running while its employee
 * is away still needs its limits, so this service makes the same repair without asking where the employee is.
 *
 * It is the repair half of that service and nothing else. Before the one effect it proves what the service proves
 * for a published laptop:
 *
 * - the caller's authority, at every step;
 * - the record is finished (`provider-issued` or `ready`), is no plan move's private record, and is still exactly
 *   the record this call started from; the employee, session, generation and launch recipe still match it, and the
 *   owner's approved policy is still the record's policy;
 * - no set-up step, rebuild or other repair of this employee is in flight;
 * - the laptop was built from the image the record names;
 * - its storage is ready and the shared pool shows the record's approved pool limits.
 *
 * The effect is `DockerEmployeeEngine.restoreResources`: the laptop must be running, and the resource controller
 * keeps the repair journal, runs one writer at a time in the office and takes every value from the record's own
 * approved policy. No request field carries a limit. Nothing here attaches a terminal, reads or starts an agent,
 * changes attendance, writes the record or touches the shared pool.
 */
import { isDeepStrictEqual } from 'node:util';
import {
  DockerEmployeeContinuationError,
  dockerContinuationDigest,
  type DockerContinuationAuthority,
  type DockerContinuationEngine,
  type DockerContinuationStore,
} from './docker-employee-continuation.js';
import {
  DockerEmployeePool,
  DockerEmployeeWorkerImage,
  type DockerEmployeeContinuationRecord,
} from './docker-employee-continuation-data.js';

export interface DockerLaptopLimitUpkeepDeps {
  readonly store: Pick<DockerContinuationStore, 'record' | 'existingSubject' | 'policy'>;
  readonly engine: Pick<
    DockerContinuationEngine,
    'existingImage' | 'observeStorage' | 'observePool' | 'assertPreparationCurrent'
  > & {
    /** The in-place repair, saying whether anything had to be written. */
    restoreResources?(
      row: DockerEmployeeContinuationRecord,
      requireCurrent: () => void
    ): Promise<'unchanged' | 'restored'>;
  };
  /** A set-up step or a rebuild of this employee is running. Denial DATA only. */
  busy(employeeId: string): boolean;
}

export interface DockerLaptopLimitUpkeepResult {
  readonly operationId: string;
  /** `unchanged`: the approved limits were in place and acknowledged. `restored`: they were written again and read back. */
  readonly limits: 'unchanged' | 'restored';
}

function refuse(code: string): never {
  throw new DockerEmployeeContinuationError(code);
}

export class DockerLaptopLimitUpkeep {
  readonly #flights = new Set<string>();
  constructor(private readonly deps: DockerLaptopLimitUpkeepDeps) {}

  /** Denial DATA for other owners of the same employee; never an admission. */
  flightActive(employeeId: string): boolean {
    return this.#flights.has(employeeId);
  }

  /** The finished laptop record a repair acts for, when the employee has one. No Engine call. */
  finished(employeeId: string): DockerEmployeeContinuationRecord | undefined {
    const row = this.deps.store.record(employeeId);
    return row && row.version !== 3 && ['provider-issued', 'ready'].includes(row.phase) && row.destination
      ? row
      : undefined;
  }

  /**
   * Re-applies the already approved limits of one finished, running laptop and says whether anything was written.
   * Every refusal is thrown with its code and changes nothing.
   */
  async restore(
    employeeId: string,
    operationId: string,
    authority: DockerContinuationAuthority
  ): Promise<DockerLaptopLimitUpkeepResult> {
    authority.require();
    const row = this.finished(employeeId),
      restore = this.deps.engine.restoreResources?.bind(this.deps.engine);
    if (!row || row.request.operationId !== operationId || row.owner !== authority.owner)
      refuse('DOCKER_CONTINUATION_UNKNOWN_OPERATION');
    if (!restore) refuse('DOCKER_RESOURCE_REPAIR_UNAVAILABLE');
    const subject = this.deps.store.existingSubject(employeeId, row);
    if (
      !subject ||
      row.request.sessionId !== subject.sessionId ||
      row.request.sessionGeneration !== subject.sessionGeneration
    )
      refuse('DOCKER_CONTINUATION_TARGET_CHANGED');
    const current = () => {
      authority.require();
      if (!isDeepStrictEqual(this.deps.store.record(employeeId), row)) refuse('DOCKER_CONTINUATION_ORIGINAL_CHANGED');
      const live = this.deps.store.existingSubject(employeeId, row);
      if (
        !live ||
        live.owner !== authority.owner ||
        live.owner !== subject.owner ||
        live.sessionId !== subject.sessionId ||
        live.sessionGeneration !== subject.sessionGeneration ||
        live.providerSourceDigest !== subject.providerSourceDigest
      )
        refuse('DOCKER_CONTINUATION_TARGET_CHANGED');
      if (!isDeepStrictEqual(this.deps.store.policy(employeeId), row.policy))
        refuse('DOCKER_CONTINUATION_POLICY_CHANGED');
      this.deps.engine.assertPreparationCurrent?.(row);
    };
    current();
    if (this.#flights.has(employeeId) || this.deps.busy(employeeId)) refuse('DOCKER_CONTINUATION_BUSY');
    this.#flights.add(employeeId);
    try {
      await this.#qualify(row, current);
      // Nothing else of this employee took flight while the laptop was being read.
      if (this.deps.busy(employeeId)) refuse('DOCKER_CONTINUATION_BUSY');
      const limits = await restore(row, current);
      current();
      return { operationId, limits };
    } finally {
      this.#flights.delete(employeeId);
    }
  }

  /** The image, storage and shared pool of a published laptop, as its set-up service reads them before a repair. */
  async #qualify(row: DockerEmployeeContinuationRecord, current: () => void): Promise<void> {
    const { engine } = this.deps;
    // Without the read that re-earns the published image nothing shows this laptop is the one the record names.
    if (!engine.existingImage) refuse('DOCKER_RESOURCE_REPAIR_SCOPE_UNSUPPORTED');
    const image = DockerEmployeeWorkerImage.parse(await engine.existingImage(row, current));
    current();
    if (!isDeepStrictEqual(image, row.workerImage)) refuse('DOCKER_CONTINUATION_WORKER_IMAGE_CHANGED');
    if (engine.observeStorage) {
      const storage = await engine.observeStorage(row);
      current();
      if (storage === 'ephemeral-unissued') refuse('DOCKER_EPHEMERAL_PREPARATION_REQUIRED');
      if (storage !== 'ready') refuse('DOCKER_CONTINUATION_STORAGE_UNCONFIRMED');
    }
    const raw = await engine.observePool(row);
    current();
    const pool = raw ? DockerEmployeePool.parse(raw) : null;
    if (!pool || !row.pool) refuse('DOCKER_CONTINUATION_POOL_UNCONFIRMED');
    if (pool.policyDigest !== dockerContinuationDigest(row.policy.pool) || !isDeepStrictEqual(pool, row.pool))
      refuse('DOCKER_CONTINUATION_POOL_CHANGED');
  }
}
