/** Reconcile native pool observations, recover a stopped, empty pool and put a
 * running pool's approved limits back in place, each using its already
 * approved policy. Employee and provider launches use their own workflow. */
import { CompanyService, CompanyError } from './company-service.js';
import { CompanyDockerContinuationStore } from './docker-employee-store.js';
import { DockerContainedResources, DockerPoolReconciliationReceipt } from './docker-contained-resource-controller.js';
import {
  DockerEmployeeContinuationError,
  dockerContinuationDigest,
  type DockerContinuationAuthority,
} from './docker-employee-continuation.js';
import { dockerPoolMetadataDigest, type DockerPoolObservationRecord } from './docker-pool-observation-data.js';
import type { DockerEmployeeContinuationRecord } from './docker-employee-continuation-data.js';
import type { DockerColdPoolJournal } from './docker-cold-pool-journal.js';
import { reprovisionHeads } from './docker-absent-reprovision-data.js';
export interface DockerPoolStatus {
  readonly state: 'retained' | 'reconciliation-required' | 'held';
  readonly sessionId: string;
  readonly sessionGeneration: number;
  readonly code?: string;
  readonly scopeDigest?: string;
  readonly allowedActions: readonly ('reconcile-pool' | 'repair-pool')[];
}
/** Holds of a running pool that re-applying its approved limits settles: the
 * kernel no longer shows them, or no acknowledgement of them survives. */
