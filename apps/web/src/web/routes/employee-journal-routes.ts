import { renderMemoryBrief } from '../../memory-brief.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ChatMessage } from '../../chatroom-store.js';
import type { CompanyEmployee } from '../../company-types.js';
import { EmployeeJournalError, journalId, journalProject, type EmployeeJournalStore, type ReadVisibleMessage } from '../../employee-journal.js';
import type { OwnerVerifier } from '../../owner-auth/marks.js';
import type { SessionPort } from '../ports/session-port.js';
import { ownerFor, resolveParentSessionId } from '../route-helpers.js';

export interface EmployeeJournalRouteDeps {
  verifiedOwner: OwnerVerifier;
  /** Actual caller classification; owner, human and service callers must not become an agent by adding a header. */
  agentSession: (request: FastifyRequest) => string | undefined;
  company: (owner: string | undefined) => { employees: readonly CompanyEmployee[] };
  journal: () => EmployeeJournalStore;
  /** The exact message as this live member session can read it now; throws when it cannot. */
  visibleMessage: (sessionId: string, roomId: string, messageId: string) => ChatMessage;
}

const SOURCE_TEXT_BYTES = 4096;
const Id = z.string().refine(journalId);
const Query = z.string().min(1).max(300);
const Project = z.string().refine(journalProject);
const Save = z.object({ roomId: Id, turnId: Id, draft: z.unknown(), project: Project.optional() }).strict();
const Recall = z.object({ q: Query, roomId: Id.optional(), project: Project.optional() }).strict();
const MapQuery = z.object({ q: Query.optional(), roomId: Id.optional(), before: z.coerce.number().int().positive().optional(),
  project: Project.optional() }).strict();
const Source = z.object({ roomId: Id, messageId: Id }).strict();
const OwnerPage = z.object({ before: z.coerce.number().int().positive().optional() }).strict();

const headers = (reply: FastifyReply) => {
  reply.header('Cache-Control', 'no-store'); reply.header('X-Content-Type-Options', 'nosniff');
};
const failed = (reply: FastifyReply, error: unknown) => {
  headers(reply);
  const safe = error instanceof EmployeeJournalError ? error : new EmployeeJournalError(503, 'journal unavailable', 'JOURNAL_UNAVAILABLE');
  return reply.code(safe.status).send({ success: false, error: safe.message, errorCode: safe.code, ...(safe.gates ? { gates: safe.gates } : {}) });
};
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(value ?? {});
  if (!parsed.success) throw new EmployeeJournalError(400, 'invalid journal request', 'JOURNAL_INVALID');
  return parsed.data;
};
const truncate = (text: string, max: number) => {
  const buffer = Buffer.from(text);
  return buffer.length <= max ? { text, truncated: false } : { text: buffer.subarray(0, max).toString().replace(/�+$/, ''), truncated: true };
};

/**
 * The journal is keyed to the employee the authenticated session belongs to. No request field names
 * an employee, so a session reads and writes only its own journal; coordinators get nothing extra.
 * The owner reads every journal and never writes as an employee.
 */
