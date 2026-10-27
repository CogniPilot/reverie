import { createHash, createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { goalFixtureRepository } from './goal-source-fixture.js';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  GOAL_ASSERTION_HEADER,
  GoalBrokerAuthentication,
  isBrokerGoalRequest,
  registerGoalBrokerBoundary,
  type GoalBrokerBinding,
  type GoalBrokerIssuer,
  type GoalBrokerPorts,
  type GoalNonceKey,
} from '../src/goal-broker-auth.js';

const SID = '11111111-2222-3333-4444-555555555555';
const KEY = Buffer.from('not-a-deployment-key-synthetic-01!');
const BODY = Buffer.from('{"objective":"synthetic"}');
const sha = (body: Buffer) => createHash('sha256').update(body).digest('hex');
function token(overrides: Record<number, unknown> = {}, body = BODY): string {
  const fields: unknown[] = [
    1,
    'goal-request',
    'test-broker',
    'test-epoch',
    SID,
    7,
    'POST',
    '/api/goals',
    sha(body),
    100_000,
    110_000,
    'a'.repeat(32),
  ];
  for (const [index, value] of Object.entries(overrides)) fields[Number(index)] = value;
  const encoded = Buffer.from(JSON.stringify(fields)).toString('base64url');
  return (
    encoded +
    '.' +
    createHmac('sha256', KEY)
      .update('reverie-goal-request-v1\n' + encoded)
      .digest('hex')
  );
}
function fixture() {
  let now = 100_000;
  let binding: GoalBrokerBinding | undefined = {
    owner: 'owner-1',
    employeeId: 'employee-1',
    sessionId: SID,
    sessionGeneration: 7,
  };
  let issuer: GoalBrokerIssuer | undefined = { epoch: 'test-epoch', key: KEY };
  let custody = true;
  let afterClaim = () => {};
  const claims = new Map<string, object>();
  const nonceId = (key: GoalNonceKey) => JSON.stringify([key.issuer, key.epoch, key.nonce]);
  const ports: GoalBrokerPorts = {
    canonicalFile: '/synthetic-private/company.json',
    now: () => now,
    issuer: (id) => (id === 'test-broker' ? issuer : undefined),
    binding: (sid) => (sid === SID ? binding : undefined),
    assertPrivateCustody: (file) => {
      if (!custody || file !== '/synthetic-private/company.json') throw Error('private proof unavailable');
    },
    nonces: {
      claim: async (key) => {
        const id = nonceId(key);
        if (claims.has(id)) return undefined;
        const claim = {};
        claims.set(id, claim);
        await Promise.resolve();
        afterClaim();
        return claim;
      },
      assertCurrent: (claim, key) => {
        if (claims.get(nonceId(key)) !== claim) throw Error('claim no longer current');
      },
    },
  };
  const auth = new GoalBrokerAuthentication(ports);
  return {
    auth,
    ports,
    claims,
    setNow: (value: number) => {
      now = value;
    },
    setBinding: (value?: GoalBrokerBinding) => {
      binding = value;
    },
    setIssuer: (value?: GoalBrokerIssuer) => {
      issuer = value;
    },
    setCustody: (value: boolean) => {
      custody = value;
    },
    afterClaim: (value: () => void) => {
      afterClaim = value;
    },
  };
}
const request = (assertion = token(), extra = {}) => ({
  method: 'POST',
  target: '/api/goals',
  body: BODY,
  assertion,
  ...extra,
});
const denied = (operation: Promise<unknown>) =>
  expect(operation).rejects.toMatchObject({ code: 'GOAL_FORBIDDEN', status: 403 });

// Component mode uses real codecs with synthetic key/binding/clock/transport; it is not Office signing.
function fixtureForward(mode: 'component-proof' | 'restricted-office', input: Record<string, unknown>) {
  const args = ['-B', '-m', 'tests.goal_broker_fixture'];
  if (mode === 'component-proof') args.push('--component-proof');
  return JSON.parse(
    execFileSync('python3', args, {
      cwd: goalFixtureRepository(import.meta.dirname),
      input: JSON.stringify(input),
      encoding: 'utf8',
      timeout: 5000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, PYTHONDONTWRITEBYTECODE: '1' },
    })
  );
}

