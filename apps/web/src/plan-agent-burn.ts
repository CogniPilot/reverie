/**
 * @fileoverview Per-agent plan burn: how much of a plan each session is using right now, a plan rate that follows them
 * within minutes, and what moving one session to another plan would do to both plans.
 *
 * Claude Code's status line reports each session's cumulative API-equivalent cost (`cost.total_cost_usd`) after every
 * assistant message. Those reports are kept as per-session cost samples (`PlanCostTracker`). A plan's weekly percent rises
 * roughly in proportion to the cost of the sessions on it, so:
 *
 * - agent cost rate: USD per hour, the least-squares slope of one session's cost over the last 30 minutes;
 * - plan conversion: weekly points per USD, the plan's weekly rise over the summed cost rise of its sessions over the
 *   same 6-hour window `plan-pace.ts` uses for its steady rate;
 * - agent burn = conversion × agent cost rate, and the realtime plan rate is their sum.
 *
 * Pure apart from `PlanCostTracker`'s file IO; time is always a parameter. See docs/plan-burn-per-agent.md.
 */
import { promises as fs } from 'node:fs';
import { BURN_WINDOW_MS, WEEK_MS, type UsageSample } from './plan-pace.js';

export interface CostSample {
  at: number;
  /** Cumulative USD the session has reported since its process started; a drop means it restarted. */
  cost: number;
}

/** Agent cost rates look this far back, so a session that starts or stops working shows within minutes. */
export const AGENT_RATE_WINDOW_MS = 30 * 60 * 1000;
/** Readings closer together than this cannot give an hourly rate. */
export const AGENT_RATE_MIN_SPAN_MS = 10 * 60 * 1000;
/** Kept long enough for a day of accuracy checks against the weekly readings. */
export const COST_HISTORY_MS = 26 * 3600 * 1000;
/** At most one sample per session per minute. */
export const COST_SAMPLE_MS = 60 * 1000;
/** A conversion needs at least this much weekly rise and cost, so rounding in either cannot dominate it. */
export const MIN_CONVERSION_POINTS = 2;
export const MIN_CONVERSION_USD = 1;
const SAME_RESET_MS = 5 * 60 * 1000;
const HOUR_MS = 3600 * 1000;

const round = (n: number, places: number): number => Math.round(n * 10 ** places) / 10 ** places;

/** Append one reading: one per minute (the newest in a minute replaces the last), older than the retention dropped. */
export function addCostSample(samples: CostSample[], sample: CostSample): CostSample[] {
  const kept = samples.filter((s) => s.at > sample.at - COST_HISTORY_MS && s.at <= sample.at);
  const last = kept[kept.length - 1];
  if (last && sample.at - last.at < COST_SAMPLE_MS) kept[kept.length - 1] = sample;
  else kept.push(sample);
  return kept;
}

/** The readings in [from, now] after the last restart (a fall in cumulative cost), in time order. */
function lastRun(samples: CostSample[], from: number, now: number): CostSample[] {
  const inside = samples.filter((s) => s.at >= from && s.at <= now && Number.isFinite(s.cost)).sort((a, b) => a.at - b.at);
  let start = 0;
  for (let i = 1; i < inside.length; i++) if (inside[i].cost < inside[i - 1].cost) start = i;
  return inside.slice(start);
}

/** USD per hour over the last `windowMs`, or null without two readings far enough apart (no report at all is 0: idle). */
export function costRate(samples: CostSample[], now: number, windowMs = AGENT_RATE_WINDOW_MS): number | null {
  const run = lastRun(samples, now - windowMs, now);
  if (run.length === 0) return 0;
  if (run.length < 2) return null;
  if (run[run.length - 1].at - run[0].at < AGENT_RATE_MIN_SPAN_MS) return null;
  const t0 = run[0].at;
  const meanX = run.reduce((sum, s) => sum + (s.at - t0), 0) / run.length;
  const meanY = run.reduce((sum, s) => sum + s.cost, 0) / run.length;
  let num = 0;
  let den = 0;
  for (const s of run) {
    num += (s.at - t0 - meanX) * (s.cost - meanY);
    den += (s.at - t0 - meanX) ** 2;
  }
  return den === 0 ? null : round(Math.max(0, (num / den) * HOUR_MS), 3);
}

