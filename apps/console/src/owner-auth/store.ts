/**
 * @fileoverview The owner account file: `<data>/owner-auth.json`, mode 0600, written atomically.
 *
 * Holds the owner's username and scrypt password hash, the must-change flag, the TOTP secret
 * (0600 like the rest; an encryption key would sit in the same directory, so it would add
 * nothing), hashed recovery codes, hashed remembered-device and service tokens, the account
 * lockout state, the session epoch ("log out everywhere" bumps it) and the enforcement policy.
 *
 * The console and the host CLI (`reverie owner ...`) both edit it, so every read checks the file's
 * mtime and every change is a read-modify-write under a process-local queue. The CLI writes while
 * the console runs; the console notices on its next request.
 *
 * The policy is also kept in its own small file, `<data>/owner-auth.policy`, rewritten with every
 * account write. If the account file disappears, a restarted console still knows that owner
 * sign-in was set up and keeps the policy (failing closed) instead of turning it off.
 */
import { randomUUID } from 'node:crypto';
import { promises as fs, statSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PasswordHash } from '../types.js';

export type OwnerPolicy = 'off' | 'log' | 'enforce';

/** One retry bucket (a network source, a remembered device or an owner session). */
export interface Throttle {
  failures: number;
  lastFailureAt: number;
  lockedUntil: number;
  lockouts?: number;
}

export interface OwnerDevice {
  id: string;
  /** sha256 of the device cookie's secret part. */
  hash: string;
  label: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

export interface OwnerService {
  id: string;
  hash: string;
  name: string;
  createdAt: number;
}

export interface OwnerAccount {
  version: 1;
  username: string;
  password: PasswordHash;
  /** Set by the host CLI's one-time password: the first login may only change the password. */
  mustChange: boolean;
  /** When a host-issued one-time password stops working (30 min after it was printed). */
  oneTimeExpiresAt?: number;
  passwordChangedAt: number;
  totp?: { secret: string; enabledAt: number; lastStep: number };
  /** A secret offered for enrolment but not yet confirmed by a first code. */
  totpPending?: { secret: string; createdAt: number };
  recovery: Array<{ hash: string; usedAt?: number }>;
  devices: OwnerDevice[];
  services: OwnerService[];
  /** Retry buckets, kept on disk so a restart does not reset them (pruned to the 200 most recent). */
  throttles?: Record<string, Throttle>;
  /** Bumped by "log out everywhere" and by a password change: every older session is invalid. */
  epoch: number;
  policy: OwnerPolicy;
  /** Owner-set keepers (`cto`, or company employee ids): may nudge, interrupt and read any agent session. */
  keepers?: string[];
}

export class OwnerAuthStore {
  private cache: { mtimeMs: number; size: number; account: OwnerAccount | undefined } | undefined;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(readonly file: string) {}

  get markerFile(): string {
    return join(dirname(this.file), 'owner-auth.policy');
  }

  /** The policy marker: the policy, `unreadable`, or undefined when there is none. */
  readMarker(): OwnerPolicy | 'unreadable' | undefined {
    let text: string;
    try {
      text = readFileSync(this.markerFile, 'utf8');
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : 'unreadable';
    }
    const policy = text.trim();
    return policy === 'off' || policy === 'log' || policy === 'enforce' ? policy : 'unreadable';
  }

  async writeMarker(policy: OwnerPolicy): Promise<void> {
    await fs.mkdir(dirname(this.markerFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.markerFile}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, policy + '\n', { mode: 0o600 });
    await fs.rename(temporary, this.markerFile);
  }

  /** The account, or undefined before the host has bootstrapped one. Cheap: re-reads only on change. */
  read(): OwnerAccount | undefined {
    let stat: { mtimeMs: number; size: number };
    try {
      stat = statSync(this.file);
    } catch {
      this.cache = undefined;
      return undefined;
    }
    if (this.cache && this.cache.mtimeMs === stat.mtimeMs && this.cache.size === stat.size) return this.cache.account;
    const account = JSON.parse(readFileSync(this.file, 'utf8')) as OwnerAccount;
    this.cache = { mtimeMs: stat.mtimeMs, size: stat.size, account };
    return account;
  }

  /** Read-modify-write, serialized in this process; the result is written atomically with mode 0600. */
  update<T>(change: (account: OwnerAccount) => T): Promise<T> {
    const run = this.chain.then(async () => {
      this.cache = undefined;
      const account = this.read();
      if (!account) throw new Error('No owner account; bootstrap it with `reverie owner bootstrap`');
      const result = change(account);
      await this.write(account);
      return result;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Create or replace the whole account (host CLI bootstrap only). */
  replace(account: OwnerAccount): Promise<void> {
    const run = this.chain.then(() => this.write(account));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async write(account: OwnerAccount): Promise<void> {
    await fs.mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(account, null, 2) + '\n', { mode: 0o600 });
    await fs.rename(temporary, this.file);
    await fs.chmod(this.file, 0o600);
    this.cache = undefined;
    await this.writeMarker(account.policy);
  }
}
