/** Private Docker-worker callback credential reader; never falls back to a human password. */
import * as fs from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

const LIMIT = 2048;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const TOKEN = /^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/;
function stamp(value: fs.Stats): string {
  return [
    value.dev,
    value.ino,
    value.mode,
    value.uid,
    value.gid,
    value.nlink,
    value.size,
    value.mtimeMs,
    value.ctimeMs,
  ].join(':');
}
function privateParents(file: string, uid: number): void {
  if (!isAbsolute(file) || resolve(file) !== file || fs.realpathSync(file) !== file)
    throw Error('Docker worker credential path refused');
  for (let path = dirname(file); ; path = dirname(path)) {
    const entry = fs.lstatSync(path);
    if (
      !entry.isDirectory() ||
      ![0, uid].includes(entry.uid) ||
      ((entry.mode & 0o022) !== 0 && !(entry.uid === 0 && (entry.mode & 0o1000) !== 0))
    )
      throw Error('Docker worker credential directory refused');
    if (path === '/') break;
  }
}

/** The launcher supplies a fixed private HOME credential-file path, never key material.
 * Absence selects the old human client path; any selected but bad file fails closed. */
export function readDockerWorkerIdentity(env: NodeJS.ProcessEnv, sessionId: string): string | undefined {
  const file = env.REVERIE_WORKER_IDENTITY_FILE;
  if (file === undefined) return undefined;
  if (!file || !UUID.test(sessionId) || typeof process.getuid !== 'function')
    throw Error('Docker worker credential unavailable');
  const uid = process.getuid();
  privateParents(file, uid);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  let failure: unknown, token: string | undefined;
  try {
    const before = fs.fstatSync(fd);
    const namedBefore = fs.lstatSync(file);
    if (
      !before.isFile() ||
      before.uid !== uid ||
      (before.mode & 0o777) !== 0o600 ||
      before.nlink !== 1 ||
      before.size < 1 ||
      before.size > LIMIT + 1 ||
      stamp(before) !== stamp(namedBefore)
    )
      throw Error('Docker worker credential custody refused');
    const buffer = Buffer.alloc(LIMIT + 2);
    let count = 0,
      read: number;
    do {
      read = fs.readSync(fd, buffer, count, buffer.length - count, count);
      count += read;
    } while (read > 0 && count < buffer.length);
    const after = fs.fstatSync(fd),
      namedAfter = fs.lstatSync(file);
    if (count !== before.size || stamp(before) !== stamp(after) || stamp(after) !== stamp(namedAfter))
      throw Error('Docker worker credential changed');
    const bytes = buffer.subarray(0, count);
    const raw = bytes.toString('utf8');
    token = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
    if (!Buffer.from(raw).equals(bytes) || token.length > LIMIT || !TOKEN.test(token))
      throw Error('Docker worker credential malformed');
  } catch (cause) {
    failure = cause;
  }
  try {
    fs.closeSync(fd);
  } catch (cause) {
    failure =
      failure === undefined ? cause : new AggregateError([failure, cause], 'Docker worker credential close failed');
  }
  if (failure !== undefined) throw new Error('Docker worker credential unavailable', { cause: failure });
  return token;
}
