/**
 * Who may read and choose an employee's model: the owner, an employee holding the owner-set
 * manageModels grant (for a colleague or itself), and an employee reading its own model. A title,
 * a service token or an ungranted employee is refused before anything is recorded or typed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { trustedFixtureOwner } from '../helpers/trusted-owner-fixture.js';
import { registerAuthMiddleware } from '../../src/web/middleware/auth.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { CompanyService } from '../../src/company-service.js';
import { CompanyStore } from '../../src/company-store.js';
import { ChatroomStore } from '../../src/chatroom-store.js';
import type { CompanyEmployee } from '../../src/company-types.js';
import type { SessionPort } from '../../src/web/ports/session-port.js';
import type { EmployeeModelStatus, ModelEmployee } from '../../src/employee-model-service.js';
import { registerEmployeeModelRoutes } from '../../src/web/routes/employee-model-routes.js';

describe('employee model routes', () => {
  let app: FastifyInstance;
  let directory: string;
  let service: CompanyService;
  let manager: CompanyEmployee;
  let worker: CompanyEmployee;
  const choose = vi.fn(
    async (employee: ModelEmployee, choice: { model: string }, by: string): Promise<EmployeeModelStatus> => ({
      employeeId: employee.id,
      name: employee.name,
      supported: true,
      target: choice.model,
      state: 'pending',
      reason: by,
    })
  );
  const status = vi.fn(
    (employee: ModelEmployee): EmployeeModelStatus => ({
      employeeId: employee.id,
      name: employee.name,
      supported: true,
      state: 'none',
    })
  );
  const audit = vi.fn(async () => {});
  const sessions = new Map([
    ['manager-session', { id: 'manager-session', name: 'Manager' }],
    ['worker-session', { id: 'worker-session', name: 'Worker' }],
  ]);
  const hire = (name: string, sessionId: string, position: string) =>
    service.hire({ name, icon: '🌱', position, expertise: ['testing'], sessionId, researchEnabled: false });

  beforeEach(async () => {
    choose.mockClear();
    status.mockClear();
    audit.mockClear();
    directory = await mkdtemp(join(tmpdir(), 'reverie-model-routes-'));
    const store = new CompanyStore(join(directory, 'company.json'));
    await store.init();
    const rooms = new ChatroomStore();
    service = new CompanyService(store, {
      getSession: (id) => sessions.get(id) as never,
      chatrooms: {
        rooms: () => rooms.list(),
        room: (id) => rooms.get(id),
        addMember: (id, sessionId, options) => rooms.addMember(id, sessionId, options).member,
        removeMember: (id, sessionId) => rooms.removeMember(id, sessionId),
      },
      research: { start: vi.fn(), inspect: vi.fn(), stop: vi.fn() },
    });
    // A title that sounds like authority, and no grant.
    manager = await hire('Burt', 'manager-session', 'Chief Technology Officer');
    worker = await hire('Stan', 'worker-session', 'Engineer');
    app = Fastify();
    registerAuthMiddleware(app, false);
    registerEmployeeModelRoutes(app, {
      ctx: { sessions } as unknown as SessionPort,
      company: service,
      models: { choose, status },
      verifiedOwner: trustedFixtureOwner,
      audit,
    });
    installRouteErrorHandler(app);
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });

  const put = (id: string, headers: Record<string, string> = {}, payload: unknown = { model: 'claude-opus-5-5' }) =>
    app.inject({ method: 'PUT', url: `/api/company/employees/${id}/model`, headers, payload: payload as object });
  const get = (id: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: `/api/company/employees/${id}/model`, headers });
  const as = (sessionId: string) => ({ 'x-reverie-parent-session': sessionId });
  const grant = (manageModels: boolean) =>
    service.update(manager.id, undefined, { permissions: { manageModels } }, () => {});

  it('lets the owner choose any employee’s model', async () => {
    const response = await put(worker.id, {}, { model: 'claude-opus-5-5', effort: 'high' });
    expect(response.statusCode).toBe(200);
    expect(choose).toHaveBeenCalledWith(
      expect.objectContaining({ id: worker.id }),
      { model: 'claude-opus-5-5', effort: 'high' },
      'owner'
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ admin: 'owner', action: 'employee_model', target: 'Stan' })
    );
  });

  it('refuses an ungranted employee, whatever its title, before anything is recorded', async () => {
    for (const target of [worker.id, manager.id]) {
      const response = await put(target, as('manager-session'));
      expect(response.statusCode).toBe(403);
      expect(response.json().error).toBe('Employee model permission is required');
    }
    expect((await get(worker.id, as('manager-session'))).statusCode).toBe(403);
    expect(choose).not.toHaveBeenCalled();
  });

  it('lets a granted employee choose a colleague’s model and its own, and loses that with the grant', async () => {
    await grant(true);
    const colleague = await put(worker.id, as('manager-session'));
    expect(colleague.statusCode).toBe(200);
    expect(choose).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: worker.id }),
      { model: 'claude-opus-5-5' },
      'employee Burt'
    );
    expect((await put(manager.id, as('manager-session'))).statusCode).toBe(200);
    expect((await get(worker.id, as('manager-session'))).statusCode).toBe(200);
    await grant(false);
    expect((await put(worker.id, as('manager-session'))).statusCode).toBe(403);
    expect(choose).toHaveBeenCalledTimes(2);
  });

  it('lets an employee read its own model without a grant, but not choose it', async () => {
    expect((await get(worker.id, as('worker-session'))).statusCode).toBe(200);
    expect((await put(worker.id, as('worker-session'))).statusCode).toBe(403);
    expect(choose).not.toHaveBeenCalled();
  });

  it('refuses a service token, an unknown employee and a model id that is not one', async () => {
    expect((await put(worker.id, { 'x-reverie-service-token': 'service' })).statusCode).toBe(403);
    expect((await put('missing')).statusCode).toBe(404);
    for (const model of ['-opus', 'opus 5', 'claude-opus-5-5\r/clear', 'x'.repeat(101)])
      expect((await put(worker.id, {}, { model })).statusCode, model).toBe(400);
    expect((await put(worker.id, {}, { model: 'opus', effort: 'ultracode' })).statusCode).toBe(400);
    expect((await put(worker.id, {}, { model: 'opus', extra: true })).statusCode).toBe(400);
    expect(choose).not.toHaveBeenCalled();
  });
});
