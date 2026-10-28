/**
 * @fileoverview The chat database: every room (members and settings included) and every message, in
 * SQLite (`chat.db` next to chatrooms.json; node:sqlite, WAL, synchronous=FULL, file mode 0600).
 *
 * The service keeps working on the in-memory store (chatroom-store.ts) with a recent window of each
 * room's messages; `sync()` writes what changed since the last sync in one transaction and returns
 * only once it is committed, so a change is on disk before the request that made it is answered.
 * Messages that leave the window stay in the database (nothing is deleted, not even the messages of a
 * deleted room). What changed is diffed against the JSON last written, so no mutation site needs to
 * know about the database.
 *
 * Tables: `rooms(id, data)` holds a room without its messages, `messages(room_id, id, at, data)` a
 * message as stored (poll, reactions, edits, the deleted flag and upload refs live in `data`), and
 * `messages_fts` the searchable text of every message that is not deleted (its rowid is the
 * message's rowid).
 *
 * The importer (first start, and the dry run) builds a database from chatrooms.json plus the weekly
 * archive files and checks it against them before anything switches.
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import type { ChatMessage, ChatRoom } from './chatroom-store.js';

export const CHAT_DB_SCHEMA_VERSION = 1;

// node:sqlite has no types in this @types/node; only what is used here.
interface SqlStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Array<Record<string, unknown>>;
  iterate(...params: unknown[]): IterableIterator<Record<string, unknown>>;
}
export interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
}
interface SqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqlDatabase;
  backup(source: SqlDatabase, destination: string): Promise<number>;
}

let sqliteModule: SqliteModule | undefined;
export function sqlite(): SqliteModule {
  return (sqliteModule ??= createRequire(import.meta.url)('node:sqlite') as SqliteModule);
}

export class ChatDbError extends Error {}

/**
 * A sync that wrote nothing to the database. `journaled`: its lines (all carrying one `txn`) did
 * reach the archive files, so a `void` line for that txn must follow.
 */
export class ChatDbSyncError extends ChatDbError {
  constructor(
    message: string,
    readonly changes: SyncChanges,
    readonly journaled: boolean,
    options?: { cause?: unknown }
  ) {
    super(message, options);
  }
}

/** A room row: the room without its messages. */
export type RoomRow = Omit<ChatRoom, 'messages'>;

/**
 * One line of the weekly archive files (chat-archive.ts): a message as it was at `archivedAt`, a room,
 * or a room's removal. Lines journaled by one database sync share a `txn`; a `void` line says that
 * sync's commit failed, so readers skip its lines (lines from before the database have no txn).
 */
export type JournalLine =
  | { kind?: 'message'; txn?: string; roomId: string; room: string; archivedAt: number; message: ChatMessage }
  | { kind: 'room'; txn?: string; roomId: string; archivedAt: number; data: RoomRow }
  | { kind: 'room-deleted'; txn?: string; roomId: string; archivedAt: number }
  | { kind: 'void'; txn: string; archivedAt: number };

/** The lines that stand: those of voided txns (and the void lines) left out. */
export function standingLines(lines: readonly JournalLine[]): Array<Exclude<JournalLine, { kind: 'void' }>> {
  const voided = new Set(lines.flatMap((l) => (l.kind === 'void' ? [l.txn] : [])));
  return lines.filter((l): l is Exclude<JournalLine, { kind: 'void' }> => l.kind !== 'void' && !(l.txn && voided.has(l.txn)));
}

