/**
 * @fileoverview `codeman agent …` — session-to-session verbs for the agent running
 * inside a Codeman session, in every CLI mode.
 *
 * A thin HTTP client over endpoints that already exist (`quick-start`, `input`,
 * `wait`, `wait-output`, `last-response`, `terminal`, `DELETE sessions/:id`). It
 * invents no route and no transport: everything goes through `CODEMAN_API_URL`, so
 * auth, ownership and the per-session waiter cap apply unchanged. The behaviour is
 * the packaged agent skill's (`skills/codeman`), ported from shell prose into code
 * with tests, so a `codex`/`opencode`/`pi` agent — which never gets the claude-only
 * preamble — has the same verbs from one line in its AGENTS.md.
 *
 * Invariants (each asserted in `test/cli-agent.test.ts`):
 * 1. Refuses outside a Codeman session (`CODEMAN_MUX=1` + `CODEMAN_API_URL`); it
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
import https from 'node:https';
import type { Command } from 'commander';
import {
  basicAuthHeader,
  credentialsFrom,
  readCodemanEnvFile,
  type CodemanCredentials,
} from './codeman-credentials.js';
import { getCli } from './config/cli-registry/registry.js';
import { GLYPH, palette, table } from './cli-style.js';
import { getErrorMessage } from './types.js';
import { CODEX_REASONING_EFFORTS } from './types/session.js';
import { stripAnsi as stripAnsiSequences } from './utils/regex-patterns.js';
import { quoteForPane } from './pane-quote.js';

// ─────────────────────────────────────────────────────────────────────────────
// Context and guard
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentContext {
  /** Base URL of the Codeman server, from `CODEMAN_API_URL`. */
  apiUrl: string;
  /** This session's id, from `CODEMAN_SESSION_ID`. */
  selfId: string;
  /** Basic-auth credentials, when the server has a password. */
  auth?: CodemanCredentials;
}

/** Thrown when the process is not inside a Codeman-managed session. */
export class AgentGuardError extends Error {}

/** Exit codes shared by every verb; a shell agent can branch on them. */
export const EXIT = {
  ok: 0,
  error: 1,
  timeout: 2,
  dead: 3,
  refused: 4,
} as const;

/**
 * Resolve the context from the environment, or throw `AgentGuardError`.
 *
 * Credentials in the order every client of the API uses (`credentialsFrom`, shared
 * with `codeman attach` and the TUI): each field from the environment (a session
 * inherits the server's), then the data dir's `.env`. No password means the server
 * is open (single-user) — or it is not, and the 401 says so.
 */
export function resolveAgentContext(
  env: NodeJS.ProcessEnv = process.env,
  envFile: () => Record<string, string> = readCodemanEnvFile
): AgentContext {
  if (env.CODEMAN_MUX !== '1') {
    throw new AgentGuardError('Not inside a Reverie-managed session (CODEMAN_MUX is not 1); refusing to act.');
  }
  const apiUrl = env.CODEMAN_API_URL?.trim();
  if (!apiUrl) {
    throw new AgentGuardError('CODEMAN_API_URL is not set; refusing to guess a server.');
  }
  const selfId = env.CODEMAN_SESSION_ID?.trim();
  if (!selfId) {
    throw new AgentGuardError('CODEMAN_SESSION_ID is not set; cannot tell which session is me.');
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
  options: { enter: boolean; clientId: string; seq: number; wait?: string | true; waitTimeout?: number }
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    input: options.enter ? `${text}\r` : text,
    useMux: true,
    clientId: options.clientId,
    seq: options.seq,
  };
  if (options.wait !== undefined) body.wait = options.wait;
  if (options.waitTimeout !== undefined) body.waitTimeout = options.waitTimeout;
  return body;
}

/** Body for the interrupt path: a bare ESC, and nothing appended — ever. */
export function buildInterruptBody(clientId: string, seq: number): Record<string, unknown> {
  return { input: '\u001b', useMux: true, clientId, seq };
}

/** `clientId` for this caller: fixed per sending session, so `seq` stays monotonic. */
export function defaultClientId(selfId: string, suffix = ''): string {
  return `codeman-agent-cli-${selfId.slice(0, 8)}${suffix ? `-${suffix}` : ''}`;
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
}

export type ApiRequest = (ctx: AgentContext, options: RequestOptions) => Promise<ApiResponse>;

/** Every request carries these; they are ignored on endpoints that do not read them. */
export function baseHeaders(ctx: AgentContext): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  // Tags sessions this caller spawns as its children (lineage in the web UI).
  // Cosmetic, never fails a call. NOT X-Codeman-Agent-Origin: that one marks a case
  // directory as deletable agent scratch, so it rides only the spawn request that
  // may create one (see agentSpawn), never anything else. Absent for a caller outside
  // any session (`codeman mcp` launched by a desktop MCP client), which has no self.
  if (ctx.selfId) headers['X-Codeman-Parent-Session'] = ctx.selfId;
  const authorization = ctx.auth ? basicAuthHeader(ctx.auth) : undefined;
  if (authorization) headers.Authorization = authorization;
  return headers;
}

