/** A laptop's own copy of its plan sign-in, read and replaced from the office.
 *
 * The office cannot open an employee's home, so one fixed program runs inside
 * the employee's running laptop, as the laptop user, the way the plan account
 * status observer does. It finds the folder that laptop's Claude client uses
 * (the plan move generation its environment names, else the seat folder of the
 * employee's plan), and does exactly one of three things:
 *
 * - `observe`: prints what the sign-in file says without its tokens: a state,
 *   two times and the SHA-256 of its bytes.
 * - `read <digest>`: prints the file, only while it still has that digest. This
 *   is the one place sign-in bytes leave a laptop, and only for a copy the
 *   office has decided to place elsewhere.
 * - `write <digest|absent>`: replaces the file with the usable sign-in on its
 *   stdin, only while the file still has that digest and no renewal of the
 *   client is in flight. The new file is written whole under a private name,
 *   mode 0600, and renamed into place; the file it replaces is kept once
 *   beside it.
 *
 * Nothing is created but that one file: a laptop with no sign-in folder is
 * reported as holding none. The caller values are the mode, the validated
 * profile ID and a digest. One stdout line: a JSON receipt, or
 * `REFUSED <reason>` with exit status 3. */
import { z } from 'zod';
import type { DockerEngineCommand } from './docker-engine-command.js';
import type { SignInHolderPort, SignInWriteOutcome } from './plan-signin-reconciler.js';
import { SIGN_IN_FILE_LIMIT, signInView, type SignInView } from './plan-signin-sync.js';

const NODE = '/opt/reverie-worker-client/bin/node';
const PROFILE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const CONTAINER = /^[a-f0-9]{64}$/;

