/**
 * @fileoverview Push notification routes.
 * Manages VAPID keys, push subscriptions, and preference updates.
 */

import { FastifyInstance, type FastifyRequest } from 'fastify';
import { sendDeviceTest } from '../../chat-push.js';
import { isMultiUserMode } from '../../config/multiuser.js';
import { v4 as uuidv4 } from 'uuid';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { PushSubscribeSchema, PushPreferencesUpdateSchema } from '../schemas.js';
import { parseBody } from '../route-helpers.js';
import type { InfraPort } from '../ports/index.js';

export function registerPushRoutes(app: FastifyInstance, ctx: InfraPort): void {
  const isHuman = (req: FastifyRequest): boolean => !req.headers['x-codeman-parent-session'];
  const ownsDevice = (req: FastifyRequest, id: string): boolean => {
    const sub = ctx.pushStore.get(id);
    return !!sub && isHuman(req) && (!isMultiUserMode() || (!!req.authUser && sub.username === req.authUser.username));
  };
  app.get('/api/push/vapid-key', async () => {
    return { success: true, data: { publicKey: ctx.pushStore.getPublicKey() } };
  });

  app.post('/api/push/subscribe', async (req, reply) => {
    if (!isHuman(req))
      return reply
        .code(403)
        .send(createErrorResponse(ApiErrorCode.FORBIDDEN, 'Only the user manages device notifications'));
    const { endpoint, keys, userAgent, pushPreferences } = parseBody(PushSubscribeSchema, req.body);
    const record = ctx.pushStore.addSubscription({
      id: uuidv4(),
      endpoint,
      keys,
      userAgent: userAgent ?? req.headers['user-agent'] ?? '',
      createdAt: Date.now(),
      pushPreferences: pushPreferences ?? {},
      // Multi-user: stamp the trusted caller identity so sendPushNotifications can
      // scope session notifications to the owner (+ admins). Undefined in single-user.
      username: req.authUser?.username,
      role: req.authUser?.role,
    });
    return { success: true, data: { id: record.id } };
  });

  app.put('/api/push/subscribe/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { pushPreferences } = parseBody(PushPreferencesUpdateSchema, req.body);
    if (!ownsDevice(req, id))
      return reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'Subscription not found'));
    const updated = ctx.pushStore.updatePreferences(id, pushPreferences);
    if (!updated) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Subscription not found');
    }
    return {};
  });

  app.delete('/api/push/subscribe/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!ownsDevice(req, id))
      return reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'Subscription not found'));
    const removed = ctx.pushStore.removeSubscription(id);
    if (!removed) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Subscription not found');
    }
    return {};
  });

  app.post('/api/push/subscribe/:id/test', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!ownsDevice(req, id))
      return reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'Subscription not found'));
    const sent = await sendDeviceTest(ctx.pushStore, ctx.pushStore.get(id)!);
    if (!sent)
      return reply
        .code(502)
        .send(
          createErrorResponse(
            ApiErrorCode.OPERATION_FAILED,
            'Push service did not accept the test. Enable notifications again and retry.'
          )
        );
    return { success: true, data: { accepted: true } };
  });
}
