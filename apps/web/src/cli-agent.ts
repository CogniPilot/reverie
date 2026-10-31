import { isChatRaster, localImageFiles } from './chat-image-paths.js';
/**
 * @fileoverview `reverie agent …` — session-to-session verbs for the agent running
 * inside a Reverie session, in every CLI mode.
 *
 * A thin HTTP client over endpoints that already exist (`quick-start`, `input`,
 * `wait`, `wait-output`, `last-response`, `terminal`, `DELETE sessions/:id`). It
 * invents no route and no transport: everything goes through `REVERIE_API_URL`, so
 * auth, ownership and the per-session waiter cap apply unchanged. The behaviour is
 * the packaged agent skill's (`skills/reverie`), ported from shell prose into code
 * with tests, so a `codex`/`opencode`/`pi` agent — which never gets the claude-only
 * preamble — has the same verbs from one line in its AGENTS.md.
 *
 * Invariants (each asserted in `test/cli-agent.test.ts`):
 * 1. Refuses outside a Reverie session (`REVERIE_MUX=1` + `REVERIE_API_URL`); it
 *    never guesses a URL — a server you are not part of is not yours to drive.
 * 2. `send` transmits printable text plus `\r` only. ESC exists solely as
 *    `interrupt`, which never appends `\r`. A stray control byte is a dead session
 *    in the fullscreen TUIs (opencode's `Ctrl+C` is `app_exit`).
 * 3. `rm` fails closed: empty id, a short self id, or a prefix match in EITHER
 *    direction refuses. Ids appear in full and 8-char form, so equality alone
 *    misses a real combination — and the miss deletes the caller.
 * 4. An id shorter than 8 characters refuses (exit 4) before any request, on every
 *    verb. `9` would resolve to whichever session is alone with that first
 *    character, the user's own interactive tab included.
 *
 * Commands live here as functions returning an exit code, not calling
 * `process.exit`, so the whole surface is unit-testable against a fake server.
 *
 * @module cli-agent
 */
import http from 'node:http';
import { displayTime, displayTimeZone } from './display-time.js';
import { agentCapabilities } from './cli-agent-capabilities.js';
import { agentCredentialsInstall, agentCredentialsList } from './cli-agent-credentials.js';
import { agentCredentialStatus } from './cli-agent-credential-status.js';
import { agentContext, agentContextReceipt } from './cli-agent-context.js';
import { AGENT_EXIT } from './agent-exit-codes.js';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { DIGEST_CURSOR_MAX } from './chatroom-digest.js';
import { StringDecoder } from 'node:string_decoder';
import { MAX_MESSAGE_CHARS } from './chatroom-store.js';
import { saveChatAttachment, chatAttachmentDestinationRefusal } from './cli-chat-attachment.js';
import type { Command } from 'commander';
import type { CompanyWakeReport } from './company-wake.js';
import {
  basicAuthHeader,
  credentialsFrom,
  readReverieEnvFile,
  type ReverieCredentials,
} from './reverie-credentials.js';
import { getCli } from './config/cli-registry/registry.js';
import { GLYPH, palette, table } from './cli-style.js';
import { getErrorMessage } from './types.js';
import { CODEX_REASONING_EFFORTS } from './types/session.js';
import { stripAnsi as stripAnsiSequences } from './utils/regex-patterns.js';
import { quoteForPane } from './pane-quote.js';
import { pronounsProblem, pronounsProposal } from './pronouns.js';
import { agentPlanRequest, agentRequestPlanMove, agentPlanMoveAction, agentPendingPlanMoves } from './cli-plan-request.js';
import { registerGoalCommands } from './cli-goal.js';
import { registerJournalCommands } from './cli-agent-journal.js';
import { registerHireRequestCommands } from './cli-agent-hire-request.js';
import { goalClientTarget } from './goal-client-target.js';

/** A chat message id, as the server stores it. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─────────────────────────────────────────────────────────────────────────────
// Context and guard
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentContext {
  /** Base URL of the Reverie server, from `REVERIE_API_URL`. */
  apiUrl: string;
  /** This session's id, from `REVERIE_SESSION_ID`. */
  selfId: string;
  /** Basic-auth credentials, when the server has a password. */
  auth?: ReverieCredentials;
}

/** Thrown when the process is not inside a Reverie-managed session. */
export class AgentGuardError extends Error {}

/** Exit codes shared by every verb; a shell agent can branch on them. */
export const EXIT = AGENT_EXIT;

/**
 * Resolve the context from the environment, or throw `AgentGuardError`.
 *
 * Credentials in the order every client of the API uses (`credentialsFrom`, shared
 * with `reverie attach` and the TUI): each field from the environment (a session
 * inherits the server's), then the data dir's `.env`. No password means the server
 * is open (single-user) — or it is not, and the 401 says so.
 */
export function resolveAgentContext(
  env: NodeJS.ProcessEnv = process.env,
  envFile: () => Record<string, string> = readReverieEnvFile
): AgentContext {
  if (env.REVERIE_MUX !== '1') {
    throw new AgentGuardError('Not inside a Reverie-managed session (REVERIE_MUX is not 1); refusing to act.');
  }
  const apiUrl = env.REVERIE_API_URL?.trim();
  if (!apiUrl) {
    throw new AgentGuardError('REVERIE_API_URL is not set; refusing to guess a server.');
  }
  const selfId = env.REVERIE_SESSION_ID?.trim();
  if (!selfId) {
    throw new AgentGuardError('REVERIE_SESSION_ID is not set; cannot tell which session is me.');
  }
  const credentials = credentialsFrom(env, envFile());
  return { apiUrl, selfId, auth: credentials.password ? credentials : undefined };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers (the invariants)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Is `id` this session? Prefix in BOTH directions, because ids appear in full and
 * in 8-char form (mux names, UI surfaces, Docker's truncated `$SELF`). A self id
 * shorter than 8 characters cannot prove anything and is treated as "maybe me".
 */
export function isSelfSession(selfId: string, id: string): boolean {
  if (!id || selfId.length < 8) return true;
  return id.startsWith(selfId) || selfId.startsWith(id);
}

/** Why `rm` refuses, or `undefined` when the delete may go ahead. */
export function deleteRefusal(selfId: string, id: string): string | undefined {
  if (!id) return 'refusing: empty session id';
  if (selfId.length < 8) return 'refusing: own session id unset or too short to prove this is not me';
  if (isSelfSession(selfId, id)) return `refusing: ${id} is me`;
  return undefined;
}

/**
 * The prompt `send` was given, which must be ONE argument. Joining several with spaces
 * would turn an unquoted `$(cat notes.txt)`, which the shell splits on every newline,
 * back into a single line, so the multi-line refusal below would never see it.
 */
export function sendPromptFromArgs(words: readonly string[]): { text: string } | { error: string } {
  if (words.length === 1) return { text: words[0] };
  return {
    error: `refusing: the prompt must be ONE argument, got ${words.length} — quote it (\`send <id> "…"\`; a prompt that starts with "-" goes after --: \`send <id> -- "- fix the bug"\`)`,
  };
}

/**
 * Why `send` refuses this text, or `undefined` when it is printable. The composer
 * takes one line; the server strips `\r`/`\n` but everything else below 0x20 (and
 * DEL) reaches the pane as a keypress. None of that is a prompt.
 */
export function inputRefusal(text: string): string | undefined {
  if (text.length === 0) return 'refusing: empty input (use `interrupt` for ESC, `send <id> ""` is never a prompt)';
  // The composer is one line: the server strips newlines, which silently joins the
  // lines into one prompt, and a tab reaches the pane as a keypress (claude: mode toggle).
  if (/[\n\r\t]/.test(text)) {
    return 'refusing: input must be a single line (the composer strips newlines and would join your lines) — join them yourself, or write a file into the workspace and send its path';
  }
  // C0, DEL and C1 (U+0080–U+009F: an 8-bit CSI is still a CSI to a terminal).
  // eslint-disable-next-line no-control-regex
  const control = text.match(/[\x00-\x1f\x7f-\x9f]/);
  if (control) {
    const code = control[0].charCodeAt(0).toString(16).padStart(2, '0');
    return `refusing: input contains control byte 0x${code}; send transmits printable text only (ESC is \`interrupt\`)`;
  }
  return undefined;
}

/**
 * Body for `POST /sessions/:id/input` on the send path: text plus `\r` unless the
 * caller asked to type without submitting. Never anything else.
 */
export function buildSendBody(
  text: string,
  options: { enter: boolean; clientId: string; seq: number; wait?: string | true; waitTimeout?: number; ifIdle?: boolean }
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    input: options.enter ? `${text}\r` : text,
    useMux: true,
    clientId: options.clientId,
    seq: options.seq,
  };
  if (options.wait !== undefined) body.wait = options.wait;
  if (options.waitTimeout !== undefined) body.waitTimeout = options.waitTimeout;
  if (options.ifIdle) body.ifIdle = true;
  return body;
}

/** Body for the interrupt path: a bare ESC, and nothing appended — ever. */
export function buildInterruptBody(clientId: string, seq: number): Record<string, unknown> {
  return { input: '\u001b', useMux: true, clientId, seq };
}

/** `clientId` for this caller: fixed per sending session, so `seq` stays monotonic. */
export function defaultClientId(selfId: string, suffix = ''): string {
  return `reverie-agent-cli-${selfId.slice(0, 8)}${suffix ? `-${suffix}` : ''}`;
}

/**
 * Strip a terminal buffer for humans: the shared ANSI strip (CSI, OSC such as window
 * titles, keypad modes) plus the charset designators (`ESC ( B`) it leaves in.
 */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return stripAnsiSequences(text).replace(/\x1b[()][AB0]/g, '');
}

/** Parse a positive-integer option (`--timeout` ms, `--tail` bytes); the server rejects anything else. */
export function parsePositiveInt(raw: string | undefined, fallback: number, flag = '--timeout'): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${flag} must be a positive integer, got "${raw}"`);
  }
  return n;
}

/**
 * Exit code for a wait result: matched or a signal → ok, `exit` or `ended` → dead,
 * timeout → timeout. `ended` is checked BEFORE the happy paths: a worker that dies
 * during `--until stop` comes back as `ended:true, signal:null` (the registry only
 * satisfies waiters that listed `exit`, then cancels the rest), and a `--match` on
 * a dead worker as `ended:true, matched:false` — both are "dead", never "done".
 */
export function waitExitCode(wait: WaitResult | undefined): number {
  if (!wait) return EXIT.error;
  if (wait.signal === 'exit' || wait.ended) return EXIT.dead;
  if (wait.timedOut) return EXIT.timeout;
  if (wait.matched === false) return EXIT.timeout;
  return EXIT.ok;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP
// ─────────────────────────────────────────────────────────────────────────────

export interface ApiEnvelope<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  errorCode?: string;
}

export interface ApiResponse<T = unknown> {
  status: number;
  /** Parsed envelope, or `undefined` when the body was not JSON (auth guards answer in plain text). */
  json?: ApiEnvelope<T>;
  text: string;
  /** Only requested by bounded binary downloads; never decoded as text. */
  bytes?: Buffer;
  /** Selected response metadata; binary credential clients validate caller and material binding. */
  headers?: Record<string, string | undefined>;
}

export interface WaitResult {
  /** The signal that fired, or null when the wait ended without one. */
  signal?: string | null;
  timedOut?: boolean;
  /** The session went away (deleted / torn down / the write failed) before the wait resolved. */
  ended?: boolean;
  timeoutMs?: number;
  until?: string[];
  matched?: boolean;
  match?: string;
  snippet?: string;
  immediate?: boolean;
}

export interface RequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: Record<string, unknown>;
  /** Raw bytes sent as application/octet-stream (file uploads), instead of a JSON body. */
  rawBody?: Buffer;
  headers?: Record<string, string>;
  /** Socket timeout; long-polls pass their own timeout plus headroom. */
  timeoutMs?: number;
  /** Aborts the request (an MCP client cancelling a long wait); the promise rejects. */
  signal?: AbortSignal;
  /** Binary response with a hard byte ceiling and whole-request deadline (no redirects). */
  binary?: { maxBytes: number; deadlineMs: number };
  /** Optional bounded JSON response, used for attachment room resolution. */
  bounds?: { maxBytes: number; deadlineMs: number };
}

export type ApiRequest = (ctx: AgentContext, options: RequestOptions) => Promise<ApiResponse>;

/** Every request carries these; they are ignored on endpoints that do not read them. */
export function baseHeaders(ctx: AgentContext): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  // Tags sessions this caller spawns as its children (lineage in the web UI).
  // Cosmetic, never fails a call. NOT X-Reverie-Agent-Origin: that one marks a case
  // directory as deletable agent scratch, so it rides only the spawn request that
  // may create one (see agentSpawn), never anything else. Absent for a caller outside
  // any session (`reverie mcp` launched by a desktop MCP client), which has no self.
  if (ctx.selfId) headers['X-Reverie-Parent-Session'] = ctx.selfId;
  const authorization = ctx.auth ? basicAuthHeader(ctx.auth) : undefined;
  if (authorization) headers.Authorization = authorization;
  return headers;
}

/** The real transport. `rejectUnauthorized:false` because the HTTPS install uses a self-signed cert. */
export const httpRequest: ApiRequest = (ctx, options) => {
  const url = new URL(options.path, ctx.apiUrl);
  const bounds = options.binary ?? options.bounds;
  if (
    bounds &&
    (url.origin !== new URL(ctx.apiUrl).origin ||
      !['http:', 'https:'].includes(url.protocol) ||
      !Number.isSafeInteger(bounds.maxBytes) ||
      bounds.maxBytes <= 0 ||
      !Number.isSafeInteger(bounds.deadlineMs) ||
      bounds.deadlineMs <= 0)
  ) {
    return Promise.reject(new Error('invalid bounded download request'));
  }
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const bodyText = options.body === undefined ? undefined : JSON.stringify(options.body);
  const headers: Record<string, string | number> = { ...baseHeaders(ctx), ...(options.headers ?? {}) };
  if (options.rawBody !== undefined) {
    headers['Content-Type'] = 'application/octet-stream';
    headers['Content-Length'] = options.rawBody.length;
  } else if (bodyText !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(bodyText);
  }
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const failed = (error: Error) => {
      clearTimeout(deadline);
      reject(error);
    };
    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        method: options.method,
        path: goalClientTarget(options) ?? `${url.pathname}${url.search}`,
        rejectUnauthorized: false,
        headers,
        timeout: options.timeoutMs ?? 30_000,
        signal: options.signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        // The supported room-file route always declares its raw file length.
        // Refuse uncertain/truncated proxy bodies, never silently accept a prefix.
        const expected = options.binary && res.statusCode === 200 ? res.headers['content-length'] : undefined;
        if (options.binary && res.statusCode === 200 &&
            (expected === undefined || !/^\d+$/.test(expected) ||
             (res.headers['content-encoding'] !== undefined && res.headers['content-encoding'] !== 'identity'))) {
          req.destroy(new Error('download requires an unencoded declared length'));
          res.destroy();
          return;
        }
        if (
          bounds &&
          res.headers['content-length'] !== undefined &&
          (!/^\d+$/.test(res.headers['content-length']) || Number(res.headers['content-length']) > bounds.maxBytes)
        ) {
          req.destroy(new Error('download exceeds byte limit'));
          res.destroy();
          return;
        }
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (bounds && size > bounds.maxBytes) {
            req.destroy(new Error('download exceeds byte limit'));
            res.destroy();
          } else chunks.push(chunk);
        });
        // A connection dropped mid-body emits 'error' and never 'end'; without this the
        // promise never settles (and a long-lived `reverie mcp` never answers the call).
        res.on('error', failed);
        res.on('end', () => {
          clearTimeout(deadline);
          if (options.binary) {
            if (expected !== undefined && size !== Number(expected)) {
              failed(new Error('download length mismatch'));
              return;
            }
            resolve({ status: res.statusCode ?? 0, text: '', bytes: Buffer.concat(chunks),
              headers: Object.fromEntries(Object.entries(res.headers).filter((entry): entry is [string, string] =>
                ['content-type', 'cache-control', 'x-reverie-employee-id', 'x-reverie-session-id', 'x-reverie-credential-id'].includes(entry[0]) && typeof entry[1] === 'string')) });
            return;
          }
          const text = Buffer.concat(chunks).toString('utf-8');
          let json: ApiEnvelope | undefined;
          try {
            json = JSON.parse(text) as ApiEnvelope;
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode ?? 0, json, text });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error(`request timed out after ${options.timeoutMs ?? 30_000} ms`)));
    req.on('error', failed);
    if (bounds) deadline = setTimeout(() => req.destroy(new Error('download deadline exceeded')), bounds.deadlineMs);
    if (options.rawBody !== undefined) req.write(options.rawBody);
    else if (bodyText !== undefined) req.write(bodyText);
    req.end();
  });
};

/** A server field as one line of text: a nested `{ message }` keeps its words, anything else is bounded JSON, never `[object Object]`. */
function envelopeText(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value.trim() || fallback;
  if (value === undefined || value === null) return fallback;
  const message = (value as { message?: unknown }).message;
  if (typeof message === 'string' && message.trim()) return message.trim();
  try {
    return JSON.stringify(value).slice(0, 200);
  } catch {
    return fallback;
  }
}

/** One line describing a failed response, for humans. Plain-text guards (401/403/429) have no envelope. */
export function describeFailure(res: ApiResponse): string {
  if (res.json && !res.json.success) {
    const error = envelopeText(res.json.error, 'request failed');
    // A framework error body ({ error: 'Service Unavailable', message }) puts the useful words in `message`.
    const detail = envelopeText((res.json as { message?: unknown }).message, '');
    const text = detail && detail !== error ? `${error}: ${detail}` : error;
    return `${envelopeText(res.json.errorCode, 'ERROR')}: ${text} (HTTP ${res.status})`;
  }
  const text = res.text.trim().split('\n')[0] ?? '';
  if (res.status === 401)
    return `HTTP 401 ${text}: the server wants a password (REVERIE_PASSWORD, or the data dir's .env)`;
  return `HTTP ${res.status}${text ? ` ${text}` : ''}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface AgentDeps {
  ctx: AgentContext;
  request: ApiRequest;
  io: AgentIo;
  json: boolean;
  /** Clock for `seq`; injectable so tests are deterministic. */
  now?: () => number;
}

/** Shared thin client for model-context hooks; successful reads never consume delivery. */
export async function agentChatSummary(deps: AgentDeps, hookEvent?: string): Promise<number> {
  if (hookEvent && !['SessionStart', 'UserPromptSubmit', 'PostToolUse'].includes(hookEvent))
    return fail(deps, 'Unsupported summary hook event');
  const result = await deps.request(deps.ctx, { method: 'GET', path: '/api/chatrooms/turn-summary', timeoutMs: 2000 });
  const data = result.json?.data as { text?: unknown } | undefined;
  if (!result.json?.success || typeof data?.text !== 'string' || data.text.length > 3000)
    return fail(deps, 'Pending message summary unavailable');
  if (hookEvent) {
    deps.io.out(JSON.stringify({ hookSpecificOutput: { hookEventName: hookEvent, additionalContext: data.text } }));
  } else if (deps.json) emitJson(deps, data);
  else if (data.text) deps.io.out(data.text);
  return 0;
}

/**
 * Fresh own digest; no hook installation, suppression marker or read state. By default it continues from, and moves,
 * this agent's digest cursor (FYIs already covered are not repeated); --all and --since leave the cursor alone.
 */
export async function agentChatDigest(deps: AgentDeps, options: { all?: boolean; since?: string } = {}): Promise<number> {
  if (options.all && options.since !== undefined) return fail(deps, 'Use --all or --since, not both');
  let since = options.since;
  // A cursor can be longer than a command-line argument; --since @FILE reads it from a file (e.g. saved from --json).
  if (since?.startsWith('@')) {
    try {
      since = readFileSync(since.slice(1), 'utf8').trim();
    } catch {
      return fail(deps, 'Could not read the cursor file');
    }
  }
  if (since !== undefined && (!since || since.length > DIGEST_CURSOR_MAX)) return fail(deps, 'Use --since with a cursor printed by an earlier digest');
  // An explicit cursor goes in the body: a long one does not fit in a URL.
  const result = await deps.request(deps.ctx, since !== undefined
    ? { method: 'POST', path: '/api/chatrooms/digest', body: { since }, timeoutMs: 2000 }
    : { method: 'GET', path: '/api/chatrooms/digest', timeoutMs: 2000, ...(options.all ? { query: { since: 'all' } } : {}) });
  const data = result.json?.data as { version?: unknown; generatedAt?: unknown; text?: unknown; revision?: unknown } | undefined;
  const age = (deps.now?.() ?? Date.now()) - Number(data?.generatedAt);
  if (!result.json?.success || data?.version !== 2 || typeof data.text !== 'string' || data.text.length > 12000 ||
      typeof data.revision !== 'string' || !/^[a-f0-9]{64}$/.test(data.revision) ||
      typeof data.generatedAt !== 'number' || !Number.isSafeInteger(data.generatedAt) || age < -5000 || age > 30000)
    return fail(deps, 'Fresh actionable digest unavailable; attention and read state are unchanged');
  if (deps.json) emitJson(deps, data);
  else deps.io.out(data.text);
  return EXIT.ok;
}

/** Print `data` as JSON (the `--json` path) — always the envelope's `data`, never a reshaped copy. */
function emitJson(deps: AgentDeps, data: unknown): void {
  deps.io.out(JSON.stringify(data, null, 2));
}

function fail(deps: AgentDeps, message: string, code: number = EXIT.error): number {
  if (deps.json) {
    deps.io.out(JSON.stringify({ success: false, error: message }));
  } else {
    deps.io.err(palette.err(`${GLYPH.fail} ${message}`));
  }
  return code;
}

interface SessionRow {
  id: string;
  name?: string;
  mode?: string;
  status?: string;
  workingDir?: string;
  pid?: number | null;
  parentSessionId?: string | null;
}

/** A full session id (the only form the routes accept); `ls` prints the 8-char prefix. */
const FULL_ID_LENGTH = 36;

/**
 * Shortest prefix that may name a session: the 8-char form `ls` prints, and the floor
 * the server's own resolver uses (`PARENT_SESSION_ID_MIN_PREFIX`, route-helpers.ts).
 */
export const MIN_ID_PREFIX_LENGTH = 8;

/**
 * Turn the id a human typed into the one the routes accept. `ls` prints 8-char
 * prefixes and the routes answer 404 to those (measured live), so anything shorter
 * than a full id resolves through the session list; an ambiguous prefix refuses
 * rather than picking one. Below 8 characters it refuses before the list: "unique"
 * means nothing for `9` — it names whatever session happens to be alone with that
 * first character, and `rm`/`send` would act on it.
 */
export async function resolveSessionId(
  deps: AgentDeps,
  id: string
): Promise<{ id: string } | { error: string; code: number }> {
  if (!id) return { error: 'refusing: empty session id', code: EXIT.refused };
  if (id.length < MIN_ID_PREFIX_LENGTH) {
    return {
      error: `refusing: "${id}" is shorter than ${MIN_ID_PREFIX_LENGTH} characters — use the 8-character id \`agent ls\` prints, or the full id`,
      code: EXIT.refused,
    };
  }
  if (id.length >= FULL_ID_LENGTH) return { id };
  const res = await deps.request(deps.ctx, { method: 'GET', path: '/api/v1/sessions' });
  if (!res.json?.success) return { error: describeFailure(res), code: EXIT.error };
  const matches = ((res.json.data as SessionRow[] | undefined) ?? []).filter((s) => s.id.startsWith(id));
  if (matches.length === 1) return { id: matches[0].id };
  if (matches.length === 0) return { error: `no session starts with "${id}" (see \`agent ls\`)`, code: EXIT.error };
  return { error: `"${id}" is ambiguous: ${matches.map((s) => s.id.slice(0, 13)).join(', ')}`, code: EXIT.error };
}

