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
 *
 * Putting limits BACK is not changing them. When a running laptop, or the pool all laptops share, no longer shows
 * the limits the owner approved (a reload of the host's service manager resets them), the supervisor asks the same
 * two services the owner's repair routes call to write those same approved values again. No laptop is stopped.
 *
 * That one step does not depend on attendance (`keepLimits`). A laptop that keeps running while its employee is
 * out of the office or stopped needs its limits like any other, and a set-up step would be refused for it, so the
 * supervisor asks `DockerLaptopLimitUpkeep` instead, the service the owner's repair route uses for such an employee.
 * Its guard there is the owner's switch, the ready office and the unchanged employee; it never requires anyone to be
 * in the office and never brings anyone back. Nothing is attached, no agent is read or started.
 *
 * A rebuild is requested without `confirmDiscardRunning` unless one running laptop is exactly the recorded
 * destination and one of two statements holds, read just now. Those two statements are the supervisor's only uses
 * of the owner's confirmation:
 *
 * - a read made inside that laptop says no agent runs there; or
 * - an agent runs there, the policy chose the rebuild because the office terminal's input is held for good
 *   (`terminal-input-held`), and that terminal, read again at this moment, still has its input held and shows no
 *   turn in progress. The office can never type to that agent again, so nothing is gained by keeping it between
 *   turns. A turn in progress, a pane the office is not reading, a second running laptop or a running laptop that
 *   is not the recorded one all refuse, as they always did.
 *
 * One kind of running laptop is not counted among those: the candidate that an abandoned plan move of this employee
 * created for the new plan, when it is not the employee's recorded laptop and a read inside it, made now, finds no
 * agent (`#withoutEmptyCandidates`). A move starts that container before it launches an agent in it, so a move that
 * was abandoned in between leaves it running and empty, and the rebuild is the product's own way to remove what an
 * abandoned move left behind.
 */
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { CompanyError, type CompanyService } from './company-service.js';
import type { DockerAbsentReprovision, DockerAbsentReprovisionPlanMoves } from './docker-absent-reprovision.js';
import type { DockerLaptopLimitUpkeep } from './docker-laptop-limit-upkeep.js';
import type { DockerPoolReconciliation } from './docker-pool-reconciliation.js';
import { reprovisionHeads, type DockerLaptopTemplate } from './docker-absent-reprovision-data.js';
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
import {
  readSupervisedTerminal,
  type SupervisedTerminal,
  type SupervisorObservation,
  type SupervisorPrecondition,
  type SupervisorProviderPresence,
} from './employee-supervisor-policy.js';

export interface DockerSupervisorLaptopDeps {
  readonly company: Pick<CompanyService, 'recoveryAction' | 'store'>;
  readonly store: {
    record(employeeId: string): DockerEmployeeContinuationRecord | undefined;
    policy(employeeId: string): unknown;
  };
  readonly engine: {
    observeDestination(row: DockerEmployeeContinuationRecord): Promise<DockerContainerObservation | null>;
  };
  readonly service: Pick<DockerEmployeeContinuation, 'observe' | 'selection' | 'begin' | 'repair' | 'flightActive'>;
  /** The shared pool's status and in-place repair, as the owner's routes call them. */
  readonly pool: Pick<DockerPoolReconciliation, 'status' | 'repair'>;
  /** The in-place repair of one finished laptop's own limits that does not ask where its employee is. */
  readonly limits?: Pick<DockerLaptopLimitUpkeep, 'finished' | 'restore' | 'flightActive'>;
  readonly absent: Pick<DockerAbsentReprovision, 'previewRebuild' | 'rebuild'>;
  /** The plan moves' journal, for the candidate laptops that abandoned moves of an employee left behind. */
  readonly moves?: () => Pick<DockerAbsentReprovisionPlanMoves, 'abandonedCandidateRecords'> | undefined;
  /** The office's own terminal object for a session, when it has one. */
  readonly sessions: { get(sessionId: string): SupervisedTerminal | undefined };
  /** The laptop runtime's configuration and key are still the ones the office started with. */
  current(): boolean;
}

/** Another operation holds the employee: nothing was tried and the attempt is not spent. */
const BUSY = new Set(['DOCKER_CONTINUATION_BUSY', 'DOCKER_REPROVISION_BUSY']);
/** The shared pool is what stands in the way of a laptop's own limits. Its in-place repair comes first. */
const POOL_FIRST = new Set(['DOCKER_CONTINUATION_POOL_UNCONFIRMED', 'DOCKER_RESOURCE_POOL_HELPER_UNACKNOWLEDGED']);

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
    const heads = reprovisionHeads(this.deps.company.store.snapshot().retiredDockerEmployeeContinuations, employeeId);
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
    return this.deps.service.flightActive(employeeId) || !!this.deps.limits?.flightActive(employeeId);
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

  /**
   * The stopped source a first set-up would start from, as the owner's policy read reports it. `outdated` is that
   * read's own refusal of a never-started source that was made for an earlier laptop image. Every other refusal
   * stays unknown.
   */
  async source(
    employee: SupervisedEmployee,
    guard: SupervisorGuard
  ): Promise<'stopped' | 'running' | 'outdated' | 'unknown'> {
    try {
      const selection = await this.deps.service.selection(employee.id, this.#authority(employee, guard));
      return selection.operationId === null ? selection.state : 'unknown';
    } catch (error) {
      return error instanceof DockerEmployeeContinuationError &&
        error.code === 'DOCKER_CONTINUATION_SOURCE_IMAGE_OUTDATED'
        ? 'outdated'
        : 'unknown';
    }
  }

  async #destinationPresence(row: DockerEmployeeContinuationRecord): Promise<SupervisorProviderPresence> {
    try {
      const seen = await this.deps.engine.observeDestination(row);
      // The listing said this container runs; a read that disagrees proves nothing.
      if (!seen || seen.state !== 'running') return 'unknown';
      return seen.provider.kind;
    } catch {
      return 'unknown';
    }
  }

  /**
   * The running laptops that still have to be shown empty before a rebuild may discard them: all of them, except
   * the candidate of an abandoned plan move of this employee in which a read made now finds no agent. The read is
   * the same one that shows the recorded laptop empty; the move's journal only says which container to read. The
   * employee's recorded laptop is never taken off the list here, and neither is a candidate that cannot be read or
   * in which anything runs.
   */
  async #withoutEmptyCandidates(employee: SupervisedEmployee, running: readonly string[]): Promise<readonly string[]> {
    const recorded = this.#row(employee.id)?.destination?.containerId;
    if (running.every((id) => id === recorded)) return running;
    const empty = new Set<string>();
    try {
      const left = (await this.deps.moves?.()?.abandonedCandidateRecords?.(employee.id, employee.owner)) ?? [];
      for (const { record } of left) {
        const id = record.destination?.containerId;
        if (!id || id === recorded || !running.includes(id) || empty.has(id)) continue;
        const presence = await this.#destinationPresence(record);
        if (presence === 'absent' || presence === 'exited') empty.add(id);
      }
    } catch {
      return running;
    }
    return running.filter((id) => !empty.has(id));
  }

  /**
   * What a rebuild would discard, read now. `no-laptop`: the Engine lists no running laptop of this employee.
   * `exited` / `absent`: the one running laptop is the recorded destination and a read inside it found no agent;
   * `absent` also when the only laptops that run are empty candidates of abandoned plan moves.
   * `running`: an agent runs there, or a laptop runs that this office cannot show to be empty.
   */
  async provider(employee: SupervisedEmployee, guard: SupervisorGuard): Promise<SupervisorProviderPresence> {
    // A pending operation already proved its containers absent or discarded them before it retired the record.
    if (this.#pending(employee.id)) return 'no-laptop';
    const template = this.#template(employee.id);
    if (!template) return 'unknown';
    let running: readonly string[];
    try {
      running = (await this.deps.absent.previewRebuild(employee.id, template, this.#authority(employee, guard)))
        .runningLaptops;
    } catch {
      return 'unknown';
    }
    if (!running.length) return 'no-laptop';
    running = await this.#withoutEmptyCandidates(employee, running);
    if (!running.length) return 'absent';
    const row = this.#row(employee.id);
    if (!row?.destination || running.length !== 1 || running[0] !== row.destination.containerId) return 'running';
    return this.#destinationPresence(row);
  }

  /**
   * Continue: the recorded request, sent again. Never for a plan move's private record. A laptop whose set-up is
   * finished has no step left to continue; what can be put right there without stopping it is its approved limits.
   */
  async resend(employee: SupervisedEmployee, guard: SupervisorGuard): Promise<SupervisorActionResult> {
    const row = this.#row(employee.id);
    if (!row || row.version === 3)
      return { outcome: 'refused', detail: 'no laptop set-up of this employee to continue' };
    try {
      const authority = this.#authority(employee, guard);
      const repaired = ['provider-issued', 'ready'].includes(row.phase)
        ? await this.#repair(employee, row, authority)
        : undefined;
      return repaired ?? settled(await this.deps.service.begin(employee.id, row.request, authority));
    } catch (error) {
      return refusal(error);
    }
  }

  /**
   * The owner's two repair calls for a running laptop: the pool that every laptop shares first, when its status
   * offers that, then this laptop's own limits. Both write only values the owner already approved. Undefined when
   * the laptop is held by something a repair does not settle and the request sent again is offered instead.
   */
  async #repair(
    employee: SupervisedEmployee,
    row: DockerEmployeeContinuationRecord,
    authority: DockerContinuationAuthority
  ): Promise<SupervisorActionResult | undefined> {
    await this.#repairPool(employee, authority);
    const result = await this.deps.service.repair(employee.id, row.request.operationId, authority);
    return result.state === 'held' && result.allowedActions.includes('continue') ? undefined : settled(result);
  }

  /** The owner's pool repair, when the pool's status offers it. True when it was asked for. */
  async #repairPool(employee: SupervisedEmployee, authority: DockerContinuationAuthority): Promise<boolean> {
    const pool = await this.deps.pool.status(employee.id, authority);
    if (!pool.allowedActions.includes('repair-pool') || !pool.scopeDigest) return false;
    await this.deps.pool.repair(
      employee.id,
      {
        sessionId: pool.sessionId,
        sessionGeneration: pool.sessionGeneration,
        expectedScopeDigest: pool.scopeDigest,
      },
      authority
    );
    return true;
  }

  /**
   * Keep the approved limits of this employee's finished laptop in place, wherever the employee is. `unchanged`:
   * they were in place. `restored`: they were written again and read back. `not-running`: the laptop is stopped,
   * so there is nothing to keep. Undefined: the employee has no finished laptop. The laptop's own limits are tried
   * first; only when the shared pool stands in the way is the pool repaired, once, and the laptop tried again.
   */
  async keepLimits(employee: SupervisedEmployee, guard: SupervisorGuard): Promise<SupervisorActionResult | undefined> {
    const limits = this.deps.limits,
      row = limits?.finished(employee.id);
    if (!limits || !row) return undefined;
    try {
      const authority = this.#authority(employee, guard);
      const restore = () => limits.restore(employee.id, row.request.operationId, authority);
      const first = await restore().catch((error: unknown) => {
        if (error instanceof DockerEmployeeContinuationError && POOL_FIRST.has(error.code)) return error;
        throw error;
      });
      if (!(first instanceof DockerEmployeeContinuationError)) return { outcome: 'done', detail: first.limits };
      if (!(await this.#repairPool(employee, authority))) throw first;
      await restore();
      return { outcome: 'done', detail: 'restored' };
    } catch (error) {
      if (error instanceof DockerEmployeeContinuationError && error.code === 'DOCKER_CONTINUATION_CONTAINER_STOPPED')
        return { outcome: 'done', detail: 'not-running' };
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

  /**
   * Nothing that could start an agent in the laptop has moved since the read that allowed its discard: no set-up
   * step is in flight and the office terminal is the same object under the same process, or gone. A held terminal
   * stays held for as long as it is that object, and what its pane shows is not asked again here: the pane of a
   * laptop that is being stopped prints, which says nothing about a turn.
   */
  #quiet(employee: SupervisedEmployee): () => void {
    const before = this.deps.sessions.get(employee.sessionId),
      pid = before?.pid ?? null;
    return () => {
      if (this.deps.service.flightActive(employee.id))
        throw new DockerEmployeeContinuationError('DOCKER_CONTINUATION_BUSY');
      const now = this.deps.sessions.get(employee.sessionId);
      if (now && now.pid !== null && (now !== before || now.pid !== pid))
        throw new DockerEmployeeContinuationError('DOCKER_REPROVISION_TARGET_CHANGED');
    };
  }

  /**
   * The held terminal, read again now: why the laptop its agent runs in may not be discarded for it, or undefined
   * when it may. A turn in progress tried nothing and is waited for; everything else is a refusal.
   */
  #heldTerminalRefusal(employee: SupervisedEmployee): SupervisorActionResult | undefined {
    const { inputHeld, turn } = readSupervisedTerminal(this.deps.sessions.get(employee.sessionId));
    if (!inputHeld) return { outcome: 'refused', detail: "the office terminal's input is not held" };
    if (turn === 'working') return { outcome: 'busy', detail: 'the agent is in the middle of a turn' };
    if (turn !== 'idle') return { outcome: 'refused', detail: "the office is not reading the agent's terminal" };
    return undefined;
  }

  /**
   * Why the running laptops a rebuild would stop may not be discarded, read now; undefined when they may. See the
   * file comment: only the one recorded laptop, and only when it is empty or its terminal's input is held for good.
   */
  async #discardRefusal(
    employee: SupervisedEmployee,
    listed: readonly string[],
    proved: readonly SupervisorPrecondition[]
  ): Promise<SupervisorActionResult | undefined> {
    const running = await this.#withoutEmptyCandidates(employee, listed);
    if (!running.length) return undefined;
    const row = this.#row(employee.id);
    const recorded = !!row?.destination && running.length === 1 && running[0] === row.destination.containerId;
    const presence = recorded ? await this.#destinationPresence(row!) : 'running';
    if (presence === 'exited' || presence === 'absent') return undefined;
    if (recorded && presence === 'running' && proved.includes('terminal-input-held'))
      return this.#heldTerminalRefusal(employee);
    return { outcome: 'refused', detail: 'a running laptop is not shown to be empty' };
  }

  /**
   * The owner's rebuild: preview, then apply with the preview's own digest. A pending one is finished instead.
   * `proved` is what the policy asked to be proved for this step; see `#discardRefusal` for its one use.
   */
  async rebuild(
    employee: SupervisedEmployee,
    guard: SupervisorGuard,
    proved: readonly SupervisorPrecondition[] = []
  ): Promise<SupervisorActionResult> {
    try {
      const pending = this.#pending(employee.id);
      if (pending) {
        const resumed = await this.deps.absent.rebuild(
          employee.id,
          {
            operationId: pending.operationId,
            sessionId: pending.sessionId,
            sessionGeneration: pending.sessionGeneration,
            expectedScopeDigest: pending.scopeDigest,
            template: pending.template,
          },
          this.#authority(employee, guard)
        );
        return resumed.state === 'ready'
          ? { outcome: 'done', detail: 'finished ' + pending.operationId }
          : { outcome: 'refused', detail: resumed.code ?? resumed.state };
      }
      const template = this.#template(employee.id);
      if (!template) return { outcome: 'refused', detail: 'no approved laptop layout on record' };
      const preview = await this.deps.absent.previewRebuild(employee.id, template, this.#authority(employee, guard));
      const blocked = 'code' in preview ? preview.code : undefined;
      if (blocked || !(preview.allowedActions as readonly string[]).includes('rebuild'))
        return { outcome: 'refused', detail: blocked ?? 'the rebuild is not offered' };
      let fence: (() => void) | undefined;
      if (preview.runningLaptops.length) {
        const refused = await this.#discardRefusal(employee, preview.runningLaptops, proved);
        if (refused) return refused;
        fence = this.#quiet(employee);
      }
      const result = await this.deps.absent.rebuild(
        employee.id,
        {
          operationId: randomUUID(),
          sessionId: preview.sessionId,
          sessionGeneration: preview.sessionGeneration,
          expectedScopeDigest: preview.scopeDigest,
          template,
          ...(fence ? { confirmDiscardRunning: true as const } : {}),
        },
        this.#authority(employee, guard, fence)
      );
      return result.state === 'ready'
        ? { outcome: 'done', detail: 'rebuilt ' + result.operationId }
        : { outcome: 'refused', detail: result.code ?? result.state };
    } catch (error) {
      return refusal(error);
    }
  }
}
