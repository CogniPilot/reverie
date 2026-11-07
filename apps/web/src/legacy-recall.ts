/**
 * @fileoverview Read-only recall from an agent's old per-instance memory store, the in-process successor of the
 * `python -m reverie.memory_cli` recall that `memory_recall` used to spawn. The office journal is the store of record;
 * this answers from the old store as labelled history and returns the exact JSON text the python bridge printed.
 *
 * It ranks as python's `MemoryStore.retrieve` did: relevance (cosine against the query embedding, negative relevance
 * skipped), recency (0.995 per hour) and importance, averaged; best first, newer first on ties; eight private or six
 * project results. Nothing is written. The python path first initialised the agent's daemon, which re-embedded rows
 * stored under another embedder, imported a pending legacy-history.json, created directories, logs and empty stores,
 * seeded beliefs, wrote a profile, and after ranking stamped `last_accessed`. Here:
 * - rows under another embedder are re-embedded in memory, as python would have before ranking, and report the current
 *   embedder's name, as python's rewritten rows did;
 * - a pending legacy-history import that would add episodes refuses instead of being imported;
 * - a missing store answers [] without being created; the other effects did not change results and are not reproduced.
 */
import fs from 'node:fs';
import path from 'node:path';
import { sqlite } from './chat-db.js';
import { pyStrip } from './memory-floors.js';
import { cosine, hashedEmbedder, pickEmbedder, type Embedder, type LlamaOptions } from './memory-embed.js';
import { crPow, pyFloatRepr } from './python-float.js';
import { resolveLoose } from './web/routes/agent-profile-report.js';

const INSTANCE_FIELDS = new Set([
  'id',
  'agent_name',
  'owner_name',
  'data_dir',
  'persona',
  'initial_self',
  'role',
  'kind',
  'shared_room_tone',
  'employee_id',
]);
const INSTANCE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const PROJECT = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const KINDS = ['episode', 'reflection', 'dream'];
const LEGACY_ASSISTANT_COLUMN = Buffer.from('6a696e785f74657874', 'hex').toString('ascii');
const DECAY_PER_HOUR = 0.995;

/** Bounds the python path did not have; each refuses rather than answering partially. */
export const RECALL_LIMITS = {
  instanceBytes: 64 * 1024,
  legacyHistoryBytes: 64 * 1024 * 1024,
  rows: 50_000,
  embeddingBytes: 64 * 1024,
  /** Rows under another embedder re-embedded through the embedding service in one recall. */
  serviceReembeds: 256,
};

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && pyStrip(value) !== '';

function expandUser(value: string, home: string): string {
  if (value === '~' || value.startsWith('~/')) return home + value.slice(1);
  if (value.startsWith('~')) throw new Error("instance data_dir names another user's home directory");
  return value;
}

