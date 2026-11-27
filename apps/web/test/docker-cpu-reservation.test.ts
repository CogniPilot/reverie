/** CPUs kept free of every employee laptop: pure topology and policy data, the
 * owner decision journal, the default-policy hook on the real continuation
 * store, plan-move limits, and the authenticated owner API. Synthetic only. */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { policy } from './helpers/docker-resource-physical.js';
import { CompanyStore } from '../src/company-store.js';
import { CompanyService, type CompanyServiceDeps } from '../src/company-service.js';
import { EmployeeSchema, type CompanyState } from '../src/company-types.js';
import { CompanyDockerContinuationStore } from '../src/docker-employee-store.js';
import { DockerEmployeeResourcePolicy } from '../src/docker-employee-continuation-data.js';
import {
  dockerCpuReservationDefault,
  dockerCpuReservationRefusal,
  dockerCpuReservedPolicy,
  dockerReplacementKeepsLimits,
  formatKernelCpuList,
  parseKernelCpuList,
  type DockerCpuTopology,
} from '../src/docker-cpu-reservation-data.js';
import { DockerCpuReservation, readHostCpuTopology } from '../src/docker-cpu-reservation.js';
import { registerDockerCpuReservationRoutes } from '../src/web/routes/docker-cpu-reservation-routes.js';
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
  eid = '44444444-4444-4444-8444-444444444444',
  sid = '55555555-5555-4555-8555-555555555555';
const all = [...Array(32).keys()],
  reserved = all.filter((cpu) => cpu !== 0 && cpu !== 16);
/** A 16-core, 32-thread host whose first core is CPUs 0 and 16. */
const host: DockerCpuTopology = { online: all, firstCore: [0, 16] };
const wide = DockerEmployeeResourcePolicy.parse({
  ...policy,
  allowedCpus: all,
  pool: { ...policy.pool, allowedCpus: all },
});
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
async function directory(): Promise<string> {
  const path = await fs.mkdtemp(join(tmpdir(), 'cpu-reservation-'));
  cleanups.push(() => fs.rm(path, { recursive: true, force: true }));
  return path;
}