const REPAIRABLE: ReadonlySet<string> = new Set(['DOCKER_POOL_POLICY_CHANGED', 'DOCKER_POOL_ORIGINAL_ACK_MISSING']);
function refuse(code: string): never {
  throw new DockerEmployeeContinuationError(code);
}
/** One request's view of the employee it acts for and of the pool metadata it started from. */
interface PoolContext {
  readonly original: {
    employeeId: string;
    owner: string | null;
    sessionId: string;
    sessionGeneration: number;
    policy: DockerPoolObservationRecord['poolPolicy'];
  };
  readonly beforeState: ReturnType<CompanyService['store']['snapshot']>;
  readonly beforePool: string;
  current(): void;
  requireSubject(): void;
}
export class DockerPoolReconciliation {
  constructor(
    private readonly company: CompanyService,
    private readonly store: CompanyDockerContinuationStore,
    private readonly resources: DockerContainedResources,
    private readonly runtimeCurrent: () => void,
    private readonly cold?: DockerColdPoolJournal
  ) {
    if (
      !(company instanceof CompanyService) ||
      !(store instanceof CompanyDockerContinuationStore) ||
      !(resources instanceof DockerContainedResources) ||
      store.company !== company
    )
      throw Error('Actual boxed company/resource owners required');
  }
  #context(employeeId: string, authority: DockerContinuationAuthority): PoolContext {
    const subject = () => {
      this.runtimeCurrent();
      authority.require();
      const state = this.company.store.snapshot(),
        rows = state.employees.filter((value) => value.id === employeeId);
      if (rows.length !== 1 || rows[0]!.owner !== authority.owner || rows[0]!.bindingMigration)
        throw new CompanyError('Original recovery employee changed', 409);
      const employee = rows[0]!,
        policy = this.store.policy(employeeId).pool;
      return {
        employeeId,
        owner: employee.owner ?? null,
        sessionId: employee.sessionId,
        sessionGeneration: employee.sessionGeneration,
        policy,
      };
    };
    const original = subject(),
      beforeState = this.company.store.snapshot(),
      beforePool = dockerPoolMetadataDigest(beforeState),
      subjectDigest = dockerContinuationDigest(original);
    const requireSubject = () => {
      if (dockerContinuationDigest(subject()) !== subjectDigest) refuse('DOCKER_POOL_TARGET_CHANGED');
    };
    const current = () => {
      requireSubject();
      if (dockerPoolMetadataDigest(this.company.store.snapshot()) !== beforePool)
        refuse('DOCKER_POOL_CANONICAL_CHANGED');
    };
    return { original, beforeState, beforePool, current, requireSubject };
  }
  #result(
    context: {
      original: {
        employeeId: string;
        owner: string | null;
        sessionId: string;
        sessionGeneration: number;
        policy: DockerPoolObservationRecord['poolPolicy'];
      };
    },
    record: DockerPoolObservationRecord,
    metadataDigest: string
  ): DockerPoolStatus {
    const retained = this.#retained(record);
    return {
      state: retained ? 'retained' : 'reconciliation-required',
      sessionId: context.original.sessionId,
      sessionGeneration: context.original.sessionGeneration,
      scopeDigest: dockerContinuationDigest({ subject: context.original, record, poolMetadata: metadataDigest }),
      ...(retained ? {} : { code: 'DOCKER_POOL_ACK_NOT_RETAINED' }),
      allowedActions: retained ? [] : ['reconcile-pool'],
    };
  }
  #retained(record: DockerPoolObservationRecord): boolean {
    const digest = dockerContinuationDigest(record);
    return this.company.store.snapshot().dockerPoolObservations?.some(
      (value) => dockerContinuationDigest(value) === digest
    ) === true;
  }

  /** The laptop record that names the stopped anchor for a cold recovery: the
   * employee's current one, or, while they have none, the one their last
   * rebuild retired. A rebuild retires the record and keeps the employee, the
   * session and the pool, so the retired record still names the box's one
   * anchor; without it an office whose laptops were all being rebuilt when the
   * host restarted could never start its anchor again. Every native check of
   * the recovery is made against that anchor as it is now. */
  #coldSource(employeeId: string): DockerEmployeeContinuationRecord | undefined {
    const current = this.store.record(employeeId);
    if (current) return current;
    const retired = this.company.store.snapshot().retiredDockerEmployeeContinuations ?? [];
    const heads = reprovisionHeads(retired, employeeId);
    if (heads.length !== 1) return undefined;
    // The newest entry of the one history that retired a record: replacing an unused source retires none.
    let entry: (typeof retired)[number] | undefined = heads[0];
    for (let steps = 0; entry && !entry.record && steps < retired.length; steps++) {
      const previous: string | undefined = entry.previous;
      entry = retired.find((value) => value.employeeId === employeeId && value.operationId === previous);
    }
    return entry?.record;
  }

  #coldContext(employeeId: string, authority: DockerContinuationAuthority) {
    const base = this.#context(employeeId, authority);
    const row = this.#coldSource(employeeId);
    if (!row || row.owner !== authority.owner ||
        row.request.sessionId !== base.original.sessionId ||
        row.request.sessionGeneration !== base.original.sessionGeneration ||
        dockerContinuationDigest(row.policy.pool) !== dockerContinuationDigest(base.original.policy))
      refuse('DOCKER_POOL_COLD_SOURCE_UNCONFIRMED');
    const rowDigest = dockerContinuationDigest(row);
    const requireSource = () => {
      authority.requireOffice();
      if (this.company.store.publicationUnconfirmed ||
          dockerContinuationDigest(this.#coldSource(employeeId) ?? null) !== rowDigest)
        refuse('DOCKER_POOL_COLD_SOURCE_CHANGED');
      if (this.company.store.snapshot().employees.some(employee => employee.dockerResourcePolicy &&
          dockerContinuationDigest(employee.dockerResourcePolicy.pool) !== dockerContinuationDigest(row.policy.pool)))
        refuse('DOCKER_POOL_COLD_POLICY_CHANGED');
    };
    const current = () => { base.current(); requireSource(); };
    current();
    return { base, row, requireSource, current };
  }

  async coldPreview(employeeId: string, authority: DockerContinuationAuthority) {
    if (!this.cold) refuse('DOCKER_POOL_COLD_RECOVERY_UNAVAILABLE');
    this.cold.requireIdle();
    const context = this.#coldContext(employeeId, authority);
    const native = await this.resources.coldPoolScope(context.row, context.current);
    return {
      sessionId: context.base.original.sessionId,
      sessionGeneration: context.base.original.sessionGeneration,
      scopeDigest: dockerContinuationDigest({ subject: context.base.original, prior: context.base.beforePool, native: native.digest }),
      policy: context.base.original.policy,
    };
  }

  async coldRecover(
    employeeId: string,
    input: { operationId: string; sessionId: string; sessionGeneration: number; expectedScopeDigest: string },
    authority: DockerContinuationAuthority,
  ): Promise<DockerPoolStatus> {
    if (!this.cold) refuse('DOCKER_POOL_COLD_RECOVERY_UNAVAILABLE');
    this.cold.requireIdle();
    const context = this.#coldContext(employeeId, authority);
    const { base } = context;
    if (input.sessionId !== base.original.sessionId || input.sessionGeneration !== base.original.sessionGeneration)
      refuse('DOCKER_POOL_TARGET_CHANGED');
    const native = await this.resources.coldPoolScope(context.row, context.current);
    const scopeDigest = dockerContinuationDigest({ subject: base.original, prior: base.beforePool, native: native.digest });
    if (input.expectedScopeDigest !== scopeDigest) refuse('DOCKER_POOL_COLD_SOURCE_CHANGED');
    let published: DockerPoolObservationRecord | undefined;
    const current = () => {
      if (published) {
        base.requireSubject();
        context.requireSource();
        if (!this.#retained(published)) refuse('DOCKER_POOL_CANONICAL_CHANGED');
      } else context.current();
    };
    return this.cold.issue({
      operationId: input.operationId, employeeId, sessionId: input.sessionId,
      sessionGeneration: input.sessionGeneration, scopeDigest,
    }, current, async (journal, confirm) => {
      const receipt = await this.resources.recoverColdPool(context.row, {
        id: input.operationId, nativeDigest: native.digest,
      }, journal, current);
      const observation = DockerPoolReconciliationReceipt.prototype.snapshot.call(receipt, current);
      const saved = await this.company.store.publishDockerPoolObservation(receipt, base.beforePool, current);
      if (saved.state === 'not-issued') throw saved.cause;
      if (saved.state === 'unconfirmed') refuse('DOCKER_POOL_PUBLICATION_UNCONFIRMED');
      published = observation;
      current();
      confirm(dockerContinuationDigest(observation));
      return this.#result(base, observation, dockerPoolMetadataDigest(this.company.store.snapshot()));
    });
  }

  /** Removes the anchor of the shared pool while the Engine reports it dead,
   * so that the pool can be set up again: a dead container can be neither
   * started nor used, and no laptop set-up can create an anchor under its
   * name while it stands. The same source checks as a cold recovery apply:
   * the employee's own laptop record names this anchor under the pool policy
   * every employee is approved with, and no cold recovery is unfinished. The
   * resource controller proves the rest (`removeDeadPoolAnchor`). Nothing of
   * any employee, record or pool observation is changed.
   * `removed`: the anchor is gone and the next laptop set-up creates one.
   * `refused`: the Engine would not remove it, in its own words. */
  async removeDeadAnchor(
    employeeId: string,
    authority: DockerContinuationAuthority
  ): Promise<{ state: 'removed' } | { state: 'refused'; engine: string }> {
    if (!this.cold) refuse('DOCKER_POOL_COLD_RECOVERY_UNAVAILABLE');
    const cold = this.cold;
    cold.requireIdle();
    const context = this.#coldContext(employeeId, authority);
    const current = () => {
      context.current();
      cold.requireIdle();
    };
    const result = await this.resources.removeDeadPoolAnchor(context.row, current);
    return result.removed ? { state: 'removed' } : { state: 'refused', engine: result.engine };
  }

  /** The one cold recovery that was issued and has not finished, when there
   * is one. DATA only: the employee and session it was issued for. */
  coldHeld(): { employeeId: string; sessionId: string; sessionGeneration: number; operationId: string } | undefined {
    const held = this.cold?.held();
    return held && {
      employeeId: held.employeeId, sessionId: held.sessionId, sessionGeneration: held.sessionGeneration,
      operationId: held.operationId,
    };
  }

  /** Finishes the one unfinished cold recovery as itself. Nothing it already
   * issued is issued again: its anchor START is repeated only when every
   * native fact is still exactly what the attempt was issued for, for the same
   * employee, and its helper is observed under its own cursor. An employee
   * other than the one it was issued for can finish it and can never restart
   * it: the scope it was issued for names its own employee.
   * The attempt then ends one of two ways. A confirmed pool is published and
   * closes it, as a recovery that never stopped does. An attempt that can
   * write nothing more and confirmed nothing is recorded as ended; the pool is
   * then read again like any other, and a new recovery may be previewed.
   * Anything that cannot be proved leaves the attempt held. */
  async coldResume(employeeId: string, authority: DockerContinuationAuthority): Promise<DockerPoolStatus> {
    if (!this.cold) refuse('DOCKER_POOL_COLD_RECOVERY_UNAVAILABLE');
    if (!this.cold.held()) return this.status(employeeId, authority);
    const context = this.#coldContext(employeeId, authority);
    const { base } = context;
    let published: DockerPoolObservationRecord | undefined;
    const current = () => {
      if (published) {
        base.requireSubject();
        context.requireSource();
        if (!this.#retained(published)) refuse('DOCKER_POOL_CANONICAL_CHANGED');
      } else context.current();
    };
    const subject = (native: string) =>
      dockerContinuationDigest({ subject: base.original, prior: base.beforePool, native });
    const result = await this.cold.resume(current, async (attempt) => {
      const receipt = await this.resources.resumeColdPool(context.row, {
        id: attempt.scope.operationId, issuedFor: (native) => subject(native) === attempt.scope.scopeDigest,
      }, attempt.journal, current);
      if (!receipt || attempt.journal.read(context.row, 'pool-helper')?.phase !== 'completed') {
        attempt.end();
        return undefined;
      }
      const observation = DockerPoolReconciliationReceipt.prototype.snapshot.call(receipt, current);
      if (!this.#retained(observation)) {
        const saved = await this.company.store.publishDockerPoolObservation(receipt, base.beforePool, current);
        if (saved.state === 'not-issued') throw saved.cause;
        if (saved.state === 'unconfirmed') refuse('DOCKER_POOL_PUBLICATION_UNCONFIRMED');
      }
      published = observation;
      current();
      attempt.confirm(dockerContinuationDigest(observation));
      return this.#result(base, observation, dockerPoolMetadataDigest(this.company.store.snapshot()));
    });
    return result ?? this.status(employeeId, authority);
  }

  /** A plan move may read an already-reconciled source pool. The original
   * anchor task and source record retain their historical process identity. */
  async requirePlanSourcePool(
    source: Pick<DockerEmployeeContinuationRecord, 'pool' | 'policy' | 'tasks'>,
    current: () => void
  ): Promise<void> {
    const historic = source.tasks?.find((task) => task.role === 'anchor');
    if (!source.pool || historic?.phase !== 'running' || historic.containerId !== source.pool.containerId ||
        source.pool.policyDigest !== dockerContinuationDigest(source.policy.pool))
      refuse('DOCKER_POOL_SOURCE_CHANGED');
    const check = () => {
      current();
      this.runtimeCurrent();
      this.cold?.requireIdle();
      if (this.company.store.publicationUnconfirmed) refuse('DOCKER_POOL_PUBLICATION_UNCONFIRMED');
    };
    check();
    const receipt = await this.#capture(source.policy.pool, check);
    const observed = DockerPoolReconciliationReceipt.prototype.snapshot.call(receipt, check);
    if (
      observed.anchorTask.containerId !== historic.containerId ||
      observed.anchorTask.imageId !== historic.imageId ||
      observed.anchorTask.name !== historic.name ||
      observed.anchorTask.configurationDigest !== historic.configurationDigest ||
      observed.epoch.parent.path !== '/reverie.slice/reverie-box.slice/' + source.pool.cgroupParent ||
      !this.#retained(observed)
    ) refuse('DOCKER_POOL_SOURCE_RECONCILIATION_REQUIRED');
    DockerPoolReconciliationReceipt.prototype.require.call(receipt);
    check();
  }
  async #capture(
    policy: DockerPoolObservationRecord['poolPolicy'],
    current: () => void
  ): Promise<DockerPoolReconciliationReceipt> {
    try {
      return await this.resources.capturePoolObservation(policy, current);
    } catch (cause) {
      // Revoked authority/currency is NOT laundered into a native read failure.
      current();
      if (cause instanceof DockerEmployeeContinuationError) throw cause;
      throw new DockerEmployeeContinuationError('DOCKER_POOL_OBSERVATION_UNCONFIRMED', 409, { cause });
    }
  }
  async status(employeeId: string, authority: DockerContinuationAuthority): Promise<DockerPoolStatus> {
    const context = this.#context(employeeId, authority);
    if (this.company.store.publicationUnconfirmed)
      return {
        state: 'held',
        sessionId: context.original.sessionId,
        sessionGeneration: context.original.sessionGeneration,
        code: 'DOCKER_POOL_PUBLICATION_UNCONFIRMED',
        allowedActions: [],
      };
    try {
      this.cold?.requireIdle();
      const receipt = await this.#capture(context.original.policy, context.current);
      context.current();
      const record = DockerPoolReconciliationReceipt.prototype.snapshot.call(receipt, context.current);
      return this.#result(context, record, context.beforePool);
    } catch (cause) {
      context.current();
      const code = cause instanceof DockerEmployeeContinuationError ? cause.code : 'DOCKER_POOL_OBSERVATION_UNCONFIRMED';
      // The repair re-applies exactly the policy this status was read with. Its
      // digest binds the request to this employee, this hold and this record.
      const repairable = REPAIRABLE.has(code) && this.#repairSource(employeeId, context) !== undefined;
      return {
        state: 'held',
        sessionId: context.original.sessionId,
        sessionGeneration: context.original.sessionGeneration,
        code,
        ...(repairable
          ? { scopeDigest: dockerContinuationDigest({ subject: context.original, code, poolMetadata: context.beforePool }) }
          : {}),
        allowedActions: repairable ? ['repair-pool'] : [],
      };
    }
  }
  /** The laptop record whose recorded anchor and approved pool policy a repair
   * acts for. Undefined when this employee has none that names the one policy
   * every employee of the box is approved with. */
  #repairSource(employeeId: string, context: PoolContext): DockerEmployeeContinuationRecord | undefined {
    const row = this.store.record(employeeId),
      policy = dockerContinuationDigest(context.original.policy);
    if (
      !row ||
      row.version === 3 ||
      (row.owner ?? null) !== context.original.owner ||
      row.request.sessionId !== context.original.sessionId ||
      row.request.sessionGeneration !== context.original.sessionGeneration ||
      dockerContinuationDigest(row.policy.pool) !== policy ||
      this.company.store
        .snapshot()
        .employees.some(
          (employee) =>
            employee.dockerResourcePolicy && dockerContinuationDigest(employee.dockerResourcePolicy.pool) !== policy
        )
    )
      return undefined;
    return row;
  }
  /** Puts the already approved limits of the running shared pool back in
   * place and records its observation. No laptop is stopped or recreated, and
   * the approved policy is read, never written. A repeated request finds
   * nothing left to do and answers with the pool's status. */
  async repair(
    employeeId: string,
    input: { sessionId: string; sessionGeneration: number; expectedScopeDigest: string },
    authority: DockerContinuationAuthority
  ): Promise<DockerPoolStatus> {
    const context = this.#context(employeeId, authority);
    if (
      input.sessionId !== context.original.sessionId ||
      input.sessionGeneration !== context.original.sessionGeneration
    )
      refuse('DOCKER_POOL_TARGET_CHANGED');
    if (this.company.store.publicationUnconfirmed) refuse('DOCKER_POOL_PUBLICATION_UNCONFIRMED');
    const before = await this.status(employeeId, authority);
    if (!before.allowedActions.includes('repair-pool')) return before;
    if (input.expectedScopeDigest !== before.scopeDigest) refuse('DOCKER_POOL_SCOPE_CHANGED');
    const row = this.#repairSource(employeeId, context);
    if (!row) refuse('DOCKER_POOL_REPAIR_SOURCE_UNCONFIRMED');
    const source = dockerContinuationDigest({ ...row, tasks: undefined, ephemeralRestoration: undefined });
    const ready = () => {
      context.current();
      this.cold?.requireIdle();
      const actual = this.store.record(employeeId);
      if (
        this.company.store.publicationUnconfirmed ||
        !actual ||
        dockerContinuationDigest({ ...actual, tasks: undefined, ephemeralRestoration: undefined }) !== source ||
        !this.#repairSource(employeeId, context)
      )
        refuse('DOCKER_POOL_REPAIR_SOURCE_CHANGED');
    };
    ready();
    await this.resources.repairPool(row, ready);
    ready();
    const receipt = await this.#capture(context.original.policy, ready);
    const record = DockerPoolReconciliationReceipt.prototype.snapshot.call(receipt, ready);
    if (this.#retained(record)) return this.#result(context, record, context.beforePool);
    return this.#publish(context, receipt, record, ready);
  }
  async reconcile(
    employeeId: string,
    input: { sessionId: string; sessionGeneration: number; expectedScopeDigest: string },
    authority: DockerContinuationAuthority
  ): Promise<DockerPoolStatus> {
    const context = this.#context(employeeId, authority);
    const ready = () => {
      context.current();
      this.cold?.requireIdle();
    };
    if (
      input.sessionId !== context.original.sessionId ||
      input.sessionGeneration !== context.original.sessionGeneration
    )
      refuse('DOCKER_POOL_TARGET_CHANGED');
    if (this.company.store.publicationUnconfirmed) refuse('DOCKER_POOL_PUBLICATION_UNCONFIRMED');
    const receipt = await this.#capture(context.original.policy, ready);
    const record = DockerPoolReconciliationReceipt.prototype.snapshot.call(receipt, ready);
    const expected = this.#result(context, record, context.beforePool).scopeDigest;
    if (input.expectedScopeDigest !== expected) refuse('DOCKER_POOL_SCOPE_CHANGED');
    return this.#publish(context, receipt, record, ready);
  }
  /** Records one fresh native observation through the canonical writer. */
  async #publish(
    context: PoolContext,
    receipt: DockerPoolReconciliationReceipt,
    record: DockerPoolObservationRecord,
    ready: () => void
  ): Promise<DockerPoolStatus> {
    ready();
    const result = await this.company.store.publishDockerPoolObservation(receipt, context.beforePool, ready);
    if (result.state === 'not-issued') throw result.cause;
    if (result.state === 'unconfirmed') refuse('DOCKER_POOL_PUBLICATION_UNCONFIRMED');
    context.requireSubject();
    const current = this.company.store.snapshot();
    const existing = context.beforeState.dockerPoolObservations ?? [];
    const before = {
      ...context.beforeState,
      dockerPoolObservations: existing.some(
        (value) => value.configuration.containerId === record.configuration.containerId
      )
        ? existing
        : [...existing, record],
    };
    if (dockerPoolMetadataDigest(current) !== dockerPoolMetadataDigest(before)) refuse('DOCKER_POOL_CANONICAL_CHANGED');
    return this.#result(context, record, dockerPoolMetadataDigest(current));
  }
}
