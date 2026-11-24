/**
 * @fileoverview The office supervisor's reads and steps for one Docker laptop.
 *
 * Every method here calls the same application service method that the owner's route for that step calls
 * (`DockerEmployeeContinuation.observe/selection/begin`, `DockerAbsentReprovision.previewRebuild/rebuild`). Nothing
 * reaches the Engine, a session or a record except through them and one read-only destination observation.
 *
 * THE SUPERVISOR'S AUTHORITY is the one object built by `#authority`. Where a route proves a signed-in owner (or a
 * worker with a recovery grant) for each request, the supervisor presents:
 *
 * - the employee's own `recoveryAction` (same employee, session, generation and runtime recipe, no migration);
 * - the supervisor's guard: the owner's switch is on, the office is ready, and the employee is still meant to be
 *   running and in the office;
 * - a current laptop runtime.
 *
 * It is rechecked at every point the services recheck an owner. Its office authority is the same check and nothing
 * more: it can confirm an attendance the owner already set, and can never bring anyone back from being out of the
 * office. It cannot approve or change resource limits, choose a plan or a template, or answer for a stopped employee.
 */
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { CompanyError, type CompanyService } from './company-service.js';
import type { DockerAbsentReprovision } from './docker-absent-reprovision.js';
import type { DockerLaptopTemplate } from './docker-absent-reprovision-data.js';
import {
  DockerEmployeeContinuationError,
  dockerContinuationDigest,
  type DockerContainerObservation,
  type DockerContinuationAuthority,
  type DockerContinuationResult,
  type DockerEmployeeContinuation,
} from './docker-employee-continuation.js';
import type { DockerEmployeeContinuationRecord } from './docker-employee-continuation-data.js';
import { describeDockerProviderExit } from './docker-provider-exit.js';
import type {
  SupervisedEmployee,
  SupervisorActionResult,
  SupervisorGuard,
  SupervisorLaptopReading,
} from './employee-supervisor.js';
import type { SupervisorObservation } from './employee-supervisor-policy.js';

export interface DockerSupervisorLaptopDeps {
  readonly company: Pick<CompanyService, 'recoveryAction' | 'store'>;
  readonly store: {
    record(employeeId: string): DockerEmployeeContinuationRecord | undefined;
    policy(employeeId: string): unknown;
  };
  readonly engine: {
    observeDestination(row: DockerEmployeeContinuationRecord): Promise<DockerContainerObservation | null>;
  };
  readonly service: Pick<DockerEmployeeContinuation, 'observe' | 'selection' | 'begin' | 'flightActive'>;
  readonly absent: Pick<DockerAbsentReprovision, 'previewRebuild' | 'rebuild'>;
  /** The office's own terminal object for a session, when it has one. */
  readonly sessions: { get(sessionId: string): { readonly pid: number | null } | undefined };
  /** The laptop runtime's configuration and key are still the ones the office started with. */
  current(): boolean;
}

/** Another operation holds the employee: nothing was tried and the attempt is not spent. */
const BUSY = new Set(['DOCKER_CONTINUATION_BUSY', 'DOCKER_REPROVISION_BUSY']);

function refusal(error: unknown): SupervisorActionResult {
  if (error instanceof DockerEmployeeContinuationError)
    return { outcome: BUSY.has(error.code) ? 'busy' : 'refused', detail: error.code };
  // A CompanyError carries a sentence written for the API caller; nothing else is quoted.
  if (error instanceof CompanyError) return { outcome: 'refused', detail: error.message };
  if (error instanceof ZodError) return { outcome: 'failed', detail: 'the request did not fit the service' };
  throw error;
}

function settled(result: DockerContinuationResult): SupervisorActionResult {
  if (result.state !== 'held') return { outcome: 'done', detail: result.phase };
  return { outcome: result.code && BUSY.has(result.code) ? 'busy' : 'refused', detail: result.code ?? result.phase };
}

export class DockerSupervisorLaptops {
  constructor(private readonly deps: DockerSupervisorLaptopDeps) {}

