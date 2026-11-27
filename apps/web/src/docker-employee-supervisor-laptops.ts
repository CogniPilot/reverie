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
 * - an agent runs there, or the read cannot say, and the policy chose the rebuild between that agent's turns: the
 *   step was asked to prove one of `SUPERVISOR_OCCUPIED_PROOFS`. The office terminal, read again at this moment,
 *   must show no turn in progress. A turn in progress is waited for. A pane the office is not reading refuses,
 *   unless the policy found that it cannot be read at all and the long wait for that has passed
 *   (`agent-unreadable`). Where the reason is a held terminal input (`terminal-input-held`) the input must still
 *   be held, and where it is a held laptop (`laptop-held`) the laptop's own read must still say so. Where it is
 *   an agent parked on a provider start-up screen (`agent-parked-at-screen`) the office terminal must still show
 *   that screen by more than its words: such an agent has not reached its composer, so it holds no conversation in
 *   progress. A second running laptop or a running laptop that is not the recorded one refuses, as it always did.
 *
 * One kind of running laptop is not counted among those: the candidate that an abandoned plan move of this employee
 * created for the new plan, when it is not the employee's recorded laptop and a read inside it, made now, finds no
 * agent (`#withoutEmptyCandidates`). A move starts that container before it launches an agent in it, so a move that
 * was abandoned in between leaves it running and empty, and the rebuild is the product's own way to remove what an
 * abandoned move left behind. No proof of the policy excuses such a candidate: only that read does, and a candidate
 * in which anything runs, or which cannot be read, refuses like any other laptop that is not the recorded one.
 *
 * THE OWNER'S STANDING DEFAULTS (company setting `supervisorStandingDefaults`, on unless the owner switched it off)
 * stand where the owner's own approval of limits and of a layout stood, for an employee who has none: see
 * docker-standing-defaults.ts for what they are. The supervisor still never chooses a value: both are derived from
 * what the owner approved for the other employees, and the limits are saved through the same store method the
 * owner's docker-policy route calls. The switch is read again inside that save.
 *
 * THE POOL AFTER A HOST RESTART (`keepPool`). When the host restarts, every laptop and the pool's anchor are stopped.
 * No laptop can be set up before the anchor runs again, and only the cold recovery starts a stopped anchor. The
 * owner's two calls for that (`cold-preview`, then `cold-recover`) are made here through the same service, under
 * the owner's standing switch for repairs instead of a signed-in owner. The service itself refuses while any laptop
 * of the box runs; this file never decides that. A recovery that was issued and did not finish is finished as
 * itself (`cold-resume`) before anything new is previewed. A pool that runs and only lacks its observation record
 * gets that record (`reconcile`). The pool is shared, so any employee's record can stand for it: the attendance of
 * that employee is not asked, and nobody is started, attached or returned to the office by this step. When the
 * service refuses the preview through one employee's record, whatever the refusal, the next employee's is tried:
 * a refusal can belong to that one record. Only when every record was tried is the pool reported as stopped with
 * the refusal's own code, which every waiting employee's report then shows.
 *
 * STORED HOME (`storedHome`). Before a finished laptop that is stopped is rebuilt, the office asks whether the HOME
 * and Nix directories at its recorded paths are still the ones its storage holder recorded. A rebuilt laptop is
 * bound to those paths, so this is where a different disk at the same path would be taken for an employee's home.
 * The read is the one a same-plan recovery makes; a new device number is accepted only as `stoppedReference` of the
 * reattach helper allows. `renumbered` and `different` stop the automatic rebuild. An office that has no verifier
 * rebuilds by the recorded path, as it did before this check existed. The policy asks for the read before it
 * decides (`stored-home`), the driver makes it, and `rebuild` makes it once more itself, last, for every rebuild:
 * a laptop that runs has no stopped storage to compare and is not held up by it.
 */
