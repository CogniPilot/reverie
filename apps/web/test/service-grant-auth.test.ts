import { it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  ServiceGrantAuthentication,
  signServiceAssertion,
  type ServiceGrantPorts,
  type ServicePurpose,
} from '../src/service-grant-auth.js';
import { CanonicalRecoveryAuthority, type RecoveryMetadata } from '../src/recovery-authority.js';

const NOW = 1_800_000_000_000;
const S1 = '11111111-1111-1111-1111-111111111111';
const S2 = '22222222-2222-2222-2222-222222222222';
function fixture(purpose: ServicePurpose = 'RESUME_SERVICE') {
  const state = {
    now: NOW,
    key: randomBytes(32) as Uint8Array,
    epoch: 'e1',
    grant: {
      id: 'g1',
      purpose,
      owner: 'owner',
      principal: 'svc',
      epoch: 'e1',
      employees:
        purpose === 'RESUME_SERVICE'
          ? [
              { employeeId: 'employee', sessionId: S1, sessionGeneration: 1 },
              { employeeId: 'other', sessionId: S2, sessionGeneration: 1 },
            ]
          : [],
      resources: purpose === 'LEASE_SERVICE' ? ['resource'] : [],
      issuedAt: NOW - 1000,
      expiresAt: NOW + 3_600_000,
    } as any,
    revoked: false as boolean | undefined,
    bindings: {
      employee: { owner: 'owner', employeeId: 'employee', sessionId: S1, sessionGeneration: 1 },
      other: { owner: 'someone-else', employeeId: 'other', sessionId: S2, sessionGeneration: 1 },
    } as Record<string, any>,
    claims: new Set<string>(),
    nonceLost: false,
    seed: 0,
  };
  const ports: ServiceGrantPorts = {
    issuer: (principal) => (principal === 'svc' ? { epoch: state.epoch, key: state.key } : undefined),
    grant: (id) => (id === state.grant?.id ? structuredClone(state.grant) : undefined),
    revoked: () => state.revoked,
    binding: (employeeId) => state.bindings[employeeId],
    nonces: {
      async claim(key) {
        if (state.claims.has(key.nonce)) return undefined;
        state.claims.add(key.nonce);
        return {};
      },
      assertCurrent() {
        if (state.nonceLost) throw new Error('lost');
      },
    },
    now: () => state.now,
  };
  const sign = (over: Partial<Parameters<typeof signServiceAssertion>[1]> = {}, key = state.key) =>
    signServiceAssertion(key, {
      purpose,
      principal: 'svc',
      epoch: 'e1',
      ownerId: 'owner',
      grantId: 'g1',
      issuedAt: state.now,
      expiresAt: state.now + 5000,
      nonce: (state.seed++).toString(16).padStart(32, '0'),
      ...over,
    });
  return { state, ports, auth: new ServiceGrantAuthentication(ports), sign };
}

it('authenticates nothing without trusted ports, whatever the caller asserts', async () => {
  const f = fixture();
  const none = new ServiceGrantAuthentication();
  expect(await none.authenticate({ assertion: f.sign() }, 'RESUME_SERVICE')).toBeNull();
  expect(await none.authenticateResume({ authenticatedOwner: true, RESUME_SERVICE: true })).toBeNull();
});

it('a valid assertion yields a lease that is current only for in-scope targets owned by the grant owner', async () => {
  const f = fixture();
  const lease = await f.auth.authenticate({ assertion: f.sign() }, 'RESUME_SERVICE');
  expect(lease).toMatchObject({ kind: 'RESUME_SERVICE', ownerId: 'owner', principal: 'svc', grantId: 'g1' });
  expect(lease!.current('employee')).toBe(true);
  expect(lease!.current('other')).toBe(false); // granted, but its canonical owner differs
  expect(lease!.current('outsider')).toBe(false); // not in scope
  expect(lease!.current('employee\n')).toBe(false);
  expect(Object.isFrozen(lease)).toBe(true);
});

