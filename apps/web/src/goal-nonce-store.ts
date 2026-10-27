/**
 * @fileoverview Optional private durable Goal nonce backend. No constructor I/O,
 * initializer, key readers or production registration. Trusted composition must
 * provide custody for the entire storage/authority namespace and a pre-existing
 * ledger+lock. Modes and path spelling never establish custody.
 */
import * as fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, normalize } from 'node:path';
import type { GoalBrokerPorts, GoalNonceKey } from './goal-broker-auth.js';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const HEX = /^[0-9a-f]{64}$/;
const NONCE = /^[0-9a-f]{32}$/;
const MAX_CAPACITY = 4096;
const QUEUE_LIMIT = 32;
const LOCK_ARGS = ['--exclusive', '--wait', '1', '--conflict-exit-code', '75', '3'];
const LOCK_TIMEOUT_MS = 2000;
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const matches = (re: RegExp, v: unknown): v is string =>
  typeof v === 'string' && !v.includes('\n') && !v.includes('\r') && re.test(v);
const keys = (v: object, names: string[]): boolean =>
  Object.keys(v).length === names.length && names.every((name) => Object.hasOwn(v, name));
const path = (v: string): boolean => isAbsolute(v) && normalize(v) === v && !v.includes('\0') && v !== '/';

export interface GoalNonceCustodyScope {
  readonly root: string;
  readonly parent: string;
  readonly file: string;
  readonly lock: string;
  readonly temporary: string;
  readonly authorityNamespace: string;
}
export interface GoalNonceStoreOptions {
  readonly file: string;
  readonly storeId: string;
  readonly capacity: number;
  /** Explicit trusted absolute packaged flock executable; no PATH lookup/default. */
  readonly flockExecutable: string;
  readonly authorityNamespace: string;
  /** Must establish the WHOLE scope outside worker-writable/shared namespaces,
   * repeated before EVERY storage read/write/metadata operation. Not a caller boolean. */
  assertPrivateCustody(scope: GoalNonceCustodyScope): void;
  now?: () => number;
}
interface Entry {
  key: string;
  claimId: string;
  expiresAt: number;
}
interface Ledger {
  version: 1;
  storeId: string;
  capacity: number;
  revision: number;
  clockFloor: number;
  entries: Entry[];
}
interface Claim {
  storeId: string;
  key: string;
  claimId: string;
  expiresAt: number;
}
type NoncePort = GoalBrokerPorts['nonces'];
export class GoalNonceStoreError extends Error {
  constructor() {
    super('Private durable Goal nonce storage unavailable or no longer current');
  }
}

/** Implements the sealed broker-auth nonce port. Handles are process-local and
 * unforgeable; the exact nonce/claim must also exist in fresh durable state. */
export class GoalNonceStore implements NoncePort {
  private readonly options?: Readonly<GoalNonceStoreOptions>;
  private readonly scope?: Readonly<GoalNonceCustodyScope>;
  private readonly handles = new WeakMap<object, Claim>();
  private chain: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private observedClock = -1;

  constructor(options?: GoalNonceStoreOptions) {
    if (!options) return;
    if (
      !path(options.file) ||
      !path(options.authorityNamespace) ||
      !path(options.flockExecutable) ||
      !matches(UUID, options.storeId) ||
      !integer(options.capacity) ||
      options.capacity < 1 ||
      options.capacity > MAX_CAPACITY ||
      typeof options.assertPrivateCustody !== 'function'
    )
      throw new GoalNonceStoreError();
    const root = dirname(options.file);
    if (root === '/') throw new GoalNonceStoreError();
    this.options = Object.freeze({ ...options });
    this.scope = Object.freeze({
      root,
      parent: dirname(root),
      file: options.file,
      lock: options.file + '.lock',
      temporary: options.file + '.pending',
      authorityNamespace: options.authorityNamespace,
    });
  }

  private get config(): Readonly<GoalNonceStoreOptions> {
    if (!this.options) throw new GoalNonceStoreError();
    return this.options;
  }

  private get storage(): Readonly<GoalNonceCustodyScope> {
    if (!this.scope) throw new GoalNonceStoreError();
    return this.scope;
  }

  private guard(): void {
    this.config.assertPrivateCustody(this.storage);
  }

  private io<T>(operation: () => T): T {
    this.guard();
    return operation();
  }

  private clock(): number {
    this.guard();
    const now = (this.config.now ?? Date.now)();
    if (!integer(now) || now < this.observedClock) throw new GoalNonceStoreError();
    this.observedClock = now;
    return now;
  }

  private key(key: GoalNonceKey): string {
    if (
      !key ||
      typeof key !== 'object' ||
      Array.isArray(key) ||
      !keys(key, ['issuer', 'epoch', 'nonce', 'expiresAt']) ||
      !matches(ID, key.issuer) ||
      !matches(ID, key.epoch) ||
      !matches(NONCE, key.nonce) ||
      !integer(key.expiresAt)
    )
      throw new GoalNonceStoreError();
    return createHash('sha256')
      .update('reverie-goal-nonce-v1\n' + JSON.stringify([key.issuer, key.epoch, key.nonce]))
      .digest('hex');
  }

