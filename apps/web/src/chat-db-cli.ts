#!/usr/bin/env node
/**
 * @fileoverview The chat database's maintenance tool (chat-db.ts). Run on the console host:
 *
 *   node dist/chat-db-cli.js smoke
 *       node:sqlite, WAL and FTS5 work in this Node (the deploy check runs it).
 *   node dist/chat-db-cli.js dry-run --data DIR --out NEW.db
 *       import DIR/chatrooms.json + DIR/chat-archive into NEW.db and print the per-room check; nothing
 *       in DIR is touched.
 *   node dist/chat-db-cli.js check --db FILE
 *       integrity check and counts.
 *   node dist/chat-db-cli.js backup --db FILE --out DEST
 *       online backup (never a file copy), then reopened and checked.
 *   node dist/chat-db-cli.js export --db FILE --out ROOMS.json
 *       every room with every message in the chatrooms.json shape (the rollback; the old build archives
 *       what is past its cap on its first save).
 *   node dist/chat-db-cli.js rebuild --archive DIR --out NEW.db [--compare FILE]
 *       a database from the archive files alone, optionally compared with the live one.
 *
 * Output files must not exist; nothing is overwritten. Exit status 1 on any failed check.
 */

import fs from 'node:fs';
import { join } from 'node:path';
import { ChatDb, backupChatDb, compareDbs, importLegacy, rebuildFromArchive, sqlite } from './chat-db.js';

function arg(args: string[], name: string): string {
  const i = args.indexOf(`--${name}`);
  const value = i >= 0 ? args[i + 1] : undefined;
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function smoke(): void {
  const db = new (sqlite().DatabaseSync)(':memory:');
  try {
    db.exec("CREATE VIRTUAL TABLE t USING fts5(text); INSERT INTO t(text) VALUES ('hello durable world');");
    const hit = db.prepare("SELECT snippet(t, 0, '[', ']', '…', 8) AS s FROM t WHERE t MATCH ?").get('"dura"*');
    if (hit?.s !== 'hello [durable] world') throw new Error(`fts5 snippet returned ${JSON.stringify(hit)}`);
  } finally {
    db.close();
  }
  const dir = fs.mkdtempSync(join(process.env.TMPDIR || '/tmp', 'chat-db-smoke-'));
  const file = join(dir, 'smoke.db');
  const db2 = ChatDb.open(file);
  try {
    const mode = db2.db.prepare('PRAGMA journal_mode').get()?.journal_mode;
    if (mode !== 'wal') throw new Error(`journal_mode is ${String(mode)}`);
  } finally {
    db2.close();
  }
  fs.rmSync(dir, { recursive: true });
  console.log(`ok: node ${process.version}, node:sqlite with WAL and FTS5`);
}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  switch (command) {
    case 'smoke':
      smoke();
      return 0;
    case 'dry-run': {
      const data = arg(args, 'data');
      const report = importLegacy({ json: join(data, 'chatrooms.json'), archiveDir: join(data, 'chat-archive'), dbFile: arg(args, 'out') });
      console.log(JSON.stringify(report, null, 2));
      return report.ok ? 0 : 1;
    }
    case 'check': {
      const db = ChatDb.open(arg(args, 'db'));
      try {
        console.log(JSON.stringify({ ok: true, ...db.counts() }));
      } finally {
        db.close();
      }
      return 0;
    }
    case 'backup':
      console.log(JSON.stringify({ ok: true, ...(await backupChatDb(arg(args, 'db'), arg(args, 'out'))) }));
      return 0;
    case 'export': {
      const db = ChatDb.open(arg(args, 'db'));
      try {
        const rooms = db.exportRooms();
        fs.writeFileSync(arg(args, 'out'), JSON.stringify(rooms), { mode: 0o600, flag: 'wx' });
        console.log(JSON.stringify({ ok: true, rooms: rooms.length, messages: rooms.reduce((n, r) => n + r.messages.length, 0) }));
      } finally {
        db.close();
      }
      return 0;
    }
    case 'rebuild': {
      const out = arg(args, 'out');
      const built = rebuildFromArchive(arg(args, 'archive'), out);
      const i = args.indexOf('--compare');
      if (i < 0) {
        console.log(JSON.stringify({ ok: true, ...built }));
        return 0;
      }
      const [a, b] = [ChatDb.open(args[i + 1]), ChatDb.open(out)];
      try {
        const diff = compareDbs(a, b);
        const ok = !diff.rooms.length && !diff.messages.length;
        console.log(JSON.stringify({ ok, ...built, differentRooms: diff.rooms.slice(0, 20), differentMessages: diff.messages.slice(0, 20), differences: diff.rooms.length + diff.messages.length }));
        return ok ? 0 : 1;
      } finally {
        a.close();
        b.close();
      }
    }
    default:
      console.error('usage: chat-db-cli smoke | dry-run --data DIR --out NEW.db | check --db FILE | backup --db FILE --out DEST | export --db FILE --out ROOMS.json | rebuild --archive DIR --out NEW.db [--compare FILE]');
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: Error) => {
    console.error(`chat-db: ${err.message}`);
    process.exit(1);
  }
);