/** `agent ls` — every session the caller can see, self marked. */
export async function agentLs(deps: AgentDeps): Promise<number> {
  const res = await deps.request(deps.ctx, { method: 'GET', path: '/api/v1/sessions' });
  if (!res.json?.success) return fail(deps, describeFailure(res));
  const sessions = (res.json.data as SessionRow[] | undefined) ?? [];
  if (deps.json) {
    emitJson(
      deps,
      sessions.map((s) => ({ ...s, self: isSelfSession(deps.ctx.selfId, s.id) }))
    );
    return EXIT.ok;
  }
  if (sessions.length === 0) {
    deps.io.out(palette.muted('(no sessions)'));
    return EXIT.ok;
  }
  const rows = sessions.map((s) => [
    isSelfSession(deps.ctx.selfId, s.id) ? '*' : ' ',
    s.id.slice(0, 8),
    s.mode ?? '?',
    s.status ?? '?',
    s.name || s.workingDir || '',
  ]);
  deps.io.out(table([[' ', 'ID', 'MODE', 'STATUS', 'NAME'], ...rows], { gap: 2 }));
  deps.io.out(
    palette.muted(`* = this session (${deps.ctx.selfId.slice(0, 8)}). status is a UI hint, never a sync signal.`)
  );
  return EXIT.ok;
}

export interface SpawnOptions {
  caseName: string;
  mode: string;
  name?: string;
  /** Wait for the composer before returning, where the registry gives the mode a ready mark. */
  ready: boolean;
  timeoutMs: number;
  /** Codex-only launch options; sent as `codexConfig` on the normal create path. */
  reasoningEffort?: string;
  bypassApprovals?: boolean;
  resumeSessionId?: string;
}

/**
 * Agent-scratch label for a case directory a spawn CREATES (the server applies it only
 * when quick-start makes the directory). The Add Case UI offers a recursive delete for
 * such directories, so this header must never ride any other request: mislabelling a
 * real repo there is the one failure in this area that costs actual work.
 */
export const AGENT_ORIGIN_HEADER = { 'X-Reverie-Agent-Origin': 'reverie-agent-cli' } as const;

/**
 * What the mode's TUI draws once its composer can take a prompt, from the CLI registry
 * (`capabilities.composerReadyMark`); undefined means the mode has no readiness wait.
 */
export function composerReadyMark(mode: string): string | undefined {
  return getCli(mode)?.capabilities.composerReadyMark;
}
/** `agent spawn` — quick-start with lineage, then the readiness ladder where the mode has one. */
export async function agentSpawn(deps: AgentDeps, options: SpawnOptions): Promise<number> {
  const codexConfig: Record<string, unknown> = {};
  if (options.reasoningEffort !== undefined) codexConfig.reasoningEffort = options.reasoningEffort;
  if (options.bypassApprovals) codexConfig.dangerouslyBypassApprovals = true;
  if (options.resumeSessionId !== undefined) codexConfig.resumeSessionId = options.resumeSessionId;
  if (Object.keys(codexConfig).length > 0) {
    if (options.mode !== 'codex') {
      return fail(deps, '--reasoning-effort, --bypass-approvals and --resume-session apply to --mode codex only');
    }
    if (
      options.reasoningEffort !== undefined &&
      !(CODEX_REASONING_EFFORTS as readonly string[]).includes(options.reasoningEffort)
    ) {
      return fail(deps, `--reasoning-effort must be one of: ${CODEX_REASONING_EFFORTS.join(', ')}`);
    }
    if (options.resumeSessionId !== undefined && !/^[a-zA-Z0-9_-]{1,100}$/.test(options.resumeSessionId)) {
      return fail(deps, '--resume-session must be a thread id (letters, digits, - and _ only)');
    }
  }
  const body: Record<string, unknown> = {
    caseName: options.caseName,
    mode: options.mode,
    parentSessionId: deps.ctx.selfId,
  };
  if (options.name) body.sessionName = options.name;
  if (Object.keys(codexConfig).length > 0) body.codexConfig = codexConfig;
  const res = await deps.request(deps.ctx, {
    method: 'POST',
    path: '/api/v1/quick-start',
    body,
    headers: { ...AGENT_ORIGIN_HEADER },
  });
  const data = res.json?.data as { sessionId?: string; caseName?: string; casePath?: string } | undefined;
  if (!res.json?.success || !data?.sessionId) return fail(deps, describeFailure(res));
  const sid = data.sessionId;

  let ready: boolean | undefined;
  let readinessError: string | undefined;
  let dead = false;
  const mark = composerReadyMark(options.mode);
  if (options.ready && mark) {
    const wait = await deps.request(deps.ctx, {
      method: 'GET',
      path: `/api/v1/sessions/${encodeURIComponent(sid)}/wait-output`,
      query: { match: mark, from: 'buffer', timeout: options.timeoutMs },
      timeoutMs: options.timeoutMs + 10_000,
    });
    // A failed readiness call (waiter cap, 400, network) is its own error, not "the
    // composer never showed up": report the real reason instead of the trust-dialog hint.
    if (!wait.json?.success) readinessError = describeFailure(wait);
    else {
      const result = (wait.json.data as { wait?: WaitResult } | undefined)?.wait;
      // A worker that died while we waited is exit 3 like every other wait, not a
      // "composer not seen" timeout that sends the caller looking for a dialog.
      dead = waitExitCode(result) === EXIT.dead;
      ready = !dead && Boolean(result?.matched);
    }
  }

  if (deps.json) {
    emitJson(deps, { ...data, ready, readinessError });
  } else {
    // Human lines go to stderr so `SID=$(reverie agent spawn …)` captures the id alone.
    const say = (line: string) => deps.io.err(line);
    say(palette.ok(`${GLYPH.ok} spawned ${sid} (${options.mode}, case ${data.caseName ?? options.caseName})`));
    if (ready === true) say(palette.muted('  composer up: the worker can take a prompt'));
    if (dead) say(palette.err(`${GLYPH.fail} the worker exited during the readiness wait`));
    if (ready === false && !dead) {
      say(
        palette.warn(
          `${GLYPH.warn} composer not seen within ${options.timeoutMs} ms — read \`agent read ${sid.slice(0, 8)} --tail 2000\` before sending (a startup dialog?)`
        )
      );
    }
    if (readinessError) say(palette.err(`${GLYPH.fail} readiness check failed: ${readinessError}`));
    if (ready === undefined && !readinessError && options.ready) {
      say(
        palette.muted(
          `  ${options.mode} has no readiness mark; give it a moment, then use --match markers to synchronize`
        )
      );
    }
    deps.io.out(sid);
  }
  if (readinessError) return EXIT.error;
  if (dead) return EXIT.dead;
  return ready === false ? EXIT.timeout : EXIT.ok;
}

export interface SendOptions {
  id: string;
  text: string;
  enter: boolean;
  /** `undefined` = fire-and-forget; `true` = default signal set; string = comma list. */
  wait?: string | true;
  timeoutMs?: number;
  clientId?: string;
  seq?: number;
  /** Server-side idle-only write (`agent wake`): refused while the session works, never typed over a draft. */
  ifIdle?: boolean;
}

/** `agent send` — printable text plus `\r`, exactly-once, optionally blocking on end of turn. */
export async function agentSend(deps: AgentDeps, options: SendOptions): Promise<number> {
  if (isSelfSession(deps.ctx.selfId, options.id)) {
    return fail(deps, `refusing: ${options.id} is me — typing into my own composer is not a message`, EXIT.refused);
  }
  const refusal = inputRefusal(options.text);
  if (refusal) return fail(deps, refusal, EXIT.refused);
  const target = await resolveSessionId(deps, options.id);
  if ('error' in target) return fail(deps, target.error, target.code);
  const body = buildSendBody(options.text, {
    enter: options.enter,
    clientId: options.clientId ?? defaultClientId(deps.ctx.selfId),
    seq: options.seq ?? (deps.now ?? Date.now)(),
    wait: options.wait,
    waitTimeout: options.wait !== undefined ? options.timeoutMs : undefined,
    ifIdle: options.ifIdle,
  });
  const res = await deps.request(deps.ctx, {
    method: 'POST',
    path: `/api/v1/sessions/${encodeURIComponent(target.id)}/input`,
    body,
    timeoutMs: (options.timeoutMs ?? 60_000) + 10_000,
  });
  // An idle-only send refused because the session is working is a refusal, not an error.
  if (!res.json?.success) return fail(deps, describeFailure(res), options.ifIdle && res.status === 409 ? EXIT.refused : EXIT.error);
  const data = res.json.data as
    | { delivered?: boolean; typedUnsent?: boolean; duplicate?: boolean; buffered?: boolean; dropped?: boolean; workerDead?: boolean; wait?: WaitResult }
    | undefined;
  if (deps.json) emitJson(deps, data ?? {});
  if (options.ifIdle && data?.delivered === false && !data.duplicate) {
    if (!deps.json)
      deps.io.err(palette.err(data.typedUnsent
        ? `${GLYPH.fail} not woken: ${target.id} became busy after the wake text was typed — Enter was withheld, so the text is left unsent in its composer and will not be retried`
        : `${GLYPH.fail} not woken: ${target.id} is busy or has a draft in its composer — nothing was typed`));
    return EXIT.refused;
  }
  // Fire-and-forget to a remote session whose host is asleep (wake-on-LAN): the server
  // holds the chunk and types it once the pane is back (`buffered`), or the chunk was
  // over the wake buffer's cap and is gone (`dropped`). The seq is spent either way,
  // so a retry needs a new one (the default, the clock, gives it that).
  if (data?.dropped) {
    if (!deps.json) {
      deps.io.err(
        palette.err(
          `${GLYPH.fail} dropped: ${target.id}'s host is waking and its input buffer is full — nothing will be typed; send again once it is back`
        )
      );
    }
    return EXIT.error;
  }
  // `delivered:false` without `duplicate` is the route's "the bytes went nowhere":
  // the PTY exited or send-keys hit a dead pane. The field exists so a client does not
  // say "wait longer" when the truth is "restart the worker" — so it is a failure here.
  if (data?.delivered === false && !data.duplicate && data.workerDead === false) {
    // The server checked the pane and it is alive: the write itself failed (a broker or website pause), so this is a
    // retry, not a restart. Restarting a live worker would cut its turn.
    if (!deps.json) {
      deps.io.err(
        palette.err(`${GLYPH.fail} not delivered: the write to ${target.id} failed but its worker is still running — retry shortly; do not restart it`)
      );
    }
    return EXIT.error;
  }
  if (data?.delivered === false && !data.duplicate) {
    if (!deps.json) {
      deps.io.err(
        palette.err(`${GLYPH.fail} not delivered: ${target.id} has no live worker (pane exited) — restart it`)
      );
    }
    return EXIT.dead;
  }
  if (!deps.json) {
    const noEnter = options.enter ? '' : ' (no Enter)';
    if (data?.duplicate) {
      deps.io.out(palette.warn(`${GLYPH.warn} duplicate (clientId/seq already applied): nothing typed`));
    } else if (data?.buffered) {
      deps.io.out(
        palette.ok(
          `${GLYPH.ok} buffered for ${target.id}${noEnter}: its host is asleep; Reverie is waking it and types this once the pane is back`
        )
      );
    } else if (data?.delivered === true) {
      deps.io.out(palette.ok(`${GLYPH.ok} delivered to ${target.id}${noEnter}`));
    } else {
      // Fire-and-forget answers before the write, so there is no delivery report here.
      deps.io.out(palette.ok(`${GLYPH.ok} accepted for ${target.id}${noEnter} (no delivery report without --wait)`));
    }
    if (data?.wait) deps.io.out(describeWait(data.wait));
  }
  if (options.wait === undefined) return EXIT.ok;
  return waitExitCode(data?.wait);
}

/** What `agent wake` types: one standard nudge, so a woken agent knows why it was prompted and where to look. */
export const WAKE_PROMPT =
  'Wake-up check from a colleague: you look idle. Read what needs you (reverie agent chat digest), check your Board cards (reverie board show --mine), then carry on with your current work or say what is blocking you.';

/**
 * `agent wake` — type the standard resume prompt into an idle colleague's composer (an agent should be
 * able to wake a sleeping agent with one command). It goes through the same input route as `send`, so the server decides who
 * may type where. A session that is working is left alone: the CLI checks first, and the server checks again at write time
 * (`ifIdle`), types only into an empty composer and never falls back to a raw write.
 */
export async function agentWake(deps: AgentDeps, options: { id: string }): Promise<number> {
  if (isSelfSession(deps.ctx.selfId, options.id)) {
    return fail(deps, `refusing: ${options.id} is me — I am awake`, EXIT.refused);
  }
  const target = await resolveSessionId(deps, options.id);
  if ('error' in target) return fail(deps, target.error, target.code);
  const res = await deps.request(deps.ctx, { method: 'GET', path: '/api/v1/sessions' });
  if (!res.json?.success) return fail(deps, describeFailure(res));
  const row = ((res.json.data as SessionRow[] | undefined) ?? []).find((s) => s.id === target.id);
  if (!row) return fail(deps, `no session ${target.id} (see \`agent ls\`)`, EXIT.error);
  if (row.status !== 'idle') {
    return fail(deps, `not waking ${row.name ?? target.id}: it is ${row.status ?? 'in an unknown state'}, not idle`, EXIT.refused);
  }
  return agentSend(deps, { id: target.id, text: WAKE_PROMPT, enter: true, ifIdle: true });
}

/** Recover one exact company employee through the caller's existing scoped API. Never types session input. */
export async function agentWakeEmployee(deps: AgentDeps, options: { employeeId: string }): Promise<number> {
  const id = options.employeeId;
  if (!UUID_RE.test(id) || id !== id.toLowerCase()) {
    return fail(
      deps,
      'Use a full canonical employee UUID from /api/company; session IDs and PIDs are not employee IDs.',
      EXIT.refused
    );
  }
  const company = await deps.request(deps.ctx, { method: 'GET', path: '/api/company' });
  if (company.status < 200 || company.status >= 300 || !company.json?.success)
    return fail(
      deps,
      describeFailure(company),
      company.status === 401 || company.status === 403 ? EXIT.refused : EXIT.error
    );
  const employees = (company.json.data as { employees?: Array<{ id?: unknown }> } | undefined)?.employees;
  if (!Array.isArray(employees)) return fail(deps, 'Company employee identities could not be confirmed.');
  if (employees.filter((employee) => employee?.id === id).length !== 1)
    return fail(deps, 'No unique company employee has that full UUID; do not use a session ID or PID.', EXIT.refused);

  let response: ApiResponse;
  try {
    response = await deps.request(deps.ctx, {
      method: 'POST',
      path: `/api/company/employees/${id}/wake`,
      body: {},
    });
  } catch {
    return fail(deps, 'Employee wake outcome is unconfirmed. Check its current state before trying again.');
  }
  if (response.status < 200 || response.status >= 300 || !response.json?.success)
    return fail(deps, describeFailure(response), [401, 403, 409].includes(response.status) ? EXIT.refused : EXIT.error);
  const data = response.json.data as { recovery?: CompanyWakeReport } | undefined;
  const recovery = data?.recovery;
  if (
    !recovery ||
    !Array.isArray(recovery.awakened) ||
    !Array.isArray(recovery.skipped) ||
    recovery.awakened.length + recovery.skipped.length > 1 ||
    !recovery.awakened.every((employeeId) => employeeId === id) ||
    !recovery.skipped.every(
      (skip) =>
        skip &&
        typeof skip === 'object' &&
        skip.employeeId === id &&
        typeof skip.reason === 'string' &&
        skip.reason.length > 0 &&
        skip.reason.length <= 200
    )
  )
    return fail(deps, 'Employee wake result could not be confirmed. Check its current state before trying again.');
  if (deps.json) emitJson(deps, data);
  else if (recovery.awakened.length) deps.io.out(`Awakened employee ${id}.`);
  else if (recovery.skipped.length)
    deps.io.out(`Skipped employee ${id}: ${quoteForPane(recovery.skipped[0].reason, 200)}`);
  else deps.io.out(`No employee awakened; the server returned no recovery outcome for ${id}.`);
  return recovery.awakened.length ? EXIT.ok : EXIT.refused;
}