  private openLock(): number {
    this.guard();
    const root = this.io(() => fs.lstatSync(this.storage.root));
    if (!root.isDirectory() || root.isSymbolicLink()) throw new GoalNonceStoreError();
    // No O_CREAT: missing/malformed state must never become an empty trusted ledger.
    return this.openRegular(this.storage.lock, fs.constants.O_RDWR);
  }

  private openRegular(file: string, access: number): number {
    // Refuse special files before opening them (including devices). O_NONBLOCK
    // additionally prevents a raced FIFO substitution from hanging before fstat.
    // Custody must keep this namespace outside untrusted writers; type/mode alone
    // never establishes that authority. Check the opened inode against preflight.
    const named = this.io(() => fs.lstatSync(file));
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1) throw new GoalNonceStoreError();
    const fd = this.io(() => fs.openSync(file, access | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK));
    try {
      const info = this.io(() => fs.fstatSync(fd));
      if (!info.isFile() || info.nlink !== 1 || info.dev !== named.dev || info.ino !== named.ino)
        throw new GoalNonceStoreError();
      return fd;
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
  }

  private verifyLock(fd: number): void {
    this.guard();
    const held = this.io(() => fs.fstatSync(fd));
    const named = this.io(() => fs.lstatSync(this.storage.lock));
    if (!named.isFile() || named.nlink !== 1 || held.dev !== named.dev || held.ino !== named.ino)
      throw new GoalNonceStoreError();
  }

