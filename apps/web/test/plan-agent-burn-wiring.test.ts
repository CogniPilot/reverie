/**
 * Per-agent plan burn wiring: the status-telemetry route offers each known session's cumulative cost to the tracker, and
 * the Plans rows carry each Claude plan's per-agent burn from those samples and the plan's weekly history.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { createRouteTestHarness, type RouteTestHarness } from './routes/_route-test-utils.js';
import { trustedFixtureOwner } from './helpers/trusted-owner-fixture.js';
import { registerPlansRoutes } from '../src/web/routes/plans-routes.js';
import { installRouteErrorHandler } from '../src/web/route-error-handler.js';
import { registerStatusTelemetryRoutes } from '../src/web/routes/status-telemetry-routes.js';
import { PlanCostTracker } from '../src/plan-agent-burn.js';
import { PlanService } from '../src/plan-accounts.js';
import { WEEK_MS } from '../src/plan-pace.js';
import { getDataDir } from '../src/config/instance.js';
import { resetLatestAccountPlanUsage, setLatestAccountPlanUsage } from '../src/web/plan-usage-latest.js';
import type { SubscriptionProfile } from '../src/subscription-profiles.js';

const M = 60 * 1000;
const H = 60 * M;
const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
const RESET = NOW + WEEK_MS / 2;

describe('status-telemetry records session cost', () => {
  let h: RouteTestHarness;
  let dir: string;
  let tracker: PlanCostTracker;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'plan-cost-route-'));
    tracker = new PlanCostTracker(join(dir, 'costs.json'));
    h = await createRouteTestHarness((app, ctx) => registerStatusTelemetryRoutes(app, ctx, tracker), { sessionId: 'worker' });
  });

  afterEach(async () => {
    await h.app.close();
    // The tracker writes in the background; let that write land before its directory goes.
    await tracker.flushed();
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the cost of a known session and nothing for an unknown one', async () => {
    await h.app.inject({ method: 'POST', url: '/api/status-telemetry', payload: { sessionId: 'worker', data: { cost: { total_cost_usd: 2.5 } } } });
    await h.app.inject({ method: 'POST', url: '/api/status-telemetry', payload: { sessionId: 'nobody', data: { cost: { total_cost_usd: 9 } } } });
    await h.app.inject({ method: 'POST', url: '/api/status-telemetry', payload: { sessionId: 'worker', data: { model: { display_name: 'x' } } } });
    expect((await tracker.costs('worker')).map((s) => s.cost)).toEqual([2.5]);
    expect(await tracker.costs('nobody')).toEqual([]);
  });
});

describe('Plans rows carry per-agent burn', () => {
  let home: string;
  const savedHome = process.env.HOME;
  /** Every service a test builds: each saves its usage history in the background, into `home`. */
  const services: PlanService[] = [];
  const track = (service: PlanService) => (services.push(service), service);

  beforeEach(() => {
    rmSync(join(getDataDir(), 'subscription-profiles.json'), { force: true });
    home = mkdtempSync(join(tmpdir(), 'plans-agent-burn-'));
    process.env.HOME = home;
    mkdirSync(join(home, '.claude-accounts', 'secondary'), { recursive: true });
    writeFileSync(join(home, '.claude-accounts', 'secondary', '.credentials.json'), '{}');
    resetLatestAccountPlanUsage();
  });

  afterEach(async () => {
    // Settle every history write before removing the home it writes into (it otherwise races rmSync: ENOTEMPTY).
    await Promise.all(services.splice(0).map((service) => service.settled()));
    process.env.HOME = savedHome;
    resetLatestAccountPlanUsage();
    rmSync(home, { recursive: true, force: true });
  });

  /** Two Claude plans: `secondary` with two working sessions and a rising history, `team-20x` with no data. */
  const twoPlans = () => {
    mkdirSync(join(home, '.claude-accounts', 'team-20x'), { recursive: true });
    writeFileSync(join(home, '.claude-accounts', 'team-20x', '.credentials.json'), '{}');
    const history = join(home, 'plan-usage-history.json');
    const weekly = [];
    for (let t = NOW - 6 * H; t <= NOW; t += 5 * M) weekly.push({ at: t, weekly: Math.round(20 + (1.5 * (t - NOW + 6 * H)) / H), resetAt: RESET });
    writeFileSync(history, JSON.stringify({ 'acct-anthropic-secondary': weekly }));
    const samples: Record<string, { at: number; cost: number }[]> = { a: [], b: [] };
    for (let t = NOW - 6 * H; t <= NOW; t += M) {
      samples.a.push({ at: t, cost: (2 * (t - NOW + 6 * H)) / H });
      samples.b.push({ at: t, cost: (1 * (t - NOW + 6 * H)) / H });
    }
    writeFileSync(join(home, 'costs.json'), JSON.stringify(samples));
    for (const [id, label, used] of [['acct-anthropic-secondary', 'secondary', 29], ['acct-anthropic-team-20x', 'team-20x', 10]] as const)
      setLatestAccountPlanUsage({ id, label, provider: 'anthropic', status: 'ready', updatedAt: NOW, usage: { sevenDay: { usedPercentage: used, resetAt: RESET } } });
    const dirOf = join(home, '.claude-accounts', 'secondary');
    const session = (id: string, name: string) => ({ id, name, mode: 'claude', status: 'busy', getEnvOverridesForPersist: () => ({ CLAUDE_CONFIG_DIR: dirOf }) });
    return track(new PlanService({
      reader: {
        read: async (p: SubscriptionProfile) => ({ id: p.id, label: p.label, provider: p.provider, status: 'ready' as const, authState: 'signed-in' as const, updatedAt: NOW, usage: null }),
      },
      sessions: () => [session('a', 'Worker A'), session('b', 'Worker B')],
      coordinatorIds: () => [],
      historyFile: history,
      costs: new PlanCostTracker(join(home, 'costs.json')),
      home,
      now: () => NOW,
      gpu: async () => ({ available: false, utilization: null, memoryUsedMb: null, memoryTotalMb: null, models: [], lastHolder: null }),
    }));
  };

  it('estimates a move with the leaving plan learned factor and the joining plan prior', async () => {
    const service = twoPlans();
    const target = (await service.rows()).accounts.find((r) => r.label === 'team-20x')!;
    const impact = (await service.moveImpact('a', target.id))!;
    expect(impact.usdPerHour).toBeCloseTo(2, 1);
    expect(impact.from.id).toBe('acct-anthropic-secondary');
    expect(impact.from.conversion.basis).toBe('learned');
    expect(impact.to.conversion.basis).toBe('prior');
    expect(impact.to.conversion.tier).toBe('20x');
    // Leaving drops the plan's rate by about 2 units × ~0.5; joining adds 2 units × the 20x prior (1/20).
    expect(impact.from.rateAfter!).toBeLessThan(impact.from.rateNow!);
    expect(impact.from.endAfter!).toBeLessThan(impact.from.endNow!);
    expect(impact.to.rateBasis).toBe('none');
    expect(impact.to.rateNow).toBe(0);
    expect(impact.to.rateAfter!).toBeCloseTo(2 * (1 / 20), 2);
    expect(impact.from.rateBasis).toBe('realtime');
    expect(impact.to.endAfterLow!).toBeLessThanOrEqual(impact.to.endAfter!);
    expect(impact.to.endAfterHigh!).toBeGreaterThanOrEqual(impact.to.endAfter!);
    expect(await service.moveImpact('nobody', target.id)).toBeNull();
    expect(await service.moveImpact('a', 'acct-anthropic-secondary')).toBeNull();
  });

  it('serves the move impact to the owner and refuses a bad query', async () => {
    const app = Fastify({ logger: false });
    registerPlansRoutes(app, twoPlans(), undefined, undefined, trustedFixtureOwner);
    installRouteErrorHandler(app);
    await app.ready();
    try {
      const ok = await app.inject({ method: 'GET', url: `/api/plans/move-impact?session=a&to=${encodeURIComponent('acct-anthropic-team-20x')}` });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().data.to.label).toBe('team-20x');
      expect((await app.inject({ method: 'GET', url: '/api/plans/move-impact?session=a' })).statusCode).toBe(400);
      expect((await app.inject({ method: 'GET', url: '/api/plans/move-impact?session=zz&to=x' })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('serves the move impact to a coordinator with plans.view_all on its session header, not to a plain agent', async () => {
    const app = Fastify({ logger: false });
    const scope = {
      callerSession: (req: { headers: Record<string, unknown> }) => req.headers['x-reverie-parent-session'] as string | undefined,
      canViewAll: (id: string) => id === 'coordinator',
    };
    // No verified owner: only the session header speaks.
    registerPlansRoutes(app, twoPlans(), undefined, scope as never);
    installRouteErrorHandler(app);
    await app.ready();
    try {
      const url = `/api/plans/move-impact?session=a&to=${encodeURIComponent('acct-anthropic-team-20x')}`;
      const asCoordinator = await app.inject({ method: 'GET', url, headers: { 'x-reverie-parent-session': 'coordinator' } });
      expect(asCoordinator.statusCode).toBe(200);
      expect(asCoordinator.json().data.from.id).toBe('acct-anthropic-secondary');
      expect((await app.inject({ method: 'GET', url, headers: { 'x-reverie-parent-session': 'b' } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(403);
      expect(
        (await app.inject({ method: 'GET', url, headers: { 'x-reverie-parent-session': 'coordinator', 'x-reverie-service-token': 't' } })).statusCode
      ).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('settles the background history write, so the home can be removed cleanly', async () => {
    const service = twoPlans();
    const history = join(home, 'plan-usage-history.json');
    await service.rows(); // records a usage sample and starts a background save
    await service.settled();
    const saved = JSON.parse(readFileSync(history, 'utf8'));
    expect(saved['acct-anthropic-secondary'].at(-1).at).toBe(NOW);
    expect(readdirSync(home).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('splits the plan burn across the sessions on it', async () => {
    const history = join(home, 'plan-usage-history.json');
    // The plan rose 1.5 points an hour for 6 hours while its two sessions spent 2 and 1 work units an hour.
    const weekly = [];
    for (let t = NOW - 6 * H; t <= NOW; t += 5 * M) weekly.push({ at: t, weekly: Math.round(20 + (1.5 * (t - NOW + 6 * H)) / H), resetAt: RESET });
    writeFileSync(history, JSON.stringify({ 'acct-anthropic-secondary': weekly }));
    const costs = new PlanCostTracker(join(home, 'costs.json'));
    const samples: Record<string, { at: number; cost: number }[]> = { a: [], b: [] };
    for (let t = NOW - 6 * H; t <= NOW; t += M) {
      samples.a.push({ at: t, cost: (2 * (t - NOW + 6 * H)) / H });
      samples.b.push({ at: t, cost: (1 * (t - NOW + 6 * H)) / H });
    }
    writeFileSync(join(home, 'costs.json'), JSON.stringify(samples));
    setLatestAccountPlanUsage({
      id: 'acct-anthropic-secondary',
      label: 'secondary',
      provider: 'anthropic',
      status: 'ready',
      updatedAt: NOW,
      usage: { sevenDay: { usedPercentage: 29, resetAt: RESET } },
    });
    const dirOf = join(home, '.claude-accounts', 'secondary');
    const session = (id: string, name: string) => ({
      id,
      name,
      mode: 'claude',
      status: 'busy',
      getEnvOverridesForPersist: () => ({ CLAUDE_CONFIG_DIR: dirOf }),
    });
    const service = track(new PlanService({
      reader: {
        read: async (p: SubscriptionProfile) => ({ id: p.id, label: p.label, provider: p.provider, status: 'ready' as const, authState: 'signed-in' as const, updatedAt: NOW, usage: null }),
      },
      sessions: () => [session('a', 'Worker A'), session('b', 'Worker B')],
      coordinatorIds: () => [],
      historyFile: history,
      costs,
      home,
      now: () => NOW,
      gpu: async () => ({ available: false, utilization: null, memoryUsedMb: null, memoryTotalMb: null, models: [], lastHolder: null }),
    }));
    const row = (await service.rows()).accounts.find((r) => r.id === 'acct-anthropic-secondary')!;
    expect(row.agentBurn).not.toBeNull();
    const burn = row.agentBurn!;
    expect(burn.conversion.basis).toBe('learned');
    expect(burn.usdPerHour).toBeCloseTo(3, 1);
    expect(burn.agents.map((a) => a.name)).toEqual(['Worker A', 'Worker B']);
    expect(burn.agents[0].share).toBeCloseTo(2 / 3, 2);
    // About 0.5 points per work unit: the realtime rate lands near the plan's real 1.5 points an hour.
    expect(burn.realtimePerHour).toBeGreaterThan(1.2);
    expect(burn.realtimePerHour).toBeLessThan(1.8);
  });
});