function describeWait(wait: WaitResult): string {
  if (wait.signal === 'exit') return palette.err(`${GLYPH.fail} the session exited`);
  if (wait.ended) {
    return palette.err(
      `${GLYPH.fail} the wait ended without an answer: the session went away (dead worker, deleted, or nothing was written)`
    );
  }
  // A timeout is a 200 with `timedOut`, an answer rather than a failure: exit 2 says it,
  // so the line stays neutral instead of looking like an error to whoever reads the log.
  if (wait.timedOut) return palette.muted(`timed out after ${wait.timeoutMs ?? '?'} ms (exit 2)`);
  if (wait.matched !== undefined) {
    return wait.matched
      ? palette.ok(`${GLYPH.ok} matched "${wait.match}"${wait.snippet ? `: ${wait.snippet}` : ''}`)
      : palette.muted('not matched (exit 2)');
  }
  return palette.ok(
    `${GLYPH.ok} signal: ${wait.signal}${wait.immediate ? ' (immediate: current state, not a transition)' : ''}`
  );
}

export interface WaitOptions {
  id: string;
  until?: string;
  match?: string;
  from?: 'buffer' | 'now';
  fresh?: boolean;
  nocase?: boolean;
  timeoutMs: number;
}

/** `agent wait` — a signal (`--until`) or a literal output marker (`--match`). */
export async function agentWait(deps: AgentDeps, options: WaitOptions): Promise<number> {
  if (options.until && options.match)
    return fail(deps, 'use either --until <signals> or --match <marker>, not both', EXIT.refused);
  const target = await resolveSessionId(deps, options.id);
  if ('error' in target) return fail(deps, target.error, target.code);
  const sid = encodeURIComponent(target.id);
  const res = options.match
    ? await deps.request(deps.ctx, {
        method: 'GET',
        path: `/api/v1/sessions/${sid}/wait-output`,
        query: {
          match: options.match,
          from: options.from ?? 'buffer',
          nocase: options.nocase ? 1 : undefined,
          timeout: options.timeoutMs,
        },
        timeoutMs: options.timeoutMs + 10_000,
      })
    : await deps.request(deps.ctx, {
        method: 'GET',
        path: `/api/v1/sessions/${sid}/wait`,
        query: { until: options.until, fresh: options.fresh ? 1 : undefined, timeout: options.timeoutMs },
        timeoutMs: options.timeoutMs + 10_000,
      });
  // A 400 here is the server saying "this mode has no such signal" (until=stop on an
  // external CLI). Passed through, never papered over: the marker path is the answer.
  if (!res.json?.success) return fail(deps, describeFailure(res));
  const data = res.json.data as { wait?: WaitResult; status?: string; limitPaused?: boolean } | undefined;
  if (deps.json) {
    emitJson(deps, data ?? {});
  } else if (data?.wait) {
    deps.io.out(describeWait(data.wait));
    if (data.limitPaused)
      deps.io.out(palette.warn(`${GLYPH.warn} session is paused on a usage limit; a timeout is expected`));
  }
  return waitExitCode(data?.wait);
}

export interface ReadOptions {
  id: string;
  /** Bytes of raw terminal to fetch; ANSI is stripped for humans. */
  tail?: number;
  /** Whole conversation (`context=full`) instead of the last assistant message. */
  full?: boolean;
}

/** `agent read` — the last answer (the route picks the transcript reader or the pane segmenter) or a terminal tail. */
export async function agentRead(deps: AgentDeps, options: ReadOptions): Promise<number> {
  const target = await resolveSessionId(deps, options.id);
  if ('error' in target) return fail(deps, target.error, target.code);
  const sid = encodeURIComponent(target.id);
  if (options.tail !== undefined) {
    const res = await deps.request(deps.ctx, {
      method: 'GET',
      path: `/api/v1/sessions/${sid}/terminal`,
      query: { tail: options.tail },
    });
    if (!res.json?.success) return fail(deps, describeFailure(res));
    const buffer = (res.json.data as { terminalBuffer?: string } | undefined)?.terminalBuffer ?? '';
    if (deps.json) emitJson(deps, res.json.data);
    else deps.io.out(stripAnsi(buffer));
    return EXIT.ok;
  }
  const res = await deps.request(deps.ctx, {
    method: 'GET',
    path: `/api/v1/sessions/${sid}/last-response`,
    query: { context: options.full ? 'full' : undefined },
  });
  if (!res.json?.success) return fail(deps, describeFailure(res));
  const data = res.json.data as
    | { text?: string; timestamp?: string; messages?: Array<{ role: string; text: string }> }
    | undefined;
  if (deps.json) {
    emitJson(deps, data ?? {});
    return EXIT.ok;
  }
  if (options.full && data?.messages) {
    for (const m of data.messages) deps.io.out(`${palette.emph(m.role)}: ${m.text}`);
    return EXIT.ok;
  }
  const text = data?.text ?? '';
  if (!text) {
    deps.io.err(
      palette.muted('(empty: nothing answered yet, or nothing the server could segment as an answer; try --tail 3000)')
    );
    return EXIT.ok;
  }
  deps.io.out(text);
  return EXIT.ok;
}

/** `agent interrupt` — a bare ESC keypress, no Enter, conversation intact. */
export async function agentInterrupt(deps: AgentDeps, options: { id: string }): Promise<number> {
  if (isSelfSession(deps.ctx.selfId, options.id)) return fail(deps, `refusing: ${options.id} is me`, EXIT.refused);
  const target = await resolveSessionId(deps, options.id);
  if ('error' in target) return fail(deps, target.error, target.code);
  const body = buildInterruptBody(defaultClientId(deps.ctx.selfId, 'interrupt'), (deps.now ?? Date.now)());
  const res = await deps.request(deps.ctx, {
    method: 'POST',
    path: `/api/v1/sessions/${encodeURIComponent(target.id)}/input`,
    body,
  });
  if (!res.json?.success) return fail(deps, describeFailure(res));
  if (deps.json) emitJson(deps, res.json.data ?? {});
  else
    deps.io.out(
      palette.ok(
        `${GLYPH.ok} ESC sent to ${target.id} — one Esc does not always land; read the tail before the next prompt`
      )
    );
  return EXIT.ok;
}

/** `agent rm` — delete a session that is provably not this one. */
export async function agentRm(deps: AgentDeps, options: { id: string }): Promise<number> {
  const refusal = deleteRefusal(deps.ctx.selfId, options.id);
  if (refusal) return fail(deps, refusal, EXIT.refused);
  const target = await resolveSessionId(deps, options.id);
  if ('error' in target) return fail(deps, target.error, target.code);
  // The guard again on the RESOLVED id: a prefix that is not me can still resolve
  // to me only if the list is lying, but a delete is the one call worth the paranoia.
  const resolvedRefusal = deleteRefusal(deps.ctx.selfId, target.id);
  if (resolvedRefusal) return fail(deps, resolvedRefusal, EXIT.refused);
  const res = await deps.request(deps.ctx, {
    method: 'DELETE',
    path: `/api/v1/sessions/${encodeURIComponent(target.id)}`,
  });
  if (!res.json?.success) return fail(deps, describeFailure(res));
  if (deps.json) emitJson(deps, res.json.data ?? {});
  else deps.io.out(palette.ok(`${GLYPH.ok} deleted ${target.id} (its case directory stays on disk)`));
  return EXIT.ok;
}

// ─────────────────────────────────────────────────────────────────────────────
// Chatrooms (`agent chat …`)
// ─────────────────────────────────────────────────────────────────────────────

interface ChatMemberRow {
  sessionId: string;
  icon?: string;
  name: string;
  role: string;
  goal: string;
  progress: string;
  away?: string;
  /** Owner-set, from the member's employee record. */
  pronouns?: string;
  /** Its own 'doing' Board cards, read from the Board by the server (never stored on the membership). */
  focus?: Array<{ id: string; title: string; end?: number }>;
  focusMore?: number;
  alive?: boolean;
  working?: boolean;
  updatedAt?: number;
}

interface ChatMessageRow {
  id: string;
  at: number;
  from: { kind: string; name: string; sessionId?: string };
  to: 'all' | string[];
  text: string;
  attachments?: Array<{ id: string; name: string; path: string; type: string; size: number; localPath?: string; localImageStatus?: 'ready' | 'unavailable' }>;
  /** Set when the user deleted the message (its text is then empty). */
  deleted?: { at: number };
  /** A poll: `text` is its question. */
  poll?: ChatPollRow;
  edited?: { at: number };
  pinned?: { at: number; by: string; kind?: 'user' | 'agent' };
}

interface ChatPollRow {
  question: string;
  options: { id: string; label: string }[];
  multi?: boolean;
  closesAt?: number;
  recommended?: string;
  closed?: { at: number; by: string };
  votes: Record<string, string[]>;
}

interface ChatRoomRow {
  id: string;
  name: string;
  topic?: string;
  /** `private` (members only) or `public` (any agent can join); a server that does not say is treated as private. */
  visibility?: 'public' | 'private';
  coordinatorId?: string;
  /** A direct message: it has no name of its own (`dm` lists its participants). */
  kind?: 'dm';
  dm?: string[];
  members: ChatMemberRow[];
  messages?: ChatMessageRow[];
}

/** What a room is called when it has no name: a direct message is "Direct message" (more than two people, "Group message"). */
function chatRoomLabel(room: ChatRoomRow): string {
  if (room.kind !== 'dm' || !Array.isArray(room.dm)) return room.name;
  return room.name || (room.dm.length > 2 ? 'Group message' : 'Direct message');
}

/**
 * Pick the room a chat verb acts on: `--room` (id, 8+ char id prefix, or name) among
 * the rooms the caller can see, else the ONE room this session is a member of, else (in several rooms) the one room the last prompt
 * delivered to it came from. A prompt that bundled several rooms is not a guess to make: it asks for --room and lists them.
 */
export async function resolveChatRoom(
  deps: AgentDeps,
  room: string | undefined
): Promise<{ room: ChatRoomRow; ownerNames?: string[] } | { error: string; code: number }> {
  const res = await deps.request(deps.ctx, {
    method: 'GET',
    path: '/api/v1/chatrooms',
    query: { member: room ? undefined : 'self' },
  });
  if (!res.json?.success) return { error: describeFailure(res), code: EXIT.error };
  const rooms = ((res.json.data as { rooms?: ChatRoomRow[] } | undefined)?.rooms ?? []) as ChatRoomRow[];
  // What the owner is called in a room (company settings), when the server says, for a line that @mentions them.
  const listed = (res.json.data as { ownerNames?: unknown } | undefined)?.ownerNames;
  const ownerNames = Array.isArray(listed)
    ? listed.filter((n): n is string => typeof n === 'string' && !!n.trim())
    : [];
  const found = (r: ChatRoomRow) => (ownerNames.length ? { room: r, ownerNames } : { room: r });
  const lastDelivery = (res.json.data as { lastDelivery?: { roomIds?: string[] } | null } | undefined)?.lastDelivery;
  if (room) {
    const matching = (ref: string) => {
      const wanted = ref.trim().toLowerCase();
      return rooms.filter(
        (r) =>
          r.id === ref ||
          (ref.length >= 8 && r.id.startsWith(ref)) ||
          r.name.toLowerCase() === wanted ||
          chatRoomLabel(r).toLowerCase() === wanted
      );
    };
    // The value as given first (a room may be named "DM:ops"); then the `DM:<roomId>` form a delivered DM header uses.
    let matches = matching(room);
    if (matches.length === 0 && /^DM:/i.test(room.trim())) matches = matching(room.trim().slice(3));
    if (matches.length === 1) return found(matches[0]);
    if (matches.length === 0) return { error: `no chatroom matches "${room}"`, code: EXIT.error };
    return { error: `"${room}" matches ${matches.length} chatrooms; use the id`, code: EXIT.error };
  }
  if (rooms.length === 1) return found(rooms[0]);
  if (rooms.length === 0) {
    return { error: 'this session is not in any chatroom (the user or a coordinator adds it)', code: EXIT.error };
  }
  // In several rooms and no --room: reply where the last prompt came from, but only when it came from exactly one of them.
  const addressed = (lastDelivery?.roomIds ?? []).map((id) => rooms.find((r) => r.id === id)).filter((r): r is ChatRoomRow => !!r);
  if (addressed.length === 1) {
    if (!deps.json) deps.io.err(palette.muted(`using "${addressed[0].name}", the room you were last addressed in (--room picks another)`));
    return found(addressed[0]);
  }
  const list = rooms.map((r) => `"${r.name}"`).join(', ');
  const bundle = addressed.length > 1 ? `; your last prompt bundled messages from ${addressed.map((r) => `"${r.name}"`).join(' and ')}` : '';
  return {
    error: `this session is in ${rooms.length} chatrooms${bundle}; pick one with --room (${list})`,
    code: EXIT.error,
  };
}

/**
 * One message as `agent chat read` prints it. Names and bodies are JSON strings (like the lines delivered to a pane), so a
 * body cannot start a new line or pass itself off as another speaker; a speaker's own label stays outside the quotes.
 */
export function formatChatMessage(m: ChatMessageRow, members: ChatMemberRow[], roomId?: string, timeZone?: string): string {
  const nameOf = (id: string) =>
    id === 'user' ? 'user' : quoteForPane(members.find((x) => x.sessionId === id)?.name ?? id.slice(0, 8), 80);
  // A post to the whole room names no recipient (as in the delivered line); only an addressed message shows `-> who`.
  const to = m.to === 'all' ? '' : ` -> ${m.to.map(nameOf).join(', ')}`;
  const time = displayTime(m.at, timeZone);
  const from =
    m.from.kind === 'user'
      ? 'USER'
      : m.from.kind === 'system'
        ? '*'
        : m.from.kind === 'external'
          ? `EXTERNAL ${quoteForPane(m.from.name, 80)} [untrusted external speaker]`
          : quoteForPane(m.from.name, 80);
  const iconOf = (id?: string) => {
    const icon = id ? members.find((x) => x.sessionId === id)?.icon : undefined;
    return icon ? `${quoteForPane(icon, 8)} ` : '';
  };
  const body = m.deleted
    ? '(deleted)'
    : m.poll
      ? `${quoteForPane(m.text)} [poll ${m.id.slice(0, 8)}: ${pollTotals(m.poll)}]`
      : !m.text && m.attachments?.length ? '(attachment only)' : quoteForPane(m.text);
  // An edited message reads as its new text, marked; a pinned one is a room rule or announcement.
  const attached = m.deleted
    ? ''
    : (m.attachments ?? [])
        .map((file) => {
          const link =
            roomId && UUID_RE.test(roomId) && UUID_RE.test(file.id)
              ? ` /api/v1/chatrooms/${encodeURIComponent(roomId)}/files/${encodeURIComponent(file.id)}`
              : '';
          return file.localPath
            ? ` [attached: ${quoteForPane(file.localPath, 400)}]`
            : ` [attached: ${quoteForPane(file.name, 200)}${file.localImageStatus === 'unavailable' ? ' (local image unavailable; re-read to request a fresh path)' : link}]`;
        })
        .join('');
  const marks = `${m.edited && !m.deleted ? ' (edited)' : ''}${m.pinned && !m.deleted ? ' [pinned]' : ''}`;
  return m.from.kind === 'system'
    ? `${time} * ${iconOf(m.from.sessionId)}${body}${attached}`
    : `${time} ${iconOf(m.from.sessionId)}${from}${to}: ${body || (attached ? '(attachment only)' : '')}${attached}${marks}`;
}

const pollOpen = (poll: ChatPollRow, now = Date.now()): boolean =>
  !poll.closed && !(poll.closesAt !== undefined && now >= poll.closesAt);

/** `"A" 2 | "B" 1, open`: every option label is a JSON string. */
function pollTotals(poll: ChatPollRow): string {
  const count = (id: string) => Object.values(poll.votes ?? {}).filter((v) => v.includes(id)).length;
  return `${poll.options.map((o) => `${quoteForPane(o.label, 100)} ${count(o.id)}`).join(' | ')}, ${pollOpen(poll) ? 'open' : 'closed'}`;
}

/** The lines `agent chat poll-results` prints: the question, then each option with its votes and who chose it. */
export function formatPollResults(m: ChatMessageRow, members: ChatMemberRow[]): string[] {
  const poll = m.poll;
  if (!poll) return [];
  const voterName = (id: string) =>
    id === 'user' ? 'USER' : quoteForPane(members.find((x) => x.sessionId === id)?.name ?? id.slice(0, 8), 80);
  const voters = Object.keys(poll.votes ?? {});
  const lines = [
    `poll ${m.id.slice(0, 8)} ${quoteForPane(poll.question, 300)} [${pollOpen(poll) ? 'open' : 'closed'}${poll.multi ? ', several may be chosen' : ''}] ${voters.length} voter${voters.length === 1 ? '' : 's'}`,
  ];
  poll.options.forEach((o, i) => {
    const who = voters.filter((v) => poll.votes[v].includes(o.id));
    const pct = voters.length ? Math.round((who.length / voters.length) * 100) : 0;
    lines.push(
      `  ${i + 1}. ${quoteForPane(o.label, 100)}  ${who.length} vote${who.length === 1 ? '' : 's'} (${pct}%)${poll.recommended === o.id ? '  [recommended]' : ''}${who.length ? `  by ${who.map(voterName).join(', ')}` : ''}`
    );
  });
  return lines;
}

/** `agent chat poll` — ask the room a question with options. */
export async function agentChatPoll(
  deps: AgentDeps,
  options: { room?: string; to?: string; question: string; options: string[]; rec?: string; multi?: boolean; closesInMinutes?: number }
): Promise<number> {
  if (options.options.length < 2) return fail(deps, 'a poll needs at least two --option values', EXIT.refused);
  const target = await resolveChatRoom(deps, options.room);
  if ('error' in target) return fail(deps, target.error, target.code);
  const res = await deps.request(deps.ctx, {
    method: 'POST',
    path: `/api/v1/chatrooms/${encodeURIComponent(target.room.id)}/polls`,
    body: {
      question: options.question,
      options: options.options,
      ...(options.rec ? { recommended: options.rec } : {}),
      ...(options.multi ? { multi: true } : {}),
      ...(options.closesInMinutes ? { closesAt: Date.now() + options.closesInMinutes * 60_000 } : {}),
    },
  });
  if (!res.json?.success) return fail(deps, describeFailure(res));
  if (options.to && !deps.json) deps.io.err(palette.muted(TO_IGNORED_NOTE));
  const message = (res.json.data as { message?: { id: string } } | undefined)?.message;
  if (deps.json) emitJson(deps, res.json.data ?? {});
  else
    deps.io.out(
      palette.ok(`${GLYPH.ok} poll ${message?.id.slice(0, 8) ?? ''} posted to "${target.room.name}"; see votes with: reverie agent chat poll-results ${message?.id.slice(0, 8) ?? '<id>'}`)
    );
  return EXIT.ok;
}

/** The poll message a (prefix of a) message id names in a room. */
async function findPollMessage(
  deps: AgentDeps,
  roomId: string,
  prefix: string
): Promise<{ message: ChatMessageRow; members: ChatMemberRow[] } | { error: string }> {
  if (prefix.trim().length < 6) return { error: 'give at least 6 characters of the poll id (shown by agent chat read)' };
  const res = await deps.request(deps.ctx, {
    method: 'GET',
    path: `/api/v1/chatrooms/${encodeURIComponent(roomId)}/messages`,
    query: { limit: 1000 },
  });
  if (!res.json?.success) return { error: describeFailure(res) };
  const data = (res.json.data ?? {}) as { messages?: ChatMessageRow[]; members?: ChatMemberRow[]; timeZone?: string };
  const hits = (data.messages ?? []).filter((m) => m.poll && !m.deleted && m.id.startsWith(prefix.trim().toLowerCase()));
  if (hits.length === 0) return { error: `no poll with id ${quoteForPane(prefix, 40)} in this room's history (the last 1000 messages are kept)` };
  if (hits.length > 1) return { error: `${quoteForPane(prefix, 40)} matches ${hits.length} polls; give more characters` };
  return { message: hits[0], members: data.members ?? [] };
}