/** The real transport. `rejectUnauthorized:false` because the HTTPS install uses a self-signed cert. */
export const httpRequest: ApiRequest = (ctx, options) => {
  const url = new URL(options.path, ctx.apiUrl);
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
    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        method: options.method,
        path: `${url.pathname}${url.search}`,
        rejectUnauthorized: false,
        headers,
        timeout: options.timeoutMs ?? 30_000,
        signal: options.signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        // A connection dropped mid-body emits 'error' and never 'end'; without this the
        // promise never settles (and a long-lived `codeman mcp` never answers the call).
        res.on('error', reject);
        res.on('end', () => {
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
    req.on('error', reject);
    if (options.rawBody !== undefined) req.write(options.rawBody);
    else if (bodyText !== undefined) req.write(bodyText);
    req.end();
  });
};

/** One line describing a failed response, for humans. Plain-text guards (401/403/429) have no envelope. */
export function describeFailure(res: ApiResponse): string {
  if (res.json && !res.json.success) {
    return `${res.json.errorCode ?? 'ERROR'}: ${res.json.error ?? 'request failed'} (HTTP ${res.status})`;
  }
  const text = res.text.trim().split('\n')[0] ?? '';
  if (res.status === 401)
    return `HTTP 401 ${text}: the server wants a password (CODEMAN_PASSWORD, or the data dir's .env)`;
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
export const AGENT_ORIGIN_HEADER = { 'X-Codeman-Agent-Origin': 'codeman-agent-cli' } as const;

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
    // Human lines go to stderr so `SID=$(codeman agent spawn …)` captures the id alone.
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
  });
  const res = await deps.request(deps.ctx, {
    method: 'POST',
    path: `/api/v1/sessions/${encodeURIComponent(target.id)}/input`,
    body,
    timeoutMs: (options.timeoutMs ?? 60_000) + 10_000,
  });
  if (!res.json?.success) return fail(deps, describeFailure(res));
  const data = res.json.data as
    | { delivered?: boolean; duplicate?: boolean; buffered?: boolean; dropped?: boolean; wait?: WaitResult }
    | undefined;
  if (deps.json) emitJson(deps, data ?? {});
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
): Promise<{ room: ChatRoomRow } | { error: string; code: number }> {
  const res = await deps.request(deps.ctx, {
    method: 'GET',
    path: '/api/v1/chatrooms',
    query: { member: room ? undefined : 'self' },
  });
  if (!res.json?.success) return { error: describeFailure(res), code: EXIT.error };
  const rooms = ((res.json.data as { rooms?: ChatRoomRow[] } | undefined)?.rooms ?? []) as ChatRoomRow[];
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
    if (matches.length === 1) return { room: matches[0] };
    if (matches.length === 0) return { error: `no chatroom matches "${room}"`, code: EXIT.error };
    return { error: `"${room}" matches ${matches.length} chatrooms; use the id`, code: EXIT.error };
  }
  if (rooms.length === 1) return { room: rooms[0] };
  if (rooms.length === 0) {
    return { error: 'this session is not in any chatroom (the user or a coordinator adds it)', code: EXIT.error };
  }
  // In several rooms and no --room: reply where the last prompt came from, but only when it came from exactly one of them.
  const addressed = (lastDelivery?.roomIds ?? []).map((id) => rooms.find((r) => r.id === id)).filter((r): r is ChatRoomRow => !!r);
  if (addressed.length === 1) {
    if (!deps.json) deps.io.err(palette.muted(`using "${addressed[0].name}", the room you were last addressed in (--room picks another)`));
    return { room: addressed[0] };
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
export function formatChatMessage(m: ChatMessageRow, members: ChatMemberRow[]): string {
  const nameOf = (id: string) =>
    id === 'user' ? 'user' : quoteForPane(members.find((x) => x.sessionId === id)?.name ?? id.slice(0, 8), 80);
  // A post to the whole room names no recipient (as in the delivered line); only an addressed message shows `-> who`.
  const to = m.to === 'all' ? '' : ` -> ${m.to.map(nameOf).join(', ')}`;
  const time = new Date(m.at).toLocaleTimeString();
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
      : quoteForPane(m.text);
  // An edited message reads as its new text, marked; a pinned one is a room rule or announcement.
  const marks = `${m.edited && !m.deleted ? ' (edited)' : ''}${m.pinned && !m.deleted ? ' [pinned]' : ''}`;
  return m.from.kind === 'system'
    ? `${time} * ${iconOf(m.from.sessionId)}${body}`
    : `${time} ${iconOf(m.from.sessionId)}${from}${to}: ${body}${marks}`;
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
  const data = (res.json.data ?? {}) as { messages?: ChatMessageRow[]; members?: ChatMemberRow[] };
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

/** `agent chat say` — post to the room, always to everyone (`--to` is accepted and ignored: nothing an agent posts is private in a channel). */
export async function agentChatSay(
  deps: AgentDeps,
  options: { room?: string; to?: string; text: string; files?: string[]; readFile?: (path: string) => Promise<Buffer> }
): Promise<number> {
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
    },
  });
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

