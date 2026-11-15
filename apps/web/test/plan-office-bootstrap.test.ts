import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { registerOwnerRoutes } from '../src/owner-auth/routes.js';
import { OWNER_COOKIE } from '../src/owner-auth/policy.js';
import { PlanOfficeBootstrap, seedPlanOffice } from './helpers/plan-office-bootstrap.js';
import {
  enrollIsolatedPlanOfficeOwner,
  resumeIsolatedPlanOfficeOwner,
} from './helpers/docker-continuation-auth-canary.js';

const contract = {
  version: 1,
  purpose: 'reverie-ci-plan-office-bootstrap-v1',
  employees: [
    {
      employeeId: '10000000-0000-4000-8000-000000000001',
      sessionId: '20000000-0000-4000-8000-000000000002',
      nativeThreadId: '30000000-0000-4000-8000-000000000003',
      name: 'CI Worker',
      account: 'ci-plan-a',
      permissions: { moveOwnPlan: true },
    },
  ],
};
describe('isolated plan-office bootstrap boundaries', () => {
  it('does not accept seeded native bindings, live phases or an uncontrolled account path', async () => {
    expect(PlanOfficeBootstrap.parse(contract).employees[0]!.permissions.managePlans).toBe(false);
    for (const extra of [{ dockerBinding: {} }, { phase: 'ready' }, { account: '/personal/account' }])
      expect(() =>
        PlanOfficeBootstrap.parse({ ...contract, employees: [{ ...contract.employees[0], ...extra }] })
      ).toThrow();
    await expect(seedPlanOffice(contract)).rejects.toThrow('isolated Docker control fixture');
  });
  it('obtains its owner cookie through the real enrollment/login API and never forwards it to another origin', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'plan-office-owner-'));
    const app = Fastify();
    try {
      const service = new OwnerAuthService({
        store: new OwnerAuthStore(join(directory, 'owner-auth.json')),
        auditFile: join(directory, 'audit.jsonl'),
        setupEnabled: true,
      });
      await app.register(cookie);
      registerOwnerRoutes(app, service, false);
      let calls = 0;
      app.get('/api/fixture/owner', (request, reply) => {
        calls++;
        if (!service.session(request.cookies[OWNER_COOKIE])) return reply.code(403).send({ success: false });
        return { success: true, data: { actualOwner: true } };
      });
      await app.listen({ port: 0, host: '127.0.0.1' });
      const address = app.server.address();
      if (!address || typeof address === 'string') throw Error('Actual ephemeral owner API required');
      const endpoint = 'http://127.0.0.1:' + address.port;
      const owner = await enrollIsolatedPlanOfficeOwner(endpoint, directory);
      const response = await owner.request('/api/fixture/owner');
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true, data: { actualOwner: true } });
      for (const path of [
        'https://other.invalid/api/fixture/owner',
        '//other.invalid/api/fixture/owner',
        '/api/../../owner/login',
      ])
        await expect(owner.request(path)).rejects.toThrow('Only this disposable office API');
      expect(calls).toBe(1);
      expect((await stat(owner.ownerSessionFile)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(owner.ownerSessionFile, 'utf8')).cookie).toMatch(/^reverie_owner=/);
      expect(owner.requests().map((r) => r.path)).toEqual([
        '/api/owner/status',
        '/api/owner/setup',
        '/api/owner/login',
        '/api/owner/status',
        '/api/fixture/owner',
      ]);
      const resumed = await resumeIsolatedPlanOfficeOwner(endpoint, directory);
      expect(resumed.requests().map((r) => r.path)).toEqual(['/api/owner/status']);
      expect((await resumed.request('/api/fixture/owner')).status).toBe(200);
      await expect(resumed.request('//foreign.invalid/api/fixture/owner')).rejects.toThrow('Only this disposable');
      await resumed.request('/api/owner/logout', 'POST', {});
      await expect(resumeIsolatedPlanOfficeOwner(endpoint, directory)).rejects.toThrow('Current actual owner login');
      await expect(enrollIsolatedPlanOfficeOwner(endpoint, directory)).rejects.toThrow('not pristine');
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
