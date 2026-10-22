/**
 * @fileoverview Host-side administration of the owner account (`reverie owner ...`), run on the
 * machine (or in the container as the console's user), never over HTTP.
 *
 * Administrative bootstrap and recovery remain CLI-only. Browser account creation is limited
 * to a truly unclaimed installation; existing or damaged accounts never reopen registration.
 * One-time passwords are random, printed once to the operator, never logged, and force a change at
 * the first sign-in.
 */
import { randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { hashPassword, isValidUsername, normalizeUsername } from '../user-store.js';
import { randomToken, sha256 } from './crypto.js';
import { ONE_TIME_TTL_MS, OWNER_SCRYPT_PARAMS } from './service.js';
import type { OwnerAccount, OwnerAuthStore, OwnerPolicy } from './store.js';

export class OwnerAdminError extends Error {}

/**
 * Every host action is audited next to the account file, as `host-cli` (no secrets).
 */
export async function auditAdmin(
  store: OwnerAuthStore,
  event: string,
  detail: Record<string, unknown> = {}
): Promise<boolean> {
  const line = JSON.stringify({ at: new Date().toISOString(), event, actor: 'host-cli', ...detail }) + '\n';
  let handle: fs.FileHandle | undefined;
  try {
    // NONBLOCK: a FIFO in its place must not hang the command; only a regular file takes the line.
    handle = await fs.open(
      auditFile(store),
      fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW,
      0o600
    );
    if (!(await handle.stat()).isFile()) return false;
    await handle.writeFile(line);
    return true;
  } catch {
    /* best effort; setPolicy reports a lost line */
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function auditFile(store: OwnerAuthStore): string {
  return join(dirname(store.file), 'owner-auth-audit.jsonl');
}

/**
 * Refuse to run inside an agent session (its environment carries a session id) unless the operator
 * says `--host`: a confused agent told to "fix the 403s" must not be one command from turning the
 * policy off. (Not a defence against a deliberately malicious agent; see the threat note.)
 */
export function assertHostShell(env: NodeJS.ProcessEnv, host: boolean): void {
  if (host) return;
  if (env.REVERIE_SESSION_ID) {
    throw new OwnerAdminError('Run `reverie owner` from a host shell, not inside an agent session');
  }
}

/** A one-time password: 128 bits, easy to type from a terminal. */
export function oneTimePassword(): string {
  return randomToken(16);
}

/**
 * The policy a first bootstrap keeps: a fresh image volume starts with only the policy marker
 * (`enforce`, written by the image entrypoint), and creating the account must not lower it.
 * An unreadable marker fails closed; no marker at all is the long-standing default, `log`.
 */
function markerPolicy(store: OwnerAuthStore): OwnerPolicy {
  const marker = store.readMarker();
  if (marker === undefined) return 'log';
  return marker === 'unreadable' ? 'enforce' : marker;
}

export async function bootstrap(
  store: OwnerAuthStore,
  username: string,
  options: { force?: boolean; enforce?: boolean; now?: number } = {}
): Promise<{ username: string; oneTimePassword: string }> {
  const name = normalizeUsername(username);
  if (!isValidUsername(name)) throw new OwnerAdminError('Usernames are 2-32 of a-z 0-9 _ - and start alphanumeric');
  if (store.read() && !options.force) {
    throw new OwnerAdminError('An owner account exists; use reset-password, or --force to replace it entirely');
  }
  const password = oneTimePassword();
  const now = options.now ?? Date.now();
  const account: OwnerAccount = {
    version: 1,
    username: name,
    password: await hashPassword(password, OWNER_SCRYPT_PARAMS),
    mustChange: true,
    oneTimeExpiresAt: now + ONE_TIME_TTL_MS,
    passwordChangedAt: now,
    recovery: [],
    devices: [],
    services: store.read()?.services ?? [],
    keepers: store.read()?.keepers ?? [],
    throttles: {},
    epoch: (store.read()?.epoch ?? 0) + 1,
    // `enforce` (a fresh native install) only ever raises the policy; it never lowers one.
    policy: options.enforce ? 'enforce' : (store.read()?.policy ?? markerPolicy(store)),
  };
  await store.replace(account);
  await auditAdmin(store, 'owner_bootstrapped', { username: name, replaced: !!options.force, policy: account.policy });
  return { username: name, oneTimePassword: password };
}

/** Lockout recovery: a new one-time password (change forced at sign-in); every session ends. */
export async function resetPassword(store: OwnerAuthStore, now = Date.now()): Promise<string> {
  const password = oneTimePassword();
  const hash = await hashPassword(password, OWNER_SCRYPT_PARAMS);
  await store.update((a) => {
    a.password = hash;
    a.mustChange = true;
    a.oneTimeExpiresAt = now + ONE_TIME_TTL_MS;
    a.passwordChangedAt = now;
    a.throttles = {};
    a.epoch++;
  });
  await auditAdmin(store, 'password_reset');
  return password;
}

/** Lost authenticator: two-factor, recovery codes and remembered devices are removed; sessions end. */
export async function resetTwoFactor(store: OwnerAuthStore): Promise<void> {
  await store.update((a) => {
    delete a.totp;
    delete a.totpPending;
    a.recovery = [];
    a.devices = [];
    a.epoch++;
  });
  await auditAdmin(store, 'two_factor_reset');
}

export async function unlock(store: OwnerAuthStore): Promise<void> {
  await store.update((a) => {
    a.throttles = {};
  });
  await auditAdmin(store, 'unlocked');
}

export async function logoutEverywhere(store: OwnerAuthStore): Promise<void> {
  await store.update((a) => {
    a.epoch++;
    a.devices = [];
  });
  await auditAdmin(store, 'logout_everywhere');
}

/** The host services that call the console and need a service token once `enforce` is on. */
export const REQUIRED_SERVICES = ['watcher', 'plan-usage'] as const;
export const MIN_RECOVERY_CODES = 5;
/** No caller that is not signed in may have been refused-in-log-mode within this window before `enforce`. */
export const QUIET_MS = 60 * 60 * 1000;
/**
 * The policy writes each would-deny key at most hourly (policy.ts auditHourly), so a request in the
 * last QUIET_MS may only show as a line up to an hour older. Reading two windows back catches it.
 */
export const LOOKBACK_MS = 2 * QUIET_MS;

/**
 * What the audit says about callers `enforce` would refuse: `known` with the anonymous requests of
 * the last LOOKBACK_MS (their counts summed), or `known: false` with the reason when the audit cannot
 * show it (missing, unreadable, not a regular file, or covering less than QUIET_MS of log mode).
 * An I/O failure is never read as quiet. Errs towards "not quiet": a caller that stopped up to an
 * hour ago still counts.
 */
export type AnonymousTraffic = { known: true; count: number } | { known: false; reason: string };

export async function recentAnonymous(store: OwnerAuthStore, now = Date.now()): Promise<AnonymousTraffic> {
  let text: string;
  let handle: fs.FileHandle | undefined;
  try {
    // NONBLOCK: a FIFO in its place must not hang the command; NOFOLLOW: no link to another file.
    handle = await fs.open(auditFile(store), fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW);
    if (!(await handle.stat()).isFile()) return { known: false, reason: 'the audit log is not a regular file' };
    text = await handle.readFile('utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'error';
    return {
      known: false,
      reason: code === 'ENOENT' ? 'there is no audit log yet: run log mode first' : `the audit log cannot be read (${code})`,
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
  let count = 0;
  let first = Infinity;
  let logSince = -Infinity;
  for (const line of text.split('\n')) {
    let e: { at?: string; event?: string; caller?: string; count?: unknown; to?: unknown };
    try {
      e = JSON.parse(line);
    } catch {
      continue; /* a damaged line is skipped */
    }
    const at = Date.parse(String(e?.at));
    if (!Number.isFinite(at)) continue;
    first = Math.min(first, at);
    if (e.event === 'policy_changed' && e.to === 'log') logSince = Math.max(logSince, at);
    if (e.event !== 'policy_would_deny' || e.caller !== 'anonymous' || !(now - at <= LOOKBACK_MS)) continue;
    count += typeof e.count === 'number' && e.count > 0 ? e.count : 1;
  }
  const since = Math.max(first, logSince);
  if (!(now - since >= QUIET_MS)) {
    return { known: false, reason: 'the audit log does not cover the last hour of log mode yet: wait' };
  }
  return { known: true, count };
}

/** What in the account itself would lock the owner (or the host services) out under `enforce`. */
function accountProblems(a: OwnerAccount | undefined): string[] {
  if (!a) return ['there is no owner account (reverie owner bootstrap)'];
  const problems: string[] = [];
  if (a.policy === 'off') problems.push('the policy is off: run log first, so the would-deny log shows who is not signed in');
  if (a.mustChange) problems.push('the password is still a one-time password: sign in and change it');
  if (!a.totp) problems.push('two-step sign-in is off: set up the authenticator app on the account page');
  const codes = a.recovery.filter((r) => !r.usedAt).length;
  if (codes < MIN_RECOVERY_CODES) problems.push(`only ${codes} unused recovery codes (at least ${MIN_RECOVERY_CODES}): make new ones`);
  const missing = REQUIRED_SERVICES.filter((name) => !a.services.some((s) => s.name === name));
  if (missing.length) problems.push(`no service token for: ${missing.join(', ')} (reverie owner service-token issue <name>)`);
  return problems;
}

function trafficProblems(traffic: AnonymousTraffic): string[] {
  if (!traffic.known) return [`quiet cannot be established: ${traffic.reason}`];
  return traffic.count > 0
    ? [`${traffic.count} requests in the last two hours came from callers that are not signed in: sign in everywhere first, then wait`]
    : [];
}

/**
 * What would lock the owner (or the host services) out if `enforce` went on now; empty when nothing.
 * Names only what is missing, never a secret.
 */
export async function enforceProblems(store: OwnerAuthStore, now = Date.now()): Promise<string[]> {
  const traffic = await recentAnonymous(store, now);
  return [...accountProblems(store.read()), ...trafficProblems(traffic)];
}

class EnforceRefused extends Error {
  constructor(readonly problems: string[]) {
    super('enforce refused');
  }
}

/**
 * Change the policy. `enforce` is refused while anything in enforceProblems() holds, unless the owner
 * passes `forceLockoutRisk`; both the refusal and a forced flip are audited with the problems.
 * The account checks run inside the write that flips the policy, under the account lock every writer
 * (the host CLI, the console) holds, so they hold for the account that is committed; the audit
 * evidence is read just before. Returns whether the audit line was written: a forced flip with a broken audit log
 * still happens (the owner asked), and the CLI says the line is missing.
 */
export async function setPolicy(
  store: OwnerAuthStore,
  policy: OwnerPolicy,
  options: { forceLockoutRisk?: boolean; now?: number } = {}
): Promise<{ audited: boolean }> {
  if (!['off', 'log', 'enforce'].includes(policy)) throw new OwnerAdminError('Policy is off, log or enforce');
  const traffic = policy === 'enforce' ? await recentAnonymous(store, options.now) : undefined;
  let changed: { from: OwnerPolicy; problems: string[] };
  try {
    changed = await store.update((a) => {
      const problems = traffic ? [...accountProblems(a), ...trafficProblems(traffic)] : [];
      if (problems.length && !options.forceLockoutRisk) throw new EnforceRefused(problems);
      const from = a.policy;
      a.policy = policy;
      return { from, problems };
    });
  } catch (error) {
    if (!(error instanceof EnforceRefused)) throw error;
    await auditAdmin(store, 'policy_enforce_refused', { problems: error.problems });
    throw new OwnerAdminError('Not turning enforce on yet:\n- ' + error.problems.join('\n- '));
  }
  const audited = await auditAdmin(store, 'policy_changed', {
    from: changed.from,
    to: policy,
    ...(changed.problems.length ? { forced: true, problems: changed.problems } : {}),
  });
  return { audited };
}

/** A keeper entry is an exact company employee id. */
const KEEPER_ENTRY = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;

export function listKeepers(store: OwnerAuthStore): string[] {
  return store.read()?.keepers ?? [];
}

/**
 * Let an agent keep others awake: its explicitly listed company employee may nudge, interrupt and
 * read any agent session. Only this host command sets it, and it is audited.
 */
export async function addKeeper(store: OwnerAuthStore, entry: string): Promise<string[]> {
  if (!KEEPER_ENTRY.test(entry)) throw new OwnerAdminError('A keeper is a company employee id');
  const keepers = await store.update((a) => {
    a.keepers = [...new Set([...(a.keepers ?? []), entry])];
    return a.keepers;
  });
  await auditAdmin(store, 'keeper_added', { keeper: entry });
  return keepers;
}

export async function removeKeeper(store: OwnerAuthStore, entry: string): Promise<boolean> {
  const removed = await store.update((a) => {
    const before = a.keepers?.length ?? 0;
    a.keepers = (a.keepers ?? []).filter((k) => k !== entry);
    return a.keepers.length < before;
  });
  if (removed) await auditAdmin(store, 'keeper_removed', { keeper: entry });
  return removed;
}

export function listAdmins(store: OwnerAuthStore): string[] {
  return store.read()?.admins ?? [];
}

/**
 * Let an agent call the admin routes (policy.ts ADMIN_ROUTES): its exact company employee id must be listed. Only this host command sets it, and it is audited.
 */
export async function addAdmin(store: OwnerAuthStore, entry: string): Promise<string[]> {
  if (!KEEPER_ENTRY.test(entry)) throw new OwnerAdminError('An admin is a company employee id');
  const admins = await store.update((a) => {
    a.admins = [...new Set([...(a.admins ?? []), entry])];
    return a.admins;
  });
  await auditAdmin(store, 'admin_added', { admin: entry });
  return admins;
}

export async function removeAdmin(store: OwnerAuthStore, entry: string): Promise<boolean> {
  const removed = await store.update((a) => {
    const before = a.admins?.length ?? 0;
    a.admins = (a.admins ?? []).filter((k) => k !== entry);
    return a.admins.length < before;
  });
  if (removed) await auditAdmin(store, 'admin_removed', { admin: entry });
  return removed;
}

/** A service token (e.g. the host's runtime watcher), printed once; only its hash is kept. */
export async function issueServiceToken(store: OwnerAuthStore, name: string, now = Date.now()): Promise<string> {
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(name)) throw new OwnerAdminError('A service name is 1-40 of a-z 0-9 _ -');
  const token = randomToken();
  await store.update((a) => {
    a.services = a.services.filter((s) => s.name !== name);
    a.services.push({ id: randomUUID(), hash: sha256(token), name, createdAt: now });
  });
  await auditAdmin(store, 'service_token_issued', { name });
  return token;
}

export async function revokeServiceToken(store: OwnerAuthStore, name: string): Promise<boolean> {
  const revoked = await store.update((a) => {
    const before = a.services.length;
    a.services = a.services.filter((s) => s.name !== name);
    return a.services.length < before;
  });
  if (revoked) await auditAdmin(store, 'service_token_revoked', { name });
  return revoked;
}

/** What the operator may see: no hashes, no secrets. */
export function describe(store: OwnerAuthStore, now = Date.now()) {
  const a = store.read();
  if (!a) return { configured: false };
  return {
    configured: true,
    username: a.username,
    policy: a.policy,
    mustChange: a.mustChange,
    twoFactor: !!a.totp,
    recoveryCodesLeft: a.recovery.filter((r) => !r.usedAt).length,
    devices: a.devices.filter((d) => d.expiresAt > now).length,
    services: a.services.map((s) => s.name),
    keepers: a.keepers ?? [],
    admins: a.admins ?? [],
    lockedBuckets: Object.entries(a.throttles ?? {})
      .filter(([, t]) => t.lockedUntil > now)
      .map(([key, t]) => ({
        bucket: key.startsWith('src:') ? key : key.split(':')[0],
        until: new Date(t.lockedUntil).toISOString(),
      })),
    oneTimePasswordExpires: a.mustChange && a.oneTimeExpiresAt ? new Date(a.oneTimeExpiresAt).toISOString() : undefined,
  };
}