/** USD a session used in [from, to]: the sum of its rises, counting a restart's new total from zero. */
export function costUsed(samples: CostSample[], from: number, to: number): number {
  const inside = samples.filter((s) => s.at >= from && s.at <= to && Number.isFinite(s.cost)).sort((a, b) => a.at - b.at);
  let used = 0;
  for (let i = 1; i < inside.length; i++) {
    const rise = inside[i].cost - inside[i - 1].cost;
    used += rise >= 0 ? rise : inside[i].cost;
  }
  return used;
}

export type PlanTier = '1x' | '5x' | '20x';

/**
 * The tier a plan's label names (`20x`, `5x`; `Pro`/`Plus` are the 1x tiers, a bare `Max` is 5x), or null. Profiles carry
 * no tier field yet, so an unnamed tier keeps the wider prior below.
 */
export function planTier(label: string): PlanTier | null {
  const l = label.toLowerCase();
  if (/\b20\s?x\b/.test(l)) return '20x';
  if (/\b5\s?x\b/.test(l) || /\bmax\b/.test(l)) return '5x';
  if (/\b(pro|plus)\b/.test(l)) return '1x';
  return null;
}

/**
 * Prior weekly points per work unit (USD of API-equivalent cost) for a 1x plan, by provider. These are guesses: a 1x plan
 * spending about 100 USD-equivalent a week. Larger tiers divide by their multiple. Every plan's own readings replace them as
 * data comes in (`planConversion`).
 */
export const PRIOR_PCT_PER_USD_1X: Record<string, number> = { anthropic: 1, openai: 1 };
const TIER_MULTIPLE: Record<PlanTier, number> = { '1x': 1, '5x': 5, '20x': 20 };
/** Prior spread in log space: a known tier is trusted to a factor of 3, an unknown one spans 1x to 20x around 5x. */
const PRIOR_LOG_SD_KNOWN = Math.log(3);
const PRIOR_LOG_SD_UNKNOWN = Math.log(4.5);
/** Model spread of one observation beyond rounding: usage is not exactly proportional to cost (cache, model mix). */
const OBSERVATION_LOG_SD = 0.25;
/** Providers report whole weekly percents, so a rise read from two readings is uncertain by about 0.7 points. */
const RISE_SD_POINTS = 0.7;

export interface PlanConversion {
  /** Weekly points per work unit (USD), the posterior median. */
  pctPerUsd: number;
  /** About a one-sigma band: the posterior median divided and multiplied by its spread. */
  low: number;
  high: number;
  /** 'prior' until the plan's own readings give an observation, then 'learned'. */
  basis: 'prior' | 'learned';
  tier: PlanTier | null;
}

/** The prior for a plan from its provider and tier. */
export function priorConversion(provider: string, tier: PlanTier | null): { logMean: number; logSd: number } {
  const base = PRIOR_PCT_PER_USD_1X[provider] ?? 1;
  const multiple = tier === null ? TIER_MULTIPLE['5x'] : TIER_MULTIPLE[tier];
  return { logMean: Math.log(base / multiple), logSd: tier === null ? PRIOR_LOG_SD_UNKNOWN : PRIOR_LOG_SD_KNOWN };
}

