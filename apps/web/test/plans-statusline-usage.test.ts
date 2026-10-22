/**
 * Plans for Claude accounts: usage comes from the numbers Claude Code's own status line reports
 * (newest report on the account), marked stale after 30 minutes; after a restart the last saved
 * weekly sample seeds the card, labelled with its as-of time. Nothing is fetched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlanService, USAGE_STALE_MS } from '../src/plan-accounts.js';
import { WEEK_MS } from '../src/plan-pace.js';
import { getDataDir } from '../src/config/instance.js';
import {
  getLatestAccountPlanUsage,
  resetLatestAccountPlanUsage,
  setLatestAccountPlanUsage,
} from '../src/web/plan-usage-latest.js';
import type { SubscriptionProfile } from '../src/subscription-profiles.js';

const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
const RESET = NOW + WEEK_MS / 2;

describe('Plans Claude usage from the status line', () => {
  let home: string;
  let history: string;
  const savedHome = process.env.HOME;
  let clock = NOW;

  const service = () =>
    new PlanService({
      reader: {
        // Same as the live reader: signed in, no usage of its own.
        read: async (p: SubscriptionProfile) => ({
          id: p.id,
          label: p.label,
          provider: p.provider,
          status: 'ready' as const,
          updatedAt: clock,
          usage: null,
        }),
      },
      sessions: () => [],
      coordinatorIds: () => [],
      historyFile: history,
      home,
      now: () => clock,
      gpu: async () => ({
        available: false,
        utilization: null,
        memoryUsedMb: null,
        memoryTotalMb: null,
        models: [],
        lastHolder: null,
      }),
    });

  const report = (at: number, week = 42, five = 11) =>
    setLatestAccountPlanUsage({
      id: 'acct-anthropic-secondary',
      label: 'secondary',
      provider: 'anthropic',
      status: 'ready',
      updatedAt: at,
      usage: {
        fiveHour: { usedPercentage: five, resetAt: at + 3600_000 },
        sevenDay: { usedPercentage: week, resetAt: RESET },
      },
    });

  const secondary = async () => (await service().rows()).accounts.find((r) => r.id === 'acct-anthropic-secondary')!;

  beforeEach(() => {
    rmSync(join(getDataDir(), 'subscription-profiles.json'), { force: true });
    home = mkdtempSync(join(tmpdir(), 'plans-sl-'));
    process.env.HOME = home;
    mkdirSync(join(home, '.claude-accounts', 'secondary'), { recursive: true });
    writeFileSync(join(home, '.claude-accounts', 'secondary', '.credentials.json'), '{}');
    history = join(home, 'plan-usage-history.json');
    clock = NOW;
    resetLatestAccountPlanUsage();
  });

  afterEach(() => {
    process.env.HOME = savedHome;
    resetLatestAccountPlanUsage();
    rmSync(home, { recursive: true, force: true });
  });

  it('shows the status-line sample on the account row', async () => {
    report(NOW - 60_000);
    const row = await secondary();
    expect(row.usageSource).toBe('statusline');
    expect(row.usageAsOf).toBe(NOW - 60_000);
    expect(row.usageStale).toBe(false);
    expect(row.pace.weekly).toBe(42);
    expect(row.pace.fiveHour).toBe(11);
    expect(row.pace.weekReset).toBe(RESET);
  });

  it('marks the numbers stale after 30 minutes but keeps them with their as-of time', async () => {
    report(NOW - USAGE_STALE_MS - 1000);
    const row = await secondary();
    expect(row.usageStale).toBe(true);
    expect(row.usageAsOf).toBe(NOW - USAGE_STALE_MS - 1000);
    expect(row.pace.weekly).toBe(42);
  });

  it('a newer report replaces an older one; an older one never replaces a newer one', () => {
    report(NOW - 5000, 50);
    report(NOW - 9000, 10);
    expect(getLatestAccountPlanUsage('acct-anthropic-secondary')?.usage?.sevenDay?.usedPercentage).toBe(50);
  });

  it('saves each reading with its own reset, and a restart keeps the period instead of blanking it', async () => {
    report(NOW - 60_000);
    await secondary();
    // The history is written in the background.
    await vi.waitFor(() => expect(existsSync(history)).toBe(true));
    const saved = JSON.parse(readFileSync(history, 'utf8'))['acct-anthropic-secondary'];
    expect(saved.at(-1).resetAt).toBe(RESET);
    resetLatestAccountPlanUsage();
    clock = NOW + 3600_000;
    const row = await secondary();
    expect(row.usageSource).toBe('history');
    expect(row.pace.weekReset).toBe(RESET);
    expect(row.pace.weekStart).toBe(RESET - WEEK_MS);
    expect(row.pace.hoursToReset).toBeGreaterThan(0);
  });

  it('does not invent a reset when the saved one has already passed', async () => {
    writeFileSync(history, JSON.stringify({ 'acct-anthropic-secondary': [{ at: NOW - 3 * 3600_000, weekly: 37, resetAt: NOW - 1000 }] }));
    const row = await secondary();
    expect(row.pace.weekReset).toBeNull();
  });

  it('after a restart seeds the weekly figure from the last saved sample, labelled with its time', async () => {
    writeFileSync(history, JSON.stringify({ 'acct-anthropic-secondary': [{ at: NOW - 3 * 3600_000, weekly: 37 }] }));
    const row = await secondary();
    expect(row.usageSource).toBe('history');
    expect(row.usageAsOf).toBe(NOW - 3 * 3600_000);
    expect(row.usageStale).toBe(true);
    expect(row.pace.weekly).toBe(37);
    expect(row.pace.fiveHour).toBeNull();
  });

  it('a seeded sample is not written back as a fresh one', async () => {
    const saved = [{ at: NOW - 3 * 3600_000, weekly: 37 }];
    writeFileSync(history, JSON.stringify({ 'acct-anthropic-secondary': saved }));
    const svc = service();
    await svc.rows();
    expect((await svc.usageHistory())['acct-anthropic-secondary']).toEqual(saved);
  });

  it('shows no data, not an error, before any report or sample', async () => {
    const row = await secondary();
    expect(row.usageSource).toBeNull();
    expect(row.usageAsOf).toBeNull();
    expect(row.pace.weekly).toBeNull();
    expect(row.signedIn).toBe(true);
  });
});
