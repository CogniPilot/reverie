/**
 * @fileoverview Recall from the old memory store matches the python bridge it replaces. The fixture was produced by the
 * unmodified python reference: synthetic stores, a pinned clock and a fake embedding service; it records the exact rows
 * (hashed embeddings by digest) and what `python -m reverie.memory_cli` printed or failed with.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sqlite } from '../src/chat-db.js';
import { legacyRecall, parsePyJson, dumpPyJson, RECALL_LIMITS } from '../src/legacy-recall.js';
import { hashedEmbedder } from '../src/memory-embed.js';

interface FixtureRow {
  id: number;
  embedding: string | { hashed: string } | null;
  [column: string]: unknown;
}
interface FixtureCase {
  id: string;
  instance: Record<string, unknown> | null;
  state_in_home: string | null;
  columns: string | null;
  schema: string;
  state: Record<string, string> | null;
  legacy_history: string | null;
  embed: 'service' | 'down' | null;
  request: { query: string; project?: string };
  refuses: boolean;
  private?: FixtureRow[];
  project?: { id: string; rows: FixtureRow[] };
  expect: { code: number; stdout: string; stderr: string };
}
const fixture = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'legacy-recall-reference.json'), 'utf8')
) as {
  now: number;
  projectSchema: string;
  cases: FixtureCase[];
};
const LEGACY_COLUMN = Buffer.from('6a696e785f74657874', 'hex').toString('ascii');
const COLUMNS = [
  'id',
  'kind',
  'created_at',
  'user_text',
  'assistant_text',
  'text',
  'importance',
  'importance_source',
  'embed_model',
  'embedding',
  'source_ids',
  'section',
  'meta',
  'last_accessed',
];

/** The fake embedding service the reference used: the first eight bytes of sha256(input), each b/255 - 0.5. */
const fake = (input: string) =>
  [...createHash('sha256').update(input, 'utf8').digest().subarray(0, 8)].map((b) => b / 255 - 0.5);
let service: http.Server;
let serviceUrl = '';
beforeAll(async () => {
  service = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [{ embedding: fake((JSON.parse(body) as { input: string }).input) }] }));
    });
  });
  await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve));
  serviceUrl = `http://127.0.0.1:${(service.address() as AddressInfo).port}/v1`;
});
afterAll(() => new Promise<void>((resolve) => service.close(() => resolve())));

async function blob(row: FixtureRow): Promise<Uint8Array | null> {
  if (row.embedding === null) return null;
  if (typeof row.embedding === 'string') return Buffer.from(row.embedding, 'hex');
  const vector = await hashedEmbedder(1024).embed(row.text as string);
  const packed = Buffer.from(new Float32Array(vector).buffer);
  expect(createHash('sha256').update(packed).digest('hex'), `hashed embedding of row ${row.id}`).toBe(
    row.embedding.hashed
  );
  return packed;
}

async function build(
  file: string,
  schema: string,
  rows: FixtureRow[],
  columns: string | null,
  state: Record<string, string> | null
) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new (sqlite().DatabaseSync)(file);
  db.exec(schema.replaceAll('<legacy-assistant-column>', LEGACY_COLUMN));
  for (const row of rows) {
    const names = COLUMNS.filter((c) => !(c === 'assistant_text' && columns === 'none'));
    const values: unknown[] = [];
    for (const c of names) values.push(c === 'embedding' ? await blob(row) : row[c]);
    const sqlNames = names.map((c) => (c === 'assistant_text' && columns === 'legacy' ? LEGACY_COLUMN : c));
    db.prepare(`INSERT INTO memories (${sqlNames.join(',')}) VALUES (${sqlNames.map(() => '?').join(',')})`).run(
      ...(values as never[])
    );
  }
  for (const [key, value] of Object.entries(state ?? {}))
    db.prepare('INSERT INTO state (key, value) VALUES (?, ?)').run(key, value);
  db.close();
}

