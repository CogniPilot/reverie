import { afterEach, beforeEach, expect, it } from 'vitest';
import Fastify from 'fastify';
import * as fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classify } from '../src/owner-auth/policy.js';
import {
  createServiceDecisions,
  registerServiceDecisionRoute,
  registerServiceGrantRoutes,
  registerServiceGrantSetupPage,
  ServiceDecisions,
  SERVICE_ASSERTION_HEADER,
} from '../src/service-decision.js';
import { signServiceAssertion } from '../src/service-grant-auth.js';
import { loadServiceAuthConfig } from '../src/service-auth-config.js';
import { goalFixture } from './helpers/goal-test-fixture.js';

const FLOCK = fs.realpathSync(
  (process.env.PATH ?? '')
    .split(':')
    .map((item) => join(item, 'flock'))
    .find((item) => fs.existsSync(item))!
);
let f: Awaited<ReturnType<typeof goalFixture>>;
let dir: string;
let key: Buffer;
let n = 0;
const nonce = () => (++n).toString(16).padStart(32, '0');
const SESSION = '44444444-4444-4444-8444-444444444444';

beforeEach(async () => {
  f = await goalFixture();
  f.clock.now = Date.now(); // decisions run on the real clock; issue grants on the same one
  nonceProof = true;
  nonceChecks = 0;
  dir = fs.mkdtempSync(join(tmpdir(), 'service-decision-'));
  fs.chmodSync(dir, 0o700);
  fs.mkdirSync(join(dir, 'nonces'), { mode: 0o700 });
  // Install-time ledger initialization (SELF's step), as the nonce store requires.
  fs.writeFileSync(
    join(dir, 'nonces/ledger.json'),
    JSON.stringify({
      version: 1,
      storeId: '11111111-2222-4333-8444-555555555555',
      capacity: 64,
      revision: 0,
      clockFloor: Date.now() - 60_000,
      entries: [],
    }),
    { mode: 0o600 }
  );
  fs.writeFileSync(join(dir, 'nonces/ledger.json.lock'), '', { mode: 0o600 });
  key = randomBytes(32);
  fs.writeFileSync(join(dir, 'ops.key'), key, { mode: 0o400 });
  fs.writeFileSync(
    join(dir, 'service-auth.json'),
    JSON.stringify({
      version: 1,
      serviceUid: process.geteuid!(),
      purposes: {
        OPS_STATUS: { scope: 'employees+resources', action: 'reverie.ops.status' },
        OPS_WEBSITE_RESTART: { scope: 'employees+resources', action: 'reverie.ops.website.restart' },
        LEASE_SERVICE: { scope: 'resources', action: 'reverie.prune.lease' },
      },
      principals: [{ principal: 'ops', epoch: 'e1', key: join(dir, 'ops.key') }],
    }),
    { mode: 0o600 }
  );
  await f.store.update((state) => {
    state.employees.find((e) => e.id === 'w')!.sessionId = SESSION;
  });
});
afterEach(async () => {
  fs.rmSync(dir, { recursive: true, force: true });
  await f.cleanup();
});
const custody = { assertPrivateCustody: () => undefined };
// Stands in for the Goal private bootstrap's projection: it re-proves the EXACT whole scope before every storage operation.
let nonceProof = true;
let nonceChecks = 0;
const nonceOptions = (authority = join(dir, 'nonces/authority')) => ({
  file: join(dir, 'nonces/ledger.json'),
  storeId: '11111111-2222-4333-8444-555555555555',
  capacity: 64,
  flockExecutable: FLOCK,
  authorityNamespace: authority,
  assertPrivateCustody: (scope: Record<string, string>) => {
    nonceChecks++;
    const expected = {
      root: join(dir, 'nonces'),
      parent: dir,
      file: join(dir, 'nonces/ledger.json'),
      lock: join(dir, 'nonces/ledger.json.lock'),
      temporary: join(dir, 'nonces/ledger.json.pending'),
      authorityNamespace: join(dir, 'nonces/authority'),
    };
    if (!nonceProof || JSON.stringify(scope) !== JSON.stringify(expected))
      throw new Error('projected nonce custody absent');
  },
});
const decisions = (file = join(dir, 'service-auth.json')) =>
  createServiceDecisions(loadServiceAuthConfig(file), { company: { store: f.store }, custody, nonce: nonceOptions() });
