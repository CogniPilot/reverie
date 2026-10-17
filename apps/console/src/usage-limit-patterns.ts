/**
 * @fileoverview Pure detection of Claude Code usage-limit pause messages.
 *
 * When a Claude subscription limit (5-hour rolling window, weekly, Opus weekly,
 * or extra-usage balance) is hit, the Claude Code TUI stops working and prints a
 * status line with the reset time. These helpers detect that state in cleaned
 * (ANSI-stripped) terminal output and parse the reset time, so the session
 * auto-resume feature (SessionAutoOps) can schedule a "continue" nudge.
 *
 * Message shapes covered (observed across Claude Code 1.0.x–2.1.x, 2025–2026):
 * - `5-hour limit reached ∙ resets 8pm`                                (v1.0.109+ footer)
 * - `Session limit reached ∙ resets 8pm`
 * - `Weekly limit reached ∙ resets 6pm`
 * - `Opus weekly limit reached ∙ resets Oct 6, 1pm`
 * - `Limit reached · resets 1pm (America/Chicago) · /upgrade to Max…`  (v2.0.55+)
 * - `You've hit your limit · resets 1:40pm (America/New_York)`         (v2.1.x)
 * - `You've hit your weekly limit · resets Mon 12:00am`
 * - `You've hit your limit · resets May 5 at 9pm (America/New_York)`
 * - `You're out of extra usage · resets 1pm (America/Los_Angeles)`
 * - `Claude usage limit reached. Your limit will reset at 2pm (America/New_York)` (v1.0.x inline)
 * - `Claude AI usage limit reached|1755309600`                         (raw API, epoch seconds)
 *
 * Deliberately conservative: a limit phrase WITHOUT a parseable reset time is
 * ignored (returns null) so ordinary conversation text mentioning "limit
 * reached" can't arm the scheduler. The downstream retry loop (re-detection
 * after each resume attempt) compensates for any parsing imprecision.
 *
 * All functions are pure (caller passes `now`) for testability.
 *
 * @module usage-limit-patterns
 */

/** Result of scanning terminal output for a usage-limit pause. */
export interface UsageLimitDetection {
  /**
   * Epoch ms when the limit resets. May be in the past when the matched
   * message is stale (caller should treat past values as "retry soon").
   */
  resetAt: number;
  /** Matched message snippet (for logging and UI). */
  matched: string;
}

/**
 * Limit phrases that indicate Claude stopped on a usage limit.
 * `\blimit reached` covers all "<X> limit reached" footer variants.
 */
const LIMIT_PHRASE_PATTERN =
  /(?:\blimit\s+reached\b|you'?ve\s+hit\s+your\s+(?:\w+\s+)?limit\b|you'?re\s+out\s+of\s+extra\s+usage\b)/gi;

/**
 * Reset-time spec following a limit phrase. Captures:
 * 1 month (weekly resets >1 day out: "Oct 6, 1pm" / "May 5 at 9pm")
 * 2 day-of-month
 * 3 day-of-week ("Mon 12:00am")
 * 4 hour (12h)  5 minutes  6 am/pm  7 IANA timezone in parens (optional)
 * `resets?` + optional `at` also covers the v1.0.x "will reset at 2pm" form.
 */
const RESET_TIME_PATTERN =
  /\bresets?\s+(?:at\s+)?(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:\s*,\s*|\s+at\s+)|(sun|mon|tue|wed|thu|fri|sat)[a-z]*\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b(?:\s*\(([^()\n]{1,64})\))?/i;

/** Raw API form: `Claude AI usage limit reached|1755309600` (epoch seconds). */
const EPOCH_LIMIT_PATTERN = /\busage\s+limit\s+reached\|(\d{9,11})\b/gi;

/** How far after a limit phrase the reset-time spec may appear (chars). */
const RESET_TIME_WINDOW = 160;

/** Parsed reset spec must not be further out than this (weekly max ≈ 7 days). */
const MAX_RESET_HORIZON_MS = 8 * 24 * 60 * 60 * 1000;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Current UTC offset of an IANA timezone in ms, or null if unresolvable
 * (e.g. the `(Etc/Unknown)` failure variant Claude Code can print).
 * DST transitions inside the wait window can skew the result by an hour;
 * the auto-resume retry loop absorbs that.
 */
function zoneOffsetMs(timeZone: string, at: number): number | null {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' });
    const name = dtf.formatToParts(at).find((p) => p.type === 'timeZoneName')?.value;
    if (!name) return null;
    const m = /^GMT(?:([+-])(\d{1,2})(?::(\d{2}))?)?$/.exec(name);
    if (!m) return null;
    if (!m[1]) return 0; // plain "GMT"
    const sign = m[1] === '-' ? -1 : 1;
    return sign * (parseInt(m[2], 10) * 60 + (m[3] ? parseInt(m[3], 10) : 0)) * 60_000;
  } catch {
    return null;
  }
}

interface ResetSpec {
  month?: number; // 0-11
  dayOfMonth?: number; // 1-31
  dayOfWeek?: number; // 0-6 (Sun-Sat)
  hour: number; // 0-23
  minute: number; // 0-59
  timeZone?: string;
}

