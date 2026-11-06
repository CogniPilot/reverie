/** Path-free, authenticated current-employee memory policy. No native effect. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { MemoryScopePublisher, MemoryScopeRequestSchema } from '../../memory-scope-publisher.js';
import { currentEmployeeCaller, type EmployeeCallerSource } from '../employee-caller.js';
import type { SessionPort } from '../ports/session-port.js';

export function registerMemoryScopeRoutes(
  app: FastifyInstance,
  ctx: Pick<SessionPort, 'sessions'>,
  source: EmployeeCallerSource,
  publisher?: MemoryScopePublisher
): void {
  app.post('/api/agent/memory-scope', { bodyLimit: 16 * 1024 }, async (request: FastifyRequest, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    const refused = () =>
      reply
        .code(403)
        .send({
          success: false,
          errorCode: 'MEMORY_SCOPE_FORBIDDEN',
          error: 'Memory scope unavailable for this caller',
        });
    try {
      const caller = currentEmployeeCaller(request, ctx, source);
      if (!caller || !publisher) return refused();
      const parsed = MemoryScopeRequestSchema.safeParse(request.body);
      if (!parsed.success)
        return reply
          .code(400)
          .send({ success: false, errorCode: 'MEMORY_SCOPE_INVALID', error: 'Invalid memory scope request' });
      const checked = await publisher.check(caller, parsed.data);
      return checked ? { success: true, data: checked } : refused();
    } catch {
      return refused();
    }
  });
}