it('refuses forged, malformed, over-long, expired, future and cross-purpose assertions', async () => {
  const f = fixture();
  const bad = [
    f.sign({}, randomBytes(32)),
    f.sign().replace(/.$/, (c) => (c === '0' ? '1' : '0')),
    f.sign({ expiresAt: f.state.now + 10_001 }),
    f.sign({ issuedAt: f.state.now - 6000, expiresAt: f.state.now - 1 }),
    f.sign({ issuedAt: f.state.now + 1, expiresAt: f.state.now + 2000 }),
    f.sign({ purpose: 'LEASE_SERVICE' }),
    f.sign({ ownerId: 'someone-else' }),
    f.sign({ epoch: 'e0' }),
    f.sign({ principal: 'other-svc' }),
    f.sign({ grantId: 'missing' }),
    f.sign({ nonce: 'xyz' }),
    'not-an-assertion',
    'x'.repeat(3000),
  ];
  for (const assertion of bad) expect(await f.auth.authenticate({ assertion }, 'RESUME_SERVICE')).toBeNull();
  expect(await f.auth.authenticate({}, 'RESUME_SERVICE')).toBeNull();
  expect(await f.auth.authenticate(Object.create({ assertion: f.sign() }), 'RESUME_SERVICE')).toBeNull();
  expect(await f.auth.authenticate({ assertion: f.sign() }, 'ADMIN' as ServicePurpose)).toBeNull();
});

it('a grant names exactly one purpose: a LEASE_SERVICE grant never authenticates resume, and vice versa', async () => {
  const lease = fixture('LEASE_SERVICE');
  const assertion = lease.sign({ purpose: 'RESUME_SERVICE' });
  expect(await lease.auth.authenticateResume({ assertion })).toBeNull();
  const ok = await lease.auth.authenticateLeaseService({ assertion: lease.sign() });
  expect(ok!.current('resource')).toBe(true);
  expect(ok!.current('employee')).toBe(false);
  const resume = fixture('RESUME_SERVICE');
  expect(
    await resume.auth.authenticateLeaseService({ assertion: resume.sign({ purpose: 'LEASE_SERVICE' }) })
  ).toBeNull();
});

it('rejects grants with titles, roles, booleans or other extra fields, duplicate scope or bad windows', async () => {
  for (const change of [
    (g: any) => (g.title = 'CTO'),
    (g: any) => (g.maintenance = true),
    (g: any) => (g.employees[0].role = 'COO'),
    (g: any) => (g.expiresAt = g.issuedAt),
    (g: any) => (g.owner = 'owner\n'),
    (g: any) => (g.expiresAt = NOW - 1),
    (g: any) => (g.epoch = 'e0'),
  ]) {
    const f = fixture();
    change(f.state.grant);
    expect(await f.auth.authenticate({ assertion: f.sign() }, 'RESUME_SERVICE')).toBeNull();
  }
});

it('replayed nonces and unknown revocation fail closed', async () => {
  const f = fixture();
  const assertion = f.sign();
  expect(await f.auth.authenticate({ assertion }, 'RESUME_SERVICE')).not.toBeNull();
  expect(await f.auth.authenticate({ assertion }, 'RESUME_SERVICE')).toBeNull();
  f.state.revoked = undefined;
  expect(await f.auth.authenticate({ assertion: f.sign() }, 'RESUME_SERVICE')).toBeNull();
});

it('current() turns false on revocation, grant edits, key rotation, expiry, nonce loss or owner change', async () => {
  const cases: Array<(s: ReturnType<typeof fixture>['state']) => void> = [
    (s) => (s.revoked = true),
    (s) => (s.revoked = undefined),
    (s) => s.grant.employees.pop(),
    (s) => (s.grant = undefined),
    (s) => (s.key = randomBytes(32)),
    (s) => (s.epoch = 'e2'),
    (s) => (s.now += 5000), // assertion lifetime over: re-authenticate per effect batch
    (s) => (s.nonceLost = true),
    (s) => (s.bindings.employee = { ...s.bindings.employee, owner: 'someone-else' }),
    (s) => (s.bindings.employee = { ...s.bindings.employee, sessionGeneration: 2 }),
    (s) => (s.bindings.employee = undefined),
  ];
  for (const change of cases) {
    const f = fixture();
    const lease = await f.auth.authenticate({ assertion: f.sign() }, 'RESUME_SERVICE');
    expect(lease!.current('employee')).toBe(true);
    change(f.state);
    expect(lease!.current('employee')).toBe(false);
  }
});

