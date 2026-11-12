/** Real owner sessions and company store; no host executor is configured or contacted. */
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { ownerVerifier } from '../src/owner-auth/marks.js';
import { CompanyStore } from '../src/company-store.js';
import { CompanyService } from '../src/company-service.js';
import { ChatroomStore } from '../src/chatroom-store.js';
import { FleetResourcesService, registerFleetResourceRoutes } from '../src/resource-fleet-service.js';
import { FleetPreviewRequestSchema } from '../src/types/resource-fleet.js';
import type { SessionPort } from '../src/web/ports/session-port.js';

const employeeId = '10000000-0000-4000-8000-000000000001';
const preview = {
  expectedRevision: 'reviewed-host-revision',
  targetImageId: 'offered-image-reference',
  policies: [{ employeeId, memoryHighMiB: 1024, memoryMaxMiB: 2048, cpuWeight: 100, perfEnabled: true }],
  pool: { memoryHighMiB: 4096, memoryMaxMiB: 8192, cpuWeight: 100, allowedCpus: [0, 1] },
  canaryEmployeeId: employeeId,
  handoff: 'Preserve the current draft and employee data.',
};
let app: FastifyInstance, directory: string, auth: OwnerAuthService, token: string;
let company: CompanyService;
let fleet: FleetResourcesService,
  observeUninstalledPool: ReturnType<typeof vi.fn>,
  wakeEmployee: ReturnType<typeof vi.fn>;
const headers = () => ({ host: 'localhost', origin: 'http://localhost', cookie: 'reverie_owner=' + token });
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'fleet-api-'));
  auth = new OwnerAuthService({
    store: new OwnerAuthStore(join(directory, 'auth.json')),
    auditFile: join(directory, 'audit.jsonl'),
    setupEnabled: true,
  });
  const password = 'synthetic-Fleet!7-fixture';
  token = await auth.setup('FixtureOwner', password, password, '127.0.0.1');
  const store = new CompanyStore(join(directory, 'company.json'));
  await store.init();
  const rooms = new ChatroomStore();
  const sessions = new Map([
    ['one', { id: 'one', name: 'One' }],
    ['two', { id: 'two', name: 'Two' }],
  ]);
  company = new CompanyService(store, {
    getSession: (id) => sessions.get(id),
    chatrooms: {
      rooms: () => rooms.list(),
      room: (id) => rooms.get(id),
      addMember: (id, session, options) => rooms.addMember(id, session, options).member,
      removeMember: (id, session) => rooms.removeMember(id, session),
    },
    research: { start: vi.fn(), inspect: vi.fn(), stop: vi.fn() },
  });
  await company.hire({ name: 'One', icon: '1', position: 'Engineer', expertise: ['systems'], sessionId: 'one' });
  await company.hire({ name: 'Two', icon: '2', position: 'Engineer', expertise: ['systems'], sessionId: 'two' });
  await store.update((state) => {
    state.employees[0].onVacation = true;
    state.employees[1].desiredRunning = false;
  });
  app = Fastify();
  await app.register(cookie);
  observeUninstalledPool = vi.fn(async () => {
    const now = Date.now();
    return {
      version: 1,
      purpose: 'worker-pool-uninstalled-observation-v1',
      nonce: randomUUID(),
      observedAtEpochMs: now,
      expiresAtEpochMs: now + 5000,
      nominationDigest: 'a'.repeat(64),
      configurationDigest: 'b'.repeat(64),
      brokerPid: 123,
      brokerStart: '100',
      brokerProgramDigest: 'c'.repeat(64),
      lifecycleGeneration: '1',
      principal: auth.registrationIdentity(token),
      websiteContainerId: 'd'.repeat(64),
      uninstalled: true,
      oldOperationOutcome: 'unconfirmed',
      startsAuthorized: false,
      activationAuthorized: false,
    };
  });
  wakeEmployee = vi.fn();
  fleet = new FleetResourcesService(
    company,
    auth,
    undefined,
    {
      observeUninstalledPool,
      wakeEmployee,
      refreshHealth: async () => {},
      providerHealth: () => undefined,
    },
    join(directory, 'recovery.json')
  );
  registerFleetResourceRoutes(
    app,
    ownerVerifier({ service: auth, ctx: { sessions } as unknown as SessionPort }),
    fleet
  );
});
afterEach(async () => {
  fleet.close();
  await app.close();
  await rm(directory, { recursive: true, force: true });
});

