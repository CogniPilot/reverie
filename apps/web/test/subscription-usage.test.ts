import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SubscriptionUsageReader } from '../src/subscription-usage.js';
import {
  getLatestPlanUsage,
  setLatestAccountPlanUsage,
  setLatestCodexPlanUsage,
} from '../src/web/plan-usage-latest.js';
import type { SubscriptionProfile } from '../src/subscription-profiles.js';

const owned: string[] = [];
afterEach(async () => {
  for (const dir of owned.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
async function profile(id: string): Promise<SubscriptionProfile> {
  const configDir = await fs.mkdtemp(join(tmpdir(), 'reverie-subscription-'));
  owned.push(configDir);
  return { id, label: id, provider: 'anthropic', configDir, openCodeDataDir: join(configDir, 'oc') };
}
async function credential(p: SubscriptionProfile, token: string): Promise<void> {
  await fs.writeFile(
    join(p.configDir, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt: Date.now() + 60_000 } })
  );
}

describe('per-subscription usage', () => {
  it('reads Claude quota metadata immediately after sign-in without exposing credentials', async () => {
    const p = await profile('claude');
    await credential(p, 'secret-token');
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ five_hour: { utilization: 12, resets_at: '2026-10-22T12:00:00Z' }, seven_day: { utilization: 34, resets_at: '2026-10-28T12:00:00Z' } })));
    vi.stubGlobal('fetch', fetcher);
    try {
      const reading = await new SubscriptionUsageReader('test', async () => 'signed-in').read(p);
      expect(reading).toMatchObject({ status: 'ready', authState: 'signed-in', usage: { fiveHour: { usedPercentage: 12 }, sevenDay: { usedPercentage: 34 } } });
      expect(JSON.stringify(reading)).not.toContain('secret-token');
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('detects a login immediately even if a signed-out reading was cached', async () => {
    const a = await profile('new');
    const reader = new SubscriptionUsageReader('test', async () => 'signed-in');
    expect((await reader.read(a)).status).toBe('signed-out');
    await credential(a, 'new-token');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ five_hour: { utilization: 0, resets_at: '2026-10-22T12:00:00Z' } }))));
    try { expect((await reader.read(a)).status).toBe('ready'); } finally { vi.unstubAllGlobals(); }
  });
  it('keeps authentication errors and signed-out state separate from absent usage', async () => {
    const p = await profile('expired');
    await credential(p, 'not-a-working-login');
    for (const state of ['signed-out', 'unavailable', 'error'] as const) {
      const reading = await new SubscriptionUsageReader('test', async () => state).read(p);
      expect(reading.authState).toBe(state);
      expect(reading.usage).toBeNull();
    }
  });
  it('keeps other accounts and a newer successful reading when a stale polling failure arrives', () => {
    const base = {
      provider: 'anthropic' as const,
      label: '<unsafe>',
      status: 'ready' as const,
      usage: { fiveHour: { usedPercentage: 10, resetAt: 1000 } },
    };
    setLatestAccountPlanUsage({ ...base, id: 'first', updatedAt: 200 });
    setLatestAccountPlanUsage({
      ...base,
      id: 'second',
      updatedAt: 200,
      usage: { sevenDay: { usedPercentage: 80, resetAt: 1000 } },
    });
    setLatestAccountPlanUsage({ ...base, id: 'first', updatedAt: 100, status: 'unavailable', usage: null });
    setLatestCodexPlanUsage(null);
    expect(getLatestPlanUsage()?.accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'first', usage: base.usage }),
        expect.objectContaining({ id: 'second', usage: { sevenDay: { usedPercentage: 80, resetAt: 1000 } } }),
      ])
    );
  });
});
