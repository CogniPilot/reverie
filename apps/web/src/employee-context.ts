/** Generated managed context and explicitly harness-reported input; never a reconstruction of an old startup. */
import { createHash } from 'node:crypto';
import {
  effectiveCoreBeliefs, employeePlanContext, employeeProfileContext, employeeRestContext,
  type CompanyEmployee,
} from './company-types.js';

export const EMPLOYEE_CONTEXT_BYTES = 64 * 1024;
export const MANAGED_CONTEXT_RETENTION = 'website-process-lifetime' as const;
export interface EmployeeContextSection {
  id: string;
  label: string;
  status: 'configured' | 'missing' | 'captured';
  text: string;
  source?: string;
}
export interface ManagedContextReport {
  employeeId: string;
  sessionId: string;
  sessionGeneration: number;
  runtimeBinding?: string;
  generatedAt: number;
  digest: string;
  context: string;
  sections: EmployeeContextSection[];
  stage: 'startup' | 'model-request';
  reportedAt: number;
  assurance: 'harness-reported-input';
  retention: typeof MANAGED_CONTEXT_RETENTION;
}
export interface EmployeeContextView {
  employeeId: string;
  sessionId: string;
  sessionGeneration: number;
  runtimeBinding?: string;
  generatedAt: number;
  context: string;
  sections: EmployeeContextSection[];
  startup: { status: 'unavailable' | 'captured'; reason: string; report?: ManagedContextReport };
  digest?: string;
  retention?: typeof MANAGED_CONTEXT_RETENTION;
  lastManagedDelivery?: ManagedContextReport;
}
export class EmployeeContextError extends Error {
  constructor(readonly status = 503) { super(status === 403 ? 'Current employee context access denied' : status === 404 ? 'Employee context not found' : status === 400 ? 'Invalid managed context receipt' : 'Managed employee context unavailable'); }
}
const bytes = (value: string) => Buffer.byteLength(value, 'utf8');
const sameBinding = (first: Pick<EmployeeContextView, 'employeeId' | 'sessionId' | 'sessionGeneration' | 'runtimeBinding'>,
  second: Pick<EmployeeContextView, 'employeeId' | 'sessionId' | 'sessionGeneration' | 'runtimeBinding'>) =>
  first.employeeId === second.employeeId && first.sessionId === second.sessionId && first.sessionGeneration === second.sessionGeneration && first.runtimeBinding === second.runtimeBinding;

export function buildEmployeeContext(
  employee: CompanyEmployee,
  companyCoreBeliefs: readonly string[] = [],
  options: { now?: () => number; runtimeBinding?: string } = {}
): EmployeeContextView {
  try {
    if (!employee.id || !employee.sessionId || !Number.isSafeInteger(employee.sessionGeneration) || employee.sessionGeneration <= 0)
      throw new EmployeeContextError();
    const core = effectiveCoreBeliefs(companyCoreBeliefs, employee.coreBeliefs);
    const profile = JSON.stringify({ name: employee.name, position: employee.position, expertise: employee.expertise,
      responsibilities: employee.responsibilities ?? [], personality: employee.personality ?? '' });
    // Select public permission facts explicitly: never serialize credentials, runtime env or provider history.
    const declared = Object.fromEntries(['recoverEmployees', 'moveOwnPlan', 'managePlans', 'editBoardIssues', 'manageBoard', 'manageDecisions']
      .flatMap(key => typeof employee.permissions[key as keyof typeof employee.permissions] === 'boolean'
        ? [[key, employee.permissions[key as keyof typeof employee.permissions]]] : []));
    const sections: EmployeeContextSection[] = [
      { id: 'profile', label: 'Current owner-selected profile', status: 'configured', text: profile, source: 'current employee record' },
      { id: 'core-beliefs', label: 'Effective core beliefs', status: core.length ? 'configured' : 'missing', text: core.join('\n\n'), source: 'company core first, then personal additions; exact duplicates omitted' },
      { id: 'tool-permissions', label: 'Current declared tool grants', status: 'configured', text: JSON.stringify(declared) + '\nActions still check their current canonical grants. Profile and core text add no permissions.', source: 'current employee permission record' },
      { id: 'rest-preferences', label: 'Sleep and Dream eligibility', status: 'configured', text: employeeRestContext(employee), source: 'current employee record' },
      { id: 'plan-permissions', label: 'Plan permission guidance', status: 'configured', text: employeePlanContext(employee), source: 'current employee record' },
      { id: 'workspace-instructions', label: 'Selected workspace instructions', status: 'missing', text: '', source: 'No selected-file capture is available; arbitrary workspace files were not read.' },
    ];
    const context = employeeProfileContext(employee, companyCoreBeliefs) + '\n\n' + employeeRestContext(employee) + '\n\n' + employeePlanContext(employee);
    const generatedAt = (options.now ?? Date.now)();
    if (!Number.isSafeInteger(generatedAt) || generatedAt < 0 || bytes(context) > EMPLOYEE_CONTEXT_BYTES ||
        sections.length > 8 || sections.reduce((total, section) => total + bytes(section.text), 0) > EMPLOYEE_CONTEXT_BYTES)
      throw new EmployeeContextError();
    return { employeeId: employee.id, sessionId: employee.sessionId, sessionGeneration: employee.sessionGeneration,
      ...(options.runtimeBinding ? { runtimeBinding: options.runtimeBinding } : {}), generatedAt, context, sections, startup: { status: 'unavailable',
        reason: 'No actual managed startup input was captured for this binding. This is generated current context, not proof of what an existing process consumed.' } };
  } catch (error) { throw error instanceof EmployeeContextError ? error : new EmployeeContextError(); }
}

