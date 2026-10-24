/** Corrected F1/F2 interleavings: no mutable subdirectory authority; retain uncancellable work. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { WorkspaceFiles } from '../src/workspace-files.js';

const control = vi.hoisted(() => ({
  phase: '',
  calls: 0,
  active: 0,
  maximum: 0,
  links: 0,
  release: undefined as (() => void) | undefined,
  gate: undefined as Promise<void> | undefined,
  root: '',
  renameFrom: '',
  renameTo: '',
}));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  const wait = async (phase: string) => {
    if (control.phase !== phase) return;
    control.calls++;
    control.active++;
    control.maximum = Math.max(control.maximum, control.active);
    try {
      await control.gate;
    } finally {
      control.active--;
    }
  };
  return {
    ...fs,
    realpath: async (...args: Parameters<typeof fs.realpath>) => {
      if (String(args[0]) === control.root) await wait('root');
      const actual = await fs.realpath(...args);
      if (control.renameFrom && actual === control.renameFrom) {
        const from = control.renameFrom;
        control.renameFrom = '';
        await fs.rename(from, control.renameTo);
        return fs.realpath(...args);
      }
      return actual;
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]).includes('.reverie-upload')) await wait('temporary');
      const handle = await fs.open(...args);
      if (String(args[0]).startsWith(control.root) || String(args[0]).startsWith('/proc/self/fd/')) {
        const read = handle.read.bind(handle),
          close = handle.close.bind(handle),
          stat = handle.stat.bind(handle);
        handle.read = (async (...args: Parameters<typeof handle.read>) => {
          await wait('read');
          return read(...args);
        }) as typeof handle.read;
        handle.stat = (async (...args: Parameters<typeof handle.stat>) => {
          await wait('stat');
          return stat(...args);
        }) as typeof handle.stat;
        handle.close = async () => {
          await wait('close');
          return close();
        };
      }
      return handle;
    },
    opendir: async (...args: Parameters<typeof fs.opendir>) => {
      const dir = await fs.opendir(...args);
      const read = dir.read.bind(dir);
      dir.read = (async () => {
        await wait('list');
        return read();
      }) as typeof dir.read;
      return dir;
    },
    link: async (...args: Parameters<typeof fs.link>) => {
      control.links++;
      await wait('commit');
      return fs.link(...args);
    },
    unlink: async (...args: Parameters<typeof fs.unlink>) => {
      if (String(args[0]).includes('.reverie-upload')) await wait('cleanup');
      return fs.unlink(...args);
    },
  };
});
let task: string, root: string;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const trustedFixture = (timeout = 100) =>
  new WorkspaceFiles(
    () => root,
    timeout,
    async () => {
      /* Private synthetic authority only. */
    }
  );
async function drain() {
  control.phase = '';
  control.release?.();
  await pause(40);
}
beforeEach(async () => {
  task = await mkdtemp(join(tmpdir(), 'workspace-safety-'));
  root = join(task, 'drive');
  await mkdir(root);
  control.root = root;
  control.calls = 0;
  control.active = 0;
  control.maximum = 0;
  control.links = 0;
  control.renameFrom = '';
  control.renameTo = '';
});
afterEach(async () => {
  await drain();
  await rm(task, { recursive: true, force: true });
});
function gate(phase: string) {
  control.phase = phase;
  control.gate = new Promise((resolve) => {
    control.release = resolve;
  });
}
async function entered() {
  for (let i = 0; i < 100 && !control.active; i++) await pause(2);
  expect(control.active).toBe(1);
}

for (const target of ['outside', '.hidden', 'credentials.json'])
  it(`refuses subfolder publication before a controlled ${target} rename can run`, async () => {
    const allowed = join(root, 'allowed');
    await mkdir(allowed);
    let consumed = false;
    const source = Readable.from(
      (async function* () {
        consumed = true;
        yield Buffer.from('owned');
        await rename(allowed, target === 'outside' ? join(task, target) : join(root, target));
      })()
    );
    await expect(trustedFixture().upload('allowed', 'new.txt', source, 5)).rejects.toMatchObject({ status: 403 });
    expect(consumed).toBe(false);
    expect(control.links).toBe(0);
    expect(await readdir(allowed)).toEqual([]);
  });
