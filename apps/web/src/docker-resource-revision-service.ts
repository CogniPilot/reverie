/** Owner-approved Docker leaf-only revisions. No employee/launch-row mutation, paid admission or host broker. */
import { boundedDockerResourceVisits } from './docker-resource-convergence.js';
import { dockerResourceScope } from './docker-resource-revisions.js';
import { isDeepStrictEqual } from 'node:util';
import { CompanyService, CompanyError } from './company-service.js';
import type { CompanyEmployee } from './company-types.js';
import { CompanyDockerContinuationStore } from './docker-employee-store.js';
import { DockerEmployeeProviderHealthProof, DockerEmployeeEngine } from './docker-employee-engine.js';
import { DockerContainedResources } from './docker-contained-resource-controller.js';
import { DockerEmployeeContinuationError, dockerContinuationDigest } from './docker-employee-continuation.js';
import {
  DockerResourceRevisionStore,
  DockerResourceDesiredRevision,
  dockerRevisedPolicy,
} from './docker-resource-revisions.js';
export type DockerResourceConvergence = {
  readonly employeeId: string;
  readonly state:
    | 'no-desired-policy'
    | 'offline-or-unbound'
    | 'pending-provider'
    | 'settled-history'
    | 'observed'
    | 'applied';
};
export class DockerResourceRevisionService {
  readonly #converging = new Map<string, Promise<DockerResourceConvergence>>();
  readonly #failures = new Map<string, { scope: string; revision: string; code: string }>();