import { randomUUID } from 'node:crypto';
import type { DockerStoppedStorage, DockerStoredHomeLayout } from './docker-employee-engine.js';
import { reprovisionStorage } from './docker-absent-reprovision-source.js';
import type { DockerVerifierCapability } from './docker-worker-reattach-helper.js';
import { ZodError } from 'zod';
import { CompanyError, type CompanyService } from './company-service.js';
import type { CompanyState } from './company-types.js';
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
import type {
  DockerEmployeeContinuationRecord,
  DockerEmployeeResourcePolicy,
} from './docker-employee-continuation-data.js';
import { describeDockerProviderExit } from './docker-provider-exit.js';
import { standingLayout, standingLimits } from './docker-standing-defaults.js';
import type {
  SupervisedEmployee,
  SupervisorActionResult,
  SupervisorGuard,
  SupervisorLaptopReading,
  SupervisorPoolGuard,
  SupervisorPoolResult,
  SupervisorPoolStep,
  SupervisorStoredHomeReading,
} from './employee-supervisor.js';
import {
  readParkedScreen,
  readSupervisedTerminal,
  readTerminalTurn,
  SUPERVISOR_OCCUPIED_PROOFS,
  type SupervisedScreenTerminal,
  type SupervisorObservation,
  type SupervisorPrecondition,
  type SupervisorStoredHome,
  type SupervisorProviderPresence,
} from './employee-supervisor-policy.js';

export interface DockerSupervisorLaptopDeps {
  readonly company: Pick<CompanyService, 'recoveryAction' | 'store'>;
  readonly store: {
    record(employeeId: string): DockerEmployeeContinuationRecord | undefined;
    policy(employeeId: string): unknown;
    /** The save behind the owner's docker-policy route. Absent where standing limits cannot be given. */
    savePolicy?(
      employeeId: string,
      owner: string | undefined,
      policy: DockerEmployeeResourcePolicy,
      current: () => void
    ): Promise<void>;
  };
  readonly engine: {
    observeDestination(row: DockerEmployeeContinuationRecord): Promise<DockerContainerObservation | null>;
  };
  readonly service: Pick<DockerEmployeeContinuation, 'observe' | 'selection' | 'begin' | 'repair' | 'flightActive'>;
  /** The shared pool's status, in-place repair, observation record and cold recovery, as the owner's routes call them. */
  readonly pool: Pick<DockerPoolReconciliation, 'status' | 'repair'> &
    Partial<Pick<DockerPoolReconciliation, 'reconcile' | 'coldPreview' | 'coldRecover' | 'coldResume' | 'coldHeld'>>;
  /** Reads of an employee's stored HOME and Nix directories. Absent where the office has no laptops to verify. */
  readonly storage?: {
    /** See `DockerEmployeeEngine.stoppedStorage`. */
    stopped(
      row: DockerEmployeeContinuationRecord,
      current: () => void,
      layout?: DockerStoredHomeLayout
    ): Promise<DockerStoppedStorage>;
    /** What the configured verifier image can do; `none` when the office is configured with no verifier. */
    capability?(): 'none' | DockerVerifierCapability;
    /** Record which filesystem a running laptop's directories are on. See `DockerEmployeeEngine.rememberStorage`. */
    remember?(
      row: DockerEmployeeContinuationRecord,
      current: () => void
    ): Promise<'recorded' | 'not-running' | 'not-recorded'>;
  };
  /** The in-place repair of one finished laptop's own limits that does not ask where its employee is. */
  readonly limits?: Pick<DockerLaptopLimitUpkeep, 'finished' | 'restore' | 'flightActive'>;
  readonly absent: Pick<DockerAbsentReprovision, 'previewRebuild' | 'rebuild'>;
  /** The plan moves' journal, for the candidate laptops that abandoned moves of an employee left behind. */
  readonly moves?: () => Pick<DockerAbsentReprovisionPlanMoves, 'abandonedCandidateRecords'> | undefined;
  /** The office's own terminal object for a session, when it has one. */
  readonly sessions: { get(sessionId: string): SupervisedScreenTerminal | undefined };
  /** The saved record of a session says its terminal input is held. Asked only while there is no terminal object. */
  inputHeldOnRecord?(sessionId: string): boolean;
  /** The laptop runtime's configuration and key are still the ones the office started with. */
  current(): boolean;
}

