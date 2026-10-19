/**
 * @fileoverview Role scoping of GET /api/plans: the owner and a coordinator see every account, any other agent only the account
 * its own session runs on; sign-in stays the owner's. The same API serves the page, `reverie plans` and the MCP tools.
 */
import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerPlansRoutes } from '../src/web/routes/plans-routes.js';
import type { PlanService } from '../src/plan-accounts.js';
import type { AccountLoginService } from '../src/account-login.js';
import { allowed, classify } from '../src/owner-auth/policy.js';

const COORD = 'cccccccc-0000-4000-8000-000000000001';
const WORKER = 'wwwwwwww-0000-4000-8000-000000000002';
const IDLE = 'iiiiiiii-0000-4000-8000-000000000003';

const row = (id: string, sessions: string[]) => ({
  id, label: id, provider: 'anthropic', profileId: id, acctName: null, isDefault: false, signedIn: true, status: 'ok', updatedAt: 1,
  pace: { fiveHour: 1, weekly: 2, weekStart: 0, weekReset: 9, elapsed: 3, pace: 0, burnPerHour: 0, projected: 4, runsOutAt: null, recommendation: 'steady' },
  bankedResets: null, sessions: sessions.map((s) => ({ id: s, name: s.slice(0, 4), mode: 'claude', status: 'idle' })), orchestrator: false,
});
const DATA = { generatedAt: 1, accounts: [row('work', [COORD]), row('cogni', [WORKER]), row('spare', [])], gpu: { available: false, utilization: null, memoryUsedMb: null, memoryTotalMb: null, models: [], lastHolder: null } };

let app: FastifyInstance;
afterEach(async () => app.close());

async function build() {
  app = Fastify();
  const started: string[] = [];
  const logins = { start: async () => { started.push('x'); return {}; }, get: () => undefined, cancel: () => undefined } as unknown as AccountLoginService;
  registerPlansRoutes(app, { plans: async () => DATA, suggest: async () => null } as unknown as PlanService, logins, {
    callerSession: (req) => {
      const h = req.headers['x-codeman-parent-session'];
      return [COORD, WORKER, IDLE].includes(h as string) ? (h as string) : undefined;
    },
    canViewAll: (id) => id === COORD,
  });
  await app.ready();
  return started;
}
const get = (session?: string) =>
  app.inject({ method: 'GET', url: '/api/plans', headers: session ? { 'x-codeman-parent-session': session } : {} });
const ids = (r: { json(): { data: { accounts: Array<{ id: string }> } } }) => r.json().data.accounts.map((a) => a.id);

describe('GET /api/plans by role', () => {
  it('owner: every account and the GPU line', async () => {
    await build();
    const r = await get();
    expect(r.statusCode).toBe(200);
    expect(ids(r)).toEqual(['work', 'cogni', 'spare']);
    expect(r.json().data.gpu).toBeDefined();
  });

  it('coordinator: every account', async () => {
    await build();
    const r = await get(COORD);
    expect(ids(r)).toEqual(['work', 'cogni', 'spare']);
  });

  it('other agent: only the account its own session runs on, and no GPU line', async () => {
    await build();
    const r = await get(WORKER);
    expect(ids(r)).toEqual(['cogni']);
    expect(r.json().data.gpu).toBeUndefined();
  });

  it('an agent on no account sees nothing; a header that names no live session is refused', async () => {
    await build();
    expect(ids(await get(IDLE))).toEqual([]);
    expect((await get('not-a-session')).statusCode).toBe(403);
  });

  it('no token or credential field is ever in a row', async () => {
    await build();
    expect(JSON.stringify((await get()).json())).not.toMatch(/token|secret|password|credential|configDir/i);
  });
});

describe('sign-in stays the owner’s', () => {
  it('an agent caller cannot start, read or cancel a sign-in; the owner can reach the route', async () => {
    const started = await build();
    for (const [method, url] of [['POST', '/api/plans/accounts/work/login'], ['POST', '/api/plans/login-all'], ['GET', '/api/plans/logins/x'], ['DELETE', '/api/plans/logins/x']] as const) {
      const r = await app.inject({ method, url, headers: { 'x-codeman-parent-session': COORD } });
      expect(r.statusCode, `${method} ${url}`).toBe(403);
    }
    expect(started).toEqual([]);
    const owner = await app.inject({ method: 'GET', url: '/api/plans/logins/x' });
    expect(owner.statusCode).not.toBe(403);
  });
});

describe('owner-auth policy', () => {
  it('lets an agent read GET /api/plans but never start a sign-in', () => {
    expect(allowed(classify('GET', '/api/plans', '/api/plans'), 'agent')).toBe(true);
    expect(allowed(classify('POST', '/api/plans/accounts/:id/login', '/x'), 'agent')).toBe(false);
    expect(allowed(classify('POST', '/api/plans/login-all', '/x'), 'agent')).toBe(false);
    expect(allowed(classify('GET', '/api/plans', '/api/plans'), 'anonymous')).toBe(false);
  });
});