it('shows the complete company roster without inventing host policy, image, history or enforcement', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/company/resources/fleet', headers: headers() });
  expect(response.statusCode).toBe(200);
  const status = response.json().data;
  expect(status.canPreview).toBe(false);
  expect(status.revision).toBeNull();
  expect(status.images).toEqual([]);
  expect(status.pool).toEqual({ desired: null, observed: null });
  expect(status.operations).toBeNull();
  expect(status.unmanagedLaptops).toBeNull();
  expect(status.employees.map((row: { state: string }) => row.state)).toEqual(['vacation', 'off']);
  for (const employee of status.employees) {
    expect(employee.observed).toBeNull();
    expect(employee.observedImageId).toBeNull();
  }
});
it('rejects anonymous, mixed service/agent credentials and revoked real owner sessions', async () => {
  for (const extra of [
    { cookie: '' },
    { 'x-reverie-parent-session': 'one' },
    { 'x-reverie-service-token': 'fixture-service' },
    { authorization: 'Bearer fixture' },
    { 'x-reverie-goal-proof': 'fixture' },
  ]) {
    expect(
      (await app.inject({ method: 'GET', url: '/api/company/resources/fleet', headers: { ...headers(), ...extra } }))
        .statusCode
    ).toBe(403);
  }
  auth.logout(token);
  expect(
    (await app.inject({ method: 'GET', url: '/api/company/resources/fleet', headers: headers() })).statusCode
  ).toBe(403);
});
it('fails unavailable requests before any durable attempt or settings change and never fabricates result IDs', async () => {
  const before = await readFile(join(directory, 'company.json'));
  for (const [action, payload] of [
    ['preview', preview],
    ['apply', { previewId: 'previous-preview', expectedRevision: 'old' }],
    ['result', { operationId: 'prior-unknown-operation' }],
  ] as const) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/company/resources/fleet/' + action,
      headers: headers(),
      payload,
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ success: false, code: 'FLEET_HOST_SETUP_REQUIRED' });
    expect(response.json()).not.toHaveProperty('data.operationId');
  }
  expect(await readFile(join(directory, 'company.json'))).toEqual(before);
  const crossOrigin = await app.inject({
    method: 'POST',
    url: '/api/company/resources/fleet/apply',
    headers: { ...headers(), origin: 'http://elsewhere.invalid' },
    payload: { previewId: 'x', expectedRevision: 'x' },
  });
  expect(crossOrigin.statusCode).toBe(403);
});
it('validates closed controller semantics and refuses paths, unsafe handoffs and ambiguous cohorts', async () => {
  expect(FleetPreviewRequestSchema.safeParse(preview).success).toBe(true);
  for (const payload of [
    { ...preview, path: '/private/broker.json' },
    { ...preview, handoff: 'bad\0input' },
    { ...preview, policies: [preview.policies[0], preview.policies[0]] },
    { ...preview, policies: [{ ...preview.policies[0], memoryHighMiB: 2048 }] },
    { ...preview, policies: [{ ...preview.policies[0], cpuWeight: 0 }] },
    { ...preview, pool: { ...preview.pool, allowedCpus: [0, 0] } },
  ]) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/company/resources/fleet/preview',
      headers: headers(),
      payload,
    });
    expect(response.statusCode).toBe(400);
  }
});
it('accepts an explicit unbounded pool threshold without enabling rollout or nullable employee thresholds', async () => {
  const unbounded = { ...preview, pool: { ...preview.pool, memoryHighMiB: null } };
  expect(FleetPreviewRequestSchema.safeParse(unbounded).success).toBe(true);
  expect(FleetPreviewRequestSchema.safeParse(preview).success).toBe(true);
  const before = await readFile(join(directory, 'company.json'));
  const accepted = await app.inject({
    method: 'POST',
    url: '/api/company/resources/fleet/preview',
    headers: headers(),
    payload: unbounded,
  });
  expect(accepted.statusCode).toBe(503);
  expect(accepted.json()).toMatchObject({ success: false, code: 'FLEET_HOST_SETUP_REQUIRED' });
  for (const memoryHighMiB of [undefined, 0, 8192, Infinity]) {
    expect(FleetPreviewRequestSchema.safeParse({ ...preview, pool: { ...preview.pool, memoryHighMiB } }).success).toBe(
      false
    );
  }
  const employeeNull = { ...unbounded, policies: [{ ...preview.policies[0], memoryHighMiB: null }] };
  expect(FleetPreviewRequestSchema.safeParse(employeeNull).success).toBe(false);
  const refused = await app.inject({
    method: 'POST',
    url: '/api/company/resources/fleet/preview',
    headers: headers(),
    payload: employeeNull,
  });
  expect(refused.statusCode).toBe(400);
  expect(await readFile(join(directory, 'company.json'))).toEqual(before);
});

