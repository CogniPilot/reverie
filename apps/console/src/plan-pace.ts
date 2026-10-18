/**
 * @fileoverview Plan pacing: how fast each subscription account is being used through
 * its weekly window, and what that means for the agents on it.
 *
 * Pure (time is a parameter) so the arithmetic is unit-tested on its own; the IO lives
 * in `plan-accounts.ts` and the route in `routes/plan-routes.ts`.
 *
 * - elapsed: how far through the weekly window we are (0-100).
 * - pace: weekly usage percent minus elapsed percent. Negative is headroom: the account
 *   is behind an even burn and its agents can work harder.
 * - burn rate: weekly percentage points per hour over the last 6 h of samples, from at least 1 h of
 *   them and only samples of the same weekly period (same reset); otherwise `null` ("not enough data").
 * - projected: where weekly usage lands at the reset at the current burn rate (or at
 *   the average rate so far, when there is not enough recent history).
 * - recommendation: stop (5-hour window at 95 % or weekly at/over 100 %), ease (pace
 *   above +15), push (pace below -15), steady otherwise; login when signed out and
 *   unknown when the provider gave no reading.
 */

export const WEEK_MS = 7 * 24 * 3600 * 1000;
export const BURN_WINDOW_MS = 6 * 3600 * 1000;
/** Samples spanning less than this cannot give a burn rate: two readings minutes apart say nothing about an hourly pace. */
export const MIN_BURN_SPAN_MS = 60 * 60 * 1000;
/** Without a recent rate, the average since the week began is used only once this much of the week has passed. */
export const MIN_AVERAGE_HOURS = 6;
/** Two resets this close are the same period (providers round the reset instant differently). */
const SAME_RESET_MS = 5 * 60 * 1000;
export const PUSH_BELOW = -15;
export const EASE_ABOVE = 15;
export const STOP_FIVE_HOUR = 95;
export const STOP_WEEKLY = 100;

export type PlanRecommendation = 'push' | 'steady' | 'ease' | 'stop' | 'login' | 'unknown';

export interface UsageWindow {
  usedPercentage: number;
  /** Epoch ms (or ISO) when the window resets. */
  resetAt: number | string;
}

export interface UsageSample {
  at: number;
  weekly: number;
  /** The reset the provider reported with this reading (epoch ms), so a reading is never mixed into another period's rate. */
  resetAt?: number;
  /** Set when the reading was filed under the wrong account; it is kept, but no rate, pace or plot uses it. */
  misattributed?: boolean;
}