/** `agent chat poll-results` — who voted for what. */
export async function agentChatPollResults(deps: AgentDeps, options: { room?: string; id: string }): Promise<number> {
  const target = await resolveChatRoom(deps, options.room);
  if ('error' in target) return fail(deps, target.error, target.code);
  const found = await findPollMessage(deps, target.room.id, options.id);
  if ('error' in found) return fail(deps, found.error);
  if (deps.json) {
    emitJson(deps, { id: found.message.id, poll: found.message.poll });
    return EXIT.ok;
  }
  for (const line of formatPollResults(found.message, found.members)) deps.io.out(line);
  return EXIT.ok;
}

/** A poll reference: ROOM:ID (the room's name or id, then the first 6+ characters of the poll id) or, with --room, just ID. */
export function parsePollRef(ref: string, room?: string): { room?: string; id: string } {
  const at = ref.lastIndexOf(':');
  if (at <= 0) return { room, id: ref };
  return { room: ref.slice(0, at), id: ref.slice(at + 1) };
}

/** `agent chat poll close ROOM:ID` — close a poll early (its author, the room's coordinator, or the user). */
export async function agentChatPollClose(deps: AgentDeps, options: { room?: string; ref: string }): Promise<number> {
  const ref = parsePollRef(options.ref, options.room);
  const target = await resolveChatRoom(deps, ref.room);
  if ('error' in target) return fail(deps, target.error, target.code);
  const found = await findPollMessage(deps, target.room.id, ref.id);
  if ('error' in found) return fail(deps, found.error);
  const res = await deps.request(deps.ctx, {
    method: 'POST',
    path: `/api/v1/chatrooms/${encodeURIComponent(target.room.id)}/messages/${encodeURIComponent(found.message.id)}/poll/close`,
    body: {},
  });
  if (!res.json?.success) return fail(deps, describeFailure(res));
  if (deps.json) emitJson(deps, res.json.data ?? {});
  else deps.io.out(palette.ok(`${GLYPH.ok} closed poll ${found.message.id.slice(0, 8)} in "${target.room.name}": ${pollTotals((res.json.data as { poll: ChatPollRow }).poll)}`));
  return EXIT.ok;
}

/** `agent chat vote` — choose option(s) on a poll (none withdraws). */
export async function agentChatVote(deps: AgentDeps, options: { room?: string; id: string; options: string[] }): Promise<number> {
  const target = await resolveChatRoom(deps, options.room);
  if ('error' in target) return fail(deps, target.error, target.code);
  const found = await findPollMessage(deps, target.room.id, options.id);
  if ('error' in found) return fail(deps, found.error);
  const res = await deps.request(deps.ctx, {
    method: 'POST',
    path: `/api/v1/chatrooms/${encodeURIComponent(target.room.id)}/messages/${encodeURIComponent(found.message.id)}/poll/vote`,
    body: { options: options.options },
  });
  if (!res.json?.success) return fail(deps, describeFailure(res));
  if (deps.json) emitJson(deps, res.json.data ?? {});
  else deps.io.out(palette.ok(`${GLYPH.ok} ${options.options.length ? 'vote recorded' : 'vote withdrawn'}`));
  return EXIT.ok;
}

/** `agent chat rooms` — the rooms this session belongs to. */
/** A public channel an agent could join: name, topic and size only. */
interface PublicChannelRow {
  id: string;
  name: string;
  topic?: string;
  memberCount: number;
  joined: boolean;
}

async function listPublicChannels(deps: AgentDeps): Promise<{ rows: PublicChannelRow[] } | { error: string }> {
  const res = await deps.request(deps.ctx, { method: 'GET', path: '/api/v1/chatrooms/public' });
  if (!res.json?.success) return { error: describeFailure(res) };
  return { rows: ((res.json.data as { rooms?: PublicChannelRow[] } | undefined)?.rooms ?? []) as PublicChannelRow[] };
}

/** `agent chat rooms` — the rooms this session is in (with `--all`, also the public channels it is not in and could join). */
export async function agentChatRooms(deps: AgentDeps, options: { all?: boolean } = {}): Promise<number> {
  const res = await deps.request(deps.ctx, { method: 'GET', path: '/api/v1/chatrooms', query: { member: 'self' } });
  if (!res.json?.success) return fail(deps, describeFailure(res));
  const rooms = ((res.json.data as { rooms?: ChatRoomRow[] } | undefined)?.rooms ?? []) as ChatRoomRow[];
  let available: PublicChannelRow[] = [];
  if (options.all) {
    const listed = await listPublicChannels(deps);
    if ('error' in listed) return fail(deps, listed.error);
    available = listed.rows.filter((c) => !c.joined);
  }
  if (deps.json) {
    emitJson(deps, options.all ? { rooms, available } : rooms);
    return EXIT.ok;
  }
  if (rooms.length === 0) deps.io.out(palette.muted('(not in any chatroom)'));
  for (const r of rooms) {
    const me = r.members.find((m) => m.sessionId === deps.ctx.selfId);
    deps.io.out(`${r.id.slice(0, 8)}  ${quoteForPane(r.name, 80)}  (${r.visibility === 'public' ? 'public' : 'private'}, ${r.members.length} members${me ? `, you are ${me.role}` : ''})`);
  }
  if (options.all) {
    if (available.length === 0) deps.io.out(palette.muted('(no other public channels)'));
    for (const c of available) {
      deps.io.out(`${c.id.slice(0, 8)}  ${quoteForPane(c.name, 80)}  (public, ${c.memberCount} members${c.topic ? `, ${quoteForPane(c.topic, 80)}` : ''}) - join with: reverie agent chat join ${quoteForPane(c.name, 80)}`);
    }
  }
  return EXIT.ok;
}

/** `agent chat join <channel>` — enter a public channel (a private one needs the owner or its coordinator to add you). */
/** `agent chat visibility public|private`: the room's coordinator (or the owner) makes the channel public or private. */
export async function agentChatVisibility(deps: AgentDeps, options: { room?: string; visibility: string }): Promise<number> {
  if (options.visibility !== 'public' && options.visibility !== 'private') return fail(deps, 'say public or private', EXIT.refused);
  const target = await resolveChatRoom(deps, options.room);
  if ('error' in target) return fail(deps, target.error, target.code);
  const res = await deps.request(deps.ctx, {
    method: 'PUT',
    path: `/api/v1/chatrooms/${encodeURIComponent(target.room.id)}/visibility`,
    body: { visibility: options.visibility },
  });
  if (!res.json?.success) return fail(deps, describeFailure(res));
  if (deps.json) emitJson(deps, { room: target.room.id, visibility: options.visibility });
  else deps.io.out(palette.ok(`${GLYPH.ok} "${quoteForPane(target.room.name, 80)}" is now ${options.visibility}`));
  return EXIT.ok;
}

export async function agentChatJoin(deps: AgentDeps, options: { room: string }): Promise<number> {
  const listed = await listPublicChannels(deps);
  if ('error' in listed) return fail(deps, listed.error);
  const wanted = options.room.trim().toLowerCase();
  const matches = listed.rows.filter((c) => c.id === options.room || (options.room.length >= 8 && c.id.startsWith(options.room)) || c.name.toLowerCase() === wanted);
  if (matches.length === 0) {
    return fail(deps, `no public channel matches "${options.room}" (a private channel needs the owner or its coordinator to add you; reverie agent chat rooms --all lists the public ones)`);
  }
  if (matches.length > 1) return fail(deps, `"${options.room}" matches ${matches.length} public channels; use the id`);
  const channel = matches[0];
  if (channel.joined) {
    if (deps.json) emitJson(deps, { joined: false, room: channel.id });
    else deps.io.out(palette.ok(`${GLYPH.ok} you are already in "${channel.name}"`));
    return EXIT.ok;
  }
  const res = await deps.request(deps.ctx, { method: 'POST', path: `/api/v1/chatrooms/${encodeURIComponent(channel.id)}/join`, body: {} });
  if (!res.json?.success) return fail(deps, describeFailure(res));
  if (deps.json) emitJson(deps, res.json.data ?? {});
  else deps.io.out(palette.ok(`${GLYPH.ok} joined "${channel.name}"; post there with: reverie agent chat say --room ${quoteForPane(channel.name, 80)} "..."`));
  return EXIT.ok;
}

/** `agent chat leave [room]` — leave a channel this session is in. */
export async function agentChatLeave(deps: AgentDeps, options: { room?: string }): Promise<number> {
  const target = await resolveChatRoom(deps, options.room);
  if ('error' in target) return fail(deps, target.error, target.code);
  const res = await deps.request(deps.ctx, {
    method: 'DELETE',
    path: `/api/v1/chatrooms/${encodeURIComponent(target.room.id)}/members/${encodeURIComponent(deps.ctx.selfId ?? '')}`,
  });
  if (!res.json?.success) return fail(deps, describeFailure(res));
  if (deps.json) emitJson(deps, res.json.data ?? {});
  else deps.io.out(palette.ok(`${GLYPH.ok} left "${target.room.name}"`));
  return EXIT.ok;
}

/** Said when an old `--to` is still given: it is accepted so nothing stalls, and ignored. */
const TO_IGNORED_NOTE = '--to is ignored: everyone in a channel reads every message, so the post went to everyone; @name a member to address them';

/** Explicit stdin is UTF-8 data, never shell syntax. Positional say keeps its existing trimming. */
export async function agentChatSayInput(
  deps: AgentDeps,
  words: string[],
  options: { stdin?: boolean; room?: string; to?: string; file?: string[]; replyTo?: string; ifLatest?: boolean; ifNoNewerThan?: string },
  input: AsyncIterable<Buffer | string> = process.stdin
): Promise<number> {
  if (options.stdin && words.length)
    return fail(deps, 'refusing: use either --stdin or positional text, not both', EXIT.refused);
  let text = words.join(' ').trim();
  if (options.stdin) {
    const decoder = new StringDecoder('utf8');
    text = '';
    try {
      for await (const chunk of input) {
        text += decoder.write(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
        if (text.length > MAX_MESSAGE_CHARS)
          return fail(deps, `refusing: message exceeds ${MAX_MESSAGE_CHARS} characters`, EXIT.refused);
      }
      text += decoder.end();
    } catch {
      return fail(deps, 'refusing: could not read --stdin; no message sent', EXIT.refused);
    }
    if (text.length > MAX_MESSAGE_CHARS)
      return fail(deps, `refusing: message exceeds ${MAX_MESSAGE_CHARS} characters`, EXIT.refused);
  }
  if (!text.trim() && (options.stdin || !options.file?.length))
    return fail(deps, 'refusing: empty message', EXIT.refused);
  return agentChatSay(deps, {
    room: options.room,
    to: options.to,
    text,
    files: options.file,
    replyTo: options.replyTo,
    ifLatest: options.ifLatest,
    ifNoNewerThan: options.ifNoNewerThan,
  });
}

/** `agent chat say` — post to the room, always to everyone (`--to` is accepted and ignored: nothing an agent posts is private in a channel). */
export async function agentChatSay(
  deps: AgentDeps,
  options: {
    room?: string;
    to?: string;
    text: string;
    files?: string[];
    /** The id of the message this post answers (a spoken turn waits for exactly this link). */
    replyTo?: string;
    /** Refuse instead of posting when someone else posted after the last message this session saw here. */
    ifLatest?: boolean;
    /** Refuse instead of posting when someone else posted after this message id. */
    ifNoNewerThan?: string;
    readFile?: (path: string) => Promise<Buffer>;
  }
): Promise<number> {
  // Refused before anything is uploaded or posted, so a bad id never turns into an unlinked answer.
  if (options.replyTo !== undefined && !UUID_RE.test(options.replyTo))
    return fail(deps, `refusing: --reply-to needs a message id, got ${JSON.stringify(options.replyTo).slice(0, 80)}`, EXIT.refused);
  if (options.ifNoNewerThan !== undefined && !UUID_RE.test(options.ifNoNewerThan))
    return fail(deps, `refusing: --if-no-newer-than needs a message id, got ${JSON.stringify(options.ifNoNewerThan).slice(0, 80)}`, EXIT.refused);
  if (options.ifLatest && options.ifNoNewerThan !== undefined)
    return fail(deps, 'refusing: use --if-latest or --if-no-newer-than, not both', EXIT.refused);
  const target = await resolveChatRoom(deps, options.room);
  if ('error' in target) return fail(deps, target.error, target.code);
  // Each --file is copied into the room's attachment store first, then the message names them.
  const attachments: string[] = [];
  for (const path of options.files ?? []) {
    let data: Buffer;
    try {
      data = await (options.readFile ?? ((p: string) => import('node:fs/promises').then((fs) => fs.readFile(p))))(path);
    } catch (err) {
      return fail(deps, `cannot read ${path}: ${getErrorMessage(err)}`);
    }
    const up = await deps.request(deps.ctx, {
      method: 'POST',
      path: `/api/v1/chatrooms/${encodeURIComponent(target.room.id)}/files`,
      query: { name: path.split('/').pop() ?? 'file', type: guessContentType(path) },
      rawBody: data,
      timeoutMs: 120_000,
    });
    if (!up.json?.success) return fail(deps, `${path}: ${describeFailure(up)}`);
    attachments.push((up.json.data as { file: { id: string } }).file.id);
  }
  const res = await deps.request(deps.ctx, {
    method: 'POST',
    path: `/api/v1/chatrooms/${encodeURIComponent(target.room.id)}/messages`,
    body: {
      text: options.text,
      ...(attachments.length ? { attachments } : {}),
      ...(options.replyTo !== undefined ? { replyTo: options.replyTo } : {}),
      ...(options.ifLatest ? { ifLatest: true } : {}),
      ...(options.ifNoNewerThan !== undefined ? { ifNoNewerThan: options.ifNoNewerThan } : {}),
    },
  });
  // A guarded post that crossed newer messages was not stored: show them, so the next step is to read and decide.
  if (res.status === 409 && (res.json?.errorCode === 'CHAT_NEWER_MESSAGES' || res.json?.errorCode === 'CHAT_NO_READ_MARK')) {
    if (deps.json) {
      deps.io.out(JSON.stringify({ success: false, error: res.json.error, errorCode: res.json.errorCode, data: res.json.data ?? {} }));
      return EXIT.refused;
    }
    const data = res.json.data as { newer?: Array<{ id: string; from: string; excerpt: string }>; more?: boolean } | undefined;
    deps.io.err(`not posted: ${describeFailure(res)}`);
    if (data?.more) deps.io.err('  (older ones not shown)');
    for (const m of data?.newer ?? []) deps.io.err(`  ${m.id.slice(0, 8)} ${JSON.stringify(m.from)}: ${JSON.stringify(m.excerpt)}`);
    deps.io.err('read them with: reverie agent chat read');
    return EXIT.refused;
  }
  if (!res.json?.success) return fail(deps, describeFailure(res));
  if (deps.json) emitJson(deps, res.json.data ?? {});
  else
    deps.io.out(palette.ok(`${GLYPH.ok} posted to "${chatRoomLabel(target.room)}"`));
  if (options.to && !deps.json) deps.io.err(palette.muted(TO_IGNORED_NOTE));
  // The post went out; the server's heads-ups (a name that is not in the room, ...) are printed, never a block. --json carries them in the data.
  const warnings = (res.json.data as { warnings?: { text?: string }[] } | undefined)?.warnings;
  if (!deps.json) for (const w of warnings ?? []) if (typeof w?.text === 'string') deps.io.err(palette.muted(w.text));
  return EXIT.ok;
}

/** `agent chat emote` — post an action line ("* A member dances") in your own name. */
export async function agentChatEmote(deps: AgentDeps, options: { room?: string; action: string }): Promise<number> {
  const action = options.action.trim();
  if (!action) return fail(deps, 'refusing: empty emote', EXIT.refused);
  const target = await resolveChatRoom(deps, options.room);
  if ('error' in target) return fail(deps, target.error, target.code);
  const me = target.room.members.find((m) => m.sessionId === deps.ctx.selfId);
  if (!me) return fail(deps, 'you are not a member of this room', EXIT.refused);
  return agentChatSay(deps, { room: target.room.id, text: `* ${me.name} ${action}` });
}

/** A content type from the extension, for how the room shows an attachment (images inline). */
export function guessContentType(path: string): string {
  const ext = path.toLowerCase().split('.').pop() ?? '';
  const types: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
    txt: 'text/plain',
    md: 'text/markdown',
    json: 'application/json',
    csv: 'text/csv',
    log: 'text/plain',
  };
  return types[ext] ?? 'application/octet-stream';
}

/** Default reads request bounded local image copies; failure never advertises a server path as readable. */
async function withLocalImages(deps: AgentDeps, roomId: string, messages: ChatMessageRow[]): Promise<ChatMessageRow[]> {
  let requests = 0;
  const result: ChatMessageRow[] = [];
  for (const original of messages) {
    const message = { ...original, attachments: original.attachments?.map(file => ({ ...file })) };
    const images = message.deleted ? [] : (message.attachments ?? []).filter(isChatRaster);
    if (images.length) {
      for (const image of images) {
        image.path = '';
        delete image.localPath;
        image.localImageStatus = 'unavailable';
      }
      if (requests++ < 4) {
        try {
          const response = await deps.request(deps.ctx, { method: 'POST',
            path: `/api/v1/chatrooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(message.id)}/image-paths`, body: {} });
          const files = response.json?.success ? localImageFiles(response.json.data, images.slice(0, 4).map(file => file.id)) : [];
          for (const file of files) {
            const image = images.find(image => image.id === file.fileId)!;
            image.path = image.localPath = file.path;
            image.localImageStatus = 'ready';
          }
        } catch { /* A readable message remains usable when its local copy is unavailable. */ }
      }
    }
    result.push(message);
  }
  return result;
}

/** `agent chat read` — recent history. */
export async function agentChatRead(deps: AgentDeps, options: { room?: string; limit: number; message?: string; acknowledge?: boolean }): Promise<number> {
  if (options.acknowledge && !options.message) return fail(deps, '--acknowledge requires --message');
  const target = await resolveChatRoom(deps, options.room);
  if ('error' in target) return fail(deps, target.error, target.code);
  if (options.message) {
    const path = `/api/v1/chatrooms/${encodeURIComponent(target.room.id)}/messages/${encodeURIComponent(options.message)}`;
    const exact = await deps.request(deps.ctx, { method: 'GET', path });
    if (!exact.json?.success) return fail(deps, describeFailure(exact));
    const data = exact.json.data as { message?: ChatMessageRow; readToken?: string; timeZone?: string } | undefined;
    if (data?.message?.id !== options.message || typeof data.readToken !== 'string') return fail(deps, 'Unrecognized exact-message response; nothing acknowledged');
    data.message = (await withLocalImages(deps, target.room.id, [data.message]))[0];
    // Explicit acknowledgement follows receipt of this exact response, never a guessed timestamp or text match.
    if (!deps.json) deps.io.out(formatChatMessage(data.message, target.room.members ?? [], target.room.id, data.timeZone));
    if (options.acknowledge) {
      const ack = await deps.request(deps.ctx, { method: 'POST', path: path + '/read-ack', body: { readToken: data.readToken } });
      const confirmed = ack.json?.success && (ack.json.data as { acknowledged?: string } | undefined)?.acknowledged === options.message;
      if (!confirmed) {
        if (deps.json) { emitJson(deps, { message: data.message, acknowledgementConfirmed: false }); return EXIT.error; }
        return fail(deps, 'Acknowledgement not confirmed; inspect delivery-status before retrying');
      }
    }
    if (deps.json) emitJson(deps, { message: data.message, acknowledgementConfirmed: !!options.acknowledge });
    return EXIT.ok;
  }
  const res = await deps.request(deps.ctx, {
    method: 'GET',
    path: `/api/v1/chatrooms/${encodeURIComponent(target.room.id)}/messages`,
    query: { limit: options.limit },
  });
  if (!res.json?.success) return fail(deps, describeFailure(res));
  const data = (res.json.data ?? {}) as { messages?: ChatMessageRow[]; members?: ChatMemberRow[]; timeZone?: string };
  data.messages = await withLocalImages(deps, target.room.id, data.messages ?? []);
  if (deps.json) {
    emitJson(deps, data);
    return EXIT.ok;
  }
  const messages = data.messages;
  if (messages.length === 0) deps.io.out(palette.muted('(no messages yet)'));
  for (const m of messages) deps.io.out(formatChatMessage(m, data.members ?? [], target.room.id, data.timeZone));
  return EXIT.ok;
}

