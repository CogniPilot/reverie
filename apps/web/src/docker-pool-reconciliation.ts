/** Reconcile native pool observations and recover a stopped, empty pool using
 * its approved policy. Employee and provider launches use their own workflow. */
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
export interface DockerPoolStatus {
  readonly state: 'retained' | 'reconciliation-required' | 'held';
  readonly sessionId: string;
  readonly sessionGeneration: number;
  readonly code?: string;
  readonly scopeDigest?: string;
  readonly allowedActions: readonly 'reconcile-pool'[];
}
function refuse(code: string): never {
  throw new DockerEmployeeContinuationError(code);
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
  #context(employeeId: string, authority: DockerContinuationAuthority) {
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

  #coldContext(employeeId: string, authority: DockerContinuationAuthority) {
    const base = this.#context(employeeId, authority);
    const row = this.store.record(employeeId);
    if (!row || row.owner !== authority.owner ||
        row.request.sessionId !== base.original.sessionId ||
        row.request.sessionGeneration !== base.original.sessionGeneration ||
        dockerContinuationDigest(row.policy.pool) !== dockerContinuationDigest(base.original.policy))
      refuse('DOCKER_POOL_COLD_SOURCE_UNCONFIRMED');
    const rowDigest = dockerContinuationDigest(row);
    const requireSource = () => {
      authority.requireOffice();
      if (this.company.store.publicationUnconfirmed ||
          dockerContinuationDigest(this.store.record(employeeId) ?? null) !== rowDigest)
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
      return {
        state: 'held',
        sessionId: context.original.sessionId,
        sessionGeneration: context.original.sessionGeneration,
        code: cause instanceof DockerEmployeeContinuationError ? cause.code : 'DOCKER_POOL_OBSERVATION_UNCONFIRMED',
        allowedActions: [],
      };
    }
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
