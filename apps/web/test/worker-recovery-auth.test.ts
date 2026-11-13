import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkerRecoveryAuthentication, RECOVERY_HEADER, recoveryRequestTarget } from '../src/worker-recovery-auth.js';
import type { CompanyEmployee } from '../src/company-types.js';
const hostRoot = vi.hoisted(() => ({ uid: 0, mode: undefined as number | undefined }));
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  const { hostRootMetadata } = await import('./helpers/host-root-metadata.js');
  return {
    ...actual,
    lstatSync: ((file, options) =>
      hostRootMetadata(file, actual.lstatSync(file, options as never), hostRoot)) as typeof actual.lstatSync,
  };
});
const fixture = JSON.parse(
  fs.readFileSync(new URL('./fixtures/worker-recovery-request.json', import.meta.url), 'utf8')
);
const flock = fs.realpathSync(
  (process.env.PATH ?? '')
    .split(':')
    .map((p) => join(p, 'flock'))
    .find((p) => fs.existsSync(p))!
);
const clean: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of clean.splice(0).reverse()) await f();
  hostRoot.uid = 0;
  hostRoot.mode = undefined;
});
async function setup() {
  const root = fs.mkdtempSync(join(tmpdir(), 'recovery-auth-'));
  clean.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name: string, data: unknown) =>
    fs.writeFileSync(join(root, name), typeof data === 'string' ? data : JSON.stringify(data), { mode: 0o600 });
  write('worker-recovery-auth.json', fixture.config);
  write('recovery-nonces.json', {
    version: 1,
    storeId: fixture.config.storeId,
    capacity: 4096,
    revision: 0,
    clockFloor: 0,
    entries: [],
  });
  write('recovery-nonces.json.lock', '');
  const caller = {
    id: 'caller',
    sessionId: fixture.sessionId,
    sessionGeneration: 7,
    desiredRunning: true,
  } as CompanyEmployee;
  const employees = [caller];
  let now = 1001;
  const app = Fastify();
  clean.push(() => app.close());
  const auth = new WorkerRecoveryAuthentication(
    root,
    () => employees,
    flock,
    () => now
  );
  auth.register(app);
  let principal: Awaited<ReturnType<typeof auth.authenticate>>;
  app.post('*', async (req, reply) => {
    try {
      principal = await auth.authenticate(req);
      principal.assertCurrent();
      return { success: true };
    } catch (error) {
      return reply.code(403).send({ success: false, reason: String(error) });
    }
  });
  const send = (assertion = fixture.assertion, body = fixture.body, target = fixture.target, headers = {}) =>
    app.inject({
      method: 'POST',
      url: target,
      headers: { [RECOVERY_HEADER]: assertion, 'content-type': 'application/json', ...headers },
      payload: body,
    });
  const sign = (target = fixture.target, body = fixture.body, changes: Record<number, unknown> = {}) => {
    const fields = [
      1,
      'worker-recovery-request',
      fixture.config.issuer,
      fixture.config.epoch,
      fixture.sessionId,
      7,
      'POST',
      target,
      createHash('sha256').update(body).digest('hex'),
      1000,
      11000,
      'c'.repeat(32),
    ];
    for (const [key, value] of Object.entries(changes)) fields[Number(key)] = value;
    const encoded = Buffer.from(JSON.stringify(fields)).toString('base64url');
    return (
      encoded +
      '.' +
      createHmac('sha256', Buffer.from(fixture.config.key, 'hex'))
        .update('reverie-worker-recovery-request-v1\n' + encoded)
        .digest('hex')
    );
  };
  return {
    root,
    caller,
    employees,
    write,
    send,
    sign,
    auth,
    principal: () => principal!,
    now: (n: number) => {
      now = n;
    },
  };
}
it('accepts the Python-produced proof once and pins issuer/caller custody after awaits', async () => {
  const f = await setup();
  expect((await f.send()).json()).toEqual({ success: true });
  expect((await f.send()).statusCode).toBe(403);
  f.caller.sessionGeneration++;
  expect(() => f.principal().assertCurrent()).toThrow('caller changed');
  f.caller.sessionGeneration--;
  f.principal().assertCurrent();
  f.write('worker-recovery-auth.json', { ...fixture.config, epoch: 'replaced' });
  expect(() => f.principal().assertIssued()).toThrow('issuer changed');
});
it.each(['foreign-owner', 'writable'] as const)('refuses an untrusted host-root %s metadata edge', async (kind) => {
  const f = await setup();
  if (kind === 'foreign-owner') hostRoot.uid = process.getuid!() + 1000;
  else hostRoot.mode = 0o40777;
  expect((await f.send()).statusCode).toBe(403);
});
it.each(['body', 'target', 'purpose', 'generation', 'signature', 'expired', 'service', 'parent-only'])(
  'refuses %s substitution without consuming authority',
  async (kind) => {
    const f = await setup();
    let proof = fixture.assertion,
      body = fixture.body,
      target = fixture.target,
      headers = {};
    if (kind === 'body') body += ' ';
    if (kind === 'target') target += '/status';
    if (kind === 'purpose') proof = f.sign(target, body, { 1: 'goal-request' });
    if (kind === 'generation') proof = f.sign(target, body, { 5: 8 });
    if (kind === 'signature') proof = proof.slice(0, -1) + (proof.endsWith('0') ? '1' : '0');
    if (kind === 'expired') f.now(11000);
    if (kind === 'service') headers = { 'x-reverie-service-token': 'fixture' };
    if (kind === 'parent-only') proof = '';
    expect((await f.send(proof, body, target, headers)).statusCode).toBe(403);
  }
);
it.each(['mode', 'symlink', 'hardlink', 'pending', 'lock', 'missing'])(
  'fails closed on damaged private %s storage',
  async (kind) => {
    const f = await setup(),
      config = join(f.root, 'worker-recovery-auth.json');
    if (kind === 'mode') fs.chmodSync(config, 0o644);
    if (kind === 'symlink') {
      fs.renameSync(config, config + '.old');
      fs.symlinkSync(config + '.old', config);
    }
    if (kind === 'hardlink') fs.linkSync(config, config + '.other');
    if (kind === 'pending') f.write('recovery-nonces.json.pending', 'uncertain');
    if (kind === 'lock') f.write('recovery-nonces.json.lock', 'not empty');
    if (kind === 'missing') fs.unlinkSync(join(f.root, 'recovery-nonces.json'));
    expect((await f.send()).statusCode).toBe(403);
  }
);
it('allows only exact bounded recovery targets, without query strings or alternate methods', () => {
  for (const action of ['status', 'resolve', 'cancel'])
    expect(recoveryRequestTarget('POST', '/api/plans/moves/id_1/' + action)).toBe(true);
  expect(recoveryRequestTarget('GET', fixture.target)).toBe(false);
  expect(recoveryRequestTarget('POST', fixture.target + '?authority=owner')).toBe(false);
  expect(recoveryRequestTarget('POST', '/api/plans/moves/id/adopt-anything')).toBe(false);
});
it('accepts a valid nonce ledger larger than the request body bound', async () => {
  const f = await setup();
  const entries = Array.from({ length: 500 }, (_, n) => ({
    key: n.toString(16).padStart(64, '0'),
    claimId: `aaaaaaaa-bbbb-cccc-dddd-${n.toString(16).padStart(12, '0')}`,
    expiresAt: 300000,
  }));
  f.write('recovery-nonces.json', {
    version: 1,
    storeId: fixture.config.storeId,
    capacity: 4096,
    revision: 500,
    clockFloor: 1000,
    entries,
  });
  expect(fs.statSync(join(f.root, 'recovery-nonces.json')).size).toBeGreaterThan(65536);
  expect((await f.send()).json()).toEqual({ success: true });
});
it('limits an accepted operation lease independently from the short request validity', async () => {
  const f = await setup();
  expect((await f.send()).statusCode).toBe(200);
  f.now(100000);
  expect(() => f.principal().assertCurrent()).not.toThrow();
  f.now(301001);
  expect(() => f.principal().assertIssued()).toThrow();
});

it.each(['employee', 'session'] as const)(
  'refuses globally duplicate source %s before consuming its nonce',
  async (kind) => {
    const f = await setup();
    const before = fs.readFileSync(join(f.root, 'recovery-nonces.json'));
    f.employees.push({
      ...f.caller,
      ...(kind === 'employee' ? { sessionId: 'different-session' } : { id: 'different-employee' }),
    });
    expect((await f.send()).statusCode).toBe(403);
    expect(fs.readFileSync(join(f.root, 'recovery-nonces.json'))).toEqual(before);
    f.employees.pop();
    expect((await f.send()).statusCode).toBe(200);
    f.employees.push({
      ...f.caller,
      ...(kind === 'employee' ? { sessionId: 'different-session' } : { id: 'different-employee' }),
    });
    expect(() => f.principal().assertCurrent()).toThrow('caller changed');
  }
);
