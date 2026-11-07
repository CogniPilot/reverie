/**
 * @fileoverview `reverie agent memory` (installed as `reverie-memory`): one JSON request on standard input, recall or
 * remember, with an explicit instance and exactly one private or project scope. It replaces python's `memory_cli` and
 * answers as it did: recall reads the old per-instance store (read-only history) and, inside a session, the journal;
 * remember writes only to the journal and, outside a session, refuses with the exact save command.
 *
 * Every check runs in python's order with python's wording, and output is byte for byte what python printed, so callers
 * and the skills that document this command see no change. Where this is stricter it says so (see `tighten`).
 */
import type { Command } from 'commander';
import { AgentGuardError, httpRequest, resolveAgentContext, type AgentDeps, type ApiRequest } from './cli-agent.js';
import { agentJournalRecall, agentJournalSave, journalRoom } from './cli-agent-journal.js';
import { envValue } from './config/reverie-env.js';
import { instanceDataDir, legacyRecall, parsePyJson, dumpPyJson, pyOsError, type PyJson } from './legacy-recall.js';
import type { JournalPort, LegacyRecall } from './mcp-memory-tools.js';
import { pyStrip, screenMemoryText } from './memory-floors.js';

const TAGS = ['decision', 'promise', 'correction', 'preference', 'identity', 'relationship', 'open-question', 'lesson',
  'personal-reflection'];
const NO_SESSION = 'remember saves to your office journal as your own Reverie session, and this process is not running '
  + 'inside one. Nothing was saved. Inside your session, run: ';
const QUERY_MAX = 500;
const TEXT_MAX = 2000;
const TEXT_FIELDS = ['query', 'text', 'project', 'channel', 'room', 'turn', 'tag', 'quote', 'source', 'reason'];
/** The most standard input read; python read without a bound. */
export const MEMORY_INPUT_MAX = 1024 * 1024;

export interface MemoryCliDeps {
  /** Standard input, decoded. */
  input: string;
  /** --instance, already defaulted from REVERIE_INSTANCE_CONFIG. */
  instance?: string;
  env: NodeJS.ProcessEnv;
  out(line: string): void;
  err(line: string): void;
  /** The journal as this session; undefined outside one (python: no REVERIE_SESSION_ID). */
  journal?: JournalPort;
  recall?: LegacyRecall;
  screen?: (text: string, home: string) => string;
}

/** Python truthiness of a decoded JSON value. */
function truthy(value: PyJson | undefined): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string' || Array.isArray(value)) return value.length > 0;
  if (value instanceof Map) return value.size > 0;
  return 'int' in value ? value.int !== 0n : value.float !== 0;
}