async function grant(purpose = 'OPS_WEBSITE_RESTART', resources = ['website']) {
  const { GoalLifecycle } = await import('../src/goal-lifecycle.js');
  const goals = new GoalLifecycle(f.store, () => f.clock.now, f.auth, {
    OPS_STATUS: 'employees+resources',
    OPS_WEBSITE_RESTART: 'employees+resources',
    LEASE_SERVICE: 'resources',
  });
  const scope = purpose === 'LEASE_SERVICE' ? { resources } : { employeeIds: ['w'], resources };
  return goals.issueServiceGrant(
    { purpose, principal: 'ops', epoch: 'e1', ...scope, expiresAt: Date.now() + 60_000 },
    'owner'
  );
}
const assertion = (grantId: string, purpose = 'OPS_WEBSITE_RESTART', over: Record<string, unknown> = {}) =>
  signServiceAssertion(key, {
    purpose,
    principal: 'ops',
    epoch: 'e1',
    ownerId: 'a',
    grantId,
    issuedAt: Date.now() - 100,
    expiresAt: Date.now() + 5000,
    nonce: nonce(),
    ...over,
  } as never);

it('the decision route is public at the owner policy layer and a bare 403 without configured decisions', async () => {
  expect(classify('POST', '/api/service-decisions', '/api/service-decisions')).toBe('public');
  const app = Fastify();
  registerServiceDecisionRoute(app);
  const response = await app.inject({
    method: 'POST',
    url: '/api/service-decisions',
    payload: { action: 'reverie.ops.status' },
  });
  expect(response.statusCode).toBe(403);
  expect(response.json()).toEqual({
    success: false,
    errorCode: 'SERVICE_FORBIDDEN',
    error: 'Service decision unavailable',
  });
  await app.close();
});

it('end to end: real config, key file, durable nonce store and canonical grant decide exactly the granted scope', async () => {
  const issued = await grant();
  const app = Fastify();
  registerServiceDecisionRoute(app, decisions());
  const ask = (body: unknown, header = assertion(issued.id)) =>
    app.inject({
      method: 'POST',
      url: '/api/service-decisions',
      headers: { [SERVICE_ASSERTION_HEADER]: header },
      payload: body as object,
    });
  const ok = await ask({ action: 'reverie.ops.website.restart', employeeId: 'w', resourceId: 'website' });
  expect(ok.statusCode, ok.body).toBe(200);
  const body = ok.json();
  expect(body).toMatchObject({
    decision: 'allowed',
    reason: 'none',
    grantRef: { grantId: issued.id },
    epoch: 'e1',
    actor: { employeeId: 'w', sessionId: SESSION, sessionGeneration: 1 },
  });
  expect(body.grantRef.policyGeneration).toMatch(/^sha256:[0-9a-f]{64}$/);
  // Last-effect recheck with a fresh assertion: same generation while nothing changed.
  const again = await ask({ action: 'reverie.ops.website.restart', employeeId: 'w', resourceId: 'website' });
  expect(again.json().grantRef.policyGeneration).toBe(body.grantRef.policyGeneration);
  expect(
    (await ask({ action: 'reverie.ops.website.restart', employeeId: 'w', resourceId: 'other' })).json().decision
  ).toBe('denied');
  expect(
    (await ask({ action: 'reverie.ops.website.restart', employeeId: 'v', resourceId: 'website' })).json().decision
  ).toBe('denied');
  // Replay of a spent assertion, a purpose/action mismatch, unknown actions and malformed bodies are bare 403s.
  const spent = assertion(issued.id);
  expect(
    (await ask({ action: 'reverie.ops.website.restart', employeeId: 'w', resourceId: 'website' }, spent)).statusCode
  ).toBe(200);
  expect(
    (await ask({ action: 'reverie.ops.website.restart', employeeId: 'w', resourceId: 'website' }, spent)).statusCode
  ).toBe(403);
  expect((await ask({ action: 'reverie.ops.status', employeeId: 'w', resourceId: 'website' })).statusCode).toBe(403);
  expect((await ask({ action: 'reverie.ops.shell', employeeId: 'w', resourceId: 'website' })).statusCode).toBe(403);
  expect((await ask({ action: 'reverie.ops.website.restart', resourceId: 'website' })).statusCode).toBe(403);
  expect(
    (await ask({ action: 'reverie.ops.website.restart', employeeId: 'w', resourceId: 'website', argv: ['x'] }))
      .statusCode
  ).toBe(403);
  expect(
    (
      await ask(
        { action: 'reverie.ops.website.restart', employeeId: 'w', resourceId: 'website' },
        'forged.' + '0'.repeat(64)
      )
    ).statusCode
  ).toBe(403);
  // Revocation turns the next answer into a refusal.
  await f.goals.revokeServiceGrant(issued.id, 'owner');
  expect(
    (await ask({ action: 'reverie.ops.website.restart', employeeId: 'w', resourceId: 'website' })).statusCode
  ).toBe(403);
  await app.close();
});