export const DOCKER_SIGNIN_HOLDER_PROGRAM = String.raw`
const fs = require('node:fs');
const crypto = require('node:crypto');
const HOME = '/home/agent';
const SEATS = '/instances/default/console/accounts/';
const NAME = '.credentials.json';
const argv = process.argv.slice(1), mode = argv[0], profile = argv[1], expected = argv[2];
class Refusal extends Error {}
const refuse = (reason) => { throw new Refusal(reason); };
const DIR = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
const FILE = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
const NEW = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
// The folder this laptop's client was started with. Any other value is not a
// sign-in folder the office made, and is left alone.
function locate() {
  const env = process.env.CLAUDE_CONFIG_DIR || '', moves = HOME + '/.reverie/plan-moves/';
  if (env.startsWith(moves)) {
    const found = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/generation-([a-f0-9]{64})\/claude$/
      .exec(env.slice(moves.length));
    if (!found) refuse('location');
    return { holder: 'generation', names: ['.reverie', 'plan-moves', found[1], 'generation-' + found[2], 'claude'] };
  }
  if (env !== '' && env !== SEATS + profile) refuse('location');
  return { holder: 'seat', names: ['.reverie', 'seat-auth', profile] };
}
// Every step is taken from a held directory handle and never through a link.
function folder(names) {
  const uid = BigInt(process.getuid());
  let fd;
  try { fd = fs.openSync(HOME, DIR); } catch { refuse('folder'); }
  if (fs.fstatSync(fd, { bigint: true }).uid !== uid) refuse('folder');
  for (const name of names) {
    let next;
    try { next = fs.openSync('/proc/self/fd/' + fd + '/' + name, DIR); } catch (error) {
      if (error && error.code === 'ENOENT') return undefined;
      refuse('folder');
    }
    const stat = fs.fstatSync(next, { bigint: true });
    if (!stat.isDirectory() || stat.uid !== uid) refuse('folder');
    fd = next;
  }
  return fd;
}
function entry(path) {
  try { return fs.lstatSync(path, { bigint: true }); } catch (error) {
    if (error && error.code === 'ENOENT') return undefined;
    refuse('file');
  }
}
function own(stat) {
  if (!stat.isFile() || stat.uid !== BigInt(process.getuid())) refuse('file');
}
function current(dir) {
  const path = '/proc/self/fd/' + dir + '/' + NAME, stat = entry(path);
  if (!stat) return undefined;
  own(stat);
  if (stat.size > 131072n) refuse('file');
  let fd;
  try { fd = fs.openSync(path, FILE); } catch { refuse('file'); }
  try {
    const now = fs.fstatSync(fd, { bigint: true });
    if (!now.isFile() || now.ino !== stat.ino || now.dev !== stat.dev) refuse('file');
    const bytes = Buffer.alloc(Number(now.size) + 1);
    let size = 0;
    for (let count; size < bytes.length && (count = fs.readSync(fd, bytes, size, bytes.length - size, size)) > 0;) size += count;
    if (size !== Number(now.size)) refuse('file');
    return bytes.subarray(0, size);
  } catch (error) {
    if (error instanceof Refusal) throw error;
    refuse('file');
  } finally { fs.closeSync(fd); }
}
const time = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
// The same reading the office makes of its own copy (plan-signin-sync.ts).
function view(bytes) {
  if (!bytes) return { state: 'absent' };
  const digest = sha(bytes), text = bytes.toString('utf8');
  let value;
  try { value = JSON.parse(text); } catch { return { state: 'invalid', digest }; }
  if (!Buffer.from(text).equals(bytes) || !value || typeof value !== 'object' || Array.isArray(value))
    return { state: 'invalid', digest };
  const login = value.claudeAiOauth;
  if (!login || typeof login !== 'object' || Array.isArray(login)) return { state: 'signed-out', digest };
  const refreshExpiresAt = time(login.refreshTokenExpiresAt), expiresAt = time(login.expiresAt);
  const tokens = typeof login.accessToken === 'string' && login.accessToken !== '' &&
    typeof login.refreshToken === 'string' && login.refreshToken !== '';
  return tokens && expiresAt !== undefined
    ? { state: 'usable', digest, expiresAt, ...(refreshExpiresAt === undefined ? {} : { refreshExpiresAt }) }
    : { state: 'blank', digest, ...(refreshExpiresAt === undefined ? {} : { refreshExpiresAt }) };
}
// The client holds this lock folder while it renews. A lock it stopped
// updating a minute ago is one it lost.
function refreshing(dir) {
  try {
    return Date.now() - Number(fs.lstatSync('/proc/self/fd/' + dir + '/.oauth_refresh.lock').mtimeMs) < 60000;
  } catch { return false; }
}
function input() {
  const chunks = [], buffer = Buffer.alloc(65536), pause = new Int32Array(new SharedArrayBuffer(4));
  let size = 0;
  for (let idle = 0; ;) {
    let count;
    try { count = fs.readSync(0, buffer, 0, buffer.length, null); } catch (error) {
      if (error && error.code === 'EOF') break;
      if (!error || error.code !== 'EAGAIN' || ++idle > 2000) refuse('input');
      Atomics.wait(pause, 0, 0, 5);
      continue;
    }
    if (!count) break;
    if ((size += count) > 131072) refuse('input');
    chunks.push(Buffer.from(buffer.subarray(0, count)));
  }
  return Buffer.concat(chunks);
}
function place(dir, bytes, had) {
  const base = '/proc/self/fd/' + dir + '/', pending = NAME + '.reverie-sync', previous = NAME + '.reverie-previous';
  try {
    const stale = entry(base + pending);
    if (stale) { own(stale); fs.unlinkSync(base + pending); }
    const fd = fs.openSync(base + pending, NEW, 0o600);
    try {
      for (let at = 0; at < bytes.length;) at += fs.writeSync(fd, bytes, at, bytes.length - at);
      fs.fchmodSync(fd, 0o600);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    if (had) {
      const kept = entry(base + previous);
      if (kept) { own(kept); fs.unlinkSync(base + previous); }
      fs.linkSync(base + NAME, base + previous);
    }
    fs.renameSync(base + pending, base + NAME);
    fs.fsyncSync(dir);
  } catch (error) {
    if (error instanceof Refusal) throw error;
    refuse('write');
  }
}
function main() {
  if (!['observe', 'read', 'write'].includes(mode) || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(profile || '') ||
      argv.length !== (mode === 'observe' ? 2 : 3) ||
      (mode !== 'observe' && !(/^[a-f0-9]{64}$/.test(expected) || (mode === 'write' && expected === 'absent'))))
    refuse('arguments');
  if (process.platform !== 'linux' || !(process.getuid() > 0)) refuse('user');
  process.umask(0o077);
  const incoming = mode === 'write' ? input() : undefined;
  const at = locate(), dir = folder(at.names);
  const receipt = { version: 1, purpose: 'reverie-signin-holder-v1', mode, profile, holder: at.holder };
  if (dir === undefined) return { ...receipt, state: 'none' };
  const bytes = current(dir), seen = view(bytes);
  if (mode === 'observe') return { ...receipt, ...seen, refreshing: refreshing(dir) };
  if ((seen.digest || 'absent') !== expected) refuse('changed');
  if (mode === 'read') {
    if (seen.state !== 'usable') refuse('changed');
    return { ...receipt, ...seen, text: bytes.toString('utf8') };
  }
  const wanted = view(incoming);
  if (wanted.state !== 'usable') refuse('input');
  if (refreshing(dir)) refuse('busy');
  place(dir, incoming, !!bytes);
  const after = view(current(dir));
  if (after.digest !== wanted.digest) refuse('changed');
  return { ...receipt, ...after, credential: bytes ? 'replaced' : 'installed' };
}
try {
  process.stdout.write(JSON.stringify(main()) + '\n');
} catch (error) {
  process.stdout.write('REFUSED ' + (error instanceof Refusal ? error.message : 'unexpected') + '\n');
  process.exitCode = 3;
}
`;

