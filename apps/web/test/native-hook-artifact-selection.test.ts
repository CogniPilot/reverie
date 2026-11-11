import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, chmod, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkedNativeHookHostTest, selectNativeHookHostTest } from '../scripts/select-native-hook-host-test.js';

let root: string, repo: string, target: string, executable: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hook-artifact-'));
  repo = join(root, 'repo');
  target = join(root, 'target');
  executable = join(target, 'debug/deps/reverie_host-fixture');
  await mkdir(repo);
  await mkdir(join(target, 'debug/deps'), { recursive: true });
  // The selector only reads this synthetic ELF header; no fixture is executed.
  await writeFile(executable, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  await chmod(executable, 0o700);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
function artifact() {
  return {
    reason: 'compiler-artifact',
    package_id: pathToFileURL(join(repo, 'crates/reverie-host')).href.replace(/^file:/, 'path+file:') + '#0.1.0',
    manifest_path: join(repo, 'crates/reverie-host/Cargo.toml'),
    target: { name: 'reverie_host', src_path: join(repo, 'crates/reverie-host/src/lib.rs'), kind: ['lib'], test: true },
    profile: { test: true },
    executable,
    filenames: [executable],
  };
}
const stream = (rows: unknown[] = []) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
const finished = { reason: 'build-finished', success: true };
it('selects the exact completed host library test artifact without executable globbing', () => {
  const source = stream([{ reason: 'compiler-artifact', manifest_path: '/other/Cargo.toml' }, artifact(), finished]);
  expect(checkedNativeHookHostTest(source, repo, target)).toBe(executable);
});
it('refuses absent, duplicate, failed, unfinished and malformed Cargo streams', () => {
  for (const source of [
    stream([finished]),
    stream([artifact(), artifact(), finished]),
    stream([artifact(), { ...finished, success: false }]),
    stream([artifact()]),
    stream([artifact(), finished, finished]),
    stream([artifact(), finished, {}]),
    stream([{ reason: 'compiler-message', message: { level: 'error' } }, artifact(), finished]),
    stream([artifact(), finished]) + 'not JSON\n',
  ])
    expect(() => selectNativeHookHostTest(source, repo, target)).toThrow();
});
it('refuses wrong crate, source, target kind, test profile, package identity and outside-target paths', () => {
  const original = artifact();
  for (const row of [
    { ...original, manifest_path: join(repo, 'other/Cargo.toml') },
    { ...original, target: { ...original.target, src_path: '/other/lib.rs' } },
    { ...original, target: { ...original.target, kind: ['bin'] } },
    { ...original, target: { ...original.target, test: false } },
    { ...original, profile: { test: false } },
    { ...original, package_id: 'registry+https://example.invalid#reverie-host@0.1.0' },
    { ...original, executable: '/outside/host', filenames: ['/outside/host'] },
    { ...original, filenames: [] },
  ])
    expect(() => selectNativeHookHostTest(stream([row, finished]), repo, target)).toThrow();
});
it('refuses symlink, non-executable and script artifacts after stream qualification', async () => {
  const source = stream([artifact(), finished]);
  await chmod(executable, 0o600);
  expect(() => checkedNativeHookHostTest(source, repo, target)).toThrow();
  await chmod(executable, 0o700);
  await writeFile(executable, '#!/bin/sh\nexit 0\n');
  expect(() => checkedNativeHookHostTest(source, repo, target)).toThrow('ELF');
  await rm(executable);
  await symlink(process.execPath, executable);
  expect(() => checkedNativeHookHostTest(source, repo, target)).toThrow('regular');
});
it('runs the tracked CLI and refuses a failed stream without printing an executable', async () => {
  const input = join(root, 'cargo.jsonl'),
    script = resolve('scripts/select-native-hook-host-test.ts');
  await writeFile(input, stream([artifact(), finished]));
  const run = () =>
    spawnSync(process.execPath, ['--import', 'tsx', script, repo, target, input], { encoding: 'utf8', timeout: 10000 });
  const good = run();
  expect(good.status).toBe(0);
  expect(good.stdout.trim()).toBe(executable);
  await writeFile(input, stream([artifact(), { ...finished, success: false }]));
  const bad = run();
  expect(bad.status).toBe(1);
  expect(bad.stdout).toBe('');
  expect(bad.stderr).toContain('did not finish');
});