const componentProof = (input: Record<string, unknown>) => fixtureForward('component-proof', input);
const restrictedOffice = (input: Record<string, unknown>) => fixtureForward('restricted-office', input);

describe('purpose-separated broker Goal boundary', () => {
  const canonicalRoutes = (value: string): Array<{ method: 'GET' | 'POST'; target: string; route: string }> => [
    { method: 'GET', target: '/api/goals/' + value, route: '/api/goals/:id' },
    { method: 'POST', target: '/api/goals/' + value + '/transitions', route: '/api/goals/:id/transitions' },
    { method: 'POST', target: '/api/goals/' + value + '/adopt', route: '/api/goals/:id/adopt' },
    { method: 'POST', target: '/api/goals/' + value + '/unblock-proofs', route: '/api/goals/:id/unblock-proofs' },
    { method: 'POST', target: '/api/goal-grants/' + value + '/revoke', route: '/api/goal-grants/:id/revoke' },
    {
      method: 'POST',
      target: '/api/goal-unblock-proofs/' + value + '/revoke',
      route: '/api/goal-unblock-proofs/:id/revoke',
    },
    { method: 'GET', target: '/api/goal-metadata/' + value, route: '/api/goal-metadata/:employeeId' },
    { method: 'GET', target: '/api/goal-metadata/worker?grantId=' + value, route: '/api/goal-metadata/:employeeId' },
    {
      method: 'GET',
      target: '/api/goal-metadata/' + value + '?grantId=' + value,
      route: '/api/goal-metadata/:employeeId',
    },
  ];

  it.each([64, 65, 100])(
    'synthetic proof component → server accepts canonical route identifiers of length%s',
    async (size) => {
      const value = 'Aa0_.:-'.repeat(15).slice(0, size);
      for (const { method, target, route } of canonicalRoutes(value)) {
        expect(isBrokerGoalRequest(method, target)).toBe(true);
        const forwarded = componentProof({ method, target, body: method === 'GET' ? '' : '{}' });
        expect(forwarded.target).toBe(target);
        const f = fixture();
        const app = Fastify();
        registerGoalBrokerBoundary(app, f.auth);
        app.route({
          method,
          url: route,
          handler: async (req) => {
            const principal = await f.auth.authenticate(req);
            expect(principal?.employeeId).toBe('employee-1');
            return { accepted: true };
          },
        });
        try {
          const response = await app.inject({
            method,
            url: target,
            ...(method === 'POST' ? { payload: forwarded.body } : {}),
            headers: forwarded.headers,
          });
          expect(response.statusCode, target).toBe(200);
          expect(response.json()).toEqual({ accepted: true });
        } finally {
          await app.close();
        }
      }
    }
  );

  it.each(['x'.repeat(101), 'bad%41', 'bad/name', 'bad name', 'bad\n', 'nonascii-é', 'bad?extra=1'])(
    'both languages reject overlong or invalid canonical route identifier %s',
    async (value) => {
      for (const { method, target } of canonicalRoutes(value)) {
        expect(isBrokerGoalRequest(method, target), target).toBe(false);
        for (const forward of [componentProof, restrictedOffice])
          expect(forward({ method, target, body: method === 'GET' ? '' : '{}' })).toEqual({
            refused: 403,
            upstream: false,
            environmentReads: 0,
          });
        const f = fixture();
        const body = method === 'GET' ? Buffer.alloc(0) : Buffer.from('{}');
        await denied(f.auth.verify({}, { method, target, body, assertion: token({ 6: method, 7: target }, body) }));
        expect(f.claims.size).toBe(0);
      }
    }
  );

  it.each([64, 65, 100])(
    'synthetic proof component accepts the canonical authenticated employee identifier length%s',
    async (size) => {
      const f = fixture();
      const employeeId = 'e'.repeat(size);
      f.setBinding({ owner: 'owner-1', employeeId, sessionId: SID, sessionGeneration: 7 });
      const forwarded = componentProof({ method: 'GET', target: '/api/goal-metadata/' + employeeId, body: '' });
      const context = {};
      await f.auth.verify(context, {
        method: 'GET',
        target: forwarded.target,
        body: Buffer.alloc(0),
        assertion: forwarded.headers['X-Reverie-Goal-Assertion'],
      });
      expect((await f.auth.authenticate(context))?.employeeId).toBe(employeeId);
    }
  );

  it.each(['e'.repeat(101), '', 'bad/name', 'bad%41', 'nonascii-é', 'bad\n'])(
    'refuses invalid canonical binding employee identifier%s before nonce claim',
    async (employeeId) => {
      const f = fixture();
      f.setBinding({ owner: 'owner-1', employeeId, sessionId: SID, sessionGeneration: 7 });
      await denied(f.auth.verify({}, request()));
      expect(f.claims.size).toBe(0);
    }
  );

  it.each([2, 3])('issuer/epoch field%s keeps its separate64-character limit', async (index) => {
    for (const length of [64, 65]) {
      const f = fixture();
      const fields = { [index]: 'i'.repeat(length) };
      const ports = {
        ...f.ports,
        issuer: () => ({ epoch: index === 3 ? 'i'.repeat(length) : 'test-epoch', key: KEY }),
      };
      const auth = new GoalBrokerAuthentication(ports);
      const context = {};
      if (length === 64) {
        await auth.verify(context, request(token(fields)));
        expect((await auth.authenticate(context))?.employeeId).toBe('employee-1');
      } else {
        await denied(auth.verify(context, request(token(fields))));
        expect(f.claims.size).toBe(0);
      }
    }
  });

  it('default unavailable ports deny even a correctly signed synthetic assertion', async () => {
    const auth = new GoalBrokerAuthentication();
    await denied(auth.verify({}, request()));
    expect(await auth.authenticate({ headers: { [GOAL_ASSERTION_HEADER]: token() } })).toBeUndefined();
    expect(() => auth.assertPrivateCustody('/synthetic-private/company.json')).toThrow();
  });

  it('only server-verified request objects yield a frozen employee principal', async () => {
    const { auth } = fixture();
    const context = {};
    await auth.verify(context, request());
    const principal = (await auth.authenticate(context))!;
    expect(principal).toEqual({
      kind: 'employee',
      owner: 'owner-1',
      employeeId: 'employee-1',
      sessionId: SID,
      sessionGeneration: 7,
    });
    expect(Object.isFrozen(principal)).toBe(true);
    expect(await auth.authenticate({ ...context, principal })).toBeUndefined();
    expect(() => auth.assertCurrent({ ...principal }, context)).toThrow();
    expect(() => auth.assertCurrent(principal, {})).toThrow();
  });

  it.each([
    ['purpose', { 1: 'routine-request' }],
    ['issuer', { 2: 'other' }],
    ['epoch', { 3: 'old-epoch' }],
    ['session', { 4: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }],
    ['generation', { 5: 6 }],
    ['method', { 6: 'DELETE' }],
    ['path', { 7: '/api/goals/other' }],
    ['body digest', { 8: '0'.repeat(64) }],
    ['future', { 9: 100_001 }],
    ['expired', { 9: 90_000, 10: 100_000 }],
    ['overlong expiry', { 10: 110_001 }],
    ['inverted expiry', { 10: 99_999 }],
    ['nonce', { 11: 'short' }],
    ['unknown field', { 12: 'owner' }],
    ['newline identity', { 2: 'test-broker\n' }],
  ])('refuses signed but invalid %s', async (_name, overrides) => {
    const { auth, claims } = fixture();
    await denied(auth.verify({}, request(token(overrides))));
    expect(claims.size).toBe(0);
  });

  it('rejects tampering, duplicate headers and noncanonical encodings', async () => {
    for (const assertion of [
      token().slice(0, -1) + 'z',
      token() + 'x',
      token().replace('.', '=.'),
      [token(), token()],
      'forged',
    ]) {
      const { auth } = fixture();
      await denied(auth.verify({}, request(assertion as string)));
    }
  });

  it('binds exact bytes, including whitespace, not reparsed JSON', async () => {
    await denied(fixture().auth.verify({}, request(token(), { body: Buffer.from('{ "objective":"synthetic"}') })));
  });

  it('refuses replay concurrently and across authentication-instance replacement', async () => {
    const { auth, ports } = fixture();
    const outcomes = await Promise.allSettled([auth.verify({}, request()), auth.verify({}, request())]);
    expect(outcomes.map((item) => item.status).sort()).toEqual(['fulfilled', 'rejected']);
    await denied(new GoalBrokerAuthentication(ports).verify({}, request()));
  });

  it.each(['binding', 'issuer', 'key', 'expiry', 'custody', 'nonce'] as const)(
    'rechecks %s after nonce claim awaits',
    async (change) => {
      const f = fixture();
      f.afterClaim(() => {
        if (change === 'binding') f.setBinding();
        if (change === 'issuer') f.setIssuer();
        if (change === 'key') f.setIssuer({ epoch: 'test-epoch', key: Buffer.alloc(32, 8) });
        if (change === 'expiry') f.setNow(110_000);
        if (change === 'custody') f.setCustody(false);
        if (change === 'nonce') f.claims.clear();
      });
      await denied(f.auth.verify({}, request()));
    }
  );

  it.each(['binding', 'owner', 'generation', 'issuer', 'key', 'expiry', 'custody', 'nonce'] as const)(
    'commit-time port refuses changed %s',
    async (change) => {
      const f = fixture();
      const context = {};
      await f.auth.verify(context, request());
      const principal = (await f.auth.authenticate(context))!;
      if (change === 'binding') f.setBinding();
      if (change === 'owner') f.setBinding({ ...principal, owner: 'other' });
      if (change === 'generation') f.setBinding({ ...principal, sessionGeneration: 8 });
      if (change === 'issuer') f.setIssuer();
      if (change === 'key') f.setIssuer({ epoch: 'test-epoch', key: Buffer.alloc(32, 9) });
      if (change === 'expiry') f.setNow(110_000);
      if (change === 'custody') f.setCustody(false);
      if (change === 'nonce') f.claims.clear();
      expect(() => f.auth.assertCurrent(principal, context)).toThrow();
      await denied(f.auth.authenticate(context));
    }
  );

  it('does not infer custody from a path or authorize another file', () => {
    const f = fixture();
    expect(() => f.auth.assertPrivateCustody('/worker-writable/company.json')).toThrow();
    f.setCustody(false);
    expect(() => f.auth.assertPrivateCustody(f.ports.canonicalFile)).toThrow();
  });

  it('bounds body and only accepts exact closed Goal methods/paths', async () => {
    for (const target of [
      '/api/goals\n',
      '/api/goals/',
      '/api/goals?x=1',
      '/api/%67oals',
      '/api/goals/../settings',
      '/api/settings',
    ])
      expect(isBrokerGoalRequest('POST', target), target).toBe(false);
    expect(isBrokerGoalRequest('DELETE', '/api/goals')).toBe(false);
    await denied(fixture().auth.verify({}, request(token(), { body: Buffer.alloc(65537) })));
  });

  it('binds GET metadata query exactly and refuses a GET body', async () => {
    const target = '/api/goal-metadata/employee-1?grantId=gr-1';
    const assertion = token({ 6: 'GET', 7: target }, Buffer.alloc(0));
    await fixture().auth.verify({}, { method: 'GET', target, body: Buffer.alloc(0), assertion });
    await denied(fixture().auth.verify({}, { method: 'GET', target: target + 'x', body: Buffer.alloc(0), assertion }));
    await denied(fixture().auth.verify({}, { method: 'GET', target, body: BODY, assertion }));
  });

  it('synthetic proof transport → server inject authenticates fixed fixture identity, not supplied claims', async () => {
    const forwarded = componentProof({
      body: BODY.toString(),
      headers: {
        'X-Reverie-Goal-Assertion': 'forged',
        'X-Reverie-Goal-Principal': 'owner',
        'X-Reverie-Parent-Session': 'other',
        Cookie: 'forged',
      },
    });
    expect(forwarded.headers['X-Reverie-Parent-Session']).toBe(SID);
    expect(forwarded.headers['X-Reverie-Goal-Principal']).toBeUndefined();
    const f = fixture();
    const app = Fastify();
    registerGoalBrokerBoundary(app, f.auth);
    app.post('/api/goals', async (req) => {
      const principal = await f.auth.authenticate(req);
      if (!principal) throw Error('unverified');
      f.auth.assertCurrent(principal, req); // Same sync port the later Goal commit must call.
      return { employeeId: principal.employeeId, kind: principal.kind };
    });
    try {
      const response = await app.inject({
        method: forwarded.method,
        url: forwarded.target,
        payload: forwarded.body,
        headers: forwarded.headers,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({ employeeId: 'employee-1', kind: 'employee' });
      expect(
        (
          await app.inject({
            method: forwarded.method,
            url: forwarded.target,
            payload: forwarded.body,
            headers: forwarded.headers,
          })
        ).statusCode
      ).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('registered default boundary denies an explicit synthetic proof when host ports are absent', async () => {
    const forwarded = componentProof({ body: BODY.toString() });
    expect(forwarded.headers['X-Reverie-Goal-Assertion']).toEqual(expect.any(String));
    const app = Fastify();
    let handled = 0;
    registerGoalBrokerBoundary(app);
    app.post('/api/goals', async () => {
      handled++;
      return {};
    });
    try {
      const result = await app.inject({
        method: 'POST',
        url: '/api/goals',
        payload: forwarded.body,
        headers: forwarded.headers,
      });
      expect(result.statusCode).toBe(403);
      expect(handled).toBe(0);
      expect(result.body).not.toContain('synthetic');
    } finally {
      await app.close();
    }
  });

  it('synthetic component proof cannot be reused for another wire request at server boundary', async () => {
    const forwarded = componentProof({ body: BODY.toString() });
    const cases = [
      {
        method: 'POST',
        url: '/api/goals',
        payload: BODY.toString() + ' ',
        assertion: forwarded.headers['X-Reverie-Goal-Assertion'],
      },
      {
        method: 'POST',
        url: '/api/goals/g-2/transitions',
        payload: BODY.toString(),
        assertion: forwarded.headers['X-Reverie-Goal-Assertion'],
      },
      { method: 'POST', url: '/api/goals', payload: BODY.toString(), assertion: 'forged' },
      {
        method: 'DELETE',
        url: '/api/goals',
        payload: BODY.toString(),
        assertion: forwarded.headers['X-Reverie-Goal-Assertion'],
      },
    ];
    for (const input of cases) {
      const f = fixture();
      const app = Fastify();
      let handled = 0;
      registerGoalBrokerBoundary(app, f.auth);
      app.route({
        method: ['POST', 'DELETE'],
        url: input.url,
        handler: async () => {
          handled++;
          return {};
        },
      });
      try {
        const result = await app.inject({
          method: input.method as 'POST' | 'DELETE',
          url: input.url,
          payload: input.payload,
          headers: { 'content-type': 'application/json', [GOAL_ASSERTION_HEADER]: input.assertion },
        });
        expect(result.statusCode, JSON.stringify(input)).toBe(403);
        expect(handled).toBe(0);
        expect(f.claims.size).toBe(0);
      } finally {
        await app.close();
      }
    }
  });

  it('upstream host ports changing between authentication and commit prevent mocked commit', async () => {
    const forwarded = componentProof({ body: BODY.toString() });
    const f = fixture();
    const app = Fastify();
    let committed = false;
    registerGoalBrokerBoundary(app, f.auth);
    app.post('/api/goals', async (req, reply) => {
      const principal = (await f.auth.authenticate(req))!;
      await Promise.resolve();
      f.setBinding();
      try {
        f.auth.assertCurrent(principal, req);
      } catch {
        return reply.code(403).send({ success: false });
      }
      committed = true;
      return {};
    });
    try {
      const result = await app.inject({
        method: 'POST',
        url: '/api/goals',
        payload: forwarded.body,
        headers: forwarded.headers,
      });
      expect(result.statusCode).toBe(403);
      expect(committed).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('actual restricted Office refuses Goal forwarding even with a valid synthetic component proof', () => {
    const forwarded = componentProof({ body: BODY.toString() });
    expect(forwarded.headers['X-Reverie-Goal-Assertion']).toEqual(expect.any(String));
    for (const headers of [{}, forwarded.headers])
      expect(restrictedOffice({ body: BODY.toString(), headers })).toEqual({
        refused: 403,
        upstream: false,
        environmentReads: 0,
      });
  });

  it('ordinary Basic/parent headers never create a Goal principal', async () => {
    expect(
      await fixture().auth.authenticate({
        headers: {
          authorization: 'Basic synthetic',
          'x-reverie-parent-session': SID,
          'x-reverie-service-token': 'synthetic',
        },
        principal: { kind: 'owner' },
      })
    ).toBeUndefined();
    expect(restrictedOffice({ unavailable: true })).toEqual({ refused: 403, upstream: false, environmentReads: 0 });
  });
});
