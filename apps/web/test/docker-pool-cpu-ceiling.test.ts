/** Owner-approved employee group CPU ceiling: pure data, the private approval
 * journal, the real resource controller's pool matching, and the authenticated
 * API. Only native Docker transport is controlled; no Engine or kernel is used. */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { fixture as physicalFixture, helper, policy, deployment } from './helpers/docker-resource-physical.js';
import { CompanyStore } from '../src/company-store.js';
import { CompanyService, type CompanyServiceDeps } from '../src/company-service.js';
import { EmployeeSchema } from '../src/company-types.js';
import {
  DockerContainedResources,
  dockerOtherResourceLimitsMatch,
} from '../src/docker-contained-resource-controller.js';
import type { DockerEngineCommand } from '../src/docker-engine-command.js';
import {
  DockerPoolCpuCeilingApproval,
  dockerPoolCpuCeilingDefault,
  dockerPoolCpuCeilingObserved,
  dockerPoolCpuCeilingState,
  dockerPoolCpuMax,
} from '../src/docker-pool-cpu-ceiling-data.js';
import { DockerPoolCpuCeilingStore } from '../src/docker-pool-cpu-ceiling-store.js';
import { DockerPoolCpuCeiling } from '../src/docker-pool-cpu-ceiling.js';
import { registerDockerPoolCpuCeilingRoutes } from '../src/web/routes/docker-pool-cpu-ceiling-routes.js';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { ownerVerifier } from '../src/owner-auth/marks.js';
import { registerOwnerPolicy } from '../src/owner-auth/policy.js';
import { registerAuthMiddleware } from '../src/web/middleware/auth.js';
import { ownerFor } from '../src/web/route-helpers.js';
import type { SessionPort } from '../src/web/ports/session-port.js';

const boxId = 'b'.repeat(64),
  first = '11111111-1111-4111-8111-111111111111',
  second = '22222222-2222-4222-8222-222222222222',
  third = '33333333-3333-4333-8333-333333333333',
  twentyFour = '2400000 100000',
  unlimited = 'max 100000';
const approval = (revision: string, cpuCores: number | null, poolCpus = 32) =>
  DockerPoolCpuCeilingApproval.parse({
    version: 1,
    purpose: 'reverie-boxed-pool-cpu-ceiling-v1',
    revision,
    owner: null,
    boxId,
    scope: 'all-employees',
    cpuCores,
    poolCpus,
  });
const current = () => {};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
async function directory(): Promise<string> {
  const path = await fs.mkdtemp(join(tmpdir(), 'pool-cpu-ceiling-'));
  cleanups.push(() => fs.rm(path, { recursive: true, force: true }));
  return path;
}

