/** Observe/repair only original native pool ACK correlation. No paid/worker/
 * provider or resource-policy mutation is available through this service. */
import { CompanyService, CompanyError } from './company-service.js';
import { CompanyDockerContinuationStore } from './docker-employee-store.js';
import { DockerContainedResources, DockerPoolReconciliationReceipt } from './docker-contained-resource-controller.js';
import {
  DockerEmployeeContinuationError,
  dockerContinuationDigest,
  type DockerContinuationAuthority,
} from './docker-employee-continuation.js';
import { dockerPoolMetadataDigest, type DockerPoolObservationRecord } from './docker-pool-observation-data.js';
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
    private readonly runtimeCurrent: () => void
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
    const retained =
      this.company.store
        .snapshot()
        .dockerPoolObservations?.some(
          (value) => dockerContinuationDigest(value) === dockerContinuationDigest(record)
        ) === true;
    return {
      state: retained ? 'retained' : 'reconciliation-required',
      sessionId: context.original.sessionId,
      sessionGeneration: context.original.sessionGeneration,
      scopeDigest: dockerContinuationDigest({ subject: context.original, record, poolMetadata: metadataDigest }),
      ...(retained ? {} : { code: 'DOCKER_POOL_ACK_NOT_RETAINED' }),
      allowedActions: retained ? [] : ['reconcile-pool'],
    };
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
    if (
      input.sessionId !== context.original.sessionId ||
      input.sessionGeneration !== context.original.sessionGeneration
    )
      refuse('DOCKER_POOL_TARGET_CHANGED');
    if (this.company.store.publicationUnconfirmed) refuse('DOCKER_POOL_PUBLICATION_UNCONFIRMED');
    const receipt = await this.#capture(context.original.policy, context.current);
    const record = DockerPoolReconciliationReceipt.prototype.snapshot.call(receipt, context.current);
    const expected = this.#result(context, record, context.beforePool).scopeDigest;
    if (input.expectedScopeDigest !== expected) refuse('DOCKER_POOL_SCOPE_CHANGED');
    context.current();
    const result = await this.company.store.publishDockerPoolObservation(receipt, context.beforePool, context.current);
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
