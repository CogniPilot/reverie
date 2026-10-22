/** Durable delivery identities, separate from the newest-message seen marker. */
import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, renameSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { sqlite, type SqlDatabase } from './chat-db.js';

export interface PendingDelivery {
  id: string;
  sessionId: string;
  roomId: string;
  messageId: string;
  passive: boolean;
  at: number;
  state: 'queued' | 'uncertain';
}

class PendingDeliveryFormatError extends Error {}

export class PendingDeliveryStore {
  private closed = false;

  private constructor(private readonly db: SqlDatabase) {}

  static openRecoverable(file: string): { store: PendingDeliveryStore; quarantined?: string } {
    try {
      return { store: this.open(file) };
    } catch (error) {
      if (!(error instanceof PendingDeliveryFormatError)) throw error;
      const stamp = new Date().toISOString().replace(/[^\dTZ]/g, '');
      const quarantined = `${file}.quarantine-${stamp}-${randomUUID()}`;
      mkdirSync(quarantined, { mode: 0o700 });
      const moved: Array<{ from: string; to: string }> = [];
      try {
        // Move the sidecars with their database; never attach old WAL pages to the replacement.
        for (const suffix of ['-wal', '-shm', '']) {
          const from = `${file}${suffix}`;
          const to = join(quarantined, basename(from));
          try {
            renameSync(from, to);
            moved.push({ from, to });
          } catch (moveError) {
            if ((moveError as NodeJS.ErrnoException).code !== 'ENOENT') throw moveError;
          }
        }
      } catch (moveError) {
        for (const { from, to } of moved.reverse()) renameSync(to, from);
        throw moveError;
      }
      return { store: this.open(file), quarantined };
    }
  }

  /** Read-only validation preserves an unknown database and its WAL before any writable open. */
  private static validate(file: string): void {
    let db: SqlDatabase | undefined;
    try {
      db = new (sqlite().DatabaseSync)(file, { readOnly: true });
      const check = db.prepare('PRAGMA integrity_check').all();
      if (check.length !== 1 || check[0].integrity_check !== 'ok') {
        throw new PendingDeliveryFormatError('Pending deliveries failed integrity check');
      }
      const version = db.prepare('PRAGMA user_version').get()?.user_version;
      if (version !== 0 && version !== 1) throw new PendingDeliveryFormatError('Unsupported pending delivery schema');
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
      if (tables.some((row) => row.name !== 'pending') || (version === 1 && !tables.length)) {
        throw new PendingDeliveryFormatError('Unrecognized pending delivery schema');
      }
      if (tables.length) {
        const columns = db
          .prepare('PRAGMA table_info(pending)')
          .all()
          .map((row) => row.name);
        if (columns.join(',') !== 'id,sessionId,roomId,messageId,passive,at,state') {
          throw new PendingDeliveryFormatError('Unrecognized pending delivery columns');
        }
      }
    } catch (error) {
      const code = (error as { errcode?: number }).errcode;
      if (code === 11 || code === 26)
        throw new PendingDeliveryFormatError('Pending delivery database is corrupt', { cause: error });
      throw error;
    } finally {
      db?.close();
    }
  }

  static open(file: string): PendingDeliveryStore {
    mkdirSync(dirname(file), { recursive: true });
    try {
      closeSync(openSync(file, 'wx', 0o600));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    this.validate(file);
    const db = new (sqlite().DatabaseSync)(file);
    try {
      db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      db.exec(`CREATE TABLE IF NOT EXISTS pending (
        id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, roomId TEXT NOT NULL, messageId TEXT NOT NULL,
        passive INTEGER NOT NULL, at REAL NOT NULL, state TEXT NOT NULL CHECK(state IN ('queued', 'uncertain'))
      );
      CREATE INDEX IF NOT EXISTS pending_session ON pending(sessionId, roomId, messageId);
      PRAGMA user_version = 1;`);
      return new PendingDeliveryStore(db);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  list(): PendingDelivery[] {
    return this.db
      .prepare('SELECT * FROM pending ORDER BY rowid')
      .all()
      .map((row) => ({
        ...row,
        passive: row.passive === 1,
      })) as unknown as PendingDelivery[];
  }

  add(entry: PendingDelivery): void {
    // A limit failure is visible and stops delivery; outstanding receipts are never silently evicted.
    if (Number(this.db.prepare('SELECT count(*) AS n FROM pending').get()?.n) >= 50_000) {
      throw new Error('Pending delivery limit reached; inspect unconfirmed submissions before resuming');
    }
    this.db
      .prepare('INSERT INTO pending VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(entry.id, entry.sessionId, entry.roomId, entry.messageId, Number(entry.passive), entry.at, entry.state);
  }

  state(ids: string[], state: PendingDelivery['state']): void {
    if (this.closed || !ids.length) return;
    this.transaction(() => {
      const update = this.db.prepare('UPDATE pending SET state = ? WHERE id = ?');
      for (const id of ids) update.run(state, id);
    });
  }

  remove(ids: string[]): void {
    if (this.closed || !ids.length) return;
    this.transaction(() => {
      const drop = this.db.prepare('DELETE FROM pending WHERE id = ?');
      for (const id of ids) drop.run(id);
    });
  }

  acknowledge(sessionId: string, roomId: string, messageIds: string[]): void {
    if (this.closed || !messageIds.length) return;
    this.transaction(() => {
      const drop = this.db.prepare('DELETE FROM pending WHERE sessionId = ? AND roomId = ? AND messageId = ?');
      for (const id of messageIds) drop.run(sessionId, roomId, id);
    });
  }

  forget(sessionId?: string, roomId?: string, messageId?: string): void {
    if (this.closed) return;
    const parts: string[] = [];
    const values: string[] = [];
    for (const [key, value] of Object.entries({ sessionId, roomId, messageId })) {
      if (value !== undefined) {
        parts.push(`${key} = ?`);
        values.push(value);
      }
    }
    if (!parts.length) throw new Error('A delivery identity is required');
    this.db.prepare(`DELETE FROM pending WHERE ${parts.join(' AND ')}`).run(...values);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private transaction(action: () => void): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      action();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
