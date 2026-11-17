/** A server-selected account is read through held private files. Paths, JSON
 * and hashes alone never grant a move or a native effect. */
import fs from 'node:fs';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import type { PlanAccount, PlanService } from './plan-accounts.js';
import { dockerContinuationDigest, DockerEmployeeContinuationError } from './docker-employee-continuation.js';
const origin = Symbol('protected selected plan account');
function refuse(code = 'DOCKER_PLAN_ACCOUNT_UNCONFIRMED'): never {
  throw new DockerEmployeeContinuationError(code);
}
function stamp(s: fs.BigIntStats): string {
  return [s.dev, s.ino, s.uid, s.gid, s.mode, s.nlink, s.size, s.mtimeNs, s.ctimeNs].join(':');
}
function owned(uid: bigint): boolean {
  return uid === BigInt(process.getuid?.() ?? -1) || uid === 0n;
}
function directory(s: fs.BigIntStats): string {
  if (!s.isDirectory() || !owned(s.uid) || (s.mode & 0o022n) !== 0n) refuse();
  return [s.dev, s.ino, s.uid, s.gid, s.mode].join(':');
}
function selection(a: PlanAccount): string {
  return dockerContinuationDigest({
    id: a.id,
    provider: a.provider,
    configDir: a.configDir,
    realDir: a.realDir,
    profileId: a.profileId,
    isDefault: a.isDefault,
    profile: a.profile,
  });
}
export class DockerPlanAccountSnapshot {
  readonly #account: PlanAccount;
  readonly #root: number;
  readonly #auth: number;
  readonly #rootStamp: string;
  readonly #authStamp: string;
  readonly #authName: '.credentials.json' | 'auth.json';
  readonly #current: () => void;
  readonly #bytes: Buffer;
  #closed = false;
  #revoked = false;
  private constructor(token: symbol, a: PlanAccount, root: number, auth: number, current: () => void, bytes: Buffer) {
    if (token !== origin) refuse();
    this.#account = structuredClone(a);
    this.#root = root;
    this.#auth = auth;
    this.#current = current;
    this.#rootStamp = directory(fs.fstatSync(root, { bigint: true }));
    this.#authStamp = stamp(fs.fstatSync(auth, { bigint: true }));
    this.#bytes = Buffer.from(bytes);
    this.#authName = a.provider === 'anthropic' ? '.credentials.json' : 'auth.json';
    Object.freeze(this);
  }
  static async capture(
    plans: Pick<PlanService, 'account'>,
    id: string,
    current: () => void
  ): Promise<DockerPlanAccountSnapshot> {
    current();
    let root: number | undefined,
      auth: number | undefined,
      result: DockerPlanAccountSnapshot | undefined,
      bytes: Buffer | undefined;
    try {
      const a = await plans.account(id);
      current();
      if (!a || a.id !== id || !['anthropic', 'openai'].includes(a.provider)) refuse();
      if (
        fs.statfsSync('/proc').type !== 0x9fa0 ||
        !a.realDir.startsWith('/') ||
        a.realDir.includes('\0') ||
        fs.realpathSync(a.configDir) !== a.realDir ||
        fs.realpathSync(a.realDir) !== a.realDir
      )
        refuse();
      root = fs.openSync(a.realDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      directory(fs.fstatSync(root, { bigint: true }));
      const name = a.provider === 'anthropic' ? '.credentials.json' : 'auth.json';
      auth = fs.openSync(
        '/proc/self/fd/' + root + '/' + name,
        constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
      );
      const before = fs.fstatSync(auth, { bigint: true });
      if (
        !before.isFile() ||
        !owned(before.uid) ||
        before.nlink !== 1n ||
        (before.mode & 0o022n) !== 0n ||
        before.size < 2n ||
        before.size > 128n * 1024n
      )
        refuse();
      bytes = Buffer.alloc(Number(before.size));
      let offset = 0;
      while (offset < bytes.length) {
        const count = fs.readSync(auth, bytes, offset, bytes.length - offset, offset);
        if (count === 0) refuse();
        offset += count;
      }
      if (
        fs.readSync(auth, Buffer.alloc(1), 0, 1, bytes.length) !== 0 ||
        stamp(before) !== stamp(fs.fstatSync(auth, { bigint: true }))
      )
        refuse();
      const text = bytes.toString('utf8');
      if (!Buffer.from(text).equals(bytes)) refuse();
      const value: unknown = JSON.parse(text);
      if (!value || typeof value !== 'object' || Array.isArray(value)) refuse();
      result = new DockerPlanAccountSnapshot(origin, a, root, auth, current, bytes);
      if (stamp(before) !== result.#authStamp) refuse();
      result.require();
      const again = await plans.account(id);
      current();
      if (!again || selection(again) !== selection(a)) refuse();
      result.require();
      root = undefined;
      auth = undefined;
      return result;
    } catch {
      let closeFailed = false;
      if (result) {
        try {
          result.close();
        } catch {
          closeFailed = true;
        }
        root = undefined;
        auth = undefined;
      }
      for (const fd of [auth, root])
        if (fd !== undefined) {
          try {
            fs.closeSync(fd);
          } catch {
            closeFailed = true;
          }
        }
      current();
      return refuse(closeFailed ? 'DOCKER_PLAN_ACCOUNT_CLOSE_UNCONFIRMED' : 'DOCKER_PLAN_ACCOUNT_UNCONFIRMED');
    } finally {
      bytes?.fill(0);
    }
  }
  rootIdentity(): Readonly<{ dev: string; ino: string; uid: number; gid: number; mode: number }> {
    this.require();
    const value = fs.fstatSync(this.#root, { bigint: true });
    return Object.freeze({
      dev: String(value.dev),
      ino: String(value.ino),
      uid: Number(value.uid),
      gid: Number(value.gid),
      mode: Number(value.mode),
    });
  }
  get descriptor(): Readonly<{
    id: string;
    provider: 'anthropic' | 'openai';
    selectionDigest: string;
    authDigest: string;
    canonicalSnapshotDigest: string;
  }> {
    this.require();
    const a = this.#account,
      provider = a.provider;
    if (provider !== 'anthropic' && provider !== 'openai') refuse();
    const selected = selection(a),
      authDigest = createHash('sha256').update(this.#bytes).digest('hex');
    return Object.freeze({
      id: a.id,
      provider,
      selectionDigest: selected,
      authDigest,
      canonicalSnapshotDigest: dockerContinuationDigest({
        selectionDigest: selected,
        authDigest,
        root: this.#rootStamp,
        auth: this.#authStamp,
      }),
    });
  }
  require(): void {
    if (this.#closed || this.#revoked) refuse();
    try {
      this.#current();
      if (
        fs.realpathSync(this.#account.configDir) !== this.#account.realDir ||
        directory(fs.fstatSync(this.#root, { bigint: true })) !== this.#rootStamp ||
        directory(fs.lstatSync(this.#account.realDir, { bigint: true })) !== this.#rootStamp ||
        stamp(fs.fstatSync(this.#auth, { bigint: true })) !== this.#authStamp ||
        stamp(fs.lstatSync('/proc/self/fd/' + this.#root + '/' + this.#authName, { bigint: true })) !== this.#authStamp
      )
        refuse();
      this.#current();
    } catch {
      this.#revoked = true;
      this.#current();
      refuse();
    }
  }
  /** Only private stdin payload construction may consume these secret bytes. */
  authText(): string {
    this.require();
    return this.#bytes.toString('utf8');
  }
  selected(a: PlanAccount): void {
    this.require();
    if (selection(a) !== selection(this.#account)) refuse();
  }
  close(): void {
    if (this.#closed) refuse();
    this.#closed = true;
    let failed = false;
    for (const fd of [this.#auth, this.#root]) {
      try {
        fs.closeSync(fd);
      } catch {
        failed = true;
      }
    }
    this.#bytes.fill(0);
    if (failed) refuse('DOCKER_PLAN_ACCOUNT_CLOSE_UNCONFIRMED');
  }
}
Object.freeze(DockerPlanAccountSnapshot.prototype);