export function registerEmployeeJournalRoutes(
  app: FastifyInstance,
  ctx: Pick<SessionPort, 'sessions'>,
  deps: EmployeeJournalRouteDeps
): void {
  // Same live-session and single-employee binding checks as the employee context routes.
  const current = (request: FastifyRequest) => {
    const denied = () => new EmployeeJournalError(403, 'journal unavailable for this caller', 'JOURNAL_UNAVAILABLE');
    const owner = ownerFor(request); const sessionId = deps.agentSession(request);
    if (!sessionId || request.headers['x-reverie-parent-session'] !== sessionId ||
        request.headers['x-reverie-service-token'] !== undefined ||
        resolveParentSessionId(ctx, request, undefined, owner) !== sessionId) throw denied();
    const session = ctx.sessions.get(sessionId);
    if (!session || typeof session.pid !== 'number' || session.pid <= 0 || session.paneExit !== undefined) throw denied();
    const company = deps.company(owner); const matches = company.employees.filter(employee => employee.sessionId === sessionId);
    const employee = matches[0];
    if (matches.length !== 1 || !employee || company.employees.filter(row => row.id === employee.id).length !== 1 ||
        employee.desiredRunning === false || employee.onVacation || employee.bindingMigration != null) throw denied();
    const read: ReadVisibleMessage = (roomId, messageId) => {
      let message: ChatMessage;
      try { message = deps.visibleMessage(sessionId, roomId, messageId); } catch { return undefined; }
      const fromSelf = message.from.kind === 'agent' && (message.from.sessionId === sessionId || message.from.employeeId === employee.id);
      return { id: message.id, roomId: message.roomId, at: message.at, text: message.text, fromSelf };
    };
    return { owner: owner ?? '', employee, sessionId, read };
  };
  const options = { bodyLimit: 16 * 1024, errorHandler: (_error: unknown, _request: FastifyRequest, reply: FastifyReply) =>
    failed(reply, new EmployeeJournalError(400, 'invalid journal request', 'JOURNAL_INVALID')) };

  app.post('/api/agent/journal/save', options, async (request, reply) => {
    headers(reply);
    try {
      const body = parse(Save, request.body);
      const self = current(request);
      return { success: true, data: deps.journal().save(self.owner, self.employee.id, body, self.read) };
    } catch (error) { return failed(reply, error); }
  });
  app.get('/api/agent/journal/recall', options, async (request, reply) => {
    headers(reply);
    try {
      const query = parse(Recall, request.query);
      const self = current(request);
      return { success: true, data: { entries: deps.journal().recall(self.owner, self.employee.id, query.q, self.read, query.roomId, query.project) } };
    } catch (error) { return failed(reply, error); }
  });
  // What a new session starts with (the SessionStart hook prepends it): identity, how to use the journal, top entries.
  app.get('/api/agent/memory-brief', options, async (request, reply) => {
    headers(reply);
    try {
      parse(z.object({}).strict(), request.query);
      const self = current(request);
      const brief = deps.journal().brief(self.owner, self.employee.id);
      return { success: true, data: { total: brief.total, entries: brief.entries.map(({ text: _text, ...entry }) => entry),
        text: renderMemoryBrief(self.employee.name, brief) } };
    } catch (error) { return failed(reply, error); }
  });
  app.get('/api/agent/journal/map', options, async (request, reply) => {
    headers(reply);
    try {
      const query = parse(MapQuery, request.query);
      const self = current(request);
      return { success: true, data: deps.journal().map(self.owner, self.employee.id, { query: query.q, before: query.before, roomId: query.roomId, project: query.project }) };
    } catch (error) { return failed(reply, error); }
  });
  app.get('/api/agent/journal/source', options, async (request, reply) => {
    headers(reply);
    try {
      const query = parse(Source, request.query);
      const self = current(request);
      let message: ChatMessage;
      try { message = deps.visibleMessage(self.sessionId, query.roomId, query.messageId); }
      catch { throw new EmployeeJournalError(404, 'message unavailable to this employee', 'JOURNAL_SOURCE_UNAVAILABLE'); }
      return { success: true, data: { id: message.id, roomId: message.roomId, at: new Date(message.at).toISOString(),
        from: message.from.name, ...truncate(message.text, SOURCE_TEXT_BYTES) } };
    } catch (error) { return failed(reply, error); }
  });
  app.get<{ Params: { turnId: string } }>('/api/agent/journal/receipt/:turnId', options, async (request, reply) => {
    headers(reply);
    try {
      if (!journalId(request.params.turnId)) throw new EmployeeJournalError(400, 'turn message id required', 'JOURNAL_INVALID');
      const self = current(request);
      return { success: true, data: deps.journal().receipt(self.owner, self.employee.id, request.params.turnId) };
    } catch (error) { return failed(reply, error); }
  });
  app.get<{ Params: { id: string } }>('/api/company/employees/:id/journal', options, async (request, reply) => {
    headers(reply);
    try {
      if (!deps.verifiedOwner(request)) throw new EmployeeJournalError(403, 'owner only', 'JOURNAL_UNAVAILABLE');
      const query = parse(OwnerPage, request.query);
      const owner = ownerFor(request);
      if (deps.company(owner).employees.filter(employee => employee.id === request.params.id).length !== 1)
        throw new EmployeeJournalError(404, 'no such employee', 'JOURNAL_NOT_FOUND');
      return { success: true, data: deps.journal().ownerPage(owner ?? '', request.params.id, query.before) };
    } catch (error) { return failed(reply, error); }
  });
}
