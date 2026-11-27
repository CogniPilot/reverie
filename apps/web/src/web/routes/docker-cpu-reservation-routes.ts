/** Human owner view and decision of the CPUs kept free of every employee
 * laptop. Recovery or office permissions, titles and worker headers never
 * imply this permission. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DockerCpuList } from '../../docker-cpu-reservation-data.js';
import type { DockerCpuReservation } from '../../docker-cpu-reservation.js';
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
    reservedCpus: DockerCpuList,
  })
  .strict();
const prefix = 'DOCKER_CPU_RESERVATION';
export function registerDockerCpuReservationRoutes(
  app: FastifyInstance,
  service: DockerCpuReservation,
  auth: DockerOwnerResourceAuthentication
): void {
  app.get('/api/company/docker-resources/cpu-reservation', async (req, reply) =>
    dockerOwnerResourceRun(prefix, reply, async () => service.status(dockerOwnerResourceAuthority(auth, req).require))
  );
  app.put('/api/company/docker-resources/cpu-reservation', async (req, reply) =>
    dockerOwnerResourceRun(prefix, reply, async () => {
      const grant = dockerOwnerResourceAuthority(auth, req, true);
      const body = approval.parse(req.body);
      return service.approve(
        { revision: body.revision, expectedRevision: body.expectedRevision, reservedCpus: body.reservedCpus },
        grant.owner,
        grant.require
      );
    })
  );
}
