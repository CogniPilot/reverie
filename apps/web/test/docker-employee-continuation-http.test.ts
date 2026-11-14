/** Actual HTTP authentication and canonical CompanyStore; engine ports are inert,
 * synthetic observations. No Docker socket, provider, or live data is used. */
import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CompanyService, type CompanyServiceDeps } from '../src/company-service.js';
import { CompanyStore } from '../src/company-store.js';
import { EmployeeSchema } from '../src/company-types.js';
import {
  DockerEmployeeContinuation,
  dockerContinuationDigest,
  type DockerContinuationEngine,
} from '../src/docker-employee-continuation.js';
import { CompanyDockerContinuationStore } from '../src/docker-employee-store.js';
import { registerDockerEmployeeContinuationRoutes } from '../src/web/routes/docker-employee-continuation-routes.js';
import {
  DockerWorkerIdentityAuthentication,
  dockerWorkerIdentityOf,
  registerDockerWorkerIdentity,
  DOCKER_WORKER_IDENTITY_HEADER,
} from '../src/docker-worker-identity.js';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { ownerVerifier } from '../src/owner-auth/marks.js';
import { registerOwnerPolicy } from '../src/owner-auth/policy.js';
import { registerAuthMiddleware } from '../src/web/middleware/auth.js';
import { ownerFor } from '../src/web/route-helpers.js';
import type { SessionPort } from '../src/web/ports/session-port.js';
import type { SessionState } from '../src/types.js';

const actor = '11111111-1111-4111-8111-111111111111';
const target = '22222222-2222-4222-8222-222222222222';
const actorSid = 'aaaaaaaa-1111-4111-8111-111111111111';
const sid = 'bbbbbbbb-2222-4222-8222-222222222222';
const cid = 'c'.repeat(64),
  image = 'sha256:' + 'd'.repeat(64),
  destinationImage = 'sha256:' + 'e'.repeat(64);