const time = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const receipt = z
  .object({
    version: z.literal(1),
    purpose: z.literal('reverie-signin-holder-v1'),
    mode: z.enum(['observe', 'read', 'write']),
    profile: z.string().regex(PROFILE),
    /** Which folder the laptop's client uses. */
    holder: z.enum(['seat', 'generation']),
    /** `none`: the laptop has no such folder, so it holds no copy at all. */
    state: z.enum(['none', 'absent', 'invalid', 'signed-out', 'blank', 'usable']),
    digest: z.string().regex(DIGEST).optional(),
    expiresAt: time.optional(),
    refreshExpiresAt: time.optional(),
    /** The client's own renewal lock is held right now. */
    refreshing: z.boolean().optional(),
    /** `read` only: the sign-in file. Never logged, never kept. */
    text: z.string().max(SIGN_IN_FILE_LIMIT).optional(),
    credential: z.enum(['installed', 'replaced']).optional(),
  })
  .strict();
export type DockerSignInHolderReceipt = z.infer<typeof receipt>;
export type DockerSignInHolderMode = DockerSignInHolderReceipt['mode'];

/** Pure fixed argv DATA: `docker exec` of the program in one laptop, as that laptop's own user. */
export function dockerSignInHolderArguments(
  containerId: string,
  mode: DockerSignInHolderMode,
  profileId: string,
  expected?: string
): readonly string[] {
  if (
    !CONTAINER.test(containerId) ||
    !PROFILE.test(profileId) ||
    !['observe', 'read', 'write'].includes(mode) ||
    (mode === 'observe') !== (expected === undefined) ||
    (expected !== undefined && !DIGEST.test(expected) && !(mode === 'write' && expected === 'absent'))
  )
    throw Error('Fixed sign-in holder request required');
  return [
    'exec',
    ...(mode === 'write' ? ['--interactive'] : []),
    '--workdir',
    '/',
    containerId,
    NODE,
    '--no-global-search-paths',
    '--no-addons',
    '--input-type=commonjs',
    '-e',
    DOCKER_SIGNIN_HOLDER_PROGRAM,
    '--',
    mode,
    profileId,
    ...(expected === undefined ? [] : [expected]),
  ];
}

