import { afterEach, beforeEach, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadServiceAuthConfig, serviceIssuers, serviceNonces } from '../src/service-auth-config.js';
import { ServiceGrantAuthentication, signServiceAssertion, type ServiceGrantPorts } from '../src/service-grant-auth.js';

let dir: string;
const trust = { trustedUids: [process.getuid!()] };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'service-auth-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const config = (over: Record<string, unknown> = {}) => ({
  version: 1,
  purposes: {
    RESUME_SERVICE: { scope: 'employees' },
    LEASE_SERVICE: { scope: 'resources' },
    REST_PLAN_REPORT_METADATA: { scope: 'employees' },
    OPS_STATUS: { scope: 'employees+resources', action: 'reverie.ops.status' },
    OPS_WEBSITE_RESTART: { scope: 'employees+resources', action: 'reverie.ops.website.restart' },
  },
  principals: [{ principal: 'ops', epoch: '2026-10-25.1', key: join(dir, 'ops.key') }],
  ...over,
});
function write(name: string, value: unknown, mode = 0o600): string {
  const file = join(dir, name);
  writeFileSync(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
  chmodSync(file, mode);
  return file;
}

it('loads the tracked purpose registry with action aliases; nothing else is a purpose', () => {
  const loaded = loadServiceAuthConfig(write('service-auth.json', config()), trust);
  expect(loaded.purposes).toEqual({
    RESUME_SERVICE: 'employees',
    LEASE_SERVICE: 'resources',
    REST_PLAN_REPORT_METADATA: 'employees',
    OPS_STATUS: 'employees+resources',
    OPS_WEBSITE_RESTART: 'employees+resources',
  });
  expect(loaded.purposeFor('reverie.ops.website.restart')).toBe('OPS_WEBSITE_RESTART');
  expect(loaded.purposeFor('reverie.ops.shell')).toBeUndefined();
  expect(loaded.digest).toMatch(/^[0-9a-f]{64}$/);
});

it('refuses untrusted files and malformed or ambiguous configs', () => {
  const good = write('good.json', config());
  symlinkSync(good, join(dir, 'link.json'));
  expect(() => loadServiceAuthConfig(join(dir, 'link.json'), trust)).toThrow();
  expect(() => loadServiceAuthConfig(write('loose.json', config(), 0o664), trust)).toThrow();
  expect(() => loadServiceAuthConfig(good)).toThrow(); // default trust is root only
  expect(() => loadServiceAuthConfig('relative.json', trust)).toThrow();
  for (const bad of [
    config({ extra: true }),
    config({ purposes: { lower_case: { scope: 'employees' } } }),
    config({ purposes: { OPS_A: { scope: 'everything' } } }),
    config({
      purposes: { OPS_A: { scope: 'resources', action: 'x.y' }, OPS_B: { scope: 'resources', action: 'x.y' } },
    }),
    config({
      principals: [
        { principal: 'ops', epoch: 'e', key: '/k' },
        { principal: 'ops', epoch: 'f', key: '/l' },
      ],
    }),
    config({ principals: [{ principal: 'p'.repeat(57), epoch: 'e', key: '/k' }] }),
    config({ principals: [{ principal: 'ops', epoch: 'e', key: 'relative' }] }),
  ])
    expect(() => loadServiceAuthConfig(write('bad.json', bad), trust)).toThrow();
});

it('issuer keys are re-read and re-checked on every call: 32 bytes, private, trusted owner, no symlink', () => {
  const loaded = loadServiceAuthConfig(write('service-auth.json', config()), trust);
  const issuer = serviceIssuers(loaded, trust);
  expect(issuer('ops')).toBeUndefined(); // key not provisioned yet
  const key = randomBytes(32);
  write('ops.key', key, 0o400);
  expect(issuer('ops')).toEqual({ epoch: '2026-10-25.1', key });
  expect(issuer('other')).toBeUndefined();
  chmodSync(join(dir, 'ops.key'), 0o640);
  expect(issuer('ops')).toBeUndefined();
  unlinkSync(join(dir, 'ops.key'));
  write('ops.key', randomBytes(31), 0o400);
  expect(issuer('ops')).toBeUndefined();
  unlinkSync(join(dir, 'ops.key'));
  symlinkSync(write('real.key', randomBytes(32), 0o400), join(dir, 'ops.key'));
  expect(issuer('ops')).toBeUndefined();
});

it('service nonces use their own issuer namespace in the durable nonce store', async () => {
  const seen: unknown[] = [];
  const nonces = serviceNonces({
    claim: async (key) => (seen.push(key), {}),
    assertCurrent: (_claim, key) => void seen.push(key),
  });
  const key = { principal: 'ops', epoch: 'e1', nonce: 'a'.repeat(32), expiresAt: 5 };
  await nonces.claim(key);
  nonces.assertCurrent({}, key);
  expect(seen).toEqual([
    { issuer: 'service:ops', epoch: 'e1', nonce: 'a'.repeat(32), expiresAt: 5 },
    { issuer: 'service:ops', epoch: 'e1', nonce: 'a'.repeat(32), expiresAt: 5 },
  ]);
});

it('end to end: an OPS grant authorizes exactly its employees on its resources, with a stable grantRef generation', async () => {
  const loaded = loadServiceAuthConfig(write('service-auth.json', config()), trust);
  const key = randomBytes(32);
  write('ops.key', key, 0o400);
  const now = 1_800_000_000_000;
  const session = '11111111-1111-1111-1111-111111111111';
  let revoked = false;
  const grant = {
    id: 'g-ops',
    purpose: 'OPS_WEBSITE_RESTART',
    owner: 'owner',
    principal: 'ops',
    epoch: '2026-10-25.1',
    employees: [{ employeeId: 'worker', sessionId: session, sessionGeneration: 1 }],
    resources: ['website'],
    issuedAt: now - 1,
    expiresAt: now + 60_000,
  };
  const used = new Set<string>();
  const ports: ServiceGrantPorts = {
    issuer: serviceIssuers(loaded, trust),
    grant: (id) => (id === grant.id ? structuredClone(grant) : undefined),
    revoked: () => revoked,
    binding: (id) =>
      id === 'worker' ? { owner: 'owner', employeeId: 'worker', sessionId: session, sessionGeneration: 1 } : undefined,
    nonces: serviceNonces({
      claim: async (k) => (used.has(k.nonce) ? undefined : (used.add(k.nonce), {})),
      assertCurrent: () => undefined,
    }),
    now: () => now,
  };
  const auth = new ServiceGrantAuthentication(ports, loaded.purposes);
  const assertion = (nonce: string) =>
    signServiceAssertion(key, {
      purpose: loaded.purposeFor('reverie.ops.website.restart')!,
      principal: 'ops',
      epoch: '2026-10-25.1',
      ownerId: 'owner',
      grantId: 'g-ops',
      issuedAt: now,
      expiresAt: now + 5000,
      nonce,
    });
  const lease = await auth.authenticate({ assertion: assertion('1'.repeat(32)) }, 'OPS_WEBSITE_RESTART');
  expect(lease!.currentFor('worker', 'website')).toBe(true);
  expect(lease!.currentFor('worker', 'other-site')).toBe(false);
  expect(lease!.currentFor('stranger', 'website')).toBe(false);
  expect(lease!.current('website')).toBe(false); // employees+resources needs both
  expect(lease!.epoch).toBe('2026-10-25.1');
  expect(lease!.generation).toMatch(/^sha256:[0-9a-f]{64}$/);
  const again = await auth.authenticate({ assertion: assertion('2'.repeat(32)) }, 'OPS_WEBSITE_RESTART');
  expect(again!.generation).toBe(lease!.generation);
  revoked = true;
  expect(lease!.currentFor('worker', 'website')).toBe(false);
});
