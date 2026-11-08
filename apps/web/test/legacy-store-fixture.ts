/**
 * @fileoverview The synthetic old memory stores of the legacy recall reference, built exactly as the python reference
 * built them: the fixture, its rows and the fake embedding service. Shared by the recall and `reverie agent memory` tests.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { expect } from 'vitest';
import { sqlite } from '../src/chat-db.js';
import { hashedEmbedder } from '../src/memory-embed.js';

export interface FixtureRow {
  id: number;
  embedding: string | { hashed: string } | null;
  [column: string]: unknown;
}
export interface FixtureCase {
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
export const fixture = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'legacy-recall-reference.json'), 'utf8')
) as {
  now: number;
  projectSchema: string;
  cases: FixtureCase[];
};
export const LEGACY_COLUMN = Buffer.from('6a696e785f74657874', 'hex').toString('ascii');
export const COLUMNS = [
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
export const fake = (input: string) =>
  [...createHash('sha256').update(input, 'utf8').digest().subarray(0, 8)].map((b) => b / 255 - 0.5);

/** Serves the fake embeddings on 127.0.0.1; resolves to its /v1 URL and a close function. */
export async function fakeEmbeddingService(): Promise<{ url: string; close: () => Promise<void> }> {
  const service = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [{ embedding: fake((JSON.parse(body) as { input: string }).input) }] }));
    });
  });
  await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(service.address() as AddressInfo).port}/v1`,
    close: () => new Promise<void>((resolve) => service.close(() => resolve())),
  };
}

export async function blob(row: FixtureRow): Promise<Uint8Array | null> {
  if (row.embedding === null) return null;
  if (typeof row.embedding === 'string') return Buffer.from(row.embedding, 'hex');
  const vector = await hashedEmbedder(1024).embed(row.text as string);
  const packed = Buffer.from(new Float32Array(vector).buffer);
  expect(createHash('sha256').update(packed).digest('hex'), `hashed embedding of row ${row.id}`).toBe(
    row.embedding.hashed
  );
  return packed;
}

export async function build(
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

/** Lay one case out under `root` (home, instance config, stores, legacy history); returns its home and config paths. */
export async function stage(c: FixtureCase, root: string): Promise<{ home: string; config: string }> {
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
  return { home, config };
}