/** The plan's weekly rise and its sessions' summed cost over the last 6 hours of this week, else everything kept this week. */
export function observedRise(
  usage: UsageSample[],
  sessionCosts: CostSample[][],
  now: number,
  weekReset: number | null
): { rise: number; usd: number } | null {
  const weekStart = weekReset === null ? -Infinity : weekReset - WEEK_MS;
  const samePeriod = (s: UsageSample) =>
    weekReset === null || s.resetAt === undefined || !Number.isFinite(s.resetAt) || Math.abs(s.resetAt - weekReset) <= SAME_RESET_MS;
  for (const back of [BURN_WINDOW_MS, COST_HISTORY_MS]) {
    const from = Math.max(now - back, weekStart);
    const weekly = usage
      .filter((s) => s.at >= from && s.at <= now && !s.misattributed && samePeriod(s))
      .sort((a, b) => a.at - b.at);
    if (weekly.length < 2) continue;
    const first = weekly[0];
    const last = weekly[weekly.length - 1];
    const rise = last.weekly - first.weekly;
    const usd = sessionCosts.reduce((sum, costs) => sum + costUsed(costs, first.at, last.at), 0);
    if (rise >= MIN_CONVERSION_POINTS && usd >= MIN_CONVERSION_USD) return { rise, usd };
  }
  return null;
}

/**
 * Weekly points per work unit on one plan: the provider/tier prior, updated by the plan's own observed rise per USD
 * (a precision-weighted average in log space, so a factor-of-two error counts the same either way).
 */
export function planConversion(input: {
  provider: string;
  label: string;
  usage: UsageSample[];
  sessionCosts: CostSample[][];
  now: number;
  weekReset: number | null;
}): PlanConversion {
  const tier = planTier(input.label);
  const prior = priorConversion(input.provider, tier);
  let mean = prior.logMean;
  let variance = prior.logSd ** 2;
  const seen = observedRise(input.usage, input.sessionCosts, input.now, input.weekReset);
  if (seen) {
    const obsVariance = (RISE_SD_POINTS / seen.rise) ** 2 + OBSERVATION_LOG_SD ** 2;
    const precision = 1 / variance + 1 / obsVariance;
    mean = (mean / variance + Math.log(seen.rise / seen.usd) / obsVariance) / precision;
    variance = 1 / precision;
  }
  const sd = Math.sqrt(variance);
  return {
    pctPerUsd: round(Math.exp(mean), 4),
    low: round(Math.exp(mean - sd), 4),
    high: round(Math.exp(mean + sd), 4),
    basis: seen ? 'learned' : 'prior',
    tier,
  };
}

export interface ConversionFit {
  /** Mean absolute error of the hourly predicted rise (factor × the sessions' cost) against the observed rise, points/h. */
  maePerHour: number;
  /** Mean of predicted minus observed, points/h: negative when the plan rises faster than its reporting sessions explain. */
  biasPerHour: number;
  /** Hours compared. */
  n: number;
}

/**
 * How well the factor turns the sessions' cost into the plan's observed weekly rise, hour by hour over the last 6 hours
 * of this week. In-sample: the same readings also update the factor. Null with no hour that has two readings.
 */
export function conversionFit(
  usage: UsageSample[],
  sessionCosts: CostSample[][],
  pctPerUsd: number,
  now: number,
  weekReset: number | null
): ConversionFit | null {
  const weekStart = weekReset === null ? -Infinity : weekReset - WEEK_MS;
  const samePeriod = (s: UsageSample) =>
    weekReset === null || s.resetAt === undefined || !Number.isFinite(s.resetAt) || Math.abs(s.resetAt - weekReset) <= SAME_RESET_MS;
  const from = Math.max(now - BURN_WINDOW_MS, weekStart);
  const weekly = usage.filter((s) => s.at >= from && s.at <= now && !s.misattributed && samePeriod(s)).sort((a, b) => a.at - b.at);
  const errors: number[] = [];
  const biases: number[] = [];
  for (let end = now; end - HOUR_MS >= from - 1; end -= HOUR_MS) {
    const inside = weekly.filter((s) => s.at > end - HOUR_MS && s.at <= end);
    if (inside.length < 2) continue;
    const first = inside[0];
    const last = inside[inside.length - 1];
    const hours = (last.at - first.at) / HOUR_MS;
    if (hours < 0.5 || last.weekly < first.weekly) continue;
    const predicted = (pctPerUsd * sessionCosts.reduce((sum, costs) => sum + costUsed(costs, first.at, last.at), 0)) / hours;
    const observed = (last.weekly - first.weekly) / hours;
    errors.push(Math.abs(predicted - observed));
    biases.push(predicted - observed);
  }
  if (!errors.length) return null;
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  return { maePerHour: round(mean(errors), 2), biasPerHour: round(mean(biases), 2), n: errors.length };
}

