import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { appendAdminAudit } from '../../src/web/admin-audit.js';

vi.mock('../../src/web/admin-audit.js', () => ({ appendAdminAudit: vi.fn(async () => {}) }));
import Fastify, { type FastifyInstance } from 'fastify';
import { registerCompanyRoutes } from '../../src/web/routes/company-routes.js';
import { CompanyService } from '../../src/company-service.js';
import { CompanyStore } from '../../src/company-store.js';
import { ChatroomStore } from '../../src/chatroom-store.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SessionPort } from '../../src/web/ports/session-port.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';

describe('company HTTP ownership and expert invites', () => {
  let app: FastifyInstance;
  let directory: string;
  let service: CompanyService;
  let rooms: ChatroomStore;
  const hireBody = {
    name: 'Maya',
    icon: '🌱',
    position: 'Scientist',
    expertise: ['biology'],
    sessionId: 'expert-session',
    researchEnabled: true,
  };

  beforeEach(async () => {
    vi.mocked(appendAdminAudit).mockClear();
    directory = await mkdtemp(join(tmpdir(), 'fleet-company-routes-'));
    const store = new CompanyStore(join(directory, 'company.json'));
    await store.init();
    rooms = new ChatroomStore();
    const sessions = new Map([
      ['expert-session', { id: 'expert-session', name: 'Expert' }],
      ['parent-session', { id: 'parent-session', name: 'Parent' }],
    ]);
    service = new CompanyService(store, {
      getSession: (id) => sessions.get(id),
      chatrooms: {
        rooms: () => rooms.list(),
        room: (id) => rooms.get(id),
        addMember: (id, sessionId, options) => rooms.addMember(id, sessionId, options).member,
      },
      research: { start: vi.fn(), inspect: vi.fn(), stop: vi.fn() },
    });
    app = Fastify();
    registerCompanyRoutes(app, { sessions } as unknown as SessionPort, service);
    installRouteErrorHandler(app);
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('allows owner hiring, discovery and assignment while blocking agent configuration', async () => {
    const denied = await app.inject({
      method: 'POST',
      url: '/api/company/employees',
      payload: hireBody,
      headers: { 'x-codeman-parent-session': 'parent-session' },
    });
    expect(denied.statusCode).toBe(403);
    const stale = await app.inject({
      method: 'POST',
      url: '/api/company/employees',
      payload: hireBody,
      headers: { 'x-codeman-parent-session': 'stale-session' },
    });
    expect(stale.statusCode).toBe(403);
    const created = await app.inject({ method: 'POST', url: '/api/company/employees', payload: hireBody });
    expect(created.statusCode).toBe(200);
    const id = created.json().data.employee.id;
    const discover = await app.inject('/api/company');
    expect(discover.json().data.employees[0].id).toBe(id);
    expect(discover.json().data.canManage).toBe(true);
    const configured = await app.inject({
      method: 'PUT',
      url: '/api/company/settings',
      payload: { enabled: true, timeZone: 'UTC', ctoId: id },
    });
    expect(configured.statusCode).toBe(200);
    expect(service.view().settings.ctoId).toBe(id);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/company/settings',
          payload: { enabled: true },
          headers: { 'x-codeman-parent-session': 'parent-session' },
        })
      ).statusCode
    ).toBe(403);
  });

  it('lets only the owner edit an employee position, expertise and icon', async () => {
    const employee = await service.hire(hireBody);
    const url = `/api/company/employees/${employee.id}`;
    const change = { position: 'Console expert', expertise: ['console', 'tests'], icon: '🧩' };
    for (const header of ['parent-session', 'stale-session', '']) {
      const res = await app.inject({ method: 'PUT', url, payload: change, headers: { 'x-codeman-parent-session': header } });
      expect(res.statusCode).toBe(403);
    }
    expect(service.view().employees[0]).toMatchObject({ position: 'Scientist', icon: '🌱' });
    expect(appendAdminAudit).not.toHaveBeenCalled();

    const ok = await app.inject({ method: 'PUT', url, payload: { position: 'Console expert' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.employee).toMatchObject({ position: 'Console expert', icon: '🌱', expertise: ['biology'] });
    expect(appendAdminAudit).toHaveBeenCalledTimes(1);
    expect(appendAdminAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'employee_update', target: 'Maya', detail: expect.objectContaining({ position: { from: 'Scientist', to: 'Console expert' } }) })
    );
    const all = await app.inject({ method: 'PUT', url, payload: change });
    expect(all.json().data.employee).toMatchObject({ ...change, name: 'Maya', sessionId: 'expert-session' });
  });

  it('refuses an unknown employee, unknown or empty fields, and invalid values on the employee edit', async () => {
    const employee = await service.hire(hireBody);
    const put = (id: string, payload: unknown) => app.inject({ method: 'PUT', url: `/api/company/employees/${id}`, payload: payload as object });
    expect((await put('nobody', { position: 'X' })).statusCode).toBe(404);
    for (const bad of [{}, { sessionId: 'parent-session' }, { position: 'X', sessionId: 'parent-session' }, { position: 'X', name: 'Other' }, { owner: 'x' }, { position: '' }, { expertise: [] }, { icon: 'not an icon at all' }]) {
      expect((await put(employee.id, bad)).statusCode).toBe(400);
    }
    expect(service.view().employees[0]).toMatchObject({ name: 'Maya', position: 'Scientist', sessionId: 'expert-session' });
  });

  it('lets authorized agent members invite real registered experts, never unknown substitutes', async () => {
    const employee = await service.hire(hireBody);
    const room = rooms.create('Science', undefined);
    const invite = () =>
      app.inject({
        method: 'POST',
        url: `/api/company/employees/${employee.id}/invite`,
        payload: { roomId: room.id },
        headers: { 'x-codeman-parent-session': 'parent-session' },
      });
    expect((await invite()).statusCode).toBe(403);
    rooms.addMember(room.id, 'parent-session');
    expect((await invite()).statusCode).toBe(200);
    expect(room.members.some((m) => m.sessionId === 'expert-session')).toBe(true);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/company/employees/fake-expert/invite',
          payload: { roomId: room.id },
        })
      ).statusCode
    ).toBe(404);
  });

  it('validates timezones, CTO registry and evidence-free company notes', async () => {
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/company/settings',
          payload: { enabled: true, timeZone: 'Imaginary/Zone' },
        })
      ).statusCode
    ).toBe(400);
    expect(
      (await app.inject({ method: 'PUT', url: '/api/company/settings', payload: { ctoId: 'unregistered' } })).statusCode
    ).toBe(400);
    const employee = await service.hire(hireBody);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/company/employees/${employee.id}/memories`,
          payload: { text: 'I dreamed a theorem', kind: 'imagination' },
        })
      ).statusCode
    ).toBe(200);
    expect(service.view().memories[0].kind).toBe('imagination');
  });
});
