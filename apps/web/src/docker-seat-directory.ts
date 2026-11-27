/** The host folder behind a laptop's one sign-in ("seat") bind, and the
 * sign-in inside it. The Engine refuses a bind whose source is missing and the
 * office cannot write an employee's home, so one networkless helper from the
 * worker image makes the folder inside that home, as the laptop user. When the
 * office holds a signed-in copy of the plan account, the helper also places
 * that copy, read from its stdin exactly as a plan move's installer receives
 * the same bytes, and the office accepts the result by digest. The program is
 * fixed: the caller values are the validated profile ID, which names the last
 * directory, and the provider, which selects one of two fixed file names. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DockerEmployeeContinuationError } from './docker-employee-continuation.js';
import type { DockerEngineCommand } from './docker-engine-command.js';
const NODE = '/opt/reverie-worker-client/bin/node';
const PURPOSE = 'boxed-seat-prepare-v1';
const PROFILE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const AUTH_LIMIT = 128 * 1024;
/** `<home>/.reverie/seat-auth/<profile>`: each directory is made 0700 when it
 * is absent and otherwise must already be a real directory (never a link) of
 * the same user with exactly that mode. Every step is taken from a held
 * directory handle, so a path swapped underneath cannot redirect a later one.
 * Without a sign-in on stdin, a sign-in file that exists is only reported as
 * present. With one, the seat ends up holding exactly those bytes: they are
 * written whole under a private name and renamed into place, and a different
 * sign-in that was there is kept once beside it, so a token the provider
 * rotated at the office does not leave the laptop on a stale copy. A sign-in
 * path that is not a plain file of this user is refused. A directory below the
 * home, or the sign-in file, that is this user's but more permissive than 0700
 * or 0600 is narrowed to it through its held handle and read back; the home
 * itself is never changed, and nothing is ever chown-ed.
 * One stdout line: a JSON receipt, or `REFUSED <reason>` with exit status 3. */
