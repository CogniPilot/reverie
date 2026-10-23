import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { ownerVerifier } from '../src/owner-auth/marks.js';
import { OWNER_COOKIE, registerOwnerPolicy, SERVICE_HEADER } from '../src/owner-auth/policy.js';
import * as admin from '../src/owner-auth/admin.js';
import { RoutinesGrants } from '../src/routines-grants.js';
import { registerCronRoutes } from '../src/web/routes/cron-routes.js';
import { appendAdminAudit } from '../src/web/admin-audit.js';
import type { CronPort } from '../src/web/ports/index.js';
import { createMockRouteContext } from './mocks/index.js';

vi.mock('../src/web/admin-audit.js', () => ({ appendAdminAudit: vi.fn(async () => {}) }));

let dir: string;
let store: OwnerAuthStore;
let service: OwnerAuthService;
let serviceToken: string;
let ownerToken: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'routines-owner-'));
  store = new OwnerAuthStore(join(dir, 'owner.json'));
  const bootstrap = await admin.bootstrap(store, 'fixture-owner', { enforce: true });
  serviceToken = await admin.issueServiceToken(store, 'synthetic-untrusted-service');
  service = new OwnerAuthService({ store, auditFile: join(dir, 'auth-audit.jsonl') });
  const login = await service.login('fixture-owner', bootstrap.oneTimePassword, '127.0.0.1');
  ownerToken = await service.changePassword(
    login.session!,
    { current: bootstrap.oneTimePassword, next: 'synthetic-correct-horse-42' },
    '127.0.0.1'
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function fixture(file: string) {
  const grants = new RoutinesGrants(file);
  await grants.init();
  const set = vi.spyOn(grants, 'set');
  const ctx = createMockRouteContext();
  ctx.sessions.clear();
  const port: CronPort = {
    // This endpoint must not touch the scheduler; the permission file is real.
    cron: {} as CronPort['cron'],
    routines: {
      grants,
      findEmployee: () => undefined,
      isMember: () => false,
      notificationRoomId: () => undefined,
      notify: () => false,
    },
  };
  const app = Fastify();
  await app.register(cookie);
  registerOwnerPolicy(app, {
    service,
    ctx,
    isCapabilityRequest: () => false,
    relations: {
      known: () => false,
      related: () => false,
      coordinated: () => false,
      upward: () => false,
      keeper: () => false,
      admin: () => false,
    },
  });
  registerCronRoutes(app, port, ownerVerifier({ service, ctx }));
  vi.mocked(appendAdminAudit).mockClear();
  return { app, grants, set };
}

for (const policy of ['enforce', 'log', 'off'] as const) {
  it(`refuses service grant writes under ${policy} without changing disk, permission or audit`, async () => {
    await admin.setPolicy(store, policy, { forceLockoutRisk: true });
    const file = join(dir, `service-${policy}.json`);
    const { app, grants, set } = await fixture(file);
    const before = grants.snapshot();
    try {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/routines-grants',
        headers: { [SERVICE_HEADER]: serviceToken },
        payload: { roles: [], employees: { 'synthetic-employee': true } },
      });
      expect(response.statusCode, response.body).toBe(403);
      expect(set).not.toHaveBeenCalled();
      expect(grants.snapshot()).toEqual(before);
      expect(grants.allows({ id: 'synthetic-employee', position: 'Member' })).toBe(false);
      await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(appendAdminAudit).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it(`preserves verified owner grant writes under ${policy}`, async () => {
    await admin.setPolicy(store, policy, { forceLockoutRisk: true });
    const file = join(dir, `owner-${policy}.json`);
    const { app, grants, set } = await fixture(file);
    const payload = { roles: [], employees: { 'synthetic-owner-approved': true } };
    try {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/routines-grants',
        cookies: { [OWNER_COOKIE]: ownerToken },
        headers: { host: 'localhost', origin: 'http://localhost' },
        payload,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(set).toHaveBeenCalledOnce();
      expect(grants.allows({ id: 'synthetic-owner-approved', position: 'Member' })).toBe(true);
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(payload);
      expect(appendAdminAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'routines_grants_set', admin: 'owner' })
      );
    } finally {
      await app.close();
    }
  });
}