function readUtf8(file: string, limit: number): string {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${file} is not a regular file`);
    if (stat.size > limit) throw new Error(`${file} is too large to read`);
    const bytes = Buffer.alloc(stat.size);
    let read = 0;
    while (read < bytes.length) {
      const n = fs.readSync(fd, bytes, read, bytes.length - read, read);
      if (n === 0) break;
      read += n;
    }
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
}

/** The instance's state directory, validated exactly as python's `load_instance` validates the config. */
export function instanceDataDir(instanceConfig: string, home: string): string {
  const config = fs.realpathSync(expandUser(instanceConfig, home));
  const raw = JSON.parse(readUtf8(config, RECALL_LIMITS.instanceBytes)) as unknown;
  if (
    raw === null ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).some((key) => !INSTANCE_FIELDS.has(key))
  )
    throw new Error('instance config must be an object with supported fields only');
  const fields = raw as Record<string, unknown>;
  for (const key of ['id', 'agent_name', 'owner_name', 'data_dir', 'persona'])
    if (!nonEmpty(fields[key])) throw new Error(`instance config requires nonempty ${key}`);
  if (!INSTANCE_ID.test(fields.id as string)) throw new Error('invalid instance id');
  const parent = path.dirname(config);
  const expanded = expandUser(fields.data_dir as string, home);
  const state = resolveLoose(path.isAbsolute(expanded) ? expanded : path.join(parent, expanded));
  if (state === parent || parent.startsWith(state === path.sep ? state : state + path.sep))
    throw new Error('instance data_dir must be a separate state directory');
  const initial = fields.initial_self;
  if (initial !== undefined && initial !== null) {
    const self = initial as Record<string, unknown>;
    if (
      typeof initial !== 'object' ||
      Array.isArray(initial) ||
      typeof self.consciousness !== 'string' ||
      !Array.isArray(self.directives) ||
      self.directives.some((item) => !nonEmpty(item))
    )
      throw new Error('initial_self requires a consciousness statement and directive strings');
  }
  if (!['cto', 'agent', 'expert', 'implementer'].includes(('kind' in fields ? fields.kind : 'agent') as string))
    throw new Error('invalid agent kind');
  if (!nonEmpty('role' in fields ? fields.role : 'Expert')) throw new Error('role must be nonempty text');
  if (
    !['professional', 'social'].includes(
      ('shared_room_tone' in fields ? fields.shared_room_tone : 'professional') as string
    )
  )
    throw new Error('shared_room_tone must be professional or social');
  if ('employee_id' in fields && !(typeof fields.employee_id === 'string' && UUID.test(fields.employee_id)))
    throw new Error('employee_id must be a lowercase UUID');
  return state;
}

// ---- python's json: numbers keep their int/float kind, output matches json.dumps(ensure_ascii=False) -------------------

type PyJson = null | boolean | string | { int: bigint } | { float: number } | PyJson[] | Map<string, PyJson>;

/** `json.loads` keeping python's int/float distinction (and its NaN and Infinity literals). */
export function parsePyJson(text: string): PyJson {
  let at = 0;
  const fail = (): never => {
    throw new Error(`Expecting value: char ${at}`);
  };
  const space = () => {
    while (at < text.length && ' \t\n\r'.includes(text[at])) at++;
  };
  const value = (): PyJson => {
    space();
    const c = text[at];
    if (c === '{') {
      at++;
      const map = new Map<string, PyJson>();
      space();
      if (text[at] === '}') return (at++, map);
      for (;;) {
        space();
        if (text[at] !== '"') fail();
        const key = string();
        space();
        if (text[at++] !== ':') fail();
        map.set(key, value());
        space();
        if (text[at] === ',') at++;
        else if (text[at] === '}') return (at++, map);
        else fail();
      }
    }
    if (c === '[') {
      at++;
      const list: PyJson[] = [];
      space();
      if (text[at] === ']') return (at++, list);
      for (;;) {
        list.push(value());
        space();
        if (text[at] === ',') at++;
        else if (text[at] === ']') return (at++, list);
        else fail();
      }
    }
    if (c === '"') return string();
    for (const [word, result] of [
      ['null', null],
      ['true', true],
      ['false', false],
      ['NaN', { float: NaN }],
      ['Infinity', { float: Infinity }],
      ['-Infinity', { float: -Infinity }],
    ] as const)
      if (text.startsWith(word, at)) return ((at += word.length), result);
    const number = /^(-?(?:0|[1-9]\d*))(\.\d+)?([eE][-+]?\d+)?/.exec(text.slice(at));
    if (!number) return fail();
    at += number[0].length;
    return number[2] || number[3] ? { float: Number(number[0]) } : { int: BigInt(number[1]) };
  };
  const string = (): string => {
    const start = at++;
    while (at < text.length && text[at] !== '"') at += text[at] === '\\' ? 2 : 1;
    if (at >= text.length) fail();
    return JSON.parse(text.slice(start, ++at)) as string;
  };
  const result = value();
  space();
  if (at !== text.length) throw new Error(`Extra data: char ${at}`);
  return result;
}

const ESCAPES: Record<string, string> = {
  '"': '\\"',
  '\\': '\\\\',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\b': '\\b',
  '\f': '\\f',
};

function dumpString(text: string): string {
  // eslint-disable-next-line no-control-regex -- python escapes every C0 control character.
  return `"${text.replace(/["\\\u0000-\u001f]/g, (c) => ESCAPES[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}"`;
}