export const DOCKER_SEAT_DIRECTORY_PROGRAM = String.raw`
const fs = require('node:fs');
const HOME = '/home/agent';
const argv = process.argv.slice(1), id = argv[0], provider = argv[1];
class Refusal extends Error {}
const refuse = (reason) => { throw new Refusal(reason); };
const FLAGS = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
const NEW = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
const tightened = [];
// A mode that grants more than the wanted one is narrowed through the held
// handle and read back; one that withholds the owner's own access is refused.
function narrow(fd, stat, wanted, label, allowed) {
  if ((stat.mode & 0o7777n) === wanted) return stat;
  if (!allowed || (stat.mode & wanted) !== wanted) refuse(label + '-mode');
  try { fs.fchmodSync(fd, Number(wanted)); } catch { refuse(label + '-mode'); }
  const after = fs.fstatSync(fd, { bigint: true });
  if ((after.mode & 0o7777n) !== wanted || after.ino !== stat.ino || after.dev !== stat.dev) refuse(label + '-mode');
  tightened.push(label);
  return after;
}
function held(path, label, mayNarrow) {
  let fd;
  try { fd = fs.openSync(path, FLAGS); } catch (error) {
    refuse(label + (error && (error.code === 'ELOOP' || error.code === 'ENOTDIR') ? '-not-directory' : '-unreadable'));
  }
  const stat = fs.fstatSync(fd, { bigint: true });
  if (!stat.isDirectory()) refuse(label + '-not-directory');
  if (stat.uid !== BigInt(process.getuid())) refuse(label + '-owner');
  return { fd, stat: narrow(fd, stat, 0o700n, label, mayNarrow) };
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
  const bytes = Buffer.concat(chunks);
  if (!bytes.length) return bytes;
  const text = bytes.toString('utf8');
  let value;
  try { value = JSON.parse(text); } catch { refuse('input'); }
  if (!Buffer.from(text).equals(bytes) || !value || typeof value !== 'object' || Array.isArray(value)) refuse('input');
  return bytes;
}
function entry(path) {
  try { return fs.lstatSync(path, { bigint: true }); } catch (error) {
    if (error && error.code === 'ENOENT') return undefined;
    refuse('credential-unreadable');
  }
}
function own(stat) {
  if (!stat.isFile() || stat.uid !== BigInt(process.getuid())) refuse('credential-foreign');
}
function privateFile(path, stat) {
  if ((stat.mode & 0o7777n) === 0o600n) return;
  let fd;
  try { fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); } catch {
    refuse('credential-mode');
  }
  try {
    const now = fs.fstatSync(fd, { bigint: true });
    if (!now.isFile() || now.ino !== stat.ino || now.dev !== stat.dev || now.uid !== stat.uid) refuse('credential-foreign');
    narrow(fd, now, 0o600n, 'credential', true);
  } finally { fs.closeSync(fd); }
}
function same(path, stat, bytes) {
  if (stat.size !== BigInt(bytes.length)) return false;
  let fd;
  try { fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); } catch {
    refuse('credential-unreadable');
  }
  try {
    const now = fs.fstatSync(fd, { bigint: true });
    if (now.ino !== stat.ino || now.dev !== stat.dev) refuse('credential-foreign');
    const read = Buffer.alloc(bytes.length + 1);
    let size = 0;
    for (let count; size < read.length && (count = fs.readSync(fd, read, size, read.length - size, size)) > 0;) size += count;
    return size === bytes.length && read.subarray(0, size).equals(bytes);
  } catch (error) {
    if (error instanceof Refusal) throw error;
    refuse('credential-unreadable');
  } finally { fs.closeSync(fd); }
}
function place(seat, name, bytes) {
  const base = '/proc/self/fd/' + seat.fd + '/', pending = name + '.reverie-seed', previous = name + '.reverie-previous';
  try {
    const stale = entry(base + pending);
    if (stale) { own(stale); fs.unlinkSync(base + pending); }
    const fd = fs.openSync(base + pending, NEW, 0o600);
    try {
      for (let at = 0; at < bytes.length;) at += fs.writeSync(fd, bytes, at, bytes.length - at);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    const before = entry(base + name);
    if (before) {
      own(before);
      const kept = entry(base + previous);
      if (kept) { own(kept); fs.unlinkSync(base + previous); }
      fs.linkSync(base + name, base + previous);
    }
    fs.renameSync(base + pending, base + name);
    fs.fsyncSync(seat.fd);
    return before ? 'refreshed' : 'installed';
  } catch (error) {
    if (error instanceof Refusal) throw error;
    refuse('credential-create');
  }
}
try {
  if (argv.length !== 2 || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id || '') || !['anthropic', 'openai'].includes(provider))
    refuse('arguments');
  if (process.platform !== 'linux' || !(process.getuid() > 0)) refuse('user');
  process.umask(0o077);
  const auth = input();
  const home = held(HOME, 'home', false);
  const created = [];
  let at = home;
  for (const [name, label] of [['.reverie', 'state'], ['seat-auth', 'seats'], [id, 'seat']]) {
    const path = '/proc/self/fd/' + at.fd + '/' + name;
    let made = false;
    try { fs.mkdirSync(path, 0o700); made = true; } catch (error) {
      if (!error || error.code !== 'EEXIST') refuse(label + '-create');
    }
    const next = held(path, label, true);
    if (made) { created.push(label); fs.fsyncSync(at.fd); }
    at = next;
  }
  const name = provider === 'anthropic' ? '.credentials.json' : 'auth.json';
  const path = '/proc/self/fd/' + at.fd + '/' + name, existing = entry(path);
  if (existing) { own(existing); privateFile(path, existing); }
  const credential = !auth.length ? (existing ? 'present' : 'absent')
    : existing && same(path, existing, auth) ? 'current' : place(at, name, auth);
  process.stdout.write(JSON.stringify({
    version: 1,
    purpose: 'reverie-seat-directory-ready-v1',
    profile: id,
    provider,
    created,
    tightened,
    credential,
    ...(auth.length
      ? { credentialDigest: require('node:crypto').createHash('sha256').update(auth).digest('hex') }
      : {}),
    home: { dev: String(home.stat.dev), ino: String(home.stat.ino) },
    seat: { dev: String(at.stat.dev), ino: String(at.stat.ino) },
  }) + '\n');
} catch (error) {
  process.stdout.write('REFUSED ' + (error instanceof Refusal ? error.message : 'unexpected') + '\n');
  process.exitCode = 3;
}
`;
const decimal = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);
const identity = z.object({ dev: decimal, ino: decimal }).strict();
const receipt = z
  .object({
    version: z.literal(1),
    purpose: z.literal('reverie-seat-directory-ready-v1'),
    profile: z.string().regex(PROFILE),
    provider: z.enum(['anthropic', 'openai']),
    created: z.array(z.enum(['state', 'seats', 'seat'])).max(3),
    /** What existed with a mode that granted too much and was narrowed. */
    tightened: z.array(z.enum(['state', 'seats', 'seat', 'credential'])).max(4),
    /** With the office's copy on stdin: `installed` (the seat had none),
     * `refreshed` (it replaced a different one, which is kept beside it once)
     * or `current` (the seat already held exactly it). Without: `present` (the
     * seat has a sign-in file, left alone) or `absent`. */
    credential: z.enum(['installed', 'refreshed', 'current', 'present', 'absent']),
    /** Of the office's copy now in the seat; never of anything else. */
    credentialDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    home: identity,
    seat: identity,
  })
  .strict()
  .refine(
    (value) => ['installed', 'refreshed', 'current'].includes(value.credential) === (value.credentialDigest !== undefined)
  );
