import { trustedFixtureOwner } from '../helpers/trusted-owner-fixture.js';
/**
 * @fileoverview Org chart clean-up: the temporary-worker profiles of sessions that are gone (they piled up as agents were recreated)
 * can be removed, owner only. A running agent's record is never touched, and another owner's records are left alone.
 * Port: N/A (app.inject()).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerCompanyRoutes } from '../../src/web/routes/company-routes.js';
import { CompanyService } from '../../src/company-service.js';
import { CompanyStore } from '../../src/company-store.js';
import { ChatroomService } from '../../src/chatroom-service.js';
import { AvatarStore } from '../../src/agent-avatars.js';
import { createMockSession } from '../mocks/index.js';
import type { SessionPort } from '../../src/web/ports/session-port.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';

const LIVE = 'live-session';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 3)]);
const PAUSED = 'paused-pinned';
const EMPLOYEE_SESSION = 'employee-old-session';
const AGENT = { 'x-reverie-parent-session': LIVE };

describe('removing the profiles of agents that are gone', () => {
  let app: FastifyInstance;
  let directory: string;
  let service: CompanyService;
  let avatars: AvatarStore;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'reverie-company-prune-'));
    const store = new CompanyStore(join(directory, 'company.json'));
    await store.init();
    const sessions = new Map([[LIVE, createMockSession(LIVE)]]);
    const chatrooms = new ChatroomService({ file: join(directory, 'chatrooms.json'), getSession: () => undefined, broadcast: () => {} });
    await chatrooms.init();
    service = new CompanyService(store, {
      getSession: (id) => sessions.get(id) as never,
      chatrooms,
      keepsRecord: (id) => id === PAUSED,
      research: { start: vi.fn(), inspect: vi.fn(), stop: vi.fn() },
    });
    avatars = new AvatarStore(join(directory, 'agent-avatars'));
    app = Fastify();
    registerCompanyRoutes(app, { sessions } as unknown as SessionPort, service, avatars, undefined, undefined, { verifiedOwner: trustedFixtureOwner });
    installRouteErrorHandler(app);
    await app.ready();
    await store.update((state) => {
      const at = (sessionId: string, owner?: string) => ({ sessionId, owner, name: sessionId, icon: '', createdAt: 1 });
      state.temporaryAgents.push(at(LIVE), at('gone-1'), at('gone-2'), at('theirs', 'someone-else'), at(PAUSED), at(EMPLOYEE_SESSION));
      state.employees.push({ id: 'e1', name: 'Pat', icon: '\u{1F642}', position: 'Analyst', expertise: ['x'], sessionId: EMPLOYEE_SESSION, researchEnabled: true, createdAt: 1 });
    });
    await avatars.put('gone-1', PNG);
    await avatars.put(LIVE, PNG);
  });
  afterEach(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });

  const ids = () => service.store.snapshot().temporaryAgents.map((a) => a.sessionId).sort();

  it('prune removes only the gone sessions of this owner, and their picture files, and reports how many', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/company/temporary/prune', payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ removed: 2 });
    expect(ids()).toEqual([LIVE, 'theirs', PAUSED, EMPLOYEE_SESSION].sort());
    expect((await readdir(join(directory, 'agent-avatars'))).sort()).toEqual([`${LIVE}.png`]);
    // nothing left to do the second time
    expect((await app.inject({ method: 'POST', url: '/api/company/temporary/prune', payload: {} })).json().data).toEqual({ removed: 0 });
  });

  it('is owner only: a request naming an agent session is refused and removes nothing', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/company/temporary/prune', headers: AGENT, payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: '/api/company/temporary/gone-1', headers: AGENT })).statusCode).toBe(403);
    expect(ids()).toEqual([LIVE, 'gone-1', 'gone-2', 'theirs', PAUSED, EMPLOYEE_SESSION].sort());
  });

  it('removing one: unknown is 404, a running agent is refused (409), a gone one goes with its picture', async () => {
    expect((await app.inject({ method: 'DELETE', url: '/api/company/temporary/nope' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/company/temporary/${LIVE}` })).statusCode).toBe(409);
    expect((await app.inject({ method: 'DELETE', url: '/api/company/temporary/theirs' })).statusCode).toBe(404);
    const res = await app.inject({ method: 'DELETE', url: '/api/company/temporary/gone-1' });
    expect(res.statusCode).toBe(200);
    expect(ids()).toEqual([LIVE, 'gone-2', 'theirs', PAUSED, EMPLOYEE_SESSION].sort());
    expect(await readdir(join(directory, 'agent-avatars'))).toEqual([`${LIVE}.png`]);
  });

  it('keeps a pinned agent that is only stopped, and a session that is also an employee\u2019s: neither is pruned or removed one by one', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/company/temporary/prune', payload: {} })).json().data).toEqual({ removed: 2 });
    expect(ids()).toContain(PAUSED);
    expect(ids()).toContain(EMPLOYEE_SESSION);
    const one = await app.inject({ method: 'DELETE', url: `/api/company/temporary/${PAUSED}` });
    expect(one.statusCode).toBe(409);
    expect(one.json().error).toContain('pinned');
    expect(ids()).toContain(PAUSED);
  });

  it('shows which records are kept, so the page can tell a paused agent from a gone one', async () => {
    const view = (await app.inject({ method: 'GET', url: '/api/company' })).json().data.temporaryAgents as Array<{ sessionId: string; kept?: boolean }>;
    expect(view.find((a) => a.sessionId === PAUSED)?.kept).toBe(true);
    expect(view.find((a) => a.sessionId === 'gone-1')?.kept).toBeUndefined();
  });
});

