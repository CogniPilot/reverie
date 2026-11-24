import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DOCKER_SIGNIN_HOLDER_PROGRAM,
  DockerLaptopSignInHolder,
  dockerSignInHolderArguments,
  readSignInHolderResult,
} from '../src/docker-signin-holder.js';
import { signInView } from '../src/plan-signin-sync.js';

const profile = 'anthropic-898367f5';
const NOW = 1_800_000_000_000;
const HOUR = 60 * 60_000;
const container = 'c'.repeat(64);
const move = '10000000-0000-4000-8000-000000000001';
const projection = 'a'.repeat(64);
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
function file(expiresAt: number, serial = 0): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: 'SYNTHETIC_ACCESS_' + serial,
      refreshToken: 'SYNTHETIC_REFRESH_' + serial,
      expiresAt,
      refreshTokenExpiresAt: NOW + 500 * HOUR,
    },
  });
}
const emptied = JSON.stringify({
  claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: 0, refreshTokenExpiresAt: NOW + 500 * HOUR },
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function home(): string {
  const root = fs.mkdtempSync(join(tmpdir(), 'reverie-signin-holder-'));
  roots.push(root);
  fs.chmodSync(root, 0o700);
  return root;
}
/** The shipped program text; only its fixed home constant points elsewhere. */
function program(root: string): string {
  const fixed = "const HOME = '/home/agent';";
  expect(DOCKER_SIGNIN_HOLDER_PROGRAM.split(fixed)).toHaveLength(2);
  return DOCKER_SIGNIN_HOLDER_PROGRAM.replace(fixed, () => 'const HOME = ' + JSON.stringify(root) + ';');
}
function run(
  root: string,
  args: string[],
  options: { input?: string; configDir?: string } = {}
): { status: number; output: string } {
  const env = { PATH: process.env.PATH, ...(options.configDir ? { CLAUDE_CONFIG_DIR: options.configDir } : {}) };
  try {
    const output = execFileSync(process.execPath, ['--input-type=commonjs', '-e', program(root), '--', ...args], {
      encoding: 'utf8',
      input: options.input ?? '',
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { status: 0, output };
  } catch (error) {
    const failed = error as { status: number; stdout: string };
    return { status: failed.status, output: failed.stdout };
  }
}
const receipt = (result: { status: number; output: string }) => {
  expect(result.status).toBe(0);
  return JSON.parse(result.output) as Record<string, unknown>;
};
function seat(root: string, text?: string): string {
  const dir = join(root, '.reverie', 'seat-auth', profile);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (text !== undefined) fs.writeFileSync(join(dir, '.credentials.json'), text, { mode: 0o600 });
  return dir;
}
function generation(root: string, text?: string): { dir: string; configDir: string } {
  const relative = join('.reverie', 'plan-moves', move, 'generation-' + projection, 'claude');
  const dir = join(root, relative);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (text !== undefined) fs.writeFileSync(join(dir, '.credentials.json'), text, { mode: 0o600 });
  return { dir, configDir: join(root, relative) };
}

describe('the fixed sign-in holder program', () => {
  it('observes a seat without printing a token, and reads it exactly as the office reads its own copy', () => {
    const root = home();
    for (const text of [file(NOW + 8 * HOUR), emptied, '{}', 'not json', '[]']) {
      seat(root, text);
      const result = run(root, ['observe', profile]);
      expect(result.output).not.toContain('SYNTHETIC');
      const { version, purpose, mode, profile: named, holder, refreshing, ...view } = receipt(result);
      expect({ version, purpose, mode, named, holder, refreshing }).toEqual({
        version: 1,
        purpose: 'reverie-signin-holder-v1',
        mode: 'observe',
        named: profile,
        holder: 'seat',
        refreshing: false,
      });
      expect(view).toEqual(signInView(text));
    }
  });

  it('reports a seat folder with no file as absent and a laptop with no folder as holding none', () => {
    const root = home();
    expect(receipt(run(root, ['observe', profile])).state).toBe('none');
    seat(root);
    expect(receipt(run(root, ['observe', profile]))).toMatchObject({ state: 'absent', holder: 'seat' });
  });

  it("uses the plan move generation the laptop's environment names, not the seat", () => {
    const root = home();
    seat(root, emptied);
    const { configDir } = generation(root, file(NOW + 3 * HOUR, 7));
    expect(receipt(run(root, ['observe', profile], { configDir }))).toMatchObject({
      holder: 'generation',
      state: 'usable',
      expiresAt: NOW + 3 * HOUR,
    });
  });

  it('refuses an environment that names any other folder', () => {
    const root = home();
    seat(root, emptied);
    for (const configDir of [
      join(root, '.claude'),
      '/instances/default/console/accounts/anthropic-other',
      join(root, '.reverie', 'plan-moves', move, 'generation-' + projection, 'claude', '..'),
      join(root, '.reverie', 'plan-moves', '..', 'seat-auth', profile),
    ])
      expect(run(root, ['observe', profile], { configDir })).toEqual({ status: 3, output: 'REFUSED location\n' });
    // The seat's own mount path is the seat.
    expect(
      receipt(run(root, ['observe', profile], { configDir: '/instances/default/console/accounts/' + profile })).holder
    ).toBe('seat');
  });

  it('replaces an emptied seat with a usable sign-in: whole, private, and with the old file kept once', () => {
    const root = home();
    const dir = seat(root, emptied);
    const next = file(NOW + 8 * HOUR, 2);
    const result = run(root, ['write', profile, digest(emptied)], { input: next });
    expect(result.output).not.toContain('SYNTHETIC');
    expect(receipt(result)).toMatchObject({
      mode: 'write',
      state: 'usable',
      digest: digest(next),
      credential: 'replaced',
    });
    expect(fs.readFileSync(join(dir, '.credentials.json'), 'utf8')).toBe(next);
    expect(fs.statSync(join(dir, '.credentials.json')).mode & 0o7777).toBe(0o600);
    expect(fs.statSync(join(dir, '.credentials.json')).nlink).toBe(1);
    expect(fs.readFileSync(join(dir, '.credentials.json.reverie-previous'), 'utf8')).toBe(emptied);
    expect(fs.readdirSync(dir).sort()).toEqual(['.credentials.json', '.credentials.json.reverie-previous']);
  });

  it('installs into a seat folder that has no file only when told the file is absent', () => {
    const root = home();
    const dir = seat(root);
    const next = file(NOW + 8 * HOUR, 2);
    expect(run(root, ['write', profile, digest(emptied)], { input: next })).toEqual({
      status: 3,
      output: 'REFUSED changed\n',
    });
    expect(receipt(run(root, ['write', profile, 'absent'], { input: next })).credential).toBe('installed');
    expect(fs.readdirSync(dir)).toEqual(['.credentials.json']);
  });

  it('refuses to write over a file that is no longer the one that was read', () => {
    const root = home();
    const renewed = file(NOW + 9 * HOUR, 9);
    const dir = seat(root, renewed);
    expect(run(root, ['write', profile, digest(emptied)], { input: file(NOW + 8 * HOUR, 2) })).toEqual({
      status: 3,
      output: 'REFUSED changed\n',
    });
    expect(fs.readFileSync(join(dir, '.credentials.json'), 'utf8')).toBe(renewed);
  });

  it('never writes an emptied, signed-out or malformed sign-in', () => {
    const root = home();
    const dir = seat(root, emptied);
    for (const input of [emptied, '{}', 'not json', '', '[]'])
      expect(run(root, ['write', profile, digest(emptied)], { input })).toEqual({
        status: 3,
        output: 'REFUSED input\n',
      });
    expect(fs.readFileSync(join(dir, '.credentials.json'), 'utf8')).toBe(emptied);
  });

  it("waits while the client's own renewal lock is fresh, and ignores one it lost a minute ago", () => {
    const root = home();
    const dir = seat(root, emptied);
    const next = file(NOW + 8 * HOUR, 2);
    fs.mkdirSync(join(dir, '.oauth_refresh.lock'));
    expect(receipt(run(root, ['observe', profile])).refreshing).toBe(true);
    expect(run(root, ['write', profile, digest(emptied)], { input: next })).toEqual({
      status: 3,
      output: 'REFUSED busy\n',
    });
    const old = new Date(Date.now() - 5 * 60_000);
    fs.utimesSync(join(dir, '.oauth_refresh.lock'), old, old);
    expect(receipt(run(root, ['write', profile, digest(emptied)], { input: next })).state).toBe('usable');
  });

  it('releases the bytes of a usable copy only while it still has the digest that was decided on', () => {
    const root = home();
    const text = file(NOW + 8 * HOUR, 4);
    seat(root, text);
    expect(receipt(run(root, ['read', profile, digest(text)]))).toMatchObject({ mode: 'read', text });
    expect(run(root, ['read', profile, digest(emptied)])).toEqual({ status: 3, output: 'REFUSED changed\n' });
    seat(root, emptied);
    expect(run(root, ['read', profile, digest(emptied)])).toEqual({ status: 3, output: 'REFUSED changed\n' });
  });

  it('does not follow a link in place of the folder or the file', () => {
    const root = home();
    const elsewhere = home();
    fs.writeFileSync(join(elsewhere, '.credentials.json'), file(NOW + HOUR), { mode: 0o600 });
    fs.mkdirSync(join(root, '.reverie', 'seat-auth'), { recursive: true, mode: 0o700 });
    fs.symlinkSync(elsewhere, join(root, '.reverie', 'seat-auth', profile));
    expect(run(root, ['observe', profile])).toEqual({ status: 3, output: 'REFUSED folder\n' });
    fs.unlinkSync(join(root, '.reverie', 'seat-auth', profile));
    const dir = seat(root);
    fs.symlinkSync(join(elsewhere, '.credentials.json'), join(dir, '.credentials.json'));
    expect(run(root, ['observe', profile])).toEqual({ status: 3, output: 'REFUSED file\n' });
    expect(run(root, ['write', profile, 'absent'], { input: file(NOW + 2 * HOUR, 5) }).status).toBe(3);
    expect(fs.readFileSync(join(elsewhere, '.credentials.json'), 'utf8')).toBe(file(NOW + HOUR));
  });

  it('refuses anything but its three fixed requests', () => {
    const root = home();
    seat(root, emptied);
    for (const args of [
      [],
      ['observe'],
      ['observe', '../x'],
      ['observe', profile, 'extra'],
      ['read', profile],
      ['read', profile, 'absent'],
      ['write', profile],
      ['write', profile, 'nothex'],
      ['delete', profile, digest(emptied)],
    ])
      expect(run(root, args)).toEqual({ status: 3, output: 'REFUSED arguments\n' });
  });
});

describe('the office side of a laptop holder', () => {
  it('builds one fixed exec per request and refuses any other', () => {
    const observe = dockerSignInHolderArguments(container, 'observe', profile);
    expect(observe.slice(0, 5)).toEqual(['exec', '--workdir', '/', container, '/opt/reverie-worker-client/bin/node']);
    expect(observe.slice(-3)).toEqual(['--', 'observe', profile]);
    expect(observe).toContain(DOCKER_SIGNIN_HOLDER_PROGRAM);
    const write = dockerSignInHolderArguments(container, 'write', profile, 'absent');
    expect(write.slice(0, 2)).toEqual(['exec', '--interactive']);
    expect(write.slice(-4)).toEqual(['--', 'write', profile, 'absent']);
    for (const bad of [
      () => dockerSignInHolderArguments('short', 'observe', profile),
      () => dockerSignInHolderArguments(container, 'observe', '../x'),
      () => dockerSignInHolderArguments(container, 'observe', profile, 'a'.repeat(64)),
      () => dockerSignInHolderArguments(container, 'read', profile),
      () => dockerSignInHolderArguments(container, 'read', profile, 'absent'),
      () => dockerSignInHolderArguments(container, 'write', profile, '--help'),
    ])
      expect(bad).toThrow('Fixed sign-in holder request required');
  });

  it('accepts only one self-consistent receipt line for the request it made', () => {
    const wanted = { mode: 'observe' as const, profileId: profile };
    const base = { version: 1, purpose: 'reverie-signin-holder-v1', mode: 'observe', profile, holder: 'seat' };
    const line = (value: unknown) => JSON.stringify(value) + '\n';
    expect(readSignInHolderResult(line({ ...base, state: 'absent', refreshing: false }), wanted)).toMatchObject({
      state: 'absent',
    });
    expect(readSignInHolderResult('REFUSED busy\n', wanted)).toEqual({ refused: 'busy' });
    for (const output of [
      undefined,
      '',
      'REFUSED Busy now\n',
      line({ ...base, state: 'absent' }) + 'more\n',
      line({ ...base, state: 'absent', digest: 'd'.repeat(64) }),
      line({ ...base, state: 'usable', digest: 'd'.repeat(64) }),
      line({ ...base, state: 'blank', digest: 'd'.repeat(64), text: 'x' }),
      line({ ...base, state: 'absent', extra: true }),
      line({ ...base, mode: 'write', state: 'absent' }),
      line({ ...base, profile: 'anthropic-other', state: 'absent' }),
    ])
      expect(readSignInHolderResult(output, wanted)).toEqual({ refused: 'unconfirmed' });
  });

  it('drives the program through the Engine port and keeps nothing of a failure', async () => {
    const root = home();
    const dir = seat(root, emptied);
    const calls: string[][] = [];
    let live = true;
    const command = {
      run: async (args: readonly string[], input?: string) => {
        calls.push([...args]);
        const at = args.indexOf('--');
        const result = run(root, args.slice(at + 1) as string[], { input });
        if (result.status === 0) return result.output;
        throw Object.assign(Error('Command failed: SYNTHETIC_ACCESS_should_never_be_read'), {
          code: result.status,
          stdout: result.output,
        });
      },
    };
    const holder = new DockerLaptopSignInHolder(
      command,
      { id: 'laptop:burt', label: 'Burt', containerId: container, profileId: profile },
      () => live
    );
    const before = await holder.observe();
    expect(before).toEqual(signInView(emptied));
    const next = file(NOW + 8 * HOUR, 3);
    // Not the file that was read: nothing is written.
    expect(await holder.write(next, signInView(file(NOW, 1)))).toBe('changed');
    expect(await holder.write(emptied, before!)).toBe('refused');
    expect(calls.filter((args) => args.includes('write'))).toHaveLength(1);
    expect(await holder.write(next, before!)).toBe('written');
    expect(fs.readFileSync(join(dir, '.credentials.json'), 'utf8')).toBe(next);
    expect(await holder.observe()).toEqual(signInView(next));
    expect(await holder.read(digest(next))).toBe(next);
    expect(await holder.read(digest(emptied))).toBeUndefined();
    live = false;
    const count = calls.length;
    expect(await holder.observe()).toBeUndefined();
    expect(await holder.write(file(NOW + 9 * HOUR, 4), signInView(next))).toBe('refused');
    expect(calls).toHaveLength(count);
  });
});