/** `json.dumps(value, ensure_ascii=False)` for a python value. */
export function dumpPyJson(value: PyJson): string {
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'string') return dumpString(value);
  if (Array.isArray(value)) return `[${value.map(dumpPyJson).join(', ')}]`;
  if (value instanceof Map)
    return `{${[...value].map(([key, item]) => `${dumpString(key)}: ${dumpPyJson(item)}`).join(', ')}}`;
  return 'int' in value ? value.int.toString() : pyFloatRepr(value.float);
}

// ---- the store ---------------------------------------------------------------------------------------------------------

interface Row {
  id: bigint;
  kind: string;
  created_at: number | bigint | string;
  user_text: unknown;
  assistant_text: unknown;
  text: unknown;
  importance: number | bigint | string;
  importance_source: unknown;
  embed_model: string;
  embedding: Uint8Array | null;
  source_ids: unknown;
  section: unknown;
  meta: unknown;
  last_accessed: unknown;
}

/** A column value as python's sqlite3 returns it, ready for json.dumps. */
function cell(value: unknown): PyJson {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return { int: value };
  if (typeof value === 'number') return { float: value };
  if (typeof value === 'string') return value;
  throw new Error('Object of type bytes is not JSON serializable');
}

function numeric(value: unknown, operand: string): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  throw new Error(
    `unsupported operand type(s) for -: 'float' and '${typeof value === 'string' ? 'str' : 'bytes'}' (${operand})`
  );
}

function unpack(blob: Uint8Array | null): number[] {
  if (!blob || blob.length === 0) return [];
  if (blob.length % 4) throw new Error('bytes length not a multiple of item size');
  if (blob.length > RECALL_LIMITS.embeddingBytes) throw new Error('a stored embedding is too large to read');
  const view = new DataView(blob.buffer, blob.byteOffset, blob.length);
  return Array.from({ length: blob.length / 4 }, (_, i) => view.getFloat32(i * 4, true));
}

type Database = InstanceType<ReturnType<typeof sqlite>['DatabaseSync']>;

function open(file: string): Database | null {
  try {
    if (!fs.statSync(file).isFile()) throw new Error(`${file} is not a regular file`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return new (sqlite().DatabaseSync)(file, { readOnly: true, timeout: 5000 } as never);
}

function tables(db: Database): Set<string> {
  return new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => String((row as { name: unknown }).name))
  );
}

/** The assistant column, accepting the legacy name python renames on open; python's errors for ambiguous or missing. */
function assistantColumn(db: Database): string {
  const columns = new Set(
    db
      .prepare('PRAGMA table_info(memories)')
      .all()
      .map((row) => String((row as { name: unknown }).name))
  );
  if (columns.has(LEGACY_ASSISTANT_COLUMN)) {
    if (columns.has('assistant_text')) throw new Error('Ambiguous assistant columns in memory store');
    return LEGACY_ASSISTANT_COLUMN;
  }
  if (!columns.has('assistant_text')) throw new Error('Missing assistant column in memory store');
  return 'assistant_text';
}

