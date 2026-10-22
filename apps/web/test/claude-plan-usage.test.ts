import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseClaudePlanUsage, readClaudePlanUsage } from '../src/claude-plan-usage.js';
import { SubscriptionUsageReader } from '../src/subscription-usage.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
const windows = { five_hour: { utilization: 12, resets_at: '2026-11-01T12:00:00Z' }, seven_day: { utilization: 34, resets_at: '2026-11-07T12:00:00Z' } };
async function login(extra = {}) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'claude-quota-')); dirs.push(dir);
  await fs.writeFile(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'synthetic-private-token', expiresAt: Date.now() + 3600_000, scopes: ['user:profile'], ...extra } }));
  return dir;
}

describe('Claude read-only quota adapter', () => {
  it('uses only the selected account and a bounded GET to the fixed endpoint; returns only quota fields', async () => {
    const dir = await login();
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ...windows, email: 'private@example.invalid', accessToken: 'private-provider-value' })));
    vi.stubGlobal('fetch', fetcher);
    const result = await readClaudePlanUsage(dir);
    expect(result.usage).toEqual({ fiveHour: { usedPercentage: 12, resetAt: Date.parse(windows.five_hour.resets_at) }, sevenDay: { usedPercentage: 34, resetAt: Date.parse(windows.seven_day.resets_at) } });
    const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/api/oauth/usage');
    expect(options).toMatchObject({ method: 'GET', redirect: 'error', headers: { Authorization: 'Bearer synthetic-private-token' } });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(result)).not.toMatch(/private|token|email/);
  });
  it.each([401, 403, 429, 500])('HTTP %s returns a fixed actionable error without consuming private body', async status => {
    const dir = await login();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('secret-account-body', { status })));
    const result = await readClaudePlanUsage(dir);
    expect(result.usage).toBeNull();
    expect(result.usageError).toMatch(status === 401 || status === 403 ? /Sign in again/ : /five minutes/);
    expect(JSON.stringify(result)).not.toContain('secret');
  });
  it.each([{ expiresAt: 1 }, { accessToken: '' }, { scopes: ['user:inference'] }])('invalid or expired OAuth never makes a network request: %j', async extra => {
    const dir = await login(extra); const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    expect((await readClaudePlanUsage(dir)).usageError).toMatch(/Sign in again/);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects malformed, oversized and failed responses without exposing exceptions', async () => {
    const dir = await login();
    for (const body of ['not-json', '{}', 'x'.repeat(65 * 1024)]) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(body)));
      expect((await readClaudePlanUsage(dir)).usage).toBeNull();
    }
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('synthetic-private-token'); }));
    expect(JSON.stringify(await readClaudePlanUsage(dir))).not.toContain('synthetic-private-token');
  });
  it('coalesces concurrent reads and caches success and failures for five minutes', async () => {
    const configDir = await login();
    const profile = { id: 'one', label: 'one', provider: 'anthropic' as const, configDir, openCodeDataDir: join(configDir, 'opencode') };
    const fetcher = vi.fn(async () => new Response(JSON.stringify(windows)));
    vi.stubGlobal('fetch', fetcher);
    const reader = new SubscriptionUsageReader('test', async () => 'signed-in');
    await Promise.all([reader.read(profile), reader.read(profile)]);
    await reader.read(profile);
    expect(fetcher).toHaveBeenCalledOnce();
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 300_001);
    fetcher.mockImplementation(async () => new Response('private', { status: 429 }));
    expect((await reader.read(profile)).usageError).toMatch(/rate limited/);
    await reader.read(profile);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('validates windows, clamps percentages, and keeps a valid zero usage window', () => {
    expect(parseClaudePlanUsage({ five_hour: { utilization: 0, resets_at: windows.five_hour.resets_at } })?.fiveHour?.usedPercentage).toBe(0);
    expect(parseClaudePlanUsage({ ...windows, five_hour: { ...windows.five_hour, utilization: 120 } })?.fiveHour?.usedPercentage).toBe(100);
    expect(parseClaudePlanUsage({ five_hour: { utilization: 1, resets_at: 'invalid' } })).toBeNull();
    expect(parseClaudePlanUsage(null)).toBeNull();
  });
});
