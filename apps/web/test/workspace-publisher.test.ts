/** Default verifier policy against controlled kernel/descriptor facts; no publication or host mutation. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { FileHandle } from 'node:fs/promises';
import { verifyWorkspacePublisher } from '../src/workspace-publisher.js';
import type { WorkspaceOperation } from '../src/workspace-operation.js';
const facts = vi.hoisted(() => ({ mount: '/shared', caps: '0', uid: 0, mode: 0o755, currentInode: 33 }));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    readFile: (...args: Parameters<typeof fs.readFile>) => {
      if (String(args[0]) === '/proc/self/status') return Promise.resolve(`CapEff:\t${facts.caps}\n`);
      if (String(args[0]) === '/proc/self/mountinfo')
        return Promise.resolve(`123 1 1:1 / ${facts.mount} rw - ext4 /dev/fake rw\n`);
      return fs.readFile(...args);
    },
  };
});
let closed: number[];
function handle(fd: number, root = false): FileHandle {
  return {
    fd,
    stat: async () => ({
      uid: root ? 1000 : facts.uid,
      mode: root ? 0o755 : facts.mode,
      dev: 1,
      ino: root ? facts.currentInode : 2,
    }),
  } as unknown as FileHandle;
}
function verify(configured = '/shared') {
  const op = {
    io: async <T>(work: () => Promise<T>) => work(),
    open: async (path: string) => handle(path === '/' ? 100 : 101, path !== '/'),
    close: async (fd: FileHandle) => {
      closed.push(fd.fd);
    },
  } as unknown as WorkspaceOperation;
  return verifyWorkspacePublisher({
    root: '/shared',
    configured,
    mount: '123',
    handle: { stat: async () => ({ dev: 1, ino: 33 }) } as unknown as FileHandle,
    operation: op,
  });
}
beforeEach(() => {
  facts.mount = '/shared';
  facts.caps = '0';
  facts.uid = 0;
  facts.mode = 0o755;
  facts.currentInode = 33;
  closed = [];
  vi.spyOn(process, 'getuid').mockReturnValue(1000);
  vi.spyOn(process, 'geteuid').mockReturnValue(1000);
});
afterEach(() => vi.restoreAllMocks());
it('accepts the exact mount root with protected root-owned parents and a non-root unprivileged publisher', async () => {
  await expect(verify()).resolves.toBeUndefined();
  expect(closed.sort()).toEqual([100, 101]);
});
it('refuses symlink aliases rather than trusting a mutable configured namespace', async () => {
  await expect(verify('/alias')).rejects.toMatchObject({ status: 403 });
});
it('refuses an ordinary directory even on the same device', async () => {
  facts.mount = '/';
  await expect(verify()).rejects.toMatchObject({ status: 403 });
});
it('refuses an effective-root publisher', async () => {
  vi.mocked(process.geteuid).mockReturnValue(0);
  await expect(verify()).rejects.toMatchObject({ status: 403 });
});
it('refuses a publisher with effective capabilities', async () => {
  facts.caps = '200000';
  await expect(verify()).rejects.toMatchObject({ status: 403 });
});
for (const mode of [0o775, 0o777, 0o1777])
  it(`refuses writable ancestor mode${mode.toString(8)}`, async () => {
    facts.mode = mode;
    await expect(verify()).rejects.toMatchObject({ status: 403 });
    expect(closed).toEqual([100]);
  });
it('refuses non-root-owned ancestors', async () => {
  facts.uid = 1000;
  await expect(verify()).rejects.toMatchObject({ status: 403 });
});
it('refuses a changed root descriptor identity and closes both descriptors', async () => {
  facts.currentInode = 34;
  await expect(verify()).rejects.toMatchObject({ status: 403 });
  expect(closed.sort()).toEqual([100, 101]);
});
