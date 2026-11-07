/** The existing live employee request binding. Returned facts confer no grant. */
import type { FastifyRequest } from 'fastify';
import type { CompanyEmployee } from '../company-types.js';
import type { SessionPort } from './ports/session-port.js';
import { ownerFor, resolveParentSessionId } from './route-helpers.js';

export interface EmployeeCallerSource {
  agentSession(request: FastifyRequest): string | undefined;
  company(owner: string | undefined): { employees: readonly CompanyEmployee[] };
}
export function currentEmployeeCaller(
  request: FastifyRequest,
  ctx: Pick<SessionPort, 'sessions'>,
  source: EmployeeCallerSource
): { owner: string | undefined; employee: CompanyEmployee; sessionId: string } | undefined {
  const owner = ownerFor(request);
  const sessionId = source.agentSession(request);
  if (
    !sessionId ||
    request.headers['x-reverie-parent-session'] !== sessionId ||
    request.headers['x-reverie-service-token'] !== undefined ||
    resolveParentSessionId(ctx, request, undefined, owner) !== sessionId
  )
    return undefined;
  const session = ctx.sessions.get(sessionId);
  if (!session || typeof session.pid !== 'number' || session.pid <= 0 || session.paneExit !== undefined)
    return undefined;
  const company = source.company(owner);
  const matches = company.employees.filter((employee) => employee.sessionId === sessionId);
  const employee = matches[0];
  if (
    matches.length !== 1 ||
    !employee ||
    company.employees.filter((row) => row.id === employee.id).length !== 1 ||
    employee.desiredRunning === false ||
    employee.onVacation ||
    employee.bindingMigration != null
  )
    return undefined;
  return { owner, employee, sessionId };
}