export interface AgentBurn {
  sessionId: string;
  name: string;
  /** USD per hour over the last 30 minutes; null when the readings are too close together to tell. */
  usdPerHour: number | null;
  /** Weekly points per hour of this plan; null without a rate. */
  pctPerHour: number | null;
  /** Fraction of the plan's reported cost rate, 0-1; null when the plan has no reported cost right now. */
  share: number | null;
}

export interface PlanAgentBurn {
  /** Weekly points per work unit (USD) on this plan, with its band (see `planConversion`). */
  conversion: PlanConversion;
  /** Hourly fit of factor × session cost against the plan's observed rise (see `conversionFit`). */
  fit: ConversionFit | null;
  /** The plan's weekly points per hour from its sessions' last 30 minutes, with the conversion's band. */
  realtimePerHour: number;
  realtimeLow: number;
  realtimeHigh: number;
  /** Summed USD per hour of the sessions on this plan that have a rate. */
  usdPerHour: number;
  agents: AgentBurn[];
}

/** Per-agent burn and the realtime rate for one plan, from its usage samples and its sessions' cost samples. */
export function planAgentBurn(input: {
  provider: string;
  label: string;
  usage: UsageSample[];
  sessions: { id: string; name: string; costs: CostSample[] }[];
  weekReset: number | null;
  now: number;
}): PlanAgentBurn {
  const conversion = planConversion({ ...input, sessionCosts: input.sessions.map((s) => s.costs) });
  const pctPerUsd = conversion.pctPerUsd;
  const rated = input.sessions.map((s) => ({ s, usd: costRate(s.costs, input.now) }));
  const usdPerHour = round(rated.reduce((sum, r) => sum + (r.usd ?? 0), 0), 3);
  const agents = rated.map(({ s, usd }) => ({
    sessionId: s.id,
    name: s.name,
    usdPerHour: usd,
    pctPerHour: usd === null ? null : round(usd * pctPerUsd, 2),
    share: usd === null || usdPerHour <= 0 ? null : round(usd / usdPerHour, 3),
  }));
  agents.sort((a, b) => (b.usdPerHour ?? -1) - (a.usdPerHour ?? -1) || a.name.localeCompare(b.name));
  return {
    conversion,
    fit: conversionFit(input.usage, input.sessions.map((s) => s.costs), pctPerUsd, input.now, input.weekReset),
    realtimePerHour: round(usdPerHour * pctPerUsd, 2),
    realtimeLow: round(usdPerHour * conversion.low, 2),
    realtimeHigh: round(usdPerHour * conversion.high, 2),
    usdPerHour,
    agents,
  };
}

export interface PlanSide {
  used: number | null;
  /** Weekly points per hour now, and with the move. */
  rateNow: number | null;
  rateAfter: number | null;
  /** Projected weekly percent at the plan's budget stop, now and with the move (capped at 100). */
  endNow: number | null;
  endAfter: number | null;
  /** When the projection with the move reaches 100 %, if before the stop (epoch ms). */
  runsOutAfter: number | null;
}

/** One side of a move: a plan whose rate changes by `deltaPerHour` weekly points per hour until its budget stop. */
export function projectSide(input: {
  used: number | null;
  rate: number | null;
  deltaPerHour: number | null;
  budgetStop: number | null;
  now: number;
}): PlanSide {
  const hours = input.budgetStop === null ? null : Math.max(0, (input.budgetStop - input.now) / HOUR_MS);
  const after = input.rate === null || input.deltaPerHour === null ? null : Math.max(0, input.rate + input.deltaPerHour);
  const end = (rate: number | null) =>
    input.used === null || rate === null || hours === null ? null : round(Math.min(100, input.used + rate * hours), 1);
  const runsOutAfter =
    input.used !== null && after !== null && after > 0 && hours !== null && input.used + after * hours > 100
      ? input.now + Math.max(0, ((100 - input.used) / after) * HOUR_MS)
      : null;
  return { used: input.used, rateNow: input.rate, rateAfter: after, endNow: end(input.rate), endAfter: end(after), runsOutAfter };
}

