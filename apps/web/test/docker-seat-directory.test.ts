/** The fixed sign-in folder helper. The program itself runs here against a
 * temporary directory that stands in for the laptop home; the helper lifecycle
 * runs over an in-memory Engine. No container, socket or live data is touched,
 * and every sign-in below is synthetic text. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DOCKER_SEAT_DIRECTORY_PROGRAM,
  prepareSeatDirectory,
  readSeatDirectoryResult,
  seatDirectoryHelperConfiguration,
  seatDirectoryRefusal,
  type SeatDirectoryTiming,
} from '../src/docker-seat-directory.js';
import { dockerRecoveryGuidance } from '../src/docker-recovery-guidance.js';

const profile = 'anthropic-26494e93';
const claude = { profileId: profile, provider: 'anthropic' as const };
const auth = JSON.stringify({ claudeAiOauth: { accessToken: 'SYNTHETIC_ACCESS', refreshToken: 'SYNTHETIC_REFRESH' } });
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const cleanups: string[] = [];
afterEach(() => {
  for (const directory of cleanups.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
function home(): string {
  const directory = fs.mkdtempSync(join(tmpdir(), 'seat-home-'));
  cleanups.push(directory);
  fs.chmodSync(directory, 0o700);
  return directory;
}
/** The shipped program text; only its fixed home constant points elsewhere. */
function program(root: string): string {
  const fixed = "const HOME = '/home/agent';";
  expect(DOCKER_SEAT_DIRECTORY_PROGRAM.split(fixed)).toHaveLength(2);
  return DOCKER_SEAT_DIRECTORY_PROGRAM.replace(fixed, () => 'const HOME = ' + JSON.stringify(root) + ';');
}
function run(root: string, args: string[], input = ''): { status: number; output: string } {
  try {
    const output = execFileSync(process.execPath, ['--input-type=commonjs', '-e', program(root), '--', ...args], {
      encoding: 'utf8',
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { status: 0, output };
  } catch (error) {
    const failed = error as { status: number; stdout: string };
    return { status: failed.status, output: failed.stdout };
  }
}
const mode = (path: string) => fs.lstatSync(path).mode & 0o7777;
const seatOf = (root: string, id = profile) => join(root, '.reverie', 'seat-auth', id);

describe('the fixed sign-in folder program', () => {
  it('makes the three private folders in a home that has none and says which', () => {
    const root = home(),
      seat = seatOf(root);
    const first = run(root, [profile, 'anthropic']);
    expect(first.status).toBe(0);
    const receipt = readSeatDirectoryResult(first.status, first.output, claude);
    expect(receipt.created).toEqual(['state', 'seats', 'seat']);
    expect(receipt.credential).toBe('absent');
    expect(receipt.seat.ino).toBe(String(fs.statSync(seat, { bigint: true }).ino));
    for (const path of [join(root, '.reverie'), join(root, '.reverie', 'seat-auth'), seat]) {
      expect(fs.lstatSync(path).isDirectory()).toBe(true);
      expect(mode(path)).toBe(0o700);
      expect(fs.lstatSync(path).uid).toBe(process.getuid!());
    }
    expect(fs.readdirSync(seat)).toEqual([]);
  });
  it('places the sign-in it is given into a seat that has none, privately and whole', () => {
    const root = home(),
      file = join(seatOf(root), '.credentials.json');
    const result = run(root, [profile, 'anthropic'], auth);
    const receipt = readSeatDirectoryResult(result.status, result.output, claude);
    expect(receipt).toMatchObject({ credential: 'installed', credentialDigest: digest(auth) });
    expect(fs.readFileSync(file, 'utf8')).toBe(auth);
    expect(mode(file)).toBe(0o600);
    expect(fs.readdirSync(seatOf(root))).toEqual(['.credentials.json']);
    // The receipt carries a digest only, never the sign-in.
    expect(result.output).not.toContain('SYNTHETIC');
    // Codex keeps its sign-in under its own fixed name.
    const codex = run(root, ['openai-ed0348c4', 'openai'], auth);
    expect(
      readSeatDirectoryResult(codex.status, codex.output, { profileId: 'openai-ed0348c4', provider: 'openai' })
    ).toMatchObject({ created: ['seat'], credential: 'installed' });
    expect(fs.readdirSync(seatOf(root, 'openai-ed0348c4'))).toEqual(['auth.json']);
  });
  it('leaves a sign-in the seat already has alone when it is given none', () => {
    const root = home(),
      file = join(seatOf(root), '.credentials.json');
    expect(run(root, [profile, 'anthropic']).status).toBe(0);
    fs.writeFileSync(file, '{"own":"older"}', { mode: 0o600 });
    const before = fs.statSync(file, { bigint: true });
    const again = run(root, [profile, 'anthropic']);
    const receipt = readSeatDirectoryResult(again.status, again.output, claude);
    expect(receipt).toMatchObject({ created: [], credential: 'present' });
    expect(receipt.credentialDigest).toBeUndefined();
    expect(fs.readFileSync(file, 'utf8')).toBe('{"own":"older"}');
    expect(fs.statSync(file, { bigint: true }).ino).toBe(before.ino);
    expect(fs.readdirSync(seatOf(root))).toEqual(['.credentials.json']);
  });
  it('refreshes a different sign-in with the one it is given, keeps the old one once, and is then idempotent', () => {
    const root = home(),
      file = join(seatOf(root), '.credentials.json'),
      previous = file + '.reverie-previous';
    fs.mkdirSync(seatOf(root), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, '{"own":"older"}', { mode: 0o600 });
    const first = run(root, [profile, 'anthropic'], auth);
    expect(readSeatDirectoryResult(first.status, first.output, claude)).toMatchObject({
      credential: 'refreshed',
      credentialDigest: digest(auth),
    });
    expect(fs.readFileSync(file, 'utf8')).toBe(auth);
    expect(mode(file)).toBe(0o600);
    expect(fs.readFileSync(previous, 'utf8')).toBe('{"own":"older"}');
    expect(mode(previous)).toBe(0o600);
    // The same sign-in again changes nothing.
    const stamp = fs.statSync(file, { bigint: true });
    const second = run(root, [profile, 'anthropic'], auth);
    expect(readSeatDirectoryResult(second.status, second.output, claude)).toMatchObject({
      credential: 'current',
      credentialDigest: digest(auth),
    });
    expect(fs.statSync(file, { bigint: true }).ino).toBe(stamp.ino);
    // A later rotation replaces it again; only the one before it is kept.
    const rotated = JSON.stringify({ claudeAiOauth: { accessToken: 'SYNTHETIC_ROTATED' } });
    const third = run(root, [profile, 'anthropic'], rotated);
    expect(readSeatDirectoryResult(third.status, third.output, claude).credential).toBe('refreshed');
    expect(fs.readFileSync(file, 'utf8')).toBe(rotated);
    expect(fs.readFileSync(previous, 'utf8')).toBe(auth);
    expect(fs.readdirSync(seatOf(root)).sort()).toEqual(['.credentials.json', '.credentials.json.reverie-previous']);
    expect(third.output).not.toContain('SYNTHETIC');
  });
  it('clears its own interrupted earlier attempt and refuses a sign-in path that is not a plain file', () => {
    const stale = home();
    fs.mkdirSync(seatOf(stale), { recursive: true, mode: 0o700 });
    fs.writeFileSync(join(seatOf(stale), '.credentials.json.reverie-seed'), '{"half":', { mode: 0o600 });
    const result = run(stale, [profile, 'anthropic'], auth);
    expect(readSeatDirectoryResult(result.status, result.output, claude).credential).toBe('installed');
    expect(fs.readdirSync(seatOf(stale))).toEqual(['.credentials.json']);
    const linked = home(),
      elsewhere = join(home(), 'target');
    fs.mkdirSync(seatOf(linked), { recursive: true, mode: 0o700 });
    fs.symlinkSync(elsewhere, join(seatOf(linked), '.credentials.json'));
    expect(run(linked, [profile, 'anthropic'], auth)).toEqual({ status: 3, output: 'REFUSED credential-foreign\n' });
    expect(fs.existsSync(elsewhere)).toBe(false);
  });
  it.each(['not json', '[]', '"text"', 'null', '{"a":1}' + 'x'.repeat(140000)])(
    'writes nothing for a sign-in that is not one bounded JSON object: %#',
    (input) => {
      const root = home();
      expect(run(root, [profile, 'anthropic'], input)).toEqual({ status: 3, output: 'REFUSED input\n' });
      expect(fs.readdirSync(root)).toEqual([]);
    }
  );
  it('refuses a link at any of the three places and creates nothing behind it', () => {
    for (const place of ['.reverie', '.reverie/seat-auth', '.reverie/seat-auth/' + profile]) {
      const root = home(),
        elsewhere = home();
      const parts = place.split('/');
      fs.mkdirSync(join(root, ...parts.slice(0, -1)), { recursive: true, mode: 0o700 });
      fs.symlinkSync(elsewhere, join(root, ...parts));
      const result = run(root, [profile, 'anthropic'], auth);
      expect(result.status).toBe(3);
      expect(result.output).toMatch(/^REFUSED (state|seats|seat)-not-directory\n$/);
      expect(fs.readdirSync(elsewhere)).toEqual([]);
      expect(() => readSeatDirectoryResult(result.status, result.output, claude)).toThrow(
        'DOCKER_REPROVISION_SEAT_DIRECTORY_FOREIGN'
      );
    }
  });
  it.each([
    ['.reverie', 'state', 0o770],
    // The live case: a seat parent left `drwxr-xr-x` above a private profile folder.
    ['.reverie/seat-auth', 'seats', 0o755],
    ['.reverie/seat-auth/' + profile, 'seat', 0o755],
    ['.reverie/seat-auth/' + profile, 'seat', 0o2777],
  ])('narrows its own too-permissive folder %s to 0700 and goes on', (place, label, loose) => {
    const root = home(),
      path = join(root, ...place.split('/'));
    fs.mkdirSync(seatOf(root), { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(path, loose);
    } catch (error) {
      // A build sandbox refuses to set the set-group-id bit; the plain permission bits still exercise the narrowing.
      if ((error as NodeJS.ErrnoException).code !== 'EPERM' || (loose & 0o7000) === 0) throw error;
      fs.chmodSync(path, loose & 0o777);
    }
    const result = run(root, [profile, 'anthropic'], auth);
    const receipt = readSeatDirectoryResult(result.status, result.output, claude);
    expect(receipt).toMatchObject({ created: [], tightened: [label], credential: 'installed' });
    for (const each of [join(root, '.reverie'), join(root, '.reverie', 'seat-auth'), seatOf(root)])
      expect(mode(each)).toBe(0o700);
    // A second run finds nothing left to narrow.
    const again = run(root, [profile, 'anthropic'], auth);
    expect(readSeatDirectoryResult(again.status, again.output, claude)).toMatchObject({
      tightened: [],
      credential: 'current',
    });
  });
  it('narrows its own too-permissive sign-in file to 0600, whether or not it is given one', () => {
    for (const input of ['', auth]) {
      const root = home(),
        file = join(seatOf(root), '.credentials.json');
      fs.mkdirSync(seatOf(root), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, auth, { mode: 0o600 });
      fs.chmodSync(file, 0o644);
      const result = run(root, [profile, 'anthropic'], input);
      expect(readSeatDirectoryResult(result.status, result.output, claude)).toMatchObject({
        tightened: ['credential'],
        credential: input ? 'current' : 'present',
      });
      expect(mode(file)).toBe(0o600);
      expect(fs.readFileSync(file, 'utf8')).toBe(auth);
    }
    // A replaced sign-in is narrowed before it is kept beside the new one.
    const root = home(),
      file = join(seatOf(root), '.credentials.json');
    fs.mkdirSync(seatOf(root), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, '{"own":"older"}');
    fs.chmodSync(file, 0o664);
    const result = run(root, [profile, 'anthropic'], auth);
    expect(readSeatDirectoryResult(result.status, result.output, claude)).toMatchObject({
      tightened: ['credential'],
      credential: 'refreshed',
    });
    expect(mode(file)).toBe(0o600);
    expect(mode(file + '.reverie-previous')).toBe(0o600);
  });
  it('still refuses what narrowing cannot make right, without changing it', () => {
    // A mode that withholds the owner's own access is not "too permissive".
    const closed = home();
    fs.mkdirSync(seatOf(closed), { recursive: true, mode: 0o700 });
    fs.chmodSync(seatOf(closed), 0o500);
    expect(run(closed, [profile, 'anthropic'], auth)).toEqual({ status: 3, output: 'REFUSED seat-mode\n' });
    expect(mode(seatOf(closed))).toBe(0o500);
    fs.chmodSync(seatOf(closed), 0o700);
    const readOnly = home(),
      credential = join(seatOf(readOnly), '.credentials.json');
    fs.mkdirSync(seatOf(readOnly), { recursive: true, mode: 0o700 });
    fs.writeFileSync(credential, auth);
    fs.chmodSync(credential, 0o400);
    expect(run(readOnly, [profile, 'anthropic'], auth)).toEqual({ status: 3, output: 'REFUSED credential-mode\n' });
    expect(mode(credential)).toBe(0o400);
    expect(() => readSeatDirectoryResult(3, 'REFUSED credential-mode\n', claude)).toThrow(
      'DOCKER_REPROVISION_SEAT_DIRECTORY_FOREIGN'
    );
    // Not a directory at all.
    const file = home();
    fs.mkdirSync(join(file, '.reverie', 'seat-auth'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(seatOf(file), '');
    expect(run(file, [profile, 'anthropic'])).toEqual({ status: 3, output: 'REFUSED seat-not-directory\n' });
    // The home itself is never changed: one that is not private is refused as before.
    const shared = home();
    fs.chmodSync(shared, 0o755);
    expect(run(shared, [profile, 'anthropic'], auth)).toEqual({ status: 3, output: 'REFUSED home-mode\n' });
    expect(mode(shared)).toBe(0o755);
  });
  it('refuses a home that is not private, and one that is not there', () => {
    const shared = home();
    fs.chmodSync(shared, 0o755);
    expect(run(shared, [profile, 'anthropic'])).toEqual({ status: 3, output: 'REFUSED home-mode\n' });
    expect(fs.readdirSync(shared)).toEqual([]);
    const missing = join(home(), 'absent');
    expect(run(missing, [profile, 'anthropic'])).toEqual({ status: 3, output: 'REFUSED home-unreadable\n' });
  });
  it.each([
    [[]],
    [[profile]],
    [['../escape', 'anthropic']],
    [['a/b', 'anthropic']],
    [['Upper', 'anthropic']],
    [['-x', 'anthropic']],
    [[profile, 'google']],
    [[profile, 'anthropic', 'extra']],
    [['x'.repeat(65), 'anthropic']],
  ])('takes exactly one validated profile ID and one known provider: %j', (args) => {
    const root = home();
    expect(run(root, args, auth)).toEqual({ status: 3, output: 'REFUSED arguments\n' });
    expect(fs.readdirSync(root)).toEqual([]);
  });
});

const receiptLine = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: 1,
    purpose: 'reverie-seat-directory-ready-v1',
    profile,
    provider: 'anthropic',
    created: ['seat'],
    tightened: [],
    credential: 'absent',
    home: { dev: '64', ino: '10' },
    seat: { dev: '64', ino: '12' },
    ...extra,
  }) + '\n';

describe('reading what the helper said', () => {
  it('accepts one exact receipt for the requested profile and provider', () => {
    expect(readSeatDirectoryResult(0, receiptLine(), claude).created).toEqual(['seat']);
    expect(
      readSeatDirectoryResult(0, receiptLine({ credential: 'installed', credentialDigest: 'a'.repeat(64) }), claude)
        .credential
    ).toBe('installed');
  });
  it.each([
    [0, receiptLine({ profile: 'openai-ed0348c4' })],
    [0, receiptLine({ provider: 'openai' })],
    [0, receiptLine({ extra: true })],
    [0, receiptLine({ credential: 'installed' })],
    [0, receiptLine({ credential: 'present', credentialDigest: 'a'.repeat(64) })],
    [0, receiptLine({ seat: { dev: '64', ino: '10' } })],
    [0, receiptLine() + receiptLine()],
    [0, receiptLine().trimEnd()],
    [0, ''],
    [0, 'REFUSED seat-mode\n'],
    [1, receiptLine()],
    [137, ''],
    [3, 'REFUSED something-new\n'],
    [3, 'x'.repeat(2000) + '\n'],
  ])('holds anything else as unconfirmed: exit %s', (status, output) => {
    expect(() => readSeatDirectoryResult(status, output, claude)).toThrow(
      'DOCKER_REPROVISION_SEAT_PREPARATION_UNCONFIRMED'
    );
  });
  it('keeps only a closed class of each refusal, each with guidance', () => {
    expect(seatDirectoryRefusal('home-owner')).toBe('DOCKER_REPROVISION_SEAT_HOME_FOREIGN');
    expect(seatDirectoryRefusal('home-mode')).toBe('DOCKER_REPROVISION_SEAT_HOME_FOREIGN');
    expect(seatDirectoryRefusal('user')).toBe('DOCKER_REPROVISION_SEAT_HOME_FOREIGN');
    expect(seatDirectoryRefusal('seats-owner')).toBe('DOCKER_REPROVISION_SEAT_DIRECTORY_FOREIGN');
    expect(seatDirectoryRefusal('seat-not-directory')).toBe('DOCKER_REPROVISION_SEAT_DIRECTORY_FOREIGN');
    expect(seatDirectoryRefusal('credential-foreign')).toBe('DOCKER_REPROVISION_SEAT_DIRECTORY_FOREIGN');
    expect(seatDirectoryRefusal('state-create')).toBe('DOCKER_REPROVISION_SEAT_DIRECTORY_UNWRITABLE');
    expect(seatDirectoryRefusal('credential-create')).toBe('DOCKER_REPROVISION_SEAT_DIRECTORY_UNWRITABLE');
    expect(seatDirectoryRefusal('arguments')).toBe('DOCKER_REPROVISION_SEAT_PREPARATION_UNCONFIRMED');
    expect(seatDirectoryRefusal('input')).toBe('DOCKER_REPROVISION_SEAT_PREPARATION_UNCONFIRMED');
    expect(seatDirectoryRefusal('seat-mode /private/host/path')).toBe(
      'DOCKER_REPROVISION_SEAT_PREPARATION_UNCONFIRMED'
    );
    for (const code of [
      'DOCKER_REPROVISION_SEAT_ACCOUNT_SIGNED_OUT',
      'DOCKER_REPROVISION_SEAT_HOME_FOREIGN',
      'DOCKER_REPROVISION_SEAT_DIRECTORY_FOREIGN',
      'DOCKER_REPROVISION_SEAT_DIRECTORY_UNWRITABLE',
      'DOCKER_REPROVISION_SEAT_PREPARATION_UNCONFIRMED',
      'DOCKER_CONTINUATION_CREATE_BIND_SOURCE_MISSING',
      'DOCKER_CONTINUATION_CREATE_CONFIG_REJECTED',
    ]) {
      const guidance = dockerRecoveryGuidance(code)!;
      expect(guidance.message.length).toBeGreaterThan(80);
      expect(guidance.allowedActions).toEqual(['retry']);
    }
    expect(dockerRecoveryGuidance('DOCKER_REPROVISION_SEAT_ACCOUNT_SIGNED_OUT')!.message).toContain('Plans page');
    expect(dockerRecoveryGuidance('DOCKER_REPROVISION_SEAT_PREPARATION_UNAVAILABLE')!.allowedActions).toEqual([]);
  });
});

type Json = Record<string, unknown>;
const image = 'sha256:' + 'e'.repeat(64),
  name = 'reverie-boxed-seat-prepare-' + '6'.repeat(32),
  helperId = 'f'.repeat(64),
  spec = { imageId: image, user: '1000:1000', homeSource: '/synthetic-state/employees/e/home', ...claude };
const timing: SeatDirectoryTiming = { waitMs: 1000, pollMs: 1, sleep: async () => {}, now: () => 0 };
/** One helper container: what `start` makes of it is the scenario. By default
 * it behaves as the program does for an empty seat. */
class Helpers {
  readonly rows = new Map<string, Json>();
  readonly calls: string[] = [];
  readonly inputs: Array<string | undefined> = [];
  outcome: ((input: string) => { exit: number; output: string }) | 'running' = (input) => ({
    exit: 0,
    output: receiptLine(
      input ? { created: ['seats', 'seat'], credential: 'installed', credentialDigest: digest(input) } : {}
    ),
  });
  output = '';
  async run(args: readonly string[], input?: string): Promise<string> {
    this.calls.push(args.slice(0, 2).join(' '));
    const [, verb] = args,
      id = args[args.length - 1]!;
    if (verb === 'ls')
      return [...this.rows.values()]
        .filter((row) => '^' + row.Name + '$' === args[args.indexOf('--filter') + 1]!.slice('name='.length))
        .map((row) => row.Id + '\n')
        .join('');
    const row = this.rows.get(id);
    if (!row) throw Error('No such container');
    if (verb === 'inspect') return JSON.stringify([row]);
    if (verb === 'start') {
      // Attached, or the program would wait for its stdin for ever.
      expect(args).toEqual(['container', 'start', '--interactive', id]);
      this.inputs.push(input);
      const state = row.State as Json;
      if (this.outcome === 'running') Object.assign(state, { Status: 'running', Running: true });
      else {
        const done = this.outcome(input ?? '');
        Object.assign(state, { Status: 'exited', Running: false, ExitCode: done.exit, OOMKilled: false });
        this.output = done.output;
      }
      return '';
    }
    if (verb === 'logs') return this.output;
    if (verb === 'rm') {
      this.rows.delete(id);
      return id + '\n';
    }
    throw Error('Unexpected synthetic Engine command: ' + args.join(' '));
  }
  async create(called: string, configuration: Json, current: () => void): Promise<string> {
    current();
    this.calls.push('create');
    const host = configuration.HostConfig as Json;
    this.rows.set(helperId, {
      Id: helperId,
      Name: '/' + called,
      Image: configuration.Image,
      State: { Status: 'created', Running: false },
      Config: {
        User: configuration.User,
        Entrypoint: configuration.Entrypoint,
        Cmd: configuration.Cmd,
        Labels: configuration.Labels,
      },
      HostConfig: { Privileged: host.Privileged, NetworkMode: host.NetworkMode },
      Mounts: (host.Mounts as Json[]).map((mount) => ({
        Type: mount.Type,
        Source: mount.Source,
        Destination: mount.Target,
        RW: mount.ReadOnly !== true,
      })),
    });
    return helperId;
  }
}

describe('the sign-in folder helper container', () => {
  it('is networkless and unprivileged, runs as the laptop user and can write only the one home', () => {
    const configuration = seatDirectoryHelperConfiguration(spec),
      host = configuration.HostConfig as Json;
    expect(configuration).toMatchObject({
      Image: image,
      User: '1000:1000',
      Entrypoint: ['/opt/reverie-worker-client/bin/node'],
      Cmd: ['--input-type=commonjs', '-e', DOCKER_SEAT_DIRECTORY_PROGRAM, '--', profile, 'anthropic'],
      Env: [],
      NetworkDisabled: true,
      OpenStdin: true,
      StdinOnce: true,
      Tty: false,
    });
    expect(host).toMatchObject({
      Privileged: false,
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      NetworkMode: 'none',
    });
    expect(host.Mounts).toEqual([
      {
        Type: 'bind',
        Source: spec.homeSource,
        Target: '/home/agent',
        ReadOnly: false,
        BindOptions: { Propagation: 'rprivate' },
      },
    ]);
    // Neither the host path nor any sign-in is part of what the Engine stores.
    expect(JSON.stringify({ ...configuration, HostConfig: { ...host, Mounts: [] } })).not.toContain(spec.homeSource);
  });
  it('creates, starts, reads and removes one helper, with an empty stdin when there is no sign-in to place', async () => {
    const engine = new Helpers();
    const receipt = await prepareSeatDirectory(engine, name, spec, () => {}, undefined, timing);
    expect(receipt.credential).toBe('absent');
    expect(engine.inputs).toEqual(['']);
    expect(engine.calls).toEqual([
      'container ls',
      'create',
      'container inspect',
      'container start',
      'container inspect',
      'container logs',
      'container rm',
    ]);
    expect(engine.rows.size).toBe(0);
  });
  it('hands the sign-in to the helper on stdin only and vouches for it by digest', async () => {
    const engine = new Helpers();
    const receipt = await prepareSeatDirectory(engine, name, spec, () => {}, auth, timing);
    expect(receipt).toMatchObject({ credential: 'installed', credentialDigest: digest(auth) });
    expect(engine.inputs).toEqual([auth]);
    // A helper that reports having placed something else is not believed.
    const lying = new Helpers();
    lying.outcome = () => ({
      exit: 0,
      output: receiptLine({ credential: 'installed', credentialDigest: 'b'.repeat(64) }),
    });
    await expect(prepareSeatDirectory(lying, name, spec, () => {}, auth, timing)).rejects.toMatchObject({
      code: 'DOCKER_REPROVISION_SEAT_PREPARATION_UNCONFIRMED',
    });
    for (const bad of ['', 'not json', '[]', '{"a":"' + 'x'.repeat(140000) + '"}'])
      await expect(prepareSeatDirectory(new Helpers(), name, spec, () => {}, bad, timing)).rejects.toThrow(
        'Fixed seat directory preparation required'
      );
  });
  it('reports a refusal by its class, removes the helper and runs again on the next request', async () => {
    const engine = new Helpers(),
      ok = engine.outcome;
    engine.outcome = () => ({ exit: 3, output: 'REFUSED seat-owner\n' });
    await expect(prepareSeatDirectory(engine, name, spec, () => {}, auth, timing)).rejects.toMatchObject({
      code: 'DOCKER_REPROVISION_SEAT_DIRECTORY_FOREIGN',
    });
    expect(engine.rows.size).toBe(0);
    engine.outcome = ok;
    await expect(prepareSeatDirectory(engine, name, spec, () => {}, auth, timing)).resolves.toMatchObject({ profile });
  });
  it('leaves a helper that has not exited and settles it by observation later', async () => {
    const engine = new Helpers();
    let clock = 0;
    engine.outcome = 'running';
    await expect(
      prepareSeatDirectory(engine, name, spec, () => {}, auth, { ...timing, now: () => (clock += 600) })
    ).rejects.toMatchObject({ code: 'DOCKER_REPROVISION_SEAT_PREPARATION_UNCONFIRMED' });
    expect(engine.rows.size).toBe(1);
    // It exits; the same request finds it by name and reads it without a second create or start.
    Object.assign(engine.rows.get(helperId)!.State as Json, { Status: 'exited', Running: false, ExitCode: 0 });
    engine.output = receiptLine({ credential: 'installed', credentialDigest: digest(auth) });
    engine.calls.length = 0;
    await expect(prepareSeatDirectory(engine, name, spec, () => {}, auth, timing)).resolves.toMatchObject({
      credential: 'installed',
    });
    expect(engine.calls).not.toContain('create');
    expect(engine.calls).not.toContain('container start');
  });
  it('never starts or reads a container under its name that is not exactly this helper', async () => {
    for (const change of [
      (row: Json) => ((row.Config as Json).User = '0:0'),
      (row: Json) => ((row.Config as Json).Cmd = ['--input-type=commonjs', '-e', 'process.exit(0)', '--', profile, 'anthropic']),
      (row: Json) => ((row.Config as Json).Cmd = [...((row.Config as Json).Cmd as string[]).slice(0, 4), 'other', 'anthropic']),
      (row: Json) => ((row.Config as Json).Cmd = [...((row.Config as Json).Cmd as string[]).slice(0, 5), 'openai']),
      (row: Json) => (((row.Mounts as Json[])[0]!.Source = '/another/home'), undefined),
      (row: Json) => ((row.HostConfig as Json).NetworkMode = 'bridge'),
      (row: Json) => (row.Image = 'sha256:' + 'd'.repeat(64)),
    ]) {
      const engine = new Helpers();
      await engine.create(name, seatDirectoryHelperConfiguration(spec), () => {});
      change(engine.rows.get(helperId)!);
      engine.calls.length = 0;
      await expect(prepareSeatDirectory(engine, name, spec, () => {}, auth, timing)).rejects.toMatchObject({
        code: 'DOCKER_REPROVISION_SEAT_PREPARATION_UNCONFIRMED',
      });
      expect(engine.calls).toEqual(['container ls', 'container inspect']);
      expect(engine.inputs).toEqual([]);
    }
  });
  it('refuses a request it was not built for and a stale caller', async () => {
    const engine = new Helpers();
    for (const bad of [
      { ...spec, profileId: '../x' },
      { ...spec, user: '0:0' },
      { ...spec, provider: 'google' as never },
      { ...spec, homeSource: 'relative/home' },
      { ...spec, homeSource: '/a/../b' },
      { ...spec, imageId: 'reverie/worker:latest' },
    ])
      await expect(prepareSeatDirectory(engine, name, bad, () => {}, auth, timing)).rejects.toThrow(
        'Fixed seat directory preparation required'
      );
    await expect(prepareSeatDirectory(engine, 'reverie-boxed-other', spec, () => {}, auth, timing)).rejects.toThrow(
      'Fixed seat directory preparation required'
    );
    const stale = () => {
      throw Error('stale');
    };
    await expect(prepareSeatDirectory(engine, name, spec, stale, auth, timing)).rejects.toThrow('stale');
    expect(engine.calls).toEqual([]);
  });
});
