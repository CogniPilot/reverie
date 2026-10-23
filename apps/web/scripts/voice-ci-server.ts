/** Isolated route fixture; never starts a real agent, owner instance or public listener. */
import Fastify from 'fastify';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ChatroomService, type ChatSessionLike } from '../src/chatroom-service.js';
import { registerVoiceSpeakRoutes } from '../src/web/routes/voice-speak-routes.js';
import { registerVoiceTurnRoutes } from '../src/web/routes/voice-turn-routes.js';
import { installRouteErrorHandler } from '../src/web/route-error-handler.js';

const artifacts = resolve(process.env.REVERIE_VOICE_CI_ARTIFACTS!);
const speech = (await readFile(resolve(artifacts, 'speech-url.txt'), 'utf8')).trim();
if (new URL(speech).hostname !== '127.0.0.1') throw new Error('Fixture speech service must be loopback');
const fixture = JSON.parse(await readFile(resolve('scripts/voice-ci/fixtures.json'), 'utf8'));
const member: ChatSessionLike = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Voice fixture',
  mode: 'codex',
  status: 'idle',
  isWorking: false,
  pid: null,
  writeViaMux: async () => true,
};
const service = new ChatroomService({
  file: resolve(artifacts, 'chatrooms.json'),
  getSession: (id) => (id === member.id ? member : undefined),
  broadcast: () => {},
});
const room = service.createRoom('Voice CI fixture', 'voice-ci');
service.addMember(room.id, member.id, { voice: true });
service.onMessage((r, message) => {
  if (message.from.kind !== 'user' || !message.spoken) return;
  setImmediate(() =>
    service.post(r.id, { kind: 'agent', sessionId: member.id, name: member.name }, fixture.reply, ['user'], {
      replyTo: message.id,
    })
  );
});
const app = Fastify({ logger: false });
app.addHook('onRequest', async (req) => {
  Object.assign(req, { authUser: { username: 'voice-ci', role: 'admin' } });
});
installRouteErrorHandler(app);
registerVoiceSpeakRoutes(app, service, {
  kokoroUrl: () => speech,
  piperUrl: () => speech,
  employeeVoice: () => ({ provider: 'kokoro', id: fixture.voice }),
});
registerVoiceTurnRoutes(app, service, { serviceUrl: () => speech, replyWaitMs: 5000 });
app.get('/fixture', async () => ({ room: room.id, member: member.id, ...fixture }));
for (const name of ['voice-chat.js', 'car-mode.js']) {
  app.get(`/${name}`, async (_req, reply) =>
    reply.type('application/javascript').send(await readFile(resolve('apps/web/src/web/public', name), 'utf8'))
  );
}
app.get('/', async (_req, reply) =>
  reply.type('text/html').send(`<!doctype html>
<html lang="en"><title>Voice CI fixture</title><div id="car"><div class="car-voice-notice" hidden></div></div>
<audio id="audio"></audio><script>class ReverieApp {}</script>
<script src="/voice-chat.js"></script><script src="/car-mode.js"></script></html>`)
);
await app.listen({ host: '127.0.0.1', port: 0 });
await writeFile(resolve(artifacts, 'console-url.txt'), app.listeningOrigin);
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.once(signal, () => {
    void app
      .close()
      .then(() => service.stop())
      .then(() => process.exit(0));
  });
