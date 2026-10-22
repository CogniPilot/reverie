import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { BuiltinEmbassy } from '../../embassy-builtin.js';
import { EmbassyPairError } from '../../embassy-pair-key.js';
import { EMBASSY_CSRF_HEADER } from './embassy-pairing-routes.js';
import { isAllowedRequestOrigin, type HostPolicy } from '../network-auth-policy.js';

/** Public protocol endpoints are capability-authenticated here, never console-cookie authenticated. */
export function registerBuiltinEmbassyRoutes(
  app: FastifyInstance,
  host: BuiltinEmbassy,
  verifiedOwner: (req: FastifyRequest) => boolean,
  policy: () => HostPolicy
) {
  const handle =
    (action: (req: FastifyRequest) => Promise<unknown>) => async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        return await action(req);
      } catch (error) {
        if (error instanceof EmbassyPairError)
          return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
        if (error instanceof z.ZodError)
          return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'Invalid Embassy request' } });
        return reply.code(503).send({ error: { code: 'UNAVAILABLE', message: 'Embassy state is unavailable' } });
      }
    };
  app.post('/api/embassy-host/settings', { bodyLimit: 4096 }, async (req, reply) => {
    if (req.headers['x-reverie-parent-session'] !== undefined || !verifiedOwner(req))
      return reply
        .code(403)
        .send({ success: false, error: 'Only the signed-in owner may configure the Embassy address' });
    const origin = req.headers.origin;
    if (
      req.headers[EMBASSY_CSRF_HEADER] !== '1' ||
      origin === 'null' ||
      (origin !== undefined && !isAllowedRequestOrigin(origin, policy()))
    )
      return reply.code(403).send({ success: false, error: 'Use this console to configure its Embassy address' });
    try {
      const body = z
        .object({ origin: z.string().max(300) })
        .strict()
        .parse(req.body);
      return { success: true, data: await host.configure(body.origin) };
    } catch (error) {
      return reply
        .code(error instanceof EmbassyPairError ? error.status : 400)
        .send({ success: false, error: error instanceof EmbassyPairError ? error.message : 'Invalid Embassy address' });
    }
  });
  for (const action of ['request', 'status', 'claim', 'cancel'] as const) {
    app.post(
      '/api/embassy/pair-' + action,
      { bodyLimit: 8192 },
      handle((req) => {
        host.checkRate(req.ip, action);
        return host.pair(action, req.body, typeof req.headers.origin === 'string' ? req.headers.origin : undefined);
      })
    );
  }
  app.get(
    '/embassy/rooms/:roomId/posts',
    handle((req) => {
      host.checkRate(req.ip, 'posts');
      return host.guestPosts(
        (req.params as { roomId: string }).roomId,
        req.cookies?.embassy_guest,
        (req.query as { after?: unknown }).after,
        undefined,
        typeof req.headers.origin === 'string' ? req.headers.origin : undefined
      );
    })
  );
  app.post(
    '/embassy/rooms/:roomId/posts',
    { bodyLimit: 20_000 },
    handle((req) => {
      host.checkRate(req.ip, 'posts');
      return host.guestPosts(
        (req.params as { roomId: string }).roomId,
        req.cookies?.embassy_guest,
        undefined,
        req.body,
        typeof req.headers.origin === 'string' ? req.headers.origin : undefined
      );
    })
  );
}
