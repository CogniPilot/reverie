/**
 * Per-agent plan burn: session cost rates, the work-unit to plan-percent conversion (prior by provider and tier, learned
 * from the plan's own readings), the realtime plan rate and the plan-move impact, with time as a parameter.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addCostSample,
  conversionFit,
  costRate,
  costUsed,
  COST_HISTORY_MS,
  moveImpact,
  planAgentBurn,
  planConversion,
  planTier,
  PlanCostTracker,
  priorConversion,
  type CostSample,
} from '../src/plan-agent-burn.js';
import { WEEK_MS, type UsageSample } from '../src/plan-pace.js';

const M = 60 * 1000;
const H = 60 * M;
const RESET = Date.UTC(2026, 10, 3, 0, 0, 0);
const NOW = RESET - 3 * 24 * H;

/** A session spending `usdPerHour` steadily over [from, to], one reading a minute. */
function spend(usdPerHour: number, from: number, to: number, start = 0): CostSample[] {
  const out: CostSample[] = [];
  for (let t = from; t <= to; t += M) out.push({ at: t, cost: start + (usdPerHour * (t - from)) / H });
  return out;
}

/** Weekly readings every 5 minutes rising `pctPerHour`, rounded to whole percents like the providers report them. */
function weekly(pctPerHour: number, from: number, to: number, start = 20): UsageSample[] {
  const out: UsageSample[] = [];
  for (let t = from; t <= to; t += 5 * M) out.push({ at: t, weekly: Math.round(start + (pctPerHour * (t - from)) / H), resetAt: RESET });
  return out;
}

describe('cost samples', () => {
  it('keeps one reading a minute and drops readings past the retention', () => {
    let s: CostSample[] = [];
    s = addCostSample(s, { at: NOW, cost: 1 });
    s = addCostSample(s, { at: NOW + 20 * 1000, cost: 1.2 });
    expect(s).toEqual([{ at: NOW + 20 * 1000, cost: 1.2 }]);
    s = addCostSample(s, { at: NOW + 2 * M, cost: 1.5 });
    expect(s).toHaveLength(2);
    s = addCostSample(s, { at: NOW + COST_HISTORY_MS + 3 * M, cost: 9 });
    expect(s).toEqual([{ at: NOW + COST_HISTORY_MS + 3 * M, cost: 9 }]);
  });

  it('rates a session from its last 30 minutes, treating a fall as a restart and silence as idle', () => {
    const steady = spend(6, NOW - 2 * H, NOW);
    expect(costRate(steady, NOW)).toBeCloseTo(6, 2);
    // Fast for the last half hour only: the 30-minute rate follows it at once.
    const burst = [...spend(1, NOW - 2 * H, NOW - 30 * M), ...spend(12, NOW - 29 * M, NOW, 1.5)];
    expect(costRate(burst, NOW)).toBeCloseTo(12, 0);
    // A restart (cost back near zero) keeps only the run after it.
    const restarted = [...spend(5, NOW - 40 * M, NOW - 20 * M, 30), ...spend(5, NOW - 19 * M, NOW, 0)];
    expect(costRate(restarted, NOW)).toBeCloseTo(5, 1);
    expect(costRate(spend(5, NOW - 3 * H, NOW - 2 * H), NOW)).toBe(0);
    expect(costRate([{ at: NOW - M, cost: 2 }, { at: NOW, cost: 2.1 }], NOW)).toBeNull();
  });

  it('adds up cost across a restart, counting the new total from zero', () => {
    const s = [{ at: NOW, cost: 4 }, { at: NOW + M, cost: 5 }, { at: NOW + 2 * M, cost: 0.5 }, { at: NOW + 3 * M, cost: 1 }];
    expect(costUsed(s, NOW, NOW + 3 * M)).toBeCloseTo(2, 6);
  });
});