  /** The whole of what the supervisor presents where a route presents a verified owner. See the file comment. */
  #authority(employee: SupervisedEmployee, guard: SupervisorGuard, fence?: () => void): DockerContinuationAuthority {
    const recovery = this.deps.company.recoveryAction(employee.id, employee.owner);
    const require = () => {
      if (!this.deps.current()) throw new DockerEmployeeContinuationError('DOCKER_CONTINUATION_RUNTIME_CHANGED');
      guard();
      recovery.require();
      fence?.();
    };
    require();
    return { owner: employee.owner, require, requireOffice: require };
  }

  #row(employeeId: string): DockerEmployeeContinuationRecord | undefined {
    return this.deps.store.record(employeeId);
  }

  /** The newest laptop operation the owner (or an earlier pass) recorded for this employee. */
  #head(employeeId: string) {
    const entries = (this.deps.company.store.snapshot().retiredDockerEmployeeContinuations ?? []).filter(
      (row) => row.employeeId === employeeId
    );
    const heads = entries.filter((row) => !entries.some((other) => other.previous === row.operationId));
    return heads.length === 1 ? heads[0] : undefined;
  }

  /** A rebuild or reprovision that retired the record and has not finished its source. */
  #pending(employeeId: string) {
    const head = this.#head(employeeId);
    return head &&
      (head.source.phase !== 'created' ||
        head.session.phase !== 'cleared' ||
        (head.removal && head.removal.phase !== 'removed'))
      ? head
      : undefined;
  }

  /**
   * The laptop layout a rebuild would use: the one the owner approved for this employee's most recent laptop
   * operation, verbatim. The supervisor never writes one; an employee with none on record is rebuilt by hand once.
   */
  #template(employeeId: string): DockerLaptopTemplate | undefined {
    return this.#head(employeeId)?.template;
  }

  /** What is already in memory about the laptop. No Engine call. */
  glance(
    employeeId: string
  ): Pick<
    SupervisorObservation['laptop'],
    'record' | 'bound' | 'policyApproved' | 'templateOnRecord' | 'rebuildPending'
  > {
    const row = this.#row(employeeId);
    const employee = this.deps.company.store.snapshot().employees.find((value) => value.id === employeeId);
    const pending = !!this.#pending(employeeId);
    return {
      record: row ? { phase: row.phase, version: row.version, operationId: row.request.operationId } : null,
      bound: !!employee?.dockerBinding,
      policyApproved: !!employee?.dockerResourcePolicy,
      templateOnRecord: !!this.#template(employeeId),
      ...(pending ? { rebuildPending: true } : {}),
    };
  }

  flightActive(employeeId: string): boolean {
    return this.deps.service.flightActive(employeeId);
  }

  /** The owner's observe read. A refusal is returned as the hold it names. */
  async read(employee: SupervisedEmployee, guard: SupervisorGuard): Promise<SupervisorLaptopReading | undefined> {
    const row = this.#row(employee.id);
    if (!row) return undefined;
    try {
      const result = await this.deps.service.observe(
        employee.id,
        row.request.operationId,
        this.#authority(employee, guard)
      );
      return {
        state: result.state,
        phase: result.phase,
        ...(result.code ? { code: result.code } : {}),
        allowedActions: [...result.allowedActions],
        ...(result.providerExit ? { providerExit: describeDockerProviderExit(result.providerExit) } : {}),
        ...(result.message ? { message: result.message } : {}),
      };
    } catch (error) {
      return {
        state: 'held',
        phase: row.phase,
        // The route answers any other failure of this read with the same code.
        code: error instanceof DockerEmployeeContinuationError ? error.code : 'DOCKER_CONTINUATION_UNCONFIRMED',
        allowedActions: [],
      };
    }
  }

  /** The stopped source a first set-up would start from, as the owner's policy read reports it. */
  async source(employee: SupervisedEmployee, guard: SupervisorGuard): Promise<'stopped' | 'running' | 'unknown'> {
    try {
      const selection = await this.deps.service.selection(employee.id, this.#authority(employee, guard));
      return selection.operationId === null ? selection.state : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /** Continue: the recorded request, sent again. Never for a plan move's private record. */
  async resend(employee: SupervisedEmployee, guard: SupervisorGuard): Promise<SupervisorActionResult> {
    const row = this.#row(employee.id);
    if (!row || row.version === 3)
      return { outcome: 'refused', detail: 'no laptop set-up of this employee to continue' };
    try {
      return settled(await this.deps.service.begin(employee.id, row.request, this.#authority(employee, guard)));
    } catch (error) {
      return refusal(error);
    }
  }

  /** The owner's "read the policy, then continue" for a stopped source that has no set-up yet. */
  async start(employee: SupervisedEmployee, guard: SupervisorGuard): Promise<SupervisorActionResult> {
    if (this.#row(employee.id)) return { outcome: 'refused', detail: 'a laptop set-up already exists' };
    if (!this.glance(employee.id).policyApproved) return { outcome: 'refused', detail: 'no approved resource limits' };
    try {
      const authority = this.#authority(employee, guard);
      const selection = await this.deps.service.selection(employee.id, authority);
      if (selection.operationId !== null || selection.state !== 'stopped')
        return { outcome: 'refused', detail: 'no stopped laptop source' };
      return settled(
        await this.deps.service.begin(
          employee.id,
          {
            operationId: randomUUID(),
            sessionId: selection.sessionId,
            sessionGeneration: selection.sessionGeneration,
            containerId: selection.containerId,
            imageId: selection.imageId,
            expectedPolicyDigest: dockerContinuationDigest(this.deps.store.policy(employee.id)),
            expectedDestinationImageId: selection.destinationImageId,
            // The supervisor never changes attendance.
            enterOffice: false,
          },
          authority
        )
      );
    } catch (error) {
      return refusal(error);
    }
  }
}
