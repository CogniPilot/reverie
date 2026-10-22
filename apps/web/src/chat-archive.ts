/**
 * @fileoverview The chat archive: what a room drops past MAX_MESSAGES_PER_ROOM, kept as JSON lines in
 * `chat-archive/YYYY-Www.jsonl` next to chatrooms.json (dir 0700, files 0600, same privacy as the
 * rooms file; there is no read API, the owner opens the files). The file is the ISO week, in the
 * company zone, of the drop; lines are appended as messages drop. One line per message:
 * `{ roomId, room, archivedAt, message }`, the message as stored.
 *
 * The service archives before the store drops anything; a failed append keeps the messages in the
 * room (it runs over the cap) and warns. A message is never dropped unarchived.
 *
 * Restarts do not repeat lines: a room's messages are strictly increasing in `at`, so the newest
 * archived `at` per room (read once from the newest week file, where the last append before a crash
 * landed) bounds what is already there. Only a crash right at a week turn, with rooms in two zones
 * whose weeks differ, can repeat one batch: a duplicate, never a loss. A torn last line (a failed
 * write) is ended before the next append, so it costs only itself; readers skip lines that do not parse.
 *
 * With the chat database (chat-db.ts) the files are its second, independent record instead: every
 * change to a message or room is appended (appendSync) as it is committed, as `{ kind: 'room', ... }`,
 * `{ kind: 'room-deleted', ... }` or a message line as above, so the database can be rebuilt from them.
 *
 * A week that has ended becomes `YYYY-Www.jsonl.gz` (checked once a day, on an append). The plain
 * file is replaced only after its .gz is on disk and reads back to the same bytes; an existing .gz is
 * never overwritten, and nothing is ever deleted.
 */

import fs from 'node:fs/promises';
import { closeSync, fstatSync, fsyncSync, mkdirSync, openSync, readSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync, gzip } from 'node:zlib';
import type { ChatMessage, ChatRoom } from './chatroom-store.js';

const WEEK_FILE = /^(\d{4}-W\d{2})\.jsonl$/;
const DAY_MS = 86_400_000;

export interface ArchiveEntry {
  roomId: string;
  room: string;
  archivedAt: number;
  message: ChatMessage;
}

/** `YYYY-MM-DD` of `at` in `timeZone` (UTC when unset or unknown). */
export function zoneDate(at: number, timeZone?: string): string {
  const format = (zone: string) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  try {
    return format(timeZone || 'UTC');
  } catch {
    return format('UTC');
  }
}

/** ISO week `YYYY-Www` of `at` in `timeZone` (weeks start Monday; week 1 holds the year's first Thursday). */
export function zoneWeek(at: number, timeZone?: string): string {
  const [y, m, d] = zoneDate(at, timeZone).split('-').map(Number);
  const day = Date.UTC(y, m - 1, d);
  const thursday = day + (3 - ((new Date(day).getUTCDay() + 6) % 7)) * DAY_MS;
  const year = new Date(thursday).getUTCFullYear();
  const week = 1 + Math.floor((thursday - Date.UTC(year, 0, 1)) / (7 * DAY_MS));
  return `${year}-W${String(week).padStart(2, '0')}`;
}

export class ChatArchive {
  /** Newest archived `at` per room; loaded on the first append. */
  private lastAt: Map<string, number> | undefined;
  /** The zone date of the last gzip sweep. */
  private sweptOn: string | undefined;

  constructor(
    readonly dir: string,
    private readonly compress: (data: Buffer) => Promise<Buffer> = promisify(gzip)
  ) {}

  /**
   * Append each room's dropped messages (oldest first) to its week file, skipping what is already
   * archived. Resolves once the lines are on disk (fsync); throws if they may not be.
   */
  async append(batches: Array<{ room: ChatRoom; messages: ChatMessage[]; week: string }>, now: number, timeZone?: string): Promise<void> {
    const lastAt = await this.load();
    const byWeek = new Map<string, { lines: string[]; newest: Map<string, number> }>();
    for (const { room, messages, week } of batches) {
      const file = byWeek.get(week) ?? { lines: [], newest: new Map<string, number>() };
      for (const message of messages) {
        if (message.at <= (file.newest.get(room.id) ?? lastAt.get(room.id) ?? -Infinity)) continue;
        const entry: ArchiveEntry = { roomId: room.id, room: room.name, archivedAt: now, message };
        file.lines.push(JSON.stringify(entry));
        file.newest.set(room.id, message.at);
      }
      if (file.lines.length) byWeek.set(week, file);
    }
    if (byWeek.size) await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    for (const [week, { lines, newest }] of byWeek) {
      await this.write(join(this.dir, `${week}.jsonl`), `${lines.join('\n')}\n`);
      // Per file: if a later file fails, the retry does not append this one again.
      for (const [id, at] of newest) lastAt.set(id, at);
    }
    try {
      await this.sweep(now, timeZone);
    } catch (err) {
      console.warn('[chat-archive] gzip of ended weeks failed (kept as plain files):', err);
    }
  }

