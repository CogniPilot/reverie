/** Capsule file/readback DATA. Only an owning actual Engine observation may use it. */
import * as fs from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { readDockerWorkerIdentity } from './docker-worker-identity-client.js';
export const WORKER_CLIENT_PREFIX = '/opt/reverie-worker-client';
export const WORKER_CLIENT_ENTRY = WORKER_CLIENT_PREFIX + '/bin/reverie';
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const relative = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      (value === 'claude-hooks.json' || ['bin', 'lib', 'notices'].includes(value.split('/')[0]!)) &&
      value.split('/').every((part) => part !== '.' && part !== '..' && /^[A-Za-z0-9@_+.=-]+$/.test(part))
  );
const Entry = z
  .object({
    path: relative,
    sha256: digest,
    bytes: z
      .number()
      .int()
      .nonnegative()
      .max(128 * 1024 * 1024),
    mode: z.union([z.literal(0o444), z.literal(0o555)]),
  })
  .strict();
const Manifest = z
  .object({
    version: z.literal(1),
    purpose: z.literal('reverie-worker-client-v1'),
    entry: z.literal('/opt/reverie-worker-client/bin/reverie'),
    node: z.literal('/opt/reverie-worker-client/bin/node'),
    files: z.array(Entry).min(4).max(256),
  })
  .strict()
  .refine(
    (value) =>
      value.files.every((file, index) => index === 0 || value.files[index - 1]!.path < file.path) &&
      Object.entries({
        'bin/node': 0o555,
        'bin/reverie': 0o555,
        'bin/reverie.mjs': 0o444,
        'claude-hooks.json': 0o444,
      }).every(([name, mode]) => value.files.some((file) => file.path === name && file.mode === mode)) &&
      value.files.reduce((sum, file) => sum + file.bytes, 0) <= 512 * 1024 * 1024
  );
const Readback = z
  .object({
    version: z.literal(1),
    purpose: z.literal('reverie-worker-client-readback-v1'),
    manifestDigest: digest,
    entrySha256: digest,
    filesChecked: z.number().int().min(4).max(256),
    nodeMajor: z.literal(22),
    ownerUid: z.literal(0),
  })
  .strict();
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
function stamp(s: fs.Stats): string {
  return [s.dev, s.ino, s.mode, s.uid, s.gid, s.nlink, s.size, s.mtimeMs, s.ctimeMs].join(':');
}
function parents(root: string, file: string, uid: number): string {
  const states: string[] = [];
  for (let directory = dirname(file); ; directory = dirname(directory)) {
    const entry = fs.lstatSync(directory);
    if (
      !entry.isDirectory() ||
      entry.uid !== uid ||
      (entry.mode & 0o777) !== 0o555 ||
      fs.realpathSync(directory) !== directory
    )
      throw Error('Worker client directory custody refused');
    states.push(stamp(entry));
    if (directory === root) break;
    if (!directory.startsWith(root + '/')) throw Error('Worker client path escaped');
  }
  return states.join(';');
}
function readFile(root: string, file: string, limit: number, mode: number, uid: number, collect = false) {
  const directories = parents(root, file, uid);
  if (fs.realpathSync(file) !== file) throw Error('Worker client path changed');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd);
    if (
      !before.isFile() ||
      before.nlink < 1 ||
      before.uid !== uid ||
      (before.mode & 0o777) !== mode ||
      before.size > limit ||
      stamp(before) !== stamp(fs.lstatSync(file))
    )
      throw Error('Worker client file custody refused');
    const hasher = createHash('sha256'),
      chunks: Buffer[] = [];
    let count = 0,
      read: number;
    do {
      const buffer = Buffer.alloc(Math.min(65536, limit + 1 - count));
      read = fs.readSync(fd, buffer, 0, buffer.length, count);
      count += read;
      if (count > limit) throw Error('Worker client file bound exceeded');
      if (read) {
        const bytes = buffer.subarray(0, read);
        hasher.update(bytes);
        if (collect) chunks.push(bytes);
      }
    } while (read > 0);
    if (
      count !== before.size ||
      stamp(before) !== stamp(fs.fstatSync(fd)) ||
      stamp(before) !== stamp(fs.lstatSync(file)) ||
      fs.realpathSync(file) !== file ||
      directories !== parents(root, file, uid)
    )
      throw Error('Worker client file changed');
    return { sha256: hasher.digest('hex'), bytes: count, content: Buffer.concat(chunks) };
  } finally {
    fs.closeSync(fd);
  }
}
/** Actual read-only file observation at an explicitly supplied artifact root.
 * It reports the actual owner UID; it never upgrades a test tree to installed code. */
