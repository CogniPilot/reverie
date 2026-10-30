/** `journal import-legacy`: reads only the caller's own instance, read-only; a dry run sends nothing; projects are opt-in. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentJournalImportLegacy, fitText, legacyDataDir } from '../src/cli-agent-journal-import.js';
import type { AgentDeps } from '../src/cli-agent.js';
const require = createRequire(import.meta.url);

const OLD = Date.parse('2026-10-01T00:00:00Z') / 1000;

function oldStore(file: string, rows: Array<[number, string, number, string]>, beliefs: Array<[number, string]> = []) {
  const db = new (require('node:sqlite').DatabaseSync)(file);
  db.exec(`CREATE TABLE memories (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, created_at REAL NOT NULL, text TEXT NOT NULL,
    importance REAL NOT NULL, user_text TEXT NOT NULL DEFAULT '');
    CREATE TABLE beliefs (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, weight REAL NOT NULL, created_at REAL NOT NULL);`);
  for (const [id, kind, importance, text] of rows)
    db.prepare('INSERT INTO memories(id, kind, created_at, text, importance) VALUES (?, ?, ?, ?, ?)').run(id, kind, OLD + id, text, importance);
  for (const [id, text] of beliefs) db.prepare('INSERT INTO beliefs(id, text, weight, created_at) VALUES (?, ?, 1, ?)').run(id, text, OLD + id);
  db.close();
}

describe('journal import-legacy', () => {
  let dir: string; let instance: string; let out: string[]; let err: string[];
  let requests: Array<{ path: string; body: { items: Array<Record<string, unknown>> } }>;
  let reply: (items: Array<Record<string, unknown>>) => { status: number; json: unknown };
  const deps = (json = false): AgentDeps => ({
    ctx: { apiUrl: 'http://office.test', selfId: 'sess-1' }, json,
    io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) },
    request: async (_ctx, options) => {
      const body = options.body as { items: Array<Record<string, unknown>> };
      requests.push({ path: options.path, body });
      return { ...reply(body.items), text: '' } as never;
    },
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'import-legacy-'));
    out = []; err = []; requests = [];
    reply = (items) => ({ status: 200, json: { success: true, data: { results: items.map((item, i) => ({ legacyId: item.legacyId, scope: item.scope,
      status: i === 0 ? 'duplicate' : 'imported', entryId: i + 1 })) } } });
    instance = join(dir, 'config', 'agent.json');
    mkdirSync(join(dir, 'config'));
    writeFileSync(instance, JSON.stringify({ id: 'a', agent_name: 'Agent', owner_name: 'Owner', data_dir: '../state', persona: 'p' }));
    mkdirSync(join(dir, 'state', 'projects', 'rumoca'), { recursive: true });
    mkdirSync(join(dir, 'state', 'projects', 'Not.A.Project'), { recursive: true });
    oldStore(join(dir, 'state', 'memory.sqlite'), [
      [1, 'reflection', 9, 'Always post review records with exact UTC times.'],
      [2, 'episode', 6, 'Talked through the compiler baseline.'],
      [3, 'episode', 3, 'Small talk about the weather.'],
      [4, 'dream', 9, 'I dreamed the scratch drive became a beach.'],
      [5, 'reflection', 5, 'é'.repeat(1500)],
    ], [[1, 'I keep my promises to the team.']]);
    oldStore(join(dir, 'state', 'projects', 'rumoca', 'memory.sqlite'), [[7, 'reflection', 7, 'Parity passed at commit abc123.']]);
    oldStore(join(dir, 'state', 'projects', 'Not.A.Project', 'memory.sqlite'), [[8, 'reflection', 9, 'never read']]);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('dry run: counts, keystones, cut texts and samples from the own store, project stores listed but not included, nothing sent', async () => {
    const before = statSync(join(dir, 'state', 'memory.sqlite')).mtimeMs;
    expect(await agentJournalImportLegacy(deps(), { dryRun: true, instance })).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('your own store: 4 to import (1 keystone, 3 important), 2 left behind (dreams and memories rated under 5)');
    expect(text).toContain('project rumoca: 1 to import (0 keystone, 1 important), 0 left behind');
    expect(text).toContain('not imported without --include-projects, because every employee could then read it');
    expect(text).toContain('#1 Always post review records with exact UTC times.');
    expect(text).toContain('cut to fit 1024 bytes, with a marker naming the original: #5');
    expect(text).toContain('Dry run: nothing was written.');
    expect(text).not.toContain('never read');
    expect(requests).toEqual([]);
    expect(statSync(join(dir, 'state', 'memory.sqlite')).mtimeMs).toBe(before);
  });

  it('write: sends the own store only, cut to fit with a marker, and reports what the server did', async () => {
    expect(await agentJournalImportLegacy(deps(), { write: true, instance })).toBe(0);
    expect(requests).toHaveLength(1);
    const items = requests[0].body.items;
    expect(requests[0].path).toBe('/api/agent/journal/import');
    expect(items.map((i) => [i.scope, i.kind, i.legacyId, i.importance])).toEqual([
      ['private', 'reflection', 1, 'keystone'], ['private', 'episode', 2, 'important'], ['private', 'reflection', 5, 'important'],
      ['private', 'belief', 1, 'important']]);
    expect(items[0].createdAt).toBe((OLD + 1) * 1000);
    const cut = String(items[2].text);
    expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(1024);
    expect(cut).toMatch(/ \[…\d+ more bytes in the old store, memory #5\]$/);
    expect(out.join('\n')).toContain('Imported 3, already imported 1, refused 0 of 4.');
    expect(out.join('\n')).toContain('Not imported: project rumoca (needs --include-projects).');
  });

  it('write --include-projects adds the project stores', async () => {
    await agentJournalImportLegacy(deps(), { write: true, includeProjects: true, instance });
    expect(requests[0].body.items.filter((i) => i.scope === 'rumoca').map((i) => i.legacyId)).toEqual([7]);
    out = [];
    await agentJournalImportLegacy(deps(), { dryRun: true, includeProjects: true, instance });
    expect(out.join('\n')).toContain('project rumoca: 1 to import (0 keystone, 1 important), 0 left behind (dreams and memories rated under 5); uses your own 20 project saves a day');
  });

  it('needs exactly one mode and an instance, and says a failed write is safe to repeat', async () => {
    expect(await agentJournalImportLegacy(deps(), { instance })).not.toBe(0);
    expect(await agentJournalImportLegacy(deps(), { dryRun: true, write: true, instance })).not.toBe(0);
    expect(await agentJournalImportLegacy(deps(), { dryRun: true }, {})).not.toBe(0);
    reply = () => ({ status: 403, json: { success: false, error: 'journal unavailable for this caller' } });
    expect(await agentJournalImportLegacy(deps(), { write: true, instance })).not.toBe(0);
    expect(err.at(-1)).toBe('Import stopped after 0 of 4: journal unavailable for this caller. Running it again is safe: memories already imported are recognised and skipped.');
  });

  it('resolves data_dir like the instance loader and refuses one that contains its own config', () => {
    expect(legacyDataDir(instance)).toBe(join(dir, 'state'));
    writeFileSync(instance, JSON.stringify({ data_dir: '.' }));
    expect(() => legacyDataDir(instance)).toThrow('separate state directory');
  });

  it('cuts on character boundaries and names the original', () => {
    expect(fitText('short', 'memory', 3)).toEqual({ text: 'short', cut: false });
    const { text, cut } = fitText('雪'.repeat(600), 'belief', 12);
    expect(cut).toBe(true);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1024);
    expect(text).toMatch(/^雪+ \[…\d+ more bytes in the old store, belief #12\]$/);
  });
});
