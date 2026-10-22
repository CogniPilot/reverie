/**
 * @fileoverview Built-in data sources for 'post' cron jobs: numbers the console computes itself, so a
 * routine can post "burn is high" or "load is high" with no shell command. A job names a source, writes
 * its text as a template with `{field}` placeholders, and may add a condition on one numeric field and a
 * change-only switch (post only when the rendered text differs from the last post).
 */
import { appendFileSync, renameSync, statSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import type { PlanRow } from '../plan-accounts.js';

export type PostSourceName = 'plans-pace' | 'host-load' | 'burn-watch' | 'github';
export type PostSourceData = Record<string, number | string>;

export const POST_CONDITION_OPS = ['gt', 'gte', 'lt', 'lte', 'eq', 'ne'] as const;
export type PostConditionOp = (typeof POST_CONDITION_OPS)[number];

/** Post only when `field <op> value`. The field must be a numeric field of the job's source. */
export interface PostCondition {
  field: string;
  op: PostConditionOp;
  value: number;
}

/** Fields each source offers; `numeric` ones can carry a condition. */
export const POST_SOURCE_FIELDS: Record<PostSourceName, { numeric: string[]; text: string[] }> = {
  'plans-pace': {
    numeric: [
      'accounts',
      'maxWeekly',
      'maxProjected',
      'minHoursToRunOut',
      'bankedAvailable',
      'bankedSoonestExpiryHours',
    ],
    text: ['worst', 'summary'],
  },
  'host-load': {
    numeric: ['load1', 'load5', 'load15', 'cpus', 'load15PerCpu'],
    text: [],
  },
  // alerts = plans that run out before their reset, plus Codex banked resets; message is the ready-to-post text.
  'burn-watch': { numeric: ['alerts'], text: ['message', 'lines'] },
  // New or changed pull requests and issues of a public repository (see github-source.ts); needs postSourceArgs.
  github: { numeric: ['items'], text: ['message', 'lines'] },
};

/** What a source may read about the job asking: its arguments and the change key it last posted. */
export interface PostSourceContext {
  args?: Record<string, unknown>;
  last?: string;
}
export type PostSources = { [K in PostSourceName]?: (ctx: PostSourceContext) => Promise<PostSourceData> };

export function isPostSource(value: unknown): value is PostSourceName {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(POST_SOURCE_FIELDS, value);
}

/** The `{placeholders}` in a template, in order. */
export function templateFields(template: string): string[] {
  return [...template.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map((m) => m[1] as string);
}

/** Why this source/template/condition combination is invalid, or null when it is fine. */
export function validatePostSource(
  source: string,
  template: string,
  when: PostCondition | undefined
): string | null {
  if (!isPostSource(source)) return `Unknown data source "${source}"`;
  const fields = POST_SOURCE_FIELDS[source];
  const known = new Set([...fields.numeric, ...fields.text]);
  for (const f of templateFields(template)) {
    if (!known.has(f)) return `"{${f}}" is not a field of ${source} (use: ${[...known].join(', ')})`;
  }
  if (when && !fields.numeric.includes(when.field)) {
    return `Condition field "${when.field}" must be one of: ${fields.numeric.join(', ')}`;
  }
  return null;
}

export function conditionHolds(when: PostCondition, data: PostSourceData): boolean {
  const actual = data[when.field];
  // A missing reading (no account has data, etc.) never satisfies a condition.
  if (typeof actual !== 'number' || !Number.isFinite(actual)) return false;
  switch (when.op) {
    case 'gt':
      return actual > when.value;
    case 'gte':
      return actual >= when.value;
    case 'lt':
      return actual < when.value;
    case 'lte':
      return actual <= when.value;
    case 'eq':
      return actual === when.value;
    case 'ne':
      return actual !== when.value;
  }
}

/** Fill `{field}` placeholders; a field with no reading renders as "n/a". */
export function renderTemplate(template: string, data: PostSourceData): string {
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_m, name: string) => {
    const v = data[name];
    return v === undefined || v === null ? 'n/a' : String(v);
  });
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Console-wide load: the 1/5/15-minute averages and the 15-minute average per CPU. */
export async function hostLoadData(): Promise<PostSourceData> {
  const [l1, l5, l15] = loadavg() as [number, number, number];
  const n = Math.max(1, cpus().length);
  return {
    load1: round1(l1),
    load5: round1(l5),
    load15: round1(l15),
    cpus: n,
    load15PerCpu: Math.round((l15 / n) * 100) / 100,
  };
}

/**
 * Subscription pace across signed-in accounts (the same rows as /api/plans). The headline numbers are the
 * worst case: highest weekly use and projection, the soonest run-out, the Codex banked resets.
 */
export function plansPaceData(rows: PlanRow[], now: number = Date.now()): PostSourceData {
  const live = rows.filter((r) => r.signedIn && r.pace.weekly !== null);
  const data: PostSourceData = { accounts: live.length, worst: 'none', summary: 'no signed-in account has a reading' };
  if (live.length === 0) return data;

  let worst = live[0] as PlanRow;
  let maxWeekly = 0;
  let maxProjected: number | null = null;
  let soonestRunOut: number | null = null;
  let banked = 0;
  let bankedExpiry: number | null = null;
  for (const r of live) {
    maxWeekly = Math.max(maxWeekly, r.pace.weekly ?? 0);
    const proj = r.pace.projected;
    if (proj !== null && (maxProjected === null || proj > maxProjected)) {
      maxProjected = proj;
      worst = r;
    }
    if (r.pace.runsOutAt !== null && (soonestRunOut === null || r.pace.runsOutAt < soonestRunOut)) {
      soonestRunOut = r.pace.runsOutAt;
    }
    if (r.bankedResets) {
      banked += r.bankedResets.availableCount;
      const exp = r.bankedResets.earliestExpiresAt;
      if (exp !== null && (bankedExpiry === null || exp < bankedExpiry)) bankedExpiry = exp;
    }
  }
  data.maxWeekly = round1(maxWeekly);
  if (maxProjected !== null) data.maxProjected = round1(maxProjected);
  if (soonestRunOut !== null) data.minHoursToRunOut = round1(Math.max(0, (soonestRunOut - now) / 3_600_000));
  data.bankedAvailable = banked;
  if (bankedExpiry !== null) data.bankedSoonestExpiryHours = round1(Math.max(0, (bankedExpiry - now) / 3_600_000));
  data.worst = worst.label;
  data.summary = live
    .map((r) => {
      const proj = r.pace.projected === null ? 'n/a' : `${round1(r.pace.projected)}%`;
      return `${r.label} ${round1(r.pace.weekly ?? 0)}% week, projected ${proj}`;
    })
    .join('; ');
  return data;
}

const utc = (ms: number | null | undefined): string => {
  if (!ms) return '-';
  const d = new Date(ms);
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
  return `${day} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
};
const who = (r: PlanRow): string => r.sessions.map((s) => s.name).join(',');

/** One log line per plan (what burn-hourly.log has always held). */
export function burnLogLines(rows: PlanRow[], now: number = Date.now()): string[] {
  const stamp = new Date(now).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  return rows.map(
    (r) =>
      `${stamp} | ${r.label} | used ${r.pace.weekly}% | ${r.pace.burnPerHour}%/h | projected ${r.pace.projected}% | ` +
      `reset ${utc(r.pace.weekReset)} | runs out ${utc(r.pace.runsOutAt)} | ${who(r)}`
  );
}

/**
 * Burn watch: an ALERT for every plan projected to run out before its weekly reset and for every Codex
 * account holding banked resets. `_key` is the alert set without times, so a job with postChangeOnly posts when
 * the set changes (and once more, "all clear", when it empties) and stays quiet when only times move.
 */
export function burnWatchData(rows: PlanRow[]): PostSourceData {
  const alerts: string[] = [];
  const keys: string[] = [];
  for (const r of rows) {
    const p = r.pace;
    if (p.runsOutAt && p.weekReset && p.runsOutAt < p.weekReset) {
      alerts.push(`ALERT ${r.label} (${who(r)}) runs out ${utc(p.runsOutAt)}, before its reset ${utc(p.weekReset)}`);
      keys.push(`ALERT ${r.label} (${who(r)}) runs out`);
    }
    const b = r.bankedResets;
    if (b && b.availableCount > 0) {
      alerts.push(
        `ALERT BANKED ${r.label} (${who(r)}): ${b.availableCount} free reset(s) available, earliest expires ${utc(b.earliestExpiresAt)}`
      );
      keys.push(`ALERT BANKED ${r.label} (${who(r)}): ${b.availableCount}`);
    }
  }
  const lines = alerts.join('; ');
  return {
    alerts: alerts.length,
    lines,
    message: alerts.length
      ? `Burn watch: ${lines}`
      : 'Burn watch: all plans now projected to reach their reset. No alerts.',
    _key: keys.join('|'),
  };
}

const BURN_LOG_MAX_BYTES = 1_000_000;

/** Append the hourly lines to the log; past 1 MB the old log is kept once as `<file>.1`. Never throws. */
export function appendBurnLog(file: string, lines: string[]): void {
  if (lines.length === 0) return;
  try {
    try {
      if (statSync(file).size > BURN_LOG_MAX_BYTES) renameSync(file, `${file}.1`);
    } catch {
      /* no log yet */
    }
    appendFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
  } catch (err) {
    console.error('[cron] burn log write failed:', err instanceof Error ? err.message : err);
  }
}
