import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { SessionPort } from '../ports/session-port.js';
import { ownerFor, parseBody } from '../route-helpers.js';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import {
  ExternalChatError,
  ExternalConnectSchema,
  ExternalEnabledSchema,
  ExternalLinkSchema,
  ExternalTransportError,
} from '../../external-chat-types.js';
import type { ExternalChatService } from '../../external-chat-service.js';

/** Configuration is an explicit owner action. Never expose stored credentials or
 * accept upstream URLs, sender identities, token query strings, or user tokens. */
export function registerExternalChatRoutes(
  app: FastifyInstance,
  _ctx: SessionPort,
  service: ExternalChatService
): void {
  app.addHook('onRoute', (options) => {
    // No global behavior: all route authorization remains in the handler below.
    if (options.url.startsWith('/api/external-chat')) options.logLevel = 'silent';
  });
  const handle =
    (fn: (req: FastifyRequest) => unknown) =>
    async (req: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
      // Present at all, even empty, means an agent asked: only an absent header is the owner dashboard.
      if (req.headers['x-codeman-parent-session'] !== undefined) {
        return reply
          .code(403)
          .send(
            createErrorResponse(ApiErrorCode.FORBIDDEN, 'External chat configuration requires the owner dashboard')
          );
      }
      try {
        return { success: true, data: await fn(req) };
      } catch (error) {
        if (error instanceof ExternalChatError) {
          return reply
            .code(error.code === 'NOT_FOUND' ? 404 : error.code === 'CONFLICT' ? 409 : 400)
            .send(createErrorResponse(ApiErrorCode[error.code], error.message));
        }
        if (error instanceof ExternalTransportError) {
          return reply.code(502).send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, error.message));
        }
        // Zod and I/O errors must never echo token input or upstream response data.
        return reply
          .code(400)
          .send(
            createErrorResponse(
              ApiErrorCode.INVALID_INPUT,
              'External chat request failed; check the configuration and server storage'
            )
          );
      }
    };
  const param = (req: FastifyRequest, key: string): string => (req.params as Record<string, string>)[key];
  app.get(
    '/api/external-chat',
    handle((req) => service.snapshot(ownerFor(req)))
  );
  app.post(
    '/api/external-chat/connections',
    handle((req) => service.connect(ownerFor(req), parseBody(ExternalConnectSchema, req.body)))
  );
  app.put(
    '/api/external-chat/connections/:id',
    handle((req) =>
      service.setEnabled(ownerFor(req), param(req, 'id'), parseBody(ExternalEnabledSchema, req.body).enabled)
    )
  );
  app.delete(
    '/api/external-chat/connections/:id',
    handle((req) => service.remove(ownerFor(req), param(req, 'id')))
  );
  app.get(
    '/api/external-chat/connections/:id/channel',
    handle((req) => {
      const channelId = (req.query as { channelId?: unknown }).channelId;
      if (typeof channelId !== 'string' || channelId.length > 100) throw new ExternalChatError('Choose a channel ID');
      return service.channel(ownerFor(req), param(req, 'id'), channelId);
    })
  );
  app.post(
    '/api/external-chat/connections/:id/links',
    handle((req) => service.link(ownerFor(req), param(req, 'id'), parseBody(ExternalLinkSchema, req.body)))
  );
  app.delete(
    '/api/external-chat/links/:id',
    handle((req) => service.unlink(ownerFor(req), param(req, 'id')))
  );
}
