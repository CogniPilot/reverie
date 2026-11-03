/**
 * @fileoverview Pure next-run-time calculations for the cron.
 *
 * All functions are pure and take an explicit `after` timestamp (epoch ms) so
 * they are deterministic and unit-testable. Daily/weekly wall-clock times use the
 * job's IANA `timeZone` when it has one, otherwise the SERVER'S LOCAL timezone.
 */

import type { CronJob } from '../types/cron.js';

/** Parse an 'HH:MM' (24-hour) string into hours/minutes, or null if invalid. */
export function parseHHMM(value: string | undefined): { hours: number; minutes: number } | null {
  if (!value) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return { hours, minutes };
}

/** True when `tz` names a time zone this runtime knows. */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

interface Wall {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0 = Sunday
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The wall-clock reading of `epoch` in `tz`. */
function wallIn(epoch: number, tz: string): Wall {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
    });
    formatters.set(tz, f);
  }
  const part: Record<string, string> = {};
  for (const p of f.formatToParts(new Date(epoch))) part[p.type] = p.value;
  return {
    year: Number(part.year),
    month: Number(part.month),
    day: Number(part.day),
    hour: Number(part.hour),
    minute: Number(part.minute),
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(part.weekday),
  };
}

/**
 * The epoch-ms of the wall time `y-m-d h:mi` in `tz`. A time that falls in a spring-forward gap
 * is moved on by the length of the jump (02:30 becomes 03:30); a time that occurs twice (fall back) to its first occurrence.
 */
function zonedToEpoch(y: number, m: number, d: number, h: number, mi: number, tz: string): number {
  const asUtc = Date.UTC(y, m - 1, d, h, mi);
  const offsetAt = (t: number): number => {
    const w = wallIn(t, tz);
    return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute) - Math.floor(t / 60_000) * 60_000;
  };
  // Try the offsets on both sides of the moment; keep the earliest instant whose wall time matches.
  const candidates = new Set([asUtc - offsetAt(asUtc - 86_400_000), asUtc - offsetAt(asUtc + 86_400_000)]);
  const matching = [...candidates].filter((t) => {
    const w = wallIn(t, tz);
    return w.year === y && w.month === m && w.day === d && w.hour === h && w.minute === mi;
  });
  if (matching.length > 0) return Math.min(...matching);
  // Gap: the later offset's reading puts the time just after the jump.
  return Math.max(...candidates);
}

/**
 * Returns the epoch-ms timestamp for `hours:minutes` on the day of `base`, shifted by `dayOffset`
 * days, in `tz` (or the server's local zone without one).
 */
function atLocalTime(base: number, hours: number, minutes: number, dayOffset: number, tz?: string): number {
  if (!tz) {
    const d = new Date(base);
    d.setHours(hours, minutes, 0, 0);
    d.setDate(d.getDate() + dayOffset);
    return d.getTime();
  }
  const w = wallIn(base, tz);
  const day = new Date(Date.UTC(w.year, w.month - 1, w.day + dayOffset));
  return zonedToEpoch(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hours, minutes, tz);
}

/** Day of week (0 = Sunday) of `epoch` in `tz`, or in the server's zone without one. */
function weekdayOf(epoch: number, tz?: string): number {
  return tz ? wallIn(epoch, tz).weekday : new Date(epoch).getDay();
}

/**
 * Compute the next fire time strictly relevant to `after`, or null if the job
 * has no future run (e.g. a completed one-time job, or invalid config).
 *
 * For `once`, returns the absolute `runAt` (even if already in the past, so a
 * missed one-time job still fires once) until it has `completedOnce`.
 */
export function computeNextRunAt(job: CronJob, after: number): number | null {
  switch (job.scheduleType) {
    case 'once': {
      if (job.completedOnce) return null;
      return typeof job.runAt === 'number' ? job.runAt : null;
    }
    case 'interval': {
      const minutes = job.intervalMinutes;
      if (!minutes || minutes <= 0) return null;
      return after + minutes * 60_000;
    }
    case 'daily': {
      const t = parseHHMM(job.dailyTime);
      if (!t) return null;
      let next = atLocalTime(after, t.hours, t.minutes, 0, job.timeZone);
      if (next <= after) next = atLocalTime(after, t.hours, t.minutes, 1, job.timeZone);
      return next;
    }
    case 'weekly': {
      const t = parseHHMM(job.weeklyTime);
      if (!t) return null;
      const days = (job.weeklyDays ?? []).filter((d) => d >= 0 && d <= 6);
      if (days.length === 0) return null;
      for (let offset = 0; offset <= 7; offset++) {
        const cand = atLocalTime(after, t.hours, t.minutes, offset, job.timeZone);
        if (cand > after && days.includes(weekdayOf(cand, job.timeZone))) return cand;
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * The next `count` fire times after `after`, as the cron would reach them (each one computed from the previous), for showing
 * a schedule before it is saved. Fewer when the schedule ends (a one-time job) or is incomplete.
 */
export function nextRuns(job: CronJob, after: number, count: number): number[] {
  const out: number[] = [];
  let from = after;
  while (out.length < count) {
    const next = computeNextRunAt(job, from);
    if (next === null || (out.length && next <= out[out.length - 1])) break;
    out.push(next);
    from = next;
  }
  return out;
}

/**
 * Duplicate-launch guard key: identifies a specific due time for a job. The
 * cron records the key it last consumed so an overlapping or restarted
 * loop will not launch the same due time twice.
 */
export function dueKeyFor(jobId: string, fireTime: number): string {
  return `${jobId}:${fireTime}`;
}