describe('CPU reservation data', () => {
  it('reads kernel CPU lists exactly and writes them back compactly', () => {
    expect(parseKernelCpuList('0-15\n')).toEqual([...Array(16).keys()]);
    expect(parseKernelCpuList('0,16')).toEqual([0, 16]);
    expect(formatKernelCpuList(reserved)).toBe('1-15,17-31');
    expect(formatKernelCpuList(parseKernelCpuList('1-15,17-31'))).toBe('1-15,17-31');
    for (const bad of ['', '3-1', '1,1', '2,1', 'a', '0-4096', '01'])
      expect(() => parseKernelCpuList(bad), bad).toThrow('DOCKER_CPU_TOPOLOGY_UNKNOWN');
  });
  it('defaults to the first physical core, never every CPU', () => {
    expect(dockerCpuReservationDefault(host)).toEqual([0, 16]);
    expect(dockerCpuReservationDefault({ online: [0, 1, 2, 3], firstCore: [0] })).toEqual([0]);
    // A sibling that is offline is not reserved; a host that IS one core reserves nothing.
    expect(dockerCpuReservationDefault({ online: [0, 1, 2], firstCore: [0, 16] })).toEqual([0]);
    expect(dockerCpuReservationDefault({ online: [0, 1], firstCore: [0, 1] })).toEqual([]);
  });
  it('takes the reserved CPUs off a laptop and never touches the shared pool', () => {
    const next = dockerCpuReservedPolicy(wide, { reservedCpus: [0, 16], everReserved: [0, 16] });
    expect(next.allowedCpus).toEqual(reserved);
    expect(next.pool).toEqual(wide.pool);
    expect({ ...next, allowedCpus: wide.allowedCpus }).toEqual(wide);
    expect(DockerEmployeeResourcePolicy.parse(next)).toEqual(next);
    // Idempotent, so applying the default to an already reserved policy changes nothing.
    expect(dockerCpuReservedPolicy(next, { reservedCpus: [0, 16], everReserved: [0, 16] })).toEqual(next);
  });
  it('gives CPUs back when the reservation shrinks, but never widens a deliberately narrow laptop', () => {
    const narrowed = dockerCpuReservedPolicy(wide, { reservedCpus: [0, 16], everReserved: [0, 16] });
    expect(dockerCpuReservedPolicy(narrowed, { reservedCpus: [], everReserved: [0, 16] }).allowedCpus).toEqual(all);
    expect(dockerCpuReservedPolicy(narrowed, { reservedCpus: [0], everReserved: [0, 16] }).allowedCpus).toEqual(
      all.slice(1)
    );
    const deliberate = { ...wide, allowedCpus: [8, 9, 10, 11] };
    expect(dockerCpuReservedPolicy(deliberate, { reservedCpus: [0, 16], everReserved: [0, 16] }).allowedCpus).toEqual([
      8, 9, 10, 11,
    ]);
    expect(dockerCpuReservedPolicy(deliberate, { reservedCpus: [8], everReserved: [0, 8, 16] }).allowedCpus).toEqual([
      9, 10, 11,
    ]);
    expect(() =>
      dockerCpuReservedPolicy({ ...wide, allowedCpus: [0, 16] }, { reservedCpus: [0, 16], everReserved: [0, 16] })
    ).toThrow('DOCKER_CPU_RESERVATION_LEAVES_NO_CPU');
  });
  it('refuses an owner reservation of offline CPUs or of every CPU', () => {
    expect(dockerCpuReservationRefusal([0, 16], host)).toBeUndefined();
    expect(dockerCpuReservationRefusal([], host)).toBeUndefined();
    expect(dockerCpuReservationRefusal([32], host)).toBe('DOCKER_CPU_RESERVATION_CPU_OFFLINE');
    expect(dockerCpuReservationRefusal(all, host)).toBe('DOCKER_CPU_RESERVATION_LEAVES_NO_CPU');
  });
  it('lets a plan move carry a new laptop CPU set and soft memory limit only', () => {
    const next = { ...wide, allowedCpus: reserved, memoryHighBytes: wide.memoryHighBytes! - 4096 };
    expect(dockerReplacementKeepsLimits(next, wide)).toBe(true);
    expect(dockerReplacementKeepsLimits(wide, wide)).toBe(true);
    expect(dockerReplacementKeepsLimits({ ...next, pidsMax: next.pidsMax - 1 }, wide)).toBe(false);
    expect(dockerReplacementKeepsLimits({ ...next, pool: { ...next.pool, allowedCpus: reserved } }, wide)).toBe(false);
    const narrowPool = { ...wide, allowedCpus: [1, 2], pool: { ...wide.pool, allowedCpus: [1, 2] } };
    expect(dockerReplacementKeepsLimits({ ...narrowPool, allowedCpus: [3] }, narrowPool)).toBe(false);
  });
  it('reads the host topology from the kernel files', async () => {
    const root = await directory();
    await fs.mkdir(join(root, 'cpu0/topology'), { recursive: true });
    await fs.writeFile(join(root, 'online'), '0-31\n');
    await fs.writeFile(join(root, 'cpu0/topology/thread_siblings_list'), '0,16\n');
    expect(readHostCpuTopology(root)).toEqual(host);
  });
});

function fakeCompany(employees: Array<{ id: string; policy?: unknown; record?: unknown }>) {
  const state = {
    employees: employees.map((value) => ({
      id: value.id,
      name: 'Employee ' + value.id.slice(-1),
      ...(value.policy ? { dockerResourcePolicy: value.policy } : {}),
    })),
    dockerEmployeeContinuations: employees.flatMap((value) =>
      value.record ? [{ employeeId: value.id, policy: value.record }] : []
    ),
  } as unknown as CompanyState;
  return { store: { snapshot: () => state } } as unknown as CompanyService;
}

