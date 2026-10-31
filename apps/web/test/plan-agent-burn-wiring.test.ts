/**
 * Per-agent plan burn wiring: the status-telemetry route offers each known session's cumulative cost to the tracker, and
 * the Plans rows carry each Claude plan's per-agent burn from those samples and the plan's weekly history.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRouteTestHarness, type RouteTestHarness } from './routes/_route-test-utils.js';
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

  beforeEach(() => {
    rmSync(join(getDataDir(), 'subscription-profiles.json'), { force: true });
    home = mkdtempSync(join(tmpdir(), 'plans-agent-burn-'));
    process.env.HOME = home;
    mkdirSync(join(home, '.claude-accounts', 'secondary'), { recursive: true });
    writeFileSync(join(home, '.claude-accounts', 'secondary', '.credentials.json'), '{}');
    resetLatestAccountPlanUsage();
  });

  afterEach(() => {
    process.env.HOME = savedHome;
    resetLatestAccountPlanUsage();
    rmSync(home, { recursive: true, force: true });
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
    const service = new PlanService({
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
    });
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