/** One bounded read-only owner-attention history page; never advances seen or ACKs. */
export async function agentChatPending(deps: AgentDeps, options: { room?: string; beforeAt?: string; beforeId?: string }): Promise<number> {
  if ((options.beforeAt === undefined) !== (options.beforeId === undefined) ||
      (options.beforeAt !== undefined && (!/^\d{1,16}$/.test(options.beforeAt) || !Number.isSafeInteger(Number(options.beforeAt)))) ||
      (options.beforeId !== undefined && (!options.beforeId || options.beforeId.length > 200)))
    return fail(deps, 'Use paired --before-at epoch-ms and --before-id exact message ID');
  const target = await resolveChatRoom(deps, options.room);
  if ('error' in target) return fail(deps, target.error, target.code);
  const result = await deps.request(deps.ctx, { method: 'GET', path: '/api/v1/chatrooms/notices/history',
    query: { roomId: target.room.id, ...(options.beforeAt !== undefined ? { beforeAt: options.beforeAt, beforeId: options.beforeId! } : {}) } });
  const data = result.json?.data as { text?: string; historyCoverage?: unknown; sourceReferences?: Array<{ roomId?: string; messageId?: string }> } | undefined;
  if (!result.json?.success || typeof data?.text !== 'string' || !data.historyCoverage ||
      !Array.isArray(data.sourceReferences) || data.sourceReferences.length > 1000 ||
      data.sourceReferences.some(ref => ref.roomId !== target.room.id || typeof ref.messageId !== 'string'))
    return fail(deps, 'Owner-attention history not confirmed; no read or handling was acknowledged');
  if (deps.json) emitJson(deps, data);
  else deps.io.out(JSON.stringify(data));
  return EXIT.ok;
}

/** Explicit own attention resolution; exact reads support intent but never ACK delivery here. */
/**
 * Explicit bulk resolution of your own notices from agents and bots in one room posted before a time (epoch ms, or ISO 8601
 * with Z or an offset). Owner and other human messages are never included. Each is resolved like `handle <id>`: an exact
 * read, then the same checked resolution; delivery and task state are unchanged.
 */
export async function agentChatHandleBefore(deps: AgentDeps, options: { room?: string; before: string }): Promise<number> {
  const raw = options.before.trim();
  const before = /^\d{1,16}$/.test(raw) ? Number(raw)
    : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(raw) ? Date.parse(raw) : NaN;
  if (!Number.isSafeInteger(before) || before > (deps.now ?? Date.now)())
    return fail(deps, 'Use --before with a past time: epoch milliseconds, or ISO 8601 with Z or an offset');
  if (!options.room) return fail(deps, '--before needs an explicit --room');
  const target = await resolveChatRoom(deps, options.room);
  if ('error' in target) return fail(deps, target.error, target.code);
  const listing = await deps.request(deps.ctx, { method: 'GET', path: '/api/v1/chatrooms/notices/pending-before',
    query: { roomId: target.room.id, before: String(before) } });
  const refs = (listing.json?.data as { sourceReferences?: Array<{ roomId?: string; messageId?: string }> } | undefined)?.sourceReferences;
  if (!listing.json?.success || !Array.isArray(refs) || refs.length > 1000 ||
      refs.some(ref => ref.roomId !== target.room.id || typeof ref.messageId !== 'string'))
    return fail(deps, 'Pending notice list not confirmed; nothing was handled');
  const quiet: AgentDeps = { ...deps, json: true, io: { ...deps.io, out: () => {}, err: () => {} } };
  const handled: string[] = [], failed: string[] = [];
  for (const ref of refs) {
    const code = await agentChatHandle(quiet, { room: target.room.id, message: ref.messageId! });
    (code === EXIT.ok ? handled : failed).push(ref.messageId!);
  }
  if (deps.json) emitJson(deps, { roomId: target.room.id, before, handled, failed });
  else deps.io.out(`Handled ${handled.length} of ${refs.length} pending agent/bot notices before ${new Date(before).toISOString()}` +
    (failed.length ? `; ${failed.length} not confirmed: ${failed.join(', ')}` : '') + '. Owner messages are never bulk-handled.');
  return failed.length ? EXIT.error : EXIT.ok;
}

export async function agentChatHandle(deps: AgentDeps, options: { room?: string; message: string; supersededBy?: string }): Promise<number> {
  const target = await resolveChatRoom(deps, options.room);
  if ('error' in target) return fail(deps, target.error, target.code);
  if (!options.message || options.message.length > 200 ||
      (options.supersededBy !== undefined && (!options.supersededBy || options.supersededBy.length > 200 || options.supersededBy === options.message)))
    return fail(deps, 'Use an exact message identity and a distinct optional replacement');
  const exact = async (messageId: string) => {
    const response = await deps.request(deps.ctx, { method: 'GET',
      path: `/api/v1/chatrooms/${encodeURIComponent(target.room.id)}/messages/${encodeURIComponent(messageId)}` });
    const data = response.json?.data as { message?: ChatMessageRow; readToken?: string; timeZone?: string } | undefined;
    return response.json?.success && data?.message?.id === messageId && typeof data.readToken === 'string'
      ? { roomId: target.room.id, messageId, readToken: data.readToken } : undefined;
  };
  const source = await exact(options.message);
  if (!source) return fail(deps, 'Exact source read failed; attention unchanged');
  const replacement = options.supersededBy ? await exact(options.supersededBy) : undefined;
  if (options.supersededBy && !replacement) return fail(deps, 'Exact replacement read failed; attention unchanged');
  const disposition = replacement ? 'superseded' : 'handled';
  const result = await deps.request(deps.ctx, { method: 'POST', path: '/api/v1/chatrooms/notices/resolve',
    body: { ...source, disposition, ...(replacement ? { replacement } : {}) } });
  const data = result.json?.data as { source?: { roomId?: string; messageId?: string }; attention?: { disposition?: string; replacement?: { messageId?: string } } } | undefined;
  if (!result.json?.success || data?.source?.roomId !== target.room.id || data.source.messageId !== options.message ||
      data.attention?.disposition !== disposition || (replacement && data.attention.replacement?.messageId !== replacement.messageId))
    return fail(deps, 'Attention resolution not confirmed; inspect current summary before retrying');
  if (deps.json) emitJson(deps, data);
  else deps.io.out(`Notice ${options.message} ${disposition}. Delivery and task state unchanged.`);
  return EXIT.ok;
}

/** Fetch one room-scoped attachment through the ordinary authenticated session transport. */
export async function agentChatFetch(
  deps: AgentDeps,
  options: { room: string; fileId: string; output: string; maxBytes?: number; timeoutMs?: number }
): Promise<number> {
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!options.room.trim()) return fail(deps, 'an explicit room name or ID is required', EXIT.refused);
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 64 * 1024 * 1024 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 120_000
  )
    return fail(deps, '--max-bytes must be 1..67108864 and --timeout 1..120000 ms (finite integers)', EXIT.refused);
  const refusal = chatAttachmentDestinationRefusal(options.output);
  if (refusal || !UUID_RE.test(options.fileId))
    return fail(deps, refusal ?? 'file id must be a full UUID', EXIT.refused);
  try {
    const target = await resolveChatRoom(
      {
        ...deps,
        request: (ctx, request) =>
          deps.request(ctx, {
            ...request,
            bounds: { maxBytes: 1024 * 1024, deadlineMs: 5_000 },
          }),
      },
      options.room
    );
    if ('error' in target) return fail(deps, target.error, target.code);
    if (!UUID_RE.test(target.room.id)) return fail(deps, 'invalid room identity', EXIT.refused);
    const res = await deps.request(deps.ctx, {
      method: 'GET',
      path: `/api/v1/chatrooms/${encodeURIComponent(target.room.id)}/files/${encodeURIComponent(options.fileId)}`,
      binary: { maxBytes, deadlineMs: timeoutMs },
      timeoutMs,
      headers: { Accept: 'application/octet-stream', 'Accept-Encoding': 'identity' },
    });
    // No redirect following, server-name output, decoded-body fallback or error-body echo.
    if (res.status !== 200) return fail(deps, `attachment fetch refused (HTTP ${res.status}); no file saved`);
    if (!Buffer.isBuffer(res.bytes) || res.bytes.length > maxBytes)
      return fail(deps, 'invalid or oversized attachment response; no file saved');
    await saveChatAttachment(options.output, res.bytes);
    if (deps.json)
      emitJson(deps, {
        roomId: target.room.id,
        fileId: options.fileId,
        output: options.output,
        bytes: res.bytes.length,
      });
    else deps.io.out(`saved ${res.bytes.length} bytes to ${quoteForPane(options.output, 200)}`);
    return EXIT.ok;
  } catch {
    // Errors may contain private transport URLs, credentials or local paths.
    return fail(
      deps,
      'attachment fetch/save failed; no success confirmed (an exclusively-created partial output may remain)'
    );
  }
}

/**
 * `agent chat replace <new-session-id> [old-session-id]`: after a plan switch, move the old session's place in every room to its successor
 * (the old defaults to this session: an agent hands over its own place before it exits). The server allows it for the owner, or when the
 * caller is the old session and the successor resumes its conversation and was made by it or by the owner.
 */
export async function agentChatReplace(deps: AgentDeps, options: { to: string; from?: string }): Promise<number> {
  const from = options.from || deps.ctx.selfId;
  if (!from) return fail(deps, 'give the old session id (or run this from the old session)', EXIT.refused);
  const res = await deps.request(deps.ctx, { method: 'POST', path: '/api/v1/chatrooms/members/replace', body: { from, to: options.to } });
  if (!res.json?.success) return fail(deps, describeFailure(res));
  const rooms = ((res.json.data ?? {}) as { rooms?: Array<{ id: string; name: string }> }).rooms ?? [];
  if (deps.json) emitJson(deps, { rooms });
  else if (!rooms.length) deps.io.out(palette.muted('the old session was not in any room'));
  else deps.io.out(palette.ok(`${GLYPH.ok} moved to ${rooms.length} room${rooms.length === 1 ? '' : 's'}: ${rooms.map((r) => quoteForPane(r.name, 60)).join(', ')}`));
  return EXIT.ok;
}

/** `agent chat notify all|mentions`: this agent chooses, for one room, to be woken by everything the room says (`all`) or only by what is meant for it (`mentions`). */
export async function agentChatNotify(deps: AgentDeps, options: { room?: string; mode: string }): Promise<number> {
  if (options.mode !== 'all' && options.mode !== 'mentions') return fail(deps, 'say all or mentions', EXIT.refused);
  if (!deps.ctx.selfId) return fail(deps, 'only an agent session sets its own notifications', EXIT.refused);
  const target = await resolveChatRoom(deps, options.room);
  if ('error' in target) return fail(deps, target.error, target.code);
  const res = await deps.request(deps.ctx, {
    method: 'PUT',
    path: `/api/v1/chatrooms/${encodeURIComponent(target.room.id)}/members/${encodeURIComponent(deps.ctx.selfId)}/notify`,
    body: { mode: options.mode },
  });
  if (!res.json?.success) return fail(deps, describeFailure(res));
  if (deps.json) emitJson(deps, { room: target.room.id, notify: options.mode });
  else {
    deps.io.out(
      palette.ok(
        `${GLYPH.ok} in "${quoteForPane(target.room.name, 80)}" you are now woken ${options.mode === 'mentions' ? 'only by a direct @mention, a reply to you, a message to you, or the owner (everything else still arrives with your next prompt)' : 'as the room says'}`
      )
    );
  }
  return EXIT.ok;
}

/** `agent chat pins`: the room's pinned messages, newest pin first, with the ids `pin` and `unpin` take. */
export async function agentChatPins(deps: AgentDeps, options: { room?: string }): Promise<number> {
  const target = await resolveChatRoom(deps, options.room);
  if ('error' in target) return fail(deps, target.error, target.code);
  const res = await deps.request(deps.ctx, {
    method: 'GET',
    path: `/api/v1/chatrooms/${encodeURIComponent(target.room.id)}/pins`,
  });
  if (!res.json?.success) return fail(deps, describeFailure(res));
  const data = (res.json.data ?? {}) as { pins?: ChatMessageRow[] };
  if (deps.json) {
    emitJson(deps, data);
    return EXIT.ok;
  }
  const pins = data.pins ?? [];
  if (pins.length === 0) deps.io.out(palette.muted('(nothing pinned)'));
  for (const m of pins) deps.io.out(`${m.id.slice(0, 8)}  pinned by ${quoteForPane(m.pinned?.by ?? '?', 40)}: ${quoteForPane(m.text)}`);
  return EXIT.ok;
}

/** `agent chat pin|unpin <id>`: the coordinator (or the user) pins or unpins a message; the id may be a prefix from `pins` or `read --json`. */
export async function agentChatPin(deps: AgentDeps, options: { room?: string; id: string; on: boolean }): Promise<number> {
  const target = await resolveChatRoom(deps, options.room);
  if ('error' in target) return fail(deps, target.error, target.code);
  const list = await deps.request(deps.ctx, {
    method: 'GET',
    path: `/api/v1/chatrooms/${encodeURIComponent(target.room.id)}/messages`,
    query: { limit: 200 },
  });
  if (!list.json?.success) return fail(deps, describeFailure(list));
  const rows = ((list.json.data ?? {}) as { messages?: ChatMessageRow[] }).messages ?? [];
  const matches = rows.filter((m) => m.id === options.id || (options.id.length >= 6 && m.id.startsWith(options.id)));
  if (matches.length !== 1) {
    return fail(deps, matches.length ? 'That id matches several messages: give more of it' : 'No such message in the last 200', EXIT.refused);
  }
  const res = await deps.request(deps.ctx, {
    method: options.on ? 'POST' : 'DELETE',
    path: `/api/v1/chatrooms/${encodeURIComponent(target.room.id)}/messages/${encodeURIComponent(matches[0].id)}/pin`,
  });
  if (!res.json?.success) return fail(deps, describeFailure(res));
  if (deps.json) emitJson(deps, res.json.data);
  else deps.io.out(options.on ? 'pinned' : 'unpinned');
  return EXIT.ok;
}

/** `agent chat who` — members with role, live state, goal and progress. */
export async function agentChatWho(deps: AgentDeps, options: { room?: string; names?: boolean }): Promise<number> {
  const target = await resolveChatRoom(deps, options.room);
  if ('error' in target) return fail(deps, target.error, target.code);
  if (options.names) {
    // Just who is in the room, to check a name before @-mentioning it (--json: a list of names).
    const names = target.room.members.map((m) => m.name);
    if (deps.json) emitJson(deps, { names });
    else for (const name of names) deps.io.out(quoteForPane(name, 80));
    return EXIT.ok;
  }
  if (deps.json) {
    emitJson(deps, target.room);
    return EXIT.ok;
  }
  deps.io.out(palette.emph(`${quoteForPane(target.room.name, 80)} (${target.room.id.slice(0, 8)})`));
  for (const m of target.room.members) {
    const state = m.alive === false ? 'gone' : m.working ? 'working' : 'idle';
    const me = m.sessionId === deps.ctx.selfId ? ' (you)' : '';
    deps.io.out(`${m.sessionId.slice(0, 8)}  ${m.icon ? `${quoteForPane(m.icon, 8)} ` : ''}${quoteForPane(m.name, 80)}${me}  [${m.role}, ${state}]`);
    // Owner-set pronouns (your own too, so you know how you are referred to): use them when you write about a member.
    if (m.pronouns) deps.io.out(`    pronouns: ${quoteForPane(m.pronouns, 40)}`);
    if (m.away) deps.io.out(`    away: ${quoteForPane(m.away, 500)}`);
    // A goal the member set itself wins; without one, its first 'doing' Board card stands in, marked as such.
    const first = m.focus?.[0];
    const goal = m.goal ? quoteForPane(m.goal, 500) : first ? `${quoteForPane(`${first.id} ${first.title}`, 160)} (from the Board)` : '-';
    deps.io.out(`    goal: ${goal}`);
    if (m.focus?.length) {
      const cards = m.focus.map((c) => quoteForPane(`${c.id} ${c.title}`, 160)).join('; ');
      deps.io.out(`    doing: ${cards}${m.focusMore ? ` (+${m.focusMore} more)` : ''}`);
    }
    deps.io.out(`    progress: ${m.progress ? quoteForPane(m.progress, 500) : '-'}`);
  }
  return EXIT.ok;
}

/** `agent chat status` — set this session's goal and/or progress synopsis. */
export async function agentChatStatus(
  deps: AgentDeps,
  options: { room?: string; goal?: string; progress?: string; away?: string; icon?: string }
): Promise<number> {
  if (options.goal === undefined && options.progress === undefined && options.away === undefined && options.icon === undefined) {
    return fail(deps, 'give --goal, --progress, --away, --icon, or any of them', EXIT.refused);
  }
  const target = await resolveChatRoom(deps, options.room);
  if ('error' in target) return fail(deps, target.error, target.code);
  const res = await deps.request(deps.ctx, {
    method: 'POST',
    path: `/api/v1/chatrooms/${encodeURIComponent(target.room.id)}/members/${encodeURIComponent(deps.ctx.selfId)}/status`,
    body: {
      ...(options.goal !== undefined ? { goal: options.goal } : {}),
      ...(options.progress !== undefined ? { progress: options.progress } : {}),
      ...(options.away !== undefined ? { away: options.away } : {}),
      ...(options.icon !== undefined ? { icon: options.icon } : {}),
    },
  });
  if (!res.json?.success) return fail(deps, describeFailure(res));
  if (deps.json) emitJson(deps, res.json.data ?? {});
  else deps.io.out(palette.ok(`${GLYPH.ok} synopsis updated in "${target.room.name}"`));
  return EXIT.ok;
}

/**
 * `agent profile` — change this session's own display name and/or icon (nothing else, no one else). `--pronouns` changes
 * nothing: pronouns are set by the owner, so it posts a proposal in the room that the owner's member card offers to set.
 */
