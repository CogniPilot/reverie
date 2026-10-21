/**
 * A session without a subscription profile that runs on another account through its CLAUDE_CONFIG_DIR override reports into THAT
 * account's series. Before this, every profile-less session wrote into anthropic-default, so two logins alternated in one series.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRouteTestHarness, type RouteTestHarness } from './routes/_route-test-utils.js';
import { registerStatusTelemetryRoutes } from '../src/web/routes/status-telemetry-routes.js';
import { getLatestAccountPlanUsage, resetLatestAccountPlanUsage } from '../src/web/plan-usage-latest.js';

const mocks = vi.hoisted(() => ({
  catalogue: [
    { id: 'anthropic-default', label: 'Default Claude', provider: 'anthropic', isDefault: true, realDir: '/home/.claude' },
    { id: 'anthropic-00000003', label: 'claude tertiary', provider: 'anthropic', isDefault: false, realDir: '/acct/tertiary' },
  ],
}));
vi.mock('../src/plan-accounts.js', async (importActual) => ({
  ...(await importActual<typeof import('../src/plan-accounts.js')>()),
  planCatalogue: async () => mocks.catalogue, // the real accountForSession does the lookup
}));

const report = (weekly: number) => ({ rate_limits: { seven_day: { used_percentage: weekly, resets_at: 1781827200 } } });

describe('status telemetry attribution by config dir', () => {
  let h: RouteTestHarness;
  const sessions = () => h.ctx.sessions as unknown as Map<string, unknown>;
  const add = (id: string, env?: Record<string, string>) =>
    sessions().set(id, { id, name: id, mode: 'claude', noteReportedModel: () => {}, getEnvOverridesForPersist: () => env });
  const post = (sessionId: string, weekly: number) =>
    h.app.inject({ method: 'POST', url: '/api/status-telemetry', payload: { sessionId, data: report(weekly) } });

  beforeEach(async () => {
    resetLatestAccountPlanUsage();
    h = await createRouteTestHarness(registerStatusTelemetryRoutes, { sessionId: 'reviewer' });
  });

  it('files a relocated session under its own account and leaves the default series alone', async () => {
    add('coordinator', { CLAUDE_CONFIG_DIR: '/acct/tertiary' });
    add('planner');
    await post('planner', 62);
    await post('coordinator', 27);
    expect(getLatestAccountPlanUsage('anthropic-default')?.usage?.sevenDay?.usedPercentage).toBe(62);
    expect(getLatestAccountPlanUsage('anthropic-00000003')?.usage?.sevenDay?.usedPercentage).toBe(27);
  });

  it('a session with no override still reports to the default account', async () => {
    add('planner');
    await post('planner', 61);
    expect(getLatestAccountPlanUsage('anthropic-default')?.usage?.sevenDay?.usedPercentage).toBe(61);
  });

  it('an override that resolves to the default directory reports to the default account', async () => {
    add('planner', { CLAUDE_CONFIG_DIR: '/home/.claude' });
    await post('planner', 60);
    expect(getLatestAccountPlanUsage('anthropic-default')?.usage?.sevenDay?.usedPercentage).toBe(60);
  });

  it('an override that matches no account is filed under no account, still broadcasts, and warns once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    add('newbie', { CLAUDE_CONFIG_DIR: '/acct/not-yet-known' });
    await post('newbie', 33);
    await post('newbie', 34);
    expect(getLatestAccountPlanUsage('anthropic-default')).toBeUndefined();
    expect(getLatestAccountPlanUsage('anthropic-00000003')).toBeUndefined();
    expect((h.ctx.broadcast as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === 'session:statusTelemetry' || c[1]?.sessionId === 'newbie')).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
