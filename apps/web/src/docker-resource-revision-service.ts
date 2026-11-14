/** Owner-approved Docker leaf-only revisions. No employee/launch-row mutation, paid admission or host broker. */
import { isDeepStrictEqual } from 'node:util';
import { CompanyService, CompanyError } from './company-service.js';
import type { CompanyEmployee } from './company-types.js';
import { CompanyDockerContinuationStore } from './docker-employee-store.js';
import { DockerEmployeeEngine } from './docker-employee-engine.js';
import { DockerContainedResources } from './docker-contained-resource-controller.js';
import { DockerEmployeeContinuationError, dockerContinuationDigest } from './docker-employee-continuation.js';
import {
  DockerResourceRevisionStore,
  DockerResourceDesiredRevision,
  dockerRevisedPolicy,
} from './docker-resource-revisions.js';
export class DockerResourceRevisionService {
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
      return {
        employeeId: employee.id,
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