/**
 * Compute the epoch ms for a parsed reset spec. Times are wall-clock in the
 * given IANA timezone when present (and resolvable), otherwise server-local —
 * Claude CLI runs on the same host as Codeman, so local time is the right
 * default. Returns null when the spec is implausible (> ~8 days out).
 */
function resolveResetSpec(spec: ResetSpec, now: number): number | null {
  const offset = spec.timeZone ? zoneOffsetMs(spec.timeZone, now) : null;

  // Wall-clock view of "now": shifted-UTC when a zone offset is known,
  // server-local otherwise. Read/build components with the matching API.
  const useZone = offset !== null;
  const wallNow = useZone ? new Date(now + offset) : new Date(now);
  const get = {
    year: () => (useZone ? wallNow.getUTCFullYear() : wallNow.getFullYear()),
    month: () => (useZone ? wallNow.getUTCMonth() : wallNow.getMonth()),
    date: () => (useZone ? wallNow.getUTCDate() : wallNow.getDate()),
    day: () => (useZone ? wallNow.getUTCDay() : wallNow.getDay()),
  };
  const build = (y: number, mo: number, d: number): number => {
    const wall = useZone
      ? Date.UTC(y, mo, d, spec.hour, spec.minute)
      : new Date(y, mo, d, spec.hour, spec.minute).getTime();
    return useZone ? wall - offset : wall;
  };

  let ts: number;
  if (spec.month !== undefined && spec.dayOfMonth !== undefined) {
    // Explicit date ("Oct 6, 1pm"). More than 2 days in the past → assume year
    // rollover (message seen near New Year); slightly past → stale, keep as-is.
    ts = build(get.year(), spec.month, spec.dayOfMonth);
    if (ts < now - 2 * DAY_MS) {
      ts = build(get.year() + 1, spec.month, spec.dayOfMonth);
    }
  } else if (spec.dayOfWeek !== undefined) {
    // Day-of-week ("Mon 12:00am") → next occurrence.
    const delta = (spec.dayOfWeek - get.day() + 7) % 7;
    ts = build(get.year(), get.month(), get.date() + delta);
    if (ts <= now) ts += 7 * DAY_MS;
  } else {
    // Time-only ("resets 8pm") → next occurrence within 24h.
    ts = build(get.year(), get.month(), get.date());
    if (ts <= now) ts += DAY_MS;
  }

  if (ts > now + MAX_RESET_HORIZON_MS) return null;
  return ts;
}

/** Parse the reset-time spec found within `window`, or null. */
function parseResetTime(window: string, now: number): number | null {
  const m = RESET_TIME_PATTERN.exec(window);
  if (!m) return null;

  const hour12 = parseInt(m[4], 10);
  const minute = m[5] ? parseInt(m[5], 10) : 0;
  if (hour12 < 1 || hour12 > 12 || minute > 59) return null;
  const pm = m[6].toLowerCase() === 'pm';
  const hour = (hour12 % 12) + (pm ? 12 : 0);

  const spec: ResetSpec = { hour, minute };
  if (m[1] && m[2]) {
    spec.month = MONTHS.indexOf(m[1].toLowerCase());
    spec.dayOfMonth = parseInt(m[2], 10);
    if (spec.dayOfMonth < 1 || spec.dayOfMonth > 31) return null;
  } else if (m[3]) {
    spec.dayOfWeek = WEEKDAYS.indexOf(m[3].toLowerCase());
  }
  if (m[7]) spec.timeZone = m[7].trim();

  return resolveResetSpec(spec, now);
}

/**
 * Scan cleaned (ANSI-stripped) terminal output for a usage-limit pause message
 * with a parseable reset time. Returns the LAST parseable occurrence in the
 * chunk (most recent on screen), or null when none is found.
 */
export function detectUsageLimitPause(cleanData: string, now: number = Date.now()): UsageLimitDetection | null {
  if (!cleanData || !/limit|extra usage/i.test(cleanData)) return null;

  let result: UsageLimitDetection | null = null;

  // Raw API epoch form
  EPOCH_LIMIT_PATTERN.lastIndex = 0;
  let em: RegExpExecArray | null;
  while ((em = EPOCH_LIMIT_PATTERN.exec(cleanData)) !== null) {
    const resetAt = parseInt(em[1], 10) * 1000;
    if (resetAt > now + MAX_RESET_HORIZON_MS) continue;
    result = { resetAt, matched: em[0] };
  }

  // TUI phrase + "resets <time>" forms
  LIMIT_PHRASE_PATTERN.lastIndex = 0;
  let pm: RegExpExecArray | null;
  while ((pm = LIMIT_PHRASE_PATTERN.exec(cleanData)) !== null) {
    const window = cleanData.slice(pm.index, pm.index + RESET_TIME_WINDOW);
    const resetAt = parseResetTime(window, now);
    if (resetAt !== null) {
      result = { resetAt, matched: window.slice(0, 80).trim() };
    }
  }

  return result;
}
