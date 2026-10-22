/**
 * @fileoverview The nightly chat backup, run inside the console process: at 03:30 in the company zone
 * the live chat.db is copied with SQLite's online backup to `chat-backups/chat-<UTC stamp>.db` (dir
 * 0700, files 0600) and checked (it opens, passes the integrity check, holds every message the source
 * held). On start, if the newest backup is more than a day old (or there is none), one catch-up run
 * goes first. Every copy is kept: pruning is the owner's call. Each run posts the result (or the
 * failure) to the coordination room.
 */

import fs from 'node:fs';
import { join } from 'node:path';
import { backupChatDb } from './chat-db.js';

const DAY_MS = 86_400_000;
const NAME = /^chat-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.db$/;

export interface ChatBackupDeps {
  database: string;
  dir: string;
  now?: () => number;
  timeZone?: () => string | undefined;
  /** Post the nightly result; `failed` marks an alert. */
  notify: (text: string, failed: boolean) => void;
  setTimer?: (fn: () => void, ms: number) => { unref?: () => void };
  clearTimer?: (timer: unknown) => void;
}

/** The wall clock of `at` in `timeZone` (UTC when unset or unknown), as UTC fields. */
function wall(at: number, timeZone?: string): number {
  const parts = (zone: string) =>
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(at);
  let p: Intl.DateTimeFormatPart[];
  try {
    p = parts(timeZone || 'UTC');
  } catch {
    p = parts('UTC');
  }
  const n = (t: string) => Number(p.find((x) => x.type === t)!.value);
  return Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
}

/** The first 03:30 in `timeZone` strictly after `now` (on a DST day without 03:30, the instant the clock shows past it). */
export function nextRunAt(now: number, timeZone?: string): number {
  const today = new Date(wall(now, timeZone));
  for (let days = 0; days < 3; days++) {
    const target = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + days, 3, 30);
    // Two passes settle the zone offset (it can differ either side of a DST change).
    let at = target - (wall(target, timeZone) - target);
    at = target - (wall(at, timeZone) - at);
    if (at > now) return at;
  }
  return now + DAY_MS;
}

function stamp(at: number): string {
  return new Date(at).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function mb(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

export class ChatBackupScheduler {
  private timer: unknown;
  private running: Promise<void> | undefined;
  private stopped = false;

  constructor(private readonly deps: ChatBackupDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Backups on disk, oldest first, with the time in their name. */
  list(): Array<{ name: string; at: number; bytes: number }> {
    let names: string[];
    try {
      names = fs.readdirSync(this.deps.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    return names
      .flatMap((name) => {
        const m = NAME.exec(name);
        if (!m) return [];
        const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
        return [{ name, at: Date.UTC(y, mo - 1, d, h, mi, s), bytes: fs.statSync(join(this.deps.dir, name)).size }];
      })
      .sort((a, b) => a.at - b.at);
  }

  /** Start: one catch-up run if the newest backup is over a day old, then 03:30 each night. */
  start(): void {
    const newest = this.list().at(-1);
    if (!newest || this.now() - newest.at > DAY_MS) void this.run();
    this.schedule();
  }

  stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) (this.deps.clearTimer ?? clearTimeout)(this.timer as NodeJS.Timeout);
    this.timer = undefined;
    return this.running ?? Promise.resolve();
  }

  private schedule(): void {
    if (this.stopped) return;
    const at = nextRunAt(this.now(), this.deps.timeZone?.());
    const timer = (this.deps.setTimer ?? setTimeout)(() => {
      this.timer = undefined;
      void this.run().finally(() => this.schedule());
    }, Math.max(0, at - this.now()));
    timer.unref?.();
    this.timer = timer;
  }

  /** One backup now (a run already going is joined, not repeated). Never throws: a failure is posted. */
  run(): Promise<void> {
    this.running ??= this.once().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async once(): Promise<void> {
    const name = `chat-${stamp(this.now())}.db`;
    try {
      fs.mkdirSync(this.deps.dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(this.deps.dir, 0o700);
      // Written under a name list() ignores, and given its real name only once checked; a failed copy
      // stays as .failed (nothing is deleted) and never counts as a backup.
      const partial = join(this.deps.dir, `${name}.partial`);
      let counts: { rooms: number; messages: number };
      try {
        counts = await backupChatDb(this.deps.database, partial);
      } catch (err) {
        if (fs.existsSync(partial)) fs.renameSync(partial, join(this.deps.dir, `${name}.failed`));
        throw err;
      }
      fs.renameSync(partial, join(this.deps.dir, name));
      const { rooms, messages } = counts;
      const all = this.list();
      const size = all.find((b) => b.name === name)?.bytes ?? 0;
      const total = all.reduce((sum, b) => sum + b.bytes, 0);
      this.notify(
        `Nightly chat backup: ${name} (${rooms} rooms, ${messages} messages, ${mb(size)}), checked. ${all.length} backup(s) kept, ${mb(total)} in all.`,
        false
      );
    } catch (err) {
      console.error('[chat-backup] nightly backup failed:', err);
      this.notify(
        `⚠️ Nightly chat backup FAILED (${name}): ${err instanceof Error ? err.message : String(err)}. Earlier backups are untouched; the next try is at 03:30 or the next console start.`,
        true
      );
    }
  }

  private notify(text: string, failed: boolean): void {
    try {
      this.deps.notify(text, failed);
    } catch (err) {
      console.error(`[chat-backup] could not post: ${text}`, err);
    }
  }
}
