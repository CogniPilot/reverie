/** Synthetic separate-process nonce test only. No bootstrap or real configuration readers. */
import { dirname } from 'node:path';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import { GoalNonceStore, type GoalNonceStoreOptions } from '../../src/goal-nonce-store.js';

let text = '';
for await (const chunk of process.stdin) text += chunk;
const input = JSON.parse(text);
if (input.crashPoint) {
  // Fail-stop a synthetic child immediately after the selected real fsync.
  // No production hook or mocked durability is added to the store.
  const original = fs.fsyncSync;
  fs.fsyncSync = (fd) => {
    original(fd);
    const directory = fs.fstatSync(fd).isDirectory();
    if ((input.crashPoint === 'temporary' && !directory) || (input.crashPoint === 'durable' && directory)) {
      process.stdout.write(JSON.stringify({ crashed: true, point: input.crashPoint }) + '\n');
      process.exit(23);
    }
  };
  syncBuiltinESMExports();
}
const root = dirname(input.file);
let proofSerial = 0;
const options: GoalNonceStoreOptions = {
  file: input.file,
  storeId: input.storeId,
  capacity: input.capacity,
  flockExecutable: input.flockExecutable,
  authorityNamespace: root + '/authority',
  now: () => input.now,
  assertPrivateCustody: (scope) => {
    proofSerial++;
    // Explicit synthetic-fixture authority, not a runtime custody implementation.
    if (
      scope.root !== root ||
      scope.parent !== dirname(root) ||
      scope.file !== input.file ||
      scope.lock !== input.file + '.lock' ||
      scope.temporary !== input.file + '.pending' ||
      scope.authorityNamespace !== root + '/authority'
    )
      throw Error('fixture scope refused');
    if (input.denyCustody) throw Error('fixture custody absent');
  },
};
let audited = 0;
if (input.auditIO) {
  // In this isolated child only, every storage syscall must have a fresh custody
  // proof. No mock filesystem or production hook substitutes for real I/O.
  let usedProof = 0;
  for (const name of [
    'lstatSync',
    'openSync',
    'fstatSync',
    'readFileSync',
    'writeFileSync',
    'fsyncSync',
    'renameSync',
    'unlinkSync',
  ]) {
    const table = fs as unknown as Record<string, (...args: unknown[]) => unknown>;
    const original = table[name]!;
    table[name] = (...args) => {
      if (proofSerial <= usedProof) throw Error('storage I/O without fresh custody proof');
      usedProof = proofSerial;
      audited++;
      return original(...args);
    };
  }
  syncBuiltinESMExports();
}
if (input.holdLock) {
  options.assertPrivateCustody({
    root,
    parent: dirname(root),
    file: input.file,
    lock: input.file + '.lock',
    temporary: input.file + '.pending',
    authorityNamespace: root + '/authority',
  });
  const fd = fs.openSync(input.file + '.lock', fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
  const held = spawnSync(input.flockExecutable, ['--exclusive', '--wait', '1', '--conflict-exit-code', '75', '3'], {
    stdio: ['ignore', 'ignore', 'ignore', fd],
    timeout: 2000,
    env: {},
  });
  if (held.status !== 0) process.exit(2);
  process.stdout.write('LOCKED\n');
  await new Promise((done) => setTimeout(done, 5000));
  fs.closeSync(fd);
  process.exit(0);
}
try {
  const store = new GoalNonceStore(options);
  const key = { issuer: 'test-broker', epoch: 'test-epoch', nonce: input.nonce, expiresAt: input.expiresAt };
  const handle = await store.claim(key);
  if (handle) store.assertCurrent(handle, key);
  process.stdout.write(JSON.stringify({ accepted: !!handle, ...(input.auditIO ? { audited } : {}) }) + '\n');
} catch {
  process.stdout.write(JSON.stringify({ refused: true }) + '\n');
}
