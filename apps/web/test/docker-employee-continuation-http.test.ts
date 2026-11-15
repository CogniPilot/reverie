/** Actual HTTP authentication and canonical CompanyStore; engine ports are inert,
 * synthetic observations. No Docker socket, provider, or live data is used. */
import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import {
  DockerResourceRevisionStore,
  dockerRevisedPolicy,
  dockerResourceAttemptKey,
} from '../src/docker-resource-revisions.js';
import { DockerEmployeeEngine } from '../src/docker-employee-engine.js';
import { DockerContainedResources } from '../src/docker-contained-resource-controller.js';
import { DockerResourceRevisionService } from '../src/docker-resource-revision-service.js';
import { registerDockerResourceRevisionRoutes } from '../src/web/routes/docker-resource-revision-routes.js';
import cookie from '@fastify/cookie';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CompanyService, type CompanyServiceDeps } from '../src/company-service.js';
import { CompanyStore } from '../src/company-store.js';
import { guardDockerRuntimeOrigin } from '../src/docker-employee-runtime.js';
import { EmployeeSchema } from '../src/company-types.js';
import {
  DockerEmployeeContinuation,
  DockerEmployeeContinuationError,
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
  const revisions = new DockerResourceRevisionStore(join(directory, 'resource-revisions'));
  cleanups.push(async () => revisions.close());
  const store = new CompanyDockerContinuationStore(
    company,
    (id) => (id === sid ? saved : undefined),
    (owner, original) => {
      const desired = revisions.desired(owner);
      return desired ? dockerRevisedPolicy(original, desired) : original;
    }
  );
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
  let runtimeCurrent = true;
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
  registerDockerEmployeeContinuationRoutes(
    app,
    company,
    store,
    service,
    guardDockerRuntimeOrigin(
      {
        verifiedOwner: ownerVerifier({ service: ownerAuth, ctx }),
        worker: dockerWorkerIdentityOf,
        owner: ownerFor,
      },
      () => {
        if (!runtimeCurrent) throw new DockerEmployeeContinuationError('DOCKER_CONTINUATION_RUNTIME_CHANGED');
      }
    )
  );
  let resourceReads = 0,
    beforeResourceRead: (() => Promise<void>) | undefined;
  const resourceCommand = {
    async create() {
      effects++;
      throw Error('No physical effects admitted by HTTP fixture');
    },
    async run() {
      resourceReads++;
      await beforeResourceRead?.();
      return '';
    },
  };
  const resources = new DockerContainedResources(
    resourceCommand,
    store,
    {
      boxId: '7'.repeat(64),
      deployment: 'synthetic-native',
      helperImageId: 'sha256:' + '8'.repeat(64),
      selectedWorkerContainerIds: () => [],
    },
    revisions
  );
  const resourceEngine = new DockerEmployeeEngine(
    resourceCommand,
    'synthetic-native',
    resources,
    { imageId: destinationImage, clientManifestDigest: '4'.repeat(64), sourceImageIds: [image] },
    store,
    'sha256:' + '8'.repeat(64),
    '7'.repeat(64)
  );
  const resourceRevisionService = new DockerResourceRevisionService(
    company,
    store,
    revisions,
    resources,
    resourceEngine
  );
  registerDockerResourceRevisionRoutes(
    app,
    resourceRevisionService,
    guardDockerRuntimeOrigin(
      {
        verifiedOwner: ownerVerifier({ service: ownerAuth, ctx }),
        worker: dockerWorkerIdentityOf,
        owner: ownerFor,
      },
      () => {
        if (!runtimeCurrent) throw new DockerEmployeeContinuationError('DOCKER_CONTINUATION_RUNTIME_CHANGED');
      }
    )
  );
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
    revisions,
    resourceRevisionService,
    resourceEngine,
    resources,
    resourceReads: () => resourceReads,
    beforeResourceRead: (fn: () => Promise<void>) => {
      beforeResourceRead = fn;
    },
    bindResourceRow: async () => {
      const destination = { ...original, containerId: '6'.repeat(64), imageId: destinationImage };
      const operationId = '55555555-5555-4555-8555-555555555555',
        credentialId = '66666666-6666-4666-8666-666666666666';
      await companyStore.update((state) => {
        const employee = state.employees.find((value) => value.id === target)!;
        employee.dockerBinding = {
          version: 1,
          operationId,
          credentialId,
          sessionId: sid,
          sessionGeneration: 9,
          containerId: destination.containerId,
          imageId: destinationImage,
          originalDigest: dockerContinuationDigest(destination),
          policyDigest: dockerContinuationDigest(policy),
        };
        state.dockerEmployeeContinuations = [
          {
            version: 1,
            purpose: 'docker-employee-continuation-v1',
            employeeId: target,
            request: { ...request, operationId },
            sourceDigest: store.subject(target)!.sourceDigest,
            original,
            destination,
            workerImage: { imageId: destinationImage, sourceImageId: image, clientManifestDigest: '4'.repeat(64) },
            policy,
            credentialId,
            phase: 'ready',
          },
        ];
      });
    },
    logout: () => ownerAuth.logout(ownerToken),
    saved,
    company,
    store,
    url,
    ownerHeaders,
    workerHeaders,
    headersFor: (caller: 'owner' | 'worker' | 'headless-worker') =>
      caller === 'owner'
        ? ownerHeaders
        : caller === 'worker'
          ? workerHeaders
          : { [DOCKER_WORKER_IDENTITY_HEADER]: machineToken },
    approval,
    request,
    effects: () => effects,
    observations: () => observations,
    revokeRuntime: () => {
      runtimeCurrent = false;
    },
    revokeIdentity: () => {
      identityCurrent = false;
    },
    beforeObservation: (fn: () => Promise<void>) => {
      beforeObservation = fn;
    },
  };
}

