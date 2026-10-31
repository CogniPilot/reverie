import { readFile, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  CompanyStore,
  SERVICE_AUTHORITY_BUDGET,
  serviceAuthorityBytes,
  serviceAuthorityFits,
  serviceRevocationBytes,
} from '../src/company-store.js';
import { canonicalServiceGrantSource } from '../src/service-grant-auth.js';
import { goalFixture } from './helpers/goal-test-fixture.js';

let f: Awaited<ReturnType<typeof goalFixture>>;
beforeEach(async () => {
  f = await goalFixture();
});
afterEach(async () => {
  await f.cleanup();
});
const custody = { assertPrivateCustody: () => undefined };
const resume = (over: Record<string, unknown> = {}) => ({
  purpose: 'RESUME_SERVICE',
  principal: 'resume-svc',
  epoch: 'e1',
  employeeIds: ['w'],
  expiresAt: f.clock.now + 3600_000,
  ...over,
});

it('only the authenticated owner issues and revokes service grants, bound to current exact employee bindings', async () => {
  await expect(f.goals.issueServiceGrant(resume(), 'worker')).rejects.toMatchObject({ code: 'GOAL_FORBIDDEN' });
  const grant = await f.goals.issueServiceGrant(resume(), 'owner');
  expect(grant).toMatchObject({
    purpose: 'RESUME_SERVICE',
    owner: 'a',
    principal: 'resume-svc',
    epoch: 'e1',
    employees: [{ employeeId: 'w', sessionId: 's', sessionGeneration: 1 }],
    resources: [],
  });
  const source = canonicalServiceGrantSource({ company: { store: f.store }, custody });
  expect(source.grant(grant.id)).toEqual(grant);
  expect(source.revoked(grant.id)).toBe(false);
  expect(source.revoked('unknown')).toBeUndefined();
  await expect(f.goals.revokeServiceGrant(grant.id, 'worker')).rejects.toMatchObject({ code: 'GOAL_FORBIDDEN' });
  await expect(f.goals.revokeServiceGrant(grant.id, 'otherOwner')).rejects.toBeTruthy();
  await f.goals.revokeServiceGrant(grant.id, 'owner');
  expect(source.revoked(grant.id)).toBe(true);
});

it('refuses mixed scope, empty scope, duplicates, foreign or inactive employees, long expiry and extra fields', async () => {
  for (const bad of [
    resume({ resources: ['r1'] }),
    resume({ employeeIds: [] }),
    resume({ employeeIds: ['w', 'w'] }),
    resume({ employeeIds: ['nobody'] }),
    resume({ expiresAt: f.clock.now }),
    resume({ expiresAt: f.clock.now + 91 * 24 * 3600_000 }),
    resume({ title: 'CTO' }),
    { purpose: 'LEASE_SERVICE', principal: 'lease-svc', epoch: 'e1', resources: [], expiresAt: f.clock.now + 1000 },
    {
      purpose: 'LEASE_SERVICE',
      principal: 'lease-svc',
      epoch: 'e1',
      resources: ['b'],
      employeeIds: ['w'],
      expiresAt: f.clock.now + 1000,
    },
    { ...resume(), purpose: 'ADMIN' },
  ])
    await expect(f.goals.issueServiceGrant(bad, 'owner')).rejects.toBeTruthy();
  const lease = await f.goals.issueServiceGrant(
    {
      purpose: 'LEASE_SERVICE',
      principal: 'lease-svc',
      epoch: 'e1',
      resources: ['disposable-b'],
      expiresAt: f.clock.now + 1000,
    },
    'owner'
  );
  expect(lease).toMatchObject({ employees: [], resources: ['disposable-b'] });
});

it('reads bindings from the same store: active unique UUID sessions only, custody checked around reads', async () => {
  const session = '33333333-3333-4333-8333-333333333333';
  await f.store.update((state) => {
    state.employees.find((e) => e.id === 'w')!.sessionId = session;
  });
  let custodyCalls = 0;
  const source = canonicalServiceGrantSource({
    company: { store: f.store },
    custody: { assertPrivateCustody: () => void custodyCalls++ },
  });
  expect(source.binding('w')).toEqual({ owner: 'a', employeeId: 'w', sessionId: session, sessionGeneration: 1 });
  expect(custodyCalls).toBe(2);
  expect(source.binding('v')).toBeUndefined(); // non-UUID session id
  expect(source.binding('nobody')).toBeUndefined();
  await f.store.update((state) => {
    state.employees.find((e) => e.id === 'w')!.onVacation = true;
  });
  expect(source.binding('w')).toBeUndefined();
  const failing = canonicalServiceGrantSource({
    company: { store: f.store },
    custody: {
      assertPrivateCustody: () => {
        throw new Error('custody');
      },
    },
  });
  expect(() => failing.grant('x')).toThrow();
});

