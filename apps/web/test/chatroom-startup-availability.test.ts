import { afterEach, expect, it, vi } from 'vitest';
import { WebServer } from '../src/web/server.js';
import { ChatroomService } from '../src/chatroom-service.js';
import { PendingDeliveryStore } from '../src/chatroom-pending-delivery.js';
import { dataPath } from '../src/config/instance.js';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { OWNER_COOKIE } from '../src/owner-auth/policy.js';

let server: WebServer | undefined;
const previousApiUrl = process.env.REVERIE_API_URL;
afterEach(async () => {
  await server?.stop();
  server = undefined;
  vi.restoreAllMocks();
  if (previousApiUrl === undefined) delete process.env.REVERIE_API_URL;
  else process.env.REVERIE_API_URL = previousApiUrl;
});

it('keeps real HTTP history reads available and refuses writes when delivery recovery fails after listen', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  let roomId = '';
  const init = ChatroomService.prototype.init;
  vi.spyOn(ChatroomService.prototype, 'init').mockImplementation(async function (this: ChatroomService) {
    await init.call(this);
    const room = this.createRoom('Workshop', undefined);
    roomId = room.id;
    this.post(room.id, { kind: 'user', name: 'Owner' }, 'committed history before recovery');
  });
  const alert = vi.spyOn(ChatroomService.prototype as unknown as { raiseAlert(text: string): Promise<void> }, 'raiseAlert')
    .mockResolvedValue();
  vi.spyOn(PendingDeliveryStore.prototype, 'list').mockImplementationOnce(() => { throw new Error('recovery IO failure'); });
  // testMode suppresses session restoration and external processes; global setup owns its synthetic HOME/data.
  const password = 'Synthetic-chat-readonly-owner-93!';
  const auth = new OwnerAuthService({
    store: new OwnerAuthStore(dataPath('owner-auth.json')),
    auditFile: dataPath('owner-auth-audit.jsonl'),
    setupEnabled: true,
  });
  await auth.setup('fixture-owner', password, password, '127.0.0.1');
  server = new WebServer(0, false, true);
  await expect(server.start()).resolves.toBeUndefined();
  const origin = `http://127.0.0.1:${server.boundPort}`;
  const url = `${origin}/api/chatrooms/${roomId}/messages`;
  const login = await fetch(origin + '/api/owner/login', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'fixture-owner', password }),
  });
  expect(login.status).toBe(200);
  const cookie = login.headers.getSetCookie().find((value) => value.startsWith(`${OWNER_COOKIE}=`))?.split(';')[0];
  expect(cookie).toBeTruthy();
  const headers = { origin, cookie: cookie!, 'content-type': 'application/json' };
  expect((await fetch(url)).status).toBe(401);
  const history = await fetch(url, { headers });
  expect(history.status).toBe(200);
  expect(await history.text()).toContain('committed history before recovery');
  const post = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ text: 'must not commit' }) });
  expect(post.status).toBe(503);
  expect(await (await fetch(url, { headers })).text()).not.toContain('must not commit');
  expect(alert).toHaveBeenCalledOnce();
  expect(alert).toHaveBeenCalledWith(expect.stringContaining('Chat is read-only'));
});