export type DockerSeatDirectoryReceipt = z.infer<typeof receipt>;
export interface DockerSeatDirectorySpec {
  readonly imageId: string;
  /** The laptop's own `uid:gid`; the folder is made by, and for, that user. */
  readonly user: string;
  /** Host path of the employee's private home, exactly as the laptop binds it. */
  readonly homeSource: string;
  readonly profileId: string;
  readonly provider: 'anthropic' | 'openai';
}
function refuse(code: string): never {
  throw new DockerEmployeeContinuationError(code);
}
/** A refusal keeps only its closed class; what the helper printed is dropped. */
export function seatDirectoryRefusal(reason: string): string {
  if (/^home-(?:not-directory|unreadable|owner|mode)$/.test(reason) || reason === 'user')
    return 'DOCKER_REPROVISION_SEAT_HOME_FOREIGN';
  if (
    /^(?:state|seats|seat)-(?:not-directory|unreadable|owner|mode)$/.test(reason) ||
    reason === 'credential-foreign' ||
    reason === 'credential-mode'
  )
    return 'DOCKER_REPROVISION_SEAT_DIRECTORY_FOREIGN';
  if (/^(?:state|seats|seat|credential)-create$/.test(reason)) return 'DOCKER_REPROVISION_SEAT_DIRECTORY_UNWRITABLE';
  return 'DOCKER_REPROVISION_SEAT_PREPARATION_UNCONFIRMED';
}
/** What one exited helper said. Anything but one exact line is unconfirmed. */
export function readSeatDirectoryResult(
  exitCode: unknown,
  output: string,
  spec: Pick<DockerSeatDirectorySpec, 'profileId' | 'provider'>
): DockerSeatDirectoryReceipt {
  if (
    typeof output !== 'string' ||
    output.length > 1024 ||
    !output.endsWith('\n') ||
    output.indexOf('\n') !== output.length - 1
  )
    return refuse('DOCKER_REPROVISION_SEAT_PREPARATION_UNCONFIRMED');
  const line = output.slice(0, -1);
  if (exitCode === 3 && line.startsWith('REFUSED ')) return refuse(seatDirectoryRefusal(line.slice('REFUSED '.length)));
  if (exitCode !== 0) return refuse('DOCKER_REPROVISION_SEAT_PREPARATION_UNCONFIRMED');
  let parsed: ReturnType<typeof receipt.safeParse>;
  try {
    parsed = receipt.safeParse(JSON.parse(line));
  } catch {
    return refuse('DOCKER_REPROVISION_SEAT_PREPARATION_UNCONFIRMED');
  }
  if (
    !parsed.success ||
    parsed.data.profile !== spec.profileId ||
    parsed.data.provider !== spec.provider ||
    (parsed.data.seat.ino === parsed.data.home.ino && parsed.data.seat.dev === parsed.data.home.dev)
  )
    return refuse('DOCKER_REPROVISION_SEAT_PREPARATION_UNCONFIRMED');
  return parsed.data;
}
function validSpec(name: string, spec: DockerSeatDirectorySpec): boolean {
  return (
    /^reverie-boxed-seat-prepare-[a-f0-9]{32}$/.test(name) &&
    /^sha256:[a-f0-9]{64}$/.test(spec.imageId) &&
    /^[1-9][0-9]{0,9}:[0-9]{1,10}$/.test(spec.user) &&
    PROFILE.test(spec.profileId) &&
    ['anthropic', 'openai'].includes(spec.provider) &&
    spec.homeSource.startsWith('/') &&
    spec.homeSource.length <= 4096 &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f,]/.test(spec.homeSource) &&
    !spec.homeSource.split('/').some((part) => part === '..' || part === '.')
  );
}
/** The same private-payload rule as the plan installer's `auth` member. */
function validAuth(auth: string): boolean {
  if (!auth.length || Buffer.byteLength(auth) > AUTH_LIMIT) return false;
  try {
    const value: unknown = JSON.parse(auth);
    return !!value && typeof value === 'object' && !Array.isArray(value);
  } catch {
    return false;
  }
}
/** No network, no capability, read-only root; only the one home is writable.
 * The sign-in never appears here: it reaches the program on stdin alone. */
