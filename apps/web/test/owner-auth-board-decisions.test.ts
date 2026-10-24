/**
 * @fileoverview Exact board decision access through real owner middleware and board handlers.
 * Synthetic sessions, owner account, service token and board only; app.inject never binds a port.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { bootstrap, issueServiceToken, setPolicy } from '../src/owner-auth/admin.js';
import { classify, OWNER_COOKIE, registerOwnerPolicy, SERVICE_HEADER } from '../src/owner-auth/policy.js';
import { ownerVerifier } from '../src/owner-auth/marks.js';
import { registerOwnerRoutes } from '../src/owner-auth/routes.js';
import { registerBoardRoutes } from '../src/web/routes/board-routes.js';
import { BoardStore } from '../src/board-store.js';
import type { ChatRoom } from '../src/chatroom-store.js';
import type { SessionPort } from '../src/web/ports/session-port.js';

const COORD = '0000002d-0035-4000-8000-000000000047';
const ORDINARY = '00000038-0043-4000-8000-000000000060';
const FORGED = '0000003e-004c-4000-8000-00000000006f';
const PASSWORD = 'synthetic-Quasar!8-lantern';

describe('owner middleware: exact board decision add and clear', () => {
  let dir: string;
  let app: FastifyInstance;
  let board: BoardStore;
  let rooms: ChatRoom[];
  let serviceToken: string;
  let ownerToken: string;
  let audit: Record<string, unknown>[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'board-decision-access-'));
    const store = new OwnerAuthStore(join(dir, 'owner-auth.json'));
    const { oneTimePassword } = await bootstrap(store, 'synthetic-owner');
    await setPolicy(store, 'enforce', { forceLockoutRisk: true });
    serviceToken = await issueServiceToken(store, 'synthetic-board-service');
    const service = new OwnerAuthService({ store, auditFile: join(dir, 'owner-auth-audit.jsonl') });
    const sessions = new Map([COORD, ORDINARY, FORGED].map((id) => [id, { id, owner: undefined }]));
    rooms = [
      {
        id: 'synthetic-room',
        name: 'synthetic-boardroom',
        createdAt: 0,
        messages: [],
        members: [
          { sessionId: COORD, role: 'coordinator', goal: '' },
          { sessionId: ORDINARY, role: 'member', goal: '' },
          { sessionId: FORGED, role: 'coordinator', goal: '', addedBy: ORDINARY },
        ],
      },
    ] as unknown as ChatRoom[];
    board = new BoardStore(join(dir, 'board.json'));
    await board.init();
    audit = [];
    app = Fastify();
    await app.register(fastifyCookie);
    registerOwnerPolicy(app, {
      service,
      ctx: { sessions } as unknown as SessionPort,
      isCapabilityRequest: () => false,
      relations: {
        known: (id) => sessions.has(id),
        related: (a, b) => a === b,
        upward: () => false,
        keeper: () => false,
        admin: () => false,
      },
    });
    registerOwnerRoutes(app, service, false);
    registerBoardRoutes(app, { sessions } as unknown as SessionPort, {
      verifiedOwner: ownerVerifier({ service, ctx: { sessions } as unknown as SessionPort }),
      store: board,
      rooms: () => rooms,
      company: () => ({
        settings: { ownerName: 'Synthetic Owner', timeZone: 'UTC' },
        employees: [
          { id: 'e-coord', name: 'Coordinator', sessionId: COORD },
          { id: 'e-ordinary', name: 'Ordinary CTO', position: 'CTO', sessionId: ORDINARY },
          { id: 'e-forged', name: 'Forged coordinator', sessionId: FORGED },
        ],
      }),
      audit: async (entry) => {
        audit.push(entry);
      },
    });
    await app.ready();
    const first = await app.inject({
      method: 'POST',
      url: '/api/owner/login',
      payload: { username: 'synthetic-owner', password: oneTimePassword },
    });
    const changed = await app.inject({
      method: 'POST',
      url: '/api/owner/password',
      headers: { origin: 'http://localhost' },
      cookies: { [OWNER_COOKIE]: first.cookies.find((c) => c.name === OWNER_COOKIE)!.value },
      payload: { current: oneTimePassword, next: PASSWORD },
    });
    expect(changed.statusCode).toBe(200);
    ownerToken = changed.cookies.find((c) => c.name === OWNER_COOKIE)!.value;
  });

  afterEach(async () => {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  });

  const asAgent = (session: string) => ({ 'x-reverie-parent-session': session });
  const post = (url: string, headers: Record<string, string>, payload: object = {}) =>
    app.inject({ method: 'POST', url, headers, payload });

  it('opens precisely add and clear, leaving annotation, blockers, import and execution owner-only', () => {
    for (const route of ['/api/board/decisions', '/api/board/decisions/:id/clear'])
      expect(classify('POST', route, route)).toBe('agent');
    for (const [method, route] of [
      ['PATCH', '/api/board/decisions/:id'],
      ['DELETE', '/api/board/decisions/:id'],
      ['POST', '/api/board/decisions/:id/execute'],
      ['POST', '/api/board/decisions/:id/delegate'],
      ['POST', '/api/board/blockers'],
      ['POST', '/api/board/import'],
    ])
      expect(classify(method, route, route)).toBe('owner');
  });

  it('an exact owner-appointed coordinator reads, adds and clears a decision with attributed audit', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/board', headers: asAgent(COORD) })).statusCode).toBe(200);
    const added = await post('/api/board/decisions', asAgent(COORD), {
      id: 'd-coord',
      text: 'Synthetic owner question',
    });
    expect(added.statusCode).toBe(200);
    expect((await post('/api/board/decisions/d-coord/clear', asAgent(COORD))).statusCode).toBe(200);
    expect(board.snapshot().decisions[0]).toMatchObject({ id: 'd-coord', clearedBy: 'e-coord' });
    expect(audit).toEqual([
      expect.objectContaining({ action: 'board-decision-add', by: 'e-coord', session: COORD }),
      expect.objectContaining({ action: 'board-decision-clear', by: 'e-coord', session: COORD }),
    ]);
  });

  it('ordinary agents, agent-made coordinator seats and session prefixes cannot add or clear', async () => {
    expect(
      (await post('/api/board/decisions', asAgent(COORD), { id: 'd-held', text: 'Synthetic held question' })).statusCode
    ).toBe(200);
    for (const id of [ORDINARY, FORGED, COORD.slice(0, 8)]) {
      expect((await post('/api/board/decisions', asAgent(id), { text: 'Refused synthetic question' })).statusCode).toBe(
        403
      );
      expect((await post('/api/board/decisions/d-held/clear', asAgent(id))).statusCode).toBe(403);
    }
    expect(board.snapshot().decisions).toHaveLength(1);
    expect(board.snapshot().decisions[0].clearedAt).toBeUndefined();
    expect(audit).toHaveLength(1);
  });

  it('a coordinator seat in an archived room grants no write authority', async () => {
    rooms[0].archivedAt = Date.now();
    expect((await post('/api/board/decisions', asAgent(COORD), { text: 'Refused archived seat' })).statusCode).toBe(
      403
    );
    expect((await post('/api/board/decisions/d-any/clear', asAgent(COORD))).statusCode).toBe(403);
    expect(audit).toEqual([]);
  });

  it('an authenticated service cannot become a headerless owner or borrow a coordinator header', async () => {
    expect(
      (await post('/api/board/decisions', asAgent(COORD), { id: 'd-held', text: 'Synthetic held question' })).statusCode
    ).toBe(200);
    for (const headers of [{ [SERVICE_HEADER]: serviceToken }, { [SERVICE_HEADER]: serviceToken, ...asAgent(COORD) }]) {
      expect((await post('/api/board/decisions', headers, { text: 'Refused service question' })).statusCode).toBe(403);
      expect((await post('/api/board/decisions/d-held/clear', headers)).statusCode).toBe(403);
    }
    expect(board.snapshot().decisions).toHaveLength(1);
    expect(board.snapshot().decisions[0].clearedAt).toBeUndefined();
    expect(audit).toHaveLength(1);
  });

  it('an authenticated owner can add and clear, including owner precedence over a service header', async () => {
    const request = {
      cookies: { [OWNER_COOKIE]: ownerToken },
      headers: { origin: 'http://localhost', [SERVICE_HEADER]: serviceToken },
    };
    expect(
      (
        await app.inject({
          ...request,
          method: 'POST',
          url: '/api/board/decisions',
          payload: { id: 'd-owner', text: 'Synthetic owner decision' },
        })
      ).statusCode
    ).toBe(200);
    expect(
      (await app.inject({ ...request, method: 'POST', url: '/api/board/decisions/d-owner/clear', payload: {} }))
        .statusCode
    ).toBe(200);
    expect(board.snapshot().decisions[0]).toMatchObject({ id: 'd-owner', clearedBy: 'owner' });
    expect(audit.every((entry) => entry.by === 'owner')).toBe(true);
  });

  it('anonymous callers still require owner authentication', async () => {
    expect((await post('/api/board/decisions', {}, { text: 'Anonymous question' })).statusCode).toBe(401);
    expect((await post('/api/board/decisions/d-any/clear', {})).statusCode).toBe(401);
    expect(audit).toEqual([]);
  });
});
