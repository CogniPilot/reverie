import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readOfficeSettings, replaceOfficeSettings } from '../src/web/office-settings-file.js';

let dir: string;
let path: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'reverie-settings-'));
  path = join(dir, 'settings.json');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

it('publishes a complete replacement while preserving symlinks, permissions and existing readers', async () => {
  const target = join(dir, 'target');
  await fs.writeFile(target, '{"old":true}');
  await fs.chmod(target, 0o640);
  await fs.symlink(target, path);
  const before = await fs.stat(target);
  const reader = await fs.open(path);
  try {
    await replaceOfficeSettings(await readOfficeSettings(path), '{"new":true}');
    expect(await reader.readFile('utf8')).toBe('{"old":true}');
    expect(await fs.readFile(path, 'utf8')).toBe('{"new":true}');
    expect(await fs.readlink(path)).toBe(target);
    const after = await fs.stat(target);
    expect([after.uid, after.gid, after.mode]).toEqual([before.uid, before.gid, before.mode]);
  } finally {
    await reader.close();
  }
});

it('retains the original and removes the staged file after a publication failure', async () => {
  await fs.writeFile(path, 'old');
  const file = await readOfficeSettings(path);
  vi.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
  await expect(replaceOfficeSettings(file, 'new')).rejects.toMatchObject({ code: 'ENOSPC' });
  expect(await fs.readFile(path, 'utf8')).toBe('old');
  expect(await fs.readdir(dir)).toEqual(['settings.json']);
  await replaceOfficeSettings(file, 'new');
});

it('creates private settings once and refuses stale creation or replacement', async () => {
  const missing = await readOfficeSettings(path);
  await replaceOfficeSettings(missing, 'created');
  expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
  await expect(replaceOfficeSettings(missing, 'lost')).rejects.toMatchObject({ code: 'EEXIST' });
  const file = await readOfficeSettings(path);
  await fs.writeFile(path, 'externally updated');
  await expect(replaceOfficeSettings(file, 'lost')).rejects.toThrow(/changed/);
  expect(await fs.readFile(path, 'utf8')).toBe('externally updated');
});

it.skipIf(process.platform === 'win32')(
  'preserves dangling links and refuses pipes without waiting for a writer',
  async () => {
    await fs.symlink('absent', path);
    await expect(replaceOfficeSettings(await readOfficeSettings(path), 'new')).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(await fs.readlink(path)).toBe('absent');
    await fs.unlink(path);
    execFileSync('mkfifo', [path]);
    await expect(readOfficeSettings(path)).rejects.toThrow(/regular file/);
  }
);

it('can update again after the first publication was interrupted before unlink', async () => {
  vi.spyOn(fs, 'rm').mockRejectedValueOnce(new Error('cleanup interrupted'));
  await expect(replaceOfficeSettings(await readOfficeSettings(path), 'first')).rejects.toThrow('cleanup interrupted');
  const [alias] = (await fs.readdir(dir)).filter((name) => name !== 'settings.json');
  expect((await fs.stat(path)).nlink).toBe(2);
  const retained = await readOfficeSettings(path);
  expect(retained.raw).toBe('first');
  await replaceOfficeSettings(retained, 'second');
  expect(await fs.readFile(path, 'utf8')).toBe('second');
  expect((await fs.stat(path)).nlink).toBe(1);
  expect(await fs.readFile(join(dir, alias), 'utf8')).toBe('first');
});

it('preserves unrelated hard links even with a staged-looking symlink to the same file', async () => {
  await fs.writeFile(path, 'original');
  await fs.link(path, join(dir, 'another-config'));
  await fs.symlink(path, join(dir, '.reverie-settings-12345678-1234-4321-8123-123456789abc.tmp'));
  await expect(readOfficeSettings(path)).rejects.toThrow(/single hard link/);
  expect(await fs.readFile(join(dir, 'another-config'), 'utf8')).toBe('original');
});
