/**
 * @fileoverview Owner authentication: password (scrypt) + optional TOTP or recovery code, sessions,
 * remembered devices, retry protection and an audit log.
 *
 * Sessions live in memory only (a console restart logs the owner out). A password change or "log
 * out everywhere" bumps the account epoch, which invalidates every older session, and the live
 * WebSocket/event-stream connections of an ended session are closed.
 *
 * Retry protection is per SOURCE, never account-wide, so no caller can lock the owner out
 * everywhere: each bucket allows three free attempts, then an exponential delay (1 s doubling, at
 * most 5 min), then a lockout after 10 failures (15 min, doubling per further lockout, at most
 * 24 h; the doubling resets after a success or a day without failures). Buckets: the network
 * source (every loopback address counts as one source), a valid remembered device (its own bucket,
 * so a device keeps signing in while its network source is locked), and an owner session (for the
 * settings that re-check the password or a code). At most one attempt per bucket and two
 * password verifications in total run at once; more are refused with 429, so a burst can neither
 * skip the counting nor saturate the thread pool.
 *
 * The audit log (`<data>/owner-auth-audit.jsonl`, 0600) records outcomes, never a password, code
 * or token.
 */
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import { hashPassword, verifyPasswordHash, normalizeUsername, isValidUsername } from '../user-store.js';
import type { PasswordHash } from '../types.js';
import {
  matchTotp,
  newRecoveryCodes,
  newTotpSecret,
  normalizeRecoveryCode,
  otpauthUrl,
  randomToken,
  safeEqualText,
  sha256,
} from './crypto.js';
import type { OwnerAccount, OwnerAuthStore, OwnerPolicy, Throttle } from './store.js';

export const OWNER_SCRYPT_PARAMS = { N: 32768, r: 8, p: 1 } as const;
export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
export const SESSION_MAX_MS = 7 * 24 * 60 * 60 * 1000;
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const ONE_TIME_TTL_MS = 30 * 60 * 1000;
export const PENDING_TOTP_TTL_MS = 10 * 60 * 1000;
export const FREE_ATTEMPTS = 3;
export const MAX_DELAY_MS = 5 * 60 * 1000;
export const LOCKOUT_AFTER = 10;
export const LOCKOUT_MS = 15 * 60 * 1000;
export const MAX_LOCKOUT_MS = 24 * 60 * 60 * 1000;
/** A bucket with no failure for this long starts over, escalation included. */
export const DECAY_MS = 24 * 60 * 60 * 1000;
export const MAX_BUCKETS = 200;
export const MAX_CONCURRENT_VERIFICATIONS = 2;
export const MIN_PASSWORD = 12;

const WEAK_PARTS = ['password', 'passw0rd', 'qwerty', 'letmein', 'iloveyou', '123456', '111111', 'abc123'];

/**
 * Why a new password is too weak, or undefined. At least 12 characters, at least 6 different
 * characters, an estimated 50+ bits for its character pools, no common weak fragment, and not the
 * username. (A long passphrase of plain words passes; "aaaaaaaaaaaa" and "Password1234!" do not.)
 */
