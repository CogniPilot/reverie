/** Synthetic owned nonce successor fault controls; no production hooks/state. */
import fs from 'node:fs';
import { dirname } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { GoalNonceStore } from '../../src/goal-nonce-store.js';
import { GoalBrokerAuthentication } from '../../src/goal-broker-auth.js';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw);
let now = 100_000,
  custody = true,
  authCustody = true,
  armed = false,
  clockError = false;
let secret = Buffer.alloc(32, 7),
  epoch = 'test-epoch';
let generation = 7,
  owner = 'owner',
  employee = 'worker';
let fsyncs = 0,
  storageOpens = 0,
  flags = 0,
  preparingFault = false;
const originalFsync = fs.fsyncSync;
const originalLstat = fs.lstatSync;
const originalOpen = fs.openSync;
const faultTarget = input.mode.endsWith('-lock') ? input.file + '.lock' : input.file;
fs.fsyncSync = (fd) => {
  originalFsync(fd);
  if (armed && fs.fstatSync(fd).isDirectory()) {
    fsyncs++;
    if (input.mode.endsWith('expiry')) now = 110_000;
    if (input.mode.endsWith('clock-regression')) now = 100_000;
    if (input.mode.endsWith('clock-error')) clockError = true;
    if (input.mode.endsWith('custody')) custody = false;
    if (input.mode === 'auth-only-custody') {
      custody = true;
      authCustody = false;
    }
    if (input.mode === 'key') secret = Buffer.alloc(32, 8);
    if (input.mode === 'epoch') epoch = 'revoked-epoch';
    if (input.mode === 'generation') generation++;
    if (input.mode === 'owner') owner = 'other';
    if (input.mode === 'employee') employee = 'other';
    if (input.mode === 'replace-claim') {
      const state = JSON.parse(fs.readFileSync(input.file, 'utf8'));
      state.entries[0].claimId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
      fs.writeFileSync(input.file, JSON.stringify(state));
    }
    if (input.mode === 'remove-ledger') fs.unlinkSync(input.file);
  }
};
fs.lstatSync = ((file: fs.PathLike, ...rest: unknown[]) => {
  const info = (originalLstat as (...args: unknown[]) => fs.Stats)(file, ...rest);
  if (file !== faultTarget) return info;
  if (input.mode.startsWith('special-')) return { ...info, isFile: () => false };
  if (armed && input.mode.startsWith('race-')) {
    armed = false;
    fs.renameSync(faultTarget, faultTarget + '.original');
    if (input.mode.startsWith('race-fifo-')) {
      if (spawnSync('mkfifo', [faultTarget], { timeout: 1000 }).status !== 0) throw Error('synthetic FIFO unavailable');
    } else {
      preparingFault = true;
      try {
        fs.writeFileSync(faultTarget, fs.readFileSync(faultTarget + '.original'));
      } finally {
        preparingFault = false;
      }
    }
  }
  return info;
}) as typeof fs.lstatSync;
fs.openSync = ((file: fs.PathLike, suppliedFlags: number | string, ...rest: unknown[]) => {
  if (file === faultTarget && !preparingFault) {
    storageOpens++;
    flags = suppliedFlags as number;
    if (input.mode.startsWith('special-')) throw Error('must refuse before special-file open');
  }
  return (originalOpen as (...args: unknown[]) => number)(file, suppliedFlags, ...rest);
}) as typeof fs.openSync;
syncBuiltinESMExports();
const readNow = () => {
  if (clockError) throw Error('synthetic clock unavailable');
  return now;
};
const store = new GoalNonceStore({
  file: input.file,
  storeId: input.storeId,
  capacity: 4,
  flockExecutable: input.flockExecutable,
  authorityNamespace: dirname(input.file) + '/authority',
  now: readNow,
  assertPrivateCustody: () => {
    if (!custody) throw Error('synthetic custody unavailable');
  },
});
const key = { issuer: 'test-broker', epoch: 'test-epoch', nonce: 'a'.repeat(32), expiresAt: 110_000 };
let refused = false;
if (input.mode.startsWith('claim-') || input.mode.startsWith('special-') || input.mode.startsWith('race-')) {
  armed = true;
  try {
    await store.claim(key);
  } catch {
    refused = true;
  }
} else if (input.mode.startsWith('backend-') || input.mode === 'replace-claim' || input.mode === 'remove-ledger') {
  const handle = (await store.claim(key))!;
  now = 100_001;
  armed = true;
  try {
    store.assertCurrent(handle, key);
  } catch {
    refused = true;
  }
} else {
  const body = Buffer.from('{}'),
    sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const fields = [
    1,
    'goal-request',
    key.issuer,
    key.epoch,
    sid,
    7,
    'POST',
    '/api/goals',
    createHash('sha256').update(body).digest('hex'),
    100_000,
    110_000,
    key.nonce,
  ];
  const encoded = Buffer.from(JSON.stringify(fields)).toString('base64url');
  const assertion =
    encoded +
    '.' +
    createHmac('sha256', secret)
      .update('reverie-goal-request-v1\n' + encoded)
      .digest('hex');
  const auth = new GoalBrokerAuthentication({
    canonicalFile: dirname(input.file) + '/company.json',
    issuer: () => ({ epoch, key: secret }),
    binding: () => ({ employeeId: employee, owner, sessionId: sid, sessionGeneration: generation }),
    assertPrivateCustody: () => {
      if (!authCustody) throw Error('synthetic auth custody unavailable');
    },
    now: readNow,
    nonces: store,
  });
  const context = {};
  await auth.verify(context, { method: 'POST', target: '/api/goals', body, assertion });
  const principal = (await auth.authenticate(context))!;
  now = 100_001;
  armed = true;
  try {
    auth.assertCurrent(principal, context);
  } catch {
    refused = true;
  }
}
process.stdout.write(
  JSON.stringify({
    refused,
    fsyncs,
    storageOpens,
    noFollow: !!(flags & fs.constants.O_NOFOLLOW),
    nonblocking: !!(flags & fs.constants.O_NONBLOCK),
  })
);