const policy = {
  memoryMaxBytes: 48 * 1024 ** 3,
  memoryHighBytes: 16 * 1024 ** 3,
  swapMaxBytes: 0,
  pidsMax: 512,
  cpuWeight: 100,
  allowedCpus: [0, 1],
  pool: { memoryMaxBytes: 48 * 1024 ** 3, swapMaxBytes: 0, pidsMax: 8192, cpuWeight: 100, allowedCpus: [0, 1] },
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(options: { recover?: boolean; office?: boolean; storedPolicy?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'boxed-http-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const ownerStore = new OwnerAuthStore(join(directory, 'owner.json'));
  const ownerAuth = new OwnerAuthService({
    store: ownerStore,
    auditFile: join(directory, 'audit.jsonl'),
    setupEnabled: true,
  });
  const ownerToken = await ownerAuth.setup(
    'boxed-owner',
    'Synthetic-only-Ocean42!',
    'Synthetic-only-Ocean42!',
    '127.0.0.1'
  );
  const companyStore = new CompanyStore(join(directory, 'company.json'));
  await companyStore.init();
  const live = { id: actorSid, name: 'Coordinator', owner: undefined };
  const sessions = new Map([[actorSid, live]]);
  const company = new CompanyService(companyStore, {
    getSession: (id: string) => sessions.get(id),
    chatrooms: { rooms: () => [] },
    research: {},
  } as unknown as CompanyServiceDeps);
  await companyStore.update((state) => {
    state.employees = [
      EmployeeSchema.parse({
        id: actor,
        sessionId: actorSid,
        sessionGeneration: 1,
        name: 'Coordinator',
        icon: 'X',
        position: 'CTO',
        expertise: ['synthetic testing'],
        createdAt: 1,
        onVacation: false,
        desiredRunning: true,
        permissions: { recoverEmployees: options.recover ?? true, manageOffice: options.office ?? false },
      }),
      EmployeeSchema.parse({
        id: target,
        sessionId: sid,
        sessionGeneration: 9,
        name: 'Worker',
        icon: 'W',
        position: 'Engineer',
        expertise: ['synthetic testing'],
        createdAt: 1,
        onVacation: true,
        desiredRunning: false,
        runtimeRecipe: { mode: 'claude', workingDir: '/synthetic-workspace' },
        ...(options.storedPolicy ? { dockerResourcePolicy: policy } : {}),
      }),
    ];
  });
  const saved = {
    id: sid,
    owner: undefined,
    mode: 'claude',
    workingDir: '/synthetic-workspace',
    runtimeThreads: {},
  } as SessionState;
  const store = new CompanyDockerContinuationStore(company, (id) => (id === sid ? saved : undefined));
  let effects = 0,
    observations = 0,
    beforeObservation: (() => Promise<void>) | undefined;
  const original = {
    containerId: cid,
    imageId: image,
    deployment: 'synthetic-native',
    employeeId: target,
    sessionId: sid,
    home: { type: 'bind', source: '/synthetic-private-home', destination: '/home/agent', readWrite: true },
    mountDigest: 'a'.repeat(64),
    storageDigest: 'b'.repeat(64),
    configurationDigest: 'f'.repeat(64),
  } as const;
  const engine = {
    async observeSource() {
      observations++;
      await beforeObservation?.();
      return { original, state: 'stopped' };
    },
    async image() {
      return { imageId: destinationImage, sourceImageId: image, clientManifestDigest: '4'.repeat(64) };
    },
    async validateCapabilities() {},
    async preparePool() {
      effects++;
      throw Error('synthetic private engine details must not reach HTTP');
    },
    async observePool() {
      return null;
    },
    async createDestination() {
      effects++;
    },
    async observeDestination() {
      return null;
    },
    async start() {
      effects++;
    },
    async configureResources() {
      effects++;
    },
    async provisionIdentity() {
      effects++;
    },
  } satisfies DockerContinuationEngine;
  const service = new DockerEmployeeContinuation(
    store,
    engine,
    {
      async launch() {
        effects++;
      },
    },
    { issue: () => 'synthetic-unused-credential' }
  );
  let identityCurrent = true;
  const binding = {
    employeeId: actor,
    sessionId: actorSid,
    sessionGeneration: 1,
    owner: undefined,
    containerId: '9'.repeat(64),
    credentialId: '33333333-3333-4333-8333-333333333333',
  };
  const identity = new DockerWorkerIdentityAuthentication(
    '44444444-4444-4444-8444-444444444444',
    Buffer.alloc(32, 0x51),
    { binding: () => (identityCurrent ? binding : undefined), keyCurrent: () => true }
  );
  const machineToken = identity.issue(binding, () => true);
  const app = Fastify();
  await app.register(cookie);
  registerDockerWorkerIdentity(app, identity);
  const authState = registerAuthMiddleware(app, false, '', ownerAuth);
  const ctx = { sessions } as unknown as SessionPort;
  registerOwnerPolicy(app, {
    service: ownerAuth,
    ctx,
    isCapabilityRequest: () => false,
    relations: {
      known: (id) => sessions.has(id),
      related: (a, b) => a === b,
      coordinated: () => false,
      upward: () => false,
      keeper: () => false,
      admin: () => false,
    },
  });
  registerDockerEmployeeContinuationRoutes(app, company, store, service, {
    verifiedOwner: ownerVerifier({ service: ownerAuth, ctx }),
    worker: dockerWorkerIdentityOf,
    owner: ownerFor,
  });
  await app.ready();
  cleanups.push(async () => {
    await app.close();
    for (const value of Object.values(authState)) value?.dispose();
  });
  const ownerHeaders = { cookie: 'reverie_owner=' + ownerToken, origin: 'http://localhost', host: 'localhost' };
  const workerHeaders = { [DOCKER_WORKER_IDENTITY_HEADER]: machineToken, 'x-reverie-parent-session': actorSid };
  const url = '/api/company/employees/' + target;
  const approval = () => ({
    sessionId: sid,
    sessionGeneration: 9,
    expectedSourceDigest: store.subject(target)!.sourceDigest,
    policy,
  });
  const request = {
    operationId: '55555555-5555-4555-8555-555555555555',
    sessionId: sid,
    sessionGeneration: 9,
    containerId: cid,
    imageId: image,
    expectedPolicyDigest: dockerContinuationDigest(policy),
    expectedDestinationImageId: destinationImage,
    enterOffice: true,
  };
  return {
    app,
    companyStore,
    company,
    store,
    url,
    ownerHeaders,
    workerHeaders,
    approval,
    request,
    effects: () => effects,
    observations: () => observations,
    revokeIdentity: () => {
      identityCurrent = false;
    },
    beforeObservation: (fn: () => Promise<void>) => {
      beforeObservation = fn;
    },
  };
}

describe('boxed recovery HTTP and canonical employee permissions', () => {
  it('a coordinator title without a recovery grant cannot inspect or start a worker', async () => {
    const f = await fixture({ recover: false, office: true, storedPolicy: true });
    const before = f.companyStore.snapshot();
    const inspection = await f.app.inject({ url: f.url + '/docker-policy', headers: f.workerHeaders });
    const start = await f.app.inject({
      method: 'POST',
      url: f.url + '/docker-continuation',
      headers: f.workerHeaders,
      payload: { request: f.request },
    });
    expect(inspection.statusCode).toBe(403);
    expect(start.statusCode).toBe(403);
    expect(f.observations()).toBe(0);
    expect(f.effects()).toBe(0);
    expect(f.companyStore.snapshot()).toEqual(before);
  });
  it('owner approves desired policy without claiming enforcement or changing office intent', async () => {
    const f = await fixture();
    const response = await f.app.inject({
      method: 'PUT',
      url: f.url + '/docker-policy',
      headers: f.ownerHeaders,
      payload: f.approval(),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toMatchObject({ state: 'desired-policy-saved', enforcement: 'unverified' });
    expect(f.companyStore.snapshot().employees.find((e) => e.id === target)).toMatchObject({
      onVacation: true,
      desiredRunning: false,
      dockerResourcePolicy: policy,
    });
    expect(f.effects()).toBe(0);
  });
  it('scoped worker can inspect without receiving an owner-only approval action or private home', async () => {
    const f = await fixture();
    const response = await f.app.inject({ url: f.url + '/docker-policy', headers: f.workerHeaders });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.allowedActions).not.toContain('approve-policy');
    expect(response.body).not.toContain('synthetic-private-home');
    expect(response.body).not.toContain('synthetic-unused-credential');
  });
  it('recovery permission never authorizes resource approval', async () => {
    const f = await fixture({ office: true });
    const before = f.companyStore.snapshot();
    for (const [method, suffix, payload] of [
      ['PUT', '/docker-policy', f.approval()],
      ['POST', '/docker-continuation', { request: f.request, policyApproval: f.approval() }],
    ] as const) {
      const response = await f.app.inject({ method, url: f.url + suffix, headers: f.workerHeaders, payload });
      expect(response.statusCode, response.body).toBe(403);
    }
    expect(f.companyStore.snapshot()).toEqual(before);
    expect(f.effects()).toBe(0);
  });
  it('requires the independent manageOffice grant before changing an OFF employee', async () => {
    const f = await fixture({ storedPolicy: true });
    const before = f.companyStore.snapshot();
    const response = await f.app.inject({
      method: 'POST',
      url: f.url + '/docker-continuation',
      headers: f.workerHeaders,
      payload: { request: f.request },
    });
    expect(response.statusCode, response.body).toBe(403);
    expect(f.companyStore.snapshot()).toEqual(before);
    expect(f.effects()).toBe(0);
  });
  it('a permitted worker reaches the same durable service and sanitized recovery outcome', async () => {
    const f = await fixture({ storedPolicy: true, office: true });
    const response = await f.app.inject({
      method: 'POST',
      url: f.url + '/docker-continuation',
      headers: f.workerHeaders,
      payload: { request: f.request },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data, response.body).toMatchObject({ phase: 'pool-issued', allowedActions: ['observe'] });
    expect(response.body).not.toContain('private engine details');
    expect(f.effects()).toBe(1);
    expect(f.companyStore.snapshot().employees.find((e) => e.id === target)).toMatchObject({
      onVacation: false,
      desiredRunning: true,
    });
    const observed = await f.app.inject({
      method: 'POST',
      url: f.url + '/docker-continuation/observe',
      headers: f.workerHeaders,
      payload: { operationId: f.request.operationId },
    });
    expect(observed.statusCode, observed.body).toBe(200);
    expect(f.effects()).toBe(1);
  });
  it.each(['generation', 'permission', 'identity'] as const)(
    'rejects %s changes during an awaited source read',
    async (change) => {
      const f = await fixture({ storedPolicy: true });
      f.beforeObservation(async () => {
        if (change === 'identity') f.revokeIdentity();
        else
          await f.companyStore.update((state) => {
            const employee = state.employees.find((e) => e.id === (change === 'permission' ? actor : target))!;
            if (change === 'permission') employee.permissions.recoverEmployees = false;
            else employee.sessionGeneration++;
          });
      });
      const response = await f.app.inject({ url: f.url + '/docker-policy', headers: f.workerHeaders });
      expect([403, 409]).toContain(response.statusCode);
      expect(f.observations()).toBe(1);
      expect(f.effects()).toBe(0);
      expect(f.companyStore.snapshot().dockerEmployeeContinuations ?? []).toHaveLength(0);
    }
  );
  it('rejects stale owner approval and resource overflow before canonical writes', async () => {
    const f = await fixture();
    const before = f.companyStore.snapshot();
    for (const approval of [
      { ...f.approval(), sessionGeneration: 8 },
      { ...f.approval(), policy: { ...policy, memoryHighBytes: policy.memoryMaxBytes + 1 } },
    ]) {
      const response = await f.app.inject({
        method: 'PUT',
        url: f.url + '/docker-policy',
        headers: f.ownerHeaders,
        payload: approval,
      });
      expect([400, 409]).toContain(response.statusCode);
    }
    expect(f.companyStore.snapshot()).toEqual(before);
    expect(f.effects()).toBe(0);
  });
  it('anonymous, parent-only and mixed machine/owner credentials have no authority', async () => {
    const f = await fixture({ storedPolicy: true, office: true });
    const before = f.companyStore.snapshot();
    for (const headers of [{}, { 'x-reverie-parent-session': actorSid }, { ...f.workerHeaders, ...f.ownerHeaders }]) {
      const response = await f.app.inject({
        method: 'POST',
        url: f.url + '/docker-continuation',
        headers,
        payload: { request: f.request },
      });
      expect([401, 403]).toContain(response.statusCode);
    }
    expect(f.companyStore.snapshot()).toEqual(before);
    expect(f.effects()).toBe(0);
  });
});
