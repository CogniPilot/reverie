/** Closed policy ordering and unavailable/error-port behavior; synthetic fixtures/app.inject only. */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { registerOwnerPolicy } from '../src/owner-auth/policy.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { dirname, join } from 'node:path';
import type { SessionPort } from '../src/web/ports/session-port.js';
import { createGoalServerBoundary, type GoalServerPorts } from '../src/goal-server-integration.js';
import { registerGoalRoutes } from '../src/web/routes/goal-routes.js';
import { goalFixture } from './helpers/goal-test-fixture.js';

const apps: FastifyInstance[] = [];
const fixtures: Array<Awaited<ReturnType<typeof goalFixture>>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const app of apps.splice(0)) await app.close();
  for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});
const goalTuples = [
  ['GET', '/api/goals'],
  ['GET', '/api/goals/:id'],
  ['GET', '/api/goal-metadata/:employeeId'],
  ['POST', '/api/goals'],
  ['POST', '/api/goals/:id/transitions'],
  ['POST', '/api/goals/:id/adopt'],
  ['POST', '/api/goals/:id/unblock-proofs'],
  ['POST', '/api/goal-grants'],
  ['POST', '/api/goal-grants/:id/revoke'],
  ['POST', '/api/goal-unblock-proofs/:id/revoke'],
] as const;

it.each(['off', 'log', 'enforce'] as const)(
  'requires the exact Goal purpose gate with ordinary owner policy %s',
  async (mode) => {
    const app = Fastify();
    apps.push(app);
    let entered = 0;
    const f = await goalFixture();
    fixtures.push(f);
    const service = new OwnerAuthService({
      store: new OwnerAuthStore(join(dirname(f.file), 'owner-auth.json')),
      auditFile: join(dirname(f.file), 'owner-audit.jsonl'),
    });
    vi.spyOn(service, 'policy').mockReturnValue(mode);
    registerOwnerPolicy(app, {
      service,
      ctx: { sessions: new Map() } as unknown as SessionPort,
      isCapabilityRequest: () => false,
      relations: {
        known: () => false,
        related: () => false,
        upward: () => false,
        keeper: () => false,
        admin: () => false,
      } as never,
    });
    for (const [method, url] of goalTuples)
      app.route({
        method,
        url,
        handler: () => {
          entered++;
          return { success: true };
        },
      });
    for (const [method, route] of goalTuples) {
      const url = route.replace(':id', 'synthetic').replace(':employeeId', 'synthetic');
      const response = await app.inject({ method, url, ...(method === 'POST' ? { payload: {} } : {}) });
      expect(response.statusCode, method + ' ' + url).toBe(403);
    }
    expect(entered).toBe(0);
  }
);

it.each([
  'authenticate',
  'assertCurrent',
  'custody',
  'permission',
  'async-permission',
  'boolean-custody',
  'employee-mints-owner',
] as const)('refuses %s port failures without exposing adapter details or committing', async (mode) => {
  const f = await goalFixture();
  fixtures.push(f);
  const app = Fastify();
  apps.push(app);
  const secret = () => {
    throw new Error('PRIVATE_PORT_CONFIGURATION_SENTINEL');
  };
  const employee = { ...f.auth };
  const ports: GoalServerPorts = { employee, registerEmployeeBoundary: () => {}, assertAction: () => {} };
  if (mode === 'authenticate') employee.authenticate = async () => secret();
  if (mode === 'assertCurrent') employee.assertCurrent = secret;
  if (mode === 'custody') employee.assertPrivateCustody = secret;
  if (mode === 'permission') ports.assertAction = secret;
  if (mode === 'async-permission') ports.assertAction = async () => secret();
  if (mode === 'boolean-custody') employee.assertPrivateCustody = () => true;
  if (mode === 'employee-mints-owner') employee.authenticate = async () => ({ kind: 'owner', owner: 'a' });
  const boundary = createGoalServerBoundary({ session: () => undefined }, f.file, ports);
  boundary.register(app);
  registerGoalRoutes(app, f.store, boundary.authentication, () => f.clock.now);
  const result = await app.inject({
    method: 'POST',
    url: '/api/goals',
    headers: { authorization: 'Bearer synthetic-worker' },
    payload: f.createInput,
  });
  expect(result.statusCode, result.body).toBe(403);
  expect(result.body).not.toContain('PRIVATE_PORT_CONFIGURATION_SENTINEL');
  expect(f.store.snapshot().goals).toEqual([]);
});
