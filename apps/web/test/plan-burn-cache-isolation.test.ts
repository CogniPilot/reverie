import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlanService } from '../src/plan-accounts.js';
import { PlanCostTracker, burnCheck } from '../src/plan-agent-burn.js';
import { WEEK_MS } from '../src/plan-pace.js';

const H = 3_600_000;
const M = 60_000;
const NOW = Date.UTC(2026, 9, 18, 12);
const RESET = NOW + WEEK_MS / 2;
const ROOT = mkdtempSync(join(tmpdir(), 'plan-burn-isolation-'));
const services: PlanService[] = [];
afterEach(async () => {
  await Promise.all(services.map(service => service.settled()));
  rmSync(ROOT, { recursive: true, force: true });
});

it('does not reuse another PlanService instance accuracy history for the same account name', async () => {
  const make = (name: string, populated: boolean) => {
    const home = join(ROOT, name);
    const account = join(home, '.claude-accounts', 'cache-review');
    mkdirSync(account, { recursive: true });
    writeFileSync(join(account, '.credentials.json'), '{}');
    const usage = [];
    const costs = [];
    if (populated) {
      for (let at = NOW - 24 * H; at <= NOW; at += 5 * M)
        usage.push({ at, weekly: 4 + (at - NOW + 24 * H) / H, resetAt: RESET });
      for (let at = NOW - 24 * H; at <= NOW; at += M)
        costs.push({ at, cost: 2 * (at - NOW + 24 * H) / H });
    }
    const historyFile = join(home, 'usage.json');
    const costFile = join(home, 'costs.json');
    writeFileSync(historyFile, JSON.stringify({ 'acct-anthropic-cache-review': usage }));
    writeFileSync(costFile, JSON.stringify({ worker: costs }));
    const service = new PlanService({
      reader: { read: async p => ({ id: p.id, label: p.label, provider: p.provider,
        status: 'ready' as const, authState: 'signed-in' as const, updatedAt: NOW,
        usage: { sevenDay: { usedPercentage: populated ? 28 : 0, resetAt: RESET } } }) },
      sessions: () => [{ id: 'worker', name: 'Worker', mode: 'claude', status: 'idle',
        getEnvOverridesForPersist: () => ({ CLAUDE_CONFIG_DIR: account }) }],
      coordinatorIds: () => [], historyFile, costs: new PlanCostTracker(costFile), home, now: () => NOW,
    });
    services.push(service);
    return service;
  };
  const first = make('first', true);
  const second = make('second', false);
  const firstRow = (await first.rows()).accounts.find(row => row.id === 'acct-anthropic-cache-review')!;
  expect(firstRow.agentBurn?.burnCheck?.n).toBeGreaterThan(0);
  expect(burnCheck({ provider: 'anthropic', label: 'cache-review', usage: [{ at: NOW, weekly: 0, resetAt: RESET }],
    sessionCosts: [[]], weekReset: RESET, now: NOW })).toBeNull();
  const secondRow = (await second.rows()).accounts.find(row => row.id === 'acct-anthropic-cache-review')!;
  expect(secondRow.agentBurn?.burnCheck).toBeNull();
});