it('throwing ports never authenticate and never leak', async () => {
  const f = fixture();
  const boom = () => {
    throw new Error('secret port detail');
  };
  for (const name of ['issuer', 'grant', 'revoked'] as const) {
    const ports = { ...f.ports, [name]: boom };
    expect(
      await new ServiceGrantAuthentication(ports).authenticate({ assertion: f.sign() }, 'RESUME_SERVICE')
    ).toBeNull();
  }
  const lease = await new ServiceGrantAuthentication({ ...f.ports, binding: boom }).authenticate(
    { assertion: f.sign() },
    'RESUME_SERVICE'
  );
  expect(lease!.current('employee')).toBe(false);
});

it('plugs into CanonicalRecoveryAuthority: a permit only for the granted employee, revoked at once', async () => {
  const f = fixture();
  const metadata: RecoveryMetadata = {
    employeeId: 'employee',
    goalId: 'goal',
    goalGeneration: 1,
    sessionId: '11111111-1111-1111-1111-111111111111',
    sessionGeneration: 1,
    transitionSequence: 0,
    ownerId: 'owner',
    revision: 1,
    goalState: 'ACTIVE',
    desiredRunning: true,
    vacation: false,
    sleeping: false,
    pendingInput: false,
    dialog: 'NONE',
    activeJobs: 0,
    activeTurn: false,
    toolWait: false,
  };
  const authority = new CanonicalRecoveryAuthority({
    authenticate: f.auth.authenticateResume,
    read: (_owner, employeeId) => ({ ...metadata, employeeId }),
    frozen: async () => ({ current: () => true }),
  });
  const permit = await authority.prepare({ assertion: f.sign() }, 'employee');
  expect(permit).not.toBeNull();
  expect(permit!.current()).toBe(true);
  expect(await authority.prepare({ assertion: f.sign() }, 'outsider')).toBeNull();
  f.state.revoked = true;
  expect(permit!.current()).toBe(false);
});

it('purposes come from the deployment registry: a configured OPS purpose works, unconfigured or mis-scoped ones never do', async () => {
  const ops = fixture('OPS_WEB_RESTART' as ServicePurpose);
  ops.state.grant.resources = ['website'];
  const registry = { RESUME_SERVICE: 'employees', OPS_WEB_RESTART: 'resources' } as const;
  const configured = new ServiceGrantAuthentication(ops.ports, registry);
  const lease = await configured.authenticate({ assertion: ops.sign() }, 'OPS_WEB_RESTART');
  expect(lease!.current('website')).toBe(true);
  expect(lease!.current('other-site')).toBe(false);
  expect(await ops.auth.authenticate({ assertion: ops.sign() }, 'OPS_WEB_RESTART')).toBeNull(); // default registry
  expect(await configured.authenticateLeaseService({ assertion: ops.sign() })).toBeNull(); // LEASE_SERVICE not configured
  const resume = fixture();
  const misScoped = new ServiceGrantAuthentication(resume.ports, { RESUME_SERVICE: 'resources' });
  expect(await misScoped.authenticateResume({ assertion: resume.sign() })).toBeNull();
  expect(
    await new ServiceGrantAuthentication(resume.ports, { resume_service: 'employees' } as any).authenticate(
      { assertion: resume.sign() },
      'resume_service'
    )
  ).toBeNull();
});

it('single-owner deployments: a grant with no owner authenticates with an empty ownerId, and only that way', async () => {
  const f = fixture();
  delete f.state.grant.owner;
  for (const b of Object.values(f.state.bindings)) if (b) delete b.owner;
  const lease = await f.auth.authenticate({ assertion: f.sign({ ownerId: '' }) }, 'RESUME_SERVICE');
  expect(lease!.current('employee')).toBe(true);
  expect(await f.auth.authenticate({ assertion: f.sign({ ownerId: 'owner' }) }, 'RESUME_SERVICE')).toBeNull();
  const owned = fixture();
  expect(await owned.auth.authenticate({ assertion: owned.sign({ ownerId: '' }) }, 'RESUME_SERVICE')).toBeNull();
});