it('legacy company files without service grant collections still load with empty defaults', async () => {
  const old = JSON.parse(await readFile(f.file, 'utf8'));
  delete old.serviceGrants;
  delete old.serviceGrantRevocations;
  await writeFile(f.file, JSON.stringify(old));
  const store = new CompanyStore(f.file);
  await store.init();
  expect(store.snapshot().serviceGrants).toEqual([]);
  expect(store.snapshot().serviceGrantRevocations).toEqual([]);
});

it('only purposes in the configured registry can be issued, with the configured scope kind', async () => {
  const { GoalLifecycle } = await import('../src/goal-lifecycle.js');
  const ops = {
    purpose: 'OPS_WEB_RESTART',
    principal: 'ops-svc',
    epoch: 'e1',
    resources: ['website'],
    expiresAt: f.clock.now + 1000,
  };
  await expect(f.goals.issueServiceGrant(ops, 'owner')).rejects.toBeTruthy(); // not in the default registry
  const configured = new GoalLifecycle(f.store, () => f.clock.now, f.auth, { OPS_WEB_RESTART: 'resources' });
  expect(await configured.issueServiceGrant(ops, 'owner')).toMatchObject({
    purpose: 'OPS_WEB_RESTART',
    resources: ['website'],
  });
  await expect(configured.issueServiceGrant(resume(), 'owner')).rejects.toBeTruthy(); // RESUME_SERVICE not configured here
  await expect(configured.issueServiceGrant({ ...ops, purpose: 'ops_lower' }, 'owner')).rejects.toBeTruthy();
});

it('employees+resources purposes (OPS) need both employees and resources', async () => {
  const { GoalLifecycle } = await import('../src/goal-lifecycle.js');
  const ops = new GoalLifecycle(f.store, () => f.clock.now, f.auth, { OPS_WEBSITE_RESTART: 'employees+resources' });
  const base = { purpose: 'OPS_WEBSITE_RESTART', principal: 'ops', epoch: 'e1', expiresAt: f.clock.now + 1000 };
  await expect(ops.issueServiceGrant({ ...base, resources: ['website'] }, 'owner')).rejects.toBeTruthy();
  await expect(ops.issueServiceGrant({ ...base, employeeIds: ['w'] }, 'owner')).rejects.toBeTruthy();
  expect(await ops.issueServiceGrant({ ...base, employeeIds: ['w'], resources: ['website'] }, 'owner')).toMatchObject({
    employees: [{ employeeId: 'w' }],
    resources: ['website'],
  });
});

it('AUTH-S1: service authority is budgeted at commit; over-budget issuance leaves state unchanged and revocation still works', async () => {
  const resources = Array.from({ length: 256 }, (_, j) => `r${j}-`.padEnd(100, 'x'));
  const big = (i: number) => ({
    id: `fill-${i}`,
    purpose: 'LEASE_SERVICE',
    owner: 'a',
    principal: 'lease-svc',
    epoch: 'e1',
    employees: [],
    resources,
    issuedAt: f.clock.now,
    expiresAt: f.clock.now + 1000,
  });
  await f.store.update((state) => {
    for (let i = 0; ; i++) {
      state.serviceGrants.push(big(i));
      if (!serviceAuthorityFits(state)) {
        state.serviceGrants.pop();
        break;
      }
    }
  });
  const filled = f.store.snapshot();
  expect(filled.serviceGrants.length).toBeGreaterThan(10);
  const before = await readFile(f.file);
  const input = {
    purpose: 'LEASE_SERVICE',
    principal: 'lease-svc',
    epoch: 'e1',
    resources,
    expiresAt: f.clock.now + 1000,
  };
  await expect(f.goals.issueServiceGrant(input, 'owner')).rejects.toBeTruthy();
  expect((await readFile(f.file)).equals(before)).toBe(true);
  expect(f.store.snapshot()).toEqual(filled);
  // At the boundary every live grant stays revocable: revoke some through the owner command, and the reserve covers all.
  for (const grant of filled.serviceGrants.slice(0, 3)) await f.goals.revokeServiceGrant(grant.id, 'owner');
  expect(f.store.snapshot().serviceGrantRevocations).toHaveLength(3);
  const allRevoked = {
    serviceGrants: filled.serviceGrants,
    serviceGrantRevocations: filled.serviceGrants.map((g) => ({
      grantId: g.id,
      owner: g.owner,
      at: Number.MAX_SAFE_INTEGER,
    })),
  };
  expect(serviceAuthorityBytes(allRevoked)).toBeLessThanOrEqual(SERVICE_AUTHORITY_BUDGET);
  expect(serviceRevocationBytes('a')).toBeGreaterThan(JSON.stringify(allRevoked.serviceGrantRevocations[0]).length);
  // The commit boundary itself refuses any writer that exceeds the budget.
  await expect(
    f.store.update((state) => {
      for (let i = 1000; serviceAuthorityBytes(state) <= SERVICE_AUTHORITY_BUDGET; i++)
        state.serviceGrants.push(big(i));
    })
  ).rejects.toThrow(/service grant storage budget/);
  expect(f.store.snapshot().serviceGrants).toHaveLength(filled.serviceGrants.length);
}, 30_000);

