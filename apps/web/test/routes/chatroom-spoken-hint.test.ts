/**
 * @fileoverview The spoken-turn hint (chatroom-delivery.ts SPOKEN_TURN_HINT) end to end through the post route and
 * the pane: only a post the server marks owner_spoken (a verified owner session cookie, no agent header, spoken
 * true) is delivered with it. Unauthenticated claims are rejected before persistence; agent and typed owner posts
 * carry no spoken hint. Legacy unverified spoken metadata never becomes owner evidence on reload. Synthetic fixtures only.
 * Port: N/A (app.inject()).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createRouteTestHarness } from './_route-test-utils.js';
import { createMockSession, type MockRouteContext } from '../mocks/index.js';
import { recordCarried } from '../helpers/wake-payload.js';
import { ChatroomService } from '../../src/chatroom-service.js';
import { ChatFileStore } from '../../src/chatroom-files.js';
import { SPOKEN_TURN_HINT, renderForRecipient, answerLinkHint } from '../../src/chatroom-delivery.js';
import { loadChatrooms, type ChatMessage } from '../../src/chatroom-store.js';
import { registerChatroomRoutes } from '../../src/web/routes/chatroom-routes.js';
import { OwnerAuthStore } from '../../src/owner-auth/store.js';
import { OwnerAuthService } from '../../src/owner-auth/service.js';
import { registerOwnerRoutes } from '../../src/owner-auth/routes.js';
import { OWNER_COOKIE, registerOwnerPolicy } from '../../src/owner-auth/policy.js';
import { ownerVerifier } from '../../src/owner-auth/marks.js';
import * as admin from '../../src/owner-auth/admin.js';
import type { SessionPort } from '../../src/web/ports/session-port.js';

const USER = 'owner-test';
const ALPHA = '0000002d-0035-4000-8000-000000000047';
const BETA = '00000038-0043-4000-8000-000000000060';

describe('spoken-turn hint on delivery', () => {
  let dir: string;
  let file: string;
  let app: FastifyInstance;
  let ctx: MockRouteContext;
  let service: ChatroomService;
  let roomId: string;
  const carried = new Map<string, string[]>();
  let owner: string;
  let clock: number;

  beforeEach(async () => {
    clock = 1_000_000;
    dir = await mkdtemp(join(tmpdir(), 'spoken-hint-'));
    file = join(dir, 'chatrooms.json');
    const store = new OwnerAuthStore(join(dir, 'owner-auth.json'));
    const oneTime = (await admin.bootstrap(store, USER)).oneTimePassword;
    await admin.setPolicy(store, 'off'); // Legacy policy mode still verifies actual owner cookies.
    const auth = new OwnerAuthService({ store, auditFile: join(dir, 'owner-auth-audit.jsonl') });
    const harness = await createRouteTestHarness((fastify, c) => {
      const deps = { service: auth, ctx: c as unknown as SessionPort };
      registerOwnerPolicy(fastify, {
        ...deps,
        isCapabilityRequest: () => false,
        relations: { known: () => true, related: (a, b) => a === b, upward: () => false, keeper: () => false } as never,
      });
      registerOwnerRoutes(fastify, auth, false);
      service = new ChatroomService({
        file,
        getSession: (id) => c.sessions.get(id),
        broadcast: () => {},
        now: () => clock,
      });
      registerChatroomRoutes(fastify, c, service, new ChatFileStore(join(dir, 'files')), ownerVerifier(deps));
    });
    app = harness.app;
    ctx = harness.ctx;
    for (const [id, name] of [
      [ALPHA, 'alpha'],
      [BETA, 'beta'],
    ] as const) {
      const s = createMockSession(id);
      s.name = name;
      carried.set(id, recordCarried(s as never, () => service));
      ctx.sessions.set(id, s as never);
    }
    roomId = service.createRoom('r1', undefined).id;
    service.addMember(roomId, ALPHA, { voice: true });
    service.addMember(roomId, BETA);

    // A one-time password session is restricted; changing the password gives a full owner session.
    const first = await app.inject({
      method: 'POST',
      url: '/api/owner/login',
      payload: { username: USER, password: oneTime },
    });
    const limited = first.cookies.find((c) => c.name === OWNER_COOKIE)!.value;
    const changed = await app.inject({
      method: 'POST',
      url: '/api/owner/password',
      payload: { current: oneTime, next: 'synthetic-correct-horse-42' },
      cookies: { [OWNER_COOKIE]: limited },
    });
    expect(changed.statusCode).toBe(200);
    owner = changed.cookies.find((c) => c.name === OWNER_COOKIE)!.value;
  });

  afterEach(async () => {
    await service.stop();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  const requestPost = (text: string, opts: { cookie?: string; agent?: string; spoken?: boolean } = {}) =>
    app.inject({
      method: 'POST',
      url: `/api/chatrooms/${roomId}/messages`,
      payload: { text, ...(opts.spoken ? { spoken: true } : {}) },
      ...(opts.cookie !== undefined ? { cookies: { [OWNER_COOKIE]: opts.cookie } } : {}),
      ...(opts.agent ? { headers: { 'x-reverie-parent-session': opts.agent } } : {}),
    });
  const post = async (text: string, opts: { cookie?: string; agent?: string; spoken?: boolean } = {}) => {
    const res = await requestPost(text, opts);
    expect(res.statusCode, res.body).toBe(200);
    return res.json().data.message as ChatMessage;
  };
  /** Everything a member's hook carried so far, after delivery has run; its pane only ever gets the wake line. */
  const pane = async (id: string) => {
    clock += 10_000;
    await service.delivery.flushAll();
    return (carried.get(id) ?? []).join('\n');
  };

  it('delivers the hint after a verified owner spoken turn', async () => {
    const m = await post('how is the deploy', { cookie: owner, spoken: true });
    expect(m.from).toEqual({ kind: 'user', name: 'user', mark: 'owner_spoken' });
    const written = await pane(ALPHA);
    expect(written).toContain(`user: how is the deploy ${SPOKEN_TURN_HINT}`);
  });

  it('rejects an unsigned spoken claim without storing or delivering it', async () => {
    const before = service.room(roomId)!.messages.length;
    const response = await requestPost('ordinary API post', { spoken: true });
    expect(response.statusCode).toBe(403);
    expect(service.room(roomId)!.messages).toHaveLength(before);
    const written = await pane(ALPHA);
    expect(written).not.toContain('ordinary API post');
    expect(written).not.toContain('spoken in car mode');
  });

  it('rejects a bad cookie spoken claim without storing or delivering it', async () => {
    const before = service.room(roomId)!.messages.length;
    const response = await requestPost('forged cookie', { cookie: 'not-a-real-session-token', spoken: true });
    expect(response.statusCode).toBe(403);
    expect(service.room(roomId)!.messages).toHaveLength(before);
    expect(await pane(ALPHA)).not.toContain('forged cookie');
    expect(await pane(ALPHA)).not.toContain('spoken in car mode');
  });

  it('gives no hint to an agent claiming spoken, even with a valid owner cookie', async () => {
    const m = await post('@alpha agent post', { agent: BETA, cookie: owner, spoken: true });
    expect(m.from.kind).toBe('agent');
    expect(m.spoken).toBeUndefined();
    const written = await pane(ALPHA);
    expect(written).toContain('beta: @alpha agent post');
    expect(written).not.toContain('spoken in car mode');
  });

  it('gives no hint to a typed verified owner post', async () => {
    const m = await post('@alpha typed', { cookie: owner });
    expect((m.from as { mark?: string }).mark).toBe('owner_typed');
    expect(await pane(ALPHA)).not.toContain('spoken in car mode');
  });

  it('preserves the owner hint after reload without elevating legacy unverified spoken metadata', async () => {
    const signed = await post('signed turn', { cookie: owner, spoken: true });
    // Model persisted history from older writers, not a request accepted by
    // today's authenticated posting route. The stored spoken flag is DATA.
    const unsigned = service.post(roomId, { kind: 'user', name: 'user' }, 'legacy unsigned turn', 'all', {
      spoken: true,
      deliver: false,
    });
    await service.stop();
    const reloaded = (await loadChatrooms(file)).find((r) => r.id === roomId)!;
    const byId = (id: string) => reloaded.messages.find((m) => m.id === id)!;
    expect((byId(signed.id).from as { mark?: string }).mark).toBe('owner_spoken');
    // The voice context, then the id its answer must name (voice-turn-routes.ts reads only a linked answer).
    expect(
      renderForRecipient(reloaded, byId(signed.id), ALPHA, () => 'alpha').endsWith(
        ` ${SPOKEN_TURN_HINT} ${answerLinkHint(signed.id)}`
      )
    ).toBe(true);
    expect(byId(unsigned.id).spoken).toBe(true);
    expect((byId(unsigned.id).from as { mark?: string }).mark).toBeUndefined();
    expect(renderForRecipient(reloaded, byId(unsigned.id), ALPHA, () => 'alpha')).not.toContain('spoken in car mode');
  });
});
