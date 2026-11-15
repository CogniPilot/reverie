/** Human owner resource approval. Recovery/office titles or worker headers never imply this permission. */
import type { FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import { CompanyError } from '../../company-service.js';
import { DockerEmployeeContinuationError } from '../../docker-employee-continuation.js';
import {
  DockerMemoryHigh,
  dockerDefaultPublicationRefusal,
  dockerAttemptPublicationRefusal,
} from '../../docker-resource-revisions.js';
import type { DockerResourceRevisionService } from '../../docker-resource-revision-service.js';
import type { DockerContinuationRouteAuthentication } from './docker-employee-continuation-routes.js';
const uuid = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase());
export function registerDockerResourceRevisionRoutes(
  app: FastifyInstance,
  service: DockerResourceRevisionService,
  auth: DockerContinuationRouteAuthentication
): void {
  const authority = (req: import('fastify').FastifyRequest) => {
    const owner = auth.owner(req);
    const require = () => {
      if (
        req.headers['x-reverie-parent-session'] !== undefined ||
        req.headers['x-reverie-worker-identity'] !== undefined ||
        req.headers['x-reverie-service-token'] !== undefined ||
        !auth.verifiedOwner(req) ||
        auth.owner(req) !== owner
      )
        throw new CompanyError('Verified resource owner required', 403);
    };
    require();
    return { owner, require };
  };
  const run = async (reply: import('fastify').FastifyReply, body: () => Promise<unknown>) => {
    try {
      return { success: true, data: await body() };
    } catch (error) {
      const notIssued = dockerDefaultPublicationRefusal(error) ?? dockerAttemptPublicationRefusal(error);
      if (notIssued) return reply.code(409).send({ success: false, error: notIssued });
      if (error instanceof DockerEmployeeContinuationError)
        return reply.code(error.status).send({ success: false, error: { code: error.code } });
      if (error instanceof CompanyError)
        return reply.code(error.status).send({ success: false, error: { code: 'DOCKER_RESOURCE_REVISION_REFUSED' } });
      if (error instanceof ZodError)
        return reply.code(400).send({ success: false, error: { code: 'DOCKER_RESOURCE_REVISION_INVALID_INPUT' } });
      return reply.code(409).send({ success: false, error: { code: 'DOCKER_RESOURCE_REVISION_UNCONFIRMED' } });
    }
  };
  app.get('/api/company/docker-resources', async (req, reply) =>
    run(reply, async () => {
      const grant = authority(req);
      return service.status(grant.owner, grant.require);
    })
  );
  app.put('/api/company/docker-resources/default', async (req, reply) =>
    run(reply, async () => {
      const grant = authority(req),
        body = z
          .object({
            revision: uuid,
            expectedRevision: uuid.nullable(),
            scope: z.literal('all-current-and-future'),
            memoryHighBytes: DockerMemoryHigh,
          })
          .strict()
          .parse(req.body);
      return service.approve(
        {
          revision: body.revision,
          owner: grant.owner ?? null,
          scope: body.scope,
          memoryHighBytes: body.memoryHighBytes,
        },
        body.expectedRevision,
        grant.require
      );
    })
  );
  app.get('/api/company/employees/:id/docker-resources', async (req, reply) =>
    run(reply, async () => {
      const grant = authority(req),
        employeeId = uuid.parse((req.params as { id: string }).id);
      return service.observe(employeeId, grant.owner, grant.require);
    })
  );
  for (const action of ['continue', 'abandon'] as const) {
    app.post('/api/company/employees/:id/docker-resources/' + action, async (req, reply) =>
      run(reply, async () => {
        const grant = authority(req),
          employeeId = uuid.parse((req.params as { id: string }).id);
        const body = z.object({ revision: uuid }).strict().parse(req.body);
        return action === 'continue'
          ? service.continueOriginal(employeeId, grant.owner, body.revision, grant.require)
          : service.abandonOriginal(employeeId, grant.owner, body.revision, grant.require);
      })
    );
  }
  app.post('/api/company/employees/:id/docker-resources/reconcile', async (req, reply) =>
    run(reply, async () => {
      const grant = authority(req),
        employeeId = uuid.parse((req.params as { id: string }).id);
      const body = z.object({ revision: uuid }).strict().parse(req.body);
      return service.reconcile(employeeId, grant.owner, body.revision, grant.require);
    })
  );
  app.post('/api/company/employees/:id/docker-resources/apply', async (req, reply) =>
    run(reply, async () => {
      const grant = authority(req),
        employeeId = uuid.parse((req.params as { id: string }).id);
      const body = z.object({ revision: uuid }).strict().parse(req.body);
      return service.apply(employeeId, grant.owner, body.revision, grant.require);
    })
  );
}