describe('conversion from work units to plan percent', () => {
  it('reads the tier from the plan label', () => {
    expect(planTier('Codex 20x')).toBe('20x');
    expect(planTier('Claude Max 5x')).toBe('5x');
    expect(planTier('Claude Max')).toBe('5x');
    expect(planTier('ChatGPT Plus')).toBe('1x');
    expect(planTier('Claude Team')).toBeNull();
  });

  it('starts from the provider and tier prior, a 20x plan burning a quarter as fast per unit as a 5x', () => {
    const five = planConversion({ provider: 'openai', label: 'Codex 5x', usage: [], sessionCosts: [], now: NOW, weekReset: RESET });
    const twenty = planConversion({ provider: 'openai', label: 'Codex 20x', usage: [], sessionCosts: [], now: NOW, weekReset: RESET });
    expect(five.basis).toBe('prior');
    expect(five.pctPerUsd / twenty.pctPerUsd).toBeCloseTo(4, 3);
    expect(five.low).toBeLessThan(five.pctPerUsd);
    expect(five.high).toBeGreaterThan(five.pctPerUsd);
    const unknown = priorConversion('anthropic', null);
    expect(unknown.logSd).toBeGreaterThan(priorConversion('anthropic', '5x').logSd);
  });

  it('learns the plan factor from its own readings and narrows the band', () => {
    // The plan actually rises 0.5 points per work unit: 3 units an hour give 1.5 points an hour.
    const usage = weekly(1.5, NOW - 6 * H, NOW);
    const costs = [spend(3, NOW - 6 * H, NOW)];
    const learned = planConversion({ provider: 'anthropic', label: 'Claude Team', usage, sessionCosts: costs, now: NOW, weekReset: RESET });
    const prior = planConversion({ provider: 'anthropic', label: 'Claude Team', usage: [], sessionCosts: [], now: NOW, weekReset: RESET });
    expect(learned.basis).toBe('learned');
    expect(learned.pctPerUsd).toBeGreaterThan(0.4);
    expect(learned.pctPerUsd).toBeLessThan(0.6);
    expect(learned.high / learned.low).toBeLessThan(prior.high / prior.low);
  });

  it('ignores readings from another weekly period and too little rise', () => {
    const other = weekly(1.5, NOW - 6 * H, NOW).map((s) => ({ ...s, resetAt: RESET + WEEK_MS }));
    const costs = [spend(3, NOW - 6 * H, NOW)];
    expect(planConversion({ provider: 'anthropic', label: 'x', usage: other, sessionCosts: costs, now: NOW, weekReset: RESET }).basis).toBe('prior');
    const flat = weekly(0.1, NOW - 6 * H, NOW);
    expect(planConversion({ provider: 'anthropic', label: 'x', usage: flat, sessionCosts: costs, now: NOW, weekReset: RESET }).basis).toBe('prior');
  });
});

describe('conversion fit against the plan readings', () => {
  it('is close to zero error when the factor explains the plan rise', () => {
    const usage = weekly(1.5, NOW - 6 * H, NOW);
    const costs = [spend(3, NOW - 6 * H, NOW)];
    const fit = conversionFit(usage, costs, 0.5, NOW, RESET)!;
    expect(fit.n).toBe(6);
    expect(Math.abs(fit.biasPerHour)).toBeLessThan(0.3);
    expect(fit.maePerHour).toBeLessThan(0.6);
  });

  it('shows a negative bias when the plan rises faster than its reporting sessions explain', () => {
    // The plan rises 3 points an hour but its reporting sessions only explain 1.5 (other, unreported usage).
    const fit = conversionFit(weekly(3, NOW - 6 * H, NOW), [spend(3, NOW - 6 * H, NOW)], 0.5, NOW, RESET)!;
    expect(fit.biasPerHour).toBeLessThan(-1);
    expect(fit.maePerHour).toBeGreaterThan(1);
  });

  it('is null without an hour that has two readings', () => {
    expect(conversionFit([], [], 0.5, NOW, RESET)).toBeNull();
    expect(conversionFit([{ at: NOW, weekly: 3, resetAt: RESET }], [], 0.5, NOW, RESET)).toBeNull();
  });
});