it('OREC retention check: expired grants past retention are pruned with their revocations, so 1000 issue/revoke cycles never jam', async () => {
  const { SERVICE_GRANT_RETENTION_MS } = await import('../src/goal-lifecycle.js');
  const lease = (expiresIn: number) => ({
    purpose: 'LEASE_SERVICE',
    principal: 'lease-svc',
    epoch: 'e1',
    resources: ['disposable-b'],
    expiresAt: f.clock.now + expiresIn,
  });
  for (let i = 0; i < 1000; i++) {
    const grant = await f.goals.issueServiceGrant(lease(3600_000), 'owner');
    await f.goals.revokeServiceGrant(grant.id, 'owner');
    f.clock.now += 3600_000 + SERVICE_GRANT_RETENTION_MS + 1;
  }
  const state = f.store.snapshot();
  expect(state.serviceGrants.length).toBeLessThanOrEqual(1);
  expect(state.serviceGrantRevocations.every((r) => state.serviceGrants.some((g) => g.id === r.grantId))).toBe(true);
}, 120_000);

it('OREC retention check: retention keeps revocation evidence; 256 live grants refuse clearly with the file unchanged', async () => {
  const { SERVICE_GRANT_RETENTION_MS } = await import('../src/goal-lifecycle.js');
  const lease = (expiresIn: number) => ({
    purpose: 'LEASE_SERVICE',
    principal: 'lease-svc',
    epoch: 'e1',
    resources: ['disposable-b'],
    expiresAt: f.clock.now + expiresIn,
  });
  const early = await f.goals.issueServiceGrant(lease(1000), 'owner');
  await f.goals.revokeServiceGrant(early.id, 'owner');
  f.clock.now += 2000; // expired, but inside retention
  await f.goals.issueServiceGrant(lease(60_000), 'owner');
  let state = f.store.snapshot();
  expect(state.serviceGrants.map((g) => g.id)).toContain(early.id);
  expect(state.serviceGrantRevocations.map((r) => r.grantId)).toEqual([early.id]);
  f.clock.now += SERVICE_GRANT_RETENTION_MS; // now past retention: pruned by the next issuance
  await f.store.update((s) => {
    while (s.serviceGrants.length < 256)
      s.serviceGrants.push({
        ...s.serviceGrants[s.serviceGrants.length - 1]!,
        id: `live-${s.serviceGrants.length}`,
        expiresAt: f.clock.now + 60_000,
      });
  });
  const before = await readFile(f.file);
  // 256 records, one of which is prunable: the issuance prunes it and succeeds.
  await f.goals.issueServiceGrant(lease(60_000), 'owner');
  state = f.store.snapshot();
  expect(state.serviceGrants.map((g) => g.id)).not.toContain(early.id);
  expect(state.serviceGrantRevocations).toEqual([]);
  expect(state.serviceGrants).toHaveLength(256);
  // Now every record is live: the next issuance is refused with a clear reason and nothing changes.
  const full = await readFile(f.file);
  await expect(f.goals.issueServiceGrant(lease(60_000), 'owner')).rejects.toThrow(/limit reached/);
  expect((await readFile(f.file)).equals(full)).toBe(true);
  expect(before.equals(full)).toBe(false);
});
