/** Real controller, single canonical writer and authenticated API. Only native
 * Docker transport is controlled; no Engine, paid provider or personal data. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { fixture as physicalFixture, helper, policy } from './helpers/docker-resource-physical.js';
import { CompanyStore } from '../src/company-store.js';
import { CompanyService, type CompanyServiceDeps } from '../src/company-service.js';
import { EmployeeSchema } from '../src/company-types.js';
import { CompanyDockerContinuationStore } from '../src/docker-employee-store.js';
import { DockerPoolReconciliation } from '../src/docker-pool-reconciliation.js';
import { DockerPoolReconciliationReceipt } from '../src/docker-contained-resource-controller.js';
import { dockerPoolMetadataDigest } from '../src/docker-pool-observation-data.js';
import { DockerEmployeeContinuation, type DockerContinuationEngine } from '../src/docker-employee-continuation.js';
import { registerDockerEmployeeContinuationRoutes } from '../src/web/routes/docker-employee-continuation-routes.js';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { ownerVerifier } from '../src/owner-auth/marks.js';
import { registerOwnerPolicy } from '../src/owner-auth/policy.js';
import { registerAuthMiddleware } from '../src/web/middleware/auth.js';
import { ownerFor } from '../src/web/route-helpers.js';
import {
  DockerWorkerIdentityAuthentication,
  DOCKER_WORKER_IDENTITY_HEADER,
  dockerWorkerIdentityOf,
  registerDockerWorkerIdentity,
} from '../src/docker-worker-identity.js';
import type { SessionPort } from '../src/web/ports/session-port.js';

const actor = '99999999-9999-4999-8999-999999999999',
  actorSid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
async function fixture(options: { recover?: boolean } = {}) {
  const physical = physicalFixture();
  await physical.controller.preparePool(physical.row(), physical.current);
  const completed = physical.tasks.get('pool-helper')!;
  if (!('containerId' in completed)) throw Error('Actual fixture helper CID required');
  physical.tasks.delete('pool-helper');
  physical.retain([]);
  const beforeEffects = { creates: [...physical.creates], starts: [...physical.starts] };
  const directory = await fs.mkdtemp(join(tmpdir(), 'pool-reconcile-'));
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  const companyFile = join(directory, 'company.json'),
    companyStore = new CompanyStore(companyFile);
  await companyStore.init();
  const sessions = new Map([[actorSid, { id: actorSid, name: 'Scoped coordinator', owner: undefined }]]);
  const deps = {
    getSession: (id: string) => sessions.get(id),
    chatrooms: { rooms: () => [] },
    research: {},
  } as unknown as CompanyServiceDeps;
  const company = new CompanyService(companyStore, deps),
    eid = physical.row().employeeId,
    sid = physical.row().request.sessionId,
    generation = physical.row().request.sessionGeneration;
  await companyStore.update((state) => {
    state.employees = [
      EmployeeSchema.parse({
        id: actor,
        sessionId: actorSid,
        sessionGeneration: 1,
        name: 'Scoped coordinator',
        icon: 'C',
        position: 'Engineer',
        expertise: ['synthetic'],
        createdAt: 1,
        onVacation: false,
        desiredRunning: true,
        permissions: { recoverEmployees: options.recover ?? true, manageOffice: false },
      }),
      EmployeeSchema.parse({
        id: eid,
        sessionId: sid,
        sessionGeneration: generation,
        name: 'Target',
        icon: 'T',
        position: 'Employee',
        expertise: ['synthetic'],
        createdAt: 1,
        onVacation: true,
        desiredRunning: false,
        dockerResourcePolicy: policy,
      }),
    ];
  });
  const store = new CompanyDockerContinuationStore(company, () => undefined);
  let runtime = true,
    identity = true;
  const runtimeCurrent = () => {
    if (!runtime) throw Error('Synthetic runtime revoked');
  };
  const service = new DockerPoolReconciliation(company, store, physical.controller, runtimeCurrent);
  const ownerAuth = new OwnerAuthService({
    store: new OwnerAuthStore(join(directory, 'owner.json')),
    auditFile: join(directory, 'audit.jsonl'),
    setupEnabled: true,
  });
  const ownerToken = await ownerAuth.setup(
    'synthetic-owner',
    'Synthetic-only-Ocean42!',
    'Synthetic-only-Ocean42!',
    '127.0.0.1'
  );
  const binding = {
    owner: undefined,
    employeeId: actor,
    sessionId: actorSid,
    sessionGeneration: 1,
    containerId: '9'.repeat(64),
    credentialId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  };
  const authentication = new DockerWorkerIdentityAuthentication(
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    Buffer.alloc(32, 0x53),
    { binding: () => (identity ? binding : undefined), keyCurrent: () => runtime }
  );
  const token = authentication.issue(binding, () => true);
  const app = Fastify();
  await app.register(cookie);
  registerDockerWorkerIdentity(app, authentication, '', { requireMachineProof: true });
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
  const forbidden = new Proxy({} as DockerContinuationEngine, {
    get() {
      throw Error('Business Engine port is forbidden');
    },
  });
  const continuation = new DockerEmployeeContinuation(
    store,
    forbidden,
    {
      launch: async () => {
        throw Error('Provider is forbidden');
      },
    },
    {
      issue: () => {
        throw Error('Credential issue is forbidden');
      },
    }
  );
  registerDockerEmployeeContinuationRoutes(
    app,
    company,
    store,
    continuation,
    {
      verifiedOwner: ownerVerifier({ service: ownerAuth, ctx }),
      owner: ownerFor,
      worker: dockerWorkerIdentityOf,
    },
    undefined,
    service
  );
  await app.ready();
  cleanups.push(async () => {
    await app.close();
    authentication.close();
    for (const timer of Object.values(authState)) timer?.dispose();
  });
  const url = '/api/company/employees/' + eid + '/docker-pool';
  const ownerHeaders = { cookie: 'reverie_owner=' + ownerToken, origin: 'http://localhost', host: 'localhost' };
  const workerHeaders = { [DOCKER_WORKER_IDENTITY_HEADER]: token, 'x-reverie-parent-session': actorSid };
  const authority = () => {
    const grant = company.recoveryAction(eid, undefined);
    return {
      owner: undefined,
      require: () => grant.require(),
      requireOffice: () => {
        throw Error('Office permission not used');
      },
    };
  };
  const body = (scopeDigest: string) => ({
    sessionId: sid,
    sessionGeneration: generation,
    expectedScopeDigest: scopeDigest,
  });
  const effects = () => expect({ creates: physical.creates, starts: physical.starts }).toEqual(beforeEffects);
  return {
    physical,
    completed,
    directory,
    companyFile,
    companyStore,
    company,
    store,
    service,
    app,
    url,
    ownerHeaders,
    workerHeaders,
    authority,
    body,
    effects,
    deps,
    eid,
    revokeRuntime: () => {
      runtime = false;
    },
    revokeIdentity: () => {
      identity = false;
    },
  };
}
describe('supported metadata-only recovery of an already lost pool ACK', () => {
  it.each(['owner', 'worker'] as const)(
    'real %s repairs missing history without inventing origin or dispatching effects',
    async (caller) => {
      const f = await fixture(),
        headers = caller === 'owner' ? f.ownerHeaders : f.workerHeaders;
      const before = await fs.readFile(f.companyFile, 'utf8');
      const status = await f.app.inject({ method: 'GET', url: f.url + '/status', headers });
      expect(status.statusCode).toBe(200);
      expect(status.json().data).toMatchObject({
        state: 'reconciliation-required',
        allowedActions: ['reconcile-pool'],
      });
      expect(await fs.readFile(f.companyFile, 'utf8')).toBe(before);
      const repaired = await f.app.inject({
        method: 'POST',
        url: f.url + '/reconcile',
        headers,
        payload: f.body(status.json().data.scopeDigest),
      });
      expect(repaired.statusCode).toBe(200);
      expect(repaired.json().data).toMatchObject({ state: 'retained', allowedActions: [] });
      const after = f.companyStore.snapshot();
      expect(after.dockerEmployeeContinuations).toBeUndefined();
      expect(after.dockerSharedPoolLineages).toBeUndefined();
      expect(after.dockerPoolObservations).toHaveLength(1);
      expect(after.dockerPoolObservations![0]).not.toHaveProperty('origin');
      expect(after.version).toBe(2);
      const normalized = { ...after, version: 1 as const };
      delete normalized.dockerPoolObservations;
      expect(normalized).toEqual(JSON.parse(before));
      const controller = f.physical.controllerWith(() =>
        f.store.retainedPoolConfigurationTasks('reverie-boxed-anchor-' + 'b'.repeat(32), helper, 'b'.repeat(64))
      );
      expect(await controller.observePool(f.physical.row())).not.toBeNull();
      const second = await f.app.inject({ method: 'GET', url: f.url + '/status', headers });
      expect(second.json().data.state).toBe('retained');
      f.effects();
      f.physical.logs.set(f.completed.containerId, '{}');
      expect((await f.app.inject({ method: 'GET', url: f.url + '/status', headers })).json().data.state).toBe('held');
      await expect(controller.observePool(f.physical.row())).rejects.toThrow();
      f.effects();
    }
  );
  it('current scoped recovery grant is required; title, parent hint and office permission do not substitute', async () => {
    const f = await fixture({ recover: false });
    for (const headers of [f.workerHeaders, { 'x-reverie-parent-session': actorSid }, {}]) {
      const response = await f.app.inject({ method: 'GET', url: f.url + '/status', headers });
      expect([401, 403]).toContain(response.statusCode);
    }
    expect(f.companyStore.snapshot().dockerPoolObservations).toBeUndefined();
    f.effects();
  });
  it.each(['grant', 'identity', 'runtime', 'target'] as const)(
    'revoked %s during native await refuses publication',
    async (change) => {
      const f = await fixture();
      const status = await f.service.status(f.eid, f.authority());
      let once = true;
      f.physical.beforeRun(async (args) => {
        if (!once || !args.includes('probe-pool')) return;
        once = false;
        if (change === 'grant')
          await f.companyStore.update((state) => {
            state.employees[0]!.permissions.recoverEmployees = false;
          });
        else if (change === 'identity') f.revokeIdentity();
        else if (change === 'runtime') f.revokeRuntime();
        else
          await f.companyStore.update((state) => {
            state.employees[1]!.sessionGeneration++;
          });
      });
      const response = await f.app.inject({
        method: 'POST',
        url: f.url + '/reconcile',
        headers: f.workerHeaders,
        payload: f.body(status.scopeDigest!),
      });
      expect([403, 409]).toContain(response.statusCode);
      expect(f.companyStore.snapshot().dockerPoolObservations).toBeUndefined();
      f.effects();
    }
  );
  it('pool metadata CAS refuses a competing genuine observation during native awaits', async () => {
    const f = await fixture(),
      status = await f.service.status(f.eid, f.authority());
    const receipt = await f.physical.controller.capturePoolObservation(policy.pool, () => {});
    const before = dockerPoolMetadataDigest(f.companyStore.snapshot());
    let once = true;
    f.physical.beforeRun(async (args) => {
      if (!once || !args.includes('probe-pool')) return;
      once = false;
      const result = await f.companyStore.publishDockerPoolObservation(receipt, before, () => {});
      expect(result.state).toBe('committed');
    });
    await expect(f.service.reconcile(f.eid, f.body(status.scopeDigest!), f.authority())).rejects.toMatchObject({
      code: 'DOCKER_POOL_CANONICAL_CHANGED',
    });
    expect(f.companyStore.snapshot().dockerPoolObservations).toHaveLength(1);
    f.effects();
  });
  it.each([
    'missing',
    'running',
    'created',
    'foreign',
    'foreign-box',
    'too-many',
    'wrong-policy',
    'wrong-image',
    'changed-epoch',
    'malformed-ack',
    'ambiguous',
    'duplicate-census',
    'unknown-io',
  ] as const)('%s native evidence remains held with no metadata or effects', async (mode) => {
    const f = await fixture(),
      id = f.completed.containerId;
    const container = f.physical.containers.get(id)!;
    if (mode === 'missing') f.physical.containers.delete(id);
    else if (mode === 'running' || mode === 'created') {
      const state = container.State as Record<string, unknown>;
      state.Status = mode;
      state.Running = mode === 'running';
    } else if (mode === 'foreign') f.physical.foreignMount();
    else if (mode === 'wrong-image') container.Image = 'sha256:' + 'f'.repeat(64);
    else if (mode === 'changed-epoch') f.physical.driftEpoch();
    else if (mode === 'malformed-ack') f.physical.logs.set(id, '{}');
    else if (mode === 'ambiguous') {
      const other = 'f'.repeat(64),
        raw = structuredClone(container);
      raw.Id = other;
      (raw.Config as { Labels: Record<string, string> }).Labels['reverie.box.resource.name'] =
        'reverie-boxed-pool-helper-' + 'f'.repeat(64);
      f.physical.containers.set(other, raw);
      f.physical.logs.set(other, f.physical.logs.get(id)!);
    } else if (mode === 'wrong-policy') {
      await f.companyStore.update((state) => {
        state.employees[1]!.dockerResourcePolicy!.pool.cpuWeight = 200;
      });
    } else if (mode === 'foreign-box') {
      (container.Config as { Labels: Record<string, string> }).Labels['reverie.box.resource.box'] = 'c'.repeat(64);
      const run = f.physical.command.run;
      f.physical.command.run = async (args, input) =>
        args.includes('label=reverie.box.resource.role=pool-helper') ? id + String.fromCharCode(10) : run(args, input);
    } else if (mode === 'too-many') {
      const run = f.physical.command.run;
      f.physical.command.run = async (args, input) =>
        args.includes('label=reverie.box.resource.role=pool-helper')
          ? Array.from({ length: 129 }, (_, index) => index.toString(16).padStart(64, '0')).join(
              String.fromCharCode(10)
            )
          : run(args, input);
    } else if (mode === 'duplicate-census') {
      const run = f.physical.command.run;
      f.physical.command.run = async (args, input) =>
        args.includes('label=reverie.box.resource.role=pool-helper')
          ? [id, id, ''].join(String.fromCharCode(10))
          : run(args, input);
    } else
      f.physical.beforeRun(() => {
        throw Error('Sensitive private transport failure');
      });
    const result = await f.service.status(f.eid, f.authority());
    expect(result).toMatchObject({ state: 'held', allowedActions: [] });
    expect(JSON.stringify(result)).not.toContain('Sensitive private');
    expect(f.companyStore.snapshot().dockerPoolObservations).toBeUndefined();
    f.effects();
  });
  it('strict request schema refuses caller policy, helper ID, foreign SID and stale preview', async () => {
    const f = await fixture(),
      status = await f.service.status(f.eid, f.authority());
    for (const payload of [
      { ...f.body(status.scopeDigest!), helperContainerId: 'f'.repeat(64) },
      { ...f.body(status.scopeDigest!), poolPolicy: { ...policy.pool, memoryMaxBytes: 1 } },
      { ...f.body(status.scopeDigest!), sessionId: actorSid },
      { ...f.body(status.scopeDigest!), expectedScopeDigest: '0'.repeat(64) },
    ]) {
      const response = await f.app.inject({
        method: 'POST',
        url: f.url + '/reconcile',
        headers: f.ownerHeaders,
        payload,
      });
      expect([400, 409]).toContain(response.statusCode);
    }
    expect(f.companyStore.snapshot().dockerPoolObservations).toBeUndefined();
    f.effects();
  });
  it('a forged receipt/private prototype cannot call publication authority or publish raw JSON', async () => {
    const f = await fixture();
    let calls = 0;
    const fake = Object.create(DockerPoolReconciliationReceipt.prototype, {
      claim: {
        value: () => {
          calls++;
        },
      },
    });
    expect(() =>
      f.companyStore.publishDockerPoolObservation(fake, dockerPoolMetadataDigest(f.companyStore.snapshot()), () => {
        calls++;
      })
    ).toThrow();
    expect(calls).toBe(0);
    await expect(
      f.companyStore.update((state) => {
        state.dockerPoolObservations = [];
      })
    ).rejects.toMatchObject({ code: 'DOCKER_POOL_CANONICAL_CHANGED' });
    f.effects();
  });
  it('lost canonical publication reply stays unconfirmed; fresh restart re-earns original native proof', async () => {
    const f = await fixture(),
      status = await f.service.status(f.eid, f.authority());
    const rename = fs.rename;
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (a, b) => {
      await rename(a, b);
      throw Error('Synthetic lost rename reply');
    });
    await expect(f.service.reconcile(f.eid, f.body(status.scopeDigest!), f.authority())).rejects.toMatchObject({
      code: 'DOCKER_POOL_PUBLICATION_UNCONFIRMED',
    });
    vi.restoreAllMocks();
    expect(f.companyStore.publicationUnconfirmed).toBe(true);
    expect((await f.service.status(f.eid, f.authority())).code).toBe('DOCKER_POOL_PUBLICATION_UNCONFIRMED');
    const restarted = new CompanyStore(f.companyFile);
    await restarted.init();
    const company = new CompanyService(restarted, f.deps),
      store = new CompanyDockerContinuationStore(company, () => undefined);
    const service = new DockerPoolReconciliation(company, store, f.physical.controller, () => {});
    const grant = company.recoveryAction(f.eid, undefined);
    expect(
      (
        await service.status(f.eid, {
          owner: undefined,
          require: () => grant.require(),
          requireOffice: () => {
            throw Error('unused');
          },
        })
      ).state
    ).toBe('retained');
    expect(f.companyStore.publicationUnconfirmed).toBe(true);
    f.effects();
  });
  it('a crash after native capture but before publication leaves no canonical proof to invent', async () => {
    const f = await fixture();
    await f.physical.controller.capturePoolObservation(policy.pool, () => {});
    const restarted = new CompanyStore(f.companyFile);
    await restarted.init();
    expect(restarted.snapshot().dockerPoolObservations).toBeUndefined();
    expect((await f.service.status(f.eid, f.authority())).state).toBe('reconciliation-required');
    f.effects();
  });
});