  private async write(file: string, text: string): Promise<void> {
    const handle = await fs.open(file, 'a+', 0o600);
    try {
      const { size } = await handle.stat();
      let lead = '';
      if (size > 0) {
        const last = Buffer.alloc(1);
        await handle.read(last, 0, 1, size - 1);
        if (last[0] !== 0x0a) lead = '\n';
      }
      await handle.appendFile(lead + text);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  /**
   * The chat database's second record (chat-db.ts): append these lines to the week's file and fsync,
   * synchronously, before the database commits the same changes. Throws if they may not be on disk.
   */
  appendSync(week: string, lines: string[]): void {
    if (!lines.length) return;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const fd = openSync(join(this.dir, `${week}.jsonl`), 'a+', 0o600);
    try {
      const { size } = fstatSync(fd);
      let lead = '';
      if (size > 0) {
        const last = Buffer.alloc(1);
        readSync(fd, last, 0, 1, size - 1);
        if (last[0] !== 0x0a) lead = '\n';
      }
      writeSync(fd, `${lead}${lines.join('\n')}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  /** The newest archived `at` per room, from the newest plain week file (only the last append can repeat). */
  private async load(): Promise<Map<string, number>> {
    if (this.lastAt) return this.lastAt;
    const lastAt = new Map<string, number>();
    const newestWeek = (await this.weeks()).at(-1);
    if (newestWeek) {
      for (const line of (await fs.readFile(join(this.dir, newestWeek), 'utf-8')).split('\n')) {
        try {
          const entry = JSON.parse(line) as Partial<ArchiveEntry>;
          const at = entry.message?.at;
          if (typeof entry.roomId === 'string' && typeof at === 'number' && at > (lastAt.get(entry.roomId) ?? -Infinity)) {
            lastAt.set(entry.roomId, at);
          }
        } catch {
          // A torn or blank line.
        }
      }
    }
    this.lastAt = lastAt;
    return lastAt;
  }

  /** Plain week files, oldest first. */
  private async weeks(): Promise<string[]> {
    try {
      return (await fs.readdir(this.dir)).filter((n) => WEEK_FILE.test(n)).sort();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  /** Gzip the plain files of weeks that have ended, at most once per zone day. */
  async sweep(now: number, timeZone?: string): Promise<string[]> {
    const today = zoneDate(now, timeZone);
    if (this.sweptOn === today) return [];
    const thisWeek = zoneWeek(now, timeZone);
    const done: string[] = [];
    for (const name of await this.weeks()) {
      if (WEEK_FILE.exec(name)![1] >= thisWeek) break;
      const plain = join(this.dir, name);
      const packed = `${plain}.gz`;
      if (await exists(packed)) {
        console.warn(`[chat-archive] ${name}.gz already exists; leaving ${name} as it is`);
        continue;
      }
      const tmp = `${packed}.${process.pid}.tmp`;
      const original = await fs.readFile(plain);
      await fs.writeFile(tmp, await this.compress(original), { mode: 0o600, flag: 'wx' });
      const handle = await fs.open(tmp, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      // Read it back: the plain file goes only if the .gz on disk holds exactly its bytes.
      let same = false;
      try {
        same = gunzipSync(await fs.readFile(tmp)).equals(original);
      } catch {
        // Not a readable gzip.
      }
      if (!same) {
        await fs.unlink(tmp);
        console.warn(`[chat-archive] ${name}.gz did not read back to the same bytes; leaving ${name} as it is`);
        continue;
      }
      // An append (appendSync, a room whose owner's zone is still in that week) may have landed since
      // the read: then keep it plain for now. Checked and swapped with no await in between, so no
      // append can fall into the gap.
      if (statSync(plain).size !== original.length) {
        await fs.unlink(tmp);
        console.warn(`[chat-archive] ${name} grew while it was being packed; leaving it as it is`);
        continue;
      }
      renameSync(tmp, packed);
      unlinkSync(plain);
      done.push(name);
    }
    this.sweptOn = today;
    return done;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}
