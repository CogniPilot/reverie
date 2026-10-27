/** Synthetic cookies from the real OfficeAuthService; no live account, Goal, socket, or effect. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OfficeAuthService } from '../src/owner-auth/office.js';
import { bootstrap } from '../src/owner-auth/admin.js';
import { registerOwnerRoutes } from '../src/owner-auth/routes.js';
import { registerOwnerPolicy, OWNER_COOKIE } from '../src/owner-auth/policy.js';
import { registerOfficeRoutes } from '../src/web/routes/office-routes.js';
import { ChatroomStore, type ChatSender } from '../src/chatroom-store.js';
import type { ChatroomService } from '../src/chatroom-service.js';
import type { SessionPort } from '../src/web/ports/session-port.js';

let directory: string, app: FastifyInstance, auth: OfficeAuthService;
let primary: string, limited: string;
const password = 'Synthetic-correct-harbor-42!';
const goalBoundary = vi.fn(async () => {
  throw new Error('Synthetic unavailable purpose boundary');
});
const goalHandler = vi.fn(async () => ({ mustNotExecute: true }));
async function call(method: 'GET' | 'POST', url: string, token?: string, payload?: object, extra = {}) {
  return app.inject({
    method,
    url,
    headers: {
      host: 'localhost',
      origin: 'http://localhost',
      ...(token ? { cookie: OWNER_COOKIE + '=' + token } : {}),
      ...extra,
    },
    ...(payload ? { payload } : {}),
  });
}
function token(response: Awaited<ReturnType<typeof call>>) {
  expect(response.statusCode, response.body).toBe(200);
  const value = response.cookies.find((c) => c.name === OWNER_COOKIE)?.value;
  expect(value).toBeTruthy();
  return value!;
}
async function signIn(username: string, temporary: string) {
  const initial = token(await call('POST', '/api/owner/login', undefined, { username, password: temporary }));
  return token(await call('POST', '/api/owner/password', initial, { current: temporary, next: password }));
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'goal-human-policy-'));
  const store = new OwnerAuthStore(join(directory, 'owner-auth.json'));
  const first = await bootstrap(store, 'fixture-owner', { enforce: true });
  auth = new OfficeAuthService({ store, auditFile: join(directory, 'audit.jsonl') });
  const rooms = new ChatroomStore(),
    room = rooms.create('fixture ordinary room', undefined);
  const chat = {
    rooms: () => rooms.list(),
    room: (id: string) => rooms.get(id),
    nameOf: () => 'Fixture',
    post: (id: string, from: ChatSender, text: string) => rooms.post(id, from, text),
  } as unknown as ChatroomService;
  app = Fastify();
  await app.register(cookie);
  registerOwnerPolicy(app, {
    service: auth,
    ctx: { sessions: new Map() } as unknown as SessionPort,
    isCapabilityRequest: () => false,
    relations: {
      known: () => false,
      related: () => false,
      upward: () => false,
      keeper: () => false,
      admin: () => false,
    },
    goalRequest: goalBoundary,
  });
  registerOwnerRoutes(app, auth, false);
  registerOfficeRoutes(app, auth, chat);
  app.get('/api/goals', goalHandler);
  primary = await signIn('fixture-owner', first.oneTimePassword);
  const invite = await call('POST', '/api/office/accounts', primary, {
    username: 'fixture-limited',
    name: 'Fixture Limited',
    role: 'limited',
    rooms: [room.id],
  });
  expect(invite.statusCode, invite.body).toBe(200);
  limited = await signIn('fixture-limited', invite.json().data.oneTimePassword);
  expect(auth.identity(limited)?.role).toBe('limited');
  goalBoundary.mockClear();
  goalHandler.mockClear();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
  await rm(directory, { recursive: true, force: true });
});
it.each(['off', 'log', 'enforce'] as const)(
  'keeps real Limited cookies outside the Goal boundary under %s policy',
  async (policy) => {
    // The production Office facade currently forces enforce with additional humans.
    // Vary only this enum to test the middleware's independent off/log boundary contract.
    vi.spyOn(auth, 'policy').mockReturnValue(policy);
    for (const extra of [{}, { 'x-reverie-parent-session': 'fixture-agent' }, { 'x-reverie-service-token': 'fake' }]) {
      const response = await call('GET', '/api/goals', limited, undefined, extra);
      expect(response.statusCode, response.body).toBe(403);
      expect(goalBoundary).not.toHaveBeenCalled();
      expect(goalHandler).not.toHaveBeenCalled();
    }
    // The original owner still reaches the rejecting purpose gate; it is never an owner bypass.
    expect((await call('GET', '/api/goals', primary)).statusCode).toBe(403);
    expect(goalBoundary).toHaveBeenCalledTimes(1);
    expect(goalHandler).not.toHaveBeenCalled();
  }
);
