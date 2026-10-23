import { trustedFixtureOwner } from './helpers/trusted-owner-fixture.js';
/**
 * One-click account sign-in: the login-pane scrape (from captured Claude and Codex
 * screens), the state machine, the service against a fake tmux, and the routes.
 */
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AccountLoginService,
  LOGIN_TIMEOUT_MS,
  defaultLoginDeps,
  nextLoginState,
  parseLoginScreen,
  type LoginDeps,
  type LoginInputs,
  type LoginScreen,
  type LoginSnapshot,
} from '../src/account-login.js';
import { installRouteErrorHandler } from '../src/web/route-error-handler.js';
import { registerPlansRoutes } from '../src/web/routes/plans-routes.js';
import type { PlanService } from '../src/plan-accounts.js';

const CLAUDE_URL =
  'https://claude.com/cai/oauth/authorize?code=true&client_id=abc&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&state=xyz';

const CLAUDE_SCREEN = `Opening browser to sign in…
If the browser didn't open, visit: ${CLAUDE_URL}
Paste code here if prompted >
`;

const CODEX_SCREEN = `
Welcome to Codex [v0.158.0]
OpenAI's command-line coding agent

Follow these steps to sign in with ChatGPT using device code authorization:

1. Open this link in your browser and sign in to your account
   https://auth.openai.com/codex/device

2. Enter this one-time code (expires in 15 minutes)
   XE1C-NRJKZ

Continue only if you started this login in Codex and trust this device.
`;

describe('parseLoginScreen', () => {
  it('finds the Claude authorize URL and the paste prompt', () => {
    expect(parseLoginScreen('anthropic', CLAUDE_SCREEN)).toEqual({
      url: CLAUDE_URL,
      code: null,
      needsCode: true,
      exitCode: null,
      error: null,
    });
  });

  it('finds the Codex device URL and one-time code', () => {
    const s = parseLoginScreen('openai', CODEX_SCREEN);
    expect(s.url).toBe('https://auth.openai.com/codex/device');
    expect(s.code).toBe('XE1C-NRJKZ');
    expect(s.needsCode).toBe(false);
  });

  it('reads the exit marker and the last error line', () => {
    const s = parseLoginScreen(
      'anthropic',
      `${CLAUDE_SCREEN}abc#def\nOAuth error: Invalid code\n__REVERIE_LOGIN_EXIT=1\n`
    );
    expect(s.exitCode).toBe(1);
    expect(s.error).toBe('OAuth error: Invalid code');
    expect(s.needsCode).toBe(false);
  });

  it('takes the error off the paste prompt line (captured from a refused code)', () => {
    const s = parseLoginScreen(
      'anthropic',
      `If the browser didn't open, visit: ${CLAUDE_URL}\nPaste code here if prompted > Login failed: Request failed with status code 400\n__REVERIE_LOGIN_EXIT=1\n`
    );
    expect(s.error).toBe('Login failed: Request failed with status code 400');
  });

  it('ignores escape sequences and a still-blank pane', () => {
    expect(parseLoginScreen('openai', '\x1b[1m   \x1b[0m\n').url).toBeNull();
  });
});

describe('nextLoginState', () => {
  const screen = (over: Partial<LoginScreen> = {}): LoginScreen => ({
    url: null,
    code: null,
    needsCode: false,
    exitCode: null,
    error: null,
    ...over,
  });
  const start: LoginSnapshot = { state: 'starting', message: '', codeSubmitted: false };
  const step = (prev: LoginSnapshot, over: Partial<LoginInputs>) =>
    nextLoginState(prev, {
      screen: screen(),
      credentialsChanged: false,
      status: null,
      now: 0,
      deadline: 1000,
      ...over,
    });

  it('waits for the user once a link shows', () => {
    expect(step(start, {}).state).toBe('starting');
    const s = step(start, { screen: screen({ url: 'https://x', needsCode: true }) });
    expect(s.state).toBe('awaiting_user');
    expect(s.message).toMatch(/paste the code/);
    expect(step(start, { screen: screen({ url: 'https://x', code: 'AB12-CD34' }) }).message).toMatch(/enter the code/);
  });

  it('verifies after a submitted code, then signs in on a good status', () => {
    const sent = { ...step(start, { screen: screen({ url: 'https://x' }) }), codeSubmitted: true };
    expect(step(sent, { screen: screen({ url: 'https://x' }) }).state).toBe('verifying');
    expect(step(sent, { screen: screen({ exitCode: 0 }) }).state).toBe('verifying');
    const done = step(sent, { screen: screen({ exitCode: 0 }), status: { loggedIn: true, who: 'me@example.com' } });
    expect(done).toMatchObject({ state: 'signed_in', message: 'Signed in as me@example.com' });
  });

  it('signs in from new credentials while the CLI is still running', () => {
    expect(step(start, { credentialsChanged: true, status: { loggedIn: true } }).state).toBe('signed_in');
  });

  it('fails plainly on a nonzero exit, with the CLI error when there is one', () => {
    expect(step(start, { screen: screen({ exitCode: 1, error: 'OAuth error: Invalid code' }) }).message).toBe(
      'Sign-in failed: OAuth error: Invalid code'
    );
    expect(step({ ...start, codeSubmitted: true }, { screen: screen({ exitCode: 1 }) }).message).toMatch(
      /refused or expired/
    );
    expect(
      step({ ...start, codeSubmitted: true }, { screen: screen({ exitCode: 1, error: 'Login failed: 400' }) }).message
    ).toBe('That code was refused or has expired (Login failed: 400). Try again with a fresh code.');
    expect(step(start, { screen: screen({ exitCode: 130 }) }).message).toMatch(/declined or closed/);
    expect(step(start, { screen: screen({ exitCode: 0 }), status: { loggedIn: false } }).state).toBe('failed');
  });

  it('times out at the deadline and never leaves a terminal state', () => {
    const t = step(start, { now: 1000 });
    expect(t.state).toBe('timeout');
    expect(step(t, { status: { loggedIn: true }, credentialsChanged: true })).toBe(t);
  });
});

