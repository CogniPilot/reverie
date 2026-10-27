/** Ordinary operator-selected private bootstrap; no defaults, initializer or authority inference.
 * Custody comes from the current existing host broker projection PLUS local FD/path
 * checks. Mode bits, an endpoint name and a supplied boolean never prove custody.
 */
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { GoalCustodyChannel } from './goal-custody-channel.js';
import { dirname, isAbsolute, normalize, join } from 'node:path';
import { z } from 'zod';
import type { GoalServerProvisioning } from './goal-server-assembly.js';
import type { GoalNonceCustodyScope } from './goal-nonce-store.js';

const ID = z.string().regex(/^[A-Za-z0-9_.:-]{1,64}(?![\s\S])/);
const UUID = z.string().regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?![\s\S])/);
const path = z
  .string()
  .refine((value) => isAbsolute(value) && normalize(value) === value && value !== '/' && !/[\0\r\n]/.test(value));
const pair = z.object({ host: path, server: path }).strict();
const Schema = z
  .object({
    version: z.literal(1),
    mode: z.enum(['owner-only', 'owner-and-employee']),
    issuer: ID,
    epoch: ID,
    serverContainerId: z.string().regex(/^[0-9a-f]{64}(?![\s\S])/),
    paths: z.object({ config: pair, key: pair, canonical: pair, nonce: pair, authority: pair }).strict(),
    nonce: z.object({ storeId: UUID, capacity: z.number().int().min(1).max(4096), flockExecutable: path }).strict(),
    server: z.object({ brokerSocket: path, custodyClient: path }).strict(),
  })
  .strict();
