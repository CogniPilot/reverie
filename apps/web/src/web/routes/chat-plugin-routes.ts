/** Owner-triggered, local snippet assistance. Disabled pages never call these routes. */
import type { FastifyInstance } from 'fastify';
import { ChatLanguageRequest, ChatLanguageService } from '../../chat-language-service.js';
import type { OwnerVerifier } from '../../owner-auth/marks.js';
import { ChatPluginSettingsSchema, ChatPluginSettingsStore } from '../../chat-plugin-settings.js';

export function registerChatPluginRoutes(
  app: FastifyInstance,
  verifiedOwner: OwnerVerifier,
  service?: ChatLanguageService,
  settings = new ChatPluginSettingsStore()
): void {
  const languageService = service ?? new ChatLanguageService({ enabled: (language) => settings.read()[language] });
  app.addHook('onClose', async () => languageService.stop());
  app.get('/api/chat-plugins', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return {
      success: true,
      data: {
        enabled: settings.read(),
        available: await languageService.available(),
        canManage: verifiedOwner(request),
      },
    };
  });
  app.put('/api/chat-plugins', { bodyLimit: 1024 }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!verifiedOwner(request))
      return reply.code(403).send({ success: false, error: 'Owner sign-in required', errorCode: 'FORBIDDEN' });
    const parsed = ChatPluginSettingsSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ success: false, error: 'Invalid plugin settings', errorCode: 'INVALID_INPUT' });
    try {
      const enabled = await settings.save(parsed.data);
      for (const language of ['python', 'modelica'] as const) {
        if (!enabled[language]) languageService.cancel(language);
      }
      return { success: true, data: { enabled, available: await languageService.available(), canManage: true } };
    } catch {
      return reply
        .code(500)
        .send({ success: false, error: 'Plugin settings could not be saved', errorCode: 'PERSISTENCE_ERROR' });
    }
  });
  app.post('/api/chat-plugins/lsp', { bodyLimit: 310000 }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!verifiedOwner(request))
      return reply.code(403).send({ success: false, error: 'Owner sign-in required', errorCode: 'FORBIDDEN' });
    const parsed = ChatLanguageRequest.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ success: false, error: 'Invalid snippet request', errorCode: 'INVALID_INPUT' });
    if (!settings.read()[parsed.data.language])
      return reply
        .code(403)
        .send({ success: false, error: 'This language plugin is disabled by the owner', errorCode: 'PLUGIN_DISABLED' });
    const controller = new AbortController();
    const close = (): void => {
      if (!reply.raw.writableEnded) controller.abort();
    };
    reply.raw.once('close', close);
    try {
      return { success: true, data: await languageService.assist(parsed.data, controller.signal) };
    } catch (error) {
      return reply.code(503).send({
        success: false,
        error: error instanceof Error ? error.message : 'Language assistance unavailable',
        errorCode: 'SERVICE_UNAVAILABLE',
      });
    } finally {
      reply.raw.removeListener('close', close);
    }
  });
}