/** A fake tmux pane and credential file the test drives. */
function harness(provider: 'anthropic' | 'openai') {
  const calls: string[][] = [];
  const logs: string[] = [];
  const ticks: Array<() => void> = [];
  const state = { screen: '', mtime: null as number | null, now: 1_000, loggedIn: false, alive: true };
  const deps: LoginDeps = {
    tmux: async (args) => {
      calls.push(args);
      if (args[0] === 'capture-pane') {
        if (!state.alive) throw new Error('no pane');
        return state.screen;
      }
      if (args[0] === 'kill-session') state.alive = false;
      if (args[0] === 'new-session') state.alive = true;
      return '';
    },
    command: (p) =>
      p === 'anthropic' ? ['claude', 'auth', 'login', '--claudeai'] : ['codex', 'login', '--device-auth'],
    mtime: async () => state.mtime,
    status: async () => ({ loggedIn: state.loggedIn, ...(state.loggedIn ? { who: 'me@example.com' } : {}) }),
    qr: async (url) => `<svg data-url="${url.length}"></svg>`,
    now: () => state.now,
    setInterval: (fn) => {
      ticks.push(fn);
      return ticks.length;
    },
    clearInterval: () => {},
    log: (l) => logs.push(l),
  };
  const svc = new AccountLoginService(deps);
  const configDir = mkdtempSync(join(tmpdir(), 'login-acct-'));
  const account = { id: `acct-${provider}-x`, label: 'x', provider, configDir };
  return { svc, account, calls, logs, state, tick: () => ticks.at(-1)?.() };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('AccountLoginService', () => {
  it('runs a Claude sign-in: link, pasted code, signed in, pane closed', async () => {
    const h = harness('anthropic');
    const view = await h.svc.start(h.account);
    const create = h.calls.find((c) => c[0] === 'new-session')!;
    expect(create.at(-1)).toContain(`CLAUDE_CONFIG_DIR='${h.account.configDir}'`);
    expect(create.at(-1)).toMatch(/claude.*auth.*login.*--claudeai.*__REVERIE_LOGIN_EXIT=/);
    expect(create.at(-1)).toContain('BROWSER=true');
    expect(view.state).toBe('starting');

    h.state.screen = CLAUDE_SCREEN;
    h.tick();
    await flush();
    let v = h.svc.get(view.id)!;
    expect(v).toMatchObject({ state: 'awaiting_user', url: CLAUDE_URL, needsCode: true });
    expect(v.qrSvg).toContain('<svg');

    await expect(h.svc.submitCode(view.id, 'no')).rejects.toThrow(/does not look like/);
    v = await h.svc.submitCode(view.id, '  abcDEF123#state-xyz  ');
    expect(h.calls).toContainEqual(['send-keys', '-t', expect.stringMatching(/^login-/), '-l', 'abcDEF123#state-xyz']);
    expect(v).toMatchObject({ state: 'verifying', needsCode: false });

    h.state.mtime = 5;
    h.state.loggedIn = true;
    h.state.screen = `${CLAUDE_SCREEN}Login successful.\n__REVERIE_LOGIN_EXIT=0\n`;
    h.tick();
    await flush();
    v = h.svc.get(view.id)!;
    expect(v).toMatchObject({ state: 'signed_in', message: 'Signed in as me@example.com' });
    expect(h.calls.at(-1)?.[0]).toBe('kill-session');
    // State changes only: never the URL, a code or pane text.
    expect(h.logs).toEqual([
      '[AccountLogin] x: starting',
      '[AccountLogin] x: awaiting_user',
      '[AccountLogin] x: code submitted',
      '[AccountLogin] x: verifying',
      '[AccountLogin] x: signed_in',
    ]);
    expect(h.logs.join('\n')).not.toMatch(/abcDEF|https:/);
  });

  it('runs a Codex device sign-in and finishes on the new auth.json', async () => {
    const h = harness('openai');
    const view = await h.svc.start(h.account);
    expect(h.calls.find((c) => c[0] === 'new-session')!.at(-1)).toContain(`CODEX_HOME='${h.account.configDir}'`);
    h.state.screen = CODEX_SCREEN;
    h.tick();
    await flush();
    expect(h.svc.get(view.id)).toMatchObject({ state: 'awaiting_user', code: 'XE1C-NRJKZ', needsCode: false });
    await expect(h.svc.submitCode(view.id, 'abcdefgh1234')).rejects.toThrow(/takes no code/);
    h.state.mtime = 9;
    h.state.loggedIn = true;
    h.tick();
    await flush();
    expect(h.svc.get(view.id)?.state).toBe('signed_in');
  });

  it('times out, and a vanished pane is a failure', async () => {
    const h = harness('openai');
    const a = await h.svc.start(h.account);
    h.state.now += LOGIN_TIMEOUT_MS;
    h.tick();
    await flush();
    expect(h.svc.get(a.id)?.state).toBe('timeout');

    const g = harness('anthropic');
    const b = await g.svc.start(g.account);
    g.state.alive = false;
    g.tick();
    await flush();
    expect(g.svc.get(b.id)?.state).toBe('failed');
  });

  it('restarting an account cancels its running sign-in', async () => {
    const h = harness('anthropic');
    const a = await h.svc.start(h.account);
    const b = await h.svc.start(h.account);
    expect(h.svc.get(a.id)?.state).toBe('cancelled');
    expect(h.svc.get(b.id)?.state).toBe('starting');
    expect(await h.svc.cancel(b.id)).toBe(true);
    expect(h.svc.get(b.id)?.state).toBe('cancelled');
  });
});

describe('sign-in routes', () => {
  it('starts, reads, takes a code and cancels; unknown ids are 404', async () => {
    const h = harness('anthropic');
    const app = Fastify();
    installRouteErrorHandler(app);
    const plans = { account: async (id: string) => (id === h.account.id ? h.account : undefined) };
    registerPlansRoutes(app, plans as unknown as PlanService, h.svc, undefined, trustedFixtureOwner);
    await app.ready();

    expect((await app.inject({ method: 'POST', url: '/api/plans/accounts/nope/login' })).statusCode).toBe(404);
    const started = await app.inject({ method: 'POST', url: `/api/plans/accounts/${h.account.id}/login` });
    expect(started.statusCode).toBe(200);
    const id = started.json().data.id as string;
    expect((await app.inject({ method: 'GET', url: `/api/plans/logins/${id}` })).json().data.state).toBe('starting');
    const bad = await app.inject({ method: 'POST', url: `/api/plans/logins/${id}/code`, payload: { code: 'x y' } });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({
      method: 'POST',
      url: `/api/plans/logins/${id}/code`,
      payload: { code: 'abcdefgh1234' },
    });
    expect(ok.json().data.state).toBe('verifying');
    expect((await app.inject({ method: 'DELETE', url: `/api/plans/logins/${id}` })).json().data.state).toBe(
      'cancelled'
    );
    expect((await app.inject({ method: 'GET', url: '/api/plans/logins/missing' })).statusCode).toBe(404);
    await app.close();
  });
});

describe('unavailable provider CLI', () => {
  it.each([126, 127])('reports startup failure rather than a declined sign-in for exit %i', exitCode => {
    const result = nextLoginState({ state: 'starting', message: '', codeSubmitted: false }, {
      screen: { url: null, code: null, needsCode: false, exitCode, error: null },
      credentialsChanged: false, status: null, now: 0, deadline: 1000,
    });
    expect(result.state).toBe('failed');
    expect(result.message).toContain('CLI is missing or not executable');
    expect(result.message).not.toContain('declined');
  });
  it('detects a missing Claude executable before a pane or credential directory is created', async () => {
    const deps = defaultLoginDeps({ socket: 'unused-login-test', claudeBinary: '/nonexistent/reverie-test-claude', codexBinary: null, path: process.env.PATH || '' });
    const service = new AccountLoginService(deps);
    await expect(service.start({ id: 'missing', label: 'Missing CLI', provider: 'anthropic', configDir: '/nonexistent/reverie-test-account' })).rejects.toMatchObject({ status: 503, message: expect.stringContaining('Claude sign-in could not start') });
  });
});
