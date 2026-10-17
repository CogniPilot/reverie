/**
 * @fileoverview Host-side administration of the owner account (`reverie owner ...`), run on the
 * machine (or in the container as the console's user), never over HTTP.
 *
 * Bootstrap is deliberately CLI-only: every agent shares the console's loopback, so a "first run
 * from localhost" web setup would let whichever process asked first claim the owner account.
 * One-time passwords are random, printed once to the operator, never logged, and force a change at
 * the first sign-in.
 */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
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
): Promise<void> {
  const line = JSON.stringify({ at: new Date().toISOString(), event, actor: 'host-cli', ...detail }) + '\n';
  try {
    await fs.appendFile(join(dirname(store.file), 'owner-auth-audit.jsonl'), line, { mode: 0o600 });
  } catch {
    /* best effort */
  }
}

/**
 * Refuse to run inside an agent session (its environment carries a session id) unless the operator
 * says `--host`: a confused agent told to "fix the 403s" must not be one command from turning the
 * policy off. (Not a defence against a deliberately malicious agent; see the threat note.)
 */
export function assertHostShell(env: NodeJS.ProcessEnv, host: boolean): void {
  if (host) return;
  if (env.CODEMAN_SESSION_ID || env.REVERIE_SESSION_ID) {
    throw new OwnerAdminError('Run `reverie owner` from a host shell, not inside an agent session');
  }
}

/** A one-time password: 128 bits, easy to type from a terminal. */
export function oneTimePassword(): string {
  return randomToken(16);
}

export async function bootstrap(
  store: OwnerAuthStore,
  username: string,
  options: { force?: boolean; now?: number } = {}
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
    policy: store.read()?.policy ?? 'log',
  };
  await store.replace(account);
  await auditAdmin(store, 'owner_bootstrapped', { username: name, replaced: !!options.force });
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

export async function setPolicy(store: OwnerAuthStore, policy: OwnerPolicy): Promise<void> {
  if (!['off', 'log', 'enforce'].includes(policy)) throw new OwnerAdminError('Policy is off, log or enforce');
  const from = await store.update((a) => {
    const previous = a.policy;
    a.policy = policy;
    return previous;
  });
  await auditAdmin(store, 'policy_changed', { from, to: policy });
}

/** A keeper entry: `cto` (the company's CTO, whoever that is) or a company employee id. */
const KEEPER_ENTRY = /^(cto|[A-Za-z0-9][A-Za-z0-9-]{0,99})$/;

export function listKeepers(store: OwnerAuthStore): string[] {
  return store.read()?.keepers ?? [];
}

/**
 * Let an agent keep others awake: its company employee (or the CTO, `cto`) may nudge, interrupt and
 * read any agent session. Only this host command sets it, and it is audited.
 */
export async function addKeeper(store: OwnerAuthStore, entry: string): Promise<string[]> {
  if (!KEEPER_ENTRY.test(entry)) throw new OwnerAdminError('A keeper is `cto` or a company employee id');
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
    lockedBuckets: Object.entries(a.throttles ?? {})
      .filter(([, t]) => t.lockedUntil > now)
      .map(([key, t]) => ({
        bucket: key.startsWith('src:') ? key : key.split(':')[0],
        until: new Date(t.lockedUntil).toISOString(),
      })),
    oneTimePasswordExpires: a.mustChange && a.oneTimeExpiresAt ? new Date(a.oneTimeExpiresAt).toISOString() : undefined,
  };
}