describe('group CPU ceiling data', () => {
  it('suggests three quarters of the pool and always leaves four CPUs free', () => {
    expect(
      [1, 2, 4, 5, 6, 8, 12, 16, 24, 32, 64, 128].map((cpus) => [cpus, dockerPoolCpuCeilingDefault(cpus)])
    ).toEqual([
      [1, 1],
      [2, 1],
      [4, 1],
      [5, 1],
      [6, 2],
      [8, 4],
      [12, 8],
      [16, 12],
      [24, 18],
      [32, 24],
      [64, 48],
      [128, 96],
    ]);
    for (const cpus of [0, -1, 1.5, 4097]) expect(() => dockerPoolCpuCeilingDefault(cpus)).toThrow();
  });
  it('maps whole CPUs to exactly one kernel value and back', () => {
    expect(dockerPoolCpuMax(24)).toBe(twentyFour);
    expect(dockerPoolCpuMax(1)).toBe('100000 100000');
    expect(dockerPoolCpuMax(null)).toBe(unlimited);
    for (const cores of [0, 1.5, -24, 4097]) expect(() => dockerPoolCpuMax(cores)).toThrow();
    expect(dockerPoolCpuCeilingObserved(twentyFour)).toEqual({ cpuMax: twentyFour, cpuCores: 24 });
    expect(dockerPoolCpuCeilingObserved(unlimited)).toEqual({ cpuMax: unlimited, cpuCores: null });
    expect(dockerPoolCpuCeilingObserved('150000 100000').cpuCores).toBe(1.5);
    for (const raw of ['', 'max', '0 100000', '24', 'max 0', ' 2400000 100000', '2400000 100000\n'])
      expect(() => dockerPoolCpuCeilingObserved(raw)).toThrow();
  });
  it('refuses an approval above its own pool or with caller-selected fields', () => {
    expect(() => approval(first, 33)).toThrow();
    expect(() => approval(first, 0)).toThrow();
    expect(approval(first, 32).cpuCores).toBe(32);
    expect(approval(first, null).cpuCores).toBeNull();
    for (const field of ['cpuMax', 'cgroupPath', 'command', 'applied'])
      expect(() =>
        DockerPoolCpuCeilingApproval.parse({ ...approval(first, 24), [field]: 'caller-selected' })
      ).toThrow();
  });
  it('classifies a fresh observation without ever inventing enforcement', () => {
    const approved = approval(second, 24);
    expect(dockerPoolCpuCeilingState(undefined, [], undefined)).toBe('unobserved');
    expect(dockerPoolCpuCeilingState(approved, [twentyFour], undefined)).toBe('unobserved');
    expect(dockerPoolCpuCeilingState(undefined, [], unlimited)).toBe('unapproved');
    expect(dockerPoolCpuCeilingState(undefined, [], twentyFour)).toBe('drifted');
    expect(dockerPoolCpuCeilingState(approved, [twentyFour], twentyFour)).toBe('applied');
    expect(dockerPoolCpuCeilingState(approved, [twentyFour], unlimited)).toBe('pending');
    expect(dockerPoolCpuCeilingState(approved, ['1600000 100000', twentyFour], '1600000 100000')).toBe('pending');
    expect(dockerPoolCpuCeilingState(approved, [twentyFour], '800000 100000')).toBe('drifted');
    // The owner removed the ceiling; the kernel still shows the earlier approved one.
    expect(dockerPoolCpuCeilingState(approval(third, null), [twentyFour], twentyFour)).toBe('pending');
    expect(dockerPoolCpuCeilingState(approval(third, null), [twentyFour], unlimited)).toBe('applied');
  });
});