/** Bounded instance memory only. Restarting the website clears issuance and reports, which remain visibly unavailable. */
export class ManagedEmployeeContextStore {
  private readonly records = new Map<string, { issued?: EmployeeContextView; startup?: ManagedContextReport; latest?: ManagedContextReport }>();
  private key(owner: string | undefined, employeeId: string): string { return JSON.stringify([owner ?? null, employeeId]); }
  inspect(owner: string | undefined, preview: EmployeeContextView): EmployeeContextView {
    const view = structuredClone(preview);
    const record = this.records.get(this.key(owner, preview.employeeId));
    view.retention = MANAGED_CONTEXT_RETENTION;
    if (record?.startup && sameBinding(record.startup, preview)) view.startup = { status: 'captured',
      reason: 'The harness reported this managed input for this employee/session binding. This is not cryptographic, HTTP-delivery or model-read proof.', report: structuredClone(record.startup) };
    if (record?.latest) view.lastManagedDelivery = structuredClone(record.latest);
    return view;
  }
  issue(owner: string | undefined, preview: EmployeeContextView): EmployeeContextView {
    const key = this.key(owner, preview.employeeId);
    if (!this.records.has(key) && this.records.size >= 200) throw new EmployeeContextError();
    const issued = structuredClone(preview);
    const snapshot = { employeeId: issued.employeeId, sessionId: issued.sessionId, sessionGeneration: issued.sessionGeneration,
      runtimeBinding: issued.runtimeBinding, generatedAt: issued.generatedAt, context: issued.context, sections: issued.sections };
    const raw = JSON.stringify(snapshot);
    if (bytes(raw) > 2 * EMPLOYEE_CONTEXT_BYTES) throw new EmployeeContextError();
    issued.digest = 'sha256:' + createHash('sha256').update(raw).digest('hex');
    const record = this.records.get(key) ?? {};
    record.issued = issued; this.records.set(key, record);
    const view = this.inspect(owner, issued); view.digest = issued.digest;
    return view;
  }
  report(owner: string | undefined, current: Pick<EmployeeContextView, 'employeeId' | 'sessionId' | 'sessionGeneration' | 'runtimeBinding'>,
    digest: string, stage: 'startup' | 'model-request', now = Date.now()): ManagedContextReport {
    const record = this.records.get(this.key(owner, current.employeeId));
    if (!record?.issued || record.issued.digest !== digest || !sameBinding(record.issued, current) ||
        !Number.isSafeInteger(now) || now < record.issued.generatedAt || now - record.issued.generatedAt > 5 * 60_000)
      throw new EmployeeContextError(403);
    if (record.latest?.digest === digest && record.latest.stage === stage) return structuredClone(record.latest);
    const issued = record.issued;
    const report: ManagedContextReport = { employeeId: issued.employeeId, sessionId: issued.sessionId,
      sessionGeneration: issued.sessionGeneration, ...(issued.runtimeBinding ? { runtimeBinding: issued.runtimeBinding } : {}), generatedAt: issued.generatedAt, digest, context: issued.context,
      sections: structuredClone(issued.sections), stage, reportedAt: now, assurance: 'harness-reported-input', retention: MANAGED_CONTEXT_RETENTION };
    record.latest = report;
    if (stage === 'startup') record.startup = report;
    return structuredClone(report);
  }
}
