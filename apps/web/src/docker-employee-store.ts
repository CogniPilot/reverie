import { rebootRestoreLaunchConfig, rebootResumeTarget } from './utils/native-thread-profile.js';
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
import type { CompanyEmployee } from './company-types.js';
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
const launchFields = [
  'mode',
  'workingDir',
  'model',
  'effort',
  'advisorModel',
  'claudeMode',
  'allowedTools',
  'subscriptionProfile',
  'customModel',
  'runtimeThreads',
  'openCodeConfig',
  'codexConfig',
  'geminiConfig',
  'antigravityConfig',
  'piConfig',
  'grokConfig',
  'deepSeekConfig',
  'ompConfig',
  'resumeSessionId',
  'claudeSessionChain',
  '__envOverrides',
  '__customModel',
] as const;
export function dockerEmployeeSourceDigest(employee: CompanyEmployee, saved: SessionState): string {
  // Normalize only the existing shared same-thread launch codec and empty
  // runtime map. This is correlation DATA, never restoration/launch authority.
  const target = rebootResumeTarget(saved);
  const normalized = target === undefined ? saved : { ...saved, ...rebootRestoreLaunchConfig(saved, target) };
  const value = { ...normalized, runtimeThreads: normalized.runtimeThreads ?? {} } as unknown as Record<
    string,
    unknown
  >;
  return dockerContinuationDigest({
    employeeId: employee.id,
    owner: employee.owner ?? null,
    sessionId: employee.sessionId,
    generation: employee.sessionGeneration,
    recipe: employee.runtimeRecipe ?? null,
    thread: employee.threadId ?? null,
    saved: Object.fromEntries(launchFields.map((key) => [key, value[key] ?? null])),
  });
}
function persistedRecord(row: DockerEmployeeContinuationRecord): DockerEmployeeContinuationRecord {
  return DockerEmployeeContinuationRecord.parse(JSON.parse(JSON.stringify(row)));
}
export class CompanyDockerContinuationStore implements DockerContinuationStore, DockerContinuationTaskJournal {
  constructor(
    readonly company: CompanyService,
    private readonly saved: (id: string) => SessionState | undefined
  ) {
    if (!(company instanceof CompanyService)) throw Error('Actual company service required');
  }
  subject(employeeId: string): DockerContinuationSubject | undefined {
    const state = this.company.store.snapshot(),
      rows = state.employees.filter((e) => e.id === employeeId),
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
      onVacation: employee.onVacation,
      desiredRunning: employee.desiredRunning,
    };
  }
  policy(employeeId: string): DockerEmployeeResourcePolicy {
    const rows = this.company.store.snapshot().employees.filter((e) => e.id === employeeId);
    if (rows.length !== 1 || !rows[0]!.dockerResourcePolicy)
      throw new CompanyError('Approve a boxed resource policy before recovery', 409);
    return DockerEmployeeResourcePolicy.parse(rows[0]!.dockerResourcePolicy);
  }
  record(employeeId: string): DockerEmployeeContinuationRecord | undefined {
    return this.company.store.snapshot().dockerEmployeeContinuations?.find((row) => row.employeeId === employeeId);
  }
  async replace(
    before: DockerEmployeeContinuationRecord | undefined,
    next: DockerEmployeeContinuationRecord,
    current: () => void
  ): Promise<void> {
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
      if (before === undefined) rows.push(structuredClone(next));
      else rows[index] = structuredClone(next);
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
