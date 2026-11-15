import fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CompanyService,type CompanyServiceDeps} from '../src/company-service.js';
import {CompanyStore} from '../src/company-store.js';
import {EmployeeSchema} from '../src/company-types.js';
import {PlanRequestCapabilities} from '../src/plan-request-capability.js';
import {captureDockerPlanRequestDecision,requireDockerPlanRequestDecision,requireDockerPlanDecisionScope} from '../src/docker-plan-request-decision.js';
import {DockerWorkerIdentityAuthentication,registerDockerWorkerIdentity,DOCKER_WORKER_IDENTITY_HEADER} from '../src/docker-worker-identity.js';
import type {PlanMoveExecutor,PlanMoveRecord} from '../src/plan-move.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { registerPlanRequestRoutes } from '../src/web/routes/plan-request-routes.js';
import { PlanMoveRequests } from '../src/plan-request.js';
import { PlanMoveError } from '../src/plan-move.js';
import { classify } from '../src/owner-auth/policy.js';

describe('plan request route authority', () => {
  let app: FastifyInstance;
  let sessions: Map<string, {id: string; owner: string | undefined}>;
  const requests = {
    create: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    cancel: vi.fn(),
    reauthorize: vi.fn(),
    decide: vi.fn(),
    credential: vi.fn(),
  };
  const headers = { host: 'console.test', origin: 'https://console.test', cookie: 'reverie_session=owner' };
  const input = { id: 'request', employeeId: 'alex', sessionId: 'source', toAccount: 'second' };
  const execution = { authorized: () => true, executor: {} as never };
  beforeEach(async () => {
    vi.resetAllMocks();
    app = Fastify();
    await app.register(cookie);
    sessions = new Map([['source', {id: 'source', owner: 'owner-a'}]]);
    registerPlanRequestRoutes(
      app,
      requests as unknown as PlanMoveRequests,
      {
        authSessions: new Map([['owner', { ip: '127.0.0.1', ua: 'fixture', createdAt: 1, method: 'basic' }]]) as never,
        sessions: sessions as never,
      },
      undefined,
      () => execution
    );
  });
  afterEach(async () => {
    await app.close();
  });
  it('does not register the retired credential export even for the current source', async () => {
    sessions.set('source', { id: 'source', owner: undefined });
    const value = { requestId: 'request', sessionId: 'source', nonce: 'a'.repeat(64) };
    requests.credential.mockResolvedValue(value); // a legacy tripwire; production has no export method
    const url = '/api/plans/requests/request/credential';
    for (const extra of [{}, { 'x-reverie-parent-session': 'another' }, { 'x-reverie-parent-session': 'source' }]) {
      const result = await app.inject({ method: 'POST', url, headers: extra });
      expect(result.statusCode).toBe(404);
      expect(result.body).not.toContain(value.nonce);
    }
    expect(requests.credential).not.toHaveBeenCalled();
  });
  it('creates only from signed-in same-origin owner and accepts no handoff, nonce or force controls', async () => {
    requests.create.mockResolvedValue({ ...input, phase: 'pending' });
    const response = await app.inject({ method: 'POST', url: '/api/plans/requests', headers, payload: input });
    expect(response.statusCode).toBe(202);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(requests.create).toHaveBeenCalledWith(input, undefined, execution);
    for (const extra of [{ cookie: '' }, { origin: 'https://other.test' }, { 'x-reverie-parent-session': 'source' }]) {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/plans/requests',
            headers: { ...headers, ...extra },
            payload: input,
          })
        ).statusCode
      ).toBe(403);
    }
    const before = requests.create.mock.calls.length;
    for (const extra of [{ forceBusy: true }, { handoff: 'owner-written' }, { nonce: 'a'.repeat(64) }])
      expect(
        (await app.inject({ method: 'POST', url: '/api/plans/requests', headers, payload: { ...input, ...extra } }))
          .statusCode
      ).not.toBe(202);
    expect(requests.create).toHaveBeenCalledTimes(before);
  });
  it('agent headers alone never approve and exact session plus one-time body credential is passed to the scoped service', async () => {
    requests.decide.mockResolvedValue({ id: 'request', phase: 'executing' });
    const url = '/api/plans/requests/request/approve';
    expect(
      (await app.inject({ method: 'POST', url, payload: { nonce: 'a'.repeat(64), handoff: 'Handoff' } })).statusCode
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: { 'x-reverie-parent-session': 'source' },
          payload: { handoff: 'Handoff' },
        })
      ).statusCode
    ).not.toBe(202);
    expect(requests.decide).not.toHaveBeenCalled();
    const response = await app.inject({
      method: 'POST',
      url,
      headers: { 'x-reverie-parent-session': 'source' },
      payload: { nonce: 'a'.repeat(64), handoff: 'Handoff' },
    });
    expect(response.statusCode).toBe(202);
    expect(requests.decide).toHaveBeenCalledWith('request', 'source', 'a'.repeat(64), 'approve', 'Handoff', 'owner-a');
    requests.decide.mockRejectedValue(new PlanMoveError('Invalid approval', 403));
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: { 'x-reverie-parent-session': 'source' },
          payload: { nonce: 'b'.repeat(64), handoff: 'Handoff' },
        })
      ).statusCode
    ).toBe(403);
  });
  it('keeps owner status/cancel/reauthorize private and whitelists only the two exact agent decisions', async () => {
    for (const suffix of ['status', 'cancel', 'reauthorize']) {
      const url = `/api/plans/requests/request/${suffix}`;
      expect(
        (await app.inject({ method: 'POST', url, headers: { 'x-reverie-parent-session': 'source' } })).statusCode
      ).toBe(403);
    }
    // Route classification grants only decision transport; nonce + binding checks still authorize it.
    expect(classify('POST', '/api/plans/requests/:id/approve', '/api/plans/requests/request/approve')).toBe('agent');
    expect(classify('POST', '/api/plans/requests/:id/reject', '/api/plans/requests/request/reject')).toBe('agent');
    expect(classify('POST', '/api/plans/requests/:id/reauthorize', '/api/plans/requests/request/reauthorize')).toBe(
      'owner'
    );
    expect(classify('POST', undefined, '/api/plans/requests/request/approve/extra')).toBe('owner');
  });
});

