/** Independent custody-first regressions. Owned files; no real helper/socket/key. */
import { expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const edge = vi.hoisted(() => ({ key: '', reads: 0, helper: '', projects: 0 }));
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return {
    ...actual,
    readSync: ((fd: number, ...args: any[]) => {
      if (actual.realpathSync('/proc/self/fd/' + fd) === edge.key) edge.reads++;
      return (actual.readSync as any)(fd, ...args);
    }) as typeof actual.readSync,
    statSync: ((file, options) => {
      const info = actual.statSync(file, options as any);
      return file === edge.helper ? Object.assign(info, { uid: typeof info.uid === 'bigint' ? 0n : 0 }) : info;
    }) as typeof actual.statSync,
  };
});
vi.mock('../src/goal-custody-channel.js', () => ({
  GoalCustodyChannel: class {
    project() {
      edge.projects++;
      throw Error('Synthetic host exposure refused');
    }
    close() {}
  },
}));
import { loadGoalPrivateBootstrap } from '../src/goal-private-bootstrap.js';
import { buildWebArgs } from '../src/daemon-control.js';

it.each(['scope', 'helper', 'host-exposure'])('refuses %s BEFORE private key content reads', (failure) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'goal-custody-order-'));
  fs.chmodSync(root, 0o700);
  const old = process.env.REVERIE_WORKER_SOCKET;
  const config = join(root, 'config.json'),
    key = join(root, 'key'),
    canonical = join(root, 'company.json');
  edge.key = key;
  edge.reads = 0;
  edge.projects = 0;
  edge.helper = fs.realpathSync(process.execPath); // explicit synthetic packaged-ownership edge only
  fs.writeFileSync(key, Buffer.alloc(32, 83), { mode: 0o600 });
  const socket = join(root, 'broker.sock');
  const paths = { config, key, canonical, nonce: join(root, 'nonce.json'), authority: join(root, 'authority') };
  fs.writeFileSync(
    config,
    JSON.stringify({
      version: 1,
      mode: 'owner-and-employee',
      issuer: 'synthetic',
      epoch: 'synthetic',
      serverContainerId: 'a'.repeat(64),
      paths: Object.fromEntries(Object.entries(paths).map(([name, path]) => [name, { host: path, server: path }])),
      nonce: { storeId: '11111111-2222-4333-8444-555555555555', capacity: 32, flockExecutable: process.execPath },
      server: { brokerSocket: socket, custodyClient: failure === 'helper' ? canonical : process.execPath },
    }),
    { mode: 0o600 }
  );
  process.env.REVERIE_WORKER_SOCKET = failure === 'scope' ? join(root, 'different.sock') : socket;
  try {
    expect(() => loadGoalPrivateBootstrap(config, canonical)).toThrow();
    expect(edge.reads).toBe(0);
    expect(edge.projects).toBe(failure === 'host-exposure' ? 1 : 0);
  } finally {
    if (old === undefined) delete process.env.REVERIE_WORKER_SOCKET;
    else process.env.REVERIE_WORKER_SOCKET = old;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('retains explicit empty config in daemon/service argv so the loader refuses it', () => {
  expect(() => loadGoalPrivateBootstrap('', '/synthetic-not-opened/company.json')).toThrow();
  expect(buildWebArgs({ port: 3000, host: '127.0.0.1', https: false, goalPrivateConfig: '' })).toContain(
    '--goal-private-config'
  );
});
