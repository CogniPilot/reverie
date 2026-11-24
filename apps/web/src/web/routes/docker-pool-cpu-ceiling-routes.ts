/** Human owner approval of the employee group CPU ceiling. Recovery or office
 * permissions, titles and worker headers never imply this permission. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { CompanyError } from '../../company-service.js';
import { DockerEmployeeContinuationError } from '../../docker-employee-continuation.js';
import { DockerPoolCpuCores } from '../../docker-pool-cpu-ceiling-data.js';
import type { DockerPoolCpuCeiling } from '../../docker-pool-cpu-ceiling.js';
import { sameOrigin } from '../../owner-auth/policy.js';
import type { DockerContinuationRouteAuthentication } from './docker-employee-continuation-routes.js';
const uuid = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase());
const approval = z
  .object({
    revision: uuid,
    expectedRevision: uuid.nullable(),
    scope: z.literal('all-employees'),
    cpuCores: DockerPoolCpuCores.nullable(),
  })
  .strict();
export function registerDockerPoolCpuCeilingRoutes(
  app: FastifyInstance,
  service: DockerPoolCpuCeiling,
  auth: Pick<DockerContinuationRouteAuthentication, 'verifiedOwner' | 'owner'>
): void {
  const authority = (req: FastifyRequest) => {
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
  const run = async (reply: FastifyReply, body: () => Promise<unknown>) => {
    try {
      return { success: true, data: await body() };
    } catch (error) {
      if (error instanceof DockerEmployeeContinuationError)
        return reply.code(error.status).send({ success: false, error: { code: error.code } });
      if (error instanceof CompanyError)
        return reply.code(error.status).send({ success: false, error: { code: 'DOCKER_POOL_CPU_CEILING_REFUSED' } });
      if (error instanceof ZodError)
        return reply.code(400).send({ success: false, error: { code: 'DOCKER_POOL_CPU_CEILING_INVALID_INPUT' } });
      return reply.code(409).send({ success: false, error: { code: 'DOCKER_POOL_CPU_CEILING_UNCONFIRMED' } });
    }
  };
  app.get('/api/company/docker-resources/cpu-ceiling', async (req, reply) =>
    run(reply, async () => service.status(authority(req).require))
  );
  app.put('/api/company/docker-resources/cpu-ceiling', async (req, reply) =>
    run(reply, async () => {
      const grant = authority(req);
      if (!sameOrigin(req)) throw new CompanyError('Verified same-origin owner required', 403);
      const body = approval.parse(req.body);
      return service.approve(
        { revision: body.revision, expectedRevision: body.expectedRevision, cpuCores: body.cpuCores },
        grant.owner,
        grant.require
      );
    })
  );
}
