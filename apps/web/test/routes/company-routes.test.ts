import { trustedFixtureOwner } from '../helpers/trusted-owner-fixture.js';
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
  const wake = vi.fn(async () => ({ awakened: [], skipped: [] }));
  let app: FastifyInstance;
  let directory: string;
  let service: CompanyService;
  let rooms: ChatroomStore;
  let sessions: Map<string, { id: string; name: string }>;
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
    wake.mockClear();
    directory = await mkdtemp(join(tmpdir(), 'reverie-company-routes-'));
    const store = new CompanyStore(join(directory, 'company.json'));
    await store.init();
    rooms = new ChatroomStore();
    sessions = new Map([
      ['expert-session', { id: 'expert-session', name: 'Expert' }],
      ['parent-session', { id: 'parent-session', name: 'Parent' }],
    ]);
    service = new CompanyService(store, {
      getSession: (id) => sessions.get(id),
      chatrooms: {
        rooms: () => rooms.list(),
        room: (id) => rooms.get(id),
        addMember: (id, sessionId, options) => rooms.addMember(id, sessionId, options).member,
        removeMember: (id, sessionId) => rooms.removeMember(id, sessionId),
      },
      research: { start: vi.fn(), inspect: vi.fn(), stop: vi.fn() },
    });
    app = Fastify();
    registerCompanyRoutes(app, { sessions } as unknown as SessionPort, service, undefined, undefined, wake, { verifiedOwner: trustedFixtureOwner });
    installRouteErrorHandler(app);
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('rejects runtime recipes in public hire and update payloads', async () => {
    const runtimeRecipe = { mode: 'opencode', workingDir: '/workspace', configs: { openCodeConfig: { configContent: 'secret' } } };
    const hire = await app.inject({ method: 'POST', url: '/api/company/employees', payload: { ...hireBody, runtimeRecipe } });
    expect(hire.statusCode).toBe(400);
    expect(service.view().employees).toHaveLength(0);
    const employee = await service.hire(hireBody);
    const update = await app.inject({ method: 'PUT', url: '/api/company/employees/' + employee.id, payload: { runtimeRecipe } });
    expect(update.statusCode).toBe(400);
    expect(service.view().employees[0].runtimeRecipe).toBeUndefined();
  });

  it('defaults sleep and dream off and lets only the owner persist preferences, including on vacation', async () => {
    const employee = await service.hire(hireBody);
    expect(employee.sleepEnabled).toBe(false);
    expect(employee.dreamEnabled).toBe(false);
    expect(employee.researchEnabled).toBe(true);
    const url = '/api/company/employees/' + employee.id;
    const payload = { sleepEnabled: true, dreamEnabled: true };
    expect((await app.inject({ method: 'PUT', url, payload, headers: { 'x-reverie-parent-session': 'parent-session' } })).statusCode).toBe(403);
    await service.store.update(state => { state.employees[0].onVacation = true; });
    expect((await app.inject({ method: 'PUT', url, payload })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PUT', url, payload: { icon: 'E' } })).statusCode).toBe(200);
    const reloaded = new CompanyStore(service.store.file); await reloaded.init();
    expect(reloaded.snapshot().employees[0]).toMatchObject({ sleepEnabled: true, dreamEnabled: true, onVacation: true, researchEnabled: true });
  });

  it('requires an explicit recovery grant, never a title, to wake a colleague', async () => {
    const target = await service.hire(hireBody);
    const lead = await service.hire({ ...hireBody, name: 'Lead', sessionId: 'parent-session', position: 'COO' });
    const request = {
      method: 'POST' as const,
      url: '/api/company/employees/' + target.id + '/wake',
      headers: { 'x-reverie-parent-session': 'parent-session' },
    };
    expect((await app.inject(request)).statusCode).toBe(403);
    expect(wake).not.toHaveBeenCalled();
    const selfGrant = await app.inject({
      method: 'PUT',
      url: '/api/company/employees/' + lead.id,
      headers: request.headers,
      payload: { permissions: { recoverEmployees: true } },
    });
    expect(selfGrant.statusCode).toBe(403);
    await service.update(lead.id, undefined, { position: 'Engineer', permissions: { recoverEmployees: true } });
    expect((await app.inject(request)).statusCode).toBe(200);
    expect(wake).toHaveBeenCalledWith(target.id);
    expect((await app.inject({ method: 'POST', url: request.url })).statusCode).toBe(200);
  });

  it('allows owner hiring, discovery and assignment while blocking agent configuration', async () => {
    const denied = await app.inject({
      method: 'POST',
      url: '/api/company/employees',
      payload: hireBody,
      headers: { 'x-reverie-parent-session': 'parent-session' },
    });
    expect(denied.statusCode).toBe(403);
    const stale = await app.inject({
      method: 'POST',
      url: '/api/company/employees',
      payload: hireBody,
      headers: { 'x-reverie-parent-session': 'stale-session' },
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
      payload: { enabled: true, timeZone: 'UTC', coordinatorEmployeeId: id },
    });
    expect(configured.statusCode).toBe(200);
    expect(service.view().settings.coordinatorEmployeeId).toBe(id);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/company/settings',
          payload: { enabled: true },
          headers: { 'x-reverie-parent-session': 'parent-session' },
        })
      ).statusCode
    ).toBe(403);
  });

  it('lets only the owner retire and restore an employee, only once the session is gone, with one audit line each', async () => {
    const id = (await app.inject({ method: 'POST', url: '/api/company/employees', payload: hireBody })).json().data
      .employee.id;
    const lounge = rooms.create('Lounge', undefined);
    rooms.addMember(lounge.id, 'expert-session');
    const agent = { 'x-reverie-parent-session': 'parent-session' };
    expect(
      (await app.inject({ method: 'POST', url: `/api/company/employees/${id}/retire`, headers: agent })).statusCode
    ).toBe(403);
    expect(
      (await app.inject({ method: 'POST', url: `/api/company/employees/${id}/retire?q=1`, headers: agent })).statusCode
    ).toBe(403);
    expect(
      (await app.inject({ method: 'POST', url: `/api/company/employees/${id}/restore`, headers: agent })).statusCode
    ).toBe(403);
    // Odd spellings of the path never reach a handler that acts.
    for (const url of [
      `//api/company/employees/${id}/retire`,
      `/api/company/employees/${id}/%72etire`,
      `/api/company/employees/${id}%2Fretire`,
    ]) {
      expect((await app.inject({ method: 'POST', url, headers: agent })).statusCode).not.toBe(200);
      expect((await app.inject({ method: 'POST', url })).statusCode).not.toBe(200);
    }
    const live = await app.inject({ method: 'POST', url: `/api/company/employees/${id}/retire` });
    expect(live.statusCode).toBe(409);
    expect(live.json().error).toMatch(/still has a session/);
    expect((await app.inject({ method: 'POST', url: '/api/company/employees/nobody/retire' })).statusCode).toBe(404);
    expect(service.view().employees.map((e) => e.id)).toEqual([id]);
    expect(appendAdminAudit).not.toHaveBeenCalled();

    sessions.delete('expert-session');
    const retired = await app.inject({ method: 'POST', url: `/api/company/employees/${id}/retire` });
    expect(retired.statusCode).toBe(200);
    expect(retired.json().data.rooms).toEqual([lounge.id]);
    expect(appendAdminAudit).toHaveBeenCalledTimes(1);
    expect(appendAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        admin: 'owner',
        action: 'employee_retire',
        target: 'Maya',
        detail: { id, sessionId: 'expert-session', rooms: [lounge.id], failed: [] },
      })
    );
    const company = (await app.inject('/api/company')).json().data;
    expect(company.employees).toEqual([]);
    expect(company.retired.map((e: { id: string }) => e.id)).toEqual([id]);
    expect(rooms.get(lounge.id)?.members.map((m) => m.sessionId)).not.toContain('expert-session');

    const restored = await app.inject({ method: 'POST', url: `/api/company/employees/${id}/restore` });
    expect(restored.statusCode).toBe(200);
    expect(appendAdminAudit).toHaveBeenCalledTimes(2);
    expect((await app.inject('/api/company')).json().data.employees.map((e: { id: string }) => e.id)).toEqual([id]);
  });

  it('lets only the owner edit an employee position, expertise and icon', async () => {
    const employee = await service.hire(hireBody);
    const url = `/api/company/employees/${employee.id}`;
    const change = { position: 'Console expert', expertise: ['console', 'tests'], icon: '🧩' };
    for (const header of ['parent-session', 'stale-session', '']) {
      const res = await app.inject({
        method: 'PUT',
        url,
        payload: change,
        headers: { 'x-reverie-parent-session': header },
      });
      expect(res.statusCode).toBe(403);
    }
    expect(service.view().employees[0]).toMatchObject({ position: 'Scientist', icon: '🌱' });
    expect(appendAdminAudit).not.toHaveBeenCalled();

    const ok = await app.inject({ method: 'PUT', url, payload: { position: 'Console expert' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.employee).toMatchObject({ position: 'Console expert', icon: '🌱', expertise: ['biology'] });
    expect(appendAdminAudit).toHaveBeenCalledTimes(1);
    expect(appendAdminAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: 'employee_update',
        target: 'Maya',
        detail: expect.objectContaining({ position: { from: 'Scientist', to: 'Console expert' } }),
      })
    );
    const all = await app.inject({ method: 'PUT', url, payload: change });
    expect(all.json().data.employee).toMatchObject({ ...change, name: 'Maya', sessionId: 'expert-session' });
  });

  it('refuses an unknown employee, unknown or empty fields, and invalid values on the employee edit', async () => {
    const employee = await service.hire(hireBody);
    const put = (id: string, payload: unknown) =>
      app.inject({ method: 'PUT', url: `/api/company/employees/${id}`, payload: payload as object });
    expect((await put('nobody', { position: 'X' })).statusCode).toBe(404);
    for (const bad of [
      {},
      { sessionId: 'parent-session' },
      { position: 'X', sessionId: 'parent-session' },
      { position: 'X', name: 'Other' },
      { owner: 'x' },
      { position: '' },
      { expertise: [] },
      { icon: 'not an icon at all' },
    ]) {
      expect((await put(employee.id, bad)).statusCode).toBe(400);
    }
    expect(service.view().employees[0]).toMatchObject({
      name: 'Maya',
      position: 'Scientist',
      sessionId: 'expert-session',
    });
  });

  it('lets authorized agent members invite real registered experts, never unknown substitutes', async () => {
    const employee = await service.hire(hireBody);
    const room = rooms.create('Science', undefined);
    const invite = () =>
      app.inject({
        method: 'POST',
        url: `/api/company/employees/${employee.id}/invite`,
        payload: { roomId: room.id },
        headers: { 'x-reverie-parent-session': 'parent-session' },
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
      (
        await app.inject({
          method: 'PUT',
          url: '/api/company/settings',
          payload: { coordinatorEmployeeId: 'unregistered' },
        })
      ).statusCode
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
  it('persists reporting edits, audits their transactional before/after, and remains owner-only', async () => {
    const report = await service.hire(hireBody);
    const lead = await service.hire({ ...hireBody, name: 'Lead', sessionId: 'parent-session', position: 'CTO' });
    const put = (reportsTo: string, headers = {}) =>
      app.inject({
        method: 'PUT',
        url: `/api/company/employees/${report.id}`,
        payload: { reportsTo },
        headers,
      });
    expect((await put(lead.id, { 'x-reverie-parent-session': 'parent-session' })).statusCode).toBe(403);
    expect((await put(lead.id, { 'x-reverie-parent-session': 'stale-agent' })).statusCode).toBe(403);
    expect(appendAdminAudit).not.toHaveBeenCalled();
    expect((await put(lead.id)).json().data.employee.reportsTo).toBe(lead.id);
    expect(service.view().employees.find((e) => e.id === report.id)?.reportsTo).toBe(lead.id);
    expect(appendAdminAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: 'employee_update',
        admin: 'owner',
        detail: expect.objectContaining({ reportsTo: { from: null, to: lead.id } }),
      })
    );
    expect((await put('owner')).statusCode).toBe(200);
    expect(appendAdminAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({ reportsTo: { from: lead.id, to: 'owner' } }),
      })
    );
  });

  it('rejects strict malformed or authority-changing updates and invalid hierarchy without audit', async () => {
    const report = await service.hire(hireBody);
    for (const payload of [
      {},
      { reportsTo: '' },
      { reportsTo: null },
      { reportsTo: 7 },
      { reportsTo: 'owner', owner: 'other' },
      { reportsTo: 'owner', sessionId: 'replacement' },
      { reportsTo: 'owner', name: 'Renamed' },
      { reportsTo: 'owner', arbitrary: true },
      { reportsTo: 'missing-parent' },
      { reportsTo: report.id },
    ]) {
      const res = await app.inject({ method: 'PUT', url: `/api/company/employees/${report.id}`, payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(service.view().employees[0]).not.toHaveProperty('reportsTo');
    expect(appendAdminAudit).not.toHaveBeenCalled();
  });

  it('only the owner grants or revokes employee recovery; an agent cannot grant itself permissions', async () => {
    const employee = await service.hire({ ...hireBody, position: 'CTO' });
    expect(employee.permissions).toEqual({ recoverEmployees: false, moveOwnPlan: false, managePlans: false });
    const url = `/api/company/employees/${employee.id}`;
    const payload = { permissions: { recoverEmployees: true } };
    for (const sessionId of ['expert-session', 'parent-session', 'stale-agent', '']) {
      const denied = await app.inject({
        method: 'PUT',
        url,
        payload,
        headers: { 'x-reverie-parent-session': sessionId },
      });
      expect(denied.statusCode).toBe(403);
    }
    const self = await app.inject({
      method: 'POST',
      url: '/api/company/self',
      payload,
      headers: { 'x-reverie-parent-session': 'expert-session' },
    });
    expect(self.statusCode).toBe(400);
    expect(service.view().employees[0].permissions.recoverEmployees).toBe(false);
    const granted = await app.inject({ method: 'PUT', url, payload });
    expect(granted.statusCode).toBe(200);
    expect(granted.json().data.employee.permissions.recoverEmployees).toBe(true);
    expect(appendAdminAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: 'employee_update',
        detail: expect.objectContaining({
          permissions: { from: { recoverEmployees: false, moveOwnPlan: false, managePlans: false }, to: { recoverEmployees: true, moveOwnPlan: false, managePlans: false } },
        }),
      })
    );
    const retitled = await app.inject({ method: 'PUT', url, payload: { position: 'COO' } });
    expect(retitled.statusCode).toBe(200);
    expect(retitled.json().data.employee.permissions.recoverEmployees).toBe(true);
    expect(
      (await app.inject({ method: 'PUT', url, payload: { permissions: { recoverEmployees: false } } })).statusCode
    ).toBe(200);
    expect(service.view().employees[0].permissions.recoverEmployees).toBe(false);
    expect(
      (await app.inject({ method: 'PUT', url, payload: { permissions: { unknownPower: true } } })).statusCode
    ).toBe(400);
  });
});
