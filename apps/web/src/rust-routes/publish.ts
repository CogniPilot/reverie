/**
 * The last step of every forwarded route, in one synchronous tick: generation, then liveness, then
 * authorization, then publication. A reply is published only if its generation is still live, the
 * response can still be written and the caller is still authorized; the TS route itself is never run
 * as a fallback.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiErrorCode, createErrorResponse } from '../types.js';
import type { Outcome, RouteChannel } from './channel.js';

/** `fixedContentType` is a plain route's content type; a typed route's outcome carries its own. */
export function publishOutcome(
  channel: RouteChannel,
  outcome: Outcome,
  req: FastifyRequest,
  reply: FastifyReply,
  authorized: () => boolean,
  forbidden: () => unknown,
  fixedContentType?: string
): unknown {
  const current = outcome.kind === 'response' && channel.isCurrent(outcome.generation);
  if (reply.sent || reply.raw.destroyed || reply.raw.writableEnded || req.raw.socket?.destroyed) {
    reply.hijack();
    return undefined;
  }
  if (!authorized()) return reply.code(403).send(forbidden());
  const contentType = outcome.kind === 'response' ? (outcome.contentType ?? fixedContentType) : undefined;
  if (current && outcome.kind === 'response' && contentType)
    return reply.code(outcome.status).type(contentType).send(outcome.body);
  return reply
    .code(503)
    .send(
      createErrorResponse(
        ApiErrorCode.OPERATION_FAILED,
        `The Rust route handler could not answer (request ${outcome.generation}-${outcome.id}). Nothing was changed.`
      )
    );
}