describe('per-agent burn', () => {
  it('splits the plan rate across its sessions by their cost in the last 30 minutes', () => {
    const usage = weekly(2, NOW - 6 * H, NOW);
    const busy = spend(3, NOW - 6 * H, NOW);
    const light = spend(1, NOW - 6 * H, NOW);
    const idle = spend(2, NOW - 6 * H, NOW - 2 * H);
    const burn = planAgentBurn({
      provider: 'anthropic',
      label: 'Claude Team',
      usage,
      sessions: [{ id: 'b', name: 'Busy', costs: busy }, { id: 'l', name: 'Light', costs: light }, { id: 'i', name: 'Idle', costs: idle }],
      weekReset: RESET,
      now: NOW,
    });
    expect(burn.usdPerHour).toBeCloseTo(4, 2);
    expect(burn.agents.map((a) => a.name)).toEqual(['Busy', 'Light', 'Idle']);
    expect(burn.agents[0].share).toBeCloseTo(0.75, 2);
    expect(burn.agents[2].usdPerHour).toBe(0);
    // The realtime rate reflects the current mix: the idle session's earlier spend is in the conversion, not the rate.
    expect(burn.realtimePerHour).toBeCloseTo(burn.usdPerHour * burn.conversion.pctPerUsd, 1);
    expect(burn.realtimeLow).toBeLessThanOrEqual(burn.realtimePerHour);
    expect(burn.realtimeHigh).toBeGreaterThanOrEqual(burn.realtimePerHour);
    expect(burn.agents.reduce((sum, a) => sum + (a.pctPerHour ?? 0), 0)).toBeCloseTo(burn.realtimePerHour, 1);
    expect(burn.fit?.n).toBe(6);
  });
});

describe('plan-move impact', () => {
  const conv = (pctPerUsd: number, spread = 1.5) => ({ pctPerUsd, low: pctPerUsd / spread, high: pctPerUsd * spread, basis: 'prior' as const, tier: null });

  it('converts the moved work with the leaving and the joining plan factors', () => {
    const impact = moveImpact({
      usdPerHour: 4,
      from: { used: 60, rate: 3, conversion: conv(0.5), budgetStop: NOW + 10 * H },
      to: { used: 20, rate: 0.5, conversion: conv(0.125), budgetStop: NOW + 10 * H },
      now: NOW,
    });
    // Leaving: 3 - 4×0.5 = 1 %/h for 10 h → 70 instead of 90. Joining: 0.5 + 4×0.125 = 1 %/h → 30 instead of 25.
    expect(impact.left.rateAfter).toBeCloseTo(1, 6);
    expect(impact.left.endNow).toBe(90);
    expect(impact.left.endAfter).toBe(70);
    expect(impact.joined.rateAfter).toBeCloseTo(1, 6);
    expect(impact.joined.endNow).toBe(25);
    expect(impact.joined.endAfter).toBe(30);
    expect(impact.joined.endAfterLow!).toBeLessThan(30);
    expect(impact.joined.endAfterHigh!).toBeGreaterThan(30);
    expect(impact.left.endAfterLow!).toBeLessThan(70);
    expect(impact.left.endAfterHigh!).toBeGreaterThan(70);
  });

  it('caps at 100, reports the run-out time and never lets the plan left go below zero burn', () => {
    const impact = moveImpact({
      usdPerHour: 10,
      from: { used: 50, rate: 1, conversion: conv(0.5), budgetStop: NOW + 10 * H },
      to: { used: 90, rate: 1, conversion: conv(0.5), budgetStop: NOW + 10 * H },
      now: NOW,
    });
    expect(impact.left.rateAfter).toBe(0);
    expect(impact.joined.endAfter).toBe(100);
    expect(impact.joined.runsOutAfter).toBe(NOW + (10 / 6) * H);
  });
});

describe('PlanCostTracker', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('records valid cost reports, persists them, and ignores the rest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plan-cost-'));
    dirs.push(dir);
    let now = NOW;
    const file = join(dir, 'plan-agent-cost-history.json');
    const tracker = new PlanCostTracker(file, () => now);
    await tracker.record('s1', 1.25);
    await tracker.record('s1', 'x');
    await tracker.record('s1', -1);
    await tracker.record('s1', Number.NaN);
    await tracker.record('', 2);
    now += 2 * M;
    await tracker.record('s1', 1.5);
    await tracker.flushed();
    expect(await tracker.costs('s1')).toEqual([{ at: NOW, cost: 1.25 }, { at: NOW + 2 * M, cost: 1.5 }]);
    expect(await tracker.costs('none')).toEqual([]);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved.s1.length).toBeGreaterThanOrEqual(1);
    const reloaded = new PlanCostTracker(file, () => now);
    expect((await reloaded.snapshot()).s1.length).toBe(saved.s1.length);
  });
});