/** `agent chat emote` — post an action line ("* Ada dances") in your own name. */
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

/** `agent chat read` — recent history. */
export async function agentChatRead(deps: AgentDeps, options: { room?: string; limit: number }): Promise<number> {
  const target = await resolveChatRoom(deps, options.room);
  if ('error' in target) return fail(deps, target.error, target.code);
  const res = await deps.request(deps.ctx, {
    method: 'GET',
    path: `/api/v1/chatrooms/${encodeURIComponent(target.room.id)}/messages`,
    query: { limit: options.limit },
  });
  if (!res.json?.success) return fail(deps, describeFailure(res));
  const data = (res.json.data ?? {}) as { messages?: ChatMessageRow[]; members?: ChatMemberRow[] };
  if (deps.json) {
    emitJson(deps, data);
    return EXIT.ok;
  }
  const messages = data.messages ?? [];
  if (messages.length === 0) deps.io.out(palette.muted('(no messages yet)'));
  for (const m of messages) deps.io.out(formatChatMessage(m, data.members ?? []));
  return EXIT.ok;
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
    if (m.away) deps.io.out(`    away: ${quoteForPane(m.away, 500)}`);
    deps.io.out(`    goal: ${m.goal ? quoteForPane(m.goal, 500) : '-'}`);
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

/** `agent profile` — change this session's own display name and/or icon (nothing else, no one else). */
export async function agentProfile(
  deps: AgentDeps,
  options: {
    name?: string;
    icon?: string;
    image?: string;
    clearImage?: boolean;
    readFile?: (path: string) => Promise<Buffer>;
  }
): Promise<number> {
  const textual = options.name !== undefined || options.icon !== undefined;
  if (!textual && options.image === undefined && !options.clearImage) {
    return fail(deps, 'give --name, --icon, --image, --clear-image, or several', EXIT.refused);
  }
  if (options.image !== undefined && options.clearImage) {
    return fail(deps, 'give --image or --clear-image, not both', EXIT.refused);
  }
  if (!deps.ctx.selfId)
    return fail(deps, 'run this inside a Reverie agent session (CODEMAN_SESSION_ID is not set)', EXIT.refused);
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
        'check CODEMAN_SESSION_ID (the server did not recognise this session)'
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

/** Register `codeman agent …` on the program. */
export function registerAgentCommands(program: Command): Command {
  const agent = program
    .command('agent')
    .description('Talk to other sessions from inside one (any CLI mode): list, spawn, send, wait, read, interrupt, rm');

  const run = runAgentVerb;

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
      'Change your own Reverie display name, icon and/or profile image, everywhere it shows (only this session)'
    )
    .option('--name <name>', 'New display name (one line, at most 100 characters)')
    .option('--icon <emoji>', 'New icon (one emoji or at most two characters); shown when there is no image')
    .option('--image <file>', 'New profile image: a PNG, JPEG, GIF or WebP file of at most 256 KB')
    .option('--clear-image', 'Remove the profile image (the icon shows again)')
    .option('--json', 'Machine-readable output')
    .action((options: { name?: string; icon?: string; image?: string; clearImage?: boolean; json?: boolean }) =>
      run(Boolean(options.json), (deps) =>
        agentProfile(deps, {
          name: options.name,
          icon: options.icon,
          image: options.image,
          clearImage: options.clearImage,
        })
      )
    );

  const chat = agent
    .command('chat')
    .description('Talk in the Reverie chatroom(s) this session belongs to: say, read, who, status, add, new, rooms');

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
    .option('--to <names>', 'Ignored (kept so older scripts do not fail): a post always goes to everyone; @name a member instead')
    .option(
      '-f, --file <path>',
      'Attach a file (repeat for several; copied into the room, max 25 MB each)',
      (v: string, prev: string[] = []) => [...prev, v]
    )
    .option('-r, --room <room>', 'Room id or name (default: the one room this session is in)')
    .option('--json', 'Machine-readable output')
    .action((words: string[], options: { to?: string; room?: string; file?: string[]; json?: boolean }) =>
      run(Boolean(options.json), (deps) => {
        const text = words.join(' ').trim();
        if (!text && !options.file?.length) return Promise.resolve(fail(deps, 'refusing: empty message', EXIT.refused));
        return agentChatSay(deps, { room: options.room, to: options.to, text, files: options.file });
      })
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
    .command('read')
    .description('Print recent room history')
    .option('-n, --limit <n>', 'How many messages', '30')
    .option('-r, --room <room>', 'Room id or name')
    .option('--json', 'Machine-readable output')
    .action((options: { limit?: string; room?: string; json?: boolean }) =>
      run(Boolean(options.json), (deps) =>
        agentChatRead(deps, { room: options.room, limit: parsePositiveInt(options.limit, 30, '--limit') })
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
