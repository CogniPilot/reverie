import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import type { CompanyEmployee } from '../../company-types.js';
import { buildEmployeeContext, EmployeeContextError, ManagedEmployeeContextStore } from '../../employee-context.js';
import type { OwnerVerifier } from '../../owner-auth/marks.js';
import type { SessionPort } from '../ports/session-port.js';
import { ownerFor, resolveParentSessionId } from '../route-helpers.js';

export interface EmployeeContextRouteDeps {
  verifiedOwner: OwnerVerifier;
  /** Actual caller classification; owner, human and service callers must not become an agent by adding a header. */
  agentSession: (request: FastifyRequest) => string | undefined;
  company: (owner: string | undefined) => {
    employees: readonly CompanyEmployee[];
    settings: { coreBeliefs?: readonly string[] };
  };
  reports?: ManagedEmployeeContextStore;
  now?: () => number;
}
const Receipt = z.object({ digest: z.string().regex(/^sha256:[0-9a-f]{64}$/), stage: z.enum(['startup', 'model-request']) }).strict();
const headers = (reply: FastifyReply) => {
  reply.header('Cache-Control', 'no-store'); reply.header('X-Content-Type-Options', 'nosniff');
};
const failed = (reply: FastifyReply, error: unknown) => {
  headers(reply);
  const safe = error instanceof EmployeeContextError ? error : new EmployeeContextError();
  return reply.code(safe.status).send({ success: false, error: safe.message, errorCode: 'EMPLOYEE_CONTEXT_UNAVAILABLE' });
};

export function registerEmployeeContextRoutes(
  app: FastifyInstance,
  ctx: Pick<SessionPort, 'sessions'>,
  deps: EmployeeContextRouteDeps
): void {
  const reports = deps.reports ?? new ManagedEmployeeContextStore();
  const now = deps.now ?? Date.now;
  const sessionEpochs = new WeakMap<object, string>();
  const runtimeBinding = (sessionId: string) => {
    const session = ctx.sessions.get(sessionId);
    if (!session) return undefined;
    let epoch = sessionEpochs.get(session);
    if (!epoch) { epoch = randomUUID(); sessionEpochs.set(session, epoch); }
    return 'sha256:' + createHash('sha256').update(JSON.stringify([epoch, session.pid])).digest('hex');
  };
  const current = (request: FastifyRequest) => {
    const owner = ownerFor(request); const sessionId = deps.agentSession(request);
    if (!sessionId || request.headers['x-reverie-parent-session'] !== sessionId ||
        request.headers['x-reverie-service-token'] !== undefined ||
        resolveParentSessionId(ctx, request, undefined, owner) !== sessionId) throw new EmployeeContextError(403);
    const session = ctx.sessions.get(sessionId);
    if (!session || typeof session.pid !== 'number' || session.pid <= 0 || session.paneExit !== undefined) throw new EmployeeContextError(403);
    const company = deps.company(owner); const matches = company.employees.filter(employee => employee.sessionId === sessionId);
    const employee = matches[0];
    if (matches.length !== 1 || !employee || company.employees.filter(row => row.id === employee.id).length !== 1 ||
        employee.desiredRunning === false || employee.onVacation || employee.bindingMigration != null) throw new EmployeeContextError(403);
    return { owner, employee, company, runtimeBinding: runtimeBinding(sessionId) };
  };
  const options = { bodyLimit: 1024, errorHandler: (_error: unknown, _request: FastifyRequest, reply: FastifyReply) => failed(reply, new EmployeeContextError(400)) };
  app.get<{ Params: { id: string } }>('/api/company/employees/:id/startup-context', options, async (request, reply) => {
    headers(reply);
    try {
      if (!deps.verifiedOwner(request)) throw new EmployeeContextError(403);
      const owner = ownerFor(request); const company = deps.company(owner);
      const matches = company.employees.filter(employee => employee.id === request.params.id);
      if (matches.length !== 1) throw new EmployeeContextError(404);
      const view = reports.inspect(owner, buildEmployeeContext(matches[0]!, company.settings.coreBeliefs, { now, runtimeBinding: runtimeBinding(matches[0]!.sessionId) }));
      if (!deps.verifiedOwner(request) || ownerFor(request) !== owner) throw new EmployeeContextError(403);
      return { success: true, data: view };
    } catch (error) { return failed(reply, error); }
  });
  app.get('/api/agent/context', options, async (request, reply) => {
    headers(reply);
    try {
      const first = current(request);
      const view = buildEmployeeContext(first.employee, first.company.settings.coreBeliefs, { now, runtimeBinding: first.runtimeBinding });
      const fresh = current(request);
      if (fresh.owner !== first.owner || fresh.employee.id !== view.employeeId || fresh.employee.sessionId !== view.sessionId ||
          fresh.employee.sessionGeneration !== view.sessionGeneration || fresh.runtimeBinding !== view.runtimeBinding) throw new EmployeeContextError(403);
      return { success: true, data: reports.issue(first.owner, view) };
    } catch (error) { return failed(reply, error); }
  });
  app.post('/api/agent/context/receipt', options, async (request, reply) => {
    headers(reply);
    try {
      const parsed = Receipt.safeParse(request.body);
      if (!parsed.success) throw new EmployeeContextError(400);
      const fresh = current(request);
      const report = reports.report(fresh.owner, { employeeId: fresh.employee.id, sessionId: fresh.employee.sessionId,
        sessionGeneration: fresh.employee.sessionGeneration, runtimeBinding: fresh.runtimeBinding }, parsed.data.digest, parsed.data.stage, now());
      // The caller supplied only the reference, never context text or a capture claim for another binding.
      return { success: true, data: {
        employeeId: report.employeeId, sessionId: report.sessionId, sessionGeneration: report.sessionGeneration,
        runtimeBinding: report.runtimeBinding,
        digest: report.digest, stage: report.stage, reportedAt: report.reportedAt,
        assurance: report.assurance, retention: report.retention,
      } };
    } catch (error) { return failed(reply, error); }
  });
}