  private async acquire(fd: number): Promise<void> {
    this.guard();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.config.flockExecutable, LOCK_ARGS, {
        stdio: ['ignore', 'ignore', 'ignore', fd],
        env: {},
        timeout: LOCK_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      });
      child.once('error', () => reject(new GoalNonceStoreError()));
      child.once('close', (code) => (code === 0 ? resolve() : reject(new GoalNonceStoreError())));
    });
    this.verifyLock(fd); // The inherited fd shares the OFD; parent keeps the kernel lock.
  }

  private acquireSync(fd: number): void {
    this.guard();
    const result = spawnSync(this.config.flockExecutable, LOCK_ARGS, {
      stdio: ['ignore', 'ignore', 'ignore', fd],
      env: {},
      timeout: LOCK_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    if (result.error || result.status !== 0) throw new GoalNonceStoreError();
    this.verifyLock(fd);
  }

  private validate(raw: unknown): Ledger {
    this.guard();
    if (
      !raw ||
      typeof raw !== 'object' ||
      Array.isArray(raw) ||
      !keys(raw, ['version', 'storeId', 'capacity', 'revision', 'clockFloor', 'entries'])
    )
      throw new GoalNonceStoreError();
    const v = raw as Ledger;
    if (
      v.version !== 1 ||
      v.storeId !== this.config.storeId ||
      v.capacity !== this.config.capacity ||
      !integer(v.revision) ||
      !integer(v.clockFloor) ||
      !Array.isArray(v.entries) ||
      v.entries.length > v.capacity
    )
      throw new GoalNonceStoreError();
    const entryKeys = new Set<string>();
    const claims = new Set<string>();
    for (const entry of v.entries) {
      if (
        !entry ||
        typeof entry !== 'object' ||
        Array.isArray(entry) ||
        !keys(entry, ['key', 'claimId', 'expiresAt']) ||
        !matches(HEX, entry.key) ||
        !matches(UUID, entry.claimId) ||
        !integer(entry.expiresAt) ||
        entryKeys.has(entry.key) ||
        claims.has(entry.claimId)
      )
        throw new GoalNonceStoreError();
      entryKeys.add(entry.key);
      claims.add(entry.claimId);
    }
    return v;
  }

  private read(): Ledger {
    this.guard();
    const fd = this.openRegular(this.storage.file, fs.constants.O_RDONLY);
    try {
      const info = this.io(() => fs.fstatSync(fd));
      const maximum = 1024 + this.config.capacity * 256;
      if (!info.isFile() || info.nlink !== 1 || info.size > maximum) throw new GoalNonceStoreError();
      const raw = this.io(() => fs.readFileSync(fd, 'utf8'));
      if (Buffer.byteLength(raw) > maximum) throw new GoalNonceStoreError();
      return this.validate(JSON.parse(raw));
    } finally {
      fs.closeSync(fd);
    }
  }

  private write(state: Ledger): void {
    this.guard();
    this.validate(state);
    const data = JSON.stringify(state);
    if (Buffer.byteLength(data) > 1024 + this.config.capacity * 256) throw new GoalNonceStoreError();
    let owned: fs.Stats | undefined;
    try {
      const fd = this.io(() =>
        fs.openSync(
          this.storage.temporary,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
          0o600
        )
      );
      try {
        owned = this.io(() => fs.fstatSync(fd));
        this.io(() => fs.writeFileSync(fd, data));
        this.io(() => fs.fsyncSync(fd));
      } finally {
        fs.closeSync(fd);
      }
      this.io(() => fs.renameSync(this.storage.temporary, this.storage.file));
      owned = undefined;
      const parent = this.io(() =>
        fs.openSync(this.storage.root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
      );
      try {
        this.io(() => fs.fsyncSync(parent));
      } finally {
        fs.closeSync(parent);
      }
    } finally {
      if (owned) {
        // Cleanup only our exact staging inode and only with STILL-valid custody.
        // Revocation or process death leaves one bounded pending file and refuses
        // further writes until authorized reconciliation; never delete unknown state.
        try {
          const current = this.io(() => fs.lstatSync(this.storage.temporary));
          if (current.dev === owned.dev && current.ino === owned.ino)
            this.io(() => fs.unlinkSync(this.storage.temporary));
        } catch {
          /* unknown custody/state is not deletion authority */
        }
      }
    }
  }

  private transaction<T>(fd: number, work: (state: Ledger, now: number) => T): T {
    this.verifyLock(fd);
    const state = this.read();
    const now = this.clock();
    if (now < state.clockFloor || state.revision === Number.MAX_SAFE_INTEGER) throw new GoalNonceStoreError();
    const before = JSON.stringify(state);
    const result = work(state, now);
    state.clockFloor = now;
    if (JSON.stringify(state) !== before) {
      state.revision++;
      this.write(state);
    }
    return result;
  }

  private currentClaim(fd: number, expected: Claim): void {
    // The transaction may just have performed a blocking durable floor write.
    // Re-read the exact claim with the lock STILL held, then check current custody
    // and clock last. Never recursively write floors or return cached authority.
    // The transaction's accepted floor is durable; this final observation only
    // refuses stale/expired results and is not advertised as another durable floor.
    this.verifyLock(fd);
    const state = this.read();
    if (
      expected.storeId !== state.storeId ||
      !state.entries.some(
        (entry) =>
          entry.key === expected.key && entry.claimId === expected.claimId && entry.expiresAt === expected.expiresAt
      )
    )
      throw new GoalNonceStoreError();
    const now = this.clock();
    if (now < state.clockFloor || expected.expiresAt <= now) throw new GoalNonceStoreError();
  }

  claim(key: GoalNonceKey): Promise<object | undefined> {
    if (this.queued >= QUEUE_LIMIT) return Promise.reject(new GoalNonceStoreError());
    // Copy immutable input before entering a queued/awaited path.
    const supplied = Object.freeze({ ...key });
    this.queued++;
    const run = this.chain
      .then(async () => {
        let fd: number | undefined;
        try {
          const hash = this.key(supplied);
          fd = this.openLock();
          await this.acquire(fd);
          const accepted = this.transaction(fd, (state, now) => {
            if (supplied.expiresAt <= now || supplied.expiresAt - now > 10_000) throw new GoalNonceStoreError();
            state.entries = state.entries.filter((entry) => entry.expiresAt > now);
            if (state.entries.some((entry) => entry.key === hash) || state.entries.length >= state.capacity)
              return undefined;
            const entry: Entry = { key: hash, claimId: randomUUID(), expiresAt: supplied.expiresAt };
            state.entries.push(entry);
            return { ...entry, storeId: state.storeId };
          });
          if (!accepted) return undefined;
          this.currentClaim(fd, accepted);
          const handle = Object.freeze({});
          this.handles.set(handle, accepted);
          return handle;
        } catch {
          throw new GoalNonceStoreError();
        } finally {
          if (fd !== undefined) fs.closeSync(fd);
        }
      })
      .finally(() => {
        this.queued--;
      });
    this.chain = run.catch(() => {});
    return run;
  }

  assertCurrent(handle: object, key: GoalNonceKey): void {
    let fd: number | undefined;
    try {
      const expected = this.handles.get(handle);
      const hash = this.key(key);
      if (!expected || expected.key !== hash || expected.expiresAt !== key.expiresAt) throw new GoalNonceStoreError();
      fd = this.openLock();
      this.acquireSync(fd);
      this.transaction(fd, (state, now) => {
        if (
          expected.storeId !== state.storeId ||
          key.expiresAt <= now ||
          !state.entries.some(
            (entry) => entry.key === hash && entry.claimId === expected.claimId && entry.expiresAt === key.expiresAt
          )
        )
          throw new GoalNonceStoreError();
      }); // Persist accepted clock floor synchronously; never use cached authority.
      this.currentClaim(fd, expected);
    } catch {
      throw new GoalNonceStoreError();
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
}