const recoveryRequest = () => ({ operationId: randomUUID(), preserveUnconfirmedHistory: true });
it('records the lost prior reference as UNKNOWN and never starts employees or grants activation', async () => {
  const payload = recoveryRequest();
  const before = await readFile(join(directory, 'company.json'));
  const response = await app.inject({
    method: 'POST',
    url: '/api/company/resources/fleet/native-reconcile',
    headers: headers(),
    payload,
  });
  expect(response.statusCode).toBe(200);
  expect(response.json().data).toMatchObject({
    operationId: payload.operationId,
    priorOutcome: 'unconfirmed',
    currentState: 'pool-uninstalled',
    historyRecorded: true,
    activationAuthorized: false,
    startsAuthorized: false,
  });
  const history = JSON.parse(await readFile(join(directory, 'recovery.json'), 'utf8'));
  expect(history).toHaveLength(1);
  expect(history[0]).toMatchObject({ operationId: payload.operationId, oldOutcome: 'unconfirmed' });
  expect(wakeEmployee).not.toHaveBeenCalled();
  expect(await readFile(join(directory, 'company.json'))).toEqual(before);
});
it('rejects unauthorized recovery before invoking the native observer', async () => {
  for (const extra of [
    { cookie: '' },
    { origin: 'http://elsewhere.invalid' },
    { authorization: 'Bearer fixture' },
    { 'x-reverie-service-token': 'fixture' },
    { 'x-reverie-parent-session': 'one' },
    { 'x-reverie-goal-proof': 'fixture' },
  ]) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/company/resources/fleet/native-reconcile',
      headers: { ...headers(), ...extra },
      payload: recoveryRequest(),
    });
    expect(response.statusCode).toBe(403);
  }
  expect(observeUninstalledPool).not.toHaveBeenCalled();
  expect(wakeEmployee).not.toHaveBeenCalled();
});
it('retains UNKNOWN when native observation fails, expires, or owner logs out during observation', async () => {
  const good = await observeUninstalledPool();
  observeUninstalledPool.mockRejectedValueOnce(new Error('native connection closed'));
  const send = () =>
    app.inject({
      method: 'POST',
      url: '/api/company/resources/fleet/native-reconcile',
      headers: headers(),
      payload: recoveryRequest(),
    });
  expect((await send()).statusCode).toBe(503);
  observeUninstalledPool.mockResolvedValueOnce({
    ...good,
    observedAtEpochMs: Date.now() - 6000,
    expiresAtEpochMs: Date.now() - 1000,
  });
  expect((await send()).statusCode).toBe(503);
  observeUninstalledPool.mockImplementationOnce(async () => {
    auth.logout(token);
    return good;
  });
  expect((await send()).statusCode).toBe(403);
  await expect(readFile(join(directory, 'recovery.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(wakeEmployee).not.toHaveBeenCalled();
});
