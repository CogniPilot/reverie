/** Legacy stop diagnostics only. The old record has no original CID/HOME scope;
 * current labels cannot reconstruct it or authorize fencing/clearing that stop. */
import { z } from 'zod';
import { CompanyService } from './company-service.js';
import { ownerStopPending } from './owner-stop-journal.js';

export const DockerOwnerStopDiagnosticRequest = z
  .object({
    sessionId: z
      .string()
      .uuid()
      .refine((value) => value === value.toLowerCase()),
    sessionGeneration: z.number().int().positive().safe(),
  })
  .strict();
export interface DockerOwnerStopStatus {
  state: 'pending' | 'not-required';
  sessionId: string;
  sessionGeneration: number;
  allowedActions: readonly [];
  code?: 'DOCKER_OWNER_STOP_LEGACY_SCOPE_UNCONFIRMED';
}
export class DockerOwnerStopDiagnosticError extends Error {
  constructor(
    readonly code:
      | 'DOCKER_OWNER_STOP_LEGACY_SCOPE_UNCONFIRMED'
      | 'DOCKER_OWNER_STOP_TARGET_CHANGED'
      | 'DOCKER_OWNER_STOP_RUNTIME_CHANGED'
  ) {
    super(code);
  }
}
export class DockerOwnerStopDiagnostic {
  constructor(
    private readonly company: CompanyService,
    private readonly requireRuntime: () => void
  ) {
    if (!(company instanceof CompanyService)) throw Error('Actual company service required');
  }
  status(
    employeeId: string,
    owner: string | undefined,
    callerSessionId?: string,
    requireIdentity: () => void = () => {}
  ): DockerOwnerStopStatus {
    requireIdentity();
    this.requireRuntime();
    const action = this.company.officeAction(employeeId, owner, callerSessionId);
    action.require();
    const employee = this.company.store
      .snapshot()
      .employees.find((value) => value.id === employeeId && value.owner === owner);
    if (!employee) throw new DockerOwnerStopDiagnosticError('DOCKER_OWNER_STOP_TARGET_CHANGED');
    const base = { sessionId: employee.sessionId, sessionGeneration: employee.sessionGeneration };
    // The canonical journal also holds conservatively when it cannot be read.
    // "pending" is a refusal diagnostic, not proof of a valid historical record.
    const pending = ownerStopPending(employee.sessionId);
    requireIdentity();
    this.requireRuntime();
    action.require();
    return pending
      ? { ...base, state: 'pending', allowedActions: [], code: 'DOCKER_OWNER_STOP_LEGACY_SCOPE_UNCONFIRMED' }
      : { ...base, state: 'not-required', allowedActions: [] };
  }
  reconcile(
    employeeId: string,
    unchecked: unknown,
    owner: string | undefined,
    callerSessionId?: string,
    requireIdentity: () => void = () => {}
  ): DockerOwnerStopStatus {
    const request = DockerOwnerStopDiagnosticRequest.parse(unchecked);
    const status = this.status(employeeId, owner, callerSessionId, requireIdentity);
    if (status.sessionId !== request.sessionId || status.sessionGeneration !== request.sessionGeneration)
      throw new DockerOwnerStopDiagnosticError('DOCKER_OWNER_STOP_TARGET_CHANGED');
    if (status.state === 'pending')
      throw new DockerOwnerStopDiagnosticError('DOCKER_OWNER_STOP_LEGACY_SCOPE_UNCONFIRMED');
    return status;
  }
}