export async function agentProfile(
  deps: AgentDeps,
  options: {
    name?: string;
    icon?: string;
    image?: string;
    clearImage?: boolean;
    pronouns?: string;
    room?: string;
    readFile?: (path: string) => Promise<Buffer>;
  }
): Promise<number> {
  const textual = options.name !== undefined || options.icon !== undefined;
  if (!textual && options.image === undefined && !options.clearImage && options.pronouns === undefined) {
    return fail(deps, 'give --name, --icon, --image, --clear-image, --pronouns, or several', EXIT.refused);
  }
  if (options.image !== undefined && options.clearImage) {
    return fail(deps, 'give --image or --clear-image, not both', EXIT.refused);
  }
  const pronouns = options.pronouns?.trim();
  if (pronouns !== undefined && (textual || options.image !== undefined || options.clearImage)) {
    return fail(deps, '--pronouns only posts a proposal; give it on its own', EXIT.refused);
  }
  const problem = pronouns === undefined ? undefined : pronounsProblem(pronouns);
  if (problem) return fail(deps, `refusing: ${problem}`, EXIT.refused);
  if (!deps.ctx.selfId)
    return fail(deps, 'run this inside a Reverie agent session (REVERIE_SESSION_ID is not set)', EXIT.refused);
  if (pronouns !== undefined) return proposePronouns(deps, pronouns, options.room);
  let image: Buffer | undefined;
  if (options.image !== undefined) {
    try {
      image = await (options.readFile ?? ((p: string) => import('node:fs/promises').then((fs) => fs.readFile(p))))(
        options.image
      );
    } catch (error) {
      return fail(deps, `cannot read ${options.image}: ${(error as Error).message}`, EXIT.refused);
    }
  }
  const profile: { name?: string; icon?: string; avatar?: string | null; rooms?: number } = {};
  if (textual) {
    const res = await deps.request(deps.ctx, {
      method: 'POST',
      path: '/api/v1/company/self',
      body: {
        ...(options.name !== undefined ? { name: options.name } : {}),
        ...(options.icon !== undefined ? { icon: options.icon } : {}),
      },
    });
    if (!res.json?.success) return fail(deps, describeFailure(res));
    Object.assign(profile, ((res.json.data ?? {}) as { profile?: typeof profile }).profile ?? {});
  }
  if (image !== undefined || options.clearImage) {
    const res = await deps.request(deps.ctx, {
      method: image !== undefined ? 'POST' : 'DELETE',
      path: '/api/v1/company/self/avatar',
      ...(image !== undefined ? { rawBody: image } : {}),
    });
    if (!res.json?.success) return fail(deps, describeFailure(res));
    const result = ((res.json.data ?? {}) as { profile?: { avatar?: string | null; rooms?: number } }).profile ?? {};
    profile.avatar = result.avatar ?? null;
    profile.rooms = Math.max(profile.rooms ?? 0, result.rooms ?? 0);
  }
  if (deps.json) emitJson(deps, profile);
  else {
    const rooms = profile.rooms ? ` (updated in ${profile.rooms} room${profile.rooms === 1 ? '' : 's'})` : '';
    const parts = [[profile.icon, profile.name].filter(Boolean).join(' ')];
    if (profile.avatar) parts.push('new profile image');
    else if (options.clearImage) parts.push('profile image removed');
    deps.io.out(palette.ok(`${GLYPH.ok} profile updated: ${parts.filter(Boolean).join(', ')}${rooms}`));
  }
  return EXIT.ok;
}

/**
 * Post `<name> proposes pronouns: <text> (@<owner> can set them on my member card)` in the room (the one room this session is
 * in, the one it was last addressed in, or --room), through `agent chat say`. Nothing is written to the employee record.
 */
async function proposePronouns(deps: AgentDeps, pronouns: string, room: string | undefined): Promise<number> {
  const target = await resolveChatRoom(deps, room);
  if ('error' in target) return fail(deps, target.error, target.code);
  const me = target.room.members.find((m) => m.sessionId === deps.ctx.selfId);
  if (!me) return fail(deps, 'you are not a member of this room', EXIT.refused);
  const owner = target.ownerNames?.[0] ? `@${target.ownerNames[0].trim()}` : '@owner';
  return agentChatSay(deps, { room: target.room.id, text: pronounsProposal(me.name, pronouns, owner) });
}

/** `agent chat new` — a coordinator creates a room it will coordinate. */
export async function agentChatNew(deps: AgentDeps, options: { name: string; members: string[] }): Promise<number> {
  const members: Array<{ sessionId: string }> = [];
  for (const id of options.members) {
    const session = await resolveSessionId(deps, id);
    if ('error' in session) return fail(deps, session.error, session.code);
    members.push({ sessionId: session.id });
  }
  const res = await deps.request(deps.ctx, {
    method: 'POST',
    path: '/api/v1/chatrooms',
    body: { name: options.name, ...(members.length ? { members } : {}) },
  });
  if (!res.json?.success) return fail(deps, describeFailure(res));
  const room = res.json.data as { id?: string; name?: string; coordinatorId?: string } | undefined;
  if (deps.json) emitJson(deps, res.json.data ?? {});
  // The server answers 200 when it took the call for the user's (a header it could not resolve):
  // the room exists but nobody coordinates it, so never claim otherwise.
  if (!room?.coordinatorId || !isSelfSession(deps.ctx.selfId, room.coordinatorId)) {
    return fail(
      deps,
      `room "${room?.name ?? options.name}" (${room?.id ?? '?'}) was created but you are not its coordinator; ` +
        'check REVERIE_SESSION_ID (the server did not recognise this session)'
    );
  }
  if (!deps.json) {
    const label = `"${room.name ?? options.name}" (${room.id ?? '?'})`;
    deps.io.out(palette.ok(`${GLYPH.ok} created ${label}; you coordinate it`));
  }
  return EXIT.ok;
}

/** `agent chat add` — the coordinator brings another session into the room. */
export async function agentChatAdd(
  deps: AgentDeps,
  options: { room?: string; id: string; goal?: string; voice?: boolean }
): Promise<number> {
  const target = await resolveChatRoom(deps, options.room);
  if ('error' in target) return fail(deps, target.error, target.code);
  const session = await resolveSessionId(deps, options.id);
  if ('error' in session) return fail(deps, session.error, session.code);
  const res = await deps.request(deps.ctx, {
    method: 'POST',
    path: `/api/v1/chatrooms/${encodeURIComponent(target.room.id)}/members`,
    body: {
      sessionId: session.id,
      ...(options.goal !== undefined ? { goal: options.goal } : {}),
      ...(options.voice ? { voice: true } : {}),
    },
  });
  if (!res.json?.success) return fail(deps, describeFailure(res));
  if (deps.json) emitJson(deps, res.json.data ?? {});
  else deps.io.out(palette.ok(`${GLYPH.ok} added ${session.id.slice(0, 8)} to "${target.room.name}"`));
  return EXIT.ok;
}

/** `agent chat voice` — the coordinator marks (or unmarks) the member that answers spoken turns. */
export async function agentChatVoice(
  deps: AgentDeps,
  options: { room?: string; id: string; on: boolean }
): Promise<number> {
  const target = await resolveChatRoom(deps, options.room);
  if ('error' in target) return fail(deps, target.error, target.code);
  const session = await resolveSessionId(deps, options.id);
  if ('error' in session) return fail(deps, session.error, session.code);
  const res = await deps.request(deps.ctx, {
    method: 'POST',
    path: `/api/v1/chatrooms/${encodeURIComponent(target.room.id)}/members/${encodeURIComponent(session.id)}/status`,
    body: { voice: options.on },
  });
  if (!res.json?.success) return fail(deps, describeFailure(res));
  if (deps.json) emitJson(deps, res.json.data ?? {});
  else
    deps.io.out(
      palette.ok(
        `${GLYPH.ok} ${session.id.slice(0, 8)} ${options.on ? 'is now the voice of' : 'no longer answers voice in'} "${target.room.name}"`
      )
    );
  return EXIT.ok;
}

// ─────────────────────────────────────────────────────────────────────────────
// Plans (read-only)
// ─────────────────────────────────────────────────────────────────────────────

interface PlanRowView {
  id: string;
  label: string;
  provider: string;
  signedIn: boolean;
  status: string;
  pace: {
    fiveHour: number | null;
    weekly: number | null;
    weekReset: number | null;
    pace: number | null;
    burnPerHour?: number | null;
    burnBasis?: 'recent' | 'average' | null;
    remainingPct?: number | null;
    sustainablePctPerHour?: number | null;
    projected: number | null;
    runsOutAt: number | null;
    recommendation: string;
  };
  bankedResets: { availableCount: number; earliestExpiresAt: number | null } | null;
  sessions: Array<{ id: string; name: string }>;
}

const PLAN_ZONE = 'America/New_York';

/** Legacy export name; human plan clocks use the configured company zone. */
export function planEt(ms: number | null | undefined, timeZone = 'UTC'): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '-';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: displayTimeZone(timeZone),
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((x) => x.type === t)?.value ?? '';
  return `${get('weekday')} ${get('day')} ${get('month')} ${get('hour')}:${get('minute')} ${get('timeZoneName')}`;
}

const planPct = (n: number | null): string => (n === null || !Number.isFinite(n) ? '-' : `${Math.round(n)}%`);

function planState(a: PlanRowView, timeZone?: string): string {
  if (!a.signedIn) return 'signed out';
  // A run-out time is only as good as the rate behind it: with no recent rate it says so instead of guessing.
  if (a.pace.runsOutAt) return `runs out ${planEt(a.pace.runsOutAt, timeZone)}${a.pace.burnBasis === 'average' ? ' (at the weekly average)' : ''}`;
  return a.pace.burnBasis ? 'on pace' : 'pace: not enough data';
}

/** "burn 0.8%/h, 39% left = 0.4%/h to the reset", or why there is no burn. */
function planBurnLine(a: PlanRowView): string {
  const p = a.pace;
  const burn =
    p.burnPerHour === null || p.burnPerHour === undefined
      ? 'burn: not enough data (needs 1 h of readings)'
      : `burn ${p.burnPerHour}%/h`;
  const left =
    p.remainingPct === null || p.remainingPct === undefined || p.sustainablePctPerHour === null || p.sustainablePctPerHour === undefined
      ? ''
      : `, ${p.remainingPct}% left = ${p.sustainablePctPerHour}%/h to the reset`;
  return `  ${burn}${left}`;
}

function planLines(a: PlanRowView, timeZone?: string): string[] {
  const lines = [
    `${quoteForPane(a.label, 80)}  (${a.provider})  ${planState(a, timeZone)}`,
    `  week ${planPct(a.pace.weekly)}  5-hour ${planPct(a.pace.fiveHour)}  resets ${planEt(a.pace.weekReset, timeZone)}`,
    ...(a.signedIn ? [planBurnLine(a)] : []),
  ];
  if (a.provider === 'openai') {
    const b = a.bankedResets;
    lines.push(`  banked resets: ${b ? b.availableCount + (b.earliestExpiresAt ? ` (earliest ${planEt(b.earliestExpiresAt, timeZone)})` : '') : 'unknown'}`);
  }
  lines.push(`  agents on it: ${a.sessions.length ? a.sessions.map((s) => quoteForPane(s.name, 40)).join(', ') : '(none)'}`);
  return lines;
}

async function loadPlans(deps: AgentDeps): Promise<{ rows: PlanRowView[]; timeZone: string } | { error: string }> {
  const res = await deps.request(deps.ctx, { method: 'GET', path: '/api/v1/plans' });
  if (!res.json?.success) return { error: describeFailure(res) };
  const data = res.json.data as { accounts?: PlanRowView[]; timeZone?: string } | undefined;
  return { rows: data?.accounts ?? [], timeZone: displayTimeZone(data?.timeZone) };
}

/** `plans`: every account this session may see (a coordinator sees all, any other agent its own account). Read-only. */
export async function agentPlans(deps: AgentDeps): Promise<number> {
  const loaded = await loadPlans(deps);
  if ('error' in loaded) return fail(deps, loaded.error);
  if (deps.json) {
    emitJson(deps, loaded.rows);
    return EXIT.ok;
  }
  if (loaded.rows.length === 0) deps.io.out(palette.muted('(no account visible to this session)'));
  for (const a of loaded.rows) for (const line of planLines(a, loaded.timeZone)) deps.io.out(line);
  return EXIT.ok;
}

/** `plans show NAME`: one account by label, id or profile id. */
export async function agentPlansShow(deps: AgentDeps, options: { name: string }): Promise<number> {
  const loaded = await loadPlans(deps);
  if ('error' in loaded) return fail(deps, loaded.error);
  const want = options.name.trim().toLowerCase();
  const hit = loaded.rows.find((a) => a.id.toLowerCase() === want || a.label.toLowerCase() === want);
  if (!hit) return fail(deps, `no account "${quoteForPane(options.name, 80)}" visible to this session`, EXIT.error);
  if (deps.json) {
    emitJson(deps, hit);
    return EXIT.ok;
  }
  for (const line of planLines(hit, loaded.timeZone)) deps.io.out(line);
  return EXIT.ok;
}

// ─────────────────────────────────────────────────────────────────────────────
// Commander wiring
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_WAIT_MS = 60_000;

/** Build deps from the live environment; the guard's message is the only thing a non-session caller sees. */
function liveDeps(json: boolean): AgentDeps | undefined {
  try {
    return {
      ctx: resolveAgentContext(),
      request: httpRequest,
      json,
      io: { out: (line) => console.log(line), err: (line) => console.error(line) },
    };
  } catch (err) {
    if (err instanceof AgentGuardError) {
      console.error(palette.err(`${GLYPH.fail} ${err.message}`));
      return undefined;
    }
    throw err;
  }
}

/** Run a verb with the live transport and turn its exit code into the process exit. */
export async function runAgentVerb(json: boolean, verb: (deps: AgentDeps) => Promise<number>): Promise<void> {
  const deps = liveDeps(json);
  if (!deps) {
    process.exitCode = EXIT.refused;
    return;
  }
  try {
    process.exitCode = await verb(deps);
  } catch (err) {
    console.error(palette.err(`${GLYPH.fail} ${getErrorMessage(err)}`));
    process.exitCode = EXIT.error;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Routines (`routine …`): a message that posts itself on a schedule, as the agent that made it
// ─────────────────────────────────────────────────────────────────────────────

/** The shortest repeat the server accepts from an agent; checked here too so the error comes before a request. */
export const ROUTINE_MIN_EVERY_MINUTES = 5;

interface RoutineRow {
  id: string;
  name: string;
  roomId?: string;
  postText?: string;
  scheduleType: string;
  intervalMinutes?: number;
  dailyTime?: string;
  weeklyDays?: number[];
  weeklyTime?: string;
  timeZone?: string;
  enabled: boolean;
  nextRunAt?: number | null;
  lastStatus?: string | null;
  lastRunAt?: number | null;
  createdBy?: { employeeId: string };
}

export type RoutineSchedule =
  | { scheduleType: 'interval'; intervalMinutes: number }
  | { scheduleType: 'daily'; dailyTime: string }
  | { scheduleType: 'weekly'; weeklyDays: number[]; weeklyTime: string };

const hhmm = (h: number, m: number): string => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

function parseClock(raw: string): string | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? hhmm(h, min) : undefined;
}

/**
 * Turn the schedule flags into the server's schedule fields, or say why not. Exactly one of --every, --daily, --weekdays, --cron.
 * The engine has interval, daily and weekly schedules, not a cron string, so --cron is accepted only where it means one of those
 * ("M H * * *" daily; "M H * * 1-5" or a day list weekly) and refused, with the reason, for anything else.
 */
export function parseRoutineSchedule(o: { every?: string; daily?: string; weekdays?: string; cron?: string }): RoutineSchedule | { error: string } {
  const given = [o.every, o.daily, o.weekdays, o.cron].filter((v) => v !== undefined);
  if (given.length !== 1) return { error: 'give exactly one of --every, --daily, --weekdays or --cron' };
  if (o.every !== undefined) {
    const m = /^(\d+)\s*([mhd])$/.exec(o.every.trim().toLowerCase());
    if (!m) return { error: '--every takes a number and m, h or d, for example 30m, 2h or 1d' };
    const minutes = Number(m[1]) * { m: 1, h: 60, d: 1440 }[m[2] as 'm' | 'h' | 'd'];
    if (minutes < ROUTINE_MIN_EVERY_MINUTES) return { error: `a routine repeats at most every ${ROUTINE_MIN_EVERY_MINUTES} minutes` };
    if (minutes > 525600) return { error: '--every is at most 365 days' };
    return { scheduleType: 'interval', intervalMinutes: minutes };
  }
  if (o.daily !== undefined) {
    const t = parseClock(o.daily);
    return t ? { scheduleType: 'daily', dailyTime: t } : { error: '--daily takes a 24-hour time such as 09:00' };
  }
  if (o.weekdays !== undefined) {
    const t = parseClock(o.weekdays);
    return t ? { scheduleType: 'weekly', weeklyDays: [1, 2, 3, 4, 5], weeklyTime: t } : { error: '--weekdays takes a 24-hour time such as 09:00' };
  }
  const refusal = (why: string): { error: string } => ({
    error: `--cron "${o.cron}" cannot be scheduled: ${why}. Routines run every N minutes/hours/days, daily, or weekly (use --every, --daily or --weekdays, or "M H * * *" / "M H * * 1-5")`,
  });
  const f = (o.cron ?? '').trim().split(/\s+/);
  if (f.length !== 5) return refusal('a cron line has five fields');
  const [min, hour, dom, mon, dow] = f as [string, string, string, string, string];
  if (!/^\d{1,2}$/.test(min) || !/^\d{1,2}$/.test(hour)) return refusal('minute and hour must be single numbers');
  const t = parseClock(`${hour}:${min.padStart(2, '0')}`);
  if (!t) return refusal('the time is out of range');
  if (dom !== '*' || mon !== '*') return refusal('day-of-month and month must be *');
  if (dow === '*') return { scheduleType: 'daily', dailyTime: t };
  const days = new Set<number>();
  for (const part of dow.split(',')) {
    const r = /^([0-7])(?:-([0-7]))?$/.exec(part);
    if (!r) return refusal('day-of-week must be * or numbers, ranges and lists such as 1-5 or 1,3');
    const a = Number(r[1]);
    const b = r[2] === undefined ? a : Number(r[2]);
    if (b < a) return refusal('a day range must run upward');
    for (let d = a; d <= b; d++) days.add(d % 7);
  }
  return { scheduleType: 'weekly', weeklyDays: [...days].sort((x, y) => x - y), weeklyTime: t };
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function routineWhen(j: RoutineRow): string {
  if (j.scheduleType === 'interval') {
    const m = j.intervalMinutes ?? 0;
    return m % 1440 === 0 ? `every ${m / 1440}d` : m % 60 === 0 ? `every ${m / 60}h` : `every ${m}m`;
  }
  const zone = j.timeZone ? ` ${j.timeZone}` : '';
  if (j.scheduleType === 'daily') return `daily ${j.dailyTime ?? ''}${zone}`;
  if (j.scheduleType === 'weekly') {
    const days = (j.weeklyDays ?? []).join(',') === '1,2,3,4,5' ? 'weekdays' : (j.weeklyDays ?? []).map((d) => DAY_NAMES[d]).join(',');
    return `${days} ${j.weeklyTime ?? ''}${zone}`;
  }
  return j.scheduleType;
}

function routineNext(j: RoutineRow): string {
  if (!j.enabled) return 'off';
  if (!j.nextRunAt) return 'none scheduled';
  const zone = j.timeZone || 'UTC';
  try {
    const text = new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(j.nextRunAt));
    return `${text} ${zone}`;
  } catch {
    return new Date(j.nextRunAt).toISOString();
  }
}

function routineLine(j: RoutineRow, roomName: (id?: string) => string): string {
  return `${j.id.slice(0, 8)}  ${j.enabled ? 'on ' : 'off'}  ${routineWhen(j)}  ${roomName(j.roomId)}  next: ${routineNext(j)}  ${quoteForPane(j.name, 60)}`;
}

/** The caller's routine with this id (or an 8+ character prefix of it), among the ones it may see. */
async function resolveRoutine(deps: AgentDeps, ref: string): Promise<{ job: RoutineRow } | { error: string; code: number }> {
  if (ref.trim().length < 8) return { error: `refusing: "${ref}" is shorter than 8 characters; use the id \`routine list\` prints`, code: EXIT.refused };
  const res = await deps.request(deps.ctx, { method: 'GET', path: '/api/v1/cron/jobs' });
  if (!res.json?.success) return { error: describeFailure(res), code: EXIT.error };
  const rows = ((res.json.data as RoutineRow[] | undefined) ?? []).filter((j) => (j as { action?: string }).action === 'post' && j.id.startsWith(ref.trim()));
  if (rows.length === 1) return { job: rows[0] as RoutineRow };
  if (rows.length === 0) return { error: `no routine of yours starts with "${ref}" (see \`routine list\`)`, code: EXIT.error };
  return { error: `"${ref}" is ambiguous: ${rows.map((r) => r.id.slice(0, 13)).join(', ')}`, code: EXIT.error };
}

/** `routine add` — schedule a message in a room you are in. The server sets the author (you) and adds the "routine" label to each post. */
export async function routineAdd(
  deps: AgentDeps,
  options: { room?: string; text: string; name?: string; disabled?: boolean; tz?: string } & Parameters<typeof parseRoutineSchedule>[0]
): Promise<number> {
  const text = options.text.trim();
  if (!text) return fail(deps, 'refusing: empty routine text', EXIT.refused);
  if (text.length > 2000) return fail(deps, 'a routine\'s text is at most 2000 characters', EXIT.refused);
  if (/[\r\n]/.test(text)) return fail(deps, 'a routine is one line', EXIT.refused);
  const schedule = parseRoutineSchedule(options);
  if ('error' in schedule) return fail(deps, schedule.error, EXIT.refused);
  const target = await resolveChatRoom(deps, options.room);
  if ('error' in target) return fail(deps, target.error, target.code);
  const res = await deps.request(deps.ctx, {
    method: 'POST',
    path: '/api/v1/cron/jobs',
    body: {
      // Without --name the label says only when it runs: the name is visible to other employees and the general, the text is not.
      name: options.name ?? `routine ${routineWhen({ id: '', name: '', enabled: true, ...schedule, timeZone: options.tz ?? PLAN_ZONE })}`,
      action: 'post',
      roomId: target.room.id,
      postText: text,
      enabled: !options.disabled,
      ...schedule,
      timeZone: options.tz ?? PLAN_ZONE,
    },
  });
  if (!res.json?.success) return fail(deps, describeFailure(res));
  const job = (res.json.data as { job: RoutineRow }).job;
  if (deps.json) emitJson(deps, job);
  else {
    deps.io.out(palette.ok(`${GLYPH.ok} routine ${job.id.slice(0, 8)} in "${chatRoomLabel(target.room)}": ${routineWhen(job)}, next ${routineNext(job)}`));
  }
  return EXIT.ok;
}

/** `routine list` — your routines; with --all, everyone's name, room and schedule (never their text). */
export async function routineList(deps: AgentDeps, options: { all?: boolean } = {}): Promise<number> {
  const res = await deps.request(deps.ctx, { method: 'GET', path: '/api/v1/cron/jobs', query: options.all ? { all: '1' } : undefined });
  if (!res.json?.success) return fail(deps, describeFailure(res));
  const rows = ((res.json.data as RoutineRow[] | undefined) ?? []).filter((j) => (j as { action?: string }).action === 'post');
  if (deps.json) {
    emitJson(deps, rows);
    return EXIT.ok;
  }
  if (rows.length === 0) {
    deps.io.out(palette.muted(options.all ? '(no routines)' : '(you have no routines; add one with `routine add`)'));
    return EXIT.ok;
  }
  const rooms = await deps.request(deps.ctx, { method: 'GET', path: '/api/v1/chatrooms' });
  const names = new Map(((rooms.json?.data as { rooms?: ChatRoomRow[] } | undefined)?.rooms ?? []).map((r) => [r.id, chatRoomLabel(r)]));
  for (const j of rows) deps.io.out(routineLine(j, (id) => `"${(id && names.get(id)) || id?.slice(0, 8) || '?'}"`));
  return EXIT.ok;
}

/** `routine show ID` — one routine in full. */
export async function routineShow(deps: AgentDeps, options: { id: string }): Promise<number> {
  const found = await resolveRoutine(deps, options.id);
  if ('error' in found) return fail(deps, found.error, found.code);
  const j = found.job;
  if (deps.json) {
    emitJson(deps, j);
    return EXIT.ok;
  }
  deps.io.out(routineLine(j, (id) => id?.slice(0, 8) ?? '?'));
  deps.io.out(`text: ${quoteForPane(j.postText ?? '', 2000)}`);
  deps.io.out(`last: ${j.lastStatus ?? 'never run'}`);
  return EXIT.ok;
}

async function routineChange(deps: AgentDeps, id: string, how: 'rm' | 'enable' | 'disable' | 'run'): Promise<number> {
  const found = await resolveRoutine(deps, id);
  if ('error' in found) return fail(deps, found.error, found.code);
  const base = `/api/v1/cron/jobs/${encodeURIComponent(found.job.id)}`;
  const res =
    how === 'rm'
      ? await deps.request(deps.ctx, { method: 'DELETE', path: base })
      : how === 'run'
        ? await deps.request(deps.ctx, { method: 'POST', path: `${base}/run` })
        : await deps.request(deps.ctx, { method: 'PUT', path: `${base}/enabled`, body: { enabled: how === 'enable' } });
  if (!res.json?.success) return fail(deps, describeFailure(res));
  const verb = { rm: 'removed', enable: 'switched on', disable: 'switched off', run: 'ran' }[how];
  if (deps.json) emitJson(deps, res.json.data ?? {});
  else deps.io.out(palette.ok(`${GLYPH.ok} routine ${found.job.id.slice(0, 8)} ${verb}`));
  if (how === 'run' && !deps.json) {
    const run = (res.json.data as { run?: { status?: string; errorMessage?: string } } | undefined)?.run;
    if (run?.status === 'failed') return fail(deps, `the post failed: ${run.errorMessage ?? 'unknown reason'}`);
  }
  return EXIT.ok;
}

export const routineRm = (deps: AgentDeps, o: { id: string }): Promise<number> => routineChange(deps, o.id, 'rm');
export const routineEnable = (deps: AgentDeps, o: { id: string }): Promise<number> => routineChange(deps, o.id, 'enable');
export const routineDisable = (deps: AgentDeps, o: { id: string }): Promise<number> => routineChange(deps, o.id, 'disable');
export const routineRun = (deps: AgentDeps, o: { id: string }): Promise<number> => routineChange(deps, o.id, 'run');

/** `routine runs ID` — the last fires of one routine, newest first. */
export async function routineRuns(deps: AgentDeps, options: { id: string; count?: number }): Promise<number> {
  const found = await resolveRoutine(deps, options.id);
  if ('error' in found) return fail(deps, found.error, found.code);
  const res = await deps.request(deps.ctx, { method: 'GET', path: `/api/v1/cron/jobs/${encodeURIComponent(found.job.id)}/runs` });
  if (!res.json?.success) return fail(deps, describeFailure(res));
  const runs = ((res.json.data as Array<{ startedAt: number; status: string; errorMessage?: string }> | undefined) ?? [])
    .slice()
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, options.count ?? 20);
  if (deps.json) {
    emitJson(deps, runs);
    return EXIT.ok;
  }
  if (runs.length === 0) deps.io.out(palette.muted('(never run)'));
  for (const r of runs) deps.io.out(`${new Date(r.startedAt).toISOString()}  ${r.status}${r.errorMessage ? `  ${quoteForPane(r.errorMessage, 160)}` : ''}`);
  return EXIT.ok;
}