describe('CPU reservation decision and status', () => {
  it('applies the topology default until the owner decides, and reports what each laptop needs', async () => {
    const root = await directory(),
      file = join(root, 'reservation.jsonl'),
      narrowed = dockerCpuReservedPolicy(wide, { reservedCpus: [0, 16], everReserved: [0, 16] });
    const company = fakeCompany([
      { id: eid.slice(0, -1) + '0', policy: wide, record: wide },
      { id: eid.slice(0, -1) + '1', policy: wide },
      { id: eid.slice(0, -1) + '2', policy: narrowed, record: narrowed },
      { id: eid.slice(0, -1) + '3' },
    ]);
    const service = new DockerCpuReservation(
      company,
      file,
      boxId,
      () => {},
      () => host
    );
    expect(service.inForce()).toEqual({ reservedCpus: [0, 16], source: 'default', everReserved: [0, 16] });
    expect(service.policy(wide).allowedCpus).toEqual(reserved);
    const status = service.status(() => {});
    expect(status).toMatchObject({
      boxId,
      topology: { onlineCpus: all, firstCoreCpus: [0, 16] },
      defaultReservedCpus: [0, 16],
      approved: null,
      reservedCpus: [0, 16],
      source: 'default',
      poolCpus: all,
      allowedActions: ['approve'],
    });
    expect(status.employees.map((employee) => [employee.state, employee.nextCpus])).toEqual([
      ['rebuild-required', reserved],
      ['next-start', reserved],
      ['applied', reserved],
    ]);
    expect(status.employees[0]!.operationCpus).toEqual(all);
    // Reading approves nothing.
    await expect(fs.stat(file)).rejects.toThrow();

    const saved = await service.approve(
      { revision: first, expectedRevision: null, reservedCpus: [] },
      undefined,
      () => {}
    );
    expect(saved).toEqual({
      approved: { revision: first, reservedCpus: [] },
      state: 'approval-saved',
      appliesTo: 'new-laptop-operations',
    });
    expect(service.inForce()).toEqual({ reservedCpus: [], source: 'owner', everReserved: [0, 16] });
    expect(service.policy(narrowed).allowedCpus).toEqual(all);
    expect(service.status(() => {}).employees.map((employee) => employee.state)).toEqual([
      'applied',
      'next-start',
      'rebuild-required',
    ]);
  });
  it('refuses offline, all-CPU, emptying and stale decisions without writing', async () => {
    const root = await directory(),
      file = join(root, 'reservation.jsonl');
    const company = fakeCompany([{ id: eid, policy: { ...wide, allowedCpus: [3, 4] } }]);
    const service = new DockerCpuReservation(
      company,
      file,
      boxId,
      () => {},
      () => host
    );
    const approve = (reservedCpus: number[], revision = first, expectedRevision: string | null = null) =>
      service.approve({ revision, expectedRevision, reservedCpus }, undefined, () => {});
    await expect(approve([40])).rejects.toThrow('DOCKER_CPU_RESERVATION_CPU_OFFLINE');
    await expect(approve(all)).rejects.toThrow('DOCKER_CPU_RESERVATION_LEAVES_NO_CPU');
    // This employee was deliberately given CPUs 3 and 4 only.
    await expect(approve([3, 4])).rejects.toThrow('DOCKER_CPU_RESERVATION_LEAVES_NO_CPU');
    await expect(fs.stat(file)).rejects.toThrow();
    await approve([0]);
    await expect(approve([1], second, null)).rejects.toThrow('DOCKER_CPU_RESERVATION_CHANGED');
    await approve([1], second, first);
    expect(service.inForce()).toEqual({ reservedCpus: [1], source: 'owner', everReserved: [0, 1, 16] });
  });
  it('refuses to guess without a readable topology and never reads revoked authority', async () => {
    const root = await directory();
    const service = new DockerCpuReservation(
      fakeCompany([{ id: eid, policy: wide }]),
      join(root, 'reservation.jsonl'),
      boxId,
      () => {},
      () => {
        throw Error('no sysfs');
      }
    );
    expect(service.inForce()).toEqual({ reservedCpus: [], source: 'default', everReserved: [] });
    expect(service.status(() => {})).toMatchObject({
      topology: null,
      code: 'DOCKER_CPU_TOPOLOGY_UNKNOWN',
      allowedActions: [],
    });
    await expect(
      service.approve({ revision: first, expectedRevision: null, reservedCpus: [0] }, undefined, () => {})
    ).rejects.toThrow('DOCKER_CPU_TOPOLOGY_UNKNOWN');
    expect(() =>
      service.status(() => {
        throw Error('revoked');
      })
    ).toThrow('revoked');
  });
});

async function companyFixture(policies: unknown[]) {
  const root = await directory(),
    companyStore = new CompanyStore(join(root, 'company.json'));
  await companyStore.init();
  const sessions = new Map<string, { id: string; name: string; owner: undefined }>();
  const company = new CompanyService(companyStore, {
    getSession: (id: string) => sessions.get(id),
    chatrooms: { rooms: () => [] },
    research: {},
  } as unknown as CompanyServiceDeps);
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
  return { root, company, sessions };
}

describe('the default reaches new laptop operations only', () => {
  it('gives a new operation the reserved CPU set and leaves the approved employee policy untouched', async () => {
    const { root, company } = await companyFixture([wide]);
    const reservation = new DockerCpuReservation(
      company,
      join(root, 'r.jsonl'),
      boxId,
      () => {},
      () => host
    );
    const store = new CompanyDockerContinuationStore(
      company,
      () => undefined,
      (_owner, value) => reservation.policy(value)
    );
    const id = eid.slice(0, -1) + '0';
    expect(store.policy(id).allowedCpus).toEqual(reserved);
    expect(store.policy(id).pool).toEqual(wide.pool);
    expect(store.newOperationPolicy(id).allowedCpus).toEqual(reserved);
    expect(store.newPolicy(id, wide).allowedCpus).toEqual(reserved);
    // Until a new operation is recorded the employee's approved policy is unchanged.
    expect(company.store.snapshot().employees[0]!.dockerResourcePolicy).toEqual(wide);
  });
});

