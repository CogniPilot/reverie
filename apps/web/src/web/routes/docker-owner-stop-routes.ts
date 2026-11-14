/** Permission-checked diagnostics. Neither route creates a helper or clears a stop. */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import { CompanyError } from '../../company-service.js';
import type { DockerContinuationRouteAuthentication } from './docker-employee-continuation-routes.js';
import { DockerOwnerStopDiagnostic, DockerOwnerStopDiagnosticError } from '../../docker-owner-stop-status.js';

export function registerDockerOwnerStopRoutes(
  app: FastifyInstance,
  service: DockerOwnerStopDiagnostic,
  auth: DockerContinuationRouteAuthentication
): void {
  const capture = (request: FastifyRequest) => {
    const worker = auth.worker(request),
      owner = worker ? worker.owner : auth.owner(request);
    const human = () =>
      request.headers['x-reverie-parent-session'] === undefined &&
      request.headers['x-reverie-worker-identity'] === undefined &&
      request.headers['x-reverie-service-token'] === undefined &&
      auth.verifiedOwner(request);
    const requireIdentity = () => {
      if (worker) worker.require();
      else if (!human()) throw new CompanyError('Verified owner or scoped office permission required', 403);
    };
    requireIdentity();
    return { employeeId: (request.params as { id: string }).id, owner, caller: worker?.sessionId, requireIdentity };
  };
  const run = async (reply: FastifyReply, action: () => unknown) => {
    try {
      return { success: true, data: action() };
    } catch (cause) {
      if (cause instanceof CompanyError)
        return reply.code(cause.status).send({
          success: false,
          error: { code: 'DOCKER_OWNER_STOP_OFFICE_REFUSED', message: cause.message, allowedActions: [] },
        });
      const code =
        cause instanceof ZodError
          ? 'DOCKER_OWNER_STOP_INVALID_INPUT'
          : cause instanceof DockerOwnerStopDiagnosticError
            ? cause.code
            : 'DOCKER_OWNER_STOP_UNCONFIRMED';
      return reply
        .code(cause instanceof ZodError ? 400 : 409)
        .send({ success: false, error: { code, allowedActions: [] } });
    }
  };
  app.get('/api/company/employees/:id/docker-stop/status', (request, reply) =>
    run(reply, () => {
      const actor = capture(request);
      return service.status(actor.employeeId, actor.owner, actor.caller, actor.requireIdentity);
    })
  );
  app.post('/api/company/employees/:id/docker-stop/reconcile', (request, reply) =>
    run(reply, () => {
      const actor = capture(request);
      return service.reconcile(actor.employeeId, request.body, actor.owner, actor.caller, actor.requireIdentity);
    })
  );
}