describe('group CPU ceiling approval journal', () => {
  it('appends only the decision the owner saw and repeats an identical request once', async () => {
    const file = join(await directory(), 'ceiling.jsonl'),
      store = new DockerPoolCpuCeilingStore(file, boxId);
    expect(store.approved()).toBeUndefined();
    expect(store.acceptedCpuMax()).toEqual([]);
    await expect(store.approve(approval(first, 24), second, current)).rejects.toThrow(
      'DOCKER_POOL_CPU_CEILING_CHANGED'
    );
    expect(await store.approve(approval(first, 24), null, current)).toEqual(approval(first, 24));
    expect(await store.approve(approval(first, 24), null, current)).toEqual(approval(first, 24));
    expect((await fs.readFile(file, 'utf8')).trim().split('\n')).toHaveLength(1);
    expect(((await fs.stat(file)).mode & 0o777).toString(8)).toBe('600');
    // A stale view, a reused revision and a changed value under one revision all refuse.
    await expect(store.approve(approval(second, 16), null, current)).rejects.toThrow('DOCKER_POOL_CPU_CEILING_CHANGED');
    await expect(store.approve(approval(first, 16), first, current)).rejects.toThrow('DOCKER_POOL_CPU_CEILING_CHANGED');
    expect(await store.approve(approval(second, 16), first, current)).toEqual(approval(second, 16));
    expect(new DockerPoolCpuCeilingStore(file, boxId).approved()).toEqual(approval(second, 16));
    expect(store.acceptedCpuMax()).toEqual([twentyFour, '1600000 100000']);
    expect(await store.approve(approval(third, null), second, current)).toEqual(approval(third, null));
    expect(store.approved()?.cpuCores).toBeNull();
    // Removing the ceiling approves no new quota; the earlier ones stay explainable.
    expect(store.acceptedCpuMax()).toEqual([twentyFour, '1600000 100000']);
  });
  it('refuses revoked authority before writing and another box entirely', async () => {
    const file = join(await directory(), 'ceiling.jsonl'),
      store = new DockerPoolCpuCeilingStore(file, boxId);
    await expect(
      store.approve(approval(first, 24), null, () => {
        throw Error('revoked');
      })
    ).rejects.toThrow('revoked');
    await expect(fs.stat(file)).rejects.toThrow();
    await expect(store.approve({ ...approval(first, 24), boxId: 'c'.repeat(64) }, null, current)).rejects.toThrow(
      'DOCKER_POOL_CPU_CEILING_CHANGED'
    );
    await store.approve(approval(first, 24), null, current);
    const other = new DockerPoolCpuCeilingStore(file, 'c'.repeat(64));
    expect(other.approved()).toBeUndefined();
    expect(other.acceptedCpuMax()).toEqual([]);
    expect(() => new DockerPoolCpuCeilingStore(file, 'not-a-box')).toThrow();
  });
  it('approves nothing from a journal that is shared, truncated or malformed', async () => {
    const root = await directory();
    for (const [name, body, mode] of [
      ['shared.jsonl', JSON.stringify(approval(first, 24)) + '\n', 0o644],
      ['truncated.jsonl', JSON.stringify(approval(first, 24)), 0o600],
      ['malformed.jsonl', '{"cpuCores":24}\n', 0o600],
    ] as const) {
      const file = join(root, name);
      await fs.writeFile(file, body, { mode });
      await fs.chmod(file, mode);
      const store = new DockerPoolCpuCeilingStore(file, boxId);
      expect(() => store.approved(), name).toThrow();
      expect(store.acceptedCpuMax(), name).toEqual([]);
      await expect(store.approve(approval(second, 16), null, current), name).rejects.toThrow();
      expect(await fs.readFile(file, 'utf8'), name).toBe(body);
    }
    const link = join(root, 'link.jsonl');
    await fs.symlink(join(root, 'shared.jsonl'), link);
    expect(new DockerPoolCpuCeilingStore(link, boxId).acceptedCpuMax()).toEqual([]);
  });
  it('remembers only the eight most recent approvals as explainable kernel values', async () => {
    const file = join(await directory(), 'ceiling.jsonl'),
      store = new DockerPoolCpuCeilingStore(file, boxId);
    let previous: string | null = null;
    for (let cores = 1; cores <= 10; cores++) {
      const revision = `aaaaaaaa-aaaa-4aaa-8aaa-${String(cores).padStart(12, '0')}`;
      await store.approve(approval(revision, cores), previous, current);
      previous = revision;
    }
    expect(store.acceptedCpuMax()).toEqual([3, 4, 5, 6, 7, 8, 9, 10].map((cores) => dockerPoolCpuMax(cores)));
  });
});

/** The real controller over the shared physical port, with the kernel's
 * cpu.max for the pool and for the worker leaf under the test's control. */