it('publishes only a root basename while mutable child directories move outside/hidden/sensitive', async () => {
  for (const [i, target] of ['outside', '.hidden', 'credentials.json'].entries()) {
    const allowed = join(root, `allowed-${i}`);
    await mkdir(allowed);
    const destination = target === 'outside' ? join(task, target) : join(root, target);
    const source = Readable.from(
      (async function* () {
        yield Buffer.from('owned');
        await rename(allowed, destination);
      })()
    );
    await trustedFixture(1000).upload('', `new-${i}.txt`, source, 5);
    expect(await readFile(join(root, `new-${i}.txt`), 'utf8')).toBe('owned');
    expect(await readdir(destination)).toEqual([]);
  }
  await expect(trustedFixture(1000).upload('', 'new-0.txt', Readable.from(['replacement']), 11)).rejects.toMatchObject({
    code: 'EEXIST',
  });
  expect(await readFile(join(root, 'new-0.txt'), 'utf8')).toBe('owned');
});
for (const mode of ['list', 'read'])
  it(`refuses ${mode} when an allowed directory becomes hidden before capability validation`, async () => {
    const allowed = join(root, 'allowed');
    await mkdir(allowed);
    await writeFile(join(allowed, 'file.txt'), 'private');
    control.renameFrom = allowed;
    control.renameTo = join(root, '.hidden');
    const files = trustedFixture(1000);
    await expect(mode === 'list' ? files.list('allowed') : files.file('allowed/file.txt', false)).rejects.toMatchObject(
      { status: 403 }
    );
    expect(await readFile(join(root, '.hidden', 'file.txt'), 'utf8')).toBe('private');
    expect(control.renameFrom).toBe('');
  });
it('default verifier leaves an ordinary mutable root readable but refuses publication without an authority injection', async () => {
  await writeFile(join(root, 'ordinary.txt'), 'readable');
  const files = new WorkspaceFiles(() => root, 2000);
  const listing = await files.list('');
  expect(listing.entries[0].name).toBe('ordinary.txt');
  expect(listing.upload.enabled).toBe(false);
  expect(listing.upload.reason).toContain('Uploads unavailable');
  await expect(files.upload('', 'no.txt', Readable.from(['x']), 1)).rejects.toMatchObject({ status: 403 });
  expect(control.links).toBe(0);
  expect(await readdir(root)).toEqual(['ordinary.txt']);
});
for (const phase of ['root', 'temporary', 'stat', 'list', 'close'])
  it(`retains a timed-out ${phase} operation across instances and stops late setup before publication`, async () => {
    gate(phase);
    const files = trustedFixture();
    const pending = phase === 'list' ? files.list('') : files.upload('', 'late.txt', Readable.from(['x']), 1);
    const outcome = expect(pending).rejects.toMatchObject({ status: 408 });
    await entered();
    await outcome;
    for (let i = 0; i < 8; i++) {
      const other = trustedFixture();
      await expect(other.list('')).rejects.toMatchObject({ status: 429 });
      await expect(other.file('late.txt', false)).rejects.toMatchObject({ status: 429 });
      await expect(other.upload('', `repeat-${i}`, Readable.from([]), 0)).rejects.toMatchObject({ status: 429 });
    }
    expect(control.calls).toBe(1);
    expect(control.maximum).toBe(1);
    expect(control.links).toBe(0);
    await drain();
    expect(control.active).toBe(0);
    expect((await readdir(root)).filter((n) => n.startsWith('.reverie-upload') || n === 'late.txt')).toEqual([]);
    await trustedFixture(1000).upload('', 'after.txt', Readable.from(['ok']), 2);
  });
