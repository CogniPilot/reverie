/** Actual cookie classification; synthetic company/context only. No files or process startup are inferred. */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { mkdtemp, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { bootstrap, issueServiceToken } from '../src/owner-auth/admin.js';
import { registerOwnerRoutes } from '../src/owner-auth/routes.js';
import { callerOf, OWNER_COOKIE, SERVICE_HEADER } from '../src/owner-auth/policy.js';
import { ownerVerifier } from '../src/owner-auth/marks.js';
import { EmployeeSchema, type CompanyEmployee } from '../src/company-types.js';
import { registerEmployeeContextRoutes } from '../src/web/routes/employee-context-routes.js';
import type { SessionPort } from '../src/web/ports/session-port.js';

const SID = '11111111-1111-4111-8111-111111111111';
describe('current and harness-reported employee context routes', () => {
  let root: string, app: FastifyInstance, ownerToken: string, serviceToken: string;
  let employee: CompanyEmployee; let clock: number; let core: string[];
  let session: { id: string; owner: undefined; pid: number | null };
  beforeEach(async () => {
    root = await mkdtemp(join(realpathSync(tmpdir()), 'employee-context-'));
    const authStore = new OwnerAuthStore(join(root, 'owner.json'));
    const { oneTimePassword } = await bootstrap(authStore, 'synthetic-owner');
    serviceToken = await issueServiceToken(authStore, 'synthetic-service');
    const service = new OwnerAuthService({ store: authStore, auditFile: join(root, 'audit.jsonl') });
    employee = EmployeeSchema.parse({ id: 'employee-one', name: 'Alex', icon: 'A', position: 'Engineer', expertise: ['Testing'],
      sessionId: SID, sessionGeneration: 1, createdAt: 1, desiredRunning: true, coreBeliefs: ['Personal fixture block'] });
    core = ['Company fixture block']; clock = 1000; session = { id: SID, owner: undefined, pid: 123 };
    const ctx = { sessions: new Map([[SID, session]]) } as unknown as SessionPort;
    app = Fastify(); await app.register(cookie); registerOwnerRoutes(app, service, false);
    registerEmployeeContextRoutes(app, ctx, { verifiedOwner: ownerVerifier({ service, ctx }),
      agentSession: request => { const caller = callerOf(request, { service, ctx }); return caller.kind === 'agent' ? caller.session : undefined; },
      company: () => ({ employees: [employee], settings: { coreBeliefs: core } }), now: () => clock });
    await app.ready();
    const login = await app.inject({ method: 'POST', url: '/api/owner/login', payload: { username: 'synthetic-owner', password: oneTimePassword } });
    const changed = await app.inject({ method: 'POST', url: '/api/owner/password', headers: { origin: 'http://localhost' },
      cookies: { [OWNER_COOKIE]: login.cookies.find(value => value.name === OWNER_COOKIE)!.value },
      payload: { current: oneTimePassword, next: 'Synthetic!new-owner-context-784' } });
    expect(changed.statusCode).toBe(200); ownerToken = changed.cookies.find(value => value.name === OWNER_COOKIE)!.value;
  });
  afterEach(async () => { await app?.close(); await rm(root, { recursive: true, force: true }); });
  const self = (method: 'GET' | 'POST', path = '/api/agent/context', payload?: object) => app.inject({ method, url: path, payload, headers: { 'x-reverie-parent-session': SID } });
  const inspect = () => app.inject({ url: '/api/company/employees/employee-one/startup-context', cookies: { [OWNER_COOKIE]: ownerToken } });
  it('owner sees current preview but no invented old startup, while self is exact and protected', async () => {
    const view = (await inspect()).json().data;
    expect(view.startup.status).toBe('unavailable'); expect(view.context).toContain('Company fixture block');
    expect((await self('GET')).json().data).toMatchObject({ employeeId: employee.id, sessionId: SID, sessionGeneration: 1 });
    for (const response of [
      await app.inject({ url: '/api/company/employees/employee-one/startup-context', headers: { 'x-reverie-parent-session': SID } }),
      await app.inject({ url: '/api/agent/context', cookies: { [OWNER_COOKIE]: ownerToken }, headers: { 'x-reverie-parent-session': SID } }),
      await app.inject({ url: '/api/agent/context', headers: { [SERVICE_HEADER]: serviceToken, 'x-reverie-parent-session': SID } }),
      await app.inject({ url: '/api/agent/context', headers: { 'x-reverie-parent-session': SID.slice(0, 16) } }),
    ]) expect(response.statusCode).toBe(403);
    session.pid = null; expect((await self('GET')).statusCode).toBe(403);
    session.pid = 123; employee.onVacation = true; expect((await self('GET')).statusCode).toBe(403);
  });
  it('captures only the exact issued input and keeps current preview distinct from reported old text', async () => {
    const issued = (await self('GET')).json().data;
    clock++;
    expect((await self('POST', '/api/agent/context/receipt', { digest: 'sha256:' + 'a'.repeat(64), stage: 'startup' })).statusCode).toBe(403);
    expect((await self('POST', '/api/agent/context/receipt', { digest: issued.digest, stage: 'startup', context: 'Injected' })).statusCode).toBe(400);
    const receipt = await self('POST', '/api/agent/context/receipt', { digest: issued.digest, stage: 'startup' });
    expect(receipt.statusCode).toBe(200); expect(receipt.json().data.assurance).toBe('harness-reported-input');
    core = ['Updated current owner block'];
    const inspected = (await inspect()).json().data;
    expect(inspected.context).toContain(core[0]); expect(inspected.context).not.toContain('Company fixture block');
    expect(inspected.startup.report.context).toBe(issued.context);
    expect(inspected.lastManagedDelivery).toMatchObject({ digest: issued.digest, stage: 'startup', retention: 'website-process-lifetime' });
    session.pid = 124;
    const restarted = (await inspect()).json().data;
    expect(restarted.runtimeBinding).not.toBe(issued.runtimeBinding);
    expect(restarted.startup.status).toBe('unavailable');
    expect(restarted.lastManagedDelivery.digest).toBe(issued.digest);
    expect((await self('POST', '/api/agent/context/receipt', { digest: issued.digest, stage: 'startup' })).statusCode).toBe(403);
    employee.sessionGeneration = 2;
    expect((await inspect()).json().data.startup.status).toBe('unavailable');
    expect((await self('POST', '/api/agent/context/receipt', { digest: issued.digest, stage: 'startup' })).statusCode).toBe(403);
  });
});