async function controllerFixture() {
  const physical = physicalFixture(boxId);
  await physical.controller.preparePool(physical.row(), physical.current);
  await physical.setPool();
  physical.makeWorker();
  await physical.controller.configure(physical.row(), physical.current);
  let pool = unlimited,
    leaf = unlimited,
    approved: string[] = [];
  const probes: string[][] = [];
  const command: DockerEngineCommand = {
    ...physical.command,
    run: async (args) => {
      const output = await physical.command.run(args);
      if (args[0] !== 'exec' || args[2] !== '/bin/reverie-docker-resources') return output;
      probes.push([...args]);
      const seen = JSON.parse(output) as { resources: { cpuMax: string } };
      seen.resources.cpuMax = args.includes('probe-worker') ? leaf : pool;
      return JSON.stringify(seen);
    },
  };
  const controller = new DockerContainedResources(command, physical.journal, {
    boxId,
    deployment,
    helperImageId: helper,
    selectedWorkerContainerIds: () => [],
    retainedPoolConfigurationTasks: () => [],
    approvedPoolCpuMax: () => approved,
  });
  const effects = () => ({
    creates: [...physical.creates],
    starts: [...physical.starts],
    tasks: structuredClone([...physical.tasks]),
  });
  return {
    physical,
    controller,
    probes,
    effects,
    kernel: (next: { pool?: string; leaf?: string }) => {
      pool = next.pool ?? pool;
      leaf = next.leaf ?? leaf;
    },
    approve: (values: string[]) => {
      approved = values;
    },
  };
}

describe('pool observations under an owner-approved group ceiling', () => {
  it('keeps the approved pool acknowledged and issues nothing when the kernel shows the approved ceiling', async () => {
    const f = await controllerFixture(),
      before = f.effects(),
      original = await f.controller.observePool(f.physical.row());
    expect(original).not.toBeNull();
    f.kernel({ pool: twentyFour });
    f.approve([twentyFour]);
    const capped = await f.controller.observePool(f.physical.row());
    expect(capped).toMatchObject({ containerId: original!.containerId, policyDigest: original!.policyDigest });
    // The physical digest is a fact about the kernel, so it follows the ceiling.
    expect(capped!.physicalDigest).not.toBe(original!.physicalDigest);
    await f.controller.preparePool(f.physical.row(), f.physical.current);
    const receipt = await f.controller.capturePoolObservation(policy.pool, f.physical.current);
    expect(receipt.snapshot(f.physical.current).poolPolicy).toEqual(policy.pool);
    expect(f.effects()).toEqual(before);
  });
  it('still refuses a pool quota the owner never approved', async () => {
    const f = await controllerFixture(),
      before = f.effects();
    f.kernel({ pool: twentyFour });
    for (const approved of [[], ['1600000 100000'], ['max 100000'], ['2400000  100000'], ['2400000 100000\n']]) {
      f.approve(approved);
      expect(await f.controller.observePool(f.physical.row()), JSON.stringify(approved)).toBeNull();
      await expect(f.controller.capturePoolObservation(policy.pool, f.physical.current)).rejects.toThrow(
        'DOCKER_POOL_POLICY_CHANGED'
      );
    }
    expect(f.effects()).toEqual(before);
  });
  it('never widens a worker leaf: an approved pool value on a leaf is a changed limit', async () => {
    const f = await controllerFixture();
    f.approve([twentyFour]);
    await expect(f.controller.observeMemoryHigh(f.physical.row(), f.physical.current)).resolves.toMatchObject({
      actualLimits: { cpuQuota: 'unlimited' },
    });
    f.kernel({ leaf: twentyFour });
    await expect(f.controller.observeMemoryHigh(f.physical.row(), f.physical.current)).rejects.toThrow(
      'OTHER_LIMIT_CHANGED'
    );
    const leaf = {
      memoryMax: String(policy.memoryMaxBytes),
      memoryHigh: 'max',
      swapMax: '0',
      pidsMax: '512',
      cpuWeight: '100',
      cpuMax: twentyFour,
      cpusetCpus: '0-1',
      cpusetCpusEffective: '0-1',
      cpusetMemsEffective: '0',
    };
    expect(dockerOtherResourceLimitsMatch(leaf, policy)).toBe(false);
    expect(dockerOtherResourceLimitsMatch({ ...leaf, cpuMax: unlimited }, policy)).toBe(true);
    expect(dockerOtherResourceLimitsMatch(leaf, policy, [twentyFour])).toBe(true);
  });
  it('reports the effective ceiling from one fresh read-only probe of the fixed anchor', async () => {
    const f = await controllerFixture(),
      before = f.effects();
    expect(await f.controller.observePoolCpu(f.physical.current)).toEqual({ cpuMax: unlimited, cpus: 2 });
    f.kernel({ pool: twentyFour });
    f.probes.length = 0;
    // Reporting needs no approval: an unapproved value is still what the kernel enforces.
    expect(await f.controller.observePoolCpu(f.physical.current)).toEqual({ cpuMax: twentyFour, cpus: 2 });
    expect(f.probes).toHaveLength(1);
    expect(f.probes[0]).toContain('probe-pool');
    expect(f.effects()).toEqual(before);
    f.physical.revoke();
    await expect(f.controller.observePoolCpu(f.physical.current)).rejects.toThrow('revoked');
    const anchor = f.physical.tasks.get('anchor');
    if (!anchor || !('containerId' in anchor)) throw Error('Actual fixture anchor required');
    f.physical.containers.delete(anchor.containerId);
    await expect(f.controller.observePoolCpu(() => {})).rejects.toThrow('DOCKER_POOL_ANCHOR_UNCONFIRMED');
  });
});

