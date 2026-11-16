/** Real controller, single canonical writer and authenticated API. Only native
 * Docker transport is controlled; no Engine, paid provider or personal data. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import {
  fixture as physicalFixture,
  helper,
  policy,
  deployment,
  workerId,
} from './helpers/docker-resource-physical.js';
import { CompanyStore } from '../src/company-store.js';
import { CompanyService, type CompanyServiceDeps } from '../src/company-service.js';
import { EmployeeSchema } from '../src/company-types.js';
import { CompanyDockerContinuationStore } from '../src/docker-employee-store.js';
import { DockerPoolReconciliation } from '../src/docker-pool-reconciliation.js';
import {
  DockerPoolReconciliationReceipt,
  DockerContainedResources,
} from '../src/docker-contained-resource-controller.js';
import { dockerResourceHelperConfiguration } from '../src/docker-resource-helper-inspection.js';
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

async function restoredPoolFixture(pin = true) {
  const physical = physicalFixture(),
    boxId = 'b'.repeat(64),
    restoreImage = 'sha256:' + '9'.repeat(64);
  await physical.controller.preparePool(physical.row(), physical.current);
  const old = physical.tasks.get('pool-helper')!;
  if (!('containerId' in old)) throw Error('Actual helper required');
  const oldRaw = physical.containers.get(old.containerId)!;
  const seen = JSON.parse(physical.logs.get(old.containerId)!) as Record<string, unknown>;
  const oldArgs = (oldRaw.Config as { Cmd: string[] }).Cmd;
  const args = ['restore-pool', ...oldArgs.slice(1), '--member', `${workerId}:200:20`];
  physical.tasks.delete('pool-helper');
  physical.containers.delete(old.containerId);
  physical.makeWorker();
  const id = '8'.repeat(64),
    name = 'reverie-boxed-pool-helper-' + '7'.repeat(64);
  const parent = (seen.parent as { path: string }).path;
  const config = dockerResourceHelperConfiguration(
    boxId,
    'pool-helper',
    name,
    args,
    { path: parent, target: '/run/reverie-box-pool' },
    restoreImage
  );
  const mounts = (config.HostConfig as { Binds: string[] }).Binds.map((value) => {
    const [Source, Destination, mode] = value.split(':');
    return { Type: 'bind', Source, Destination, RW: mode === 'rw' };
  });
  physical.containers.set(id, {
    Id: id,
    Name: '/' + name,
    Image: restoreImage,
    Config: structuredClone(config),
    HostConfig: structuredClone(config.HostConfig),
    Mounts: mounts,
    State: { Status: 'exited', Running: false, Paused: false, Restarting: false, Dead: false, Pid: 0, ExitCode: 0 },
  });
  const anchor = (seen.anchor as { id: string }).id;
  const member = (
    JSON.parse(await physical.command.run(['exec', anchor, '/bin/reverie-docker-resources', 'probe-worker'])) as {
      worker: unknown;
    }
  ).worker;
  physical.logs.set(
    id,
    JSON.stringify({ version: 1, purpose: 'reverie-boxed-restore-pool-ack-v1', observation: seen, members: [member] })
  );
  const command = {
    ...physical.command,
    run: async (args: readonly string[]) => {
      if (args[0] === 'image' && args[2] === restoreImage)
        return JSON.stringify([
          {
            Id: restoreImage,
            Config: {
              User: '0:0',
              Entrypoint: ['/bin/reverie-docker-resources'],
              Labels: { 'org.reverie.purpose': 'boxed-resource-helper-v1', 'org.reverie.resource.pool-restore': 'v1' },
            },
          },
        ]);
      return physical.command.run(args);
    },
  };
  const controller = new DockerContainedResources(command, physical.journal, {
    boxId,
    deployment,
    helperImageId: helper,
    poolRestoreHelperImageId: pin ? restoreImage : undefined,
    selectedWorkerContainerIds: () => [workerId],
    retainedPoolConfigurationTasks: () => [],
  });
  const before = { creates: [...physical.creates], starts: [...physical.starts] };
  return { physical, controller, id, restoreImage, before, config, seen };
}

describe('separately pinned populated-pool restore ACK adoption', () => {
  it('publishes and reloads strict v2 correlation while the actual anchor retains its old image', async () => {
    const f = await restoredPoolFixture();
    const receipt = await f.controller.capturePoolObservation(policy.pool, f.physical.current);
    const directory = await fs.mkdtemp(join(tmpdir(), 'restore-pool-observation-'));
    cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
    const store = new CompanyStore(join(directory, 'company.json'));
    await store.init();
    const result = await store.publishDockerPoolObservation(
      receipt,
      dockerPoolMetadataDigest(store.snapshot()),
      f.physical.current
    );
    expect(result.state).toBe('committed');
    const restarted = new CompanyStore(join(directory, 'company.json'));
    await restarted.init();
    expect(restarted.snapshot().dockerPoolObservations?.[0]).toMatchObject({
      version: 2,
      helperImageId: helper,
      poolRestoreHelperImageId: f.restoreImage,
      anchorTask: { imageId: helper },
      configuration: { imageId: f.restoreImage, containerId: f.id },
    });
    expect({ creates: f.physical.creates, starts: f.physical.starts }).toEqual(f.before);
  });
  it.each([
    'missing-pin',
    'missing-member',
    'missing-member-argument',
    'foreign-member-argument',
    'foreign-member',
    'stale-birth',
    'wrong-purpose',
    'wrong-command',
    'wrong-image',
    'running',
    'extra-mount',
    'epoch-drift',
  ] as const)('refuses %s without any native effects', async (mode) => {
    const f = await restoredPoolFixture(mode !== 'missing-pin');
    const raw = f.physical.containers.get(f.id)!,
      config = raw.Config as { Cmd: string[] },
      ack = JSON.parse(f.physical.logs.get(f.id)!) as {
        purpose: string;
        members: Array<{ id: string; startTicks: string }>;
      };
    if (mode === 'missing-member') ack.members = [];
    if (mode === 'missing-member-argument') config.Cmd.splice(-2);
    if (mode === 'foreign-member-argument') config.Cmd[config.Cmd.length - 1] = `${'6'.repeat(64)}:200:20`;
    if (mode === 'foreign-member') ack.members[0]!.id = '6'.repeat(64);
    if (mode === 'stale-birth') ack.members[0]!.startTicks = '21';
    if (mode === 'wrong-purpose') ack.purpose = 'reverie-boxed-resource-observation-v1';
    if (mode === 'wrong-command') config.Cmd[0] = 'configure-pool';
    if (mode === 'wrong-image') raw.Image = helper;
    if (mode === 'running')
      raw.State = {
        Status: 'running',
        Running: true,
        Paused: false,
        Restarting: false,
        Dead: false,
        Pid: 400,
        ExitCode: 0,
      };
    if (mode === 'extra-mount')
      (raw.Mounts as unknown[]).push({ Type: 'bind', Source: '/foreign', Destination: '/foreign', RW: true });
    if (mode === 'epoch-drift') f.physical.driftEpoch();
    f.physical.logs.set(f.id, JSON.stringify(ack));
    await expect(f.controller.capturePoolObservation(policy.pool, f.physical.current)).rejects.toThrow();
    expect({ creates: f.physical.creates, starts: f.physical.starts }).toEqual(f.before);
  });
  it('holds the original read when authority is revoked across a native observation await', async () => {
    const f = await restoredPoolFixture();
    let revoked = false;
    f.physical.beforeRun((args) => {
      if (!revoked && args[0] === 'container' && args[1] === 'logs' && args[2] === f.id) {
        revoked = true;
        f.physical.revoke();
      }
    });
    await expect(f.controller.capturePoolObservation(policy.pool, f.physical.current)).rejects.toThrow('revoked');
    expect({ creates: f.physical.creates, starts: f.physical.starts }).toEqual(f.before);
  });
  it('a lost v2 publication reply requires fresh original native inspection after reload and never reissues the restore', async () => {
    const f = await restoredPoolFixture(),
      directory = await fs.mkdtemp(join(tmpdir(), 'restore-pool-lost-ack-'));
    cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
    const file = join(directory, 'company.json'),
      store = new CompanyStore(file);
    await store.init();
    const receipt = await f.controller.capturePoolObservation(policy.pool, f.physical.current),
      rename = fs.rename;
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (a, b) => {
      await rename(a, b);
      throw Error('Lost canonical rename reply');
    });
    expect(
      (
        await store.publishDockerPoolObservation(
          receipt,
          dockerPoolMetadataDigest(store.snapshot()),
          f.physical.current
        )
      ).state
    ).toBe('unconfirmed');
    vi.restoreAllMocks();
    const restarted = new CompanyStore(file);
    await restarted.init();
    expect(restarted.snapshot().dockerPoolObservations?.[0]?.configuration.containerId).toBe(f.id);
    await expect(f.controller.capturePoolObservation(policy.pool, f.physical.current)).resolves.toBeInstanceOf(
      DockerPoolReconciliationReceipt
    );
    f.physical.logs.set(f.id, '{}');
    await expect(f.controller.capturePoolObservation(policy.pool, f.physical.current)).rejects.toThrow();
    expect({ creates: f.physical.creates, starts: f.physical.starts }).toEqual(f.before);
  });
});

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
  const resources = physical.controllerWith(() =>
    store.retainedPoolConfigurationTasks('reverie-boxed-anchor-' + 'b'.repeat(32), helper, 'b'.repeat(64))
  );
  const service = new DockerPoolReconciliation(company, store, resources, runtimeCurrent);
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
  it('accepts a bounded consistent set of original closed ACKs without inventing causality or stranding retained proof', async () => {
    const f = await fixture(),
      id = f.completed.containerId;
    const add = (other: string) => {
      const raw = structuredClone(f.physical.containers.get(id)!);
      raw.Id = other;
      (raw.Config as { Labels: Record<string, string> }).Labels['reverie.box.resource.name'] =
        'reverie-boxed-pool-helper-' + other;
      f.physical.containers.set(other, raw);
      f.physical.logs.set(other, f.physical.logs.get(id)!);
    };
    add('f'.repeat(64));
    const status = await f.app.inject({ method: 'GET', url: f.url + '/status', headers: f.ownerHeaders });
    expect(status.json().data.state).toBe('reconciliation-required');
    const result = await f.app.inject({
      method: 'POST',
      url: f.url + '/reconcile',
      headers: f.ownerHeaders,
      payload: f.body(status.json().data.scopeDigest),
    });
    expect(result.statusCode).toBe(200);
    expect(result.json().data.state).toBe('retained');
    const record = f.companyStore.snapshot().dockerPoolObservations![0]!;
    expect(record.configuration.containerId).toBe(id);
    expect(record).not.toHaveProperty('origin');
    // A later matching closed helper must not cause proof churn just because
    // its full ID sorts first. Preference is DATA only: every ACK is re-earned.
    add('0'.repeat(64));
    const before = await fs.readFile(f.companyFile, 'utf8');
    const again = await f.app.inject({ method: 'GET', url: f.url + '/status', headers: f.ownerHeaders });
    expect(again.json().data.state).toBe('retained');
    expect(await fs.readFile(f.companyFile, 'utf8')).toBe(before);
    expect(f.companyStore.snapshot().dockerPoolObservations).toHaveLength(1);
    f.effects();
  });

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
    'mixed-ack',
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
    else if (mode === 'mixed-ack') {
      const other = 'f'.repeat(64),
        raw = structuredClone(container);
      raw.Id = other;
      (raw.Config as { Labels: Record<string, string> }).Labels['reverie.box.resource.name'] =
        'reverie-boxed-pool-helper-' + 'f'.repeat(64);
      f.physical.containers.set(other, raw);
      const wrong = JSON.parse(f.physical.logs.get(id)!);
      wrong.resources.cpuWeight = '200';
      f.physical.logs.set(other, JSON.stringify(wrong));
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
  it('a valid POST preview with an unknown native reply is a typed backend hold, not invalid caller input', async () => {
    const f = await fixture(),
      status = await f.service.status(f.eid, f.authority());
    const before = await fs.readFile(f.companyFile, 'utf8');
    f.physical.logs.set(f.completed.containerId, '{}');
    const response = await f.app.inject({
      method: 'POST',
      url: f.url + '/reconcile',
      headers: f.ownerHeaders,
      payload: f.body(status.scopeDigest!),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('DOCKER_POOL_OBSERVATION_UNCONFIRMED');
    expect(await fs.readFile(f.companyFile, 'utf8')).toBe(before);
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