/** What one finished program said, or the closed reason it refused with. Anything else is `unconfirmed`. */
export function readSignInHolderResult(
  output: unknown,
  wanted: { readonly mode: DockerSignInHolderMode; readonly profileId: string }
): DockerSignInHolderReceipt | { readonly refused: string } {
  if (typeof output !== 'string' || !output.endsWith('\n') || output.indexOf('\n') !== output.length - 1)
    return { refused: 'unconfirmed' };
  const line = output.slice(0, -1);
  const refusal = /^REFUSED ([a-z-]{1,40})$/.exec(line);
  if (refusal) return { refused: refusal[1]! };
  let parsed: ReturnType<typeof receipt.safeParse>;
  try {
    parsed = receipt.safeParse(JSON.parse(line));
  } catch {
    return { refused: 'unconfirmed' };
  }
  if (!parsed.success || parsed.data.mode !== wanted.mode || parsed.data.profile !== wanted.profileId)
    return { refused: 'unconfirmed' };
  const value = parsed.data;
  // A receipt must agree with itself: a digest exactly when there is a file, an expiry exactly when it is usable.
  if (
    (value.digest === undefined) !== (value.state === 'none' || value.state === 'absent') ||
    (value.expiresAt === undefined) !== (value.state !== 'usable') ||
    (value.text === undefined) !== (value.mode !== 'read') ||
    (value.credential === undefined) !== (value.mode !== 'write' || value.state === 'none')
  )
    return { refused: 'unconfirmed' };
  return value;
}

export interface DockerLaptopSignInHolderSpec {
  /** Stable name of this holder within its plan, e.g. `laptop:<employee id>`. */
  readonly id: string;
  /** Who it is, for the log. Never a path. */
  readonly label: string;
  readonly containerId: string;
  readonly profileId: string;
}

/** One running laptop's copy. Every failure is a closed outcome; nothing the Engine or the program printed is kept. */
export class DockerLaptopSignInHolder implements SignInHolderPort {
  readonly office = false;
  readonly id: string;
  readonly label: string;
  constructor(
    private readonly command: Pick<DockerEngineCommand, 'run'>,
    private readonly spec: DockerLaptopSignInHolderSpec,
    /** The laptop runtime is still the one this holder was listed under. */
    private readonly current: () => boolean
  ) {
    this.id = spec.id;
    this.label = spec.label;
  }

  async #run(
    mode: DockerSignInHolderMode,
    expected?: string,
    input?: string
  ): Promise<DockerSignInHolderReceipt | { readonly refused: string }> {
    if (!this.current()) return { refused: 'unconfirmed' };
    const wanted = { mode, profileId: this.spec.profileId };
    let output: unknown;
    try {
      output = await this.command.run(
        dockerSignInHolderArguments(this.spec.containerId, mode, this.spec.profileId, expected),
        input
      );
    } catch (error) {
      // The program's own refusal is exit status 3 and one fixed line. Nothing else of a failure is read.
      const failed = error as { code?: unknown; stdout?: unknown } | null;
      output = failed?.code === 3 ? failed.stdout : undefined;
      const result = readSignInHolderResult(output, wanted);
      return 'refused' in result ? result : { refused: 'unconfirmed' };
    }
    return this.current() ? readSignInHolderResult(output, wanted) : { refused: 'unconfirmed' };
  }

  async observe(): Promise<SignInView | undefined> {
    const result = await this.#run('observe');
    if ('refused' in result || result.state === 'none') return undefined;
    return {
      state: result.state,
      ...(result.digest === undefined ? {} : { digest: result.digest }),
      ...(result.expiresAt === undefined ? {} : { expiresAt: result.expiresAt }),
      ...(result.refreshExpiresAt === undefined ? {} : { refreshExpiresAt: result.refreshExpiresAt }),
    };
  }

  async read(digest: string): Promise<string | undefined> {
    if (!DIGEST.test(digest)) return undefined;
    const result = await this.#run('read', digest);
    if ('refused' in result || result.text === undefined) return undefined;
    // The bytes are the ones that were decided on, or they are not used.
    return signInView(result.text).digest === digest ? result.text : undefined;
  }

  async write(text: string, expected: SignInView): Promise<SignInWriteOutcome> {
    const wanted = signInView(text);
    if (wanted.state !== 'usable' || Buffer.byteLength(text) > SIGN_IN_FILE_LIMIT) return 'refused';
    const result = await this.#run('write', expected.digest ?? 'absent', text);
    if ('refused' in result)
      return result.refused === 'changed' ? 'changed' : result.refused === 'busy' ? 'busy' : 'refused';
    return result.state === 'usable' && result.digest === wanted.digest ? 'written' : 'refused';
  }
}