const eid = '44444444-4444-4444-8444-444444444444',
  sid = '55555555-5555-4555-8555-555555555555';
const wide = { ...policy, allowedCpus: [0, 1], pool: { ...policy.pool, allowedCpus: [...Array(32).keys()] } };
async function apiFixture(options: { policies?: unknown[] } = {}) {
  const root = await directory(),
    companyStore = new CompanyStore(join(root, 'company.json'));
  await companyStore.init();
  const sessions = new Map<string, { id: string; name: string; owner: undefined }>();
  const company = new CompanyService(companyStore, {
    getSession: (id: string) => sessions.get(id),
    chatrooms: { rooms: () => [] },
    research: {},
  } as unknown as CompanyServiceDeps);
  const policies = options.policies ?? [wide];
  await companyStore.update((state) => {
    state.employees = policies.map((dockerResourcePolicy, index) =>
      EmployeeSchema.parse({
        id: eid.slice(0, -1) + index,
        sessionId: sid.slice(0, -1) + index,
        sessionGeneration: 1,
        name: 'Employee ' + index,
        icon: 'E',
        position: 'Employee',
        expertise: ['synthetic'],
        createdAt: 1,
        onVacation: false,
        desiredRunning: true,
        ...(dockerResourcePolicy ? { dockerResourcePolicy } : {}),
      })
    );
  });
  const store = new DockerPoolCpuCeilingStore(join(root, 'ceiling.jsonl'), boxId);
  let kernel: string | Error = unlimited,
    runtime = true,
    observations = 0;
  const service = new DockerPoolCpuCeiling(
    company,
    store,
    {
      observePoolCpu: async (admitted) => {
        admitted();
        observations++;
        if (kernel instanceof Error) throw kernel;
        return { cpuMax: kernel, cpus: 32 };
      },
    },
    boxId,
    () => {
      if (!runtime) throw Error('Synthetic runtime revoked');
    }
  );
  const ownerAuth = new OwnerAuthService({
    store: new OwnerAuthStore(join(root, 'owner.json')),
    auditFile: join(root, 'audit.jsonl'),
    setupEnabled: true,
  });
  const ownerToken = await ownerAuth.setup(
    'synthetic-owner',
    'Synthetic-only-Ocean42!',
    'Synthetic-only-Ocean42!',
    '127.0.0.1'
  );
  const app = Fastify();
  await app.register(cookie);
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
  registerDockerPoolCpuCeilingRoutes(app, service, {
    verifiedOwner: ownerVerifier({ service: ownerAuth, ctx }),
    owner: ownerFor,
  });
  await app.ready();
  cleanups.push(async () => {
    await app.close();
    for (const timer of Object.values(authState)) timer?.dispose();
  });
  const url = '/api/company/docker-resources/cpu-ceiling',
    ownerHeaders = { cookie: 'reverie_owner=' + ownerToken, origin: 'http://localhost', host: 'localhost' };
  return {
    app,
    url,
    ownerHeaders,
    store,
    service,
    file: join(root, 'ceiling.jsonl'),
    observations: () => observations,
    setKernel: (value: string | Error) => {
      kernel = value;
    },
    revokeRuntime: () => {
      runtime = false;
    },
    get: (headers: Record<string, string> = ownerHeaders) => app.inject({ method: 'GET', url, headers }),
    put: (payload: unknown, headers: Record<string, string> = ownerHeaders) =>
      app.inject({ method: 'PUT', url, headers, payload: payload as object }),
  };
}
const request = (revision: string, expectedRevision: string | null, cpuCores: number | null) => ({
  revision,
  expectedRevision,
  scope: 'all-employees',
  cpuCores,
});