export interface MovePlan {
  used: number | null;
  /** The plan's weekly points per hour before the move (its realtime or steady rate). */
  rate: number | null;
  conversion: PlanConversion;
  budgetStop: number | null;
}

/**
 * Moving a session that does `usdPerHour` work units an hour from plan `from` to plan `to`, assuming it keeps that pace:
 * the plan left loses that work at its own conversion and the plan joined gains it at the joined plan's conversion, so a
 * move between tiers or providers is converted by both plans' factors. `endAfterLow`/`endAfterHigh` carry each
 * conversion's band.
 */
export function moveImpact(input: { usdPerHour: number; from: MovePlan; to: MovePlan; now: number }): {
  left: PlanSide & { endAfterLow: number | null; endAfterHigh: number | null };
  joined: PlanSide & { endAfterLow: number | null; endAfterHigh: number | null };
} {
  const side = (plan: MovePlan, sign: 1 | -1) => {
    const at = (factor: number) =>
      projectSide({ used: plan.used, rate: plan.rate, deltaPerHour: sign * input.usdPerHour * factor, budgetStop: plan.budgetStop, now: input.now });
    const mid = at(plan.conversion.pctPerUsd);
    // Leaving, the higher factor removes more; joining, it adds more: the band's ends swap with the sign.
    const lo = at(sign > 0 ? plan.conversion.low : plan.conversion.high).endAfter;
    const hi = at(sign > 0 ? plan.conversion.high : plan.conversion.low).endAfter;
    return { ...mid, endAfterLow: lo, endAfterHigh: hi };
  };
  return { left: side(input.from, -1), joined: side(input.to, 1) };
}

/** Per-session cost samples from the status line, persisted beside the plan usage history. */
export class PlanCostTracker {
  private samples: Record<string, CostSample[]> | null = null;
  private saving: Promise<void> = Promise.resolve();
  private lastSave = 0;

  constructor(private readonly file: string, private readonly now: () => number = Date.now) {}

  private async load(): Promise<Record<string, CostSample[]>> {
    if (this.samples) return this.samples;
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8')) as unknown;
      this.samples = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, CostSample[]>) : {};
    } catch {
      this.samples = {};
    }
    return this.samples;
  }

  /** Record one status-line cost report; ignores anything that is not a finite, non-negative number. */
  async record(sessionId: string, cost: unknown): Promise<void> {
    if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0 || !sessionId) return;
    const samples = await this.load();
    const at = this.now();
    samples[sessionId] = addCostSample(samples[sessionId] ?? [], { at, cost });
    for (const id of Object.keys(samples)) {
      const last = samples[id].at(-1);
      if (!last || last.at <= at - COST_HISTORY_MS) delete samples[id];
    }
    if (at - this.lastSave >= COST_SAMPLE_MS) {
      this.lastSave = at;
      const snapshot = JSON.stringify(samples);
      this.saving = this.saving
        .then(async () => {
          const tmp = `${this.file}.${process.pid}.tmp`;
          await fs.writeFile(tmp, snapshot, { mode: 0o600 });
          await fs.rename(tmp, this.file);
        })
        .catch(() => {});
    }
  }

  /** A copy of every session's samples. */
  async snapshot(): Promise<Record<string, CostSample[]>> {
    return structuredClone(await this.load());
  }

  /** A copy of one session's samples (empty when it has never reported). */
  async costs(sessionId: string): Promise<CostSample[]> {
    return structuredClone((await this.load())[sessionId] ?? []);
  }

  /** Test hook: wait for the pending write. */
  flushed(): Promise<void> {
    return this.saving;
  }
}
