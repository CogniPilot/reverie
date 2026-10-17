/**
 * The chat archive: messages past the per-room cap go to chat-archive/YYYY-Www.jsonl (ISO week in the
 * company zone) before the room drops them; a failed append keeps them; a restart after an append that
 * the rooms file never caught up with does not write them twice; ended weeks are gzipped, never deleted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { ChatroomService } from '../src/chatroom-service.js';
import { MAX_MESSAGES_PER_ROOM, loadChatrooms, type ChatMessage, type ChatRoom } from '../src/chatroom-store.js';
import { ChatArchive, zoneWeek, type ArchiveEntry } from '../src/chat-archive.js';

// Monday 2026-10-19 02:00 UTC is still Sunday Oct 18 in New York: week 42 there, week 43 in UTC.
const NOW = Date.UTC(2026, 9, 19, 2, 0);
const WEEK = '2026-W42';
const ZONE = 'America/New_York';

let dir: string;
let file: string;
let archiveDir: string;
let warn: ReturnType<typeof vi.spyOn>;

function service(clock = NOW): ChatroomService {
  return new ChatroomService({
    file,
    archiveDir,
    getSession: () => undefined,
    broadcast: () => {},
    now: () => clock,
    timeZone: () => ZONE,
  });
}

function fill(s: ChatroomService, roomId: string, n: number, from = 0): void {
  for (let i = from; i < from + n; i++) s.post(roomId, { kind: 'user' }, `m${i}`, 'all', { deliver: false });
}

function lines(path: string): ArchiveEntry[] {
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as ArchiveEntry);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chat-archive-'));
  file = join(dir, 'chatrooms.json');
  archiveDir = join(dir, 'chat-archive');
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

describe('chat archive', () => {
  it('names ISO weeks in the zone', () => {
    expect(zoneWeek(NOW, ZONE)).toBe(WEEK);
    expect(zoneWeek(NOW, 'UTC')).toBe('2026-W43');
    expect(zoneWeek(Date.UTC(2027, 0, 1, 12), ZONE)).toBe('2026-W53');
    expect(zoneWeek(Date.UTC(2024, 11, 30, 12), ZONE)).toBe('2025-W01');
    expect(zoneWeek(NOW, 'Not/AZone')).toBe('2026-W43');
    // The year turn: Sunday 2027-01-03 23:59 EST is still 2026-W53; Monday 00:00 is 2027-W01.
    expect(zoneWeek(Date.UTC(2027, 0, 4, 4, 59), ZONE)).toBe('2026-W53');
    expect(zoneWeek(Date.UTC(2027, 0, 4, 5, 0), ZONE)).toBe('2027-W01');
  });

  it('a drop just before and just after Monday 00:00 in the zone lands in two week files', async () => {
    // Sunday Oct 25 23:59:59 EDT, then Monday Oct 26 00:00:01 EDT.
    const before = Date.UTC(2026, 9, 26, 3, 59, 59);
    const after = Date.UTC(2026, 9, 26, 4, 0, 1);
    const s = service(before);
    await s.init();
    const room = s.createRoom('busy', undefined);
    fill(s, room.id, MAX_MESSAGES_PER_ROOM + 1);
    await s.stop();
    const next = service(after);
    await next.init();
    fill(next, room.id, 1, 7000);
    await next.stop();
    // W43 ended with the Monday append, so that append's daily sweep gzipped it.
    const w43 = gunzipSync(readFileSync(join(archiveDir, '2026-W43.jsonl.gz'))).toString().split('\n').filter(Boolean);
    expect(w43.map((l) => (JSON.parse(l) as ArchiveEntry).message.text)).toEqual(['m0']);
    expect(lines(join(archiveDir, '2026-W44.jsonl')).map((e) => e.message.text)).toEqual(['m1']);
  });

  it('a retry after one week file failed does not append the other again', async () => {
    // W41 points into a missing directory, so its append fails after W42's has landed (W42, the
    // newest file, exists and is empty so the first load reads it).
    mkdirSync(archiveDir, { mode: 0o700 });
    writeFileSync(join(archiveDir, '2026-W42.jsonl'), '', { mode: 0o600 });
    symlinkSync(join(dir, 'missing', 'x.jsonl'), join(archiveDir, '2026-W41.jsonl'));
    const archive = new ChatArchive(archiveDir);
    const msg = (id: string, at: number) => ({ id, roomId: id, at, from: { kind: 'user' }, to: 'all', text: id }) as ChatMessage;
    const a = { id: 'room-a', name: 'a' } as ChatRoom;
    const b = { id: 'room-b', name: 'b' } as ChatRoom;
    const batches = [
      { room: a, messages: [msg('room-a', 1)], week: '2026-W42' },
      { room: b, messages: [msg('room-b', 1)], week: '2026-W41' },
    ];
    await expect(archive.append(batches, NOW, ZONE)).rejects.toThrow();
    expect(lines(join(archiveDir, '2026-W42.jsonl'))).toHaveLength(1);
    mkdirSync(join(dir, 'missing'));
    await archive.append(batches, NOW, ZONE);
    expect(lines(join(archiveDir, '2026-W42.jsonl'))).toHaveLength(1);
    expect(lines(join(dir, 'missing', 'x.jsonl'))).toHaveLength(1);
  });

  it('archives what the cap drops, in the company-zone week file, private', async () => {
    const s = service();
    await s.init();
    const room = s.createRoom('busy', undefined);
    fill(s, room.id, MAX_MESSAGES_PER_ROOM + 3);
    await s.stop();

    const day = join(archiveDir, `${WEEK}.jsonl`);
    const archived = lines(day);
    expect(archived.map((e) => e.message.text)).toEqual(['m0', 'm1', 'm2']);
    expect(archived[0]).toMatchObject({ roomId: room.id, room: 'busy', archivedAt: NOW });
    expect(statSync(day).mode & 0o777).toBe(0o600);
    expect(statSync(archiveDir).mode & 0o777).toBe(0o700);

    const [saved] = await loadChatrooms(file);
    expect(saved.messages).toHaveLength(MAX_MESSAGES_PER_ROOM);
    expect(saved.messages[0].text).toBe('m3');
  });

  it('keeps the messages past the cap when the archive cannot be written, and archives them once it can', async () => {
    writeFileSync(archiveDir, 'not a directory');
    const s = service();
    await s.init();
    const room = s.createRoom('busy', undefined);
    fill(s, room.id, MAX_MESSAGES_PER_ROOM + 2);
    await s.stop();

    expect((await loadChatrooms(file))[0].messages).toHaveLength(MAX_MESSAGES_PER_ROOM + 2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('archive failed; keeping 2 message(s)'), expect.anything());

    // Fixed: the next save archives all of them, then drops them.
    const { rmSync } = await import('node:fs');
    rmSync(archiveDir);
    const again = service();
    await again.init();
    fill(again, room.id, 1, 9000);
    await again.stop();
    expect(lines(join(archiveDir, `${WEEK}.jsonl`)).map((e) => e.message.text)).toEqual(['m0', 'm1', 'm2']);
    expect((await loadChatrooms(file))[0].messages).toHaveLength(MAX_MESSAGES_PER_ROOM);
  });

  it('does not repeat lines after a restart whose rooms file missed the drop', async () => {
    const s = service();
    await s.init();
    const room = s.createRoom('busy', undefined);
    fill(s, room.id, MAX_MESSAGES_PER_ROOM + 3);
    await s.stop();
    const day = join(archiveDir, `${WEEK}.jsonl`);
    expect(lines(day)).toHaveLength(3);

    // A crash after the append but before the rooms file was written: the file still holds the three.
    const [saved] = await loadChatrooms(file);
    const before: ChatMessage[] = lines(day).map((e) => e.message);
    writeFileSync(file, JSON.stringify([{ ...saved, messages: [...before, ...saved.messages] } satisfies ChatRoom]));

    const restarted = service(NOW + 60_000);
    await restarted.init();
    fill(restarted, room.id, 1, 5000);
    await restarted.stop();

    const archived = lines(day);
    expect(archived.map((e) => e.message.text)).toEqual(['m0', 'm1', 'm2', 'm3']);
    expect(new Set(archived.map((e) => e.message.id)).size).toBe(4);
    expect((await loadChatrooms(file))[0].messages).toHaveLength(MAX_MESSAGES_PER_ROOM);
  });

  it('ends a torn last line before appending', async () => {
    mkdirSync(archiveDir, { mode: 0o700 });
    const day = join(archiveDir, `${WEEK}.jsonl`);
    writeFileSync(day, '{"roomId":"r","mess', { mode: 0o600 });
    const s = service();
    await s.init();
    const room = s.createRoom('busy', undefined);
    fill(s, room.id, MAX_MESSAGES_PER_ROOM + 1);
    await s.stop();
    const raw = readFileSync(day, 'utf-8').split('\n');
    expect(raw[0]).toBe('{"roomId":"r","mess');
    expect((JSON.parse(raw[1]) as ArchiveEntry).message.text).toBe('m0');
  });

  it('gzips weeks that have ended, keeps the current week plain, and never overwrites a .gz', async () => {
    mkdirSync(archiveDir, { mode: 0o700 });
    const old = join(archiveDir, '2026-W41.jsonl');
    const kept = join(archiveDir, `${WEEK}.jsonl`);
    const clash = join(archiveDir, '2026-W40.jsonl');
    writeFileSync(old, '{"a":1}\n', { mode: 0o600 });
    writeFileSync(kept, '{"b":1}\n', { mode: 0o600 });
    writeFileSync(clash, '{"c":1}\n', { mode: 0o600 });
    writeFileSync(`${clash}.gz`, 'existing');

    const archive = new ChatArchive(archiveDir);
    expect(await archive.sweep(NOW, ZONE)).toEqual(['2026-W41.jsonl']);
    expect(gunzipSync(readFileSync(`${old}.gz`)).toString()).toBe('{"a":1}\n');
    expect(statSync(`${old}.gz`).mode & 0o777).toBe(0o600);
    expect(existsSync(old)).toBe(false);
    expect(readFileSync(kept, 'utf-8')).toBe('{"b":1}\n');
    expect(readFileSync(clash, 'utf-8')).toBe('{"c":1}\n');
    expect(readFileSync(`${clash}.gz`, 'utf-8')).toBe('existing');
    expect(readdirSync(archiveDir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    // Once a day.
    expect(await archive.sweep(NOW + 1000, ZONE)).toEqual([]);
  });

  it('keeps the plain file when the .gz does not read back to the same bytes', async () => {
    mkdirSync(archiveDir, { mode: 0o700 });
    const old = join(archiveDir, '2026-W41.jsonl');
    writeFileSync(old, '{"a":1}\n', { mode: 0o600 });
    const { gzipSync } = await import('node:zlib');
    const archive = new ChatArchive(archiveDir, async () => gzipSync(Buffer.from('{"a":2}\n')));
    expect(await archive.sweep(NOW, ZONE)).toEqual([]);
    expect(readFileSync(old, 'utf-8')).toBe('{"a":1}\n');
    expect(readdirSync(archiveDir)).toEqual(['2026-W41.jsonl']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('did not read back'));
  });
});
