/**
 * @fileoverview `reverie agent journal import-legacy`: moves the old per-instance memory store (reverie-memory) into the
 * caller's own office journal. It runs inside the agent's own laptop and reads only that agent's own instance, read-only;
 * the server records each memory once, as an imported, unverified entry (see EmployeeJournalStore.importLegacy).
 *
 * What moves: reflections and episodes rated 5 or more out of 10, and beliefs. Dreams are hypotheses and stay behind.
 * Project stores widen who can read them once imported, so they move only with --include-projects. A dry run writes
 * nothing and shows what a write would send.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentDeps } from './cli-agent.js';
import { AGENT_EXIT } from './agent-exit-codes.js';
import { sqlite } from './chat-db.js';
import { JOURNAL_IMPORT_BATCH, JOURNAL_PROJECT_SAVES_PER_DAY, JOURNAL_TEXT_BYTES, type JournalImportItem, type JournalImportOutcome } from './employee-journal.js';

const PROJECT = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const bounds = { maxBytes: 256 * 1024, deadlineMs: 30_000 };

export interface LegacyStore {
  scope: string;
  /** Items a write would send; for a project store without --include-projects, what it would send if included. */
  items: JournalImportItem[];
  /** Memories left behind: dreams and anything rated under 5. */
  skipped: number;
  /** Item ids whose text was cut to fit a journal entry. */
  cut: number[];
  included: boolean;
}

/** The instance's state directory, resolved the way the python instance loader does. */
export function legacyDataDir(instanceConfig: string): string {
  const config = path.resolve(instanceConfig);
  const raw = JSON.parse(fs.readFileSync(config, 'utf8')) as { data_dir?: unknown };
  if (typeof raw.data_dir !== 'string' || !raw.data_dir.trim()) throw new Error('instance config has no data_dir');
  const expanded = raw.data_dir.startsWith('~') ? path.join(os.homedir(), raw.data_dir.slice(1)) : raw.data_dir;
  const dir = path.resolve(path.dirname(config), expanded);
  if (dir === path.dirname(config) || path.dirname(config).startsWith(dir + path.sep)) throw new Error('instance data_dir must be a separate state directory');
  return dir;
}

/** Cut to the journal's text limit, saying how much was left behind and where the whole text still is. */
export function fitText(text: string, table: string, id: number): { text: string; cut: boolean } {
  const total = Buffer.byteLength(text);
  if (total <= JOURNAL_TEXT_BYTES) return { text, cut: false };
  let kept = '';
  for (const char of text) {
    const marker = ` […${total - Buffer.byteLength(kept + char)} more bytes in the old store, ${table} #${id}]`;
    if (Buffer.byteLength(kept + char + marker) > JOURNAL_TEXT_BYTES) break;
    kept += char;
  }
  return { text: `${kept.trimEnd()} […${total - Buffer.byteLength(kept.trimEnd())} more bytes in the old store, ${table} #${id}]`, cut: true };
}

function readStore(file: string, scope: string, included: boolean): LegacyStore {
  const db = new (sqlite().DatabaseSync)(file, { readOnly: true } as never);
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => String(row.name)));
    const store: LegacyStore = { scope, items: [], skipped: 0, cut: [], included };
    const add = (table: string, id: number, kind: JournalImportItem['kind'], seconds: number, text: string, importance: JournalImportItem['importance']) => {
      if (!text.trim() || !Number.isFinite(seconds) || seconds <= 0) { store.skipped += 1; return; }
      const fitted = fitText(text.trim(), table, id);
      if (fitted.cut) store.cut.push(id);
      store.items.push({ scope, legacyId: id, createdAt: Math.round(seconds * 1000), kind, importance, text: fitted.text });
    };
    if (tables.has('memories')) {
      for (const row of db.prepare('SELECT id, kind, created_at, text, importance FROM memories ORDER BY id').all()) {
        const kind = String(row.kind); const importance = Number(row.importance);
        if ((kind !== 'reflection' && kind !== 'episode') || !(importance >= 5)) { store.skipped += 1; continue; }
        add('memory', Number(row.id), kind, Number(row.created_at), String(row.text ?? ''), importance >= 8 ? 'keystone' : 'important');
      }
    }
    if (tables.has('beliefs')) {
      for (const row of db.prepare('SELECT id, created_at, text FROM beliefs ORDER BY id').all())
        add('belief', Number(row.id), 'belief', Number(row.created_at), String(row.text ?? ''), 'important');
    }
    return store;
  } finally {
    db.close();
  }
}

/** The caller's own private store, and each project store under it; read-only, nothing outside this instance. */
export function readLegacyStores(instanceConfig: string, includeProjects: boolean): LegacyStore[] {
  const data = legacyDataDir(instanceConfig);
  const stores: LegacyStore[] = [];
  const own = path.join(data, 'memory.sqlite');
  if (fs.existsSync(own)) stores.push(readStore(own, 'private', true));
  const projects = path.join(data, 'projects');
  if (fs.existsSync(projects)) {
    for (const name of fs.readdirSync(projects).sort()) {
      const file = path.join(projects, name, 'memory.sqlite');
      if (PROJECT.test(name) && fs.existsSync(file)) stores.push(readStore(file, name, includeProjects));
    }
  }
  return stores;
}