it('resource-scoped purposes take only a resource; a removed key makes every decision unavailable', async () => {
  const issued = await grant('LEASE_SERVICE', ['disposable-b']);
  const d = decisions();
  const leaseAssertion = () => assertion(issued.id, 'LEASE_SERVICE');
  expect(await d.decide(leaseAssertion(), { action: 'reverie.prune.lease', resourceId: 'disposable-b' })).toMatchObject(
    { decision: 'allowed' }
  );
  expect(await d.decide(leaseAssertion(), { action: 'reverie.prune.lease', resourceId: 'other' })).toMatchObject({
    decision: 'denied',
  });
  expect(
    await d.decide(leaseAssertion(), { action: 'reverie.prune.lease', employeeId: 'w', resourceId: 'disposable-b' })
  ).toBeNull();
  fs.unlinkSync(join(dir, 'ops.key'));
  expect(await d.decide(leaseAssertion(), { action: 'reverie.prune.lease', resourceId: 'disposable-b' })).toBeNull();
  expect(
    await new ServiceDecisions().decide(leaseAssertion(), { action: 'reverie.prune.lease', resourceId: 'disposable-b' })
  ).toBeNull();
});

it('r2d: nonce custody is the projected whole scope: missing, stale or mismatched proof makes decisions unavailable', async () => {
  const issued = await grant();
  const body = { action: 'reverie.ops.website.restart', employeeId: 'w', resourceId: 'website' };
  expect(await decisions().decide(assertion(issued.id), body)).toMatchObject({ decision: 'allowed' });
  expect(nonceChecks).toBeGreaterThan(0);
  nonceProof = false; // proof withdrawn (missing or stale projection)
  expect(await decisions().decide(assertion(issued.id), body)).toBeNull();
  nonceProof = true;
  const mismatched = createServiceDecisions(loadServiceAuthConfig(join(dir, 'service-auth.json')), {
    company: { store: f.store },
    custody,
    nonce: nonceOptions(join(dir, 'elsewhere')),
  });
  expect(await mismatched.decide(assertion(issued.id), body)).toBeNull();
  // Canonical-store custody withdrawn also refuses.
  const noCustody = createServiceDecisions(loadServiceAuthConfig(join(dir, 'service-auth.json')), {
    company: { store: f.store },
    custody: {
      assertPrivateCustody: () => {
        throw new Error('custody absent');
      },
    },
    nonce: nonceOptions(),
  });
  expect(await noCustody.decide(assertion(issued.id), body)).toBeNull();
  fs.chmodSync(join(dir, 'service-auth.json'), 0o666);
  expect(() => loadServiceAuthConfig(join(dir, 'service-auth.json'))).toThrow();
});

it('r2d: the real non-root service uid (no trust override) with projected custody allows a valid assertion', async () => {
  const issued = await grant();
  expect(
    await decisions().decide(assertion(issued.id), {
      action: 'reverie.ops.website.restart',
      employeeId: 'w',
      resourceId: 'website',
    })
  ).toMatchObject({ decision: 'allowed', actor: { employeeId: 'w', sessionId: SESSION } });
});

it('r2d: serviceUid must be the running uid; without it only root is trusted', async () => {
  const config = JSON.parse(fs.readFileSync(join(dir, 'service-auth.json'), 'utf8'));
  fs.writeFileSync(join(dir, 'other-uid.json'), JSON.stringify({ ...config, serviceUid: process.geteuid!() + 1 }), {
    mode: 0o600,
  });
  expect(() => loadServiceAuthConfig(join(dir, 'other-uid.json'))).toThrow(/serviceUid/);
  const { serviceUid: _drop, ...rootOnly } = config;
  fs.writeFileSync(join(dir, 'root-only.json'), JSON.stringify(rootOnly), { mode: 0o600 });
  expect(() => loadServiceAuthConfig(join(dir, 'root-only.json'))).toThrow(/owner is not trusted/);
});