/** `shlex.join`. */
function shlexJoin(args: string[]): string {
  return args.map((arg) => (!arg ? "''" : /[^\w@%+=:,./-]/.test(arg) ? `'${arg.replace(/'/g, `'"'"'`)}'` : arg)).join(' ');
}

/** `json.dumps(value)` for a string, with python's default ensure_ascii. */
function asciiJson(text: string): string {
  const short: Record<string, string> = { '"': '\\"', '\\': '\\\\', '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t' };
  return `"${text.replace(/[\\"]|[^ -~]/g, (c) => short[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}"`;
}

/** The request's text fields; every one is a string or absent (null counts as absent). */
type Request = Map<string, PyJson>;
const field = (request: Request, key: string): string => {
  const value = request.get(key);
  return typeof value === 'string' ? value : '';
};

/** `journal save` arguments for a remember request; fields the caller left out stay visible placeholders. */
function saveArgs(request: Request): string[] {
  const or = (key: string, placeholder: string) => field(request, key) || placeholder;
  const args = ['save', '--room', or('room', '<room-id>'), '--turn', or('turn', '<message-id>'), '--text', pyStrip(field(request, 'text')),
    '--tag', or('tag', `<${TAGS.join('|')}>`)];
  if (field(request, 'quote')) args.push('--source', or('turn', '<message-id>'), '--quote', field(request, 'quote'));
  if (field(request, 'source')) args.push('--ref', field(request, 'source'));
  if (!field(request, 'quote') && !field(request, 'source'))
    args.push('--source', or('turn', '<message-id>'), '--quote', '<exact words from that message>');
  if (field(request, 'reason')) args.push('--reason', field(request, 'reason'));
  if (field(request, 'project')) args.push('--project', field(request, 'project'));
  return args;
}
const saveCommand = (request: Request): string => shlexJoin(['reverie', 'agent', 'journal', ...saveArgs(request)]);

/** One journal verb, judged as python judged the CLI's `--json` output: its data, or a thrown reason. */
async function journalCall(journal: JournalPort, verb: (deps: AgentDeps) => Promise<number>): Promise<PyJson> {
  const done = await journal(verb);
  let body: PyJson = new Map();
  try {
    body = parsePyJson(done.out.join('\n') || '{}');
  } catch {
    /* not JSON: judged by the exit code alone */
  }
  const object = body instanceof Map ? body : new Map<string, PyJson>();
  if (done.code !== 0 || object.get('success') === false) {
    const error = object.get('error');
    const reason = (truthy(error) ? (typeof error === 'string' ? error : dumpPyJson(error!)) : '') || pyStrip(done.err.join('\n'))
      || 'journal unavailable';
    throw new Error([...reason].slice(0, 500).join(''));
  }
  return object.has('data') ? object.get('data')! : body;
}

/**
 * Where this is stricter than python, before any store or journal is touched: the text fields must be text, and the
 * query and memory text keep the memory tools' lengths. Python turned other values into their repr.
 */
function tighten(request: Request): void {
  for (const key of TEXT_FIELDS) {
    const value = request.get(key);
    // A null elsewhere reads as absent, as in python; a null query or text python would have turned into "None".
    if (value === undefined || typeof value === 'string' || (value === null && key !== 'query' && key !== 'text')) continue;
    throw new Error(`${key} must be text`);
  }
  if ([...field(request, 'query')].length > QUERY_MAX) throw new Error(`query must be at most ${QUERY_MAX} characters`);
  if ([...field(request, 'text')].length > TEXT_MAX) throw new Error(`text must be at most ${TEXT_MAX} characters`);
}

async function recall(deps: MemoryCliDeps, instance: string, request: Request): Promise<string> {
  const query = field(request, 'query');
  const project = field(request, 'project');
  const legacy = await (deps.recall ?? defaultRecall(deps.env))(instance, { query, ...(project ? { project } : {}) });
  if (!deps.journal) return legacy;
  if (!pyStrip(query)) throw new Error('recall needs a query');
  // The office journal is the store of record; the old store is read here as history until it is imported.
  let entries: PyJson;
  try {
    const data = await journalCall(deps.journal, (d) => agentJournalRecall(d, [pyStrip(query)], undefined, project || undefined));
    if (!(data instanceof Map) || !data.has('entries')) throw new TypeError("'entries'");
    entries = data.get('entries')!;
  } catch (error) {
    if (error instanceof TypeError) throw error;
    // While the journal rolls out, a failed lookup still answers from the old store, and says so.
    return dumpPyJson(new Map<string, PyJson>([['journal', []], ['legacy', parsePyJson(legacy)],
      ['note', `journal lookup failed (${(error as Error).message}); these are only older, read-only results from the old store`]]));
  }
  return dumpPyJson(new Map<string, PyJson>([['journal', entries], ['legacy', parsePyJson(legacy)],
    ['note', 'journal entries are your store of record; legacy results are older, read-only history']]));
}

async function remember(deps: MemoryCliDeps, request: Request, home: string): Promise<string> {
  const text = pyStrip(field(request, 'text'));
  let floor = 'unchecked';
  if (text) {
    try {
      floor = (deps.screen ?? screenMemoryText)(text, home);
    } catch {
      throw new Error('the hard-floor check did not run; nothing was saved');
    }
  }
  if (!text || floor !== '') throw new Error('memory is empty or crossed a hard floor');
  if (!deps.journal) throw new Error(NO_SESSION + saveCommand(request));
  const missing = ['room', 'turn', 'tag'].filter((key) => !pyStrip(field(request, key)));
  if (!field(request, 'quote') && !field(request, 'source')) missing.push('quote or source');
  if (field(request, 'tag') && !TAGS.includes(field(request, 'tag'))) missing.push('a tag from: ' + TAGS.join(', '));
  if (missing.length)
    // Refuse and show the command; never run it, and never fill in the room or turn ourselves.
    throw new Error(`remember needs ${missing.join(', ')}. Nothing was saved. To save it to your journal, run: ${saveCommand(request)}`);
  const turn = field(request, 'turn');
  const saved = await journalCall(deps.journal, async (d) => agentJournalSave(d, {
    room: await journalRoom(d, field(request, 'room')), turn, text, tag: [field(request, 'tag')],
    ...(field(request, 'quote') ? { source: [turn], quote: [field(request, 'quote')] } : {}),
    ...(field(request, 'source') ? { ref: [field(request, 'source')] } : {}),
    ...(field(request, 'reason') ? { reason: field(request, 'reason') } : {}),
    ...(field(request, 'project') ? { project: field(request, 'project') } : {}),
  }));
  return dumpPyJson(saved);
}

const defaultRecall = (env: NodeJS.ProcessEnv): LegacyRecall => (instance, request) =>
  legacyRecall(instance, request, { home: env.HOME ?? '/tmp', embedUrl: envValue(env, 'EMBED_URL') ?? '' });

/** Run one request: 0 with the result on stdout, or 1 with `{"error": ...}` on stderr, as python did. */
export async function agentMemory(deps: MemoryCliDeps): Promise<number> {
  const home = deps.env.HOME ?? '/tmp';
  try {
    if (!deps.instance) throw new Error('select an instance with --instance or REVERIE_INSTANCE_CONFIG');
    const request = parsePyJson(deps.input);
    if (!(request instanceof Map) || !['recall', 'remember'].includes(request.get('action') as string))
      throw new Error('expected a recall or remember JSON object');
    const project = request.get('project');
    const isPrivate = request.get('private');
    request.delete('private');
    if (truthy(project) === truthy(isPrivate)) throw new Error('select exactly one project or private scope');
    if (truthy(isPrivate) && request.get('channel') === 'work') throw new Error('private memory is unavailable in shared channels');
    if (truthy(project)) request.set('channel', 'work');
    tighten(request);
    // Python opened the instance before either action, so a bad instance config fails both the same way.
    try {
      instanceDataDir(deps.instance, home);
    } catch (error) {
      throw pyOsError(error);
    }
    deps.out(request.get('action') === 'recall' ? await recall(deps, deps.instance, request) : await remember(deps, request, home));
    return 0;
  } catch (error) {
    deps.err(`{"error": ${asciiJson(error instanceof Error ? error.message : String(error))}}`);
    return 1;
  }
}

/** Python bounded one whole journal command (its subprocess) to 60 seconds. */
export const JOURNAL_BUDGET_MS = 60_000;
/** The most one journal response may carry, enforced while it is read; python had no such cap. */
export const JOURNAL_RESPONSE_MAX = 1024 * 1024;

/**
 * A transport whose every request in one journal command shares one absolute deadline (room resolution included) and
 * the response cap. The transport destroys the request at its deadline or past the cap, so nothing is left running.
 */
export function budgeted(request: ApiRequest, budgetMs: number, clock: () => number = Date.now): ApiRequest {
  const deadline = clock() + budgetMs;
  return (ctx, options) => {
    const left = Math.floor(deadline - clock());
    if (left <= 0) return Promise.reject(new Error(`the journal command took longer than ${budgetMs} ms`));
    const own = options.bounds;
    return request(ctx, { ...options, bounds: {
      maxBytes: Math.min(own?.maxBytes ?? JOURNAL_RESPONSE_MAX, JOURNAL_RESPONSE_MAX),
      deadlineMs: Math.min(own?.deadlineMs ?? left, left),
    } });
  };
}

export interface SessionJournalOptions {
  transport?: ApiRequest;
  budgetMs?: number;
  /** The credentials file reader resolveAgentContext uses; injectable so tests never read a real one. */
  envFile?: () => Record<string, string>;
}

/** The journal as the session this process runs in, when the environment names one (python's test). */
export function sessionJournal(env: NodeJS.ProcessEnv, options: SessionJournalOptions = {}): JournalPort | undefined {
  if (!env.REVERIE_SESSION_ID) return undefined;
  return async (verb) => {
    const out: string[] = [];
    const err: string[] = [];
    let deps: AgentDeps;
    try {
      deps = { ctx: resolveAgentContext(env, options.envFile),
        request: budgeted(options.transport ?? httpRequest, options.budgetMs ?? JOURNAL_BUDGET_MS), json: true,
        io: { out: (line) => out.push(line), err: (line) => err.push(line) } };
    } catch (error) {
      if (error instanceof AgentGuardError) return { code: 4, out, err: [error.message] };
      throw error;
    }
    return { code: await verb(deps), out, err };
  };
}

/**
 * Python printed nothing on standard error when it succeeded; node:sqlite announces itself there once as experimental.
 * Drop only that notice, for this command.
 */
function quietSqliteNotice(): void {
  const emit = process.emitWarning.bind(process) as (...args: unknown[]) => void;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const type = typeof rest[0] === 'string' ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
    if (type === 'ExperimentalWarning' && String(warning).startsWith('SQLite is an experimental feature')) return;
    emit(warning, ...rest);
  }) as typeof process.emitWarning;
}

/** Standard input as strict UTF-8, refused past MEMORY_INPUT_MAX bytes. */
export async function readInput(stream: AsyncIterable<Buffer> = process.stdin): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > MEMORY_INPUT_MAX) throw new Error('the request on standard input is too large');
    chunks.push(chunk);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

export function registerMemoryCommand(agent: Command): void {
  agent.command('memory')
    .description('Recall from your old memory store and journal, or save to your journal: one JSON request on standard input (also installed as reverie-memory)')
    .option('--instance <path>', 'Your instance configuration (default: REVERIE_INSTANCE_CONFIG)')
    .action(async (options: { instance?: string }) => {
      quietSqliteNotice();
      const env = process.env;
      let input: string;
      try {
        input = await readInput();
      } catch (error) {
        console.error(`{"error": ${asciiJson((error as Error).message)}}`);
        process.exitCode = 1;
        return;
      }
      process.exitCode = await agentMemory({
        input, env, instance: options.instance || env.REVERIE_INSTANCE_CONFIG || undefined,
        out: (line) => console.log(line), err: (line) => console.error(line), journal: sessionJournal(env),
      });
    });
}
