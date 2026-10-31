/**
 * GET /api/plans/move-impact through the real owner policy (enforce mode) and the real parent-session resolver: a
 * coordinator with plans.view_all reaches it on its session header; a plain agent, another owner's session, a
 * headerless caller and a service token do not. Synthetic owner store; no live account or plan data.
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OfficeAuthService } from '../src/owner-auth/office.js';
import { bootstrap, issueServiceToken } from '../src/owner-auth/admin.js';
import { registerOwnerPolicy } from '../src/owner-auth/policy.js';
import { registerPlansRoutes } from '../src/web/routes/plans-routes.js';
import { installRouteErrorHandler } from '../src/web/route-error-handler.js';
import { resolveParentSessionId, ownerFor } from '../src/web/route-helpers.js';
import type { SessionPort } from '../src/web/ports/session-port.js';
import type { PlanService } from '../src/plan-accounts.js';

let directory: string;
let app: FastifyInstance;
let serviceToken: string;
const URL = '/api/plans/move-impact?session=worker&to=acct-other';
const IMPACT = { sessionId: 'worker', usdPerHour: 2, from: { id: 'acct-one' }, to: { id: 'acct-other' } };

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'plan-move-impact-policy-'));
  const store = new OwnerAuthStore(join(directory, 'owner-auth.json'));
  await bootstrap(store, 'fixture-owner', { enforce: true });
  serviceToken = await issueServiceToken(store, 'fixture-service');
  const auth = new OfficeAuthService({ store, auditFile: join(directory, 'audit.jsonl') });
  const sessions = new Map(
    [
      { id: 'coordinator-session', owner: undefined },
      { id: 'plain-agent-session', owner: undefined },
      { id: 'other-owner-session', owner: 'someone-else' },
    ].map((s) => [s.id, s])
  );
  const ctx = { sessions } as unknown as SessionPort;
  app = Fastify({ logger: false });
  await app.register(cookie);
  registerOwnerPolicy(app, {
    service: auth,
    ctx,
    isCapabilityRequest: () => false,
    relations: { known: () => false, related: () => false, upward: () => false, keeper: () => false, admin: () => false },
  });
  const plans = { moveImpact: async (session: string) => (session === 'worker' ? IMPACT : null) } as unknown as PlanService;
  registerPlansRoutes(app, plans, undefined, {
    // As the server wires it: the real resolver, and plans.view_all for the coordinator only.
    callerSession: (req) => resolveParentSessionId(ctx, req, undefined, ownerFor(req)),
    canViewAll: (id) => id === 'coordinator-session' || id === 'other-owner-session',
  });
  installRouteErrorHandler(app);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await rm(directory, { recursive: true, force: true });
});

const get = (headers: Record<string, string> = {}) => app.inject({ method: 'GET', url: URL, headers: { host: 'localhost', ...headers } });

it('lets a coordinator with plans.view_all through on its session header', async () => {
  const res = await get({ 'x-reverie-parent-session': 'coordinator-session' });
  expect(res.statusCode, res.body).toBe(200);
  expect(res.json().data).toEqual(IMPACT);
});

it('refuses a plain agent, another owner session, no header and a service token', async () => {
  expect((await get({ 'x-reverie-parent-session': 'plain-agent-session' })).statusCode).toBe(403);
  // Another owner's session does not resolve for this caller, even though it would hold view_all.
  expect((await get({ 'x-reverie-parent-session': 'other-owner-session' })).statusCode).toBe(403);
  expect((await get()).statusCode).toBe(401);
  expect((await get({ 'x-reverie-service-token': serviceToken })).statusCode).toBe(403);
  expect((await get({ 'x-reverie-service-token': serviceToken, 'x-reverie-parent-session': 'coordinator-session' })).statusCode).toBe(403);
});
