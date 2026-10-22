/**
 * @fileoverview Owner sign-in: TOTP vectors, the password / two-step / remembered-device flows,
 * retry protection, sessions, the host admin functions and the owner/agent route policy.
 * Synthetic fixtures only. Port: N/A (app.inject()).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { base32Decode, base32Encode, hotp, matchTotp, newRecoveryCodes, totpStep } from '../src/owner-auth/crypto.js';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import {
  OwnerAuthService,
  afterFailure,
  nextAttemptAt,
  passwordProblem,
  LOCKOUT_MS,
  SESSION_IDLE_MS,
  SESSION_MAX_MS,
} from '../src/owner-auth/service.js';
import { registerOwnerRoutes } from '../src/owner-auth/routes.js';
import {
  registerOwnerPolicy,
  classify,
  OWNER_COOKIE,
  DEVICE_COOKIE,
  SERVICE_HEADER,
} from '../src/owner-auth/policy.js';
import * as admin from '../src/owner-auth/admin.js';
import type { SessionPort } from '../src/web/ports/session-port.js';

const USER = 'owner-test';
const NEW_PASSWORD = 'synthetic-correct-horse-42';
const AGENT = '0000002d-0035-4000-8000-000000000047';

describe('TOTP primitives', () => {
  it('matches the RFC 6238 SHA-1 test vectors', () => {
    const secret = Buffer.from('12345678901234567890');
    for (const [time, code] of [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
    ] as Array<[number, string]>) {
      expect(hotp(secret, Math.floor(time / 30), 8)).toBe(code);
    }
  });

  it('round-trips base32 and accepts only ±1 step', () => {
    const key = base32Encode(Buffer.from('12345678901234567890'));
    expect(base32Decode(key).toString()).toBe('12345678901234567890');
    const now = 1_700_000_000_000;
    const at = (delta: number) => hotp(base32Decode(key), totpStep(now) + delta);
    expect(matchTotp(key, at(0), now)).toBe(totpStep(now));
    expect(matchTotp(key, at(-1), now)).toBe(totpStep(now) - 1);
    expect(matchTotp(key, at(1), now)).toBe(totpStep(now) + 1);
    expect(matchTotp(key, at(2), now)).toBeUndefined();
    expect(matchTotp(key, '12345', now)).toBeUndefined();
  });

  it('makes ten distinct recovery codes', () => {
    const codes = newRecoveryCodes();
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
  });
});

describe('backoff and lockout rules', () => {
  it('allows three free attempts, then doubles the wait, then locks for 15 min and escalates', () => {
    let state = { failures: 0, lastFailureAt: 0, lockedUntil: 0 } as Parameters<typeof afterFailure>[0];
    const t = 1_000_000;
    for (let i = 0; i < 3; i++) state = afterFailure(state, t);
    expect(nextAttemptAt(state)).toBe(t + 1000);
    state = afterFailure(state, t);
    expect(nextAttemptAt(state)).toBe(t + 2000);
    for (let i = 0; i < 6; i++) state = afterFailure(state, t);
    expect(state.lockedUntil).toBe(t + LOCKOUT_MS);
    for (let i = 0; i < 10; i++) state = afterFailure(state, t + LOCKOUT_MS + 1);
    expect(state.lockedUntil).toBe(t + LOCKOUT_MS + 1 + 2 * LOCKOUT_MS); // the second lockout doubles
  });
});

describe('owner sign-in', () => {
  let dir: string;
  let store: OwnerAuthStore;
  let service: OwnerAuthService;
  let app: FastifyInstance;
  let clock: number;
  let oneTime: string;
  const sessions = new Map<string, unknown>([[AGENT, { id: AGENT, owner: undefined }]]);

  async function build(policy?: 'off' | 'log' | 'enforce') {
    if (policy) await admin.setPolicy(store, policy, { forceLockoutRisk: true }); // setup: the lockout guard has its own tests
    service = new OwnerAuthService({ store, auditFile: join(dir, 'audit.jsonl'), now: () => clock });
    app = Fastify();
    await app.register(fastifyCookie);
    registerOwnerPolicy(app, {
      service,
      ctx: { sessions } as unknown as SessionPort,
      isCapabilityRequest: (req) => (req.url ?? '').startsWith('/q/'),
      relations: {
        known: () => true,
        related: (caller, target) => caller === target,
        upward: () => false,
        keeper: () => false,
        admin: () => false,
      },
      now: () => clock,
    });
    registerOwnerRoutes(app, service, false);
    app.get('/api/sessions', async () => ({ success: true, data: 'list' }));
    app.put('/api/settings', async () => ({ success: true, data: 'changed' }));
    app.put('/api/company/employees/:id/session', async () => ({ success: true, data: 'bound' }));
    app.get('/', async () => 'app');
    app.get('/app.js', async () => 'js');
    app.get('/q/:token', async () => 'qr');
    await app.ready();
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'owner-auth-'));
    store = new OwnerAuthStore(join(dir, 'owner-auth.json'));
    clock = 1_700_000_000_000;
    oneTime = (await admin.bootstrap(store, USER, { now: clock })).oneTimePassword;
    await build();
  });
  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  const cookie = (res: { cookies: Array<{ name: string; value: string }> }, name = OWNER_COOKIE) =>
    res.cookies.find((c) => c.name === name)?.value;
  const login = (password: string, extra: Record<string, string> = {}, username = USER) =>
    app.inject({ method: 'POST', url: '/api/owner/login', payload: { username, password }, cookies: extra });
  const as = (session?: string, device?: string) => ({
    ...(session ? { [OWNER_COOKIE]: session } : {}),
    ...(device ? { [DEVICE_COOKIE]: device } : {}),
  });
  async function signedIn(): Promise<string> {
    const first = await login(oneTime);
    const changed = await app.inject({
      method: 'POST',
      url: '/api/owner/password',
      payload: { current: oneTime, next: NEW_PASSWORD },
      cookies: as(cookie(first)),
    });
    expect(changed.statusCode).toBe(200);
    return cookie(changed)!;
  }
  const code = (secret: string, delta = 0) => hotp(base32Decode(secret), totpStep(clock) + delta);
  async function enrol(session: string): Promise<{ secret: string; recovery: string[] }> {
    const start = await app.inject({ method: 'POST', url: '/api/owner/2fa/start', cookies: as(session) });
    const { secret, qr } = start.json().data;
    expect(qr).toContain('<svg');
    const confirm = await app.inject({
      method: 'POST',
      url: '/api/owner/2fa/confirm',
      payload: { code: code(secret) },
      cookies: as(session),
    });
    expect(confirm.statusCode).toBe(200);
    clock += 30_000; // the enrolment code's step is used
    return { secret, recovery: confirm.json().data.recoveryCodes };
  }

  it('bootstraps with a one-time password that forces a change, then signs in normally', async () => {
    expect(((await stat(store.file)).mode & 0o777).toString(8)).toBe('600');
    const first = await login(oneTime);
    expect(first.json().data.next).toBe('change-password');
    const restricted = cookie(first)!;
    expect((await app.inject({ method: 'GET', url: '/api/owner/devices', cookies: as(restricted) })).statusCode).toBe(
      403
    );
    const short = await app.inject({
      method: 'POST',
      url: '/api/owner/password',
      payload: { current: oneTime, next: 'short' },
      cookies: as(restricted),
    });
    expect(short.statusCode).toBe(400);
    const named = await app.inject({
      method: 'POST',
      url: '/api/owner/password',
      payload: { current: oneTime, next: `xx-${USER}-xx-yy` },
      cookies: as(restricted),
    });
    expect(named.statusCode).toBe(400);
    const changed = await app.inject({
      method: 'POST',
      url: '/api/owner/password',
      payload: { current: oneTime, next: NEW_PASSWORD },
      cookies: as(restricted),
    });
    expect(changed.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/owner/devices', cookies: as(restricted) })).statusCode).toBe(
      401
    ); // older epoch
    expect(
      (await app.inject({ method: 'GET', url: '/api/owner/devices', cookies: as(cookie(changed)) })).statusCode
    ).toBe(200);
    expect((await login(oneTime)).statusCode).toBe(401);
    expect((await login(NEW_PASSWORD)).json().data.next).toBe('done');
  });

  it('chooses a normalized login username atomically with the first permanent password', async () => {
    const first = cookie(await login(oneTime))!;
    const changed = await app.inject({
      method: 'POST',
      url: '/api/owner/password',
      cookies: as(first),
      payload: { current: oneTime, next: NEW_PASSWORD, username: '  New_Login-7  ' },
    });
    expect(changed.statusCode).toBe(200);
    expect(store.read()!.username).toBe('new_login-7');
    expect(store.read()!.mustChange).toBe(false);
    expect(service.session(first)).toBeUndefined();
    expect((await app.inject({ url: '/api/owner/status', cookies: as(cookie(changed)) })).json().data.username).toBe(
      'new_login-7'
    );
    expect((await login(NEW_PASSWORD, {}, USER)).statusCode).toBe(401);
    expect((await login(NEW_PASSWORD, {}, 'new_login-7')).json().data.next).toBe('done');
  });

  it('rejects invalid login usernames without changing any account data or password', async () => {
    const restricted = cookie(await login(oneTime))!;
    const before = structuredClone(store.read());
    for (const username of ['', 'a', '_leading', 'has space', 'bad/name', 'x'.repeat(33), null, 123]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/owner/password',
        cookies: as(restricted),
        payload: { current: oneTime, next: NEW_PASSWORD, username },
      });
      expect(response.statusCode, String(username)).toBe(400);
      expect(store.read()).toEqual(before);
    }
    expect((await login(oneTime)).json().data.next).toBe('change-password');
  });

  it('username changes still require current password and configured two-factor proof', async () => {
    const session = await signedIn();
    const { secret } = await enrol(session);
    const before = structuredClone(store.read());
    const payload = { current: NEW_PASSWORD, next: 'another-strong-synthetic-72', username: 'new-account' };
    const noCode = await app.inject({ method: 'POST', url: '/api/owner/password', cookies: as(session), payload });
    expect(noCode.statusCode).toBe(400);
    expect(store.read()).toEqual(before);
    const ok = await app.inject({
      method: 'POST',
      url: '/api/owner/password',
      cookies: as(session),
      payload: { ...payload, code: code(secret) },
    });
    expect(ok.statusCode).toBe(200);
    expect(store.read()!.username).toBe('new-account');
    expect(store.read()!.totp).toEqual(expect.objectContaining({ secret: before!.totp!.secret }));
    expect(service.session(session)).toBeUndefined();
    expect((await login(payload.next, {}, 'new-account')).json().data.next).toBe('second-factor');
  });

  it('rejects weak new passwords with a reason', async () => {
    const restricted = cookie(await login(oneTime))!;
    for (const weak of ['0000002d0000002d', 'Password1234!xyz', 'qwerty-Workspace-77', 'abab-abab-abab']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/owner/password',
        payload: { current: oneTime, next: weak },
        cookies: as(restricted),
      });
      expect(res.statusCode, weak).toBe(400);
    }
    expect(passwordProblem('correct horse battery staple', USER)).toBeUndefined();
    expect(passwordProblem(NEW_PASSWORD, USER)).toBeUndefined();
  });

  it('settings change: needs the current password and, with two-step on, a code; ends other sessions and devices only', async () => {
    const session = await signedIn();
    const { secret } = await enrol(session);
    const signIn = async (remember: boolean, label: string) => {
      const challenge = (await login(NEW_PASSWORD)).json().data.challenge;
      const res = await app.inject({
        method: 'POST',
        url: '/api/owner/login/second-factor',
        payload: { challenge, code: code(secret), remember, label },
      });
      clock += 30_000;
      return { session: cookie(res)!, device: cookie(res, DEVICE_COOKIE) };
    };
    const here = await signIn(true, 'This phone');
    const other = await signIn(true, 'Old laptop');
    const change = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/api/owner/password', payload, cookies: as(here.session, here.device) });
    const next = 'another synthetic passphrase 9';
    expect((await change({ current: NEW_PASSWORD, next })).statusCode).toBe(400); // code required
    expect((await change({ current: NEW_PASSWORD, next, code: '000000' })).statusCode).toBe(401);
    expect((await change({ current: 'wrong-current', next, code: code(secret) })).statusCode).toBe(401);
    clock += 10_000; // past the backoff from the two failures above
    const ok = await change({ current: NEW_PASSWORD, next, code: code(secret) });
    expect(ok.statusCode).toBe(200);
    const status = (c: string) =>
      app.inject({ method: 'GET', url: '/api/owner/status', cookies: as(c) }).then((r) => r.json().data);
    expect((await status(cookie(ok)!)).signedIn).toBe(true); // this browser stays signed in
    expect((await status(other.session)).signedIn).toBe(false);
    expect((await status(session)).signedIn).toBe(false);
    expect((await status(cookie(ok)!)).devices.map((d: { label: string }) => d.label)).toEqual(['This phone']);
    expect((await login(next, as(undefined, other.device))).json().data.next).toBe('second-factor'); // forgotten device
    expect((await login(next, as(undefined, here.device))).json().data.next).toBe('done'); // kept device
  });

  it('sets HttpOnly SameSite=Strict cookies, Secure except on a loopback host', async () => {
    const plain = (await login(oneTime)).cookies.find((c) => c.name === OWNER_COOKIE)!;
    expect(plain).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/' });
    expect(plain.secure).toBeFalsy();
    const tls = await app.inject({
      method: 'POST',
      url: '/api/owner/login',
      payload: { username: USER, password: oneTime },
      headers: { host: 'console.example.ts.net' }, // any non-loopback host: Secure
    });
    expect(tls.cookies.find((c) => c.name === OWNER_COOKIE)!.secure).toBe(true);
  });

  it('backs off, locks out, unlocks in time, and the lockout survives a restart', async () => {
    await store.update((acc) => {
      delete acc.oneTimeExpiresAt; // this test runs longer than the one-time password lives
    });
    for (let i = 0; i < 3; i++) expect((await login('wrong-password-' + i)).statusCode).toBe(401);
    const early = await login('wrong-password-x');
    expect(early.statusCode).toBe(429);
    expect(early.headers['retry-after']).toBe('1');
    expect((await login(oneTime)).statusCode).toBe(429); // even the right password waits
    expect((await login('anything', {}, 'not-the-owner')).statusCode).toBe(429); // the per-IP bucket too
    for (let i = 0; i < 7; i++) {
      clock += 6 * 60 * 1000;
      await login('wrong-password-again');
    }
    const locked = await login(oneTime);
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error).toContain('Too many');
    await app.close();
    await build(); // a restart: the account lockout is on disk
    clock += 60 * 1000;
    expect((await login(oneTime)).statusCode).toBe(429);
    clock += LOCKOUT_MS;
    expect((await login(oneTime)).statusCode).toBe(200);
    expect(store.read()!.throttles?.['src:loopback']).toBeUndefined();
  });

  it('a wrong username counts like a wrong password and gets the same answer', async () => {
    const bad = await login(oneTime, {}, 'someone-else');
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error).toBe((await login('wrong-password')).json().error);
    expect(store.read()!.throttles?.['src:loopback']?.failures).toBe(2);
  });

  it('two-step: enrol by first code, then require a fresh code; a code is never accepted twice', async () => {
    const session = await signedIn();
    const { secret, recovery } = await enrol(session);
    expect(recovery).toHaveLength(10);
    const first = await login(NEW_PASSWORD);
    expect(first.json().data).toMatchObject({ next: 'second-factor' });
    expect(cookie(first)).toBeUndefined(); // no session before the second step
    const challenge = first.json().data.challenge;
    const second = (payload: Record<string, unknown>, c = challenge) =>
      app.inject({ method: 'POST', url: '/api/owner/login/second-factor', payload: { challenge: c, ...payload } });
    expect((await second({ code: '000000' })).statusCode).toBe(401);
    const good = code(secret);
    const ok = await second({ code: good });
    expect(ok.statusCode).toBe(200);
    expect(cookie(ok)).toBeDefined();
    const again = (await login(NEW_PASSWORD)).json().data.challenge;
    expect((await second({ code: good }, again)).statusCode).toBe(401); // same step: reuse refused
    clock += 30_000;
    expect((await second({ code: code(secret) }, again)).statusCode).toBe(200);
  });

  it('a recovery code works once', async () => {
    const session = await signedIn();
    const { recovery } = await enrol(session);
    const challenge = () => login(NEW_PASSWORD).then((r) => r.json().data.challenge);
    const use = async (c: string) =>
      app.inject({
        method: 'POST',
        url: '/api/owner/login/second-factor',
        payload: { challenge: await challenge(), recoveryCode: c },
      });
    expect((await use(recovery[0].toUpperCase())).statusCode).toBe(200);
    clock += 10_000;
    expect((await use(recovery[0])).statusCode).toBe(401);
    const status = await app.inject({ method: 'GET', url: '/api/owner/status', cookies: as(session) });
    expect(status.json().data.recoveryCodesLeft).toBe(9);
  });

  it('a remembered device skips only the second step, is revocable, and ends with log-out-everywhere', async () => {
    const session = await signedIn();
    const { secret } = await enrol(session);
    const challenge = (await login(NEW_PASSWORD)).json().data.challenge;
    const remembered = await app.inject({
      method: 'POST',
      url: '/api/owner/login/second-factor',
      payload: { challenge, code: code(secret), remember: true, label: 'Test phone' },
    });
    const device = remembered.cookies.find((c) => c.name === DEVICE_COOKIE)!;
    expect(device).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/api/owner' });
    expect(device.maxAge).toBe(30 * 24 * 60 * 60);
    expect((await login(NEW_PASSWORD, as(undefined, device.value))).json().data.next).toBe('done');
    expect((await login('wrong-password', as(undefined, device.value))).statusCode).toBe(401); // the password still counts
    const list = await app.inject({ method: 'GET', url: '/api/owner/devices', cookies: as(session) });
    expect(list.json().data.devices).toEqual([expect.objectContaining({ label: 'Test phone' })]);
    expect(JSON.stringify(list.json())).not.toContain('hash');
    await app.inject({ method: 'POST', url: '/api/owner/logout-everywhere', cookies: as(session) });
    expect((await login(NEW_PASSWORD, as(undefined, device.value))).json().data.next).toBe('second-factor');
    expect(
      (await app.inject({ method: 'GET', url: '/api/owner/status', cookies: as(session) })).json().data.signedIn
    ).toBe(false);
  });

  it('sessions end after the idle timeout and at the absolute expiry', async () => {
    const session = await signedIn();
    const probe = () =>
      app.inject({ method: 'GET', url: '/api/owner/status', cookies: as(session) }).then((r) => r.json().data.signedIn);
    clock += SESSION_IDLE_MS - 1000;
    expect(await probe()).toBe(true); // activity slides the idle window
    for (let t = 0; t < SESSION_MAX_MS; t += SESSION_IDLE_MS - 1000) {
      clock += SESSION_IDLE_MS - 1000;
      if (!(await probe())) break;
    }
    expect(await probe()).toBe(false);
    const idle = cookie(await login(NEW_PASSWORD))!;
    clock += SESSION_IDLE_MS + 1;
    expect(
      (await app.inject({ method: 'GET', url: '/api/owner/status', cookies: as(idle) })).json().data.signedIn
    ).toBe(false);
  });

  it('never writes a password, code or token to the audit log', async () => {
    const session = await signedIn();
    const { secret, recovery } = await enrol(session);
    await login('wrong-password-zzz');
    const challenge = (await login(NEW_PASSWORD)).json().data.challenge;
    await app.inject({
      method: 'POST',
      url: '/api/owner/login/second-factor',
      payload: { challenge, code: code(secret) },
    });
    const audit = await readFile(join(dir, 'audit.jsonl'), 'utf8');
    expect(audit).toContain('login_failed');
    for (const secretText of [
      oneTime,
      NEW_PASSWORD,
      'wrong-password-zzz',
      secret,
      recovery[0],
      session,
      code(secret),
    ]) {
      expect(audit).not.toContain(secretText);
    }
    expect(((await stat(join(dir, 'audit.jsonl'))).mode & 0o777).toString(8)).toBe('600');
  });

  describe('route policy', () => {
    const call = (
      method: 'GET' | 'PUT',
      url: string,
      opts: { cookies?: Record<string, string>; headers?: Record<string, string> } = {}
    ) => app.inject({ method, url, ...opts, headers: { origin: 'http://localhost:80', ...(opts.headers ?? {}) } });

    it('classifies agent, service, owner and public routes', () => {
      expect(classify('GET', '/api/sessions', '/api/sessions')).toBe('agent');
      expect(classify('POST', '/api/chatrooms/:id/messages', '/api/chatrooms/x/messages')).toBe('agent');
      expect(classify('PUT', '/api/company/employees/:id/session', '/x')).toBe('service');
      expect(classify('PUT', '/api/settings', '/api/settings')).toBe('owner');
      expect(classify('GET', undefined, '/api/not-a-route')).toBe('owner');
      expect(classify('GET', '/owner/login', '/owner/login')).toBe('public');
      expect(classify('GET', undefined, '/app.js')).toBe('public');
    });

    it('off changes nothing', async () => {
      await app.close();
      await build('off');
      expect((await call('PUT', '/api/settings')).statusCode).toBe(200);
    });

    it('log lets everything through and records each would-be refusal once an hour', async () => {
      await app.close();
      await build('log');
      for (let i = 0; i < 3; i++) expect((await call('PUT', '/api/settings')).statusCode).toBe(200);
      await new Promise((r) => setTimeout(r, 20));
      const audit = await readFile(join(dir, 'audit.jsonl'), 'utf8');
      expect(audit.match(/policy_would_deny/g)).toHaveLength(1);
    });

    it('enforce: owner cookie for owner routes; agents only on agent routes; 401 anonymous; sign-in page', async () => {
      await signedIn();
      await app.close();
      await build('enforce'); // sessions live in memory: a restart signs the owner out
      const session = cookie(await login(NEW_PASSWORD))!;
      const agent = { headers: { 'x-reverie-parent-session': AGENT } };
      expect((await call('PUT', '/api/settings')).statusCode).toBe(401);
      expect((await call('PUT', '/api/settings', agent)).statusCode).toBe(403); // header-only owner call
      expect((await call('GET', '/api/sessions', agent)).statusCode).toBe(200); // the agent CLI still works
      expect((await call('GET', '/api/sessions')).statusCode).toBe(401);
      expect(
        (await call('GET', '/api/sessions', { headers: { 'x-reverie-parent-session': 'bogus' } })).statusCode
      ).toBe(403);
      expect((await call('PUT', '/api/settings', { cookies: as(session) })).statusCode).toBe(200);
      const page = await call('GET', '/');
      expect(page.statusCode).toBe(302);
      expect(page.headers.location).toBe('/owner/login?next=%2F');
      expect((await call('GET', '/', { cookies: as(session) })).statusCode).toBe(200);
      expect((await call('GET', '/app.js')).statusCode).toBe(200);
      expect((await call('GET', '/q/abc')).statusCode).toBe(200);
      expect((await call('GET', '/owner/login')).statusCode).toBe(200);
    });

    it('enforce: a service token reaches agent and service routes only', async () => {
      const token = await admin.issueServiceToken(store, 'watcher');
      await app.close();
      await build('enforce');
      const svc = { headers: { [SERVICE_HEADER]: token } };
      expect((await call('PUT', '/api/company/employees/e1/session', svc)).statusCode).toBe(200);
      expect((await call('GET', '/api/sessions', svc)).statusCode).toBe(200);
      expect((await call('PUT', '/api/settings', svc)).statusCode).toBe(403);
      await admin.revokeServiceToken(store, 'watcher');
      expect((await call('GET', '/api/sessions', svc)).statusCode).toBe(401);
    });

    it('enforce: a one-time-password session reaches only the password change', async () => {
      await app.close();
      await build('enforce');
      const restricted = cookie(await login(oneTime))!;
      const blocked = await call('PUT', '/api/settings', { cookies: as(restricted) });
      expect(blocked.statusCode).toBe(403);
      expect(blocked.json().errorCode).toBe('PASSWORD_CHANGE_REQUIRED');
      const changed = await app.inject({
        method: 'POST',
        url: '/api/owner/password',
        payload: { current: oneTime, next: NEW_PASSWORD },
        cookies: as(restricted),
        headers: { origin: 'http://localhost:80' },
      });
      expect(changed.statusCode).toBe(200);
      expect((await call('PUT', '/api/settings', { cookies: as(cookie(changed)) })).statusCode).toBe(200);
    });

    it('enforce never blocks agents during an owner lockout', async () => {
      await app.close();
      await build('enforce');
      for (let i = 0; i < 12; i++) {
        clock += 6 * 60 * 1000;
        await login('wrong-password');
      }
      expect(store.read()!.throttles?.['src:loopback']?.lockedUntil).toBeGreaterThan(clock);
      expect((await call('GET', '/api/sessions', { headers: { 'x-reverie-parent-session': AGENT } })).statusCode).toBe(
        200
      );
    });
  });

  describe('host administration', () => {
    it('refuses a second bootstrap without --force, and reset-password forces a change and ends sessions', async () => {
      await expect(admin.bootstrap(store, USER)).rejects.toThrow('exists');
      await expect(admin.bootstrap(store, 'Not Valid!')).rejects.toThrow();
      const session = await signedIn();
      const fresh = await admin.resetPassword(store, clock);
      expect(fresh).not.toBe(oneTime);
      expect(
        (await app.inject({ method: 'GET', url: '/api/owner/status', cookies: as(session) })).json().data.signedIn
      ).toBe(false);
      expect((await login(fresh)).json().data.next).toBe('change-password');
    });

    it('reset-2fa removes two-step, recovery codes and devices; unlock clears a lockout; status shows no secrets', async () => {
      const session = await signedIn();
      await enrol(session);
      await admin.resetTwoFactor(store);
      expect((await login(NEW_PASSWORD)).json().data.next).toBe('done');
      await store.update((a) => {
        a.throttles = {
          'src:loopback': { failures: 0, lastFailureAt: clock, lockedUntil: clock + LOCKOUT_MS, lockouts: 1 },
        };
      });
      await admin.unlock(store);
      expect((await login(NEW_PASSWORD)).statusCode).toBe(200);
      const described = JSON.stringify(admin.describe(store, clock));
      expect(described).not.toContain('hash');
      expect(described).not.toContain('secret');
      expect(admin.describe(store, clock)).toMatchObject({ configured: true, username: USER, twoFactor: false });
    });
  });
});
