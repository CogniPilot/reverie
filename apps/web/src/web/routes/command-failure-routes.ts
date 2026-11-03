/** Owner-only metadata reader/page. No writer, settings or lifecycle endpoint. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import type { OwnerVerifier } from '../../owner-auth/marks.js';
import { FailureEmployeeId, FailureReportQuery, FAILURE_REPORT_LIMIT,
  parseFailureReport, readCommandFailures } from '../../command-failure-reports.js';

export function registerCommandFailureRoutes(app: FastifyInstance, deps: {
  verifiedOwner?: OwnerVerifier;
  employees: () => readonly { id: string; owner?: string }[];
  read?: typeof readCommandFailures;
  page?: () => Promise<string>;
}) {
  const authorized = (req: FastifyRequest) => req.headers['x-reverie-parent-session'] === undefined &&
    req.headers['x-reverie-service-token'] === undefined && deps.verifiedOwner?.(req) === true;
  const denied = (reply: import('fastify').FastifyReply) => reply.code(403).send({
    success: false, error: 'Sign in as the owner to read command failures.', errorCode: 'FORBIDDEN',
  });
  // The static wildcard can also serve encoded names and generated .br/.gz files.
  // Keep those fallbacks out of public immutable caching; use the checked routes.
  app.addHook('preHandler', async (req, reply) => {
    const wildcard = (req.params as Record<string, unknown> | undefined)?.['*'];
    if (typeof wildcard !== 'string' ||
        !/^\/command-failures\.(?:html|js|css)(?:\.(?:br|gz))?$/.test(posix.normalize('/' + wildcard))) return;
    reply.header('Cache-Control', 'no-store');
    if (!authorized(req)) return denied(reply);
    return reply.code(404).send({ success: false, error: 'Not found.', errorCode: 'NOT_FOUND' });
  });
  for (const [path, file, type] of [
    ['/command-failures', 'command-failures.html', 'text/html'],
    ['/command-failures.html', 'command-failures.html', 'text/html'],
    ['/command-failures.js', 'command-failures.js', 'application/javascript'],
    ['/command-failures.css', 'command-failures.css', 'text/css'],
  ]) app.get(path!, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!authorized(req)) return denied(reply);
    try {
      const page = file === 'command-failures.html' && deps.page ? await deps.page() :
        await readFile(new URL('../public/' + file, import.meta.url), 'utf8');
      if (!authorized(req)) return denied(reply);
      return reply.type(type + '; charset=utf-8').send(page);
    } catch {
      if (!authorized(req)) return denied(reply);
      return reply.code(503).send({ success: false, error: 'The command failure view is unavailable.', errorCode: 'SERVICE_UNAVAILABLE' });
    }
  });
  app.get('/api/company/command-failures', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!authorized(req)) return denied(reply);
    const parsed = FailureReportQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ success: false, error: 'Select a valid employee.', errorCode: 'INVALID_INPUT' });
    try {
      const roster = deps.employees();
      if (roster.some(row => !FailureEmployeeId.safeParse(row.id).success) ||
          new Set(roster.map(row => row.id)).size !== roster.length) throw new Error('Invalid roster');
      const selected = parsed.data.employeeId ? roster.filter(row => row.id === parsed.data.employeeId) : [...roster];
      if (parsed.data.employeeId && selected.length !== 1) return reply.code(404).send({ success: false, error: 'Employee not found.', errorCode: 'NOT_FOUND' });
      if (selected.length > FAILURE_REPORT_LIMIT) return reply.code(400).send({ success: false, error: 'Select one employee to read this larger roster.', errorCode: 'INVALID_INPUT' });
      const binding = selected.map(row => ({ id: row.id, owner: row.owner }));
      const ids = binding.map(row => row.id);
      const observed = await (deps.read ?? readCommandFailures)(ids);
      if (!authorized(req)) return denied(reply);
      const current = deps.employees();
      if (current.some(row => !FailureEmployeeId.safeParse(row.id).success) ||
          new Set(current.map(row => row.id)).size !== current.length ||
          binding.some(row => current.filter(candidate => candidate.id === row.id && candidate.owner === row.owner).length !== 1) ||
          (parsed.data.employeeId === undefined && (current.length !== binding.length || current.some(row => !ids.includes(row.id))))) {
        return reply.code(409).send({ success: false, error: 'The employee roster changed. Refresh the view.', errorCode: 'CONFLICT' });
      }
      const data = parseFailureReport(observed, ids);
      if (!authorized(req)) return denied(reply);
      return { success: true, data };
    } catch {
      if (!authorized(req)) return denied(reply);
      return reply.code(503).send({ success: false, error: 'Command failure metadata is unavailable.', errorCode: 'SERVICE_UNAVAILABLE' });
    }
  });
}