describe('pending plan requests require an actual self agent in every policy mode', () => {
  it('refuses services, spoofed headers and owners while scoping the agent to itself', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { OwnerAuthStore } = await import('../src/owner-auth/store.js');
    const { OwnerAuthService } = await import('../src/owner-auth/service.js');
    const { registerOwnerPolicy, callerOf, SERVICE_HEADER, OWNER_COOKIE } = await import('../src/owner-auth/policy.js');
    const admin = await import('../src/owner-auth/admin.js');
    const root = await mkdtemp(join(tmpdir(), 'plan-pending-principal-'));
    const store = new OwnerAuthStore(join(root, 'owner.json'));
    const boot = await admin.bootstrap(store, 'synthetic-owner', { enforce: true });
    const token = await admin.issueServiceToken(store, 'synthetic-service');
    const auth = new OwnerAuthService({ store, auditFile: join(root, 'audit.jsonl') });
    const restricted = (await auth.login('synthetic-owner', boot.oneTimePassword, '127.0.0.1')).session!;
    const owner = await auth.changePassword(restricted, { current: boot.oneTimePassword, next: 'correct-horse-plan-42-battery' }, '127.0.0.1');
    const ctx = { sessions: new Map([['source', { id: 'source', owner: undefined }]]), authSessions: new Map() };
    const list = vi.fn(async () => [{ id: 'request', phase: 'pending' }]);
    const server = Fastify(); await server.register(cookie);
    registerOwnerPolicy(server, { service: auth, ctx: ctx as never, isCapabilityRequest: () => false,
      relations: { known: () => false, related: () => false, upward: () => false, keeper: () => false, admin: () => false } as never });
    registerPlanRequestRoutes(server, { pendingForSession: list } as never, ctx as never, auth,
      () => ({ authorized: () => false, executor: {} as never }), undefined, request => {
        const caller = callerOf(request, { service: auth, ctx: ctx as never });
        return caller.kind === 'agent' && caller.session && request.headers['x-reverie-parent-session'] === caller.session ? { sessionId: caller.session } : undefined;
      });
    try {
      for (const mode of ['enforce', 'log', 'off'] as const) {
        await admin.setPolicy(store, mode, { forceLockoutRisk: true });
        for (const headers of [{}, { [SERVICE_HEADER]: token }, { [SERVICE_HEADER]: token, 'x-reverie-parent-session': 'source' }, { 'x-reverie-parent-session': 'missing' }, { cookie: `${OWNER_COOKIE}=${owner}` }, { cookie: `${OWNER_COOKIE}=${owner}`, 'x-reverie-parent-session': 'source' }]) {
          const before = list.mock.calls.length;
          const result = await server.inject({ method: 'POST', url: '/api/plans/agent-requests/pending', headers: { host: 'console.test', origin: 'https://console.test', ...headers }, payload: {} });
          expect([401, 403]).toContain(result.statusCode); expect(list).toHaveBeenCalledTimes(before);
        }
        const own = await server.inject({ method: 'POST', url: '/api/plans/agent-requests/pending', headers: { 'x-reverie-parent-session': 'source' }, payload: {} });
        expect(own.statusCode).toBe(200); expect(own.headers['cache-control']).toBe('no-store');
        expect(list).toHaveBeenLastCalledWith('source', undefined);
        const before = list.mock.calls.length;
        expect((await server.inject({ method: 'POST', url: '/api/plans/agent-requests/pending', headers: { 'x-reverie-parent-session': 'source' }, payload: { sessionId: 'other' } })).statusCode).toBe(400);
        expect(list).toHaveBeenCalledTimes(before);
      }
    } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
  });
});

const boxedDecisionCleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of boxedDecisionCleanups.splice(0).reverse()) await close();
});
async function boxedDecisionFixture(protectedActor = true) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'boxed-plan-decision-'));
  boxedDecisionCleanups.push(async () => fs.rmSync(directory, { recursive: true, force: true }));
  const employeeId = '10000000-0000-4000-8000-000000000001',
    sessionId = '20000000-0000-4000-8000-000000000002';
  const canonical = new CompanyStore(join(directory, 'company.json'));
  await canonical.init();
  const sessions = new Map([[sessionId, { id: sessionId, owner: undefined }]]);
  const company = new CompanyService(canonical, {
    getSession: (id: string) => sessions.get(id),
    chatrooms: { rooms: () => [] },
    research: {},
  } as unknown as CompanyServiceDeps);
  await canonical.update((state) => {
    state.employees = [
      EmployeeSchema.parse({
        id: employeeId,
        sessionId,
        sessionGeneration: 7,
        name: 'Synthetic expert',
        icon: 'X',
        position: 'Engineer',
        expertise: ['testing'],
        createdAt: 1,
        desiredRunning: true,
        onVacation: false,
        permissions: { moveOwnPlan: true },
        dockerBinding: {
          version: 1,
          operationId: '30000000-0000-4000-8000-000000000003',
          credentialId: '40000000-0000-4000-8000-000000000004',
          sessionId,
          sessionGeneration: 7,
          containerId: 'a'.repeat(64),
          imageId: 'sha256:' + 'b'.repeat(64),
          originalDigest: 'c'.repeat(64),
          policyDigest: 'd'.repeat(64),
        },
      }),
    ];
  });
  let active = true;
  const binding = () => {
    const employee = canonical.snapshot().employees[0]!,
      b = employee.dockerBinding!;
    return {
      employeeId: employee.id,
      owner: employee.owner,
      sessionId: employee.sessionId,
      sessionGeneration: employee.sessionGeneration,
      containerId: b.containerId,
      credentialId: b.credentialId,
    };
  };
  const authentication = new DockerWorkerIdentityAuthentication(
    '50000000-0000-4000-8000-000000000005',
    Buffer.alloc(32, 0x51),
    { binding: () => binding(), keyCurrent: () => active }
  );
  boxedDecisionCleanups.push(async () => authentication.close());
  const token = authentication.issue(binding(), () => active);
  const capabilities = new PlanRequestCapabilities(join(directory, 'capabilities'));
  let saved: import('../src/plan-request.js').PlanRequestRecord[] = [];
  const snapshot = vi.fn(async () => ({
    sessionId,
    name: 'Synthetic expert',
    account: 'first',
    working: false,
    mode: 'claude',
  }));
  const begin = vi.fn(
    async (input: import('../src/plan-move.js').PlanMoveInput) =>
      ({
        id: input.id,
        employeeId,
        oldSession: sessionId,
        fromAccount: 'first',
        toAccount: 'second',
        phase: 'waiting',
        name: 'Synthetic expert',
        at: 1,
      }) as PlanMoveRecord
  );
  let afterSave: (() => Promise<void>) | undefined, afterAudit: (() => Promise<void>) | undefined;
  const nativeExecutor = {
    snapshot,
    withDecisionAuthority: (proof: unknown) => {
      expect(requireDockerPlanDecisionScope(proof)).toMatchObject({ employeeId, sessionId, requestId: 'request' });
      return { snapshot } as unknown as PlanMoveExecutor;
    },
  } as unknown as PlanMoveExecutor;
  const executor = protectedActor ? nativeExecutor : ({ snapshot } as unknown as PlanMoveExecutor);
  const requests = new PlanMoveRequests({
    load: async () => saved,
    save: async (rows) => {
      saved = structuredClone(rows);
      await afterSave?.();
    },
    binding: () => canonical.snapshot().employees.find((e) => e.id === employeeId)?.sessionId,
    moves: { begin, get: async () => undefined, cancel: async () => {} },
    validateTarget: async () => ({ mode: 'claude' }),
    capability: { write: (v) => capabilities.write(v), remove: (sid, id) => capabilities.remove(sid, id) },
    notify: async () => {},
    audit: async () => {
      await afterAudit?.();
    },
  });
  await requests.create({ id: 'request', employeeId, sessionId, toAccount: 'second' }, undefined, {
    authorized: () => active,
    executor,
  });
  const nonce = (await capabilities.read(sessionId, 'request')).nonce;
  const app = Fastify();
  await app.register(cookie);
  registerDockerWorkerIdentity(app, authentication, '', { requireMachineProof: true });
  const ctx = { sessions, authSessions: null } as never;
  registerPlanRequestRoutes(
    app,
    requests,
    ctx,
    undefined,
    () => {
      throw new PlanMoveError('Owner transport unavailable', 403);
    },
    undefined,
    undefined,
    (request, id) =>
      captureDockerPlanRequestDecision(request, id, company, requests, capabilities, () => {
        if (!active) throw new PlanMoveError('Runtime changed', 403);
      })
  );
  await app.ready();
  boxedDecisionCleanups.push(async () => app.close());
  const headers = { [DOCKER_WORKER_IDENTITY_HEADER]: token, 'x-reverie-parent-session': sessionId };
  return {
    app,
    canonical,
    company,
    capabilities,
    requests,
    employeeId,
    sessionId,
    headers,
    nonce,
    begin,
    snapshot,
    revoke: () => {
      active = false;
    },
    saved: () => saved,
    afterSave: (callback: () => Promise<void>) => {
      afterSave = callback;
    },
    afterAudit: (callback: () => Promise<void>) => {
      afterAudit = callback;
    },
  };
}
describe('boxed approval uses genuine HMAC and the same control-private capability', () => {
  it('approves without exporting/sending the private nonce, and legacy request semantics stay separate', async () => {
    const f = await boxedDecisionFixture();
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/plans/requests/request/approve',
      headers: f.headers,
      payload: { handoff: 'Synthetic bounded work handoff.' },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json().data.phase).toBe('executing');
    expect(response.body).not.toContain(f.nonce);
    expect(response.body).not.toContain('nonceHash');
    expect(f.begin).toHaveBeenCalledTimes(1);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/plans/requests/request/approve',
          headers: f.headers,
          payload: { handoff: 'Again.' },
        })
      ).statusCode
    ).toBe(403);
    expect(f.begin).toHaveBeenCalledTimes(1);
  });
  it.each(['parent-only', 'mixed-owner', 'mixed-legacy', 'stale-generation'] as const)(
    'refuses %s before private credential lookup or move effects',
    async (kind) => {
      const f = await boxedDecisionFixture(),
        read = vi.spyOn(f.capabilities, 'read');
      const headers: Record<string, string> = { ...f.headers };
      if (kind === 'parent-only') delete headers[DOCKER_WORKER_IDENTITY_HEADER];
      if (kind === 'mixed-owner') headers.cookie = 'reverie_owner=not-authority';
      if (kind === 'mixed-legacy') headers['x-reverie-recovery-assertion'] = 'not-authority';
      if (kind === 'stale-generation')
        await f.canonical.update((state) => {
          state.employees[0]!.sessionGeneration++;
        });
      const response = await f.app.inject({
        method: 'POST',
        url: '/api/plans/requests/request/approve',
        headers,
        payload: { handoff: 'Synthetic.' },
      });
      expect(response.statusCode).toBe(403);
      expect(read).not.toHaveBeenCalled();
      expect(f.begin).not.toHaveBeenCalled();
    }
  );
  it.each(['permission', 'attendance', 'runtime'] as const)(
    'revoked %s while reading capability cannot publish approval',
    async (change) => {
      const f = await boxedDecisionFixture(),
        read = f.capabilities.read.bind(f.capabilities);
      vi.spyOn(f.capabilities, 'read').mockImplementation(async (...args) => {
        const value = await read(...args);
        if (change === 'runtime') f.revoke();
        else
          await f.canonical.update((state) => {
            if (change === 'permission') state.employees[0]!.permissions.moveOwnPlan = false;
            else state.employees[0]!.onVacation = true;
          });
        return value;
      });
      const response = await f.app.inject({
        method: 'POST',
        url: '/api/plans/requests/request/approve',
        headers: f.headers,
        payload: { handoff: 'Synthetic.' },
      });
      expect(response.statusCode).toBe(403);
      expect(response.body).not.toContain(f.nonce);
      expect(f.begin).not.toHaveBeenCalled();
      expect(f.saved()[0]!.phase).toBe('pending');
    }
  );
  it('revocation at the approval snapshot await preserves the unconsumed request', async () => {
    const f = await boxedDecisionFixture();
    f.snapshot.mockImplementation(async () => {
      await f.canonical.update((state) => {
        state.employees[0]!.permissions.moveOwnPlan = false;
      });
      return { sessionId: f.sessionId, name: 'Synthetic expert', account: 'first', working: false, mode: 'claude' };
    });
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/plans/requests/request/approve',
      headers: f.headers,
      payload: { handoff: 'Synthetic.' },
    });
    expect(response.statusCode).toBe(403);
    expect(f.begin).not.toHaveBeenCalled();
    expect(f.saved()[0]!.phase).toBe('pending');
    expect((await f.capabilities.read(f.sessionId, 'request')).nonce).toBe(f.nonce);
  });
  it('an expected self rebind after committed approval does not invalidate its response or infer new authority', async () => {
    const f = await boxedDecisionFixture();
    f.begin.mockImplementation(async (input) => {
      await f.canonical.update((state) => {
        const e = state.employees[0]!;
        e.sessionId = '60000000-0000-4000-8000-000000000006';
        e.sessionGeneration++;
      });
      return {
        id: input.id,
        employeeId: f.employeeId,
        oldSession: f.sessionId,
        newSession: '60000000-0000-4000-8000-000000000006',
        fromAccount: 'first',
        toAccount: 'second',
        phase: 'waiting',
        name: 'Synthetic expert',
        at: 1,
      };
    });
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/plans/requests/request/approve',
      headers: f.headers,
      payload: { handoff: 'Synthetic.' },
    });
    expect(response.statusCode).toBe(202);
    expect(f.begin).toHaveBeenCalledTimes(1);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/plans/requests/request/approve',
          headers: f.headers,
          payload: { handoff: 'Again.' },
        })
      ).statusCode
    ).toBe(403);
  });
  it('file errors and serialized proof objects cannot expose or substitute private approval authority', async () => {
    const f = await boxedDecisionFixture();
    vi.spyOn(f.capabilities, 'read').mockRejectedValue(Error('PRIVATE ' + f.nonce));
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/plans/requests/request/approve',
      headers: f.headers,
      payload: { handoff: 'Synthetic.' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain(f.nonce);
    expect(() => requireDockerPlanRequestDecision({ require: () => f.nonce }, 'request', f.sessionId)).toThrow(
      'Current boxed'
    );
    expect(f.begin).not.toHaveBeenCalled();
  });
});

