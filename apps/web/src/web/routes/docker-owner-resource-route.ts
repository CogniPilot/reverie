/** Shared transport for box-wide owner resource decisions (group CPU ceiling,
 * CPU reservation). Only a verified human owner reads or decides: recovery or
 * office permissions, titles and worker headers never imply this permission. */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { CompanyError } from '../../company-service.js';
import { DockerEmployeeContinuationError } from '../../docker-employee-continuation.js';
import { sameOrigin } from '../../owner-auth/policy.js';
import type { DockerContinuationRouteAuthentication } from './docker-employee-continuation-routes.js';

export type DockerOwnerResourceAuthentication = Pick<DockerContinuationRouteAuthentication, 'verifiedOwner' | 'owner'>;

/** The owner of this request and a re-check that it still holds. */
export function dockerOwnerResourceAuthority(
  auth: DockerOwnerResourceAuthentication,
  req: FastifyRequest,
  write = false
): { owner: string | undefined; require: () => void } {
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
  if (write && !sameOrigin(req)) throw new CompanyError('Verified same-origin owner required', 403);
  return { owner, require };
}

/** Envelope with stable refusal codes under `prefix`. */
export async function dockerOwnerResourceRun(
  prefix: string,
  reply: FastifyReply,
  body: () => Promise<unknown>
): Promise<unknown> {
  try {
    return { success: true, data: await body() };
  } catch (error) {
    if (error instanceof DockerEmployeeContinuationError)
      return reply.code(error.status).send({ success: false, error: { code: error.code } });
    if (error instanceof CompanyError)
      return reply.code(error.status).send({ success: false, error: { code: prefix + '_REFUSED' } });
    if (error instanceof ZodError)
      return reply.code(400).send({ success: false, error: { code: prefix + '_INVALID_INPUT' } });
    return reply.code(409).send({ success: false, error: { code: prefix + '_UNCONFIRMED' } });
  }
}
