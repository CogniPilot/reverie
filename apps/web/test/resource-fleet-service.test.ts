/** Real owner sessions and company store; no host executor is configured or contacted. */
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
  registerFleetResourceRoutes(
    app,
    ownerVerifier({ service: auth, ctx: { sessions } as unknown as SessionPort }),
    new FleetResourcesService(company)
  );
});
afterEach(async () => {
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