/** Findings about the stored home of a stopped laptop with which the rebuild step itself refuses. */
const STORED_HOME_REFUSALS: Readonly<Partial<Record<SupervisorStoredHome, string>>> = {
  renumbered: 'the stored home has a new device number that nothing accepts',
  different: 'the stored home is not the directory the laptop was built on',
  changed: 'the stored home no longer matches what was recorded',
  unknown: 'the stored home could not be read',
};
/** What a read answers when this employee's record cannot stand for the pool; another one may. */
const NO_SOURCE = '';
/** The refusal that says this employee has no laptop record that names the pool's anchor; another one may. */
const NO_POOL_SOURCE = new Set(['DOCKER_POOL_COLD_SOURCE_UNCONFIRMED']);
/** The pool's anchor is not running: what the cold recovery is for. */
const ANCHOR_STOPPED = 'DOCKER_POOL_ANCHOR_UNCONFIRMED';
/** The anchor runs and its limits or their acknowledgement are missing: a laptop set-up or the in-place repair
 * writes them. Nothing is recovered cold for it. */
const POOL_RUNNING_HOLDS = new Set(['DOCKER_POOL_POLICY_CHANGED', 'DOCKER_POOL_ORIGINAL_ACK_MISSING']);

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
  #head(employeeId: string, state: CompanyState = this.deps.company.store.snapshot()) {
    const heads = reprovisionHeads(state.retiredDockerEmployeeContinuations, employeeId);
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

  /** The owner left the standing defaults switched on for this company. */
  #standingEnabled(owner: string | undefined, state: CompanyState): boolean {
    return state.settings.find((row) => row.owner === owner)?.supervisorStandingDefaults !== false;
  }

  /** The other employees of the same company. Standing defaults are read from them and never from the employee. */
  #others(employeeId: string, state: CompanyState) {
    const self = state.employees.find((value) => value.id === employeeId);
    return self ? state.employees.filter((value) => value.id !== employeeId && value.owner === self.owner) : [];
  }

  /** The standing default limits for this employee; see docker-standing-defaults.ts. */
  #standingLimits(employeeId: string, state: CompanyState): DockerEmployeeResourcePolicy | undefined {
    return standingLimits(
      this.#others(employeeId, state).flatMap((value) =>
        value.dockerResourcePolicy ? [value.dockerResourcePolicy] : []
      )
    );
  }

  /** The standing default layout for this employee; see docker-standing-defaults.ts. */
  #standingLayout(employeeId: string, state: CompanyState): DockerLaptopTemplate | undefined {
    return standingLayout(
      this.#others(employeeId, state).flatMap((value) => {
        const template = this.#head(value.id, state)?.template;
        return template ? [template] : [];
      })
    );
  }

  /**
   * The laptop layout a rebuild would use: the one the owner approved for this employee's most recent laptop
   * operation, verbatim. The supervisor never writes one. An employee with none on record is given the owner's
   * standing default, while that is switched on and the other laptops have one in common.
   */
  #template(employeeId: string): DockerLaptopTemplate | undefined {
    const state = this.deps.company.store.snapshot(),
      own = this.#head(employeeId, state)?.template;
    if (own) return own;
    const employee = state.employees.find((value) => value.id === employeeId);
    return employee && this.#standingEnabled(employee.owner, state)
      ? this.#standingLayout(employeeId, state)
      : undefined;
  }

  /** What is already in memory about the laptop. No Engine call. */
  glance(
    employeeId: string
  ): Pick<
    SupervisorObservation['laptop'],
    'record' | 'bound' | 'policyApproved' | 'templateOnRecord' | 'rebuildPending' | 'standing'
  > {
    const row = this.#row(employeeId);
    const state = this.deps.company.store.snapshot();
    const employee = state.employees.find((value) => value.id === employeeId);
    const pending = !!this.#pending(employeeId);
    return {
      record: row ? { phase: row.phase, version: row.version, operationId: row.request.operationId } : null,
      bound: !!employee?.dockerBinding,
      policyApproved: !!employee?.dockerResourcePolicy,
      templateOnRecord: !!this.#head(employeeId, state)?.template,
      standing: {
        enabled: this.#standingEnabled(employee?.owner, state),
        limits: !!this.#standingLimits(employeeId, state),
        layout: !!this.#standingLayout(employeeId, state),
      },
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

  /** The code of a refusal by one of the laptop services, or a fixed phrase. Never a message. */
  #code(error: unknown): string {
    if (error instanceof DockerEmployeeContinuationError) return error.code;
    return error instanceof CompanyError ? 'the office refused this employee' : 'the read failed';
  }

  /**
   * One look at the shared pool. With `step`, that step is taken when this look calls for exactly it. See the
   * file comment. `candidates` are tried in order until the record of one can stand for the pool.
   */
  async keepPool(
    candidates: readonly SupervisedEmployee[],
    guard: SupervisorPoolGuard,
    step?: SupervisorPoolStep
  ): Promise<SupervisorPoolResult> {
    let held: ReturnType<NonNullable<DockerSupervisorLaptopDeps['pool']['coldHeld']>>;
    try {
      held = this.deps.pool.coldHeld?.();
    } catch (error) {
      return { pool: 'unknown', detail: this.#code(error) };
    }
    // The employee an open recovery was issued for comes first: only they can run it again as it was issued.
    const order = held
      ? [...candidates].sort((a, b) => Number(b.id === held!.employeeId) - Number(a.id === held!.employeeId))
      : candidates;
    let unread: string | undefined, refused: string | undefined;
    for (const employee of order) {
      const found = held
        ? await this.#finishPool(employee, guard, step === 'finish-pool-recovery')
        : await this.#poolFor(employee, guard, step);
      if (typeof found === 'string') {
        if (found !== NO_SOURCE) unread ??= found;
      } else if ('refused' in found) refused ??= found.refused;
      else return { ...found, employeeId: employee.id };
    }
    // The anchor is stopped and the service refused to recover it through every record that names it: the pool
    // is down, and the first refusal says why. Nobody's record could be read: nothing is known. Every record was
    // read and none names the pool: an open recovery stays open, and otherwise there is no pool to recover (a
    // laptop set-up creates one).
    if (refused !== undefined) return { pool: 'down', detail: refused };
    if (unread !== undefined) return { pool: 'unknown', detail: unread };
    return held
      ? { pool: 'down', detail: 'DOCKER_POOL_COLD_ATTEMPT_HELD' }
      : { pool: 'none', detail: 'no laptop record names the shared pool' };
  }

  /** An open recovery, finished as itself. `NO_SOURCE` when this employee's record cannot stand for the pool. */
  async #finishPool(
    employee: SupervisedEmployee,
    guard: SupervisorPoolGuard,
    act: boolean
  ): Promise<SupervisorPoolResult | string> {
    const step = 'finish-pool-recovery' as const;
    if (!act) return { pool: 'down', step };
    try {
      const authority = this.#authority(employee, guard(employee, 'repair'));
      const status = await this.deps.pool.coldResume!(employee.id, authority);
      return { ...this.#poolState(status), step, outcome: 'done', detail: status.code ?? status.state };
    } catch (error) {
      const code = this.#code(error);
      return NO_POOL_SOURCE.has(code) || error instanceof CompanyError
        ? NO_SOURCE
        : { pool: 'down', step, outcome: 'refused', detail: code };
    }
  }

  /** What a pool status says a laptop set-up can count on. */
  #poolState(status: { state: string; code?: string }): Pick<SupervisorPoolResult, 'pool' | 'detail'> {
    if (status.state !== 'held') return { pool: 'up' };
    if (status.code && POOL_RUNNING_HOLDS.has(status.code)) return { pool: 'up', detail: status.code };
    const down = status.code === ANCHOR_STOPPED || status.code === 'DOCKER_POOL_COLD_ATTEMPT_HELD';
    return { pool: down ? 'down' : 'unknown', ...(status.code ? { detail: status.code } : {}) };
  }

  /** The pool as one employee's record shows it. `NO_SOURCE` when that record cannot stand for the pool, the code
   * of the failure when the pool could not be read through it, and `refused` with the service's code when the
   * anchor is stopped and the service does not recover it through this record. */
  async #poolFor(
    employee: SupervisedEmployee,
    guard: SupervisorPoolGuard,
    asked: SupervisorPoolStep | undefined
  ): Promise<SupervisorPoolResult | string | { refused: string }> {
    const pool = this.deps.pool;
    let status: Awaited<ReturnType<DockerPoolReconciliation['status']>>;
    try {
      status = await pool.status(employee.id, this.#authority(employee, guard(employee, 'retry')));
    } catch (error) {
      // An employee with no approved limits, or one who is being moved, has no pool to show.
      return error instanceof CompanyError ? NO_SOURCE : this.#code(error);
    }
    const seen = this.#poolState(status);
    if (status.allowedActions.includes('reconcile-pool') && status.scopeDigest && pool.reconcile)
      return this.#poolStep('reconcile-pool', seen, asked, async () =>
        pool.reconcile!(
          employee.id,
          {
            sessionId: status.sessionId,
            sessionGeneration: status.sessionGeneration,
            expectedScopeDigest: status.scopeDigest!,
          },
          this.#authority(employee, guard(employee, 'retry'))
        )
      );
    if (status.code !== ANCHOR_STOPPED || !pool.coldPreview || !pool.coldRecover) return seen;
    // The service decides whether the pool may be recovered cold: a stopped anchor, no laptop of the box running,
    // every earlier writer accounted for. Its refusal is the answer.
    let preview: Awaited<ReturnType<DockerPoolReconciliation['coldPreview']>>;
    try {
      preview = await pool.coldPreview(employee.id, this.#authority(employee, guard(employee, 'retry')));
    } catch (error) {
      const code = this.#code(error);
      if (NO_POOL_SOURCE.has(code) || error instanceof CompanyError) return NO_SOURCE;
      // Whatever the refusal, another employee's record may not meet it.
      return { refused: code };
    }
    return this.#poolStep('recover-pool', seen, asked, async () =>
      pool.coldRecover!(
        employee.id,
        {
          operationId: randomUUID(),
          sessionId: preview.sessionId,
          sessionGeneration: preview.sessionGeneration,
          expectedScopeDigest: preview.scopeDigest,
        },
        this.#authority(employee, guard(employee, 'repair'))
      )
    );
  }

  async #poolStep(
    step: SupervisorPoolStep,
    seen: Pick<SupervisorPoolResult, 'pool' | 'detail'>,
    asked: SupervisorPoolStep | undefined,
    run: () => Promise<{ state: string; code?: string }>
  ): Promise<SupervisorPoolResult> {
    if (asked !== step) return { ...seen, step };
    try {
      const status = await run();
      return { ...this.#poolState(status), step, outcome: 'done', detail: status.code ?? status.state };
    } catch (error) {
      return { ...seen, step, outcome: 'refused', detail: this.#code(error) };
    }
  }

  /**
   * Whether the stored HOME and Nix directories of this employee's stopped, finished laptop are still the ones the
   * laptop was built on. `unchecked`: there is no stopped, finished laptop to compare, or this office is
   * configured with no verifier at all. `unknown`: a verifier exists and could not tell, or the read itself was
   * refused; the cause says which. Nothing that could not be confirmed is ever reported as `unchecked`.
   */
  async storedHome(employee: SupervisedEmployee, guard: SupervisorGuard): Promise<SupervisorStoredHomeReading> {
    const row = this.#row(employee.id),
      storage = this.deps.storage;
    if (!row || !storage) return { found: 'unchecked' };
    try {
      const authority = this.#authority(employee, guard);
      const seen = await storage.stopped(row, authority.require, this.#storedLayout(row));
      if (seen.state === 'not-stopped' || seen.state === 'no-verifier') return { found: 'unchecked' };
      if (seen.state === 'unconfirmed') return { found: 'unknown', cause: seen.cause };
      if (seen.state === 'renumbered') return { found: 'renumbered', cause: seen.reason };
      return { found: seen.state };
    } catch {
      return { found: 'unknown', cause: 'read-refused' };
    }
  }

  /**
   * Where a rebuild of this laptop would bind its HOME and Nix directories from, and as which user: from the
   * laptop record and the layout the rebuild would use anyway. Asked for a laptop whose container no longer
   * exists, which has no mounts to read. Undefined when there is no layout, or the record's home is not one a
   * rebuild supports: nothing is compared then, and the read stays unknown.
   */
  #storedLayout(row: DockerEmployeeContinuationRecord): DockerStoredHomeLayout | undefined {
    const template = this.#template(row.employeeId);
    if (!template) return undefined;
    try {
      const storage = reprovisionStorage(row, template);
      return { home: storage.home, nix: storage.nix, user: template.user };
    } catch {
      return undefined;
    }
  }

  /** What the office checks of a stored home with the verifier image it is configured with. */
  storedHomeCheck(): 'none' | DockerVerifierCapability {
    return this.deps.storage?.capability?.() ?? 'none';
  }

  /**
   * Record which filesystem the directories of this employee's finished, running laptop are on, so that a later
   * device renumbering can be proved. It is asked for every finished laptop alike: one a set-up made, one a
   * rebuild made and one a plan move made. Attendance is not asked, as for the limits: a laptop that runs has a
   * home, wherever its employee is. `unsupported`: this office has no verifier, or one that was built before the
   * read existed. A configured image that was not in the Engine when the office last looked is asked again: it
   * may have been loaded since, and the first read that answers settles what it can do.
   */
  async rememberHome(
    employee: SupervisedEmployee,
    guard: SupervisorGuard
  ): Promise<'recorded' | 'not-running' | 'not-recorded' | 'unsupported' | 'failed'> {
    const row = this.#row(employee.id),
      storage = this.deps.storage;
    if (!storage?.remember || ['none', 'compare-only'].includes(this.storedHomeCheck())) return 'unsupported';
    if (!row?.destination || !['provider-issued', 'ready'].includes(row.phase)) return 'not-running';
    try {
      return await storage.remember(row, this.#authority(employee, guard).require);
    } catch {
      return 'failed';
    }
  }

  /**
   * Give an employee who has no approved resource limits the owner's standing default, through the save behind the
   * owner's docker-policy route. Inside that save the supervisor's authority, the owner's switch and the default
   * itself are read again: limits that were derived from a state that has moved on are not written.
   */
  async applyStandingLimits(employee: SupervisedEmployee, guard: SupervisorGuard): Promise<SupervisorActionResult> {
    const save = this.deps.store.savePolicy?.bind(this.deps.store);
    if (!save) return { outcome: 'refused', detail: 'this office cannot save resource limits' };
    const derive = () => {
      const state = this.deps.company.store.snapshot();
      const employed = state.employees.find((value) => value.id === employee.id);
      if (!employed || employed.dockerResourcePolicy || !this.#standingEnabled(employee.owner, state)) return undefined;
      return this.#standingLimits(employee.id, state);
    };
    const policy = derive();
    if (!policy) return { outcome: 'refused', detail: 'no standing default limits to give' };
    try {
      const authority = this.#authority(employee, guard),
        digest = dockerContinuationDigest(policy);
      await save(employee.id, employee.owner, policy, () => {
        authority.require();
        const again = derive();
        if (!again || dockerContinuationDigest(again) !== digest)
          throw new CompanyError('The standing default limits changed', 409);
      });
      return { outcome: 'done', detail: 'standing limits ' + digest.slice(0, 12) };
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
   * The office terminal, read again now: why the laptop an agent may run in may not be discarded, or undefined
   * when it may. A turn in progress tried nothing and is waited for; everything else is a refusal. A pane that is
   * not read refuses unless the policy found that it cannot be read and waited the long time for that
   * (`agent-unreadable`). A held input is asked for only where that is the reason (`terminal-input-held`); with no
   * terminal object, as after an office restart, the saved session record says whether it is held. A start-up screen
   * is asked for only where that is the reason (`agent-parked-at-screen`): the pane must still show it by more than
   * its words, and a screen the office is answering itself again is not one an agent is parked on.
   */
  #occupiedRefusal(
    employee: SupervisedEmployee,
    proved: readonly SupervisorPrecondition[]
  ): SupervisorActionResult | undefined {
    const terminal = this.deps.sessions.get(employee.sessionId);
    const onRecord = !terminal && this.deps.inputHeldOnRecord?.(employee.sessionId) === true;
    if (proved.includes('terminal-input-held') && !readSupervisedTerminal(terminal, onRecord).inputHeld)
      return { outcome: 'refused', detail: "the office terminal's input is not held" };
    const { turn } = readTerminalTurn(terminal);
    if (turn === 'working') return { outcome: 'busy', detail: 'the agent is in the middle of a turn' };
    if (proved.includes('agent-parked-at-screen')) {
      const screen = readParkedScreen(terminal).startupScreen;
      if (!screen?.proof || (screen.kind === 'first-run' && screen.answering))
        return { outcome: 'refused', detail: 'the agent is not shown to be parked on a start-up screen' };
    }
    if (turn !== 'idle' && !proved.includes('agent-unreadable'))
      return { outcome: 'refused', detail: "the office is not reading the agent's terminal" };
    return undefined;
  }

  /**
   * Why the running laptops a rebuild would stop may not be discarded, read now; undefined when they may. See the
   * file comment: only the one recorded laptop, and only when it is empty or the policy chose the rebuild between
   * its agent's turns. A read that cannot say what runs there counts as an agent running, never as an empty laptop.
   * The empty candidate of an abandoned plan move is taken off the list first (`#withoutEmptyCandidates`).
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
    if (recorded && SUPERVISOR_OCCUPIED_PROOFS.some((name) => proved.includes(name)))
      return this.#occupiedRefusal(employee, proved);
    return { outcome: 'refused', detail: 'a running laptop is not shown to be empty' };
  }

  /**
   * The owner's rebuild: preview, then apply with the preview's own digest. A pending one is finished instead.
   * `proved` is what the policy asked to be proved for this step; see `#discardRefusal` and the file comment.
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
      // The hold that the rebuild was chosen for is read once more. A laptop that has finished meanwhile is kept.
      if (proved.includes('laptop-held') && (await this.read(employee, guard))?.state === 'ready')
        return { outcome: 'refused', detail: 'the laptop is no longer held' };
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
      // The home the new laptop will be bound to is read once more, last, whatever led to this rebuild: a
      // finished laptop that is stopped is never replaced while its home path holds other directories.
      // Nothing was tried when it stops the step, so the attempt is given back: the next pass reads the home
      // first and waits on what it finds, without spending a round's two rebuilds on a read that gave no answer.
      const home = STORED_HOME_REFUSALS[(await this.storedHome(employee, guard)).found];
      if (home) return { outcome: 'busy', detail: home };
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