const summary = (store: LegacyStore) => {
  const keystones = store.items.filter(item => item.importance === 'keystone').length;
  return `${store.scope === 'private' ? 'your own store' : `project ${store.scope}`}: ${store.items.length} to import (${keystones} keystone, ` +
    `${store.items.length - keystones} important), ${store.skipped} left behind (dreams and memories rated under 5)` +
    (store.included ? (store.scope === 'private' ? '' : `; uses your own ${JOURNAL_PROJECT_SAVES_PER_DAY} project saves a day, so a large store takes several days`)
      : '; not imported without --include-projects, because every employee could then read it');
};

export interface ImportLegacyOptions { dryRun?: boolean; write?: boolean; includeProjects?: boolean; instance?: string }

export async function agentJournalImportLegacy(deps: AgentDeps, options: ImportLegacyOptions, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const fail = (error: string) => {
    if (deps.json) deps.io.out(JSON.stringify({ success: false, error }));
    else deps.io.err(error);
    return AGENT_EXIT.refused;
  };
  if (Boolean(options.dryRun) === Boolean(options.write)) return fail('Choose exactly one of --dry-run or --write.');
  const instance = options.instance ?? env.REVERIE_INSTANCE_CONFIG;
  if (!instance) return fail('No instance: pass --instance <your own instance config> or set REVERIE_INSTANCE_CONFIG.');
  let stores: LegacyStore[];
  try { stores = readLegacyStores(instance, Boolean(options.includeProjects)); }
  catch (error) { return fail(`Old memory store unreadable: ${error instanceof Error ? error.message : 'unknown error'}`); }
  if (options.dryRun) {
    if (deps.json) {
      deps.io.out(JSON.stringify({ success: true, data: { stores: stores.map(store => ({ scope: store.scope, included: store.included,
        toImport: store.items.length, skipped: store.skipped, cut: store.cut, keystones: store.items.filter(item => item.importance === 'keystone'),
        samples: store.items.slice(0, 5) })) } }));
      return AGENT_EXIT.ok;
    }
    if (!stores.length) deps.io.out('No old memory store found for this instance; nothing to import.');
    for (const store of stores) {
      deps.io.out(summary(store));
      const keystones = store.items.filter(item => item.importance === 'keystone');
      if (keystones.length) {
        deps.io.out(`  keystones (imported ones stay out of your memory brief until you save them again yourself):`);
        for (const item of keystones.slice(0, 20)) deps.io.out(`    #${item.legacyId} ${item.text.slice(0, 100)}`);
        if (keystones.length > 20) deps.io.out(`    ... ${keystones.length - 20} more`);
      }
      if (store.cut.length) deps.io.out(`  cut to fit ${JOURNAL_TEXT_BYTES} bytes, with a marker naming the original: #${store.cut.join(', #')}`);
      for (const item of store.items.slice(0, 5)) deps.io.out(`  sample #${item.legacyId} (${item.kind}, ${item.importance}, ${new Date(item.createdAt).toISOString()}): ${item.text.slice(0, 160)}`);
    }
    deps.io.out('Dry run: nothing was written. Run with --write to import.');
    return AGENT_EXIT.ok;
  }
  const items = stores.filter(store => store.included).flatMap(store => store.items);
  const results: JournalImportOutcome[] = [];
  for (let start = 0; start < items.length; start += JOURNAL_IMPORT_BATCH) {
    let response;
    try {
      response = await deps.request(deps.ctx, { method: 'POST', path: '/api/agent/journal/import', body: { items: items.slice(start, start + JOURNAL_IMPORT_BATCH) }, bounds });
    } catch { response = undefined; }
    const envelope = response?.json as { success?: boolean; data?: { results: JournalImportOutcome[] }; error?: string } | undefined;
    if (response?.status !== 200 || envelope?.success !== true || !envelope.data) {
      return fail(`Import stopped after ${results.length} of ${items.length}: ${envelope?.error ?? 'journal import unavailable'}. ` +
        'Running it again is safe: memories already imported are recognised and skipped.');
    }
    results.push(...envelope.data.results);
  }
  const count = (status: JournalImportOutcome['status']) => results.filter(result => result.status === status).length;
  if (deps.json) { deps.io.out(JSON.stringify({ success: true, data: { results } })); return AGENT_EXIT.ok; }
  deps.io.out(`Imported ${count('imported')}, already imported ${count('duplicate')}, refused ${count('refused')} of ${items.length}.`);
  const reasons = new Map<string, number>();
  for (const result of results) if (result.status === 'refused') reasons.set(result.reason ?? 'refused', (reasons.get(result.reason ?? 'refused') ?? 0) + 1);
  for (const [reason, n] of reasons) deps.io.out(`  refused ${n}: ${reason}`);
  const left = stores.filter(store => !store.included && store.items.length);
  if (left.length) deps.io.out(`Not imported: ${left.map(store => `project ${store.scope}`).join(', ')} (needs --include-projects).`);
  return AGENT_EXIT.ok;
}