describe('owner API for the CPU reservation', () => {
  async function apiFixture() {
    const { root, company, sessions } = await companyFixture([wide]);
    let runtime = true;
    const service = new DockerCpuReservation(
      company,
      join(root, 'reservation.jsonl'),
      boxId,
      () => {
        if (!runtime) throw Error('Synthetic runtime revoked');
      },
      () => host
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
    registerDockerCpuReservationRoutes(app, service, {
      verifiedOwner: ownerVerifier({ service: ownerAuth, ctx }),
      owner: ownerFor,
    });
    await app.ready();
    cleanups.push(async () => {
      await app.close();
      for (const timer of Object.values(authState)) timer?.dispose();
    });
    const url = '/api/company/docker-resources/cpu-reservation',
      ownerHeaders = { cookie: 'reverie_owner=' + ownerToken, origin: 'http://localhost', host: 'localhost' };
    return {
      file: join(root, 'reservation.jsonl'),
      ownerHeaders,
      revokeRuntime: () => {
        runtime = false;
      },
      get: (headers: Record<string, string> = ownerHeaders) => app.inject({ method: 'GET', url, headers }),
      put: (payload: unknown, headers: Record<string, string> = ownerHeaders) =>
        app.inject({ method: 'PUT', url, headers, payload: payload as object }),
    };
  }
  const request = (revision: string, expectedRevision: string | null, reservedCpus: number[]) => ({
    revision,
    expectedRevision,
    scope: 'all-employees',
    reservedCpus,
  });
  it('shows the default and records an owner decision', async () => {
    const f = await apiFixture();
    const initial = (await f.get()).json();
    expect(initial.success).toBe(true);
    expect(initial.data).toMatchObject({ reservedCpus: [0, 16], source: 'default', approved: null });
    expect(initial.data.employees).toEqual([
      {
        employeeId: eid.slice(0, -1) + '0',
        name: 'Employee 0',
        operationCpus: null,
        nextCpus: reserved,
        state: 'next-start',
      },
    ]);
    const saved = await f.put(request(first, null, [0, 1, 16, 17]));
    expect(saved.statusCode).toBe(200);
    expect((await f.get()).json().data).toMatchObject({
      approved: { revision: first, reservedCpus: [0, 1, 16, 17] },
      reservedCpus: [0, 1, 16, 17],
      source: 'owner',
    });
    const stale = await f.put(request(second, null, [0]));
    expect(stale.json().error.code).toBe('DOCKER_CPU_RESERVATION_CHANGED');
  });
  it('accepts only a signed-in same-origin human owner and well-formed input', async () => {
    const f = await apiFixture(),
      { cookie: ownerCookie, ...anonymous } = f.ownerHeaders;
    expect((await f.get(anonymous)).statusCode).toBeOneOf([401, 403]);
    expect((await f.put(request(first, null, [0]), anonymous)).statusCode).toBeOneOf([401, 403]);
    for (const header of ['x-reverie-parent-session', 'x-reverie-worker-identity', 'x-reverie-service-token']) {
      const headers = { ...f.ownerHeaders, [header]: sid };
      expect((await f.get(headers)).statusCode, header).toBeOneOf([401, 403]);
      expect((await f.put(request(first, null, [0]), headers)).statusCode, header).toBeOneOf([401, 403]);
    }
    const foreign = await f.put(request(first, null, [0]), {
      cookie: ownerCookie,
      origin: 'http://elsewhere.example',
      host: 'localhost',
    });
    expect(foreign.statusCode).toBe(403);
    for (const body of [
      {},
      request(first, null, [16, 0]),
      request(first, null, [0, 0]),
      { ...request(first, null, [0]), x: 1 },
    ]) {
      const response = await f.put(body);
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
      expect(response.json().error.code).toBe('DOCKER_CPU_RESERVATION_INVALID_INPUT');
    }
    const offline = await f.put(request(first, null, [64]));
    expect(offline.statusCode).toBe(409);
    expect(offline.json().error.code).toBe('DOCKER_CPU_RESERVATION_CPU_OFFLINE');
    await expect(fs.stat(f.file)).rejects.toThrow();
    f.revokeRuntime();
    expect((await f.put(request(first, null, [0]))).statusCode).toBe(409);
    await expect(fs.stat(f.file)).rejects.toThrow();
  });
});