export function seatDirectoryHelperConfiguration(spec: DockerSeatDirectorySpec): Record<string, unknown> {
  return {
    Image: spec.imageId,
    User: spec.user,
    WorkingDir: '/',
    Entrypoint: [NODE],
    Cmd: ['--input-type=commonjs', '-e', DOCKER_SEAT_DIRECTORY_PROGRAM, '--', spec.profileId, spec.provider],
    Env: [],
    Healthcheck: { Test: ['NONE'] },
    Labels: { 'org.reverie.purpose': PURPOSE },
    NetworkDisabled: true,
    OpenStdin: true,
    StdinOnce: true,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    HostConfig: {
      Privileged: false,
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      NetworkMode: 'none',
      RestartPolicy: { Name: 'no' },
      Memory: 256 * 1024 * 1024,
      MemorySwap: 256 * 1024 * 1024,
      PidsLimit: 32,
      Mounts: [
        {
          Type: 'bind',
          Source: spec.homeSource,
          Target: '/home/agent',
          ReadOnly: false,
          BindOptions: { Propagation: 'rprivate' },
        },
      ],
    },
  };
}
const inspected = z
  .array(
    z
      .object({
        Id: z.string(),
        Name: z.string(),
        Image: z.string(),
        State: z
          .object({
            Status: z.string(),
            Running: z.boolean(),
            ExitCode: z.number().int().optional(),
            OOMKilled: z.boolean().optional(),
          })
          .passthrough(),
        Config: z
          .object({
            User: z.string(),
            Entrypoint: z.array(z.string()).nullable(),
            Cmd: z.array(z.string()).nullable(),
            Labels: z.record(z.string(), z.string()).nullable(),
          })
          .passthrough(),
        HostConfig: z.object({ Privileged: z.boolean().optional(), NetworkMode: z.string().optional() }).passthrough(),
        Mounts: z.array(z.object({ Type: z.string(), Source: z.string(), Destination: z.string() }).passthrough()),
      })
      .passthrough()
  )
  .length(1);
export interface SeatDirectoryTiming {
  readonly waitMs: number;
  readonly pollMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}