describe('boxed recovery HTTP and canonical employee permissions', () => {
  it.each(['owner', 'worker'] as const)(
    'revoked runtime origin refuses genuine %s before any observation or effect',
    async (caller) => {
      const f = await fixture({ office: true, storedPolicy: true }),
        before = f.companyStore.snapshot();
      f.revokeRuntime();
      const response = await f.app.inject({
        method: 'POST',
        url: f.url + '/docker-continuation',
        headers: caller === 'owner' ? f.ownerHeaders : f.workerHeaders,
        payload: { request: f.request },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('DOCKER_CONTINUATION_RUNTIME_CHANGED');
      expect(f.observations()).toBe(0);
      expect(f.effects()).toBe(0);
      expect(f.companyStore.snapshot()).toEqual(before);
    }
  );
  it.each(['owner', 'worker', 'headless-worker'] as const)(
    'runtime origin revoked during a genuine %s source-read await stops the next effect',
    async (caller) => {
      const f = await fixture({ office: true, storedPolicy: true }),
        before = f.companyStore.snapshot();
      f.beforeObservation(async () => {
        f.revokeRuntime();
      });
      const response = await f.app.inject({
        method: 'POST',
        url: f.url + '/docker-continuation',
        headers: f.headersFor(caller),
        payload: { request: f.request },
      });
      expect({
        status: response.statusCode,
        effects: f.effects(),
        operations: f.companyStore.snapshot().dockerEmployeeContinuations?.length ?? 0,
      }).toEqual({ status: 409, effects: 0, operations: 0 });
      expect(response.json().error.code).toBe('DOCKER_CONTINUATION_RUNTIME_CHANGED');
      expect(f.observations()).toBe(1);
      expect(f.effects()).toBe(0);
      expect(f.companyStore.snapshot()).toEqual(before);
    }
  );

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
  it.each(['owner', 'worker', 'headless-worker'] as const)(
    'a permitted %s reaches the same durable service and sanitized recovery outcome',
    async (caller) => {
      const f = await fixture({ storedPolicy: true, office: true });
      const response = await f.app.inject({
        method: 'POST',
        url: f.url + '/docker-continuation',
        headers: f.headersFor(caller),
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
        headers: f.headersFor(caller),
        payload: { operationId: f.request.operationId },
      });
      expect(observed.statusCode, observed.body).toBe(200);
      expect(f.effects()).toBe(1);
    }
  );
  it.each(['generation', 'session', 'actor-generation', 'actor-session', 'permission', 'identity'] as const)(
    'rejects %s changes during an awaited source read',
    async (change) => {
      const f = await fixture({ storedPolicy: true });
      f.beforeObservation(async () => {
        if (change === 'identity') f.revokeIdentity();
        else
          await f.companyStore.update((state) => {
            const employee = state.employees.find(
              (e) => e.id === (change === 'permission' || change.startsWith('actor-') ? actor : target)
            )!;
            if (change === 'permission') employee.permissions.recoverEmployees = false;
            else if (change.endsWith('session')) employee.sessionId = '66666666-6666-4666-8666-666666666666';
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

describe('canonical resource inventory remains independent of launch permission', () => {
  async function boundFixture() {
    const f = await fixture({ storedPolicy: true, office: true });
    const response = await f.app.inject({
      method: 'POST',
      url: f.url + '/docker-continuation',
      headers: f.ownerHeaders,
      payload: { request: f.request },
    });
    expect(response.statusCode).toBe(200);
    await f.companyStore.update((state) => {
      const row = state.dockerEmployeeContinuations![0]!,
        employee = state.employees.find((value) => value.id === target)!;
      row.phase = 'ready';
      row.destination = { ...row.original, containerId: '8'.repeat(64), imageId: destinationImage };
      employee.dockerBinding = {
        version: 1,
        operationId: row.request.operationId,
        credentialId: row.credentialId,
        sessionId: row.request.sessionId,
        sessionGeneration: row.request.sessionGeneration,
        containerId: row.destination.containerId,
        imageId: row.destination.imageId,
        originalDigest: dockerContinuationDigest(row.destination),
        policyDigest: dockerContinuationDigest(row.policy),
      };
      employee.onVacation = true;
      employee.desiredRunning = false;
    });
    return f;
  }
  it('signed API callers cannot overwrite private retained ownership or receive it as permission', async () => {
    const f = await boundFixture();
    const imageId = destinationImage;
    await f.companyStore.update((state) => {
      state.dockerEmployeeContinuations![0]!.tasks = [
        {
          role: 'anchor',
          name: 'reverie-boxed-anchor-' + 'a'.repeat(32),
          imageId,
          configurationDigest: '1'.repeat(64),
          phase: 'running',
          containerId: '2'.repeat(64),
          initPid: 101,
          initStartTicks: '202',
        },
        {
          role: 'pool-helper',
          name: 'reverie-boxed-pool-helper-synthetic',
          imageId,
          configurationDigest: '3'.repeat(64),
          phase: 'completed',
          containerId: '4'.repeat(64),
          resultDigest: '5'.repeat(64),
        },
      ];
    });
    const before = f.companyStore.snapshot();
    for (const headers of [f.ownerHeaders, f.workerHeaders]) {
      const response = await f.app.inject({
        method: 'POST',
        url: f.url + '/docker-continuation',
        headers,
        payload: { request: f.request, dockerSharedPoolLineages: [] },
      });
      expect([400, 403, 409]).toContain(response.statusCode);
      expect(response.body).not.toContain('reverie-boxed-shared-pool-lineage');
    }
    expect(f.companyStore.snapshot()).toEqual(before);
    expect(f.company.view()).not.toHaveProperty('dockerSharedPoolLineages');
    expect(f.effects()).toBe(1);
    f.revokeIdentity();
    const denied = await f.app.inject({ method: 'GET', url: f.url + '/docker-policy', headers: f.workerHeaders });
    expect(denied.statusCode).toBe(403);
    expect(f.companyStore.snapshot()).toEqual(before);
  });
  it.each(['held', 'changed-source', 'remote-saved'] as const)(
    'retains exact current bound destination when %s prevents launching',
    async (change) => {
      const f = await boundFixture();
      if (change === 'held') f.saved.providerDispatchHeld = true;
      else if (change === 'changed-source') f.saved.workingDir = '/changed-launch-recipe';
      else
        f.saved.remote = {
          hostId: 'synthetic',
          label: 'Synthetic',
          host: 'example.invalid',
          username: 'synthetic',
          remotePath: '/synthetic',
        };
      const row = f.store.record(target)!;
      expect(f.store.subject(target)?.sourceDigest).not.toBe(row.sourceDigest);
      expect(f.store.resourceInventory().map((value) => value.destination?.containerId)).toEqual(['8'.repeat(64)]);
      expect(f.effects()).toBe(1);
    }
  );
  it('retains a current bound row pool task despite held launch, without treating history as an ACK', async () => {
    const f = await boundFixture();
    f.saved.providerDispatchHeld = true;
    const task = {
      role: 'pool-helper' as const,
      name: 'reverie-boxed-pool-synthetic',
      imageId: destinationImage,
      configurationDigest: '6'.repeat(64),
      phase: 'completed' as const,
      containerId: '5'.repeat(64),
      resultDigest: '4'.repeat(64),
    };
    await f.companyStore.update((state) => {
      state.dockerEmployeeContinuations![0]!.tasks = [task];
    });
    expect(f.store.subject(target)).toBeUndefined();
    expect(
      f.store.resourceInventory().flatMap((row) => row.tasks?.filter((value) => value.role === 'pool-helper') ?? [])
    ).toEqual([task]);
    expect(f.effects()).toBe(1);
  });
  it.each([
    'owner',
    'session',
    'generation',
    'operation',
    'credential',
    'container',
    'image',
    'destination-digest',
    'policy-digest',
    'missing-binding',
    'duplicate-employee',
    'early-phase',
    'eligible-mismatched-binding',
  ] as const)('does not admit a retained destination after %s changes', async (change) => {
    const f = await boundFixture();
    f.saved.providerDispatchHeld = change !== 'eligible-mismatched-binding';
    await f.companyStore.update((state) => {
      const employee = state.employees.find((value) => value.id === target)!,
        binding = employee.dockerBinding!;
      if (change === 'owner') employee.owner = 'different-owner';
      else if (change === 'session') employee.sessionId = '77777777-7777-4777-8777-777777777777';
      else if (change === 'generation') employee.sessionGeneration++;
      else if (change === 'operation') binding.operationId = '77777777-7777-4777-8777-777777777777';
      else if (change === 'credential') binding.credentialId = '77777777-7777-4777-8777-777777777777';
      else if (change === 'container' || change === 'eligible-mismatched-binding') binding.containerId = '7'.repeat(64);
      else if (change === 'image') binding.imageId = 'sha256:' + '7'.repeat(64);
      else if (change === 'destination-digest') binding.originalDigest = '7'.repeat(64);
      else if (change === 'policy-digest') binding.policyDigest = '7'.repeat(64);
      else if (change === 'missing-binding') delete employee.dockerBinding;
      else if (change === 'duplicate-employee')
        state.employees.push({ ...employee, id: '77777777-7777-4777-8777-777777777777' });
      else state.dockerEmployeeContinuations![0]!.phase = 'pool-issued';
    });
    expect(f.store.resourceInventory()).toEqual([]);
  });
});

describe('explicit legacy source-correlation format migration', () => {
  async function legacyFixture() {
    const f = await fixture({ storedPolicy: true, office: true });
    await f.app.inject({
      method: 'POST',
      url: f.url + '/docker-continuation',
      headers: f.ownerHeaders,
      payload: { request: f.request },
    });
    await f.companyStore.update((state) => {
      const row = state.dockerEmployeeContinuations![0]!;
      if (row.version !== 2) throw Error('Current writes must use v2');
      const { providerSourceDigest: _existing, ...legacy } = row;
      void _existing;
      state.dockerEmployeeContinuations![0] = { ...legacy, version: 1, purpose: 'docker-employee-continuation-v1' };
    });
    return f;
  }
  it('imports only correlation metadata and preserves every operation, binding, permission and effect count', async () => {
    const f = await legacyFixture(),
      before = f.companyStore.snapshot(),
      effects = f.effects();
    expect(await f.store.migrateProviderSource(target, () => {})).toBe(1);
    const after = f.companyStore.snapshot(),
      upgraded = after.dockerEmployeeContinuations![0]!;
    expect(upgraded.version).toBe(2);
    if (upgraded.version !== 2) throw Error('Expected v2');
    expect(upgraded.providerSourceDigest).toBe(f.store.subject(target)!.providerSourceDigest);
    const { providerSourceDigest: _existing, ...data } = upgraded;
    void _existing;
    after.dockerEmployeeContinuations![0] = { ...data, version: 1, purpose: 'docker-employee-continuation-v1' };
    expect(after).toEqual(before);
    expect(f.effects()).toBe(effects);
    expect(await f.store.migrateProviderSource(target, () => {})).toBe(0);
  });
  it.each(['foreign-owner', 'foreign-session', 'changed-recipe'] as const)(
    'leaves %s legacy metadata unmodified and unapproved',
    async (change) => {
      const f = await legacyFixture();
      if (change === 'foreign-owner') f.saved.owner = 'foreign';
      else if (change === 'foreign-session') f.saved.id = actorSid;
      else f.saved.workingDir = '/different';
      const before = f.companyStore.snapshot(),
        effects = f.effects();
      expect(await f.store.migrateProviderSource(target, () => {})).toBe(0);
      expect(f.companyStore.snapshot()).toEqual(before);
      expect(f.effects()).toBe(effects);
    }
  );
  it('refuses revoked migration custody before canonical publication', async () => {
    const f = await legacyFixture(),
      before = f.companyStore.snapshot();
    let calls = 0;
    await expect(
      f.store.migrateProviderSource(target, () => {
        if (++calls > 1) throw Error('custody revoked');
      })
    ).rejects.toThrow('custody revoked');
    expect(f.companyStore.snapshot()).toEqual(before);
  });
});

describe('owner-only Docker live resource revision HTTP', () => {
  const revision = '99999999-9999-4999-8999-999999999999';
  const desired = {
    revision,
    expectedRevision: null,
    scope: 'all-current-and-future',
    memoryHighBytes: 48 * 1024 ** 3,
  };
  it('owner publishes desired48 for existing/offline/future, without rewriting original employees/rows or using Engine', async () => {
    const f = await fixture({ storedPolicy: true }),
      before = f.companyStore.snapshot();
    const response = await f.app.inject({
      method: 'PUT',
      url: '/api/company/docker-resources/default',
      headers: f.ownerHeaders,
      payload: desired,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.enforcement).toBe('not-observed');
    expect(f.companyStore.snapshot()).toEqual(before);
    expect(f.effects()).toBe(0);
    const status = await f.app.inject({ method: 'GET', url: '/api/company/docker-resources', headers: f.ownerHeaders });
    expect(status.statusCode).toBe(200);
    expect(
      status.json().data.employees.find((employee: { employeeId: string }) => employee.employeeId === target)
    ).toMatchObject({
      desiredMemoryHighBytes: 48 * 1024 ** 3,
      state: 'offline-or-unbound',
      enforcement: 'not-observed',
    });
    expect(f.store.policy(target)).toEqual({ ...policy, memoryHighBytes: 48 * 1024 ** 3 });
    const selection = await f.app.inject({ method: 'GET', url: f.url + '/docker-policy', headers: f.ownerHeaders });
    expect(selection.statusCode).toBe(200);
    expect(selection.json().data.policy.memoryHighBytes).toBe(48 * 1024 ** 3);
    expect(selection.json().data.policyDigest).toBe(
      dockerContinuationDigest({ ...policy, memoryHighBytes: 48 * 1024 ** 3 })
    );
    // A new future employee inherits the same approved default, with no implicit row/launch.
    const future = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      futureSid = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    await f.companyStore.update((state) =>
      state.employees.push(
        EmployeeSchema.parse({
          ...state.employees.find((employee) => employee.id === target)!,
          id: future,
          sessionId: futureSid,
        })
      )
    );
    expect(f.store.policy(future).memoryHighBytes).toBe(48 * 1024 ** 3);
    expect(f.store.record(future)).toBeUndefined();
    expect(f.effects()).toBe(0);
  });
  it.each(['worker', 'headless-worker'] as const)(
    'real scoped %s cannot approve/default/apply resource edits',
    async (caller) => {
      const f = await fixture({ recover: true, office: true, storedPolicy: true });
      for (const request of [
        { method: 'PUT' as const, url: '/api/company/docker-resources/default', payload: desired },
        { method: 'POST' as const, url: f.url + '/docker-resources/apply', payload: { revision } },
        { method: 'POST' as const, url: f.url + '/docker-resources/reconcile', payload: { revision } },
        { method: 'POST' as const, url: f.url + '/docker-resources/continue', payload: { revision } },
        { method: 'POST' as const, url: f.url + '/docker-resources/abandon', payload: { revision } },
      ]) {
        const response = await f.app.inject({ ...request, headers: f.headersFor(caller) });
        expect(response.statusCode).toBe(403);
      }
      expect(f.revisions.desired(undefined)).toBeUndefined();
      expect(f.effects()).toBe(0);
    }
  );
  it('rejects unauthenticated, ambiguous worker+owner, stale revision, and offline apply without Engine effects', async () => {
    const f = await fixture({ storedPolicy: true });
    expect(
      (
        await f.app.inject({
          method: 'PUT',
          url: '/api/company/docker-resources/default',
          payload: desired,
          headers: { origin: 'http://localhost', host: 'localhost' },
        })
      ).statusCode
    ).toBe(401);
    expect(
      (
        await f.app.inject({
          method: 'PUT',
          url: '/api/company/docker-resources/default',
          payload: desired,
          headers: { ...f.ownerHeaders, ...f.workerHeaders },
        })
      ).statusCode
    ).toBe(403);
    expect(
      (
        await f.app.inject({
          method: 'PUT',
          url: '/api/company/docker-resources/default',
          payload: desired,
          headers: f.ownerHeaders,
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await f.app.inject({
          method: 'PUT',
          url: '/api/company/docker-resources/default',
          payload: { ...desired, revision: '88888888-8888-4888-8888-888888888888' },
          headers: f.ownerHeaders,
        })
      ).statusCode
    ).toBe(409);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: f.url + '/docker-resources/apply',
          payload: { revision },
          headers: f.ownerHeaders,
        })
      ).statusCode
    ).toBe(409);
    expect(f.effects()).toBe(0);
  });
  it('a real owner logout during the asynchronous publication boundary refuses before desired commit', async () => {
    const f = await fixture(),
      original = f.revisions.approve.bind(f.revisions);
    const spy = vi.spyOn(f.revisions, 'approve').mockImplementation(async (...args) => {
      await Promise.resolve();
      f.logout();
      return original(...args);
    });
    try {
      const response = await f.app.inject({
        method: 'PUT',
        url: '/api/company/docker-resources/default',
        payload: desired,
        headers: f.ownerHeaders,
      });
      expect(response.statusCode).toBe(403);
      expect(f.revisions.desired(undefined)).toBeUndefined();
      expect(f.effects()).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('resource revision currentness across real Company/Engine async reads', () => {
  it.each(
    (['owner', 'generation', 'binding', 'recipe'] as const).flatMap((change) =>
      (['apply', 'reconcile', 'continue', 'abandon'] as const).map((path) => ({ change, path }))
    )
  )('$change swap during $path Engine read refuses before helper publication', async ({ change, path }) => {
    const f = await fixture({ storedPolicy: true });
    await f.bindResourceRow();
    const desired = {
      revision: '99999999-9999-4999-8999-999999999999',
      expectedRevision: null,
      scope: 'all-current-and-future',
      memoryHighBytes: 48 * 1024 ** 3,
    };
    expect(
      (
        await f.app.inject({
          method: 'PUT',
          url: '/api/company/docker-resources/default',
          headers: f.ownerHeaders,
          payload: desired,
        })
      ).statusCode
    ).toBe(200);
    let changed = false;
    f.beforeResourceRead(async () => {
      if (changed) return;
      changed = true;
      await f.companyStore.update((state) => {
        const employee = state.employees.find((value) => value.id === target)!;
        if (change === 'owner') employee.owner = 'changed-owner';
        if (change === 'generation') employee.sessionGeneration++;
        if (change === 'binding') employee.dockerBinding!.containerId = '7'.repeat(64);
        if (change === 'recipe') employee.runtimeRecipe!.workingDir = '/changed-workspace';
      });
    });
    const row = f.store.record(target)!;
    const response = await f.app.inject({
      method: 'POST',
      url: f.url + '/docker-resources/' + path,
      headers: f.ownerHeaders,
      payload: { revision: desired.revision },
    });
    expect(response.statusCode).toBe(409);
    expect(f.effects()).toBe(0);
    expect(f.resourceReads()).toBe(1);
    expect(f.revisions.attempt(row, desired.revision)).toBeUndefined();
  });
});

describe('new-operation approved resource default snapshot', () => {
  const desired = {
    revision: '99999999-9999-4999-8999-999999999999',
    expectedRevision: null,
    scope: 'all-current-and-future',
    memoryHighBytes: 48 * 1024 ** 3,
  };
  it('canonical NEW BEGIN uses48 through its next authority check rather than reverting to the prior16 approval', async () => {
    const f = await fixture({ storedPolicy: true });
    expect(
      (
        await f.app.inject({
          method: 'PUT',
          url: '/api/company/docker-resources/default',
          headers: f.ownerHeaders,
          payload: desired,
        })
      ).statusCode
    ).toBe(200);
    const response = await f.app.inject({
      method: 'POST',
      url: f.url + '/docker-continuation',
      headers: f.ownerHeaders,
      payload: {
        request: {
          ...f.request,
          expectedPolicyDigest: dockerContinuationDigest({ ...policy, memoryHighBytes: 48 * 1024 ** 3 }),
        },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(f.store.record(target)?.phase).toBe('pool-issued'); // actual synthetic preparePool port was reached
    expect(f.store.record(target)?.policy.memoryHighBytes).toBe(48 * 1024 ** 3);
    expect(
      f.companyStore.snapshot().employees.find((employee) => employee.id === target)?.dockerResourcePolicy
        ?.memoryHighBytes
    ).toBe(48 * 1024 ** 3);
    expect(f.effects()).toBe(1); // preparePool is intentionally unconfirmed; no provider launch
  });
  it('default publication leaves an EXISTING16 request, policy, binding and employee approval unchanged', async () => {
    const f = await fixture({ storedPolicy: true });
    await f.bindResourceRow();
    const before = f.companyStore.snapshot(),
      row = f.store.record(target);
    expect(
      (
        await f.app.inject({
          method: 'PUT',
          url: '/api/company/docker-resources/default',
          headers: f.ownerHeaders,
          payload: desired,
        })
      ).statusCode
    ).toBe(200);
    expect(f.companyStore.snapshot()).toEqual(before);
    expect(f.store.record(target)).toEqual(row);
    expect(f.store.policy(target).memoryHighBytes).toBe(16 * 1024 ** 3);
    expect(f.effects()).toBe(0);
  });
});

describe('canonical closed-writer status projection', () => {
  it('projects the actual private revision ledger through owner HTTP to the shared GUI contract', async () => {
    const f = await resourcePhaseFixture('closed-writer');
    const before = f.effects(),
      reads = f.resourceReads();
    const response = await f.app.inject({
      method: 'GET',
      url: '/api/company/docker-resources',
      headers: f.ownerHeaders,
    });
    expect(response.statusCode).toBe(200);
    const actual = response.json().data;
    expect(actual).toEqual(
      JSON.parse(
        fs.readFileSync(new URL('./fixtures/docker-resource-closed-writer-status.json', import.meta.url), 'utf8')
      )
    );
    expect(actual.employees.find((value: { employeeId: string }) => value.employeeId === target)).toMatchObject({
      state: 'closed-writer',
      writerClosed: true,
      originalOutcome: 'unknown',
      allowedActions: ['reconcile', 'new-revision'],
      enforcement: 'not-observed',
    });
    expect(f.effects()).toBe(before);
    expect(f.resourceReads()).toBe(reads);
  });
});

type ResourcePhase =
  | 'failure-before-intent'
  | 'no-desired'
  | 'none'
  | 'create-issued'
  | 'created'
  | 'start-issued'
  | 'running'
  | 'completed'
  | 'observed'
  | 'applied'
  | 'closed-writer'
  | 'observed-after-closure'
  | 'unstarted-retired'
  | 'observed-after-retirement';
async function resourcePhaseFixture(phase: ResourcePhase) {
  const f = await fixture({ storedPolicy: true });
  await f.bindResourceRow();
  if (phase === 'no-desired') return f;
  const revision = '77777777-7777-4777-8777-777777777777';
  const desired = { revision, owner: null, scope: 'all-current-and-future' as const, memoryHighBytes: 48 * 1024 ** 3 };
  await f.revisions.approve(desired, null, () => {});
  const row = f.store.resourceInventory().find((value) => value.employeeId === target)!;
  if (phase === 'none') return f;
  if (phase === 'failure-before-intent') {
    await f.companyStore.update((state) => {
      const employee = state.employees.find((value) => value.id === target)!;
      employee.onVacation = false;
      employee.desiredRunning = true;
    });
    await expect(f.resourceRevisionService.converge(target, () => {})).rejects.toThrow();
    return f;
  }

  const identity = {
    boxId: '7'.repeat(64),
    parent: { path: '/synthetic-pool', dev: '1', ino: '2' },
    anchor: { id: 'a'.repeat(64), pid: 100, startTicks: '10', path: '/synthetic-pool/anchor', dev: '1', ino: '3' },
    worker: {
      id: row.destination!.containerId,
      pid: 200,
      startTicks: '20',
      path: '/synthetic-pool/worker',
      dev: '1',
      ino: '4',
    },
  };
  const base = dockerResourceAttemptKey(row, revision);
  let before: import('../src/docker-resource-revisions.js').DockerResourceAttempt | undefined;
  const publish = async (next: import('../src/docker-resource-revisions.js').DockerResourceAttempt) => {
    await f.revisions.publish(row, desired, before, next, () => {});
    before = next;
  };
  if (phase === 'observed') {
    await publish({ ...base, state: 'observed', identity, observationDigest: 'f'.repeat(64) });
    return f;
  }
  const task = {
    role: 'leaf-helper' as const,
    name: 'reverie-boxed-synthetic-closed-writer',
    imageId: 'sha256:' + '9'.repeat(64),
    configurationDigest: 'a'.repeat(64),
    phase: 'create-issued' as const,
  };
  await publish({ ...base, state: 'helper', task });
  if (phase === 'create-issued') return f;
  const created = { ...task, phase: 'created' as const, containerId: 'b'.repeat(64) };
  if (phase !== 'unstarted-retired' && phase !== 'observed-after-retirement') {
    await publish({ ...base, state: 'helper', task: created });
    if (phase === 'created') return f;
  } else {
    const retirement = {
      version: 1 as const,
      purpose: 'reverie-memory-unstarted-intent-retired-v1' as const,
      authority: 'canonical-prestart-cas-v1' as const,
      taskDigest: dockerContinuationDigest(task),
      originalOutcome: 'unknown' as const,
    };
    await publish({ ...base, state: 'unstarted-retired', task, retirement });
    if (phase === 'observed-after-retirement')
      await publish({
        ...base,
        state: 'observed-after-retirement',
        task,
        retirement,
        identity,
        observationDigest: 'f'.repeat(64),
      });
    return f;
  }
  const issued = { ...created, phase: 'start-issued' as const };
  await publish({ ...base, state: 'helper', task: issued });
  if (phase === 'start-issued') return f;
  if (phase === 'running') {
    await publish({
      ...base,
      state: 'helper',
      task: { ...created, phase: 'running', initPid: 300, initStartTicks: '30' },
    });
    return f;
  }
  if (phase === 'completed' || phase === 'applied') {
    const completed = { ...created, phase: 'completed' as const, resultDigest: 'f'.repeat(64) };
    await publish({ ...base, state: 'helper', task: completed });
    if (phase === 'applied')
      await publish({ ...base, state: 'applied', task: completed, identity, observationDigest: 'f'.repeat(64) });
    return f;
  }
  const closure = {
    version: 1 as const,
    purpose: 'reverie-memory-writer-closed-v1' as const,
    authority: 'canonical-issued-high-only-image-v1' as const,
    containerId: issued.containerId,
    imageId: issued.imageId,
    configurationDigest: issued.configurationDigest,
    terminalStateDigest: 'c'.repeat(64),
    exitCode: 1,
    identity,
    originalOutcome: 'unknown' as const,
  };
  await publish({ ...base, state: 'closed-writer', task: issued, closure });
  if (phase === 'observed-after-closure')
    await publish({
      ...base,
      state: 'observed-after-closure',
      task: issued,
      closure,
      identity,
      observationDigest: 'f'.repeat(64),
    });
  return f;
}
const resourcePhaseActions: readonly { phase: ResourcePhase; actions: string[] }[] = [
  { phase: 'failure-before-intent', actions: ['apply'] },
  { phase: 'no-desired', actions: [] },
  { phase: 'none', actions: ['apply'] },
  { phase: 'create-issued', actions: ['continue-original', 'abandon-original'] },
  { phase: 'created', actions: ['continue-original', 'abandon-original'] },
  { phase: 'start-issued', actions: ['reconcile'] },
  { phase: 'running', actions: ['reconcile'] },
  { phase: 'completed', actions: ['reconcile'] },
  { phase: 'observed', actions: [] },
  { phase: 'applied', actions: [] },
  { phase: 'closed-writer', actions: ['reconcile', 'new-revision'] },
  { phase: 'observed-after-closure', actions: [] },
  { phase: 'unstarted-retired', actions: ['reconcile', 'new-revision'] },
  { phase: 'observed-after-retirement', actions: [] },
];
describe('exhaustive resource cursor owner HTTP action matrix', () => {
  it.each(resourcePhaseActions)('$phase offers only its canonical recovery family', async ({ phase, actions }) => {
    const f = await resourcePhaseFixture(phase),
      row = f.store.resourceInventory().find((value) => value.employeeId === target)!;
    const response = await f.app.inject({
      method: 'GET',
      url: '/api/company/docker-resources',
      headers: f.ownerHeaders,
    });
    expect(response.statusCode).toBe(200);
    const data = response.json().data;
    expect(data).toEqual(
      JSON.parse(fs.readFileSync(new URL('./fixtures/docker-resource-phase-statuses.json', import.meta.url), 'utf8'))[
        phase
      ]
    );
    expect(data.employees.find((value: { employeeId: string }) => value.employeeId === target).allowedActions).toEqual(
      actions
    );
    expect(f.revisions.actions(row, f.revisions.desired(undefined)?.revision)).toEqual(actions);
    const pending = ['create-issued', 'created', 'start-issued', 'running', 'completed'].includes(phase);
    expect(data.allowedActions).toEqual(pending ? [] : ['approve-default']);
    expect(f.revisions.canApprove(undefined)).toBe(!pending);
    if (pending)
      await expect(
        f.revisions.approve(
          {
            revision: '88888888-8888-4888-8888-888888888888',
            owner: null,
            scope: 'all-current-and-future',
            memoryHighBytes: 48 * 1024 ** 3,
          },
          '77777777-7777-4777-8777-777777777777',
          () => {}
        )
      ).rejects.toThrow('ORIGINAL_ATTEMPT_PENDING');
    for (const action of actions) {
      if (action === 'new-revision') continue;
      const endpoint = action === 'continue-original' ? 'continue' : action === 'abandon-original' ? 'abandon' : action;
      const result = await f.app.inject({
        method: 'POST',
        url: f.url + '/docker-resources/' + endpoint,
        headers: f.ownerHeaders,
        payload: { revision: '77777777-7777-4777-8777-777777777777' },
      });
      expect(result.statusCode).toBe(409); // Physical adapter is deliberately unconfirmed; a route never fabricates success.
      expect(f.resourceReads()).toBeGreaterThan(0);
      expect(f.effects()).toBe(0);
    }
  });
});

describe('scoped locked default publication refusal', () => {
  async function pendingDefaultFixture() {
    const f = await resourcePhaseFixture('none');
    const stale = await f.app.inject({ method: 'GET', url: '/api/company/docker-resources', headers: f.ownerHeaders });
    expect(stale.json().data.allowedActions).toEqual(['approve-default']);
    const row = f.store.resourceInventory().find((value) => value.employeeId === target)!;
    const desired = f.revisions.desired(undefined)!;
    await f.revisions.publish(
      row,
      desired,
      undefined,
      {
        ...dockerResourceAttemptKey(row, desired.revision),
        state: 'helper',
        task: {
          role: 'leaf-helper',
          name: 'reverie-boxed-synthetic-pending',
          imageId: 'sha256:' + '9'.repeat(64),
          configurationDigest: 'a'.repeat(64),
          phase: 'create-issued',
        },
      },
      () => {}
    );
    return f;
  }
  const payload = {
    revision: '88888888-8888-4888-8888-888888888888',
    expectedRevision: '77777777-7777-4777-8777-777777777777',
    scope: 'all-current-and-future',
    memoryHighBytes: 48 * 1024 ** 3,
  };
  it('stale enabled GET then pending helper yields a genuine revision-correlated not-issued response', async () => {
    const f = await pendingDefaultFixture();
    const response = await f.app.inject({
      method: 'PUT',
      url: '/api/company/docker-resources/default',
      headers: f.ownerHeaders,
      payload,
    });
    expect(response.statusCode).toBe(409);
    const actual = response.json();
    expect(actual).toEqual({
      success: false,
      error: {
        code: 'DOCKER_RESOURCE_REVISION_ORIGINAL_ATTEMPT_PENDING',
        action: 'approve-default',
        revision: payload.revision,
        publication: 'not-issued',
      },
    });
    expect(actual).toEqual(
      JSON.parse(
        fs.readFileSync(new URL('./fixtures/docker-resource-default-not-issued.json', import.meta.url), 'utf8')
      )
    );
    expect(f.revisions.desired(undefined)?.revision).toBe(payload.expectedRevision);
    const fresh = await f.app.inject({ method: 'GET', url: '/api/company/docker-resources', headers: f.ownerHeaders });
    expect(fresh.statusCode).toBe(200);
    expect(fresh.json().data.allowedActions).toEqual([]);
    expect(f.effects()).toBe(0);
    expect(f.resourceReads()).toBe(0);
  });
  it('a consuming lock-close failure strips the prewrite marker instead of claiming a known result', async () => {
    const f = await pendingDefaultFixture(),
      native = fs.closeSync;
    const before = fs.readFileSync(join(f.revisions.directory, 'revisions.json'));
    const close = vi.spyOn(fs, 'closeSync').mockImplementation((fd) => {
      let lock = false;
      try {
        lock = fs.readlinkSync('/proc/self/fd/' + fd) === join(f.revisions.directory, 'writer.lock');
      } catch {
        // An unrelated or already-consumed descriptor is not this fixture's writer lock.
      }
      native(fd);
      if (lock) throw Error('lost lock consuming close');
    });
    try {
      const response = await f.app.inject({
        method: 'PUT',
        url: '/api/company/docker-resources/default',
        headers: f.ownerHeaders,
        payload,
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ success: false, error: { code: 'DOCKER_RESOURCE_REVISION_UNCONFIRMED' } });
      expect(fs.readFileSync(join(f.revisions.directory, 'revisions.json'))).toEqual(before);
    } finally {
      close.mockRestore();
    }
  });
  it('a postpublication fsync failure never carries a not-issued marker', async () => {
    const f = await resourcePhaseFixture('none'),
      renameNative = fs.renameSync,
      syncNative = fs.fsyncSync;
    let renamed = false;
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation((...args) => {
      renameNative(...args);
      if (fs.realpathSync(args[1]) === join(f.revisions.directory, 'revisions.json')) renamed = true;
    });
    const sync = vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
      syncNative(fd);
      if (renamed) throw Error('lost default publication finalize');
    });
    try {
      const response = await f.app.inject({
        method: 'PUT',
        url: '/api/company/docker-resources/default',
        headers: f.ownerHeaders,
        payload,
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ success: false, error: { code: 'DOCKER_RESOURCE_REVISION_UNCONFIRMED' } });
    } finally {
      rename.mockRestore();
      sync.mockRestore();
    }
    const onDisk = JSON.parse(fs.readFileSync(join(f.revisions.directory, 'revisions.json'), 'utf8'));
    expect(onDisk.desired.at(-1).revision).toBe(payload.revision);
    expect(f.effects()).toBe(0);
  });
});

describe('default publication permission finalizer', () => {
  it('owner revocation after publication never carries the not-issued marker', async () => {
    const f = await resourcePhaseFixture('none'),
      native = fs.renameSync;
    const payload = {
      revision: '88888888-8888-4888-8888-888888888888',
      expectedRevision: '77777777-7777-4777-8777-777777777777',
      scope: 'all-current-and-future',
      memoryHighBytes: 48 * 1024 ** 3,
    };
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation((...args) => {
      native(...args);
      if (fs.realpathSync(args[1]) === join(f.revisions.directory, 'revisions.json')) f.logout();
    });
    try {
      const response = await f.app.inject({
        method: 'PUT',
        url: '/api/company/docker-resources/default',
        headers: f.ownerHeaders,
        payload,
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error).not.toHaveProperty('publication');
    } finally {
      rename.mockRestore();
    }
    const onDisk = JSON.parse(fs.readFileSync(join(f.revisions.directory, 'revisions.json'), 'utf8'));
    expect(onDisk.desired.at(-1).revision).toBe(payload.revision);
  });
});

describe('resource target currency excludes unrelated progress, retaining real owner and binding authority', () => {
  // These are controlled read ports for the service currency guard. Native kernel
  // enforcement is separately exercised by the physical controller acceptance.
  it.each(['wake-attempt', 'name', 'phase'] as const)(
    'keeps a genuine owner read current across benign %s progress',
    async (change) => {
      const f = await fixture({ storedPolicy: true });
      await f.bindResourceRow();
      let entered = false;
      const destination = vi
        .spyOn(f.resourceEngine, 'verifyResourceDestination')
        .mockImplementation(async (_row, current) => {
          if (!entered) {
            entered = true;
            await f.companyStore.update((state) => {
              const employee = state.employees.find((value) => value.id === target)!;
              if (change === 'wake-attempt') employee.wakeAttempts.push(123);
              if (change === 'name') employee.name = 'New display name';
              if (change === 'phase') state.dockerEmployeeContinuations![0]!.phase = 'provider-issued';
            });
          }
          current();
        });
      const read = vi.spyOn(f.resources, 'observeMemoryHigh').mockImplementation(async (_row, current) => {
        current();
        return {
          actualMemoryHighBytes: policy.memoryHighBytes,
          memoryMaxBytes: policy.memoryMaxBytes,
          actualLimits: { ...policy, cpuQuota: 'unlimited' as const },
          approved: true,
          approvalSource: 'original-policy' as const,
          approvedRevision: null,
        };
      });
      try {
        const response = await f.app.inject({
          method: 'GET',
          url: f.url + '/docker-resources',
          headers: f.ownerHeaders,
        });
        expect(response.statusCode).toBe(200);
        expect(response.json().data.sessionId).toBe(sid);
        expect(read).toHaveBeenCalledOnce();
        expect(destination).toHaveBeenCalledTimes(2);
        expect(f.effects()).toBe(0);
      } finally {
        read.mockRestore();
        destination.mockRestore();
      }
    }
  );
  it.each([
    'logout',
    'owner',
    'generation',
    'binding',
    'recipe',
    'vacation',
    'stopped',
    'operation',
    'held-phase',
  ] as const)('still refuses %s at the await before any resource read or write', async (change) => {
    const f = await fixture({ storedPolicy: true });
    await f.bindResourceRow();
    const destination = vi
      .spyOn(f.resourceEngine, 'verifyResourceDestination')
      .mockImplementation(async (_row, current) => {
        if (change === 'logout') f.logout();
        else
          await f.companyStore.update((state) => {
            const employee = state.employees.find((value) => value.id === target)!;
            if (change === 'owner') employee.owner = 'new-owner';
            if (change === 'generation') employee.sessionGeneration++;
            if (change === 'binding') employee.dockerBinding!.containerId = '7'.repeat(64);
            if (change === 'recipe') employee.runtimeRecipe!.workingDir = '/different';
            if (change === 'vacation') employee.onVacation = !employee.onVacation;
            if (change === 'stopped') employee.desiredRunning = !employee.desiredRunning;
            if (change === 'operation')
              state.dockerEmployeeContinuations![0]!.request.operationId = '77777777-7777-4777-8777-777777777777';
            if (change === 'held-phase') state.dockerEmployeeContinuations![0]!.phase = 'destination-issued';
          });
        current();
      });
    const read = vi.spyOn(f.resources, 'observeMemoryHigh');
    try {
      const response = await f.app.inject({ method: 'GET', url: f.url + '/docker-resources', headers: f.ownerHeaders });
      expect(response.statusCode).toBe(change === 'logout' ? 403 : 409);
      expect(read).not.toHaveBeenCalled();
      expect(f.effects()).toBe(0);
    } finally {
      read.mockRestore();
      destination.mockRestore();
    }
  });
});
