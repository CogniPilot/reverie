/** Isolated real V8 lifetime control; only the physical PTY port is synthetic. */
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import type { ProviderLaunchPublication } from '../../src/provider-launch-publication.js';

process.env.REVERIE_WORKER_SOCKET = '';
process.env.REVERIE_CAPACITY_RETRY = '0';
let exit: ((event: { exitCode: number }) => void) | undefined;
const spawn = () => ({
  pid: 999_999_997,
  onData() {
    return { dispose() {} };
  },
  onExit(callback: (event: { exitCode: number }) => void) {
    exit = callback;
    return { dispose() {} };
  },
  kill() {},
  write() {},
  resize() {},
});
mock.module('node-pty', { namedExports: { spawn }, defaultExport: { spawn } });
const { Session } = await import('../../src/session.js');
const { StateStore } = await import('../../src/state-store.js');
const { PROVIDER_LAUNCH_DISK_KEY } = await import('../../src/provider-launch-publication.js');
const collect = (globalThis as unknown as { gc?: () => void }).gc;
assert.equal(typeof collect, 'function', 'This control requires the declared --expose-gc tool');
async function quiesce() {
  for (let n = 0; n < 8; n++) {
    await setImmediate();
    collect!();
  }
  await setImmediate();
}
const root = process.argv[2];
assert.ok(root);
const file = join(root, 'lifetime-state.json');
const store = new StateStore(file);
let latest: WeakRef<ProviderLaunchPublication> | undefined;
const stage = store.stageProviderLaunch.bind(store);
store.stageProviderLaunch = (...args) => {
  const publication = stage(...args);
  latest = new WeakRef(publication);
  return publication;
};
let original: InstanceType<typeof Session> | undefined = new Session({
  workingDir: root,
  mode: 'shell',
  useMux: false,
  publicationStore: store,
  owner: 'synthetic-lifetime-owner',
});
const id = original.id;
await original.startShell();
const first = latest!;
exit!({ exitCode: 0 });
exit = undefined; // Release the original physical port's callback/context too.
await quiesce();
assert.ok(first.deref(), 'The live Session must retain its known-returned original local publication');
const before = JSON.parse(readFileSync(file, 'utf8'))[PROVIDER_LAUNCH_DISK_KEY].rows[id].attemptId;
await original.startShell();
const after = JSON.parse(readFileSync(file, 'utf8'))[PROVIDER_LAUNCH_DISK_KEY].rows[id].attemptId;
assert.notEqual(before, after, 'A later explicit local operation must get its own acknowledged attempt');
exit!({ exitCode: 0 });
exit = undefined;
await quiesce();
assert.equal(
  first.deref(),
  undefined,
  'Replacing the original local continuation must not create a global lifetime leak'
);
const owner = new WeakRef(original);
await original.stop(false);
original = undefined;
await quiesce();
assert.equal(owner.deref(), undefined, 'The Store must not keep a globally strong Session cycle');
const successor = new Session({
  id,
  workingDir: root,
  mode: 'shell',
  useMux: false,
  publicationStore: store,
  owner: 'synthetic-lifetime-owner',
  providerDispatchHeld: false,
});
assert.equal(
  successor.providerDispatchHeld,
  true,
  'Loss of the live owner never turns disk data into launch permission'
);
await successor.stop(false);
await store.saveNowAsync();
process.stdout.write(
  JSON.stringify({
    retainedWhileLive: true,
    replacedLocalCollected: true,
    ownerCollected: true,
    successorDenied: true,
  }) + '\n'
);