export function passwordProblem(password: string, username: string): string | undefined {
  if (password.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters`;
  if (password.length > 1024) return 'That password is too long';
  const lower = password.toLowerCase();
  if (username && lower.includes(username.toLowerCase())) return 'The password must not contain the username';
  if (new Set(password).size < 6) return 'Use more different characters';
  if (WEAK_PARTS.some((part) => lower.includes(part))) return 'That password contains a very common pattern';
  let pool = 0;
  if (/[a-z]/.test(password)) pool += 26;
  if (/[A-Z]/.test(password)) pool += 26;
  if (/[0-9]/.test(password)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(password)) pool += 33;
  if (password.length * Math.log2(pool) < 50) return 'That password is too easy to guess; make it longer';
  return undefined;
}

export class OwnerAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterSeconds?: number
  ) {
    super(message);
  }
}

/** The retry bucket of a network source: every loopback address is one source. */
export function sourceOf(ip: string): string {
  const address = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (address === '::1' || /^127\./.test(address)) return 'src:loopback';
  return `src:${address}`;
}

const EMPTY: Throttle = { failures: 0, lastFailureAt: 0, lockedUntil: 0, lockouts: 0 };

/** When the next attempt may be checked, under the backoff and lockout rules (0 = now). */
export function nextAttemptAt(state: Throttle): number {
  if (state.lockedUntil) return state.lockedUntil;
  if (state.failures < FREE_ATTEMPTS) return 0;
  return state.lastFailureAt + Math.min(1000 * 2 ** (state.failures - FREE_ATTEMPTS), MAX_DELAY_MS);
}

/** An expired lockout is cleared; a bucket quiet for DECAY_MS starts over, escalation included. */
export function current(state: Throttle | undefined, now: number): Throttle {
  if (!state) return EMPTY;
  if (!state.lockedUntil && state.lastFailureAt && now - state.lastFailureAt >= DECAY_MS) return EMPTY;
  if (state.lockedUntil && now >= state.lockedUntil) {
    return now - state.lockedUntil >= DECAY_MS ? EMPTY : { ...state, lockedUntil: 0, failures: 0 };
  }
  return state;
}

/** The state after one more failure at `now`. */
export function afterFailure(state: Throttle | undefined, now: number): Throttle {
  const base = current(state, now);
  const failures = base.failures + 1;
  if (failures >= LOCKOUT_AFTER) {
    const lockouts = (base.lockouts ?? 0) + 1;
    return {
      failures: 0,
      lastFailureAt: now,
      lockedUntil: now + Math.min(LOCKOUT_MS * 2 ** (lockouts - 1), MAX_LOCKOUT_MS),
      lockouts,
    };
  }
  return { failures, lastFailureAt: now, lockedUntil: 0, lockouts: base.lockouts ?? 0 };
}

interface Session {
  createdAt: number;
  lastSeenAt: number;
  epoch: number;
  /** A one-time password is in use: only the password change (and logout/status) may be used. */
  restricted: boolean;
}

export interface LoginResult {
  next: 'done' | 'change-password' | 'second-factor';
  session?: string;
  challenge?: string;
  device?: string;
}

export interface OwnerAuthDeps {
  setupEnabled?: boolean;
  store: OwnerAuthStore;
  auditFile: string;
  now?: () => number;
}

export interface HumanIdentity {
  id: string;
  username: string;
  name: string;
  role: 'owner' | 'limited';
  primary: boolean;
  avatar?: string;
}

export interface OwnerSession {
  restricted: boolean;
  role?: 'owner' | 'limited';
}

export class OwnerAuthService {
  private readonly sessions = new Map<string, Session>();
  private readonly challenges = new Map<string, { expiresAt: number; epoch: number; bucket: string }>();
  private readonly busy = new Set<string>();
  private verifying = 0;
  private setupBusy = false;
  private readonly setupSources = new Map<string, { at: number; count: number }>();
  private readonly connections = new Map<string, Set<Socket>>();
  /** The last account read successfully: kept when the file later goes missing or corrupt. */
  private lastGood: OwnerAccount | undefined;
  private warned = { missing: false, corrupt: false };
  private markerSynced: OwnerPolicy | undefined;
  /** A wrong username costs the same as a wrong password. */
  private dummyHash: Promise<PasswordHash> | undefined;

  constructor(private readonly deps: OwnerAuthDeps) {}

  /** Account-local authentication operations; shared-office accounts override this resolver. */
  forSession(_token: string | undefined): OwnerAuthService { return this; }

  identity(token: string | undefined): HumanIdentity | undefined {
    if (!this.session(token)) return undefined;
    const account = this.account();
    return account ? { id: 'owner', username: account.username, name: account.username, role: 'owner', primary: true } : undefined;
  }

  setupAvailable(): boolean {
    return (
      (this.deps.setupEnabled ?? process.env.REVERIE_OWNER_SETUP === '1') &&
      !this.lastGood &&
      this.deps.store.isUnclaimed()
    );
  }

  /** Claim only a pristine installation, with a permanent password and enforce policy from its first write. */
  async setup(username: string, password: string, confirmation: string, ip: string): Promise<string> {
    if (!this.setupAvailable())
      throw new OwnerAuthError('Account setup is unavailable; sign in or use host recovery', 409);
    const now = this.now();
    for (const [source, state] of this.setupSources) if (now - state.at >= 60_000) this.setupSources.delete(source);
    const attempt = this.setupSources.get(ip) ?? { at: now, count: 0 };
    if (this.setupBusy || attempt.count >= 5 || (!this.setupSources.has(ip) && this.setupSources.size >= 500))
      throw new OwnerAuthError('Too many setup attempts; try again shortly', 429, 60);
    attempt.count++;
    this.setupSources.set(ip, attempt);
    if (typeof username !== 'string' || !isValidUsername(username))
      throw new OwnerAuthError('Usernames are 2-32 of a-z 0-9 _ - and start alphanumeric', 400);
    const name = normalizeUsername(username);
    if (typeof password !== 'string' || typeof confirmation !== 'string' || password !== confirmation)
      throw new OwnerAuthError('The two passwords must match', 400);
    const problem = passwordProblem(password, name);
    if (problem) throw new OwnerAuthError(problem, 400);
    this.setupBusy = true;
    try {
      const account: OwnerAccount = {
        version: 1,
        username: name,
        password: await hashPassword(password, OWNER_SCRYPT_PARAMS),
        mustChange: false,
        passwordChangedAt: now,
        recovery: [],
        devices: [],
        services: [],
        throttles: {},
        keepers: [],
        admins: [],
        epoch: 1,
        policy: 'enforce',
      };
      if (!(await this.deps.store.claim(account)))
        throw new OwnerAuthError('This installation has already been claimed', 409);
      this.lastGood = account;
      await this.audit('owner_setup', { ip });
      return this.newSession(account);
    } finally {
      this.setupBusy = false;
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Owner-set keepers (see `relations.ts`); the last good copy while the file is damaged. */
  keepers(): readonly string[] {
    return this.account()?.keepers ?? [];
  }

  /** Owner-set admins (see `relations.ts`); the last good copy while the file is damaged. */
  admins(): readonly string[] {
    return this.account()?.admins ?? [];
  }

  get store(): OwnerAuthStore {
    return this.deps.store;
  }

  /**
   * The account. A corrupt file falls back to the last good copy (or, never having read one, counts
   * as "an account exists, policy enforce"); both are audited once.
   */
  account(): OwnerAccount | undefined {
    try {
      const account = this.deps.store.read();
      if (account) {
        this.lastGood = account;
        this.warned = { missing: false, corrupt: false };
        // An account written before the marker existed: record its policy once.
        if (this.markerSynced !== account.policy) {
          this.markerSynced = account.policy;
          if (this.deps.store.readMarker() !== account.policy)
            void this.deps.store.writeMarker(account.policy).catch(() => {});
        }
      }
      return account;
    } catch {
      if (!this.warned.corrupt) {
        this.warned.corrupt = true;
        void this.audit('account_file_corrupt', { fallback: this.lastGood ? 'last_good' : 'enforce' });
      }
      return this.lastGood;
    }
  }

  /**
   * The enforcement policy. It FAILS CLOSED: once an account has been seen, a vanished or corrupt
   * file keeps the last known policy (owner sign-in is impossible until the host repairs it; agent
   * routes keep working). A managed first run enforces owner authorization before account creation.
   */
  policy(): OwnerPolicy {
    const account = this.account();
    if (account) return account.policy;
    let corrupt = false;
    try {
      this.deps.store.read();
    } catch {
      corrupt = true;
    }
    if (corrupt) return this.lastGood?.policy ?? 'enforce';
    if (this.lastGood) {
      if (!this.warned.missing) {
        this.warned.missing = true;
        void this.audit('account_file_missing', { policy: this.lastGood.policy });
      }
      return this.lastGood.policy;
    }
    // After a restart the last good copy is gone; the policy marker remembers that sign-in was set
    // up, so a deleted account file cannot switch the policy off.
    const marker = this.deps.store.readMarker();
    if (marker === undefined)
      return (this.deps.setupEnabled ?? process.env.REVERIE_OWNER_SETUP === '1') ? 'enforce' : 'off';
    const policy = marker === 'unreadable' ? 'enforce' : marker;
    if (!this.warned.missing) {
      this.warned.missing = true;
      console.error(
        `[owner-auth] owner-auth.json is missing but the policy marker says ${marker}: keeping ${policy}; owner sign-in is unavailable until the host restores the account (or, on a fresh volume, runs \`reverie owner bootstrap\`)`
      );
      void this.audit('account_file_missing', { policy, source: 'marker' });
    }
    return policy;
  }

  async audit(event: string, detail: Record<string, unknown> = {}): Promise<void> {
    const line = JSON.stringify({ at: new Date(this.now()).toISOString(), event, ...detail }) + '\n';
    try {
      await fs.appendFile(this.deps.auditFile, line, { mode: 0o600 });
    } catch {
      /* the audit log is best effort; it never decides a login */
    }
  }

  // ── retry protection ────────────────────────────────────────────────────────

  private bucketOf(account: OwnerAccount, bucket: string): Throttle {
    return current(account.throttles?.[bucket], this.now());
  }

  private assertAllowed(account: OwnerAccount, bucket: string): void {
    const now = this.now();
    const state = this.bucketOf(account, bucket);
    const until = nextAttemptAt(state);
    if (until > now) {
      throw new OwnerAuthError(
        state.lockedUntil > now ? 'Too many failed attempts; try again later' : 'Wait before trying again',
        429,
        Math.ceil((until - now) / 1000)
      );
    }
  }

  /**
   * Run one attempt for a bucket: refused at once if the bucket is throttled, already has an
   * attempt in flight, or two password checks are already running. The reservation is taken
   * before any await, so concurrent requests cannot all slip past the count.
   */
  private async attempt<T>(bucket: string, scrypt: boolean, work: (account: OwnerAccount) => Promise<T>): Promise<T> {
    const account = this.requireAccount();
    this.assertAllowed(account, bucket);
    if (this.busy.has(bucket)) throw new OwnerAuthError('Another attempt is in progress', 429, 1);
    if (scrypt && this.verifying >= MAX_CONCURRENT_VERIFICATIONS) throw new OwnerAuthError('Busy; try again', 429, 1);
    this.busy.add(bucket);
    if (scrypt) this.verifying++;
    try {
      return await work(account);
    } finally {
      this.busy.delete(bucket);
      if (scrypt) this.verifying--;
    }
  }

  private async fail(bucket: string, event: string, reason: string, ip?: string): Promise<never> {
    const now = this.now();
    const state = await this.deps.store.update((account) => {
      const throttles = { ...(account.throttles ?? {}) };
      throttles[bucket] = afterFailure(throttles[bucket], now);
      account.throttles = prune(throttles, now);
      return throttles[bucket];
    });
    await this.audit(event, { ip, bucket: bucketKind(bucket), reason });
    if (state.lockedUntil > now && state.failures === 0) {
      await this.audit('lockout_started', {
        ip,
        bucket: bucketKind(bucket),
        until: new Date(state.lockedUntil).toISOString(),
        lockouts: state.lockouts,
      });
    }
    throw new OwnerAuthError('Wrong credentials', 401);
  }

  /** A success clears the bucket, escalation included. */
  private async succeed(bucket: string): Promise<void> {
    if (!this.account()?.throttles?.[bucket]) return;
    await this.deps.store.update((account) => {
      const throttles = { ...(account.throttles ?? {}) };
      delete throttles[bucket];
      account.throttles = throttles;
    });
  }

  // ── login ───────────────────────────────────────────────────────────────────

  private requireAccount(): OwnerAccount {
    const account = this.account();
    // Sign-in and settings need the file itself: a corrupt file is never signed in against.
    let readable = true;
    try {
      this.deps.store.read();
    } catch {
      readable = false;
    }
    if (!readable) throw new OwnerAuthError('The owner account file is unreadable; the host must repair it', 503);
    if (!account && this.deps.store.readMarker() !== undefined)
      throw new OwnerAuthError('The owner account file is missing; the host must restore it', 503);
    if (!account)
      throw new OwnerAuthError('No owner account yet; the host sets it up with `reverie owner bootstrap`', 503);
    return account;
  }

  async login(username: string, password: string, ip: string, deviceCookie?: string): Promise<LoginResult> {
    const device = this.deviceId(deviceCookie);
    // A remembered device has its own bucket, so a locked network source cannot lock it out.
    const bucket = device ? `dev:${device}` : sourceOf(ip);
    return this.attempt(bucket, true, async (account) => {
      const userOk = safeEqualText(normalizeUsername(username), account.username);
      this.dummyHash ??= hashPassword('not-a-real-password', OWNER_SCRYPT_PARAMS);
      const passwordOk = await verifyPasswordHash(
        String(password ?? ''),
        userOk ? account.password : await this.dummyHash
      );
      if (!userOk || !passwordOk) return this.fail(bucket, 'login_failed', 'bad_credentials', ip);
      if (account.mustChange && account.oneTimeExpiresAt && this.now() > account.oneTimeExpiresAt) {
        await this.audit('one_time_password_expired', { ip });
        throw new OwnerAuthError('The one-time password expired; ask the host for a new one', 401);
      }
      // A host-issued one-time password does not skip 2FA: only `reverie owner reset-2fa` removes it.
      if (account.totp && !device) {
        for (const [key, value] of this.challenges) if (value.expiresAt <= this.now()) this.challenges.delete(key);
        if (this.challenges.size >= 256) throw new OwnerAuthError('Too many pending sign-ins; try again later', 429);
        const challenge = randomToken();
        this.challenges.set(sha256(challenge), {
          expiresAt: this.now() + CHALLENGE_TTL_MS,
          epoch: account.epoch,
          bucket,
        });
        await this.audit('password_ok_second_factor_required', { ip });
        return { next: 'second-factor', challenge };
      }
      if (device) await this.touchDevice(device);
      await this.succeed(bucket);
      await this.audit('login_ok', { ip, restricted: account.mustChange, device: !!device });
      return { next: account.mustChange ? 'change-password' : 'done', session: this.newSession(account) };
    });
  }

  /** Second step: a TOTP code (never the same step twice) or an unused recovery code. */
  async secondFactor(
    challenge: string,
    input: { code?: string; recoveryCode?: string; remember?: boolean; label?: string },
    ip: string
  ): Promise<LoginResult> {
    const key = sha256(String(challenge ?? ''));
    const pending = this.challenges.get(key);
    const account = this.requireAccount();
    if (!pending || pending.expiresAt < this.now() || pending.epoch !== account.epoch) {
      throw new OwnerAuthError('The sign-in expired; enter the password again', 401);
    }
    return this.attempt(pending.bucket, false, async (acc) => {
      if (!acc.totp) throw new OwnerAuthError('Two-factor is not enabled', 400);
      let method: 'totp' | 'recovery';
      if (input.code !== undefined) {
        await this.useTotpCode(String(input.code), pending.bucket, 'second_factor_failed', ip);
        method = 'totp';
      } else if (input.recoveryCode !== undefined) {
        const hash = sha256(normalizeRecoveryCode(String(input.recoveryCode)));
        const used = await this.deps.store.update((a) => {
          let hit: { hash: string; usedAt?: number } | undefined;
          for (const entry of a.recovery) if (safeEqualText(entry.hash, hash) && !entry.usedAt && !hit) hit = entry;
          if (hit) hit.usedAt = this.now();
          return !!hit;
        });
        if (!used) return this.fail(pending.bucket, 'second_factor_failed', 'bad_recovery_code', ip);
        method = 'recovery';
      } else {
        throw new OwnerAuthError('Give a code from the authenticator app or a recovery code', 400);
      }
      this.challenges.delete(key);
      await this.succeed(pending.bucket);
      const fresh = this.requireAccount();
      // A reset password (one-time) still has to be changed, even when two-step is on.
      const result: LoginResult = {
        next: fresh.mustChange ? 'change-password' : 'done',
        session: this.newSession(fresh),
      };
      if (input.remember) result.device = await this.rememberDevice(String(input.label ?? '').slice(0, 80) || 'Device');
      await this.audit('login_ok', { ip, method, remembered: !!input.remember, restricted: fresh.mustChange });
      return result;
    });
  }

  // ── sessions ────────────────────────────────────────────────────────────────

  private newSession(account: OwnerAccount): string {
    for (const key of this.sessions.keys()) this.sessionByHash(key, false);
    if (this.sessions.size >= 128) throw new OwnerAuthError('Too many active sign-ins; sign out another browser or sign out everywhere', 429);
    const token = randomToken();
    const now = this.now();
    this.sessions.set(sha256(token), {
      createdAt: now,
      lastSeenAt: now,
      epoch: account.epoch,
      restricted: account.mustChange,
    });
    return token;
  }

  /** The session behind a cookie, refreshed, or undefined (expired, logged out, older epoch). */
  session(token: string | undefined): OwnerSession | undefined {
    return token ? this.sessionByHash(sha256(token), true) : undefined;
  }

  private sessionByHash(key: string, touch: boolean): { restricted: boolean } | undefined {
    const account = this.account();
    const session = this.sessions.get(key);
    const now = this.now();
    if (
      !account ||
      !session ||
      session.epoch !== account.epoch ||
      now - session.lastSeenAt > SESSION_IDLE_MS ||
      now - session.createdAt > SESSION_MAX_MS
    ) {
      if (session) this.sessions.delete(key);
      return undefined;
    }
    if (touch) session.lastSeenAt = now;
    return { restricted: session.restricted || account.mustChange };
  }

  /** Remember a long-lived connection (WebSocket, event stream) opened with an owner session. */
  track(token: string, socket: Socket): void {
    const key = sha256(token);
    const set = this.connections.get(key) ?? new Set<Socket>();
    set.add(socket);
    this.connections.set(key, set);
    socket.once('close', () => {
      set.delete(socket);
      if (!set.size) this.connections.delete(key);
    });
  }

  /** Close every tracked connection whose session has ended (sign-out, epoch change, expiry). */
  closeEnded(): number {
    let closed = 0;
    for (const [key, sockets] of this.connections) {
      if (this.sessionByHash(key, false)) continue;
      for (const socket of sockets) {
        socket.destroy();
        closed++;
      }
      this.connections.delete(key);
    }
    return closed;
  }

  logout(token: string | undefined): void {
    if (!token) return;
    this.sessions.delete(sha256(token));
    this.closeEnded();
  }

  /** Every session, pending sign-in and remembered device ends, here and in other browsers. */
  async logoutEverywhere(ip?: string): Promise<void> {
    await this.deps.store.update((account) => {
      account.epoch++;
      account.devices = [];
    });
    this.sessions.clear();
    this.challenges.clear();
    this.closeEnded();
    await this.audit('logout_everywhere', { ip });
  }

  /**
   * Self-service password change: the current password, plus a code from the authenticator once
   * two-step is on (not during the forced first change, whose sign-in already passed the second
   * step). Every OTHER session and remembered device ends; the caller keeps its session (a new
   * token is returned) and its own remembered device, if it has one.
   */
  async changePassword(
    token: string | undefined,
    input: { current: string; next: string; username?: string; code?: string; deviceCookie?: string },
    ip: string
  ): Promise<string> {
    const session = this.session(token);
    if (!session) throw new OwnerAuthError('Sign in first', 401);
    const bucket = `ses:${sha256(String(token)).slice(0, 16)}`;
    return this.attempt(bucket, true, async (account) => {
      const currentPassword = String(input.current ?? '');
      if (!(await verifyPasswordHash(currentPassword, account.password))) {
        return this.fail(bucket, 'password_change_failed', 'bad_current_password', ip);
      }
      // Username and password commit together; invalid choices consume no authenticator code.
      if (input.username !== undefined && typeof input.username !== 'string')
        throw new OwnerAuthError('Usernames are 2-32 of a-z 0-9 _ - and start alphanumeric', 400);
      const username = input.username === undefined ? account.username : normalizeUsername(input.username);
      if (!isValidUsername(username))
        throw new OwnerAuthError('Usernames are 2-32 of a-z 0-9 _ - and start alphanumeric', 400);
      const text = String(input.next ?? '');
      if (text === currentPassword) throw new OwnerAuthError('Choose a password different from the current one', 400);
      const problem = passwordProblem(text, username);
      if (problem) throw new OwnerAuthError(problem, 400);
      if (account.totp && !session.restricted) {
        if (!input.code) throw new OwnerAuthError('Enter a code from your authenticator app', 400);
        await this.useTotpCode(input.code, bucket, 'password_change_failed', ip);
      }
      const hash = await hashPassword(text, OWNER_SCRYPT_PARAMS);
      const keepDevice = this.deviceId(input.deviceCookie);
      const updated = await this.deps.store.update((a) => {
        a.username = username;
        a.password = hash;
        a.mustChange = false;
        delete a.oneTimeExpiresAt;
        a.passwordChangedAt = this.now();
        a.epoch++;
        a.devices = a.devices.filter((d) => d.id === keepDevice);
        return a;
      });
      this.sessions.clear();
      this.challenges.clear();
      this.closeEnded();
      await this.succeed(bucket);
      await this.audit('password_changed', { ip, kept_device: !!keepDevice });
      return this.newSession(updated);
    });
  }

  // ── two-factor ──────────────────────────────────────────────────────────────

  private sessionBucket(token: string | undefined): string {
    return `ses:${sha256(String(token)).slice(0, 16)}`;
  }

  /**
   * Begin enrolment. Replacing an existing authenticator needs a current code first, so a hijacked
   * session cannot swap the owner's second factor. The offered secret expires after 10 minutes.
   */
  async startTotp(
    token: string | undefined,
    code: string | undefined,
    ip: string
  ): Promise<{ secret: string; url: string }> {
    const bucket = this.sessionBucket(token);
    return this.attempt(bucket, false, async (account) => {
      if (account.totp) {
        if (!code) throw new OwnerAuthError('Enter a code from your current authenticator to replace it', 400);
        await this.useTotpCode(code, bucket, 'totp_replace_failed', ip);
      }
      const secret = newTotpSecret();
      await this.deps.store.update((a) => {
        a.totpPending = { secret, createdAt: this.now() };
      });
      await this.succeed(bucket);
      return { secret, url: otpauthUrl(secret, account.username) };
    });
  }

  /** Confirm enrolment with the first code; returns the 10 recovery codes, shown once. */
  async confirmTotp(token: string | undefined, code: string, ip: string): Promise<string[]> {
    const bucket = this.sessionBucket(token);
    return this.attempt(bucket, false, async (account) => {
      const pending = account.totpPending;
      if (!pending || this.now() - pending.createdAt > PENDING_TOTP_TTL_MS) {
        throw new OwnerAuthError('Start two-factor setup again', 400);
      }
      const step = matchTotp(pending.secret, String(code ?? '').trim(), this.now());
      if (step === undefined) return this.fail(bucket, 'totp_enrol_failed', 'bad_code', ip);
      const codes = newRecoveryCodes();
      const replaced = !!account.totp;
      await this.deps.store.update((a) => {
        a.totp = { secret: pending.secret, enabledAt: this.now(), lastStep: step };
        delete a.totpPending;
        a.recovery = codes.map((c) => ({ hash: sha256(normalizeRecoveryCode(c)) }));
      });
      await this.succeed(bucket);
      await this.audit(replaced ? 'totp_replaced' : 'totp_enabled', { ip });
      return codes;
    });
  }

  async newRecoveryCodes(token: string | undefined, code: string, ip: string): Promise<string[]> {
    const bucket = this.sessionBucket(token);
    return this.attempt(bucket, false, async () => {
      await this.useTotpCode(code, bucket, 'recovery_regenerate_failed', ip);
      const codes = newRecoveryCodes();
      await this.deps.store.update((a) => {
        a.recovery = codes.map((c) => ({ hash: sha256(normalizeRecoveryCode(c)) }));
      });
      await this.succeed(bucket);
      await this.audit('recovery_regenerated', { ip });
      return codes;
    });
  }

  async disableTotp(token: string | undefined, password: string, code: string, ip: string): Promise<void> {
    const bucket = this.sessionBucket(token);
    return this.attempt(bucket, true, async (account) => {
      if (!(await verifyPasswordHash(String(password ?? ''), account.password))) {
        return this.fail(bucket, 'totp_disable_failed', 'bad_password', ip);
      }
      await this.useTotpCode(code, bucket, 'totp_disable_failed', ip);
      await this.deps.store.update((a) => {
        delete a.totp;
        delete a.totpPending;
        a.recovery = [];
        a.devices = [];
      });
      await this.succeed(bucket);
      await this.audit('totp_disabled', { ip });
    });
  }

  /** Accept a current TOTP code exactly once: the step check and its recording are one write. */
  private async useTotpCode(code: string, bucket: string, event: string, ip?: string): Promise<void> {
    const account = this.requireAccount();
    if (!account.totp) throw new OwnerAuthError('Two-factor is not enabled', 400);
    const step = matchTotp(account.totp.secret, String(code ?? '').trim(), this.now());
    if (step === undefined) return this.fail(bucket, event, 'bad_code', ip);
    const accepted = await this.deps.store.update((a) => {
      if (!a.totp || step <= a.totp.lastStep) return false;
      a.totp.lastStep = step;
      return true;
    });
    if (!accepted) return this.fail(bucket, event, 'reused_code', ip);
  }

  // ── remembered devices ──────────────────────────────────────────────────────

  private async rememberDevice(label: string): Promise<string> {
    const id = randomUUID();
    const secret = randomToken();
    const now = this.now();
    await this.deps.store.update((a) => {
      a.devices = a.devices.filter((d) => d.expiresAt > now);
      if (a.devices.length >= 50) throw new OwnerAuthError('Too many remembered devices; revoke some first', 409);
      a.devices.push({
        id,
        hash: sha256(secret),
        label,
        createdAt: now,
        lastSeenAt: now,
        expiresAt: now + DEVICE_TTL_MS,
      });
    });
    return `${id}.${secret}`;
  }

  /** The id of the remembered device behind a cookie, if the cookie is genuine and unexpired. */
  private deviceId(cookie: string | undefined): string | undefined {
    if (!cookie || !cookie.includes('.')) return undefined;
    const [id, secret] = cookie.split('.', 2);
    const device = this.account()?.devices.find((d) => d.id === id);
    return device && device.expiresAt > this.now() && safeEqualText(device.hash, sha256(secret)) ? id : undefined;
  }

  private async touchDevice(id: string): Promise<void> {
    await this.deps.store.update((a) => {
      const d = a.devices.find((x) => x.id === id);
      if (d) d.lastSeenAt = this.now();
    });
  }

  devices(): Array<Omit<OwnerAccount['devices'][number], 'hash'>> {
    const now = this.now();
    return (this.account()?.devices ?? []).filter((d) => d.expiresAt > now).map(({ hash: _hash, ...rest }) => rest);
  }

  async revokeDevice(id: string, ip: string): Promise<boolean> {
    const removed = await this.deps.store.update((a) => {
      const before = a.devices.length;
      a.devices = a.devices.filter((d) => d.id !== id);
      return a.devices.length < before;
    });
    if (removed) await this.audit('device_revoked', { ip, device: id });
    return removed;
  }

  // ── service tokens (the host's watcher and units) ───────────────────────────

  service(token: string | undefined): string | undefined {
    if (!token) return undefined;
    const hash = sha256(token);
    let name: string | undefined;
    for (const s of this.account()?.services ?? []) if (safeEqualText(s.hash, hash) && !name) name = s.name;
    return name;
  }

  status(token: string | undefined) {
    const account = this.account();
    const session = this.session(token);
    return {
      configured: !!account,
      setupAvailable: this.setupAvailable(),
      policy: this.policy(),
      signedIn: !!session,
      ...(session && account
        ? {
            username: account.username,
            mustChange: account.mustChange,
            twoFactor: !!account.totp,
            recoveryCodesLeft: account.recovery.filter((r) => !r.usedAt).length,
            devices: this.devices(),
          }
        : {}),
    };
  }
}

function bucketKind(bucket: string): string {
  return bucket.startsWith('src:') ? bucket : bucket.split(':')[0]; // never a device or session id
}

/** Drop quiet buckets and keep at most MAX_BUCKETS (the most recent). */
function prune(throttles: Record<string, Throttle>, now: number): Record<string, Throttle> {
  const live = Object.entries(throttles).filter(([, t]) => current(t, now) !== EMPTY);
  live.sort((a, b) => b[1].lastFailureAt - a[1].lastFailureAt);
  return Object.fromEntries(live.slice(0, MAX_BUCKETS));
}
