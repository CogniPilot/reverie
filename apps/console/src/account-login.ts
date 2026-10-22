/**
 * @fileoverview One-click account sign-in from the dashboard.
 *
 * For an account (a Plans row) this starts the provider's own login CLI in a hidden tmux
 * pane on a private socket, pinned to the account's login directory:
 * - Claude: `claude auth login --claudeai` with `CLAUDE_CONFIG_DIR`. It prints an
 *   authorize URL and waits at "Paste code here"; the code shown after signing in is sent
 *   back to the pane (`submitCode`).
 * - Codex: `codex login --device-auth` with `CODEX_HOME`. It prints a device URL and a
 *   one-time code; nothing is sent back.
 *
 * The pane is read every second and reduced to a URL, a code and an exit status by the
 * pure `parseLoginScreen`; `nextLoginState` turns that, the credential file's mtime and
 * the provider's own status command into one of the LoginState values. The credential
 * file is only ever stat()ed, never opened, and the log carries state changes only (no
 * URL, code or pane text). The helper pane is killed as soon as the login settles.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { SubscriptionProvider } from './subscription-profiles.js';

export type LoginState = 'starting' | 'awaiting_user' | 'verifying' | 'signed_in' | 'failed' | 'timeout' | 'cancelled';

export const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;
/** A finished login stays readable this long, then is forgotten. */
const LOGIN_KEEP_MS = 10 * 60 * 1000;
const POLL_MS = 1000;
const EXIT_MARKER = '__REVERIE_LOGIN_EXIT=';
/** What a pasted Claude authorization code may contain (it is typed into the pane verbatim). */
export const LOGIN_CODE_PATTERN = /^[A-Za-z0-9#_.~+/=-]{8,1024}$/;

export interface LoginScreen {
  url: string | null;
  /** Codex's one-time device code. */
  code: string | null;
  /** Claude is waiting for the authorization code to be pasted. */
  needsCode: boolean;
  exitCode: number | null;
  /** The last error-looking line, for a failed login. */
  error: string | null;
}

/** Pure: the parts of a login pane that matter. `text` is `tmux capture-pane -p -J` output. */
export function parseLoginScreen(provider: SubscriptionProvider, text: string): LoginScreen {
  const lines = String(text || '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .split('\n')
    .map((l) => l.trim());
  const needsCode = lines.some((l) => /paste code here/i.test(l));
  // After a paste, the CLI's answer lands on the prompt's own line.
  const answers = lines.map((l) => l.replace(/^.*paste code here if prompted >\s*/i, ''));
  const exit = lines.map((l) => l.match(/__REVERIE_LOGIN_EXIT=(\d+)/)).find(Boolean);
  const urls = lines.flatMap((l) => l.match(/https:\/\/[^\s"'<>]+/g) ?? []);
  const url =
    provider === 'anthropic'
      ? (urls.find((u) => /oauth\/authorize/.test(u)) ?? null)
      : (urls.find((u) => /^https:\/\/auth\.openai\.com\//.test(u)) ?? null);
  const code =
    provider === 'openai'
      ? (lines.map((l) => l.match(/^([A-Z0-9]{4}-[A-Z0-9]{4,6})$/)?.[1]).find(Boolean) ?? null)
      : null;
  const exitCode = exit ? Number(exit[1]) : null;
  const errorLine = [...answers]
    .reverse()
    .find(
      (l) => !l.includes(EXIT_MARKER) && /\b(error|invalid|failed|failure|denied|declined|expired|cancel+ed)\b/i.test(l)
    );
  return {
    url,
    code,
    needsCode: provider === 'anthropic' && exitCode === null && needsCode,
    exitCode,
    error: errorLine ? errorLine.slice(0, 200) : null,
  };
}

export interface LoginStatusCheck {
  loggedIn: boolean;
  /** The account the CLI reports (Claude gives an email; Codex gives none). */
  who?: string;
}

export interface LoginSnapshot {
  state: LoginState;
  message: string;
  codeSubmitted: boolean;
}

export interface LoginInputs {
  screen: LoginScreen;
  /** The credential file was created or rewritten since the login started. */
  credentialsChanged: boolean;
  /** The provider's status command, run once the CLI exits or the credentials change. */
  status: LoginStatusCheck | null;
  now: number;
  deadline: number;
}

const TERMINAL: ReadonlySet<LoginState> = new Set(['signed_in', 'failed', 'timeout', 'cancelled']);

export function isTerminalLoginState(state: LoginState): boolean {
  return TERMINAL.has(state);
}

/** Pure: where a login goes next. Terminal states never change. */
export function nextLoginState(prev: LoginSnapshot, input: LoginInputs): LoginSnapshot {
  if (TERMINAL.has(prev.state)) return prev;
  const { screen, status } = input;
  const keep = (state: LoginState, message: string): LoginSnapshot => ({ ...prev, state, message });
  if (status?.loggedIn && (input.credentialsChanged || screen.exitCode === 0)) {
    return keep('signed_in', status.who ? `Signed in as ${status.who}` : 'Signed in');
  }
  if (screen.exitCode !== null) {
    if (screen.exitCode === 0 && status === null) return keep('verifying', 'Checking the sign-in…');
    if (screen.error && prev.codeSubmitted) {
      return keep('failed', `That code was refused or has expired (${screen.error}). Try again with a fresh code.`);
    }
    if (screen.error) return keep('failed', `Sign-in failed: ${screen.error}`);
    return keep(
      'failed',
      prev.codeSubmitted
        ? 'Sign-in did not complete: the code was refused or expired. Try again with a fresh code.'
        : 'Sign-in did not complete: it was declined or closed. Try again.'
    );
  }
  if (input.now >= input.deadline) return keep('timeout', 'Sign-in timed out. Start it again when you are ready.');
  if (input.credentialsChanged || prev.codeSubmitted) return keep('verifying', 'Checking the sign-in…');
  if (screen.url) {
    return keep(
      'awaiting_user',
      screen.code
        ? 'Open the link, sign in, and enter the code shown here.'
        : 'Open the link, sign in, then paste the code it shows you here.'
    );
  }
  return keep('starting', 'Starting the sign-in…');
}

// ─── Service ──────────────────────────────────────────────────────────────────

export interface LoginAccount {
  id: string;
  label: string;
  provider: SubscriptionProvider;
  configDir: string;
}

export interface LoginView {
  id: string;
  accountId: string;
  label: string;
  provider: SubscriptionProvider;
  state: LoginState;
  message: string;
  url: string | null;
  code: string | null;
  needsCode: boolean;
  qrSvg: string | null;
  startedAt: number;
  expiresAt: number;
}

export interface LoginDeps {
  /** Run `tmux -L <socket> ...args`, resolving stdout. */
  tmux(args: string[]): Promise<string>;
  /** The login command line for a provider (binary plus arguments). */
  command(provider: SubscriptionProvider): string[];
  /** mtime of a file, or null when missing. Never reads it. */
  mtime(path: string): Promise<number | null>;
  status(account: LoginAccount): Promise<LoginStatusCheck>;
  qr(url: string): Promise<string>;
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  log(line: string): void;
  path?: string;
}

interface LoginRecord {
  view: LoginView;
  account: LoginAccount;
  snapshot: LoginSnapshot;
  pane: string;
  startMtime: number | null;
  timer: unknown;
  status: LoginStatusCheck | null;
  checking: boolean;
  settledAt: number | null;
  polling: boolean;
}

export class LoginError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function credentialPath(account: Pick<LoginAccount, 'provider' | 'configDir'>): string {
  return join(account.configDir, account.provider === 'anthropic' ? '.credentials.json' : 'auth.json');
}

export class AccountLoginService {
  private logins = new Map<string, LoginRecord>();

  constructor(private readonly deps: LoginDeps) {}

  /** Start (or restart) the sign-in for an account. */
  async start(account: LoginAccount): Promise<LoginView> {
    for (const r of this.logins.values()) {
      if (r.account.id === account.id && !isTerminalLoginState(r.snapshot.state)) await this.cancel(r.view.id);
    }
    this.sweep();
    await fs.mkdir(account.configDir, { recursive: true, mode: 0o700 }).catch(() => {});
    const id = randomUUID();
    const pane = `login-${id.slice(0, 8)}`;
    const now = this.deps.now();
    const envVar = account.provider === 'anthropic' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
    // No browser is opened on the server: the link is shown in the dashboard instead.
    const script = [
      `exec env -u DISPLAY -u WAYLAND_DISPLAY BROWSER=true ${this.deps.path ? `PATH=${shq(this.deps.path)} ` : ''}`,
      `${envVar}=${shq(account.configDir)} sh -c ${shq(
        `${this.deps.command(account.provider).map(shq).join(' ')}; echo ${EXIT_MARKER}$?; sleep 3600`
      )}`,
    ].join('');
    await this.deps.tmux(['new-session', '-d', '-s', pane, '-x', '400', '-y', '50', script]);
    const record: LoginRecord = {
      view: {
        id,
        accountId: account.id,
        label: account.label,
        provider: account.provider,
        state: 'starting',
        message: 'Starting the sign-in…',
        url: null,
        code: null,
        needsCode: false,
        qrSvg: null,
        startedAt: now,
        expiresAt: now + LOGIN_TIMEOUT_MS,
      },
      account,
      snapshot: { state: 'starting', message: 'Starting the sign-in…', codeSubmitted: false },
      pane,
      startMtime: await this.deps.mtime(credentialPath(account)),
      timer: null,
      status: null,
      checking: false,
      settledAt: null,
      polling: false,
    };
    this.logins.set(id, record);
    this.deps.log(`[AccountLogin] ${account.label}: starting`);
    record.timer = this.deps.setInterval(() => void this.poll(id), POLL_MS);
    await this.poll(id);
    return { ...record.view };
  }

  get(id: string): LoginView | undefined {
    const r = this.logins.get(id);
    return r ? { ...r.view } : undefined;
  }

  /** Type Claude's authorization code into the waiting pane. */
  async submitCode(id: string, code: string): Promise<LoginView> {
    const r = this.logins.get(id);
    if (!r) throw new LoginError('That sign-in is no longer running; start it again', 404);
    if (r.account.provider !== 'anthropic') throw new LoginError('This sign-in takes no code', 400);
    if (isTerminalLoginState(r.snapshot.state)) throw new LoginError('That sign-in has already finished', 409);
    const clean = code.trim();
    if (!LOGIN_CODE_PATTERN.test(clean)) throw new LoginError('That does not look like a sign-in code', 400);
    await this.deps.tmux(['send-keys', '-t', r.pane, '-l', clean]);
    await this.deps.tmux(['send-keys', '-t', r.pane, 'Enter']);
    r.snapshot = { ...r.snapshot, codeSubmitted: true };
    this.deps.log(`[AccountLogin] ${r.account.label}: code submitted`);
    await this.poll(id);
    return { ...r.view };
  }

  async cancel(id: string): Promise<boolean> {
    const r = this.logins.get(id);
    if (!r) return false;
    if (!isTerminalLoginState(r.snapshot.state)) {
      r.snapshot = { ...r.snapshot, state: 'cancelled', message: 'Sign-in cancelled' };
      await this.settle(r);
    }
    return true;
  }

  /** Kill every helper pane (server shutdown). */
  async stopAll(): Promise<void> {
    for (const r of this.logins.values()) await this.cancel(r.view.id);
  }

  private sweep(): void {
    const now = this.deps.now();
    for (const [id, r] of this.logins) {
      if (r.settledAt !== null && now - r.settledAt > LOGIN_KEEP_MS) this.logins.delete(id);
    }
  }

  private async poll(id: string): Promise<void> {
    const r = this.logins.get(id);
    if (!r || r.polling || isTerminalLoginState(r.snapshot.state)) return;
    r.polling = true;
    try {
      let text = '';
      try {
        text = await this.deps.tmux(['capture-pane', '-p', '-J', '-t', r.pane]);
      } catch {
        text = `${EXIT_MARKER}1`; // the pane is gone
      }
      const screen = parseLoginScreen(r.account.provider, text);
      const mtime = await this.deps.mtime(credentialPath(r.account));
      const credentialsChanged = mtime !== null && mtime !== r.startMtime;
      if (r.status === null && !r.checking && (credentialsChanged || screen.exitCode === 0)) {
        r.checking = true;
        try {
          r.status = await this.deps.status(r.account);
        } catch {
          r.status = { loggedIn: false };
        } finally {
          r.checking = false;
        }
        // Credentials written but the CLI still running: look again on the next tick.
        if (!r.status.loggedIn && screen.exitCode === null) r.status = null;
      }
      const before = r.snapshot.state;
      r.snapshot = nextLoginState(r.snapshot, {
        screen,
        credentialsChanged,
        status: r.status,
        now: this.deps.now(),
        deadline: r.view.expiresAt,
      });
      if (screen.url && screen.url !== r.view.url) {
        r.view.url = screen.url;
        r.view.qrSvg = await this.deps.qr(screen.url).catch(() => null);
      }
      r.view.code = screen.code ?? r.view.code;
      r.view.needsCode = screen.needsCode && !r.snapshot.codeSubmitted;
      r.view.state = r.snapshot.state;
      r.view.message = r.snapshot.message;
      if (r.snapshot.state !== before) this.deps.log(`[AccountLogin] ${r.account.label}: ${r.snapshot.state}`);
      if (isTerminalLoginState(r.snapshot.state)) await this.settle(r);
    } finally {
      r.polling = false;
    }
  }

  private async settle(r: LoginRecord): Promise<void> {
    if (r.timer) this.deps.clearInterval(r.timer);
    r.timer = null;
    r.view.state = r.snapshot.state;
    r.view.message = r.snapshot.message;
    r.view.needsCode = false;
    if (r.snapshot.state !== 'signed_in') r.view.code = r.view.state === 'cancelled' ? null : r.view.code;
    if (r.settledAt === null) {
      r.settledAt = this.deps.now();
      if (r.snapshot.state === 'cancelled') this.deps.log(`[AccountLogin] ${r.account.label}: cancelled`);
    }
    await this.deps.tmux(['kill-session', '-t', r.pane]).catch(() => '');
  }
}

// ─── Production wiring ────────────────────────────────────────────────────────

const run = promisify(execFile);

export function defaultLoginDeps(opts: {
  socket: string;
  claudeBinary: string;
  codexBinary: string | null;
  path: string;
}): LoginDeps {
  const env = { ...process.env, PATH: opts.path };
  return {
    tmux: async (args) => (await run('tmux', ['-L', opts.socket, ...args], { timeout: 10_000, env })).stdout,
    command: (provider) =>
      provider === 'anthropic'
        ? [opts.claudeBinary, 'auth', 'login', '--claudeai']
        : [opts.codexBinary || 'codex', 'login', '--device-auth'],
    mtime: async (path) => {
      try {
        return (await fs.stat(path)).mtimeMs;
      } catch {
        return null;
      }
    },
    status: async (account) => {
      if (account.provider === 'anthropic') {
        const { stdout } = await run(opts.claudeBinary, ['auth', 'status', '--json'], {
          timeout: 20_000,
          env: { ...env, CLAUDE_CONFIG_DIR: account.configDir },
        });
        const s = JSON.parse(stdout) as { loggedIn?: unknown; email?: unknown };
        return { loggedIn: s.loggedIn === true, ...(typeof s.email === 'string' ? { who: s.email } : {}) };
      }
      const { stdout, stderr } = await run(opts.codexBinary || 'codex', ['login', 'status'], {
        timeout: 20_000,
        env: { ...env, CODEX_HOME: account.configDir },
      }).catch((e: { stdout?: string; stderr?: string }) => ({ stdout: e.stdout ?? '', stderr: e.stderr ?? '' }));
      const out = `${stdout}\n${stderr}`;
      return { loggedIn: /logged in/i.test(out) && !/not logged in/i.test(out) };
    },
    qr: async (url) => {
      const QRCode = await import('qrcode');
      return QRCode.toString(url, { type: 'svg', margin: 2, width: 220 });
    },
    now: () => Date.now(),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    log: (line) => console.log(line),
    path: opts.path,
  };
}
