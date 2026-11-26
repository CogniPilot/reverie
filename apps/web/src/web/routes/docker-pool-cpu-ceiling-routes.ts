/** Human owner approval of the employee group CPU ceiling. Recovery or office
 * permissions, titles and worker headers never imply this permission. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DockerPoolCpuCores } from '../../docker-pool-cpu-ceiling-data.js';
import type { DockerPoolCpuCeiling } from '../../docker-pool-cpu-ceiling.js';
import {
  dockerOwnerResourceAuthority,
  dockerOwnerResourceRun,
  type DockerOwnerResourceAuthentication,
} from './docker-owner-resource-route.js';
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
const prefix = 'DOCKER_POOL_CPU_CEILING';
export function registerDockerPoolCpuCeilingRoutes(
  app: FastifyInstance,
  service: DockerPoolCpuCeiling,
  auth: DockerOwnerResourceAuthentication
): void {
  app.get('/api/company/docker-resources/cpu-ceiling', async (req, reply) =>
    dockerOwnerResourceRun(prefix, reply, async () => service.status(dockerOwnerResourceAuthority(auth, req).require))
  );
  app.put('/api/company/docker-resources/cpu-ceiling', async (req, reply) =>
    dockerOwnerResourceRun(prefix, reply, async () => {
      const grant = dockerOwnerResourceAuthority(auth, req, true);
      const body = approval.parse(req.body);
      return service.approve(
        { revision: body.revision, expectedRevision: body.expectedRevision, cpuCores: body.cpuCores },
        grant.owner,
        grant.require
      );
    })
  );
}
