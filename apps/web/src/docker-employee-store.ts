import { EphemeralRestoration, allowedEphemeralTransition } from './docker-ephemeral-data.js';
import { retainedDockerPoolTasks } from './docker-shared-pool-lineage.js';
import {
  dockerEmployeeSourceDigest,
  dockerEmployeeProviderSourceDigest,
  legacyDockerProviderSourceMatches,
} from './docker-employee-source-correlation.js';
export {
  dockerEmployeeSourceDigest,
  dockerEmployeeProviderSourceDigest,
} from './docker-employee-source-correlation.js';
import {
  DockerContinuationTask,
  type DockerContinuationTaskRole,
  type DockerContinuationTaskJournal,
  allowedDockerTaskTransition,
} from './docker-continuation-task.js';
/** Adapter to the existing canonical CompanyStore writer. No private-file rewrite
 * or competing writable journal. Saved runtime references remain unchanged.
 */
import { isDeepStrictEqual } from 'node:util';
import { CompanyService, CompanyError } from './company-service.js';
import type { CompanyEmployee, CompanyState } from './company-types.js';
import type { SessionState } from './types.js';
import { ownerStopPending } from './owner-stop-journal.js';
import {
  DockerEmployeeResourcePolicy,
  type DockerEmployeeBinding,
  DockerEmployeeContinuationRecord,
} from './docker-employee-continuation-data.js';
import {
  dockerContinuationDigest,
  type DockerContinuationStore,
  type DockerContinuationSubject,
} from './docker-employee-continuation.js';
function boundProviderRecord(employee: CompanyEmployee, row: DockerEmployeeContinuationRecord): boolean {
  const binding = employee.dockerBinding,
    destination = row.destination;
  return Boolean(
    employee.id === row.employeeId &&
    employee.owner === row.owner &&
    employee.sessionId === row.request.sessionId &&
    employee.sessionGeneration === row.request.sessionGeneration &&
    binding &&
    destination &&
    ['identity-ready', 'provider-issued', 'ready'].includes(row.phase) &&
    binding.operationId === row.request.operationId &&
    binding.credentialId === row.credentialId &&
    binding.sessionId === row.request.sessionId &&
    binding.sessionGeneration === row.request.sessionGeneration &&
    binding.containerId === destination.containerId &&
    binding.imageId === destination.imageId &&
    binding.originalDigest === dockerContinuationDigest(destination) &&
    binding.policyDigest === dockerContinuationDigest(row.policy)
  );
}
function persistedRecord(row: DockerEmployeeContinuationRecord): DockerEmployeeContinuationRecord {
  return DockerEmployeeContinuationRecord.parse(JSON.parse(JSON.stringify(row)));
}
export class CompanyDockerContinuationStore implements DockerContinuationStore, DockerContinuationTaskJournal {
  constructor(
    readonly company: CompanyService,
    private readonly saved: (id: string) => SessionState | undefined,
    private readonly defaultPolicy?: (
      owner: string | undefined,
      policy: DockerEmployeeResourcePolicy
    ) => DockerEmployeeResourcePolicy
  ) {
    if (!(company instanceof CompanyService)) throw Error('Actual company service required');
  }
  subject(employeeId: string): DockerContinuationSubject | undefined {
    return this.subjectFromSnapshot(employeeId, this.company.store.view());
  }
  private subjectFromSnapshot(employeeId: string, state: CompanyState): DockerContinuationSubject | undefined {
    const rows = state.employees.filter((e) => e.id === employeeId),
      employee = rows[0];
    if (
      rows.length !== 1 ||
      !employee ||
      employee.bindingMigration ||
      state.employees.filter((e) => e.sessionId === employee.sessionId).length !== 1 ||
      !this.company.employeeRecoveryAvailable(employeeId, employee.owner, state) ||
      ownerStopPending(employee.sessionId)
    )
      return;
    const saved = this.saved(employee.sessionId);
    if (
      !saved ||
      saved.id !== employee.sessionId ||
      saved.owner !== employee.owner ||
      saved.remote ||
      saved.providerDispatchHeld ||
      saved.terminalInputHeld
    )
      return;
    if (saved.docker && (!employee.dockerBinding || saved.docker.containerName !== employee.dockerBinding.containerId))
      return;
    return {
      employeeId,
      sessionId: employee.sessionId,
      sessionGeneration: employee.sessionGeneration,
      owner: employee.owner,
      sourceDigest: dockerEmployeeSourceDigest(employee, saved),
      providerSourceDigest: dockerEmployeeProviderSourceDigest(employee, saved),
      onVacation: employee.onVacation,
      desiredRunning: employee.desiredRunning,
    };
  }
  /** Existing-provider correlation is not authority for another launch. */
  existingSubject(employeeId: string, row: DockerEmployeeContinuationRecord): DockerContinuationSubject | undefined {
    const state = this.company.store.view(),
      subject = this.subjectFromSnapshot(employeeId, state);
    const rows = state.dockerEmployeeContinuations?.filter((value) => value.employeeId === employeeId) ?? [];
    const employee = state.employees.find((value) => value.id === employeeId);
    if (
      !subject ||
      !employee ||
      rows.length !== 1 ||
      !isDeepStrictEqual(rows[0], row) ||
      !['provider-issued', 'ready'].includes(row.phase) ||
      !boundProviderRecord(employee, row)
    )
      return;
    const saved = this.saved(employee.sessionId);
    if (!saved) return;
    const matches =
      row.version !== 1
        ? row.providerSourceDigest === subject.providerSourceDigest
        : legacyDockerProviderSourceMatches(employee, saved, row.sourceDigest);
    return matches ? subject : undefined;
  }
  private migrationSource(row: DockerEmployeeContinuationRecord, state: CompanyState) {
    const employees = state.employees.filter((value) => value.id === row.employeeId),
      employee = employees[0];
    const saved = employee && this.saved(employee.sessionId);
    if (
      employees.length !== 1 ||
      !employee ||
      !saved ||
      employee.bindingMigration ||
      state.employees.filter((value) => value.sessionId === employee.sessionId).length !== 1 ||
      saved.id !== employee.sessionId ||
      saved.owner !== employee.owner ||
      employee.owner !== row.owner ||
      employee.sessionId !== row.request.sessionId ||
      employee.sessionGeneration !== row.request.sessionGeneration
    )
      return;
    return { employee, saved };
  }
  /** Version-only import of correlation DATA. No phase, request, native ID,
   * credential, binding, launch fence or provider effect is changed. */
  async migrateProviderSource(employeeId: string, current: () => void): Promise<number> {
    current();
    const initial = this.company.store.snapshot();
    const plans =
      initial.dockerEmployeeContinuations?.flatMap((row) => {
        if (row.employeeId !== employeeId || row.version !== 1) return [];
        const source = this.migrationSource(row, initial);
        if (!source || !legacyDockerProviderSourceMatches(source.employee, source.saved, row.sourceDigest)) return [];
        return [{ row, providerSourceDigest: dockerEmployeeProviderSourceDigest(source.employee, source.saved) }];
      }) ?? [];
    if (!plans.length) return 0;
    const matches = (plan: (typeof plans)[number], state: CompanyState) => {
      const source = this.migrationSource(plan.row, state);
      return (
        !!source && dockerEmployeeProviderSourceDigest(source.employee, source.saved) === plan.providerSourceDigest
      );
    };
    const unchanged = () => {
      current();
      const state = this.company.store.snapshot();
      if (!plans.every((plan) => matches(plan, state)))
        throw new CompanyError('Provider recipe changed during correlation format migration', 409);
    };
    await this.company.store.update((state) => {
      unchanged();
      for (const plan of plans) {
        const index =
          state.dockerEmployeeContinuations?.findIndex((row) => row.employeeId === plan.row.employeeId) ?? -1;
        if (
          index < 0 ||
          !isDeepStrictEqual(state.dockerEmployeeContinuations![index], plan.row) ||
          !matches(plan, state)
        )
          throw new CompanyError('Provider operation changed during correlation format migration', 409);
        state.dockerEmployeeContinuations![index] = DockerEmployeeContinuationRecord.parse({
          ...plan.row,
          version: 2,
          purpose: 'docker-employee-continuation-v2',
          providerSourceDigest: plan.providerSourceDigest,
        });
      }
    }, unchanged);
    return plans.length;
  }
  /** Resource membership is DATA for fresh Engine/kernel proof, never launch permission.
   * A retained binding remains accounted for when its saved launch is held or changed. */
  retainedPoolConfigurationTasks(anchorName: string, helperImageId: string, boxId?:string): DockerContinuationTask[] {
    const state=this.company.store.snapshot();
    const tasks=[...retainedDockerPoolTasks(state, anchorName, helperImageId),
      ...(state.dockerPoolObservations??[]).filter(record=>record.boxId===boxId &&
        record.anchorTask.name===anchorName).map(record=>record.configuration)];
    return [...new Map(tasks.map(task=>[dockerContinuationDigest(task),task])).values()];
  }
  resourceInventory(): DockerEmployeeContinuationRecord[] {
    const state = this.company.store.snapshot(),
      rows = state.dockerEmployeeContinuations ?? [];
    return rows.filter((row) => {
      const employees = state.employees.filter((employee) => employee.id === row.employeeId),
        employee = employees[0];
      if (
        employees.length !== 1 ||
        !employee ||
        rows.filter((value) => value.employeeId === row.employeeId).length !== 1 ||
        state.employees.filter((value) => value.sessionId === employee.sessionId).length !== 1 ||
        employee.bindingMigration ||
        employee.owner !== row.owner ||
        employee.sessionId !== row.request.sessionId ||
        employee.sessionGeneration !== row.request.sessionGeneration
      )
        return false;
      const bound = boundProviderRecord(employee, row);
      if (bound) return true;
      // Published destinations require their exact current binding, even if a
      // saved launch recipe still happens to be eligible. Earlier phases may
      // legitimately precede publication and retain the existing subject check.
      if (row.phase === 'provider-issued' || row.phase === 'ready') return false;
      const subject = this.subjectFromSnapshot(row.employeeId, state);
      if (
        subject &&
        subject.owner === row.owner &&
        subject.sessionId === row.request.sessionId &&
        subject.sessionGeneration === row.request.sessionGeneration &&
        subject.sourceDigest === row.sourceDigest
      )
        return true;
      return false;
    });
  }
  policy(employeeId: string): DockerEmployeeResourcePolicy {
    const rows = this.company.store.view().employees.filter((e) => e.id === employeeId);
    if (rows.length !== 1 || !rows[0]!.dockerResourcePolicy)
      throw new CompanyError('Approve a boxed resource policy before recovery', 409);
    const original = DockerEmployeeResourcePolicy.parse(rows[0]!.dockerResourcePolicy);
    return this.record(employeeId) ? original : this.newPolicy(employeeId, original);
  }
  /** Approved defaults apply to NEW operations only. Existing request/policy/binding stay byte-identical. */
  newPolicy(employeeId: string, policy: DockerEmployeeResourcePolicy): DockerEmployeeResourcePolicy {
    const employees = this.company.store.view().employees.filter((employee) => employee.id === employeeId);
    if (employees.length !== 1) throw new CompanyError('Unknown employee', 404);
    const original = DockerEmployeeResourcePolicy.parse(policy);
    return this.record(employeeId) || !this.defaultPolicy
      ? original
      : DockerEmployeeResourcePolicy.parse(this.defaultPolicy(employees[0]!.owner, original));
  }
  /** A new explicit plan operation snapshots the already owner-approved default.
   * Existing operation rows and their historical baseline remain unchanged. */
  newOperationPolicy(employeeId:string):DockerEmployeeResourcePolicy{
    const employees=this.company.store.view().employees.filter(e=>e.id===employeeId),employee=employees[0];
    if(employees.length!==1||!employee?.dockerResourcePolicy)throw new CompanyError('Approved employee resource policy required',409);
    const original=DockerEmployeeResourcePolicy.parse(employee.dockerResourcePolicy);
    return this.defaultPolicy?DockerEmployeeResourcePolicy.parse(this.defaultPolicy(employee.owner,original)):original;
  }
  record(employeeId: string): DockerEmployeeContinuationRecord | undefined {
    const row = this.company.store.view().dockerEmployeeContinuations?.find((value) => value.employeeId === employeeId);
    return row && structuredClone(row);
  }
  async replace(
    before: DockerEmployeeContinuationRecord | undefined,
    next: DockerEmployeeContinuationRecord,
    current: () => void
  ): Promise<void> {
    if(before?.version===3||next.version===3){
      if(!before||before.version!==3||next.version!==3||
        (!isDeepStrictEqual(before,next)&&!(before.phase==='provider-issued'&&next.phase==='ready'&&
          isDeepStrictEqual({...before,phase:'ready'},next))))
        throw new CompanyError('Plan replacement effects belong to their original move journal',409);
    }
    await this.company.store.update((state) => {
      current();
      const rows = (state.dockerEmployeeContinuations ??= []),
        index = rows.findIndex((row) => row.employeeId === next.employeeId);
      if (
        (before === undefined && index !== -1) ||
        (before !== undefined && (index === -1 || !isDeepStrictEqual(rows[index], persistedRecord(before))))
      )
        throw new CompanyError('Original boxed continuation changed', 409);
      if (
        rows.some((row) => row.employeeId !== next.employeeId && row.request.operationId === next.request.operationId)
      )
        throw new CompanyError('Boxed operation identifier already belongs to another employee', 409);
      if (before === undefined) {
        // Snapshot an already owner-approved default into this NEW operation's
        // canonical approval. Existing operation/employee bindings are never edited here.
        if (this.defaultPolicy) {
          const employees = state.employees.filter((employee) => employee.id === next.employeeId);
          const employee = employees[0];
          if (
            employees.length !== 1 ||
            !employee ||
            employee.owner !== next.owner ||
            employee.sessionId !== next.request.sessionId ||
            employee.sessionGeneration !== next.request.sessionGeneration ||
            !employee.dockerResourcePolicy
          )
            throw new CompanyError('Original employee policy changed', 409);
          const original = DockerEmployeeResourcePolicy.parse(employee.dockerResourcePolicy);
          const effective = DockerEmployeeResourcePolicy.parse(this.defaultPolicy(employee.owner, original));
          if (!isDeepStrictEqual(next.policy, effective))
            throw new CompanyError('Approved resource default changed', 409);
          if (!isDeepStrictEqual(original, effective)) {
            if (next.phase !== 'staged') throw new CompanyError('New operation policy must be staged', 409);
            employee.dockerResourcePolicy = effective;
          }
        }
        rows.push(structuredClone(next));
      } else rows[index] = structuredClone(next);
    }, current);
  }
  async enterOffice(subject: DockerContinuationSubject, current: () => void): Promise<void> {
    await this.company.setVacation(subject.employeeId, subject.owner, false, current);
  }
  async bind(
    row: DockerEmployeeContinuationRecord,
    binding: DockerEmployeeBinding,
    current: () => void
  ): Promise<void> {
    await this.company.store.update((state) => {
      current();
      const operation = state.dockerEmployeeContinuations?.find((value) => value.employeeId === row.employeeId);
      if (!isDeepStrictEqual(operation, persistedRecord(row)) || row.phase !== 'identity-ready')
        throw new CompanyError('Original Docker binding publication changed', 409);
      const employee = state.employees.find((e) => e.id === row.employeeId);
      if (
        !employee ||
        employee.owner !== row.owner ||
        employee.sessionId !== binding.sessionId ||
        employee.sessionGeneration !== binding.sessionGeneration
      )
        throw new CompanyError('Original employee changed', 409);
      employee.dockerBinding = structuredClone(binding);
    }, current);
  }
  read(row: DockerEmployeeContinuationRecord, role: DockerContinuationTaskRole): DockerContinuationTask | undefined {
    const actual = this.record(row.employeeId);
    if (!actual || actual.request.operationId !== row.request.operationId)
      throw new CompanyError('Original Docker task operation changed', 409);
    return actual.tasks?.find((task) => task.role === role);
  }
  async publish(
    row: DockerEmployeeContinuationRecord,
    before: DockerContinuationTask | undefined,
    next: DockerContinuationTask,
    current: () => void
  ): Promise<DockerEmployeeContinuationRecord> {
    if(row.version===3)throw new CompanyError('Plan replacement tasks are immutable read projections',409);
    const checked = DockerContinuationTask.parse(next);
    if (!allowedDockerTaskTransition(before, checked))
      throw new CompanyError('Invalid original Docker task transition', 409);
    return this.company.store.update((state) => {
      current();
      const actual = state.dockerEmployeeContinuations?.find((item) => item.employeeId === row.employeeId);
      if (
        !actual ||
        dockerContinuationDigest({ ...actual, tasks: undefined }) !==
          dockerContinuationDigest({ ...row, tasks: undefined })
      )
        throw new CompanyError('Original Docker task operation changed', 409);
      const tasks = (actual.tasks ??= []),
        index = tasks.findIndex((task) => task.role === checked.role),
        previous = index === -1 ? undefined : tasks[index];
      if (!isDeepStrictEqual(previous, before === undefined ? undefined : JSON.parse(JSON.stringify(before))))
        throw new CompanyError('Original Docker task cursor changed', 409);
      if (index === -1) tasks.push(checked);
      else tasks[index] = checked;
      return structuredClone(actual);
    }, current);
  }
  readEphemeral(row: DockerEmployeeContinuationRecord): EphemeralRestoration | undefined {
    const actual = this.record(row.employeeId);
    if (!actual || actual.request.operationId !== row.request.operationId)
      throw new CompanyError('Original ephemeral operation changed', 409);
    return actual.ephemeralRestoration;
  }
  async publishEphemeral(
    row: DockerEmployeeContinuationRecord,
    before: EphemeralRestoration | undefined,
    next: EphemeralRestoration,
    current: () => void
  ): Promise<void> {
    if(row.version===3)throw new CompanyError('Plan replacement effects belong to their original move journal',409);
    const checked = EphemeralRestoration.parse(next);
    if (!allowedEphemeralTransition(before, checked)) throw new CompanyError('Invalid ephemeral transition', 409);
    await this.company.store.update((state) => {
      current();
      const actual = state.dockerEmployeeContinuations?.find((item) => item.employeeId === row.employeeId);
      if (
        !actual ||
        dockerContinuationDigest({ ...actual, tasks: undefined, ephemeralRestoration: undefined }) !==
          dockerContinuationDigest({ ...row, tasks: undefined, ephemeralRestoration: undefined }) ||
        !isDeepStrictEqual(actual.ephemeralRestoration, before)
      )
        throw new CompanyError('Original ephemeral cursor changed', 409);
      actual.ephemeralRestoration = structuredClone(checked);
    }, current);
  }
  async savePolicy(
    employeeId: string,
    owner: string | undefined,
    policy: DockerEmployeeResourcePolicy,
    current: () => void
  ): Promise<void> {
    const checked = DockerEmployeeResourcePolicy.parse(policy);
    await this.company.store.update((state) => {
      current();
      const employee = state.employees.find((e) => e.id === employeeId && e.owner === owner);
      if (!employee) throw new CompanyError('Unknown employee', 404);
      if (state.dockerEmployeeContinuations?.some((row) => row.employeeId === employeeId))
        throw new CompanyError('The original boxed operation owns its approved policy; inspect it before editing', 409);
      employee.dockerResourcePolicy = checked;
    }, current);
  }
}
