/**
 * The chat database: rooms and messages in SQLite, committed before the call returns, copied to the
 * archive files (the second record), imported once from chatrooms.json and the archive, refused when
 * it fails its integrity check, rebuildable from the archive, and backed up with SQLite's backup.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, statSync, writeFileSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { ChatroomService } from '../src/chatroom-service.js';
import { MAX_MESSAGES_PER_ROOM, type ChatMessage, type ChatRoom } from '../src/chatroom-store.js';
import { ChatDb, backupChatDb, compareDbs, importLegacy, readArchive, rebuildFromArchive, standingLines } from '../src/chat-db.js';
import { ChatArchive } from '../src/chat-archive.js';
import { ChatFileStore } from '../src/chatroom-files.js';
import { registerChatroomRoutes } from '../src/web/routes/chatroom-routes.js';
import { createRouteTestHarness } from './routes/_route-test-utils.js';
import { startWebOrExit } from '../src/cli.js';

const NOW = Date.UTC(2026, 9, 17, 18, 0);
const ZONE = 'America/New_York';

let dir: string;
let file: string;
let dbFile: string;
let archiveDir: string;
let clock: number;
let errors: ReturnType<typeof vi.spyOn>;
let routed: ChatroomService;
let alerts: string[];

function service(): ChatroomService {
  return new ChatroomService({
    file,
    database: dbFile,
    archiveDir,
    getSession: () => undefined,
    broadcast: () => {},
    now: () => clock++,
    timeZone: () => ZONE,
    alert: (text) => {
      alerts.push(text);
    },
  });
}

function msg(roomId: string, id: string, at: number, text = id): ChatMessage {
  return { id, roomId, at, from: { kind: 'user', name: 'James' }, to: 'all', text };
}

function legacyRoom(id: string, messages: ChatMessage[], extra: Partial<ChatRoom> = {}): ChatRoom {
  return { id, name: `room-${id}`, createdAt: 1, userReadAt: 0, members: [{ sessionId: 's1', role: 'member', joinedAt: 1 } as never], messages, ...extra };
}

function open<T>(path: string, fn: (db: ChatDb) => T): T {
  const db = ChatDb.open(path);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chat-db-'));
  file = join(dir, 'chatrooms.json');
  dbFile = join(dir, 'chat.db');
  archiveDir = join(dir, 'chat-archive');
  clock = NOW;
  alerts = [];
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('chat database', () => {
  it('keeps rooms, members and every kind of message change across a restart', async () => {
    const s = service();
    await s.init();
    const room = s.createRoom('plans', undefined);
    const a = s.post(room.id, { kind: 'user', name: 'James' }, 'first', 'all', { deliver: false });
    const b = s.post(room.id, { kind: 'user', name: 'James' }, 'second', 'all', { deliver: false });
    s.react(room.id, a.id, '👍', 'user');
    await s.deleteMessage(room.id, b.id, 'user');
    s.renameRoom(room.id, 'plans-2');
    const before = JSON.parse(JSON.stringify(s.rooms())) as ChatRoom[];
    await s.stop();

    const again = service();
    await again.init();
    expect(again.rooms()).toEqual(before);
    expect(again.rooms()[0].messages[0].reactions).toEqual({ '👍': ['user'] });
    expect(again.rooms()[0].messages[1].deleted).toBeTruthy();
    await again.stop();
    expect(existsSync(file)).toBe(false);
  });

  it('commits a post before post() returns, and the file is private', async () => {
    const s = service();
    await s.init();
    const room = s.createRoom('now', undefined);
    const m = s.post(room.id, { kind: 'user', name: 'James' }, 'durable', 'all', { deliver: false });
    // No await, no timer: another connection already sees it.
    expect(open(dbFile, (db) => db.contents().messages.has(`${room.id}/${m.id}`))).toBe(true);
    expect(statSync(dbFile).mode & 0o777).toBe(0o600);
    for (const extra of ['-wal', '-shm']) if (existsSync(dbFile + extra)) expect(statSync(dbFile + extra).mode & 0o777).toBe(0o600);
    // The second record has it too.
    expect(readArchive(archiveDir).lines.some((l) => l.kind === undefined && l.message.id === m.id)).toBe(true);
    await s.stop();
  });

  it('holds a window of each room in memory and every message in the database', async () => {
    const s = service();
    await s.init();
    const room = s.createRoom('busy', undefined);
    for (let i = 0; i < MAX_MESSAGES_PER_ROOM + 5; i++) s.post(room.id, { kind: 'user', name: 'James' }, `m${i}`, 'all', { deliver: false });
    expect(s.rooms()[0].messages).toHaveLength(MAX_MESSAGES_PER_ROOM);
    expect(s.rooms()[0].messages[0].text).toBe('m5');
    await s.stop();
    expect(open(dbFile, (db) => db.counts().messages)).toBe(MAX_MESSAGES_PER_ROOM + 5);
    const exported = open(dbFile, (db) => db.exportRooms());
    expect(exported[0].messages.map((m) => m.text).slice(0, 2)).toEqual(['m0', 'm1']);
    const again = service();
    await again.init();
    expect(again.rooms()[0].messages[0].text).toBe('m5');
    expect(again.rooms()[0].messages.at(-1)!.text).toBe(`m${MAX_MESSAGES_PER_ROOM + 4}`);
    await again.stop();
  });

  it('imports chatrooms.json and the archive (plain and gzipped, duplicates once) and checks them', async () => {
    writeFileSync(file, JSON.stringify([legacyRoom('r1', [msg('r1', 'c', 30), msg('r1', 'd', 40)]), legacyRoom('r2', [msg('r2', 'x', 5)])]), { mode: 0o600 });
    mkdirSync(archiveDir, { mode: 0o700 });
    const line = (roomId: string, m: ChatMessage) => JSON.stringify({ roomId, room: `room-${roomId}`, archivedAt: 50, message: m });
    writeFileSync(join(archiveDir, '2026-W40.jsonl.gz'), gzipSync(`${line('r1', msg('r1', 'a', 10))}\n${line('gone', msg('gone', 'g', 1))}\n`));
    // 'c' is also still in the file (a crash between append and save): counted once, the file's copy wins.
    writeFileSync(join(archiveDir, '2026-W41.jsonl'), `${line('r1', msg('r1', 'b', 20))}\n${line('r1', msg('r1', 'c', 30, 'old'))}\n{"torn`);

    const s = service();
    await s.init();
    const [r1, r2] = s.rooms();
    expect(r1.messages.map((m) => m.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(r1.messages[2].text).toBe('c');
    expect(r2.messages.map((m) => m.id)).toEqual(['x']);
    await s.stop();

    expect(open(dbFile, (db) => db.counts())).toEqual({ rooms: 2, messages: 6 });
    // The baseline adds only what the archive did not already hold as imported: 'c' (newer in the file), 'd', 'x'.
    const baseline = readArchive(archiveDir).lines.flatMap((l) => (l.kind === undefined && l.archivedAt >= NOW ? [l.message.id] : []));
    expect(baseline.sort()).toEqual(['c', 'd', 'x']);
    const frozen = join(dir, `chatrooms.pre-sqlite-${NOW}.json`);
    expect(statSync(frozen).mode & 0o777).toBe(0o600);
    expect(readFileSync(frozen, 'utf-8')).toBe(readFileSync(file, 'utf-8'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining(`rollback copy: ${frozen}`));
    // The archive alone now rebuilds the same database.
    rebuildFromArchive(archiveDir, join(dir, 'rebuilt.db'));
    const diff = open(dbFile, (live) => open(join(dir, 'rebuilt.db'), (rebuilt) => compareDbs(live, rebuilt)));
    expect(diff).toEqual({ rooms: [], messages: [] });
  });

  it('a dry run reports per room and touches nothing it reads', () => {
    writeFileSync(file, JSON.stringify([legacyRoom('r1', [msg('r1', 'a', 1), msg('r1', 'b', 2)])]));
    const report = importLegacy({ json: file, archiveDir, dbFile: join(dir, 'dry.db') });
    expect(report).toMatchObject({ ok: true, problems: [], totals: { rooms: 1, messages: 2 }, rooms: [{ id: 'r1', json: 2, archive: 0, db: 2, ok: true }] });
    expect(existsSync(dbFile)).toBe(false);
    expect(existsSync(archiveDir)).toBe(false);
  });

  it('an import that does not match stays on chatrooms.json and keeps the rejected database aside', async () => {
    // The same id twice in one room: the database can hold it once, so the check fails.
    writeFileSync(file, JSON.stringify([legacyRoom('r1', [msg('r1', 'a', 1), msg('r1', 'a', 2)])]));
    const s = service();
    await s.init();
    expect(s.rooms()[0].messages).toHaveLength(2);
    expect(existsSync(dbFile)).toBe(false);
    expect(readdirSync(dir).some((n) => n.startsWith('chat.db.rejected-'))).toBe(true);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('did not match'), expect.arrayContaining([expect.stringContaining('repeats a message id')]));
    await s.stop();
    // Days on chatrooms.json later, a fixed file imports: the copy the log names is the one it imported, not the first attempt's.
    writeFileSync(file, JSON.stringify([legacyRoom('r1', [msg('r1', 'a', 1), msg('r1', 'b', 2)])]));
    clock = NOW + 3 * 86_400_000;
    const later = service();
    await later.init();
    await later.stop();
    const frozen = join(dir, `chatrooms.pre-sqlite-${NOW + 3 * 86_400_000}.json`);
    expect(readFileSync(frozen, 'utf-8')).toBe(readFileSync(file, 'utf-8'));
    expect(readFileSync(join(dir, `chatrooms.pre-sqlite-${NOW}.json`), 'utf-8')).not.toBe(readFileSync(file, 'utf-8'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining(`rollback copy: ${frozen}`));
  });

  it('refuses to start on a database that fails its integrity check', async () => {
    const s = service();
    await s.init();
    const room = s.createRoom('r', undefined);
    for (let i = 0; i < 300; i++) s.post(room.id, { kind: 'user', name: 'James' }, `filler ${i} ${'x'.repeat(200)}`, 'all', { deliver: false });
    await s.stop();
    // An index that no longer matches its table: the file opens and reads, only the check sees it.
    open(dbFile, (db) =>
      db.db.exec(`PRAGMA writable_schema = ON;
        UPDATE sqlite_schema SET sql = 'CREATE INDEX messages_room_at ON messages(room_id, id, at)' WHERE name = 'messages_room_at';
        PRAGMA writable_schema = OFF;`)
    );
    await expect(service().init()).rejects.toThrow(/failed its integrity check/);
    // Where it shows: one clear log line naming the file and the way back.
    expect(errors).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^\\[chatroom\\] REFUSING TO START: chat database ${dbFile} failed its integrity check.*chat-db-cli.js rebuild`)));
    // And a push to the owner's devices, sent before the console exits.
    expect(alerts).toEqual(['Chat did not start: its database failed a check. Nothing was changed. The console log has the recovery steps.']);
  });

  it('a start refused on the chat database ends the console with exit status 1', async () => {
    const s = service();
    await s.init();
    const room = s.createRoom('r', undefined);
    for (let i = 0; i < 300; i++) s.post(room.id, { kind: 'user', name: 'James' }, `filler ${i} ${'x'.repeat(200)}`, 'all', { deliver: false });
    await s.stop();
    open(dbFile, (db) =>
      db.db.exec(`PRAGMA writable_schema = ON;
        UPDATE sqlite_schema SET sql = 'CREATE INDEX messages_room_at ON messages(room_id, id, at)' WHERE name = 'messages_room_at';
        PRAGMA writable_schema = OFF;`)
    );
    const exits: number[] = [];
    const exit = ((code: number) => {
      exits.push(code);
      throw new Error('exited');
    }) as (code: number) => never;
    // The same wrapper `reverie web` starts the server with.
    await expect(startWebOrExit(() => service().init(), exit)).rejects.toThrow('exited');
    expect(exits).toEqual([1]);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('Failed to start web server: chat database'));
    // A start that works does not exit.
    await expect(startWebOrExit(async () => 'up', exit)).resolves.toBe('up');
    expect(exits).toEqual([1]);
  });

  it('rebuilds from the archive files to exactly the database: edits (twice), reactions, polls, deletes, room deletes', async () => {
    const s = service();
    await s.init();
    const keep = s.createRoom('keep', undefined);
    const gone = s.createRoom('gone', undefined);
    const m = s.post(keep.id, { kind: 'user', name: 'James' }, 'hello', 'all', { deliver: false });
    const doomed = s.post(keep.id, { kind: 'user', name: 'James' }, 'oops', 'all', { deliver: false });
    s.post(gone.id, { kind: 'user', name: 'James' }, 'bye', 'all', { deliver: false });
    s.react(keep.id, m.id, '✅', 'user');
    s.react(keep.id, m.id, '👀', 'user');
    s.react(keep.id, m.id, '✅', 'user');
    // An edit, then an edit of the edited message.
    await s.editMessage(keep.id, m.id, 'hello there', 'user');
    await s.editMessage(keep.id, m.id, 'hello again', 'user');
    // Committed by the edit itself, not by a later change to the room.
    expect(open(dbFile, (db) => db.exportRooms().find((r) => r.id === keep.id)!.messages.find((x) => x.id === m.id)!.text)).toBe('hello again');
    const poll = s.createPoll(keep.id, { kind: 'user', name: 'James' }, { question: 'Which?', options: ['one', 'two'] });
    s.votePoll(keep.id, poll.id, 'user', ['1']);
    s.votePoll(keep.id, poll.id, 'user', ['2']);
    await s.closePoll(keep.id, poll.id, 'user');
    await s.deleteMessage(keep.id, doomed.id, 'user');
    s.renameRoom(keep.id, 'kept');
    await s.deleteRoom(gone.id);
    const final = s.rooms()[0].messages;
    await s.stop();

    expect(final.find((x) => x.id === poll.id)!.poll).toMatchObject({ closed: { by: 'user' } });
    expect(final.find((x) => x.id === m.id)!.reactions).toEqual({ '👀': ['user'] });
    expect(final.find((x) => x.id === m.id)!.text).toBe('hello again');
    expect(final.find((x) => x.id === doomed.id)!.deleted).toBeTruthy();
    expect(open(dbFile, (db) => db.counts())).toEqual({ rooms: 1, messages: 4 });
    rebuildFromArchive(archiveDir, join(dir, 'rebuilt.db'));
    expect(open(dbFile, (live) => open(join(dir, 'rebuilt.db'), (rebuilt) => compareDbs(live, rebuilt)))).toEqual({ rooms: [], messages: [] });
  });

  it('a commit that fails leaves nothing in memory or the database, the archive undone, and a retry lands', async () => {
    const s = service();
    await s.init();
    const room = s.createRoom('r', undefined);
    s.post(room.id, { kind: 'user', name: 'James' }, 'kept', 'all', { deliver: false });
    const db = (s as unknown as { db: ChatDb }).db;
    const exec = db.db.exec.bind(db.db);
    let fail = true;
    db.db.exec = (sql: string) => {
      if (sql === 'COMMIT' && fail) {
        fail = false;
        throw new Error('disk I/O error');
      }
      return exec(sql);
    };
    expect(() => s.post(room.id, { kind: 'user', name: 'James' }, 'lost', 'all', { deliver: false })).toThrow(
      expect.objectContaining({ code: 'UNAVAILABLE' })
    );
    expect(s.rooms()[0].messages.map((m) => m.text)).toEqual(['kept']);
    expect(s.room(room.id)).toBe(s.rooms()[0]);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('commit failed'), expect.anything());
    // A failed rename goes back too.
    fail = true;
    expect(() => s.renameRoom(room.id, 'renamed')).toThrow(expect.objectContaining({ code: 'UNAVAILABLE' }));
    expect(s.rooms()[0].name).toBe('r');

    s.post(room.id, { kind: 'user', name: 'James' }, 'again', 'all', { deliver: false });
    await s.stop();
    const again = service();
    await again.init();
    expect(again.rooms()[0].messages.map((m) => m.text)).toEqual(['kept', 'again']);
    expect(again.rooms()[0].name).toBe('r');
    await again.stop();
    // The archive had the lost post and the rename, each under a txn that a void line then cancels.
    const lines = readArchive(archiveDir).lines;
    const voided = lines.flatMap((l) => (l.kind === 'void' ? [l.txn] : []));
    expect(voided).toHaveLength(2);
    expect(lines.some((l) => l.kind === undefined && l.message.text === 'lost' && l.txn === voided[0])).toBe(true);
    expect(standingLines(lines).some((l) => l.kind === undefined && l.message.text === 'lost')).toBe(false);
    rebuildFromArchive(archiveDir, join(dir, 'rebuilt.db'));
    expect(open(dbFile, (live) => open(join(dir, 'rebuilt.db'), (rebuilt) => compareDbs(live, rebuilt)))).toEqual({ rooms: [], messages: [] });
  });

  it('if the void line cannot be written either, writes stop (fail closed) and reads go on', async () => {
    const s = service();
    await s.init();
    const room = s.createRoom('r', undefined);
    s.post(room.id, { kind: 'user', name: 'James' }, 'kept', 'all', { deliver: false });
    const db = (s as unknown as { db: ChatDb }).db;
    const archive = (s as unknown as { archive: ChatArchive }).archive;
    const exec = db.db.exec.bind(db.db);
    db.db.exec = (sql: string) => {
      if (sql === 'COMMIT') throw new Error('disk I/O error');
      return exec(sql);
    };
    const append = archive.appendSync.bind(archive);
    archive.appendSync = (week: string, lines: string[]) => {
      if (lines.some((l) => l.includes('"kind":"void"'))) throw new Error('ENOSPC');
      append(week, lines);
    };
    expect(() => s.post(room.id, { kind: 'user', name: 'James' }, 'lost', 'all', { deliver: false })).toThrow(expect.objectContaining({ code: 'UNAVAILABLE' }));
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('WRITES CLOSED'), expect.anything());
    await vi.waitFor(() => expect(alerts).toEqual([expect.stringMatching(/^Chat is read-only/)]));
    // The disk is fine again, but the archive still holds an unvoided txn: no more writes until a restart.
    db.db.exec = exec;
    archive.appendSync = append;
    expect(() => s.post(room.id, { kind: 'user', name: 'James' }, 'later', 'all', { deliver: false })).toThrow(/read-only until the console restarts/);
    expect(s.rooms()[0].messages.map((m) => m.text)).toEqual(['kept']);
    expect(s.view(s.rooms()[0]).messages.map((m) => m.text)).toEqual(['kept']);
    await s.stop();
    expect(open(dbFile, (d) => d.counts().messages)).toBe(1);
    // Before the restart, a rebuild would bring back the lost post.
    const lost = readArchive(archiveDir).lines.find((l) => l.kind === undefined && l.message.text === 'lost')!;
    expect(standingLines(readArchive(archiveDir).lines)).toContainEqual(lost);

    // The restart voids that txn (the database never committed it), logs it, and writes open again.
    errors.mockClear();
    const restarted = service();
    await restarted.init();
    expect(errors).toHaveBeenCalledWith(expect.stringContaining(`voided 1 archive txn(s) the database never committed (writes closed or a crash mid-commit): ${lost.txn}`));
    restarted.post(room.id, { kind: 'user', name: 'James' }, 'after restart', 'all', { deliver: false });
    await restarted.stop();
    const lines = readArchive(archiveDir).lines;
    expect(lines.filter((l) => l.kind === 'void').map((l) => l.txn)).toEqual([lost.txn]);
    expect(standingLines(lines)).not.toContainEqual(lost);
    rebuildFromArchive(archiveDir, join(dir, 'rebuilt.db'));
    expect(open(dbFile, (live) => open(join(dir, 'rebuilt.db'), (rebuilt) => compareDbs(live, rebuilt)))).toEqual({ rooms: [], messages: [] });
    expect(open(join(dir, 'rebuilt.db'), (d) => d.counts().messages)).toBe(2);

    // A committed txn is never voided, and a second restart finds nothing to void.
    errors.mockClear();
    const third = service();
    await third.init();
    await third.stop();
    expect(errors).not.toHaveBeenCalledWith(expect.stringContaining('voided'));
    expect(readArchive(archiveDir).lines.filter((l) => l.kind === 'void')).toHaveLength(1);
  });

  it('a void that still cannot be written at start keeps writes closed', async () => {
    const s = service();
    await s.init();
    const room = s.createRoom('r', undefined);
    const db = (s as unknown as { db: ChatDb }).db;
    const exec = db.db.exec.bind(db.db);
    db.db.exec = (sql: string) => {
      if (sql === 'BEGIN IMMEDIATE') throw new Error('database is locked');
      return exec(sql);
    };
    const archive = (s as unknown as { archive: ChatArchive }).archive;
    const append = archive.appendSync.bind(archive);
    archive.appendSync = (week: string, lines: string[]) => {
      if (lines.some((l) => l.includes('"kind":"void"'))) throw new Error('ENOSPC');
      append(week, lines);
    };
    expect(() => s.post(room.id, { kind: 'user', name: 'James' }, 'lost', 'all', { deliver: false })).toThrow(expect.objectContaining({ code: 'UNAVAILABLE' }));
    db.close();

    // The disk is still full at the restart.
    const spy = vi.spyOn(ChatArchive.prototype, 'appendSync').mockImplementation(() => {
      throw new Error('ENOSPC');
    });
    errors.mockClear();
    const restarted = service();
    await restarted.init();
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('WRITES CLOSED: the archive has txn(s)'), expect.anything());
    await vi.waitFor(() => expect(alerts.at(-1)).toMatch(/^Chat is read-only/));
    expect(() => restarted.post(room.id, { kind: 'user', name: 'James' }, 'x', 'all', { deliver: false })).toThrow(/read-only until the console restarts/);
    spy.mockRestore();
    await restarted.stop();
  });

  it('compares only the room that changed, and a change made without naming its room is still committed at stop', async () => {
    const s = service();
    await s.init();
    const a = s.createRoom('a', undefined);
    const b = s.createRoom('b', undefined);
    s.post(b.id, { kind: 'user', name: 'James' }, 'in b', 'all', { deliver: false });
    const stringify = vi.spyOn(JSON, 'stringify');
    s.post(a.id, { kind: 'user', name: 'James' }, 'in a', 'all', { deliver: false });
    expect(stringify.mock.calls.some(([v]) => (v as ChatMessage)?.text === 'in b')).toBe(false);
    stringify.mockRestore();
    // A change with no persist naming its room (as a missed call site would be).
    s.rooms().find((r) => r.id === b.id)!.messages[0].text = 'edited quietly';
    s.post(a.id, { kind: 'user', name: 'James' }, 'again in a', 'all', { deliver: false });
    expect(open(dbFile, (d) => d.exportRooms().find((r) => r.id === b.id)!.messages[0].text)).toBe('in b');
    await s.stop();
    expect(open(dbFile, (d) => d.exportRooms().find((r) => r.id === b.id)!.messages[0].text)).toBe('edited quietly');
  });

  it('a post whose commit fails answers 503', async () => {
    const harness = await createRouteTestHarness((fastify, c) => {
      routed = new ChatroomService({ file, database: dbFile, archiveDir, getSession: (id) => c.sessions.get(id), broadcast: () => {}, now: () => clock++ });
      registerChatroomRoutes(fastify, c, routed, new ChatFileStore(mkdtempSync(join(tmpdir(), 'chatfiles-'))));
    });
    await routed.init();
    const room = routed.createRoom('r', undefined);
    const db = (routed as unknown as { db: ChatDb }).db;
    db.db.exec = () => {
      throw new Error('disk full');
    };
    const res = await harness.app.inject({ method: 'POST', url: `/api/chatrooms/${room.id}/messages`, payload: { text: 'hi' } });
    expect(res.statusCode).toBe(503);
    expect(routed.rooms()[0].messages).toEqual([]);
    await routed.stop();
    await harness.app.close();
  });

  it('backs up with SQLite backup; the backup opens, is private and equals the source', async () => {
    const s = service();
    await s.init();
    const room = s.createRoom('r', undefined);
    for (let i = 0; i < 20; i++) s.post(room.id, { kind: 'user', name: 'James' }, `m${i}`, 'all', { deliver: false });
    const dest = join(dir, 'backup.db');
    // Taken while the service has it open.
    expect(await backupChatDb(dbFile, dest)).toEqual({ rooms: 1, messages: 20 });
    await s.stop();
    expect(statSync(dest).mode & 0o777).toBe(0o600);
    expect(open(dbFile, (live) => open(dest, (copy) => compareDbs(live, copy)))).toEqual({ rooms: [], messages: [] });
    await expect(backupChatDb(dbFile, dest)).rejects.toThrow(/already exists/);
  });

  it('loses no acknowledged post when the process is killed (kill -9) mid-write', async () => {
    const child = join(dir, 'writer.mts');
    writeFileSync(
      child,
      `import { ChatroomService } from ${JSON.stringify(resolve('src/chatroom-service.ts'))};
const s = new ChatroomService({ file: ${JSON.stringify(file)}, database: ${JSON.stringify(dbFile)}, archiveDir: ${JSON.stringify(archiveDir)}, getSession: () => undefined, broadcast: () => {} });
await s.init();
const room = s.createRoom('crash', undefined);
for (let i = 0; ; i++) {
  const m = s.post(room.id, { kind: 'user', name: 'James' }, 'n' + i + ' ' + 'y'.repeat(500), 'all', { deliver: false });
  process.stdout.write('id ' + m.id + '\\n');
}
`
    );
    const acked = await new Promise<string[]>((done, fail) => {
      const proc = spawn(process.execPath, ['--import', 'tsx', child], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      proc.stdout.on('data', (d: Buffer) => {
        out += d.toString();
        if (out.split('\nid ').length > 400) proc.kill('SIGKILL');
      });
      proc.on('error', fail);
      proc.on('exit', () => done(out.split('\n').flatMap((l) => (l.startsWith('id ') ? [l.slice(3)] : []))));
    });
    expect(acked.length).toBeGreaterThanOrEqual(400);
    const stored = open(dbFile, (db) => db.contents().messages);
    const roomId = [...stored.keys()][0].split('/')[0];
    expect(acked.filter((id) => !stored.has(`${roomId}/${id}`))).toEqual([]);
    // The second record has every acknowledged post as well.
    const archived = new Set(readArchive(archiveDir).lines.flatMap((l) => (l.kind === undefined ? [l.message.id] : [])));
    expect(acked.filter((id) => !archived.has(id))).toEqual([]);
  }, 60_000);

  it('the gzip sweep leaves a week file alone if a line was appended while it was being packed', async () => {
    mkdirSync(archiveDir, { mode: 0o700 });
    const old = join(archiveDir, '2026-W40.jsonl');
    writeFileSync(old, '{"a":1}\n', { mode: 0o600 });
    const archive = new ChatArchive(archiveDir, async (data) => {
      // A room still in week 40 in its owner's zone appends meanwhile.
      new ChatArchive(archiveDir).appendSync('2026-W40', ['{"b":2}']);
      return gzipSync(data);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await archive.sweep(NOW, ZONE)).toEqual([]);
    expect(readFileSync(old, 'utf-8')).toBe('{"a":1}\n{"b":2}\n');
    expect(readdirSync(archiveDir)).toEqual(['2026-W40.jsonl']);
  });
});
