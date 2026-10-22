import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ownerFor, parseBody } from '../route-helpers.js';
import type { OwnerVerifier } from '../../owner-auth/marks.js';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import {
  EmbassyGuestEnabledSchema,
  EmbassyGuestError,
  EmbassyGuestJoinSchema,
  EmbassyGuestKeySchema,
  EmbassyGuestPostSchema,
  type EmbassyGuestClient,
} from '../../embassy-guest-client.js';

/** Embassy guest rooms are an owner-dashboard action. Every route, reads included, needs a signed-in full owner
 * session (the owner cookie, checked whatever the policy mode) and refuses any agent session header; no response ever
 * carries the invite key or the session secret. Request logging is off, so a pasted key never reaches a log line. */
export function registerEmbassyGuestRoutes(
  app: FastifyInstance,
  client: EmbassyGuestClient,
  verifiedOwner: OwnerVerifier
): void {
  app.addHook('onRoute', (options) => {
    if (options.url.startsWith('/api/embassy-guest')) options.logLevel = 'silent';
  });
  const handle =
    (fn: (req: FastifyRequest) => unknown) =>
    async (req: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
      if (req.headers['x-reverie-parent-session'] !== undefined || !verifiedOwner(req)) {
        return reply
          .code(403)
          .send(createErrorResponse(ApiErrorCode.FORBIDDEN, 'Embassy rooms require a signed-in owner'));
      }
      try {
        return { success: true, data: await fn(req) };
      } catch (error) {
        if (error instanceof EmbassyGuestError) {
          const status = { INVALID_INPUT: 400, NOT_FOUND: 404, CONFLICT: 409, UPSTREAM: 502 }[error.code];
          const code = error.code === 'UPSTREAM' ? ApiErrorCode.OPERATION_FAILED : ApiErrorCode[error.code];
          return reply.code(status).send(createErrorResponse(code, error.message));
        }
        // Validation and I/O errors never echo the request body (it may hold a key).
        return reply
          .code(400)
          .send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Embassy request refused; check the input'));
      }
    };
  const id = (req: FastifyRequest): string => {
    const value = (req.params as Record<string, string>).id;
    if (!/^[0-9a-f-]{36}$/.test(value)) throw new EmbassyGuestError('NOT_FOUND', 'Embassy room not found');
    return value;
  };
  app.get(
    '/api/embassy-guest',
    handle((req) => client.list(ownerFor(req)))
  );
  app.post(
    '/api/embassy-guest/preview',
    handle((req) => client.preview(parseBody(EmbassyGuestKeySchema, req.body).key))
  );
  app.post(
    '/api/embassy-guest/join',
    handle((req) => {
      const body = parseBody(EmbassyGuestJoinSchema, req.body);
      return client.join(ownerFor(req), body.key, body.confirmedOrigin);
    })
  );
  app.get(
    '/api/embassy-guest/:id/posts',
    handle((req) => {
      const raw = (req.query as { after?: unknown }).after ?? '0';
      if (typeof raw !== 'string' || !/^\d{1,15}$/.test(raw)) throw new EmbassyGuestError('INVALID_INPUT', 'Invalid cursor');
      return client.posts(ownerFor(req), id(req), Number(raw));
    })
  );
  app.post(
    '/api/embassy-guest/:id/posts',
    handle((req) => client.post(ownerFor(req), id(req), parseBody(EmbassyGuestPostSchema, req.body)))
  );
  app.put(
    '/api/embassy-guest/:id',
    handle((req) => client.setEnabled(ownerFor(req), id(req), parseBody(EmbassyGuestEnabledSchema, req.body).enabled))
  );
  app.delete(
    '/api/embassy-guest/:id',
    handle((req) => client.leave(ownerFor(req), id(req)))
  );
}