async function run(c: FixtureCase): Promise<{ text?: string; error?: string }> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-recall-')));
  try {
    const home = path.join(root, 'home');
    const config = path.join(root, 'config', 'agent.json');
    fs.mkdirSync(home);
    fs.mkdirSync(path.dirname(config));
    if (c.instance) fs.writeFileSync(config, JSON.stringify(c.instance));
    const state = c.state_in_home ? path.join(home, c.state_in_home) : path.join(root, 'state');
    fs.mkdirSync(state, { recursive: true });
    if (c.private) await build(path.join(state, 'memory.sqlite'), c.schema, c.private, c.columns, c.state);
    if (c.project)
      await build(
        path.join(state, 'projects', c.project.id, 'memory.sqlite'),
        fixture.projectSchema,
        c.project.rows,
        null,
        null
      );
    if (c.legacy_history !== null) fs.writeFileSync(path.join(state, 'legacy-history.json'), c.legacy_history);
    const embedUrl = c.embed === 'service' ? serviceUrl : c.embed === 'down' ? 'http://127.0.0.1:1/v1' : '';
    try {
      return { text: await legacyRecall(config, c.request, { home, embedUrl, now: () => fixture.now }) };
    } catch (error) {
      return { error: (error as Error).message.replaceAll(root, '<root>') };
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('parity with the python bridge', () => {
  for (const c of fixture.cases.filter((x) => !x.refuses)) {
    it(c.id, async () => {
      const got = await run(c);
      if (c.expect.code === 0) expect(got).toEqual({ text: c.expect.stdout.trim() });
      else expect(got).toEqual({ error: (JSON.parse(c.expect.stderr.trim()) as { error: string }).error });
    });
  }
});

describe('named differences', () => {
  it('refuses, instead of importing, when a legacy-history.json would still add episodes before ranking', async () => {
    const pending = fixture.cases.find((c) => c.refuses)!;
    expect(pending.expect.code).toBe(0); // python imported it on the spot and wrote the episodes
    expect((await run(pending)).error).toMatch(/legacy-history\.json that was never imported/);
  });

  it('never writes to the store it reads', async () => {
    const c = fixture.cases.find((x) => x.id === 'private-stale-reembedded-hashed')!;
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-recall-ro-')));
    try {
      const config = path.join(root, 'config', 'agent.json');
      fs.mkdirSync(path.dirname(config), { recursive: true });
      fs.writeFileSync(config, JSON.stringify(c.instance));
      const db = path.join(root, 'state', 'memory.sqlite');
      await build(db, c.schema, c.private!, null, null);
      const before = fs.readFileSync(db);
      fs.chmodSync(db, 0o444);
      await legacyRecall(config, c.request, { home: root, now: () => fixture.now });
      expect(fs.readFileSync(db).equals(before)).toBe(true);
      expect(fs.readdirSync(path.join(root, 'state')).sort()).toEqual(['memory.sqlite']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('answers [] for a missing store without creating it or the state directory', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-recall-none-')));
    try {
      const config = path.join(root, 'config', 'agent.json');
      fs.mkdirSync(path.dirname(config), { recursive: true });
      fs.writeFileSync(
        config,
        JSON.stringify({ id: 'a1', agent_name: 'A', owner_name: 'O', data_dir: '../state', persona: 'p' })
      );
      expect(await legacyRecall(config, { query: 'q' }, { home: root })).toBe('[]');
      expect(await legacyRecall(config, { query: 'q', project: 'p1' }, { home: root })).toBe('[]');
      expect(fs.existsSync(path.join(root, 'state'))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('bounds the rows it reads and the service re-embeds it makes', () => {
    expect(RECALL_LIMITS.rows).toBeGreaterThan(0);
    expect(RECALL_LIMITS.serviceReembeds).toBeGreaterThan(0);
  });
});

describe("python's json", () => {
  it('keeps int and float kinds through a round trip, as json.loads then json.dumps does', () => {
    expect(
      dumpPyJson(
        parsePyJson(
          '{"a": 1, "b": 1.0, "c": 1e2, "d": -0, "e": 12345678901234567890123, "f": [1.5e-7, "x\\u0001\\"y"], "a": 2}'
        )
      )
    ).toBe('{"a": 2, "b": 1.0, "c": 100.0, "d": 0, "e": 12345678901234567890123, "f": [1.5e-07, "x\\u0001\\"y"]}');
  });
});