function rows(db: Database, onlyModel: string | null): Row[] {
  const assistant = assistantColumn(db);
  const count = db.prepare(
    `SELECT count(*) AS n FROM memories WHERE kind IN (?, ?, ?)${onlyModel === null ? '' : ' AND embed_model = ?'}`
  );
  const n = Number((count.get(...KINDS, ...(onlyModel === null ? [] : [onlyModel])) as { n: number }).n);
  if (n > RECALL_LIMITS.rows) throw new Error(`the old memory store holds ${n} memories, more than recall reads`);
  const select = db.prepare(
    `SELECT id, kind, created_at, user_text, "${assistant}" AS assistant_text, text, importance, importance_source, embed_model, embedding, ` +
      `source_ids, section, meta, last_accessed FROM memories WHERE kind IN (?, ?, ?)${onlyModel === null ? '' : ' AND embed_model = ?'}`
  );
  (select as unknown as { setReadBigInts(enabled: boolean): void }).setReadBigInts(true); // python reads INTEGER as int, REAL as float
  return select.all(...KINDS, ...(onlyModel === null ? [] : [onlyModel])) as unknown as Row[];
}

/** Whether python's one-time legacy-history import would still add episodes before ranking. */
function pendingLegacyImport(db: Database, dataDir: string): boolean {
  if (tables(db).has('state')) {
    const done = db.prepare('SELECT value FROM state WHERE key = ?').get('migrated_legacy_history') as
      | { value: unknown }
      | undefined;
    if (done && done.value) return false;
  }
  let turns: unknown;
  try {
    turns = JSON.parse(readUtf8(path.join(dataDir, 'legacy-history.json'), RECALL_LIMITS.legacyHistoryBytes));
  } catch {
    return false; // python records it as missing and imports nothing
  }
  if (!Array.isArray(turns)) return false;
  let user = false;
  let pairs = 0;
  for (const turn of turns) {
    if (turn === null || typeof turn !== 'object' || Array.isArray(turn))
      throw new Error(`'${pyTypeName(turn)}' object has no attribute 'get'`);
    const { role, content } = turn as Record<string, unknown>;
    if (
      content !== undefined &&
      content !== null &&
      content !== false &&
      content !== '' &&
      content !== 0 &&
      typeof content !== 'string'
    )
      throw new Error(`'${pyTypeName(content)}' object has no attribute 'strip'`);
    if (role === 'user') user = true;
    else if (role === 'assistant' && user) {
      pairs++;
      user = false;
    }
  }
  return pairs > 0;
}

function pyTypeName(value: unknown): string {
  if (value === null) return 'NoneType';
  if (Array.isArray(value)) return 'list';
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float';
  return typeof value === 'string' ? 'str' : 'dict';
}

const PY_ERRNO: Record<string, [number, string]> = {
  ENOENT: [2, 'No such file or directory'],
  EACCES: [13, 'Permission denied'],
  ENOTDIR: [20, 'Not a directory'],
  EISDIR: [21, 'Is a directory'],
  ELOOP: [40, 'Too many levels of symbolic links'],
};

/** A file-system error worded the way python's OSError prints. */
function pyOsError(error: unknown): unknown {
  const e = error as NodeJS.ErrnoException;
  const known = e && typeof e.code === 'string' ? PY_ERRNO[e.code] : undefined;
  return known ? new Error(`[Errno ${known[0]}] ${known[1]}${e.path ? `: '${e.path}'` : ''}`) : error;
}

export interface RecallOptions {
  /** The embedding service URL the bridge received as REVERIE_EMBED_URL; empty uses the hashed embedder. */
  embedUrl?: string;
  /** HOME as the bridge saw it, for `~` in instance paths. */
  home: string;
  /** Seconds since the epoch; defaults to now. */
  now?: () => number;
  llama?: LlamaOptions;
}

export interface RecallRequest {
  query: string;
  project?: string;
}

