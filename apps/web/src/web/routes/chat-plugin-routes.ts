/** Owner-triggered, local snippet assistance. Disabled pages never call these routes. */
import type { FastifyInstance } from 'fastify';
import { ChatLanguageRequest, ChatLanguageService } from '../../chat-language-service.js';
import type { OwnerVerifier } from '../../owner-auth/marks.js';

export function registerChatPluginRoutes(
  app: FastifyInstance,
  verifiedOwner: OwnerVerifier,
  service = new ChatLanguageService()
): void {
  app.addHook('onClose', async () => service.stop());
  app.get('/api/chat-plugins', async (request, reply) => {
    if (!verifiedOwner(request))
      return reply.code(403).send({ success: false, error: 'Owner sign-in required', errorCode: 'FORBIDDEN' });
    reply.header('Cache-Control', 'no-store');
    return { success: true, data: await service.available() };
  });
  app.post('/api/chat-plugins/lsp', { bodyLimit: 310000 }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!verifiedOwner(request))
      return reply.code(403).send({ success: false, error: 'Owner sign-in required', errorCode: 'FORBIDDEN' });
    const parsed = ChatLanguageRequest.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ success: false, error: 'Invalid snippet request', errorCode: 'INVALID_INPUT' });
    const controller = new AbortController();
    const close = (): void => {
      if (!reply.raw.writableEnded) controller.abort();
    };
    reply.raw.once('close', close);
    try {
      return { success: true, data: await service.assist(parsed.data, controller.signal) };
    } catch (error) {
      return reply
        .code(503)
        .send({
          success: false,
          error: error instanceof Error ? error.message : 'Language assistance unavailable',
          errorCode: 'SERVICE_UNAVAILABLE',
        });
    } finally {
      reply.raw.removeListener('close', close);
    }
  });
}
