/** Bug 19: a verified-owner replacement spawn (employeeId) records running intent on the NEW session through the
 * guarded owner transaction; agent callers, vacations and failed launches do not. Real routes, mock mux. */
import { trustedFixtureOwner } from '../helpers/trusted-owner-fixture.js';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMockRouteContext, type MockRouteContext } from '../mocks/index.js';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { CompanyService } from '../../src/company-service.js';
import { CompanyStore } from '../../src/company-store.js';
import { ChatroomStore } from '../../src/chatroom-store.js';

vi.mock('../../src/utils/cli-resolver.js', async (original) => ({
  ...(await original<typeof import('../../src/utils/cli-resolver.js')>()),
  isCliAvailable: () => true,
  resolveCliBinDir: () => '/usr/bin',
  missingCliMessage: () => null,
}));

describe('bug 19: owner replacement spawns record running intent on the new session', () => {
  let directory: string;
  let app: FastifyInstance;
  let ctx: MockRouteContext;
  let company: CompanyService;
  let store: CompanyStore;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'reverie-replacement-intent-'));
    store = new CompanyStore(join(directory, 'company.json'));
    await store.init();
    ctx = createMockRouteContext();
    const rooms = new ChatroomStore();
    company = new CompanyService(store, {
      getSession: (id) => ctx.sessions.get(id),
      chatrooms: {
        rooms: () => rooms.list(),
        room: (id) => rooms.get(id),
        addMember: (id, sessionId, options) => rooms.addMember(id, sessionId, options).member,
      },
      research: { start: vi.fn(), inspect: vi.fn(), stop: vi.fn() },
    });
    app = Fastify();
    await app.register(fastifyCookie);
    registerSessionRoutes(app, ctx, { company, verifiedOwner: trustedFixtureOwner });
    installRouteErrorHandler(app);
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const owner = (extra = {}) =>
    app.inject({ method: 'POST', url: '/api/sessions', payload: { workingDir: directory, mode: 'claude', ...extra } });
  const agent = (parent: string, extra = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { 'x-reverie-parent-session': parent },
      payload: { workingDir: directory, mode: 'claude', ...extra },
    });
  const hireStopped = async () => {
    const ada = await company.hire({
      name: 'Ada',
      icon: '🔭',
      position: 'Scientist',
      expertise: ['x'],
      sessionId: 'test-session-1',
      researchEnabled: false,
    } as never);
    await company.setDesiredRunning('test-session-1', false); // the owner's Stop
    return ada;
  };
  const employee = () => company.view().employees[0]!;

  it('owner Stop, then an owner replacement: bound to the new session with running intent', async () => {
    const ada = await hireStopped();
    const replaced = await owner({ employeeId: ada.id });
    expect(replaced.statusCode, replaced.body).toBe(200);
    const created = replaced.json().session.id;
    expect(employee().sessionId).toBe(created);
    expect(employee().desiredRunning).toBe(true);
    // The transaction is closed: a later owner restart of the new session is not blocked as "already restarting".
    expect(() => company.prepareRuntimeRestart(created, undefined)?.finish()).not.toThrow();
  });

  it("the employee's own session replacing itself records nothing (agent caller)", async () => {
    const ada = await hireStopped();
    const replaced = await agent('test-session-1', { employeeId: ada.id });
    expect(replaced.statusCode, replaced.body).toBe(200);
    expect(employee().sessionId).toBe(replaced.json().session.id);
    expect(employee().desiredRunning).toBe(false);
  });

  it('a non-owner request records nothing', async () => {
    const ada = await hireStopped();
    await app.close();
    app = Fastify();
    await app.register(fastifyCookie);
    registerSessionRoutes(app, ctx, { company, verifiedOwner: () => false });
    installRouteErrorHandler(app);
    await app.ready();
    const replaced = await owner({ employeeId: ada.id });
    expect(replaced.statusCode, replaced.body).toBe(200);
    expect(employee().desiredRunning).toBe(false);
  });

  it('a vacationing employee keeps its stop', async () => {
    const ada = await hireStopped();
    await store.update((state) => {
      state.employees[0]!.onVacation = true;
    });
    const replaced = await owner({ employeeId: ada.id });
    expect(replaced.statusCode, replaced.body).toBe(200);
    expect(employee().desiredRunning).toBe(false);
  });

  it('a failed replacement launch rolls the claim back and leaves no open transaction', async () => {
    const ada = await hireStopped();
    ctx.addSession.mockRejectedValueOnce(new Error('synthetic launch failure'));
    const failed = await owner({ employeeId: ada.id });
    expect(failed.statusCode).toBeGreaterThanOrEqual(400);
    expect(employee().sessionId).toBe('test-session-1');
    expect(employee().desiredRunning).toBe(false);
    expect(() => company.prepareRuntimeRestart('test-session-1', undefined)?.finish()).not.toThrow();
  });

  it('a replacement of a running employee keeps it running (the thread claim stop is not the owner Stop)', async () => {
    const ada = await company.hire({
      name: 'Ada',
      icon: '🔭',
      position: 'Scientist',
      expertise: ['x'],
      sessionId: 'test-session-1',
      researchEnabled: false,
    } as never);
    await company.setDesiredRunning('test-session-1', true);
    const replaced = await owner({ employeeId: ada.id });
    expect(replaced.statusCode, replaced.body).toBe(200);
    expect(employee().desiredRunning).toBe(true);
  });
});
