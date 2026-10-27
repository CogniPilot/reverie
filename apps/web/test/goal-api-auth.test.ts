/** Actual HTTP permission boundaries via app.inject only; no server or employee adapter is activated. */
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { registerGoalRoutes } from '../src/web/routes/goal-routes.js';
import { ownerGoalAuthentication } from '../src/goal-owner-auth.js';
import { createGoalServerBoundary } from '../src/goal-server-integration.js';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { bootstrap, issueServiceToken, setPolicy } from '../src/owner-auth/admin.js';
import { OWNER_COOKIE, registerOwnerPolicy } from '../src/owner-auth/policy.js';
import { registerAuthMiddleware } from '../src/web/middleware/auth.js';
import { EmployeeSchema } from '../src/company-types.js';
import { goalFixture } from './helpers/goal-test-fixture.js';
import type { SessionPort } from '../src/web/ports/session-port.js';

describe('Goal API authentication and private custody boundary', () => {
  let f: Awaited<ReturnType<typeof goalFixture>>;
  const apps: FastifyInstance[] = [];
  let savedPassword: string | undefined;
  beforeEach(async () => {
    f = await goalFixture();
    savedPassword = process.env.REVERIE_PASSWORD;
  });
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    if (savedPassword === undefined) delete process.env.REVERIE_PASSWORD;
    else process.env.REVERIE_PASSWORD = savedPassword;
    await f.cleanup();
  });
  const as = (token: string) => ({ authorization: 'Bearer synthetic-' + token });

  it('denies reads and valid commands with the default unavailable auth/custody integration', async () => {
    const app = Fastify();
    apps.push(app);
    registerGoalRoutes(app, f.store);
    expect((await app.inject('/api/goals')).statusCode).toBe(403);
    expect(
      (await app.inject({ method: 'POST', url: '/api/goals', headers: as('owner'), payload: f.createInput })).statusCode
    ).toBe(403);
    expect(f.store.snapshot().goals).toEqual([]);
  });

  it('uses authenticated scoped principal rather than parent/header/body assertions and retains independent verification', async () => {
    const app = Fastify();
    apps.push(app);
    registerGoalRoutes(app, f.store, f.auth, () => f.clock.now);
    const created = await app.inject({
      method: 'POST',
      url: '/api/goals',
      headers: as('worker'),
      payload: f.createInput,
    });
    expect(created.statusCode).toBe(200);
    let goal = created.json().data;
    const send = (payload: Record<string, unknown>, token = 'worker') => {
      const { goalId: _goalId, ...body } = payload;
      return app.inject({
        method: 'POST',
        url: '/api/goals/' + goal.id + '/transitions',
        headers: as(token),
        payload: body,
      });
    };
    for (const state of ['ASSIGNED', 'ACTIVE', 'REVIEW'] as const) {
      const response = await send(f.command(goal, state));
      expect(response.statusCode).toBe(200);
      goal = response.json().data.goal;
    }
    expect((await send(f.command(goal, 'DONE'))).statusCode).toBe(403);
    expect((await send({ ...f.command(goal, 'DONE'), actor: { kind: 'owner' } })).statusCode).toBe(400);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/goals/' + goal.id,
          headers: { ...as('reader'), 'x-reverie-parent-session': 's' },
        })
      ).statusCode
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/goal-grants',
          headers: as('worker'),
          payload: {
            kind: 'VERIFY',
            employeeId: 'w',
            targetEmployeeId: 'w',
            goalId: goal.id,
            generation: 1,
            expectedSequence: 3,
            expiresAt: 2000,
          },
        })
      ).statusCode
    ).toBe(403);
    const granted = await app.inject({
      method: 'POST',
      url: '/api/goal-grants',
      headers: as('owner'),
      payload: {
        kind: 'VERIFY',
        employeeId: 'v',
        targetEmployeeId: 'w',
        goalId: goal.id,
        generation: 1,
        expectedSequence: 3,
        expiresAt: 2000,
      },
    });
    expect(granted.statusCode).toBe(200);
    expect(
      (await send(f.command(goal, 'DONE', { verifierGrantId: granted.json().data.id }), 'verifier')).statusCode
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/goals',
          headers: { authorization: 'Bearer invented', 'x-reverie-parent-session': 's' },
        })
      ).statusCode
    ).toBe(403);
  });

  it('integrates real owner cookies and existing owner middleware, refusing service tokens and preserving origin/revocation controls', async () => {
    process.env.REVERIE_PASSWORD = 'synthetic-goal-basic';
    const account = new OwnerAuthStore(join(f.directory, 'owner-auth.json'));
    const { oneTimePassword } = await bootstrap(account, 'synthetic-owner');
    await setPolicy(account, 'enforce', { forceLockoutRisk: true });
    const serviceToken = await issueServiceToken(account, 'synthetic-service');
    const service = new OwnerAuthService({ store: account, auditFile: join(f.directory, 'owner-audit.jsonl') });
    const restricted = await service.login('synthetic-owner', oneTimePassword, '127.0.0.1');
    const token = await service.changePassword(
      restricted.session,
      { current: oneTimePassword, next: 'synthetic-Quasar!8-lantern' },
      '127.0.0.1'
    );
    await f.store.update((state) =>
      state.employees.push(
        EmployeeSchema.parse({
          id: 'local',
          sessionId: 'local-s',
          name: 'Local',
          icon: 'W',
          position: 'Engineer',
          expertise: ['delivery'],
          createdAt: 1,
        })
      )
    );
    const app = Fastify();
    apps.push(app);
    await app.register(cookie);
    registerAuthMiddleware(app, false, '', service);
    const boundary = createGoalServerBoundary(service, f.store.file, {
      employee: f.auth,
      registerEmployeeBoundary: () => {},
      assertAction: () => {},
    });
    boundary.register(app);
    registerOwnerPolicy(app, {
      goalRequest: boundary.authorizeRequest,
      service,
      ctx: { sessions: new Map([['local-s', { id: 'local-s' }]]) } as unknown as SessionPort,
      isCapabilityRequest: () => false,
      relations: {
        known: () => false,
        related: () => false,
        upward: () => false,
        keeper: () => false,
        admin: () => false,
      },
    });
    registerGoalRoutes(app, f.store, boundary.authentication, () => f.clock.now);
    const payload = { ...f.createInput, employeeId: 'local', sessionId: 'local-s' };
    const owner = { cookies: { [OWNER_COOKIE]: token }, headers: { origin: 'http://localhost' } };
    expect((await app.inject({ ...owner, method: 'POST', url: '/api/goals', payload })).statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/goals',
          headers: {
            authorization: 'Basic ' + Buffer.from('admin:synthetic-goal-basic').toString('base64'),
            'x-reverie-service-token': serviceToken,
          },
        })
      ).statusCode
    ).toBe(403);
    expect(
      (
        await app.inject({
          ...owner,
          method: 'POST',
          url: '/api/goals',
          headers: { origin: 'http://foreign.invalid' },
          payload: { ...payload, createId: 'cross-origin' },
        })
      ).statusCode
    ).toBe(403);
    await service.logoutEverywhere('127.0.0.1');
    expect((await app.inject({ ...owner, method: 'GET', url: '/api/goals' })).statusCode).toBe(401);
  });

  it('real owner-cookie authentication alone cannot bypass missing custody proof', async () => {
    const account = new OwnerAuthStore(join(f.directory, 'owner-auth.json'));
    const { oneTimePassword } = await bootstrap(account, 'synthetic-owner');
    const service = new OwnerAuthService({ store: account, auditFile: join(f.directory, 'owner-audit.jsonl') });
    const first = await service.login('synthetic-owner', oneTimePassword, '127.0.0.1');
    const token = await service.changePassword(
      first.session,
      { current: oneTimePassword, next: 'synthetic-Quasar!8-lantern' },
      '127.0.0.1'
    );
    const app = Fastify();
    apps.push(app);
    await app.register(cookie);
    registerGoalRoutes(app, f.store, ownerGoalAuthentication(service));
    expect(
      (await app.inject({ method: 'GET', url: '/api/goals', cookies: { [OWNER_COOKIE]: token } })).statusCode
    ).toBe(403);
  });
});