type Config = z.infer<typeof Schema>;
type Identity = string[] | null;
const names = ['config', 'key', 'canonical', 'nonce', 'authority'] as const;
function refuse(): never {
  throw new Error('Private Goal bootstrap unavailable or no longer current');
}
function identity(info: fs.BigIntStats): string[] {
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String);
}
function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
class PathBatch {
  readonly root = fs.openSync('/', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  readonly descriptors = [this.root];
  readonly issued: { path: string; info: fs.BigIntStats }[] = [];
  readonly directories = new Map<string, number>();
  readonly absent: string[] = [];
  check(): void {
    for (const owner of this.issued) {
      const fresh = fs.lstatSync(owner.path, { bigint: true });
      if (
        fresh.isSymbolicLink() ||
        fresh.dev !== owner.info.dev ||
        fresh.ino !== owner.info.ino ||
        fresh.mode !== owner.info.mode ||
        fresh.uid !== owner.info.uid
      )
        refuse();
    }
    for (const value of this.absent) if (fs.lstatSync(value, { throwIfNoEntry: false }) !== undefined) refuse();
  }
  close(): void {
    for (const fd of this.descriptors.reverse()) fs.closeSync(fd);
  }
}

/** Linux anchored no-follow traversal; callers still MUST obtain current host custody. */
function entry(
  value: string,
  directory = false,
  absent = false,
  limit?: number,
  batch?: PathBatch
): { identity: Identity; bytes?: Buffer } {
  if (!path.safeParse(value).success || process.getuid === undefined) refuse();
  const uid = BigInt(process.getuid()),
    descriptors: number[] = batch?.descriptors ?? [];
  const issued: { path: string; info: fs.BigIntStats }[] = batch?.issued ?? [];
  let current = '/',
    parent = batch?.root ?? fs.openSync('/', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  if (!batch) descriptors.push(parent);
  try {
    const parts = value.split('/').slice(1);
    for (const component of parts.slice(0, -1)) {
      current = join(current, component);
      const held = batch?.directories.get(current);
      if (held !== undefined) {
        parent = held;
        continue;
      }
      parent = fs.openSync(
        `/proc/self/fd/${parent}/${component}`,
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
      );
      descriptors.push(parent);
      const info = fs.fstatSync(parent, { bigint: true });
      const stickyRoot = info.uid === 0n && (info.mode & 0o1000n) !== 0n;
      if ((info.uid !== 0n && info.uid !== uid) || ((info.mode & 0o022n) !== 0n && !stickyRoot)) refuse();
      issued.push({ path: current, info });
      batch?.directories.set(current, parent);
    }
    const parentInfo = fs.fstatSync(parent, { bigint: true });
    if (parentInfo.uid !== uid || (parentInfo.mode & 0o077n) !== 0n) refuse();
    let fd: number;
    try {
      fd = fs.openSync(
        `/proc/self/fd/${parent}/${parts.at(-1)!}`,
        fs.constants.O_RDONLY |
          fs.constants.O_NOFOLLOW |
          fs.constants.O_NONBLOCK |
          (directory ? fs.constants.O_DIRECTORY : 0)
      );
    } catch (error) {
      if (!absent || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // Check retained ancestors even for a not-yet-created temporary/lock.
      for (const owner of batch ? [] : issued) {
        const fresh = fs.lstatSync(owner.path, { bigint: true });
        if (
          fresh.isSymbolicLink() ||
          fresh.dev !== owner.info.dev ||
          fresh.ino !== owner.info.ino ||
          fresh.mode !== owner.info.mode ||
          fresh.uid !== owner.info.uid
        )
          refuse();
      }
      if (fs.lstatSync(value, { throwIfNoEntry: false }) !== undefined) refuse();
      batch?.absent.push(value);
      return { identity: null };
    }
    descriptors.push(fd);
    const info = fs.fstatSync(fd, { bigint: true });
    if (
      !(directory ? info.isDirectory() : info.isFile()) ||
      info.uid !== uid ||
      (info.mode & 0o077n) !== 0n ||
      (!directory && info.nlink !== 1n)
    )
      refuse();
    issued.push({ path: value, info });
    let bytes: Buffer | undefined;
    if (limit !== undefined) {
      if (info.size > BigInt(limit)) refuse();
      const buffer = Buffer.alloc(limit + 1);
      let offset = 0,
        count: number;
      do {
        count = fs.readSync(fd, buffer, offset, buffer.length - offset, null);
        offset += count;
      } while (count && offset < buffer.length);
      if (offset > limit || !same(identity(info), identity(fs.fstatSync(fd, { bigint: true })))) refuse();
      bytes = buffer.subarray(0, offset);
    }
    for (const owner of batch ? [] : issued) {
      const fresh = fs.lstatSync(owner.path, { bigint: true });
      if (
        fresh.isSymbolicLink() ||
        fresh.dev !== owner.info.dev ||
        fresh.ino !== owner.info.ino ||
        fresh.mode !== owner.info.mode ||
        fresh.uid !== owner.info.uid
      )
        refuse();
    }
    return { identity: identity(info), bytes };
  } finally {
    if (!batch) for (const fd of descriptors.reverse()) fs.closeSync(fd);
  }
}

function readConfig(file: string): { config: Config; digest: string; identity: Identity } {
  const loaded = entry(file, false, false, 65536),
    bytes = loaded.bytes!;
  if (!Buffer.from(bytes.toString('utf8')).equals(bytes)) refuse();
  const config = Schema.parse(JSON.parse(bytes.toString('utf8')));
  if (config.paths.config.server !== file || config.paths.key.server.startsWith('/nix/store/')) refuse();
  return { config, digest: createHash('sha256').update(bytes).digest('hex'), identity: loaded.identity };
}

/** Only an explicit ordinary launcher option enables attempts. No environment key/config discovery. */
export function loadGoalPrivateBootstrap(
  file: string | undefined,
  canonicalFile: string
): GoalServerProvisioning | undefined {
  if (file === undefined) return;
  let channel: GoalCustodyChannel | undefined;
  try {
    const initial = readConfig(file),
      { config, digest } = initial;
    // Pin metadata only. Key CONTENT is not read until issuer() has obtained a
    // complete fresh host projection and revalidated every local scope below.
    const initialKey = entry(config.paths.key.server);
    if (initialKey.identity?.[2] !== '32') refuse();
    const keyIdentity = initialKey.identity;
    if (
      config.paths.canonical.server !== canonicalFile ||
      config.server.brokerSocket !== process.env.REVERIE_WORKER_SOCKET
    )
      refuse();
    // The operator pins a packaged immutable client, not a shell command or PATH lookup.
    const executable = fs.realpathSync(config.server.custodyClient),
      executableInfo = fs.statSync(executable, { bigint: true });
    if (
      !executable.startsWith('/nix/store/') ||
      !executableInfo.isFile() ||
      executableInfo.uid !== 0n ||
      executableInfo.mode & 0o022n ||
      !(executableInfo.mode & 0o111n)
    )
      refuse();
    channel = new GoalCustodyChannel(executable, config.server.brokerSocket);
    const assertExecutable = () => {
      if (
        process.env.REVERIE_WORKER_SOCKET !== config.server.brokerSocket ||
        fs.realpathSync(config.server.custodyClient) !== executable
      )
        refuse();
      const current = fs.statSync(executable, { bigint: true });
      if (
        !same(identity(executableInfo), identity(current)) ||
        current.mode !== executableInfo.mode ||
        current.uid !== executableInfo.uid
      )
        refuse();
    };
    const projection = () => {
      const fresh = readConfig(file);
      if (fresh.digest !== digest || !same(fresh.identity, initial.identity) || !same(fresh.config, config)) refuse();
      assertExecutable();
      const response = JSON.parse(channel!.project()) as {
        version?: unknown;
        configDigest?: unknown;
        identities?: Record<string, unknown>;
      };
      if (
        !response ||
        Object.keys(response).sort().join(',') !== 'configDigest,identities,version' ||
        response.version !== 1 ||
        response.configDigest !== digest ||
        !response.identities
      )
        refuse();
      const local: Record<string, Identity> = {};
      const batch = new PathBatch();
      try {
        for (const name of names) {
          const target = config.paths[name].server;
          local[name] = entry(target, name === 'authority', false, undefined, batch).identity;
          local[name + 'Root'] = entry(dirname(target), true, false, undefined, batch).identity;
        }
        if (!same(local.key, keyIdentity)) refuse();
        local.canonicalLock = entry(canonicalFile + '.lock', false, true, undefined, batch).identity;
        local.nonceLock = entry(config.paths.nonce.server + '.lock', false, false, undefined, batch).identity;
        local.noncePending = entry(config.paths.nonce.server + '.pending', false, true, undefined, batch).identity;
        local.nonceParent = entry(dirname(dirname(config.paths.nonce.server)), true, false, undefined, batch).identity;
        batch.check();
      } finally {
        batch.close();
      }
      if (
        Object.keys(response.identities).sort().join(',') !== Object.keys(local).sort().join(',') ||
        Object.entries(local).some(([name, value]) => !same(value, response.identities![name]))
      )
        refuse();
      // Trust content and canonical scope are rechecked after the blocking helper.
      const final = readConfig(file);
      if (final.digest !== digest || !same(final.identity, initial.identity)) refuse();
      assertExecutable();
    };
    const custody = {
      assertPrivateCustody: (target: string) => {
        if (target !== canonicalFile) refuse();
        projection();
      },
    };
    const nonceCustody = (scope: GoalNonceCustodyScope) => {
      if (
        !same(scope, {
          root: dirname(config.paths.nonce.server),
          parent: dirname(dirname(config.paths.nonce.server)),
          file: config.paths.nonce.server,
          lock: config.paths.nonce.server + '.lock',
          temporary: config.paths.nonce.server + '.pending',
          authorityNamespace: config.paths.authority.server,
        })
      )
        refuse();
      projection();
    };
    projection(); // An explicit incomplete/bad bootstrap never silently starts as enabled.
    return {
      kind: 'canonical-goal-provisioning',
      mode: config.mode,
      close: () => channel!.close(),
      custody,
      issuer: (issuer) => {
        try {
          if (config.mode !== 'owner-and-employee') return;
          if (issuer !== config.issuer) return;
          projection();
          const loaded = entry(config.paths.key.server, false, false, 32),
            key = loaded.bytes!;
          if (key.length !== 32) refuse();
          projection();
          if (!same(loaded.identity, entry(config.paths.key.server).identity)) refuse();
          return { epoch: config.epoch, key };
        } catch {
          return;
        }
      },
      nonce: {
        file: config.paths.nonce.server,
        storeId: config.nonce.storeId,
        capacity: config.nonce.capacity,
        flockExecutable: config.nonce.flockExecutable,
        authorityNamespace: config.paths.authority.server,
        assertPrivateCustody: nonceCustody,
      },
    };
  } catch {
    channel?.close();
    return refuse();
  }
}