it('retains a timed-out preview read and closes the late descriptor without returning bytes', async () => {
  await writeFile(join(root, 'read.txt'), 'readable');
  gate('read');
  const pending = trustedFixture().file('read.txt', true);
  const outcome = expect(pending).rejects.toMatchObject({ status: 408 });
  await entered();
  await outcome;
  await expect(trustedFixture().list('')).rejects.toMatchObject({ status: 429 });
  expect(control.calls).toBe(1);
  await drain();
  expect((await trustedFixture(1000).list('')).entries).toHaveLength(1);
});
it('retains a timed-out streamed download read and never emits late bytes', async () => {
  await writeFile(join(root, 'read.txt'), 'readable');
  gate('read');
  const result = await trustedFixture().file('read.txt', false);
  const chunks: Buffer[] = [];
  result.stream.on('data', (chunk) => chunks.push(chunk));
  const failed = new Promise<Error>((resolve) => result.stream.once('error', resolve));
  result.stream.resume();
  await entered();
  expect((await failed).message).toContain('timed out');
  await expect(trustedFixture().list('')).rejects.toMatchObject({ status: 429 });
  expect(control.calls).toBe(1);
  await drain();
  expect(chunks).toEqual([]);
  expect((await trustedFixture(1000).list('')).entries).toHaveLength(1);
});
it('promptly aborts a backpressured download on silent consumer close while retaining stalled cleanup', async () => {
  await writeFile(join(root, 'read.txt'), Buffer.alloc(128 * 1024, 65));
  const result = await trustedFixture(2000).file('read.txt', false);
  for (let i = 0; i < 100 && !result.stream.writableNeedDrain; i++) await pause(2);
  expect(result.stream.writableNeedDrain).toBe(true);
  gate('close');
  const started = Date.now();
  result.stream.destroy();
  await entered();
  expect(Date.now() - started).toBeLessThan(500);
  await expect(trustedFixture().list('')).rejects.toMatchObject({ status: 429 });
  expect(control.calls).toBe(1);
  await drain();
  expect((await trustedFixture(1000).list('')).entries).toHaveLength(1);
});
it('holds admission while final directory close is stalled even after list data is ready', async () => {
  gate('close');
  const pending = trustedFixture().list('');
  const outcome = expect(pending).rejects.toMatchObject({ status: 408 });
  await entered();
  await outcome;
  await expect(trustedFixture().list('')).rejects.toMatchObject({ status: 429 });
  expect(control.calls).toBe(1);
  await drain();
  await expect(trustedFixture(1000).list('')).resolves.toMatchObject({ entries: [] });
});
for (const phase of ['commit', 'cleanup'])
  it(`retains ${phase} completion after caller timeout and reports an uncertain commit without rollback`, async () => {
    gate(phase);
    const pending = trustedFixture().upload('', 'arrived.txt', Readable.from(['owned']), 5);
    const outcome = expect(pending).rejects.toMatchObject({
      status: 408,
      message: 'Upload confirmation timed out; file may have arrived. Refresh before retrying.',
    });
    await entered();
    await outcome;
    await expect(trustedFixture().list('')).rejects.toMatchObject({ status: 429 });
    expect(control.maximum).toBe(1);
    await drain();
    expect(await readFile(join(root, 'arrived.txt'), 'utf8')).toBe('owned');
    expect((await readdir(root)).some((n) => n.startsWith('.reverie-upload'))).toBe(false);
  });
it('fails closed before filesystem work with an undersized libuv pool', async () => {
  const previous = process.env.UV_THREADPOOL_SIZE;
  process.env.UV_THREADPOOL_SIZE = '1';
  try {
    await expect(trustedFixture().list('')).rejects.toMatchObject({ status: 503 });
  } finally {
    if (previous === undefined) delete process.env.UV_THREADPOOL_SIZE;
    else process.env.UV_THREADPOOL_SIZE = previous;
  }
});