export function inspectWorkerClientFiles(root: string, expectedDigest: string) {
  digest.parse(expectedDigest);
  if (fs.realpathSync(root) !== root) throw Error('Worker client root changed');
  const before = fs.lstatSync(root);
  if (!before.isDirectory() || (before.mode & 0o777) !== 0o555) throw Error('Read-only worker client root required');
  const raw = readFile(root, join(root, 'manifest.json'), 128 * 1024, 0o444, before.uid, true);
  if (raw.sha256 !== expectedDigest) throw Error('Worker client manifest differs');
  const text = raw.content.toString('utf8'),
    manifest = Manifest.parse(JSON.parse(text));
  if (!Buffer.from(text).equals(raw.content) || JSON.stringify(manifest) !== text)
    throw Error('Canonical client manifest required');
  for (const file of manifest.files) {
    const observed = readFile(root, join(root, file.path), 128 * 1024 * 1024, file.mode, before.uid);
    if (observed.sha256 !== file.sha256 || observed.bytes !== file.bytes) throw Error('Worker client artifact differs');
  }
  if (stamp(before) !== stamp(fs.lstatSync(root))) throw Error('Worker client root changed');
  return {
    version: 1 as const,
    purpose: 'reverie-worker-client-readback-v1' as const,
    manifestDigest: expectedDigest,
    entrySha256: manifest.files.find((file) => file.path === 'bin/reverie')!.sha256,
    filesChecked: manifest.files.length,
    nodeMajor: Number(process.versions.node.split('.')[0]),
    ownerUid: before.uid,
  };
}
/** Strict claimed readback DATA; an exit code or old bundle reply alone is insufficient. */
function readbackText(raw: string): string {
  if (Buffer.byteLength(raw) > 4096) throw Error('Worker readback bound exceeded');
  return raw.endsWith('\n') ? raw.slice(0, -1) : raw;
}
export function parseWorkerClientReadback(raw: string, expectedDigest: string) {
  digest.parse(expectedDigest);
  if (Buffer.byteLength(raw) > 4096) throw Error('Worker client readback bound exceeded');
  const text = readbackText(raw);
  const value = Readback.parse(JSON.parse(text));
  if (JSON.stringify(value) !== text) throw Error('Canonical worker readback required');
  if (value.manifestDigest !== expectedDigest) throw Error('Worker client readback differs');
  return value;
}
export function workerClientStatus(expectedDigest: string) {
  const value = inspectWorkerClientFiles(WORKER_CLIENT_PREFIX, expectedDigest);
  return Readback.parse(value);
}
export const workerClientDigest = hash;

const CredentialReadback = z
  .object({
    version: z.literal(1),
    purpose: z.literal('reverie-worker-credential-readback-v1'),
    manifestDigest: digest,
    sessionId: z
      .string()
      .uuid()
      .refine((value) => value === value.toLowerCase()),
    tokenDigest: digest,
  })
  .strict();
/** Actual private-file bytes only; a digest is not caller or native authority. */
export function workerCredentialDigest(env: NodeJS.ProcessEnv) {
  const sessionId = env.REVERIE_SESSION_ID;
  if (!sessionId) throw Error('Full worker session required');
  const token = readDockerWorkerIdentity(env, sessionId);
  if (!token) throw Error('Selected private worker credential required');
  return { sessionId, tokenDigest: hash(token) };
}
export function workerCredentialStatus(expectedDigest: string) {
  const capsule = workerClientStatus(expectedDigest);
  return CredentialReadback.parse({
    version: 1,
    purpose: 'reverie-worker-credential-readback-v1',
    manifestDigest: capsule.manifestDigest,
    ...workerCredentialDigest(process.env),
  });
}
export function parseWorkerCredentialReadback(raw: string, expectedDigest: string, expectedSID: string) {
  if (Buffer.byteLength(raw) > 4096) throw Error('Worker credential readback bound exceeded');
  const text = readbackText(raw);
  const result = CredentialReadback.parse(JSON.parse(text));
  if (JSON.stringify(result) !== text) throw Error('Canonical worker credential readback required');
  if (result.manifestDigest !== expectedDigest || result.sessionId !== expectedSID)
    throw Error('Worker credential readback differs');
  return result;
}
