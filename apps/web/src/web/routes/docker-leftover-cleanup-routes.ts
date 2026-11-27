/** Human owner report and removal of superseded laptop leftovers on the Docker
 * host. Recovery or office permissions, titles and worker headers never imply
 * this permission. The report is a read; only the apply removes anything. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DockerLeftoverCleanup } from '../../docker-leftover-cleanup.js';
import {
  dockerOwnerResourceAuthority,
  dockerOwnerResourceRun,
  type DockerOwnerResourceAuthentication,
} from './docker-owner-resource-route.js';
const confirmation = z.object({ expectedDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const prefix = 'DOCKER_LEFTOVER';
export function registerDockerLeftoverCleanupRoutes(
  app: FastifyInstance,
  service: DockerLeftoverCleanup,
  auth: DockerOwnerResourceAuthentication
): void {
  app.get('/api/company/docker-resources/leftovers', async (req, reply) =>
    dockerOwnerResourceRun(prefix, reply, async () => service.report(dockerOwnerResourceAuthority(auth, req).require))
  );
  app.post('/api/company/docker-resources/leftovers/apply', async (req, reply) =>
    dockerOwnerResourceRun(prefix, reply, async () => {
      const grant = dockerOwnerResourceAuthority(auth, req, true);
      return service.apply(confirmation.parse(req.body), grant.require);
    })
  );
}