function registerRoutineCommands(program: Command, run: typeof runAgentVerb): void {
  const routine = program
    .command('routine')
    .description('Scheduled messages that post themselves in a room as you, labelled "routine" (yours only; the owner can turn this off)');
  const json = '--json';
  routine
    .command('add [text...]')
    .description('Schedule a message: add --room R --every 30m|--daily 09:00|--weekdays 09:00|--cron "M H * * 1-5" [--tz Zone] -- text')
    .option('-r, --room <room>', 'Room id or name (default: the one room this session is in)')
    .option('--every <span>', 'Repeat every N minutes/hours/days: 30m, 2h, 1d (at least 5m)')
    .option('--daily <HH:MM>', 'Every day at this 24-hour time')
    .option('--weekdays <HH:MM>', 'Monday to Friday at this 24-hour time')
    .option('--cron <expr>', 'Five fields; only "M H * * *" (daily) and "M H * * days" (weekly) can be scheduled')
    .option('--tz <zone>', 'IANA zone the daily/weekly time is read in (default America/New_York)')
    .option('--name <name>', 'A short label (default: the start of the text)')
    .option('--disabled', 'Create it switched off')
    .option(json, 'Machine-readable output')
    .action((words: string[], o: { room?: string; every?: string; daily?: string; weekdays?: string; cron?: string; tz?: string; name?: string; disabled?: boolean; json?: boolean }) =>
      run(Boolean(o.json), (deps) => routineAdd(deps, { ...o, text: words.join(' ') }))
    );
  routine
    .command('list')
    .alias('ls')
    .description('Your routines; --all adds everyone\'s name, room and schedule (never their text)')
    .option('--all', 'Include other authors\' routines')
    .option(json, 'Machine-readable output')
    .action((o: { all?: boolean; json?: boolean }) => run(Boolean(o.json), (deps) => routineList(deps, o)));
  routine
    .command('show <id>')
    .description('One routine in full')
    .option(json, 'Machine-readable output')
    .action((id: string, o: { json?: boolean }) => run(Boolean(o.json), (deps) => routineShow(deps, { id })));
  for (const [verb, text, fn] of [
    ['rm', 'Delete one of your routines', routineRm],
    ['enable', 'Switch a routine on', routineEnable],
    ['disable', 'Switch a routine off', routineDisable],
    ['run', 'Post it once now', routineRun],
  ] as const) {
    routine
      .command(`${verb} <id>`)
      .description(text)
      .option(json, 'Machine-readable output')
      .action((id: string, o: { json?: boolean }) => run(Boolean(o.json), (deps) => fn(deps, { id })));
  }
  routine
    .command('runs <id>')
    .description('The last fires of one routine, newest first')
    .option('-n, --count <n>', 'How many', '20')
    .option(json, 'Machine-readable output')
    .action((id: string, o: { count?: string; json?: boolean }) =>
      run(Boolean(o.json), (deps) => routineRuns(deps, { id, count: parsePositiveInt(o.count, 20) }))
    );
}