const TIMING: SeatDirectoryTiming = {
  waitMs: 60_000,
  pollMs: 500,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: Date.now,
};
/** Create (or find by its fixed name), start, await and read one helper, then
 * remove it. `auth` is the office's signed-in copy of the plan account, or
 * undefined when it has none; it travels on the helper's stdin only. The
 * program only ever adds what is missing, so an exited helper of either
 * outcome is removed and the same request may run it again; a helper that has
 * not exited is left alone and reported as unconfirmed. */
export async function prepareSeatDirectory(
  command: Pick<DockerEngineCommand, 'run' | 'create'>,
  name: string,
  spec: DockerSeatDirectorySpec,
  requireCurrent: () => void,
  auth?: string,
  timing: SeatDirectoryTiming = TIMING
): Promise<DockerSeatDirectoryReceipt> {
  if (!validSpec(name, spec) || (auth !== undefined && !validAuth(auth)))
    throw Error('Fixed seat directory preparation required');
  const configuration = seatDirectoryHelperConfiguration(spec),
    wanted = configuration.Cmd as string[];
  const unconfirmed = (): never => refuse('DOCKER_REPROVISION_SEAT_PREPARATION_UNCONFIRMED');
  const state = async (id: string) => {
    const rows = inspected.safeParse(JSON.parse(await command.run(['container', 'inspect', id])));
    const row = rows.success ? rows.data[0]! : unconfirmed();
    // Exactly this helper: same image, user, program, profile and one home bind.
    if (
      row.Id !== id ||
      row.Name !== '/' + name ||
      row.Image !== spec.imageId ||
      row.Config.User !== spec.user ||
      row.Config.Labels?.['org.reverie.purpose'] !== PURPOSE ||
      row.Config.Entrypoint?.length !== 1 ||
      row.Config.Entrypoint[0] !== NODE ||
      row.Config.Cmd?.length !== wanted.length ||
      row.Config.Cmd.some((value, index) => value !== wanted[index]) ||
      row.HostConfig.Privileged === true ||
      row.HostConfig.NetworkMode !== 'none' ||
      row.Mounts.length !== 1 ||
      row.Mounts[0]!.Type !== 'bind' ||
      row.Mounts[0]!.Source !== spec.homeSource ||
      row.Mounts[0]!.Destination !== '/home/agent'
    )
      return unconfirmed();
    return row.State;
  };
  requireCurrent();
  const listed = (
    await command.run([
      'container',
      'ls',
      '--all',
      '--no-trunc',
      '--filter',
      'name=^/' + name + '$',
      '--format',
      '{{.ID}}',
    ])
  )
    .split('\n')
    .filter((line) => line !== '');
  if (listed.length > 1 || listed.some((id) => !/^[a-f0-9]{64}$/.test(id))) unconfirmed();
  requireCurrent();
  const id = listed[0] ?? (await command.create(name, configuration, requireCurrent));
  let value = await state(id);
  if (value.Status === 'created') {
    requireCurrent();
    // Always attached: the program reads its stdin to the end, which an empty
    // input closes at once.
    await command.run(['container', 'start', '--interactive', id], auth ?? '');
    value = await state(id);
  }
  const end = timing.now() + timing.waitMs;
  while (value.Running || value.Status === 'running') {
    if (timing.now() >= end) unconfirmed();
    await timing.sleep(timing.pollMs);
    value = await state(id);
  }
  if (value.Status !== 'exited' || typeof value.ExitCode !== 'number' || value.OOMKilled === true) unconfirmed();
  const output = await command.run(['container', 'logs', id]);
  await command.run(['container', 'rm', id]);
  const result = readSeatDirectoryResult(value.ExitCode, output, spec);
  // Given a sign-in, the seat now holds exactly that one, or nothing is vouched
  // for. (The helper is already removed, so the same request runs a fresh one.)
  if (auth !== undefined && result.credentialDigest !== createHash('sha256').update(auth).digest('hex')) unconfirmed();
  return result;
}