it('service grant routes run on a GoalLifecycle facade; owner allowed, employee refused', async () => {
  const { GoalLifecycle } = await import('../src/goal-lifecycle.js');
  const app = Fastify();
  registerServiceGrantRoutes(
    app,
    new GoalLifecycle(f.store, () => f.clock.now, f.auth, { OPS_WEBSITE_RESTART: 'employees+resources' })
  );
  const body = {
    purpose: 'OPS_WEBSITE_RESTART',
    principal: 'ops',
    epoch: 'e1',
    employeeIds: ['w'],
    resources: ['website'],
    expiresAt: f.clock.now + 60_000,
  };
  const as = (who: string, url: string, payload: object) =>
    app.inject({ method: 'POST', url, headers: { authorization: 'Bearer synthetic-' + who }, payload });
  expect((await as('worker', '/api/service-grants', body)).statusCode).toBe(403);
  const issued = await as('owner', '/api/service-grants', body);
  expect(issued.statusCode, issued.body).toBe(200);
  const id = issued.json().data.id;
  expect((await as('worker', `/api/service-grants/${id}/revoke`, {})).statusCode).toBe(403);
  expect((await as('owner', `/api/service-grants/${id}/revoke`, {})).statusCode).toBe(200);
  expect(f.store.snapshot().serviceGrantRevocations.map((r) => r.grantId)).toEqual([id]);
  await app.close();
  const none = Fastify();
  registerServiceGrantRoutes(none);
  expect((await none.inject({ method: 'POST', url: '/api/service-grants', payload: body })).statusCode).toBe(403);
  await none.close();
});

it('r2c: owner setup page shows one button per configured grant with current ids and epoch; nothing is issued by rendering', async () => {
  const config = JSON.parse(fs.readFileSync(join(dir, 'service-auth.json'), 'utf8'));
  config.setupGrants = [
    { purpose: 'OPS_WEBSITE_RESTART', principal: 'ops', employees: ['w'], resources: ['website'], expiresInHours: 24 },
    {
      purpose: 'OPS_STATUS',
      principal: 'ops',
      employees: ['Nobody Here'],
      resources: ['website'],
      expiresInHours: 720,
    },
  ];
  fs.writeFileSync(join(dir, 'setup.json'), JSON.stringify(config), { mode: 0o600 });
  await f.store.update((state) => {
    state.employees.find((e) => e.id === 'w')!.name = '<img src=x onerror=alert(1)>';
  });
  const app = Fastify();
  registerServiceGrantSetupPage(app, {
    loaded: loadServiceAuthConfig(join(dir, 'setup.json')),
    company: { store: f.store },
    owner: f.auth,
  });
  const page = (who: string) =>
    app.inject({
      method: 'GET',
      url: '/api/service-grants/setup',
      headers: { authorization: 'Bearer synthetic-' + who },
    });
  expect((await page('worker')).statusCode).toBe(403);
  const html = await page('owner');
  expect(html.statusCode, html.body).toBe(200);
  expect(html.headers['content-type']).toMatch(/text\/html/);
  expect(html.body).not.toContain('<img src=x');
  expect(html.body).toContain('&lt;img src=x onerror=alert(1)&gt;');
  const buttons = [...html.body.matchAll(/data-body="([^"]*)"/g)].map((m) =>
    JSON.parse(m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, '&'))
  );
  expect(buttons).toHaveLength(1);
  expect(buttons[0]).toMatchObject({
    purpose: 'OPS_WEBSITE_RESTART',
    principal: 'ops',
    epoch: 'e1',
    employeeIds: ['w'],
    resources: ['website'],
  });
  expect(html.body).toContain('does not resolve to exactly one active employee');
  expect(f.store.snapshot().serviceGrants).toEqual([]);
  await app.close();
  const none = Fastify();
  registerServiceGrantSetupPage(none);
  expect((await none.inject({ method: 'GET', url: '/api/service-grants/setup' })).statusCode).toBe(403);
  await none.close();
});