/** Register `reverie agent …` on the program. */
export function registerAgentCommands(program: Command): Command {
  const agent = program
    .command('agent')
    .description('Talk to other sessions from inside one (any CLI mode): list, spawn, send, wait, read, interrupt, rm');

  const run = runAgentVerb;
  const context = agent.command('context').description('Read current self profile/core context; old startup is unknown without a harness receipt');
  context.option('--json', 'Machine-readable current context and capture availability')
    .action((options: { json?: boolean }) => run(Boolean(options.json), agentContext));
  context.command('receipt').description('Report an exact previously issued context snapshot as harness input').requiredOption('--digest <sha256>', 'Exact prior server-issued snapshot digest')
    .requiredOption('--stage <stage>', 'startup or model-request; harness-reported inclusion only')
    .option('--json', 'Machine-readable report metadata')
    .action((options: { json?: boolean; digest: string; stage: string }) => run(Boolean(options.json), deps => agentContextReceipt(deps, options.digest, options.stage)));
  agent.command('capabilities').description('Read current authenticated grants, supported commands and credential references; writes nothing')
    .option('--json', 'Machine-readable current capability report')
    .action((options: { json?: boolean }) => run(Boolean(options.json), agentCapabilities));
  const credentials = agent.command('credentials').description('List granted named PATs or explicitly install one private local copy; never prints material');
  credentials.command('list').description('List current named publication credential grants without secret values').option('--json', 'Machine-readable granted credential metadata')
    .action((options: { json?: boolean }) => run(Boolean(options.json), agentCredentialsList));
  credentials.command('status').description('Inspect own registration/grant availability; expiry and repository access stay explicit unknowns').option('--json', 'Machine-readable own credential availability without paths or material')
    .action((options: { json?: boolean }) => run(Boolean(options.json), agentCredentialStatus));
  credentials.command('install <name-or-id>').description('Install one granted credential as a private local file; never print its value').option('--json', 'Machine-readable installation metadata; never token material')
    .action((reference: string, options: { json?: boolean }) => run(Boolean(options.json), (deps) => agentCredentialsInstall(deps, reference)));
  registerJournalCommands(agent, run);
  registerHireRequestCommands(agent, run);
  registerGoalCommands(agent, run);
  registerRoutineCommands(program, run);
  const planMove = agent.command('plan-move').description('Request a permitted plan move or approve a handoff for this exact expert');
  planMove.command('list').description('List this expert’s pending plan requests').option('--json', 'Machine-readable result')
    .action((options: { json?: boolean }) => run(Boolean(options.json), agentPendingPlanMoves));
  planMove.command('request <account-id>')
    .description('Prepare a permitted plan move or same-account runtime refresh for safe handoff')
    .option('--restart', 'Refresh this expert on its current account through handoff and approval')
    .option('--employee <id>', 'Team expert ID (requires Manage team plans)')
    .option('--id <id>', 'Stable request ID for safe retries')
    .option('--json', 'Machine-readable result')
    .action((toAccount: string, options: { employee?: string; id?: string; json?: boolean; restart?: boolean }) =>
      run(Boolean(options.json), deps => agentRequestPlanMove(deps, { toAccount, employeeId: options.employee, id: options.id, restart: options.restart })));
  planMove.command('approve <id>')
    .description('Approve your pending request with its work-safe handoff file')
    .requiredOption('--handoff-file <path>', 'Work-safe handoff for the fresh destination session')
    .option('--json', 'Machine-readable result')
    .action((id: string, options: { handoffFile: string; json?: boolean }) =>
      run(Boolean(options.json), deps => agentPlanRequest(deps, { id, decision: 'approve', handoffFile: options.handoffFile })));
  planMove.command('reject <id>').description('Reject your pending plan request without moving the runtime').option('--json', 'Machine-readable result')
    .action((id: string, options: { json?: boolean }) =>
      run(Boolean(options.json), deps => agentPlanRequest(deps, { id, decision: 'reject' })));
  for (const action of ['status', 'cancel', 'reauthorize'] as const)
    planMove.command(`${action} <id>`).description({ status: 'Inspect the current plan request and its outcome', cancel: 'Cancel a permitted pending plan request', reauthorize: 'Reauthorize a pending request using current permitted account choices' }[action]).option('--json', 'Machine-readable result')
      .action((id: string, options: { json?: boolean }) =>
        run(Boolean(options.json), deps => agentPlanMoveAction(deps, id, action)));

  const plans = program
    .command('plans')
    .description('Subscription accounts: week and 5-hour use, reset time, pace, banked resets, agents on it (read-only)')
    .option('--json', 'Machine-readable output')
    .action((options: { json?: boolean }) => run(Boolean(options.json), agentPlans));
  plans
    .command('show <name>')
    .description('One account by label or id')
    .option('--json', 'Machine-readable output')
    .action((name: string, options: { json?: boolean }, cmd: Command) =>
      run(Boolean(options.json ?? cmd.parent?.opts().json), (deps) => agentPlansShow(deps, { name }))
    );

  agent
    .command('ls')
    .alias('list')
    .description('List sessions; * marks this one')
    .option('--json', 'Machine-readable output')
    .action((options: { json?: boolean }) => run(Boolean(options.json), agentLs));

  agent
    .command('spawn <case>')
    .description(
      'Start a worker session in a case (created if missing) and wait for its composer where the mode draws one'
    )
    .option('-m, --mode <mode>', 'Run mode id, as the Run menu names it', 'claude')
    .option('-n, --name <name>', 'Session name shown in the UI')
    .option('--no-ready', 'Return as soon as the session exists, without the readiness wait')
    .option('-t, --timeout <ms>', 'Readiness budget in ms', String(DEFAULT_WAIT_MS))
    .option('--reasoning-effort <level>', `Codex only: reasoning effort (${CODEX_REASONING_EFFORTS.join('|')})`)
    .option('--bypass-approvals', 'Codex only: run without approval prompts')
    .option('--resume-session <id>', 'Codex only: resume this Codex thread id (checked by the resume guard)')
    .option('--json', 'Machine-readable output')
    .action(
      (
        caseName: string,
        options: {
          mode: string;
          name?: string;
          ready: boolean;
          timeout?: string;
          reasoningEffort?: string;
          bypassApprovals?: boolean;
          resumeSession?: string;
          json?: boolean;
        }
      ) =>
        run(Boolean(options.json), (deps) =>
          agentSpawn(deps, {
            caseName,
            mode: options.mode,
            name: options.name,
            ready: options.ready,
            timeoutMs: parsePositiveInt(options.timeout, DEFAULT_WAIT_MS),
            reasoningEffort: options.reasoningEffort,
            bypassApprovals: options.bypassApprovals,
            resumeSessionId: options.resumeSession,
          })
        )
    );

  agent
    .command('send <id> <text...>')
    .description(
      'Type a prompt into another session and press Enter (ONE quoted argument, printable text only; a prompt that starts with "-" goes after --: send <id> -- "- fix the bug")'
    )
    .option('-w, --wait', 'Block until end of turn (the default signal set; see --until)')
    .option('-u, --until <signals>', 'Signals to wait for, comma list such as stop,exit (implies --wait)')
    .option('-t, --timeout <ms>', 'Wait budget in ms (with --wait)', String(DEFAULT_WAIT_MS))
    .option('--no-enter', 'Type the text without submitting it')
    .option('--client-id <id>', 'Exactly-once tag (default: one per calling session)')
    .option(
      '--seq <n>',
      'Sequence number for the tag (default: the current epoch ms). Must stay monotonic per client id: a reused or lower value is a silent duplicate, nothing is typed'
    )
    .option('--json', 'Machine-readable output')
    .action(
      (
        id: string,
        words: string[],
        options: {
          wait?: boolean;
          until?: string;
          timeout?: string;
          enter: boolean;
          clientId?: string;
          seq?: string;
          json?: boolean;
        }
      ) =>
        run(Boolean(options.json), (deps) => {
          const prompt = sendPromptFromArgs(words);
          if ('error' in prompt) return Promise.resolve(fail(deps, prompt.error, EXIT.refused));
          return agentSend(deps, {
            id,
            text: prompt.text,
            enter: options.enter,
            wait: options.until ?? (options.wait ? true : undefined),
            timeoutMs: parsePositiveInt(options.timeout, DEFAULT_WAIT_MS),
            clientId: options.clientId,
            seq: options.seq === undefined ? undefined : parsePositiveInt(options.seq, 1, '--seq'),
          });
        })
    );

  agent
    .command('wake <id>')
    .description('Nudge an idle colleague: type the standard "check your rooms and Board, then carry on" prompt (a working session is left alone)')
    .option('--json', 'Machine-readable output')
    .action((id: string, options: { json?: boolean }) => run(Boolean(options.json), (deps) => agentWake(deps, { id })));

  agent
    .command('wake-employee <employee-id>')
    .description(
      'Recover a company employee by full employee UUID using your recovery grant; agent wake instead nudges an idle session'
    )
    .option('--json', 'Print the real awakened/skipped recovery report; a skipped or unconfirmed wake exits nonzero')
    .action((employeeId: string, options: { json?: boolean }) =>
      run(Boolean(options.json), (deps) => agentWakeEmployee(deps, { employeeId }))
    );

  agent
    .command('wait <id>')
    .description(
      'Block until a signal (--until) or an output marker (--match) — timeout exits 2, a dead worker exits 3'
    )
    .option(
      '-u, --until <signals>',
      'Comma list: stop,idle,exit,working,blocked (stop/blocked need hook signals for the session; where there are none the server answers 400, passed through)'
    )
    .option(
      '-m, --match <marker>',
      'Literal substring to wait for in the output (ANSI-stripped, no regex). The echo of your own prompt is output too, so never put the marker verbatim in the prompt: ask for it in halves ("print WORKDONE followed by _4711") and wait on the joined form (WORKDONE_4711)'
    )
    .option('--from <where>', 'buffer (scan existing output first, the default) or now', 'buffer')
    .option('--nocase', 'Case-insensitive --match')
    .option('--fresh', 'Require an actual transition (--until only)')
    .option('-t, --timeout <ms>', 'Budget in ms', String(DEFAULT_WAIT_MS))
    .option('--json', 'Machine-readable output')
    .action(
      (
        id: string,
        options: {
          until?: string;
          match?: string;
          from: string;
          nocase?: boolean;
          fresh?: boolean;
          timeout?: string;
          json?: boolean;
        }
      ) =>
        run(Boolean(options.json), (deps) =>
          agentWait(deps, {
            id,
            until: options.until,
            match: options.match,
            from: options.from === 'now' ? 'now' : 'buffer',
            nocase: options.nocase,
            fresh: options.fresh,
            timeoutMs: parsePositiveInt(options.timeout, DEFAULT_WAIT_MS),
          })
        )
    );

  agent
    .command('read <id>')
    .description("Print a session's last answer (as the server reads it for that mode) or, with --tail, its terminal")
    .option('--tail <bytes>', 'Raw terminal tail in bytes, ANSI stripped (works in every mode)')
    .option('--full', 'The whole conversation instead of the last assistant message')
    .option('--json', 'Machine-readable output')
    .action((id: string, options: { tail?: string; full?: boolean; json?: boolean }) =>
      run(Boolean(options.json), (deps) =>
        agentRead(deps, {
          id,
          tail: options.tail === undefined ? undefined : parsePositiveInt(options.tail, 3000, '--tail'),
          full: options.full,
        })
      )
    );

  agent
    .command('interrupt <id>')
    .description('Send a bare ESC to stop the current turn (the conversation survives; deleting would not)')
    .option('--json', 'Machine-readable output')
    .action((id: string, options: { json?: boolean }) =>
      run(Boolean(options.json), (deps) => agentInterrupt(deps, { id }))
    );

  agent
    .command('rm <id>')
    .description('Delete any session except this one (refuses your own id)')
    .option('--json', 'Machine-readable output')
    .action((id: string, options: { json?: boolean }) => run(Boolean(options.json), (deps) => agentRm(deps, { id })));

  agent
    .command('profile')
    .description(
      'Change your own Reverie display name, icon and/or profile image, everywhere it shows (only this session), or propose your pronouns to the owner'
    )
    .option('--name <name>', 'New display name (one line, at most 100 characters)')
    .option('--icon <emoji>', 'New icon (one emoji or at most two characters); shown when there is no image')
    .option('--image <file>', 'New profile image: a PNG, JPEG, GIF or WebP file of at most 256 KB')
    .option('--clear-image', 'Remove the profile image (the icon shows again)')
    .option(
      '--pronouns <text>',
      'Propose your pronouns (one line, at most 24 characters): posts the proposal in the room for the owner to set; changes nothing itself'
    )
    .option('-r, --room <room>', 'Room for the --pronouns proposal (id or name)')
    .option('--json', 'Machine-readable output')
    .action(
      (options: {
        name?: string;
        icon?: string;
        image?: string;
        clearImage?: boolean;
        pronouns?: string;
        room?: string;
        json?: boolean;
      }) =>
        run(Boolean(options.json), (deps) =>
          agentProfile(deps, {
            name: options.name,
            icon: options.icon,
            image: options.image,
            clearImage: options.clearImage,
            pronouns: options.pronouns,
            room: options.room,
          })
        )
    );

  const chat = agent
    .command('chat')
    .description('Talk in the Reverie chatroom(s) this session belongs to: say, read, who, status, add, new, rooms');

  chat
    .command('digest')
    .description('One bounded cross-room delta since your last digest: owner requests, actions for you and changed Board cards first, FYIs batched; no read or handling acknowledgement')
    .option('--json', 'Machine-readable snapshot')
    .option('--all', 'Everything currently eligible; your digest cursor is not moved')
    .option('--since <cursor>', 'From a cursor printed by an earlier digest (or @FILE holding one); your digest cursor is not moved')
    .action((options: { json?: boolean; all?: boolean; since?: string }) =>
      run(Boolean(options.json), (deps) => agentChatDigest(deps, { all: options.all, since: options.since })));

  chat
    .command('summary')
    .description('Bounded own pending-message context, filtered by membership and phone mode; no read acknowledgement')
    .option('--json', 'Machine-readable snapshot')
    .option('--hook-event <event>', 'Context output for SessionStart, UserPromptSubmit or PostToolUse')
    .action((options: { json?: boolean; hookEvent?: string }) =>
      run(Boolean(options.json), (deps) => agentChatSummary(deps, options.hookEvent))
    );

  chat
    .command('mode [mode]')
    .description('Read or set your employee phone mode: ring, vibrate, silent; quiet leases expire within 8h')
    .option('--for <duration>', 'Lease duration, e.g. 30m or 1h (maximum 8h)', '1h')
    .option('--json', 'Machine-readable output')
    .action((mode: string | undefined, options: { for: string; json?: boolean }) => run(Boolean(options.json), async (deps) => {
      const match = /^(\d+(?:\.\d+)?)(m|h)$/.exec(options.for);
      const durationMs = match ? Number(match[1]) * (match[2] === 'h' ? 3600000 : 60000) : NaN;
      if (mode && (!['ring', 'vibrate', 'silent'].includes(mode) || !Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 28800000)) return fail(deps, 'Use ring|vibrate|silent --for 1h (maximum 8h)');
      const res = await deps.request(deps.ctx, { method: mode ? 'POST' : 'GET', path: '/api/v1/chatrooms/alert-mode', ...(mode ? { body: { mode, durationMs } } : {}) });
      if (!res.json?.success) return fail(deps, describeFailure(res));
      if (deps.json) emitJson(deps, res.json.data ?? {});
      else deps.io.out(JSON.stringify(res.json.data ?? {}));
      return EXIT.ok;
    }));

  chat
    .command('rooms')
    .description('List the chatrooms this session is in (--all also lists the public channels it could join)')
    .option('--all', 'Also list the public channels you are not in')
    .option('--json', 'Machine-readable output')
    .action((options: { json?: boolean; all?: boolean }) => run(Boolean(options.json), (deps) => agentChatRooms(deps, { all: options.all })));

  chat
    .command('join <channel>')
    .description('Join a public channel by name or id (a private channel needs the owner or its coordinator to add you)')
    .option('--json', 'Machine-readable output')
    .action((channel: string, options: { json?: boolean }) => run(Boolean(options.json), (deps) => agentChatJoin(deps, { room: channel })));

  chat
    .command('visibility <public|private>')
    .description("Make this channel public (any agent can join) or private (members only); the room's coordinator or the owner only")
    .option('-r, --room <room>', 'Room id or name')
    .option('--json', 'Machine-readable output')
    .action((visibility: string, options: { room?: string; json?: boolean }) =>
      run(Boolean(options.json), (deps) => agentChatVisibility(deps, { room: options.room, visibility }))
    );

  chat
    .command('leave [channel]')
    .description('Leave a channel this session is in (default: the one room it is in)')
    .option('--json', 'Machine-readable output')
    .action((channel: string | undefined, options: { json?: boolean }) => run(Boolean(options.json), (deps) => agentChatLeave(deps, { room: channel })));

  chat
    .command('say [text...]')
    .description('Post a message to everyone in the room (everyone in a channel reads every message: @name a member to address them)')
    .option('--stdin', 'Read literal UTF-8 text from stdin instead of positional text (until EOF)')
    .option('--to <names>', 'Ignored (kept so older scripts do not fail): a post always goes to everyone; @name a member instead')
    .option(
      '-f, --file <path>',
      'Attach a file (repeat for several; copied into the room, max 25 MB each)',
      (v: string, prev: string[] = []) => [...prev, v]
    )
    .option('-r, --room <room>', 'Room id or name (default: the one room this session is in)')
    .option('--reply-to <id>', 'Answer the message with this id (a spoken turn is read back only when its answer names it)')
    .option('--if-latest', 'Post only if nobody else has posted since you last read this room; otherwise list the newer messages')
    .option('--if-no-newer-than <id>', 'Post only if nobody else has posted after this message id')
    .option('--json', 'Machine-readable output')
    .action((words: string[], options: { stdin?: boolean; to?: string; room?: string; file?: string[]; replyTo?: string; ifLatest?: boolean; ifNoNewerThan?: string; json?: boolean }) =>
      run(Boolean(options.json), (deps) => agentChatSayInput(deps, words, options))
    );

  chat
    .command('emote <action...>')
    .description('Post an action line in your name, e.g. emote dances -> "* <you> dances"')
    .option('-r, --room <room>', 'Room id or name (default: the one room this session is in)')
    .option('--json', 'Machine-readable output')
    .action((words: string[], options: { room?: string; json?: boolean }) =>
      run(Boolean(options.json), (deps) => agentChatEmote(deps, { room: options.room, action: words.join(' ') }))
    );

  chat
    .command('poll [question...]')
    .description('Ask the room a question with options; people vote in the chat app (a question starting with "-" goes after --). "poll close ROOM:ID" closes one early: see "poll-close --help"')
    .option('-o, --option <label>', 'An option (repeat: at least two, at most ten)', (v: string, prev: string[] = []) => [...prev, v])
    .option('--rec <option>', 'Mark one option as your recommendation (its label or number)')
    .option('--multi', 'Allow choosing several options')
    .option('--closes-in <minutes>', 'Stop taking votes after this many minutes')
    .option('--to <names>', 'Ignored (kept so older scripts do not fail): a poll always goes to everyone')
    .option('-r, --room <room>', 'Room id or name')
    .option('--json', 'Machine-readable output')
    .action(
      (
        words: string[],
        options: { option?: string[]; rec?: string; multi?: boolean; closesIn?: string; to?: string; room?: string; json?: boolean }
      ) =>
        run(Boolean(options.json), (deps) => {
          // `poll close ROOM:ID`: a close, not a question (a real poll always has --option values).
          if (words[0] === 'close' && words.length === 2 && !options.option?.length) return agentChatPollClose(deps, { room: options.room, ref: words[1] });
          const question = words.join(' ').trim();
          if (!question) return Promise.resolve(fail(deps, 'refusing: a poll needs a question', EXIT.refused));
          return agentChatPoll(deps, {
            room: options.room,
            to: options.to,
            question,
            options: options.option ?? [],
            rec: options.rec,
            multi: options.multi,
            closesInMinutes: options.closesIn ? parsePositiveInt(options.closesIn, 0, '--closes-in') : undefined,
          });
        })
    );

  chat
    .command('poll-close <ref>')
    .description('Close a poll early; also "poll close <ref>". ref: ROOM:ID (room name or id, then 6+ characters of the poll id) or ID with --room. Its author, the room\'s coordinator or the user')
    .option('-r, --room <room>', 'Room id or name')
    .option('--json', 'Machine-readable output')
    .action((ref: string, options: { room?: string; json?: boolean }) =>
      run(Boolean(options.json), (deps) => agentChatPollClose(deps, { room: options.room, ref }))
    );

  chat
    .command('poll-results <id>')
    .description('Show a poll: each option, its votes and who chose it (id: the first 6+ characters from "agent chat read")')
    .option('-r, --room <room>', 'Room id or name')
    .option('--json', 'Machine-readable output')
    .action((id: string, options: { room?: string; json?: boolean }) =>
      run(Boolean(options.json), (deps) => agentChatPollResults(deps, { room: options.room, id }))
    );

  chat
    .command('vote <id> [options...]')
    .description('Vote on a poll by option number or label; no option withdraws your vote (a label that starts with "-" goes after --: vote <id> -- "-label"; its number always works)')
    .option('-r, --room <room>', 'Room id or name')
    .option('--json', 'Machine-readable output')
    .action((id: string, choices: string[], options: { room?: string; json?: boolean }) =>
      run(Boolean(options.json), (deps) => agentChatVote(deps, { room: options.room, id, options: choices }))
    );

  chat
    .command('delivery-status')
    .description('Inspect your own pending delivery/inspection status; does not clear anything')
    .option('--json', 'Machine-readable output')
    .action((options: { json?: boolean }) => run(Boolean(options.json), async (deps) => {
      const res = await deps.request(deps.ctx, { method: 'GET', path: '/api/v1/chatrooms/delivery-status' });
      if (!res.json?.success) return fail(deps, describeFailure(res));
      if (deps.json) emitJson(deps, res.json.data ?? {});
      else deps.io.out(JSON.stringify(res.json.data ?? {}));
      return EXIT.ok;
    }));

  chat
    .command('read')
    .description('Print recent room history, or one exact message without the history-window cap')
    .option('-n, --limit <n>', 'How many messages', '30')
    .option('-r, --room <room>', 'Room id or name')
    .option('--json', 'Machine-readable output')
    .option('--message <id>', 'Read exactly this message, including archived history; no automatic acknowledgement')
    .option('--acknowledge', 'Explicitly acknowledge only the exact message after receiving it')
    .action((options: { limit?: string; room?: string; json?: boolean; message?: string; acknowledge?: boolean }) =>
      run(Boolean(options.json), (deps) =>
        agentChatRead(deps, { room: options.room, limit: parsePositiveInt(options.limit, 30, '--limit'), message: options.message, acknowledge: options.acknowledge })
      )
    );

  chat
    .command('pending')
    .description('Inspect one bounded own owner-attention history page without marking anything read/handled')
    .option('-r, --room <room>', 'Room id or name')
    .option('--before-at <epoch-ms>', 'Older-page cursor timestamp, paired with --before-id')
    .option('--before-id <id>', 'Older-page cursor message identity, paired with --before-at')
    .option('--json', 'Machine-readable output including source references and coverage')
    .action((options: { room?: string; beforeAt?: string; beforeId?: string; json?: boolean }) =>
      run(Boolean(options.json), deps => agentChatPending(deps, options))
    );

  chat
    .command('handle [message-id]')
    .description('Resolve your own attention for an exact notice, or with --before every pending agent/bot notice in a room before a time; does not ACK delivery or complete work')
    .option('-r, --room <room>', 'Room id or name')
    .option('--superseded-by <id>', 'Visible replacement message in the same room')
    .option('--before <time>', 'Bulk: your pending notices from agents and bots in --room before this time (epoch ms or ISO 8601 with offset); never the owner\'s')
    .option('--json', 'Machine-readable output')
    .action((message: string | undefined, options: { room?: string; supersededBy?: string; before?: string; json?: boolean }) =>
      run(Boolean(options.json), async deps => {
        if ((message === undefined) === (options.before === undefined) || (options.before !== undefined && options.supersededBy !== undefined))
          return fail(deps, 'Give either an exact message id or --before <time> (not both, and --superseded-by only with an id)');
        return options.before !== undefined
          ? agentChatHandleBefore(deps, { room: options.room, before: options.before })
          : agentChatHandle(deps, { message: message!, room: options.room, supersededBy: options.supersededBy });
      })
    );

  chat
    .command('fetch <room> <file-id>')
    .description('Download a room attachment (bounded bytes/deadline; no redirects or overwrite)')
    .requiredOption('-o, --output <filename>', 'New filename in current directory, not a path')
    .option('--max-bytes <bytes>', 'Download byte ceiling, 1..67108864 (64 MiB)', '8388608')
    .option('--timeout <ms>', 'Whole download network deadline, 1..120000 ms', '30000')
    .option('--json', 'Machine-readable output')
    .action(
      (
        room: string,
        fileId: string,
        options: { output: string; json?: boolean; maxBytes?: string; timeout?: string }
      ) =>
        run(Boolean(options.json), (deps) =>
          agentChatFetch(deps, {
            room,
            fileId,
            output: options.output,
            maxBytes: Number(options.maxBytes),
            timeoutMs: Number(options.timeout),
          })
        )
    );

  chat
    .command('replace <new-session-id> [old-session-id]')
    .description("After a plan switch, hand this session's place in every room to its successor (or name the old session, owner only). Allowed for the owner, or from the old session when the successor resumes its conversation and was made by it")
    .option('--json', 'Machine-readable output')
    .action((to: string, from: string | undefined, options: { json?: boolean }) =>
      run(Boolean(options.json), (deps) => agentChatReplace(deps, { to, from }))
    );

  chat
    .command('notify <all|mentions>')
    .description('Choose what wakes you in this room: all (as the room says) or mentions (only a direct @mention, a reply to you, a message to you, or the owner; the rest still arrives with your next prompt)')
    .option('-r, --room <room>', 'Room id or name')
    .option('--json', 'Machine-readable output')
    .action((mode: string, options: { room?: string; json?: boolean }) =>
      run(Boolean(options.json), (deps) => agentChatNotify(deps, { room: options.room, mode }))
    );

  chat
    .command('pins')
    .description("List the room's pinned messages (its rules), newest first")
    .option('-r, --room <room>', 'Room id or name')
    .option('--json', 'Machine-readable output')
    .action((options: { room?: string; json?: boolean }) =>
      run(Boolean(options.json), (deps) => agentChatPins(deps, { room: options.room }))
    );

  for (const [verb, on, blurb] of [
    ['pin', true, "Pin a message in the room (coordinator only); pinned messages are in every member's briefing"],
    ['unpin', false, 'Unpin a message (coordinator only)'],
  ] as const) {
    chat
      .command(`${verb} <id>`)
      .description(blurb)
      .option('-r, --room <room>', 'Room id or name')
      .option('--json', 'Machine-readable output')
      .action((id: string, options: { room?: string; json?: boolean }) =>
        run(Boolean(options.json), (deps) => agentChatPin(deps, { room: options.room, id, on }))
      );
  }

  chat
    .command('who')
    .description('List members with role, state, goal and progress')
    .option('-n, --names', 'Only the member names, one per line')
    .option('-r, --room <room>', 'Room id or name')
    .option('--json', 'Machine-readable output')
    .action((options: { room?: string; names?: boolean; json?: boolean }) =>
      run(Boolean(options.json), (deps) => agentChatWho(deps, { room: options.room, names: options.names }))
    );

  chat
    .command('status')
    .description("Set this session's synopsis (goal, progress) and avatar icon shown to the room")
    .option('-g, --goal <text>', 'What this session is trying to achieve')
    .option('-p, --progress <text>', 'Where it stands right now')
    .option('-a, --away <text>', 'An away note shown next to your name, e.g. "back at 3" ("" clears it)')
    .option('-i, --icon <glyph>', 'Avatar: one emoji or up to two characters ("" clears it)')
    .option('-r, --room <room>', 'Room id or name')
    .option('--json', 'Machine-readable output')
    .action((options: { goal?: string; progress?: string; away?: string; icon?: string; room?: string; json?: boolean }) =>
      run(Boolean(options.json), (deps) =>
        agentChatStatus(deps, {
          room: options.room,
          goal: options.goal,
          progress: options.progress,
          away: options.away,
          icon: options.icon,
        })
      )
    );

  chat
    .command('new <name>')
    .description(
      'Coordinator only: create a chatroom that you coordinate (sessions you can see may be added with --add)'
    )
    .option('-a, --add <id>', 'A session to add (repeatable)', (value: string, all: string[] = []) => [...all, value])
    .option('--json', 'Machine-readable output')
    .action((name: string, options: { add?: string[]; json?: boolean }) =>
      run(Boolean(options.json), (deps) => agentChatNew(deps, { name, members: options.add ?? [] }))
    );

  chat
    .command('add <id>')
    .description('Coordinator only: add another session to the room (it receives a briefing)')
    .option('-g, --goal <text>', 'Its goal, shown to the room')
    .option('--voice', 'Make it the member that answers spoken turns (clears any other)')
    .option('-r, --room <room>', 'Room id or name')
    .option('--json', 'Machine-readable output')
    .action((id: string, options: { goal?: string; voice?: boolean; room?: string; json?: boolean }) =>
      run(Boolean(options.json), (deps) =>
        agentChatAdd(deps, { room: options.room, id, goal: options.goal, voice: options.voice })
      )
    );

  chat
    .command('voice <id>')
    .description('Coordinator only: mark the member that answers push-to-talk and car mode (one per room)')
    .option('--off', 'Unmark it instead')
    .option('-r, --room <room>', 'Room id or name')
    .option('--json', 'Machine-readable output')
    .action((id: string, options: { off?: boolean; room?: string; json?: boolean }) =>
      run(Boolean(options.json), (deps) => agentChatVoice(deps, { room: options.room, id, on: !options.off }))
    );

  return agent;
}
