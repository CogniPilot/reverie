/**
 * The nightly chat backup: 03:30 in the company zone (DST included), one catch-up at start when the
 * newest backup is over a day old, private files that are checked before they count, every copy kept,
 * and a posted result or alert each run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatroomService } from '../src/chatroom-service.js';
import { ChatDb } from '../src/chat-db.js';
import { ChatBackupScheduler, nextRunAt } from '../src/chat-backup.js';

const ZONE = 'America/New_York';
// Saturday 2026-10-17 14:00 EDT.
const NOW = Date.UTC(2026, 9, 17, 18, 0);

let dir: string;
let dbFile: string;
let backups: string;
let clock: number;
let posts: Array<{ text: string; failed: boolean }>;
let timers: Array<{ fn: () => void; ms: number }>;

function scheduler(database = dbFile): ChatBackupScheduler {
  return new ChatBackupScheduler({
    database,
    dir: backups,
    now: () => clock,
    timeZone: () => ZONE,
    notify: (text, failed) => posts.push({ text, failed }),
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return {};
    },
    clearTimer: () => {},
  });
}

async function seed(n: number): Promise<void> {
  let at = NOW - 1_000_000;
  const s = new ChatroomService({
    file: join(dir, 'chatrooms.json'),
    database: dbFile,
    archiveDir: join(dir, 'chat-archive'),
    getSession: () => undefined,
    broadcast: () => {},
    now: () => at++,
    timeZone: () => ZONE,
  });
  await s.init();
  const room = s.createRoom('r', undefined);
  for (let i = 0; i < n; i++) s.post(room.id, { kind: 'user', name: 'Owner' }, `m${i}`, 'all', { deliver: false });
  await s.stop();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chat-backup-'));
  dbFile = join(dir, 'chat.db');
  backups = join(dir, 'chat-backups');
  clock = NOW;
  posts = [];
  timers = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('chat backup', () => {
  it('runs at 03:30 in the company zone, across both DST changes', () => {
    // 14:00 EDT -> tomorrow 03:30 EDT (07:30 UTC).
    expect(nextRunAt(NOW, ZONE)).toBe(Date.UTC(2026, 9, 18, 7, 30));
    // 03:29 EDT -> today 03:30; 03:30 exactly -> tomorrow.
    expect(nextRunAt(Date.UTC(2026, 9, 18, 7, 29), ZONE)).toBe(Date.UTC(2026, 9, 18, 7, 30));
    expect(nextRunAt(Date.UTC(2026, 9, 18, 7, 30), ZONE)).toBe(Date.UTC(2026, 9, 19, 7, 30));
    // Clocks go back Sunday 2026-11-01: that night's 03:30 is EST (08:30 UTC).
    expect(nextRunAt(Date.UTC(2026, 9, 31, 18, 0), ZONE)).toBe(Date.UTC(2026, 10, 1, 8, 30));
    // Clocks go forward Sunday 2027-03-14 (02:00 -> 03:00): 03:30 EDT is 07:30 UTC.
    expect(nextRunAt(Date.UTC(2027, 2, 13, 18, 0), ZONE)).toBe(Date.UTC(2027, 2, 14, 7, 30));
    // Unset or unknown zone: UTC.
    expect(nextRunAt(NOW, undefined)).toBe(Date.UTC(2026, 9, 18, 3, 30));
    expect(nextRunAt(NOW, 'Not/AZone')).toBe(Date.UTC(2026, 9, 18, 3, 30));
  });

  it('writes a checked, private copy and posts its counts and size', async () => {
    await seed(5);
    await scheduler().run();
    const name = 'chat-20261017T180000Z.db';
    expect(readdirSync(backups)).toEqual([name]);
    expect(statSync(backups).mode & 0o777).toBe(0o700);
    expect(statSync(join(backups, name)).mode & 0o777).toBe(0o600);
    const db = ChatDb.open(join(backups, name));
    try {
      expect(db.counts()).toEqual({ rooms: 1, messages: 5 });
    } finally {
      db.close();
    }
    expect(posts).toHaveLength(1);
    expect(posts[0].failed).toBe(false);
    expect(posts[0].text).toMatch(/^Nightly chat backup: chat-20261017T180000Z\.db \(1 rooms, 5 messages, [\d.]+ MB\), checked\. 1 backup\(s\) kept, [\d.]+ MB in all\.$/);
  });

  it('keeps every copy', async () => {
    await seed(2);
    const s = scheduler();
    for (let day = 0; day < 3; day++) {
      clock = NOW + day * 86_400_000;
      await s.run();
    }
    expect(readdirSync(backups).sort()).toEqual(['chat-20261017T180000Z.db', 'chat-20261018T180000Z.db', 'chat-20261019T180000Z.db']);
    expect(posts.at(-1)!.text).toContain('3 backup(s) kept');
  });

  it('catches up at start only when the newest backup is over a day old, then waits for 03:30', async () => {
    await seed(1);
    // None yet: one run now.
    const first = scheduler();
    first.start();
    await first.stop();
    expect(readdirSync(backups)).toHaveLength(1);
    expect(timers.at(-1)!.ms).toBe(Date.UTC(2026, 9, 18, 7, 30) - NOW);

    // 23 h later: no catch-up.
    clock = NOW + 23 * 3_600_000;
    const second = scheduler();
    second.start();
    await second.stop();
    expect(readdirSync(backups)).toHaveLength(1);

    // 25 h later: catch-up.
    clock = NOW + 25 * 3_600_000;
    const third = scheduler();
    third.start();
    await third.stop();
    expect(readdirSync(backups)).toHaveLength(2);
  });

  it('runs again when its timer fires, and schedules the next night', async () => {
    await seed(1);
    mkdirSync(backups, { mode: 0o700 });
    // A fresh backup exists: no catch-up.
    writeFileSync(join(backups, 'chat-20261017T170000Z.db'), '');
    const s = scheduler();
    s.start();
    expect(timers).toHaveLength(1);
    clock = Date.UTC(2026, 9, 18, 7, 30);
    timers[0].fn();
    await s.run();
    await vi.waitFor(() => expect(timers).toHaveLength(2));
    expect(existsSync(join(backups, 'chat-20261018T073000Z.db'))).toBe(true);
    expect(timers[1].ms).toBe(86_400_000);
    await s.stop();
  });

  it('alerts when a run fails, keeps earlier backups, and never counts a failed copy', async () => {
    await seed(1);
    const s = scheduler();
    await s.run();
    clock = NOW + 86_400_000;
    // The database is gone (as a broken disk would make it).
    await scheduler(join(dir, 'missing.db')).run();
    expect(posts.at(-1)!.failed).toBe(true);
    expect(posts.at(-1)!.text).toMatch(/^⚠️ Nightly chat backup FAILED \(chat-20261018T180000Z\.db\): .+\. Earlier backups are untouched/);
    expect(scheduler().list().map((b) => b.name)).toEqual(['chat-20261017T180000Z.db']);
    expect(existsSync(join(dir, 'missing.db'))).toBe(false);
    // A failed copy that left a file stays, under a name that never counts as a backup.
    writeFileSync(join(dir, 'bad.db'), 'not a database');
    await scheduler(join(dir, 'bad.db')).run();
    expect(posts.at(-1)!.failed).toBe(true);
    expect(scheduler().list()).toHaveLength(1);
    // A failed run at start is still followed by the nightly timer.
    clock = NOW + 3 * 86_400_000;
    const later = scheduler(join(dir, 'missing.db'));
    later.start();
    await later.stop();
    expect(posts.at(-1)!.failed).toBe(true);
    expect(timers).toHaveLength(1);
  });

  it('a post that fails is logged, not thrown', async () => {
    await seed(1);
    const s = new ChatBackupScheduler({
      database: dbFile,
      dir: backups,
      now: () => clock,
      notify: () => {
        throw new Error('chat is read-only');
      },
    });
    await expect(s.run()).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('[chat-backup] could not post: Nightly chat backup'), expect.anything());
  });
});