export interface PlanPace {
  fiveHour: number | null;
  weekly: number | null;
  weekStart: number | null;
  weekReset: number | null;
  elapsed: number | null;
  pace: number | null;
  burnPerHour: number | null;
  /** Where the rate used for `projected` comes from: the recent samples, the average since the week began, or nothing yet. */
  burnBasis: 'recent' | 'average' | null;
  /** Points left in the week, hours to the reset, and the steady rate that would use exactly the rest by then. */
  remainingPct: number | null;
  hoursToReset: number | null;
  sustainablePctPerHour: number | null;
  projected: number | null;
  /** When weekly usage reaches 100 % at the same rate, if that is before the reset (epoch ms). */
  runsOutAt: number | null;
  recommendation: PlanRecommendation;
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
const round1 = (n: number): number => Math.round(n * 10) / 10;

export function toMs(value: number | string | undefined | null): number | null {
  if (value === undefined || value === null || value === '') return null;
  const ms = typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Weekly points per hour over the burn window, from samples inside the current week only. */
const BURN_JUMP_PTS = 10;
const H_MS = 3600 * 1000;

export function burnRate(
  samples: UsageSample[],
  now: number,
  weekStart: number | null,
  weekReset: number | null = null
): number | null {
  const from = Math.max(now - BURN_WINDOW_MS, weekStart ?? -Infinity);
  const samePeriod = (s: UsageSample) =>
    weekReset === null || s.resetAt === undefined || !Number.isFinite(s.resetAt) || Math.abs(s.resetAt - weekReset) <= SAME_RESET_MS;
  const recent = samples
    .filter((s) => s.at >= from && s.at <= now && !s.misattributed && samePeriod(s))
    .sort((a, b) => a.at - b.at);
  // Usage never falls within one period, so a drop means a reset or a foreign reading slipped in; a jump of 10 points or more
  // inside an hour is the same thing seen from the other side (27 then 61). Use only the run after the last such break.
  let start = 0;
  for (let i = 1; i < recent.length; i++) {
    const rise = recent[i].weekly - recent[i - 1].weekly;
    if (rise < 0 || (rise >= BURN_JUMP_PTS && recent[i].at - recent[i - 1].at <= H_MS)) start = i;
  }
  const run = recent.slice(start);
  if (run.length < 2) return null;
  const span = run[run.length - 1].at - run[0].at;
  if (span < MIN_BURN_SPAN_MS) return null;
  // Least-squares slope over the run, so one noisy reading cannot swing the rate.
  const t0 = run[0].at;
  const n = run.length;
  const meanX = run.reduce((sum, s) => sum + (s.at - t0), 0) / n;
  const meanY = run.reduce((sum, s) => sum + s.weekly, 0) / n;
  let num = 0;
  let den = 0;
  for (const s of run) {
    num += (s.at - t0 - meanX) * (s.weekly - meanY);
    den += (s.at - t0 - meanX) ** 2;
  }
  if (den === 0) return null;
  return round1(Math.max(0, (num / den) * 3600 * 1000));
}

export function recommend(input: {
  signedIn: boolean;
  fiveHour: number | null;
  weekly: number | null;
  pace: number | null;
}): PlanRecommendation {
  if (!input.signedIn) return 'login';
  if ((input.fiveHour ?? 0) >= STOP_FIVE_HOUR || (input.weekly ?? 0) >= STOP_WEEKLY) return 'stop';
  if (input.pace === null) return input.weekly === null && input.fiveHour === null ? 'unknown' : 'steady';
  if (input.pace > EASE_ABOVE) return 'ease';
  if (input.pace < PUSH_BELOW) return 'push';
  return 'steady';
}

export function planPace(input: {
  signedIn: boolean;
  fiveHour?: UsageWindow | null;
  sevenDay?: UsageWindow | null;
  samples?: UsageSample[];
  now: number;
}): PlanPace {
  const fiveHour = Number.isFinite(input.fiveHour?.usedPercentage) ? round1(input.fiveHour!.usedPercentage) : null;
  const weekly = Number.isFinite(input.sevenDay?.usedPercentage) ? round1(input.sevenDay!.usedPercentage) : null;
  const weekReset = toMs(input.sevenDay?.resetAt);
  const weekStart = weekReset === null ? null : weekReset - WEEK_MS;
  const elapsed = weekStart === null ? null : round1(clamp(((input.now - weekStart) / WEEK_MS) * 100, 0, 100));
  const pace = weekly === null || elapsed === null ? null : round1(weekly - elapsed);
  const burnPerHour = burnRate(input.samples ?? [], input.now, weekStart, weekReset);
  let projected: number | null = null;
  let runsOutAt: number | null = null;
  let burnBasis: PlanPace['burnBasis'] = null;
  let remainingPct: number | null = null;
  let hoursToReset: number | null = null;
  let sustainablePctPerHour: number | null = null;
  if (weekly !== null && weekReset !== null && weekStart !== null) {
    const hoursLeft = Math.max(0, (weekReset - input.now) / 3600000);
    const hoursIn = Math.max(0, (input.now - weekStart) / 3600000);
    const rate = burnPerHour ?? (hoursIn >= MIN_AVERAGE_HOURS ? weekly / hoursIn : null);
    burnBasis = burnPerHour !== null ? 'recent' : rate !== null ? 'average' : null;
    remainingPct = round1(Math.max(0, 100 - weekly));
    hoursToReset = round1(hoursLeft);
    sustainablePctPerHour = hoursLeft > 0 ? round1(remainingPct / hoursLeft) : null;
    if (rate !== null) projected = round1(weekly + rate * hoursLeft);
    if (rate !== null && rate > 0 && projected !== null && projected > 100) {
      runsOutAt = input.now + Math.max(0, ((100 - weekly) / rate) * 3600000);
    }
  }
  return {
    fiveHour,
    weekly,
    weekStart,
    weekReset,
    elapsed,
    pace,
    burnPerHour,
    burnBasis,
    remainingPct,
    hoursToReset,
    sustainablePctPerHour,
    projected,
    runsOutAt,
    recommendation: recommend({ signedIn: input.signedIn, fiveHour, weekly, pace }),
  };
}

/**
 * The account a new session should use: signed in, not told to stop, of the requested
 * provider, with the most headroom (lowest pace; then the emptiest 5-hour window).
 */
export function suggestAccount<T extends { provider: string; pace: PlanPace; signedIn: boolean }>(
  rows: T[],
  provider: string
): T | null {
  const usable = rows.filter(
    (r) =>
      r.provider === provider && r.signedIn && r.pace.recommendation !== 'stop' && r.pace.recommendation !== 'login'
  );
  usable.sort((a, b) => (a.pace.pace ?? 0) - (b.pace.pace ?? 0) || (a.pace.fiveHour ?? 0) - (b.pace.fiveHour ?? 0));
  return usable[0] ?? null;
}

/** Keep one sample per 5 minutes per account and 8 days of history. */
export function addSample(samples: UsageSample[], sample: UsageSample): UsageSample[] {
  const kept = samples.filter((s) => s.at > sample.at - 8 * 24 * 3600 * 1000);
  const last = kept[kept.length - 1];
  if (last && sample.at - last.at < 5 * 60 * 1000) kept[kept.length - 1] = sample;
  else kept.push(sample);
  return kept;
}