describe('boxed decision admission fences continue through publication/audit', () => {
  it.each(['remove', 'save', 'audit'] as const)(
    'revocation after %s is403 before move begin, preserving the consumed request history',
    async (point) => {
      const f = await boxedDecisionFixture();
      let changed = false;
      const revoke = async () => {
        if (changed) return;
        changed = true;
        await f.canonical.update((state) => {
          state.employees[0]!.permissions.moveOwnPlan = false;
        });
      };
      if (point === 'remove') {
        const remove = f.capabilities.remove.bind(f.capabilities);
        vi.spyOn(f.capabilities, 'remove').mockImplementation(async (...args) => {
          await remove(...args);
          await revoke();
        });
      }
      if (point === 'save') f.afterSave(revoke);
      if (point === 'audit') f.afterAudit(revoke);
      const response = await f.app.inject({
        method: 'POST',
        url: '/api/plans/requests/request/approve',
        headers: f.headers,
        payload: { handoff: 'Synthetic.' },
      });
      expect(response.statusCode).toBe(403);
      expect(f.begin).not.toHaveBeenCalled();
      expect(f.saved()[0]!.phase).toBe('failed');
      expect(response.body).not.toContain(f.nonce);
    }
  );
});

describe('boxed approval cannot enable an unfinished native actor', () => {
  it('refuses before consuming cooperation when the fixed Docker executor has no decision authority seam', async () => {
    const f = await boxedDecisionFixture(false);
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/plans/requests/request/approve',
      headers: f.headers,
      payload: { handoff: 'Synthetic.' },
    });
    expect(response.statusCode).toBe(503);
    expect(f.begin).not.toHaveBeenCalled();
    expect(f.saved()[0]!.phase).toBe('pending');
    expect((await f.capabilities.read(f.sessionId, 'request')).nonce).toBe(f.nonce);
  });
});
