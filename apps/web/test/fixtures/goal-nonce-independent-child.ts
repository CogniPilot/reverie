/** Independent synthetic failure control; only the exact caller-owned fixture files are used. */
import fs from 'node:fs';
import { dirname } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { createHash, createHmac } from 'node:crypto';
import { GoalNonceStore } from '../../src/goal-nonce-store.js';
import { GoalBrokerAuthentication } from '../../src/goal-broker-auth.js';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw);
let now = 100_000, custody = true, armed = false, issuerAvailable = true, bindingAvailable = true;
const originalFsync = fs.fsyncSync;
fs.fsyncSync = fd => {
  originalFsync(fd);
  if (armed && fs.fstatSync(fd).isDirectory()) {
    if (input.mode === 'expiry') now = 110_000;
    if (input.mode === 'custody') custody = false;
    if (input.mode === 'issuer') issuerAvailable = false;
    if (input.mode === 'binding') bindingAvailable = false;
  }
};
syncBuiltinESMExports();
const store = new GoalNonceStore({
  file: input.file, storeId: input.storeId, capacity: 4,
  flockExecutable: input.flockExecutable, authorityNamespace: dirname(input.file) + '/authority',
  now: () => now, assertPrivateCustody: () => { if (!custody) throw Error('Synthetic custody revoked'); },
});
const key = { issuer: 'test-broker', epoch: 'test-epoch', nonce: 'a'.repeat(32), expiresAt: 110_000 };
if (input.mode === 'fifo') {
  try { await store.claim(key); process.stdout.write(JSON.stringify({ refused: false })); }
  catch { process.stdout.write(JSON.stringify({ refused: true })); }
} else {
  const body = Buffer.from('{}'), secret = Buffer.alloc(32, 7);
  const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const fields = [1, 'goal-request', key.issuer, key.epoch, sid, 7, 'POST', '/api/goals',
    createHash('sha256').update(body).digest('hex'), 100_000, 110_000, key.nonce];
  const encoded = Buffer.from(JSON.stringify(fields)).toString('base64url');
  const assertion = encoded + '.' + createHmac('sha256', secret).update('reverie-goal-request-v1\n' + encoded).digest('hex');
  const auth = new GoalBrokerAuthentication({
    canonicalFile: dirname(input.file) + '/company.json',
    issuer: () => issuerAvailable ? ({ epoch: key.epoch, key: secret }) : undefined,
    binding: () => bindingAvailable ? ({ employeeId: 'worker', sessionId: sid, sessionGeneration: 7 }) : undefined,
    assertPrivateCustody: () => { if (!custody) throw Error('Synthetic custody revoked'); },
    now: () => now, nonces: store,
  });
  const context = {};
  await auth.verify(context, { method: 'POST', target: '/api/goals', body, assertion });
  const principal = (await auth.authenticate(context))!;
  now = 100_001;
  armed = true;
  let refused = false;
  try { auth.assertCurrent(principal, context); } catch { refused = true; }
  process.stdout.write(JSON.stringify({ refused, now, custody, issuerAvailable, bindingAvailable,
    persistedClockFloor: JSON.parse(fs.readFileSync(input.file, 'utf8')).clockFloor }));
}