  constructor(
    readonly company: CompanyService,
    readonly store: CompanyDockerContinuationStore,
    readonly revisions: DockerResourceRevisionStore,
    private readonly resources: DockerContainedResources,
    private readonly engine: DockerEmployeeEngine
  ) {
    if (
      !(company instanceof CompanyService) ||
      !(store instanceof CompanyDockerContinuationStore) ||
      !(revisions instanceof DockerResourceRevisionStore) ||
      !(resources instanceof DockerContainedResources) ||
      !(engine instanceof DockerEmployeeEngine) ||
      store.company !== company
    )
      throw Error('Actual Docker resource composition required');
  }
  async approve(input: DockerResourceDesiredRevision, expectedRevision: string | null, current: () => void) {
    const desired = DockerResourceDesiredRevision.parse(input);
    current();
    await this.revisions.approve(desired, expectedRevision, current);
    current();
    return { desired, enforcement: 'not-observed' as const };
  }
  status(owner: string | undefined, current: () => void) {
    current();
    const desired = this.revisions.desired(owner);
    const employees = this.company.registeredEmployees().filter((employee) => employee.owner === owner);
    if (employees.length > 256) throw new DockerEmployeeContinuationError('DOCKER_RESOURCE_REVISION_CAPACITY');
    const inventory = this.store.resourceInventory();
    const results = employees.map((employee) => {
      const row = inventory.find((value) => value.employeeId === employee.id);
      const attempt = row && desired ? this.revisions.attempt(row, desired.revision) : undefined;
      const failure = this.#failures.get(employee.id);
      const code =
        failure && row && desired && failure.scope === dockerResourceScope(row) && failure.revision === desired.revision
          ? failure.code
          : undefined;
      return {
        employeeId: employee.id,
        ...(code ? { code } : {}),
        sessionId: employee.sessionId,
        sessionGeneration: employee.sessionGeneration,
        desiredMemoryHighBytes: desired?.memoryHighBytes ?? null,
        state: attempt?.state ?? (row ? 'not-observed' : 'offline-or-unbound'),
        // Prior successful observations are history; status itself performs no kernel probe.
        enforcement: 'not-observed' as const,
      };
    });
    current();
    return { desired: desired ?? null, employees: results };
  }
  /** Durable owner approval, not a caller/title permission. No HTTP endpoint invokes this with worker authority. */
  converge(employeeId: string, runtimeCurrent: () => void): Promise<DockerResourceConvergence> {
    const pending = this.#converging.get(employeeId);
    if (pending) return pending;
    const work = this.#converge(employeeId, runtimeCurrent).finally(() => this.#converging.delete(employeeId));
    this.#converging.set(employeeId, work);
    return work;
  }
  async #converge(employeeId: string, runtimeCurrent: () => void): Promise<DockerResourceConvergence> {
    runtimeCurrent();
    const initial = this.company.registeredEmployees().find((employee) => employee.id === employeeId);
    if (
      !initial ||
      initial.onVacation ||
      initial.desiredRunning !== true ||
      initial.bindingMigration ||
      !initial.dockerBinding
    )
      return { employeeId, state: 'offline-or-unbound' };
    const desired = this.revisions.desired(initial.owner);
    if (!desired) return { employeeId, state: 'no-desired-policy' };
    const row = this.store.resourceInventory().find((record) => record.employeeId === employeeId);
    if (!row || !['provider-issued', 'ready'].includes(row.phase)) return { employeeId, state: 'pending-provider' };
    const scope = dockerResourceScope(row);
    try {
      const attempt = this.revisions.attempt(row, desired.revision);
      if (row.policy.memoryHighBytes === desired.memoryHighBytes || (attempt && attempt.state !== 'helper')) {
        this.#failures.delete(employeeId);
        // History is not a new kernel observation; wake/profile reads independently earn current facts.
        return { employeeId, state: 'settled-history' };
      }
      const captured = this.#capture(employeeId, initial.owner, runtimeCurrent);
      // provider-issued precedes paid dispatch. Double ABSENT never authorizes a resource writer while it is in flight.
      const proof = await this.engine.captureProviderHealth(
        captured.row,
        captured.employee.dockerBinding!,
        captured.current
      );
      captured.current();
      if (DockerEmployeeProviderHealthProof.prototype.require.call(proof, captured.employee) !== 'live')
        return { employeeId, state: 'pending-provider' };
      const current = () => {
        captured.current();
        const now = this.revisions.desired(initial.owner);
        if (!isDeepStrictEqual(now, desired))
          throw new DockerEmployeeContinuationError('DOCKER_RESOURCE_REVISION_CHANGED');
        DockerEmployeeProviderHealthProof.prototype.require.call(proof, captured.employee);
      };
      current();
      const result = await this.apply(employeeId, initial.owner, desired.revision, current);
      current();
      this.#failures.delete(employeeId);
      return { employeeId, state: result.state };
    } catch (error) {
      const code =
        error instanceof DockerEmployeeContinuationError ? error.code : 'DOCKER_RESOURCE_REVISION_UNCONFIRMED';
      this.#failures.set(employeeId, { scope, revision: desired.revision, code });
      throw error;
    }
  }
  async convergeAll(runtimeCurrent: () => void): Promise<PromiseSettledResult<DockerResourceConvergence>[]> {
    runtimeCurrent();
    const ids = this.company
      .registeredEmployees()
      .filter(
        (employee) =>
          !employee.onVacation &&
          employee.desiredRunning === true &&
          !employee.bindingMigration &&
          employee.dockerBinding &&
          this.revisions.desired(employee.owner)
      )
      .map((employee) => employee.id);
    const result = await boundedDockerResourceVisits(ids, (id) => this.converge(id, runtimeCurrent));
    runtimeCurrent();
    return result;
  }
  #capture(employeeId: string, owner: string | undefined, authority: () => void) {
    authority();
    const employee = this.company.employeeForSession(
      this.company.registeredEmployees().find((value) => value.id === employeeId && value.owner === owner)?.sessionId ??
        '',
      owner
    );
    const row = this.store
      .resourceInventory()
      .find((value) => value.employeeId === employeeId && value.owner === owner);
    if (
      !employee ||
      !row ||
      !row.destination ||
      !employee.dockerBinding ||
      !['provider-issued', 'ready'].includes(row.phase)
    )
      throw new CompanyError('Current bound Docker employee required', 409);
    const employeeDigest = dockerContinuationDigest(employee),
      rowDigest = dockerContinuationDigest(row);
    const grant = this.company.recoveryAction(employeeId, owner); // actual owner target/binding currency; not a worker grant
    let revoked = false;
    const current = () => {
      if (revoked) throw new DockerEmployeeContinuationError('DOCKER_RESOURCE_REVISION_CHANGED');
      try {
        authority();
        grant.require();
        const live: CompanyEmployee | undefined = this.company.employeeForSession(employee.sessionId, owner);
        const actual = this.store
          .resourceInventory()
          .find((value) => value.employeeId === employeeId && value.owner === owner);
        if (
          !live ||
          live.bindingMigration ||
          dockerContinuationDigest(live) !== employeeDigest ||
          !actual ||
          dockerContinuationDigest(actual) !== rowDigest ||
          !isDeepStrictEqual(live.dockerBinding, employee.dockerBinding)
        )
          throw new DockerEmployeeContinuationError('DOCKER_RESOURCE_REVISION_CHANGED');
      } catch (error) {
        revoked = true;
        throw error;
      }
    };
    current();
    return { employee, row, current };
  }
  async observe(employeeId: string, owner: string | undefined, authority: () => void) {
    const { employee, row, current } = this.#capture(employeeId, owner, authority);
    await this.engine.verifyResourceDestination(row, current);
    current();
    const actual = await this.resources.observeMemoryHigh(row, current);
    current();
    await this.engine.verifyResourceDestination(row, current);
    current();
    const desired = this.revisions.desired(owner);
    current();
    return {
      employeeId,
      sessionId: employee.sessionId,
      sessionGeneration: employee.sessionGeneration,
      operationId: row.request.operationId,
      containerId: row.destination!.containerId,
      desiredMemoryHighBytes: desired?.memoryHighBytes ?? null,
      revision: desired?.revision ?? null,
      ...actual,
      enforcement: 'fresh-native-readback' as const,
    };
  }
  async apply(employeeId: string, owner: string | undefined, revision: string, authority: () => void) {
    const { employee, row, current } = this.#capture(employeeId, owner, authority);
    const desired = this.revisions.desired(owner);
    if (!desired || desired.revision !== revision)
      throw new DockerEmployeeContinuationError('DOCKER_RESOURCE_REVISION_CHANGED');
    dockerRevisedPolicy(row.policy, desired);
    await this.engine.verifyResourceDestination(row, current);
    current();
    const result = await this.resources.reviseMemoryHigh(row, revision, current);
    current();
    await this.engine.verifyResourceDestination(row, current);
    current();
    return {
      employeeId,
      sessionId: employee.sessionId,
      sessionGeneration: employee.sessionGeneration,
      operationId: row.request.operationId,
      containerId: row.destination!.containerId,
      revision,
      ...result,
      enforcement: 'fresh-native-readback' as const,
    };
  }
}