describe('owner API for the employee group CPU ceiling', () => {
  it('proposes 24 of 32 CPUs, records the owner approval and reports it pending until the kernel shows it', async () => {
    const f = await apiFixture();
    const initial = (await f.get()).json();
    expect(initial).toEqual({
      success: true,
      data: {
        boxId,
        scope: 'all-employees',
        approved: null,
        proposed: { cpuCores: 24, poolCpus: 32 },
        effective: { cpuMax: unlimited, cpuCores: null, poolCpus: 32 },
        state: 'unapproved',
        enforcement: 'observed',
        allowedActions: ['approve'],
      },
    });
    // Reading the proposal approves nothing.
    await expect(fs.stat(f.file)).rejects.toThrow();
    const saved = await f.put(request(first, null, 24));
    expect(saved.statusCode).toBe(200);
    expect(saved.json().data).toEqual({
      approved: { revision: first, cpuCores: 24, cpuMax: twentyFour },
      state: 'approval-saved',
      enforcement: 'not-observed',
    });
    expect(f.store.approved()).toMatchObject({ revision: first, cpuCores: 24, poolCpus: 32, owner: null });
    expect((await f.get()).json().data).toMatchObject({
      approved: { revision: first, cpuCores: 24, cpuMax: twentyFour },
      effective: { cpuMax: unlimited, cpuCores: null },
      state: 'pending',
    });
    f.setKernel(twentyFour);
    expect((await f.get()).json().data).toMatchObject({
      effective: { cpuMax: twentyFour, cpuCores: 24 },
      state: 'applied',
      enforcement: 'observed',
    });
    // A later owner decision is pending while the kernel still holds the earlier approved value.
    expect((await f.put(request(second, first, 20))).statusCode).toBe(200);
    expect((await f.get()).json().data).toMatchObject({ approved: { cpuCores: 20 }, state: 'pending' });
    f.setKernel('800000 100000');
    expect((await f.get()).json().data).toMatchObject({ effective: { cpuCores: 8 }, state: 'drifted' });
    expect((await f.put(request(third, second, null))).json().data.approved).toEqual({
      revision: third,
      cpuCores: null,
      cpuMax: unlimited,
    });
  });
  it('reports an unobservable pool as unknown and never as applied', async () => {
    const f = await apiFixture();
    await f.put(request(first, null, 24));
    f.setKernel(Error('BOXED_RESOURCE_FOREIGN_CHILD'));
    expect((await f.get()).json().data).toMatchObject({
      approved: { cpuCores: 24 },
      effective: null,
      state: 'unobserved',
      enforcement: 'not-observed',
      code: 'DOCKER_POOL_CPU_OBSERVATION_UNCONFIRMED',
    });
  });
  it('accepts only a signed-in same-origin human owner', async () => {
    const f = await apiFixture(),
      { cookie: ownerCookie, ...anonymous } = f.ownerHeaders;
    expect((await f.get(anonymous)).statusCode).toBeOneOf([401, 403]);
    expect((await f.put(request(first, null, 24), anonymous)).statusCode).toBeOneOf([401, 403]);
    for (const header of ['x-reverie-parent-session', 'x-reverie-worker-identity', 'x-reverie-service-token']) {
      const headers = { ...f.ownerHeaders, [header]: sid };
      expect((await f.get(headers)).statusCode, header).toBeOneOf([401, 403]);
      expect((await f.put(request(first, null, 24), headers)).statusCode, header).toBeOneOf([401, 403]);
    }
    const foreign = await f.put(request(first, null, 24), {
      cookie: ownerCookie,
      origin: 'http://elsewhere.example',
      host: 'localhost',
    });
    expect(foreign.statusCode).toBe(403);
    expect(f.observations()).toBe(0);
    await expect(fs.stat(f.file)).rejects.toThrow();
    f.revokeRuntime();
    expect((await f.put(request(first, null, 24))).statusCode).toBe(409);
    await expect(fs.stat(f.file)).rejects.toThrow();
  });
  it('refuses malformed, stale, oversized and repeated-with-a-difference approvals without writing', async () => {
    const f = await apiFixture();
    for (const body of [
      {},
      { ...request(first, null, 24), cpuMax: twentyFour },
      { ...request(first, null, 24), scope: 'one-employee' },
      request(first, null, 0),
      request(first, null, 24.5),
      request('not-a-revision', null, 24),
      { revision: first, scope: 'all-employees', cpuCores: 24 },
    ]) {
      const response = await f.put(body);
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
      expect(response.json().error.code).toBe('DOCKER_POOL_CPU_CEILING_INVALID_INPUT');
    }
    const above = await f.put(request(first, null, 33));
    expect(above.statusCode).toBe(409);
    expect(above.json().error.code).toBe('DOCKER_POOL_CPU_CEILING_EXCEEDS_POOL');
    await expect(fs.stat(f.file)).rejects.toThrow();
    expect((await f.put(request(first, null, 24))).statusCode).toBe(200);
    expect((await f.put(request(first, null, 24))).statusCode).toBe(200);
    for (const stale of [request(second, null, 16), request(first, first, 16), request(second, third, 16)]) {
      const response = await f.put(stale);
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('DOCKER_POOL_CPU_CEILING_CHANGED');
    }
    expect((await fs.readFile(f.file, 'utf8')).trim().split('\n')).toHaveLength(1);
  });
  it('offers no approval before a pool policy exists or while employees disagree about the pool', async () => {
    const none = await apiFixture({ policies: [undefined] });
    expect((await none.get()).json().data).toMatchObject({ proposed: null, allowedActions: [], state: 'unapproved' });
    const refused = await none.put(request(first, null, 24));
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('DOCKER_POOL_CPU_CEILING_POOL_POLICY_REQUIRED');
    const narrow = { ...wide, pool: { ...wide.pool, allowedCpus: [0, 1, 2, 3] } };
    const mixed = await apiFixture({ policies: [wide, narrow] });
    expect((await mixed.get()).json().data).toMatchObject({
      proposed: null,
      allowedActions: [],
      code: 'DOCKER_POOL_CPU_CEILING_POOL_POLICY_CHANGED',
    });
    expect((await mixed.put(request(first, null, 2))).json().error.code).toBe(
      'DOCKER_POOL_CPU_CEILING_POOL_POLICY_CHANGED'
    );
    await expect(fs.stat(mixed.file)).rejects.toThrow();
    // Two employees sharing one approved pool are one pool.
    const shared = await apiFixture({ policies: [wide, { ...wide, memoryHighBytes: 8 * 1024 ** 3 }, undefined] });
    expect((await shared.get()).json().data.proposed).toEqual({ cpuCores: 24, poolCpus: 32 });
  });
});