export interface SyncChanges {
  rooms: RoomRow[];
  messages: Array<{ room: ChatRoom; message: ChatMessage }>;
  deletedRooms: string[];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages(room_id TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(room_id, id));
CREATE INDEX IF NOT EXISTS messages_room_at ON messages(room_id, at, id);
CREATE INDEX IF NOT EXISTS messages_owner_notice ON messages(room_id, at DESC, id DESC)
  WHERE json_extract(data, '$.from.kind') = 'user'
    AND json_extract(data, '$.from.mark') IN ('owner_typed', 'owner_spoken');
CREATE INDEX IF NOT EXISTS messages_notice_reply ON messages(room_id, json_extract(data, '$.replyTo'), at, id)
  WHERE json_extract(data, '$.from.kind') = 'agent' AND json_extract(data, '$.replyTo') IS NOT NULL;
CREATE TABLE IF NOT EXISTS txns(id TEXT PRIMARY KEY);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, sender, tokenize = 'unicode61 remove_diacritics 2');
`;

function roomRow(room: ChatRoom): RoomRow {
  const { messages: _messages, ...row } = room;
  return row;
}

/** Create `file` 0600 before SQLite does (its own default follows the umask; the -wal and -shm files copy the file's mode). */
function createPrivate(file: string): void {
  try {
    fs.closeSync(fs.openSync(file, 'wx', 0o600));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
}

export class ChatDb {
  /** The JSON last written per room row, and per message (by room); what `sync()` diffs against. */
  private readonly savedRooms = new Map<string, string>();
  private readonly savedMessages = new Map<string, Map<string, string>>();
  private readonly upsertMessage: SqlStatement;
  private readonly upsertRoom: SqlStatement;

  private constructor(
    readonly file: string,
    readonly db: SqlDatabase
  ) {
    this.upsertMessage = db.prepare(
      'INSERT INTO messages(room_id, id, at, data) VALUES (?, ?, ?, ?) ON CONFLICT(room_id, id) DO UPDATE SET at = excluded.at, data = excluded.data RETURNING rowid'
    );
    this.upsertRoom = db.prepare('INSERT INTO rooms(id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data');
  }

  /**
   * Open (or create) the database. Refuses a file that fails SQLite's integrity check, or one written
   * by a newer schema: the console must not run on data it cannot trust.
   */
  static open(file: string): ChatDb {
    createPrivate(file);
    const db = new (sqlite().DatabaseSync)(file);
    try {
      db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      const check = db.prepare('PRAGMA integrity_check').all();
      if (check.length !== 1 || check[0].integrity_check !== 'ok') {
        throw new ChatDbError(`chat database ${file} failed its integrity check: ${JSON.stringify(check.slice(0, 5))}`);
      }
      // Refuse a newer database before installing this build's additive indexes.
      // A fresh database has no meta table until SCHEMA is installed below.
      if (db.prepare("SELECT 1 AS hit FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get()) {
        const existingVersion = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value;
        if (existingVersion !== undefined && Number(existingVersion) > CHAT_DB_SCHEMA_VERSION)
          throw new ChatDbError(`chat database ${file} has schema ${existingVersion}; this build knows ${CHAT_DB_SCHEMA_VERSION}`);
      }
      db.exec(SCHEMA);
      const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value;
      if (version === undefined) {
        db.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', ?)").run(String(CHAT_DB_SCHEMA_VERSION));
      } else if (Number(version) > CHAT_DB_SCHEMA_VERSION) {
        throw new ChatDbError(`chat database ${file} has schema ${version}; this build knows ${CHAT_DB_SCHEMA_VERSION}`);
      }
    } catch (err) {
      db.close();
      if (err instanceof ChatDbError) throw err;
      throw new ChatDbError(`chat database ${file} could not be opened: ${(err as Error).message}`);
    }
    return new ChatDb(file, db);
  }

  close(): void {
    this.db.close();
  }

  /** Those of `ids` whose sync committed. */
  committedTxns(ids: Iterable<string>): Set<string> {
    const has = this.db.prepare('SELECT 1 AS hit FROM txns WHERE id = ?');
    return new Set([...ids].filter((id) => has.get(id) !== undefined));
  }

  /** Indexed owner-source discovery, not an unbounded history walk. Budget is shared across rooms. */
  noticeHistory(roomId: string, budget: { rows: number; bytes: number }, before?: { at: number; id: string }):
    { messages: ChatMessage[]; replies: ChatMessage[]; complete: boolean; before?: { at: number; id: string } } {
    const messages: ChatMessage[] = [], replies: ChatMessage[] = [];
    const owner = this.db.prepare(`SELECT data FROM messages INDEXED BY messages_owner_notice WHERE room_id = ?
      AND json_extract(data, '$.from.kind') = 'user'
      AND json_extract(data, '$.from.mark') IN ('owner_typed', 'owner_spoken')
      ${before ? 'AND (at, id) < (?, ?)' : ''} ORDER BY at DESC, id DESC LIMIT ?`);
    let complete = true;
    const take = (rows: IterableIterator<Record<string, unknown>>, into: ChatMessage[]) => {
      for (const row of rows) {
        const raw = String(row.data), bytes = Buffer.byteLength(raw);
        if (budget.rows <= 0 || bytes > budget.bytes) { complete = false; break; }
        budget.rows--; budget.bytes -= bytes;
        into.push(JSON.parse(raw) as ChatMessage);
      }
    };
    const ownerLimit = Math.min(1000, Math.max(0, budget.rows));
    take(owner.iterate(roomId, ...(before ? [before.at, before.id] : []), ownerLimit + 1), messages);
    const next = !complete ? (messages.length ? { at: messages.at(-1)!.at, id: messages.at(-1)!.id } : before) : undefined;
    if (messages.length) {
      const answers = this.db.prepare(`SELECT data FROM messages INDEXED BY messages_notice_reply WHERE room_id = ?
        AND json_extract(data, '$.from.kind') = 'agent' AND json_extract(data, '$.replyTo') IS NOT NULL
        AND json_extract(data, '$.replyTo') IN (SELECT value FROM json_each(?)) LIMIT ?`);
      take(answers.iterate(roomId, JSON.stringify(messages.map(m => m.id)), Math.min(1000, Math.max(0, budget.rows)) + 1), replies);
    }
    return { messages, replies, complete, ...(next ? { before: next } : {}) };
  }

  /** Every room, each with its newest `window` messages (oldest first); what the store starts from. */
  loadRooms(window: number): ChatRoom[] {
    const recent = this.db.prepare('SELECT data FROM (SELECT data, at, id FROM messages WHERE room_id = ? ORDER BY at DESC, id DESC LIMIT ?) ORDER BY at, id');
    const rooms: ChatRoom[] = [];
    for (const { id, data } of this.db.prepare('SELECT id, data FROM rooms').all()) {
      const room = { ...(JSON.parse(data as string) as RoomRow), messages: [] as ChatMessage[] } as ChatRoom;
      const saved = new Map<string, string>();
      for (const row of recent.all(id, window)) {
        const message = JSON.parse(row.data as string) as ChatMessage;
        room.messages.push(message);
        saved.set(message.id, JSON.stringify(message));
      }
      this.savedRooms.set(room.id, JSON.stringify(roomRow(room)));
      this.savedMessages.set(room.id, saved);
      rooms.push(room);
    }
    return rooms;
  }

  /**
   * Write what changed in `rooms` since the last sync, in one transaction; `journal` (the archive's
   * second copy) sees the changes first, and if it throws nothing is written. Once committed, each
   * room's messages past `window` leave memory (they stay in the database). With `touched`, only those
   * rooms are compared (a full compare stringifies every message held); removed rooms are always found.
   * `txn` (the id on the journaled lines) is recorded in the same transaction, so after a crash or a
   * failed void the archive's txns can be checked against what was committed. Returns the changes.
   */
  sync(rooms: readonly ChatRoom[], window: number, journal?: (changes: SyncChanges) => void, touched?: ReadonlySet<string>, txn?: string): SyncChanges {
    const changes: SyncChanges = { rooms: [], messages: [], deletedRooms: [] };
    const roomJson = new Map<string, string>();
    const messageJson: string[] = [];
    const live = new Set<string>();
    for (const room of rooms) {
      live.add(room.id);
      if (touched && !touched.has(room.id)) continue;
      const row = roomRow(room);
      const json = JSON.stringify(row);
      if (this.savedRooms.get(room.id) !== json) {
        changes.rooms.push(row);
        roomJson.set(room.id, json);
      }
      const saved = this.savedMessages.get(room.id);
      for (const message of room.messages) {
        const json = JSON.stringify(message);
        if (saved?.get(message.id) !== json) {
          changes.messages.push({ room, message });
          messageJson.push(json);
        }
      }
    }
    for (const id of this.savedRooms.keys()) if (!live.has(id)) changes.deletedRooms.push(id);

    if (changes.rooms.length || changes.messages.length || changes.deletedRooms.length) {
      try {
        journal?.(changes);
      } catch (err) {
        throw new ChatDbSyncError(`chat archive append failed: ${(err as Error).message}`, changes, false, { cause: err });
      }
      const dropFts = this.db.prepare('DELETE FROM messages_fts WHERE rowid = ?');
      const addFts = this.db.prepare('INSERT INTO messages_fts(rowid, text, sender) VALUES (?, ?, ?)');
      const deleteRoom = this.db.prepare('DELETE FROM rooms WHERE id = ?');
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const row of changes.rooms) this.upsertRoom.run(row.id, roomJson.get(row.id));
        changes.messages.forEach(({ room, message }, i) => {
          const rowid = this.upsertMessage.get(room.id, message.id, message.at, messageJson[i])!.rowid;
          dropFts.run(rowid);
          if (!message.deleted) addFts.run(rowid, message.text ?? '', message.from.name ?? '');
        });
        // The room goes; its messages stay (nothing is deleted).
        for (const id of changes.deletedRooms) deleteRoom.run(id);
        if (txn) this.db.prepare('INSERT INTO txns(id) VALUES (?)').run(txn);
        this.db.exec('COMMIT');
      } catch (err) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          // Already rolled back.
        }
        throw new ChatDbSyncError(`chat database commit failed: ${(err as Error).message}`, changes, true, { cause: err });
      }
      for (const [id, json] of roomJson) this.savedRooms.set(id, json);
      changes.messages.forEach(({ room, message }, i) => {
        let saved = this.savedMessages.get(room.id);
        if (!saved) this.savedMessages.set(room.id, (saved = new Map()));
        saved.set(message.id, messageJson[i]);
      });
      for (const id of changes.deletedRooms) {
        this.savedRooms.delete(id);
        this.savedMessages.delete(id);
      }
    }

    for (const room of rooms) {
      if (touched && !touched.has(room.id)) continue;
      const over = room.messages.length - window;
      if (over <= 0) continue;
      const saved = this.savedMessages.get(room.id);
      for (const message of room.messages.splice(0, over)) saved?.delete(message.id);
    }
    return changes;
  }

  /** The rooms as last committed, each with the messages memory held then: what memory goes back to when a sync fails. */
  committed(): ChatRoom[] {
    return [...this.savedRooms].map(([id, json]) => {
      const messages = [...(this.savedMessages.get(id)?.values() ?? [])].map((m) => JSON.parse(m) as ChatMessage);
      messages.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return { ...(JSON.parse(json) as RoomRow), messages } as ChatRoom;
    });
  }

  /** Every room with all of its messages, oldest first: the JSON shape of chatrooms.json (export, rollback). */
  exportRooms(): ChatRoom[] {
    const all = this.db.prepare('SELECT data FROM messages WHERE room_id = ? ORDER BY at, id');
    return this.db
      .prepare('SELECT data FROM rooms')
      .all()
      .map((r) => ({ ...(JSON.parse(r.data as string) as RoomRow), messages: all.all((JSON.parse(r.data as string) as RoomRow).id).map((m) => JSON.parse(m.data as string) as ChatMessage) }) as ChatRoom)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Room rows and message rows, as stored, keyed for comparison (rebuild and backup checks). */
  contents(): { rooms: Map<string, string>; messages: Map<string, string> } {
    const rooms = new Map<string, string>();
    for (const r of this.db.prepare('SELECT id, data FROM rooms').all()) rooms.set(r.id as string, r.data as string);
    const messages = new Map<string, string>();
    for (const m of this.db.prepare('SELECT room_id, id, data FROM messages').all()) messages.set(`${m.room_id as string}/${m.id as string}`, m.data as string);
    return { rooms, messages };
  }

  counts(): { rooms: number; messages: number } {
    return {
      rooms: Number(this.db.prepare('SELECT count(*) AS n FROM rooms').get()!.n),
      messages: Number(this.db.prepare('SELECT count(*) AS n FROM messages').get()!.n),
    };
  }
}

// ─── Archive files ───────────────────────────────────────────────────────────

const ARCHIVE_FILE = /^\d{4}-W\d{2}\.jsonl(\.gz)?$/;

/**
 * Every line of the archive files, in the order the changes happened (archivedAt, then file order);
 * unreadable lines are counted, not fatal. `plainOnly`: only the weeks not yet gzipped.
 */
export function readArchive(dir: string, opts: { plainOnly?: boolean } = {}): { lines: JournalLine[]; torn: number } {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => ARCHIVE_FILE.test(n) && !(opts.plainOnly && n.endsWith('.gz'))).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { lines: [], torn: 0 };
    throw err;
  }
  const lines: JournalLine[] = [];
  let torn = 0;
  for (const name of names) {
    const raw = fs.readFileSync(join(dir, name));
    const text = (name.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf-8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as JournalLine;
        if (typeof entry?.archivedAt !== 'number') throw new Error('not an archive line');
        if (entry.kind === 'void') {
          if (typeof entry.txn !== 'string') throw new Error('no txn');
          lines.push(entry);
          continue;
        }
        if (typeof entry.roomId !== 'string') throw new Error('not an archive line');
        if ((entry.kind === undefined || entry.kind === 'message') && typeof entry.message?.id !== 'string') throw new Error('no message');
        if (entry.kind === 'room' && typeof entry.data?.id !== 'string') throw new Error('no room');
        lines.push(entry);
      } catch {
        torn++;
      }
    }
  }
  // Stable: lines written at the same moment keep their file order.
  lines.sort((a, b) => a.archivedAt - b.archivedAt);
  return { lines, torn };
}

// ─── Import (first start and the dry run) ────────────────────────────────────

export interface ImportRoomReport {
  id: string;
  name: string;
  members: number;
  /** Messages in chatrooms.json / in the archive files / in the new database. */
  json: number;
  archive: number;
  db: number;
  ok: boolean;
}

export interface ImportReport {
  ok: boolean;
  problems: string[];
  rooms: ImportRoomReport[];
  /** Archive messages whose room is gone: imported (nothing is dropped), shown in no room. */
  orphanMessages: number;
  tornLines: number;
  totals: { rooms: number; messages: number };
}

/**
 * Build a database at `dbFile` (must not exist) from chatrooms.json and the archive files, then check
 * it against them: the same rooms, each room's members and settings exactly, and each room's message
 * ids exactly (the archive's copies and the file's, a message in both counted once; the file's copy
 * wins, it is the newer). The database is left at `dbFile` either way; the caller switches only on `ok`.
 */
export function importLegacy(opts: { json: string; archiveDir: string; dbFile: string }): ImportReport {
  const problems: string[] = [];
  let rooms: ChatRoom[] = [];
  let raw: string | undefined;
  try {
    raw = fs.readFileSync(opts.json, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (raw !== undefined) {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new ChatDbError(`${opts.json} is not a list of rooms`);
    rooms = parsed as ChatRoom[];
    for (const r of rooms) {
      if (!r || typeof r.id !== 'string' || !Array.isArray(r.members) || !Array.isArray(r.messages)) {
        throw new ChatDbError(`${opts.json} holds a room this importer does not understand: ${JSON.stringify(r).slice(0, 120)}`);
      }
    }
  }
  if (fs.existsSync(opts.dbFile)) throw new ChatDbError(`${opts.dbFile} already exists`);

  const { lines, torn } = readArchive(opts.archiveDir);
  // What must end up in the database, per room: archive copies first, then the file's (newer) ones.
  const expected = new Map<string, Map<string, ChatMessage>>();
  const put = (roomId: string, m: ChatMessage) => {
    let byId = expected.get(roomId);
    if (!byId) expected.set(roomId, (byId = new Map()));
    byId.set(m.id, m);
  };
  const archiveCount = new Map<string, Set<string>>();
  for (const line of standingLines(lines)) {
    if (line.kind !== undefined && line.kind !== 'message') continue;
    put(line.roomId, line.message);
    let ids = archiveCount.get(line.roomId);
    if (!ids) archiveCount.set(line.roomId, (ids = new Set()));
    ids.add(line.message.id);
  }
  for (const room of rooms) for (const m of room.messages) put(room.id, m);

  const db = ChatDb.open(opts.dbFile);
  try {
    const insertRoom = db.db.prepare('INSERT INTO rooms(id, data) VALUES (?, ?)');
    const insertMessage = db.db.prepare('INSERT INTO messages(room_id, id, at, data) VALUES (?, ?, ?, ?) RETURNING rowid');
    const addFts = db.db.prepare('INSERT INTO messages_fts(rowid, text, sender) VALUES (?, ?, ?)');
    db.db.exec('BEGIN IMMEDIATE');
    try {
      for (const room of rooms) insertRoom.run(room.id, JSON.stringify(roomRow(room)));
      for (const [roomId, byId] of expected) {
        for (const m of [...byId.values()].sort((a, b) => a.at - b.at)) {
          const rowid = insertMessage.get(roomId, m.id, m.at, JSON.stringify(m))!.rowid;
          if (!m.deleted) addFts.run(rowid, m.text ?? '', m.from?.name ?? '');
        }
      }
      db.db.exec('COMMIT');
    } catch (err) {
      db.db.exec('ROLLBACK');
      throw err;
    }

    // Read back and compare.
    const { rooms: dbRooms, messages: dbMessages } = db.contents();
    const report: ImportRoomReport[] = [];
    const dbIdsByRoom = new Map<string, string[]>();
    for (const key of dbMessages.keys()) {
      const cut = key.indexOf('/');
      const roomId = key.slice(0, cut);
      let list = dbIdsByRoom.get(roomId);
      if (!list) dbIdsByRoom.set(roomId, (list = []));
      list.push(key.slice(cut + 1));
    }
    for (const room of rooms) {
      const want = [...(expected.get(room.id)?.keys() ?? [])].sort();
      const got = (dbIdsByRoom.get(room.id) ?? []).sort();
      const sameRoom = dbRooms.get(room.id) === JSON.stringify(roomRow(room));
      const sameIds = want.length === got.length && want.every((id, i) => id === got[i]);
      const fileIds = new Set(room.messages.map((m) => m.id));
      if (fileIds.size !== room.messages.length) problems.push(`room ${room.id} (${room.name}): chatrooms.json repeats a message id`);
      if (!sameRoom) problems.push(`room ${room.id} (${room.name}): room row differs from chatrooms.json`);
      if (!sameIds) problems.push(`room ${room.id} (${room.name}): ${got.length} message ids in the database, ${want.length} expected`);
      report.push({
        id: room.id,
        name: room.name,
        members: room.members.length,
        json: room.messages.length,
        archive: archiveCount.get(room.id)?.size ?? 0,
        db: got.length,
        ok: sameRoom && sameIds && fileIds.size === room.messages.length,
      });
    }
    if (dbRooms.size !== rooms.length) problems.push(`${dbRooms.size} rooms in the database, ${rooms.length} in chatrooms.json`);
    const roomIds = new Set(rooms.map((r) => r.id));
    let orphanMessages = 0;
    for (const [roomId, byId] of expected) {
      if (roomIds.has(roomId)) continue;
      orphanMessages += byId.size;
      if ((dbIdsByRoom.get(roomId)?.length ?? 0) !== byId.size) problems.push(`archived messages of removed room ${roomId}: not all imported`);
    }
    const totals = db.counts();
    const expectedTotal = [...expected.values()].reduce((n, byId) => n + byId.size, 0);
    if (totals.messages !== expectedTotal) problems.push(`${totals.messages} messages in the database, ${expectedTotal} expected`);
    return { ok: problems.length === 0, problems, rooms: report, orphanMessages, tornLines: torn, totals };
  } finally {
    db.close();
  }
}

/**
 * A database rebuilt from the archive files alone (the second record): rooms and messages replayed in
 * order, the last copy of each winning. Written to `dbFile` (must not exist).
 */
export function rebuildFromArchive(archiveDir: string, dbFile: string): { rooms: number; messages: number; tornLines: number } {
  if (fs.existsSync(dbFile)) throw new ChatDbError(`${dbFile} already exists`);
  const { lines, torn } = readArchive(archiveDir);
  const rooms = new Map<string, RoomRow>();
  const messages = new Map<string, Map<string, ChatMessage>>();
  for (const line of standingLines(lines)) {
    if (line.kind === 'room') rooms.set(line.roomId, line.data);
    else if (line.kind === 'room-deleted') rooms.delete(line.roomId);
    else {
      let byId = messages.get(line.roomId);
      if (!byId) messages.set(line.roomId, (byId = new Map()));
      byId.set(line.message.id, line.message);
    }
  }
  const db = ChatDb.open(dbFile);
  try {
    const insertRoom = db.db.prepare('INSERT INTO rooms(id, data) VALUES (?, ?)');
    const insertMessage = db.db.prepare('INSERT INTO messages(room_id, id, at, data) VALUES (?, ?, ?, ?) RETURNING rowid');
    const addFts = db.db.prepare('INSERT INTO messages_fts(rowid, text, sender) VALUES (?, ?, ?)');
    db.db.exec('BEGIN IMMEDIATE');
    for (const row of rooms.values()) insertRoom.run(row.id, JSON.stringify(row));
    for (const [roomId, byId] of messages) {
      for (const m of [...byId.values()].sort((a, b) => a.at - b.at)) {
        const rowid = insertMessage.get(roomId, m.id, m.at, JSON.stringify(m))!.rowid;
        if (!m.deleted) addFts.run(rowid, m.text ?? '', m.from?.name ?? '');
      }
    }
    db.db.exec('COMMIT');
    return { ...db.counts(), tornLines: torn };
  } finally {
    db.close();
  }
}

/** Where two databases differ, as row keys (empty when the same rooms and messages are stored byte for byte). */
export function compareDbs(a: ChatDb, b: ChatDb): { rooms: string[]; messages: string[] } {
  const x = a.contents();
  const y = b.contents();
  const diff = (p: Map<string, string>, q: Map<string, string>) => {
    const out: string[] = [];
    for (const [k, v] of p) if (q.get(k) !== v) out.push(k);
    for (const k of q.keys()) if (!p.has(k)) out.push(k);
    return out;
  };
  return { rooms: diff(x.rooms, y.rooms), messages: diff(x.messages, y.messages) };
}

/**
 * A backup of the live database at `dest` (0600) with SQLite's online backup (never a file copy: a
 * copy taken mid-write can be torn), then checked: it opens, passes the integrity check, and holds
 * every room and at least every message the source held when the backup started.
 */
export async function backupChatDb(source: string, dest: string): Promise<{ rooms: number; messages: number }> {
  if (fs.existsSync(dest)) throw new ChatDbError(`${dest} already exists`);
  // Opening creates a missing file: a wrong path must fail, not back up a new empty database.
  if (!fs.existsSync(source)) throw new ChatDbError(`no chat database at ${source}`);
  const src = ChatDb.open(source);
  let before: { rooms: number; messages: number };
  try {
    before = src.counts();
    createPrivate(dest);
    await sqlite().backup(src.db, dest);
  } finally {
    src.close();
  }
  fs.chmodSync(dest, 0o600);
  const copy = ChatDb.open(dest);
  try {
    const after = copy.counts();
    if (after.messages < before.messages) throw new ChatDbError(`backup ${dest} holds ${after.messages} messages; the source held ${before.messages}`);
    return after;
  } finally {
    copy.close();
  }
}