/** Rank one store's rows against the query; `reembed` re-embeds rows stored under another embedder in memory. */
async function retrieve(
  db: Database,
  embedder: Embedder,
  query: string,
  k: number,
  reembed: boolean,
  now: () => number
): Promise<PyJson[]> {
  const found = rows(db, reembed ? null : embedder.name);
  const stale = found.filter((row) => row.embed_model !== embedder.name);
  if (stale.length > RECALL_LIMITS.serviceReembeds && !embedder.name.startsWith('hashed-'))
    throw new Error(
      `${stale.length} old memories were stored under another embedder; re-embedding them would take too many requests`
    );
  const vectors = new Map<bigint, number[]>();
  for (const row of stale) {
    if (typeof row.text !== 'string') throw new Error("embed() argument 'text' must be str");
    vectors.set(row.id, (await embedder.embed(row.text, 'document')).map(Math.fround));
  }
  const q = await embedder.embed(query, 'query');
  const at = now();
  const scored: Array<{ row: Row; score: number; created: number }> = [];
  for (const row of found) {
    const rel = cosine(q, vectors.get(row.id) ?? unpack(row.embedding));
    if (rel < 0) continue;
    const created = numeric(row.created_at, 'created_at');
    const hours = Math.max(0, (at - created) / 3600);
    const recency = crPow(DECAY_PER_HOUR, hours);
    const importance = Math.max(0, Math.min(1, numeric(row.importance, 'importance') / 10));
    const score = (Math.max(0, Math.min(1, rel)) + recency + importance) / 3;
    scored.push({ row, score, created });
  }
  scored.sort((a, b) => b.score - a.score || b.created - a.created);
  return scored.slice(0, k).map(({ row, score }) => {
    const json = (value: unknown, fallback: string) => {
      const text = value === null || value === '' ? fallback : value;
      if (typeof text !== 'string') throw new Error('the JSON object must be str, bytes or bytearray');
      return parsePyJson(text);
    };
    return new Map<string, PyJson>([
      ['id', { int: row.id }],
      ['kind', cell(row.kind)],
      ['created_at', cell(row.created_at)],
      ['user_text', cell(row.user_text)],
      ['assistant_text', cell(row.assistant_text)],
      ['text', cell(row.text)],
      ['importance', cell(row.importance)],
      ['importance_source', cell(row.importance_source)],
      ['embed_model', embedder.name],
      ['source_ids', json(row.source_ids, '[]')],
      ['section', cell(row.section)],
      ['meta', json(row.meta, '{}')],
      ['last_accessed', cell(row.last_accessed)],
      ['score', { float: score }],
    ]);
  });
}

/**
 * Recall from the caller's old store: the JSON text python's bridge printed (without its newline). Throws with
 * python's message where python failed, and with a stated reason where this refuses instead of writing.
 */
export async function legacyRecall(
  instanceConfig: string,
  request: RecallRequest,
  options: RecallOptions
): Promise<string> {
  try {
    return await recall(instanceConfig, request, options);
  } catch (error) {
    throw pyOsError(error);
  }
}

async function recall(instanceConfig: string, request: RecallRequest, options: RecallOptions): Promise<string> {
  const now = options.now ?? (() => Date.now() / 1000);
  const dataDir = instanceDataDir(instanceConfig, options.home);
  if (request.project !== undefined) {
    if (!PROJECT.test(request.project)) throw new Error('project must be a lowercase project identifier');
    const db = open(path.join(dataDir, 'projects', request.project, 'memory.sqlite'));
    if (!db) return '[]';
    try {
      return tables(db).has('memories')
        ? dumpPyJson(await retrieve(db, hashedEmbedder(1024), request.query, 6, false, now))
        : '[]';
    } finally {
      db.close();
    }
  }
  const db = open(path.join(dataDir, 'memory.sqlite'));
  if (!db) return '[]';
  try {
    if (pendingLegacyImport(db, dataDir))
      throw new Error(
        'the old memory store has a legacy-history.json that was never imported; recall reads it only after that import'
      );
    if (!tables(db).has('memories')) return '[]';
    const embedder = await pickEmbedder(options.embedUrl ?? '', options.llama);
    return dumpPyJson(await retrieve(db, embedder, request.query, 8, true, now));
  } finally {
    db.close();
  }
}
