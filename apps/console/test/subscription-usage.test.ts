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
  const configDir = await fs.mkdtemp(join(tmpdir(), 'codeman-subscription-'));
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
  it('never reads the Claude login or contacts Anthropic; the row is unknown until Claude Code reports', async () => {
    const p = await profile('claude');
    await credential(p, 'secret-token');
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    try {
      const reading = await new SubscriptionUsageReader('test').read(p);
      expect(reading).toMatchObject({ status: 'ready', usage: null });
      expect(JSON.stringify(reading)).not.toContain('secret-token');
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('detects a login immediately even if a signed-out reading was cached', async () => {
    const a = await profile('new');
    const reader = new SubscriptionUsageReader('test');
    expect((await reader.read(a)).status).toBe('signed-out');
    await credential(a, 'new-token');
    expect((await reader.read(a)).status).toBe('ready');
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
