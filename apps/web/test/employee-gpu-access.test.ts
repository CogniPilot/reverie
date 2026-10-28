/** Real owner policy/auth plus owned UDS framing; no real broker/device/lifecycle actions. */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import Fastify, {type FastifyInstance} from 'fastify';
import fastifyCookie from '@fastify/cookie';
import {createServer, type Server, type Socket} from 'node:net';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EmployeeGpuClient, EmployeeGpuStatus, registerEmployeeGpuRoutes, type EmployeeGpuStatusValue} from '../src/employee-gpu-access.js';
import {CompanyService} from '../src/company-service.js';
import {CompanyStore} from '../src/company-store.js';
import {OwnerAuthStore} from '../src/owner-auth/store.js';
import {OwnerAuthService} from '../src/owner-auth/service.js';
import {bootstrap, issueServiceToken, setPolicy} from '../src/owner-auth/admin.js';
import {OWNER_COOKIE, SERVICE_HEADER, registerOwnerPolicy} from '../src/owner-auth/policy.js';
import {ownerVerifier} from '../src/owner-auth/marks.js';
import {registerOwnerRoutes} from '../src/owner-auth/routes.js';
import type {SessionPort} from '../src/web/ports/session-port.js';

const SID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const DEVICE = 'GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const frame = (value: unknown, kind = 74) => {
  const body = Buffer.from(JSON.stringify(value));const header = Buffer.alloc(5);
  header[0] = kind;header.writeUInt32BE(body.length, 1);return Buffer.concat([header, body]);
};
let dir: string, server: Server, sockets: Set<Socket>, requests: Record<string, unknown>[];
let handler: (command: Record<string, unknown>, socket: Socket) => void;
let socketPath: string;
async function broker() {
  dir = await mkdtemp(join(tmpdir(), 'employee-gpu-'));socketPath = join(dir, 'control.sock');
  sockets = new Set();requests = [];
  server = createServer(socket => {
    sockets.add(socket);socket.on('close', () => sockets.delete(socket));socket.on('error', () => {});
    let data = Buffer.alloc(0);
    socket.on('data', chunk => {
      data = Buffer.concat([data, chunk]);if (data.length < 5 || data.length < data.readUInt32BE(1) + 5) return;
      expect(data[0]).toBe(67);expect(data.length).toBe(data.readUInt32BE(1) + 5);
      const command = JSON.parse(data.subarray(5).toString());requests.push(command);handler(command, socket);
    });
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
}
afterEach(async () => {
  for (const socket of sockets ?? []) socket.destroy();
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  if (dir) await rm(dir, {recursive: true, force: true});
});
const status = (employeeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'): EmployeeGpuStatusValue => ({
  version: 1, employeeId, current: {sessionId: SID, sessionGeneration: 1, bindingDigest: 'b'.repeat(64)}, revision: 0,
  choices: {known: true, devices: [{deviceUuid: DEVICE, model: 'Synthetic NVIDIA GPU'}]}, requested: null,
  applied: {known: true, enabled: true, deviceUuid: DEVICE, source: 'legacy-session'},
  active: {known: false, running: true, enabled: null, deviceUuid: null}, state: 'unchanged',
});

describe('fixed private GPU client', () => {
  beforeEach(broker);
  it('reads one bounded fragmented J frame and sends only the fixed C request', async () => {
    handler = (_command, socket) => {const bytes = frame(status());socket.write(bytes.subarray(0, 3));socket.end(bytes.subarray(3));};
    expect(await new EmployeeGpuClient(socketPath).exchange({action: 'gpu-access-status', employeeId: status().employeeId})).toEqual(status());
    expect(requests).toEqual([{action: 'gpu-access-status', employeeId: status().employeeId}]);
  });
  it('refuses EOF/lost acknowledgement exactly once without repeating a mutation', async () => {
    handler = (_command, socket) => socket.end();
    await expect(new EmployeeGpuClient(socketPath).exchange({action: 'gpu-access-request', employeeId: status().employeeId,
      expected: {...status().current, revision: 0}, enabled: false})).rejects.toThrow('not confirmed');
    expect(requests).toHaveLength(1);
  });
  it('refuses oversized, extra, foreign-schema and E responses without leaking body text', async () => {
    for (const value of ['oversized', 'extra', 'schema', 'error']) {
      handler = (_command, socket) => {
        if (value === 'oversized') {const header = Buffer.alloc(5);header[0] = 74;header.writeUInt32BE(65537, 1);socket.end(header);}
        else if (value === 'extra') socket.end(Buffer.concat([frame(status()), Buffer.from('x')]));
        else if (value === 'schema') socket.end(frame({...status(), command: 'never-accepted'}));
        else socket.end(frame('synthetic-private-secret must not escape', 69));
      };
      await expect(new EmployeeGpuClient(socketPath).exchange({action: 'gpu-access-status', employeeId: status().employeeId})).rejects.toThrow('not confirmed');
    }
  });
  it('uses an absolute deadline even if the owned peer remains connected', async () => {
    let admitted!: () => void;
    const accepted = new Promise<void>(resolve => {admitted = resolve;});
    handler = (_command, socket) => {const header = Buffer.alloc(5);header[0] = 74;header.writeUInt32BE(1024, 1);socket.write(header);admitted();};
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
    try {
      const result = new EmployeeGpuClient(socketPath).exchange({action: 'gpu-access-status', employeeId: status().employeeId})
        .then(() => 'unexpected success', error => String(error.message));
      await accepted;await vi.advanceTimersByTimeAsync(35001);
      expect(await result).toContain('not confirmed');expect(requests).toHaveLength(1);
    } finally {vi.useRealTimers();}
  });

  it('refuses duplicate physical identities and cannot infer active access from an applied grant', () => {
    expect(EmployeeGpuStatus.safeParse({...status(), choices: {known: true, devices: [status().choices.devices[0], status().choices.devices[0]]}}).success).toBe(false);
    expect(EmployeeGpuStatus.parse(status()).active.enabled).toBeNull();
  });
});

describe('owner GPU HTTP request boundary', () => {
  let app: FastifyInstance, company: CompanyService, eid: string, token: string, serviceToken: string;
  let native: EmployeeGpuStatusValue;
  let sessions: Map<string, {id: string; owner: string | undefined}>;
  beforeEach(async () => {
    await broker();
    const store = new CompanyStore(join(dir, 'company.json'));await store.init();
    sessions = new Map([SID, OTHER].map(id => [id, {id, owner: undefined}]));
    company = new CompanyService(store, {getSession: id => sessions.get(id),
      chatrooms: {rooms: () => [], room: () => undefined, addMember: () => {throw Error('No room mutation');}, removeMember: () => {}},
      research: {start: vi.fn(), inspect: vi.fn(), stop: vi.fn()}});
    eid = (await company.hire({name: 'Synthetic Expert', icon: 'S', position: 'Engineer', expertise: ['testing'], sessionId: SID})).id;
    native = status(eid);handler = (_command, socket) => socket.end(frame(native));
    const authStore = new OwnerAuthStore(join(dir, 'owner.json'));
    const {oneTimePassword} = await bootstrap(authStore, 'synthetic-owner');
    await setPolicy(authStore, 'enforce', {forceLockoutRisk: true});serviceToken = await issueServiceToken(authStore, 'synthetic-service');
    const auth = new OwnerAuthService({store: authStore, auditFile: join(dir, 'owner-audit.jsonl')});
    app = Fastify();await app.register(fastifyCookie);
    const ctx = {sessions} as unknown as SessionPort;
    registerOwnerPolicy(app, {service: auth, ctx, isCapabilityRequest: () => false,
      relations: {known: id => sessions.has(id), related: (a, b) => a === b, upward: () => false, keeper: () => false, admin: () => false}});
    registerOwnerRoutes(app, auth, false);
    registerEmployeeGpuRoutes(app, company, new EmployeeGpuClient(socketPath), ownerVerifier({service: auth, ctx}));
    await app.ready();
    const login = await app.inject({method: 'POST', url: '/api/owner/login', payload: {username: 'synthetic-owner', password: oneTimePassword}});
    const changed = await app.inject({method: 'POST', url: '/api/owner/password', headers: {origin: 'http://localhost'},
      cookies: {[OWNER_COOKIE]: login.cookies.find(cookie => cookie.name === OWNER_COOKIE)!.value},
      payload: {current: oneTimePassword, next: 'Quasar!9-lantern-cobalt'}});
    expect(changed.statusCode).toBe(200);token = changed.cookies.find(cookie => cookie.name === OWNER_COOKIE)!.value;
  });
  afterEach(async () => app?.close());
  const url = (id: string) => '/api/company/employees/' + id + '/gpu-access';
  it('keeps anonymous, agent, service, foreign origin and identity-spoofing writes away from control', async () => {
    expect((await app.inject({url: url(eid)})).statusCode).toBe(401);
    expect((await app.inject({url: url(eid), headers: {'x-reverie-parent-session': SID}})).statusCode).toBe(403);
    expect((await app.inject({url: url(eid), headers: {[SERVICE_HEADER]: serviceToken}})).statusCode).toBe(403);
    const body = {expected: {...native.current, revision: 0}, enabled: false};
    expect((await app.inject({method: 'POST', url: url(eid), cookies: {[OWNER_COOKIE]: token},
      headers: {origin: 'http://foreign.invalid'}, payload: body})).statusCode).toBe(403);
    expect((await app.inject({method: 'POST', url: url(eid), cookies: {[OWNER_COOKIE]: token}, headers: {origin: 'http://localhost'},
      payload: {...body, owner: true}})).statusCode).toBe(400);
    expect(requests).toEqual([]);
  });
  it('does not expose another owner employee or turn delegated plan/recovery permissions into GPU authority', async () => {
    sessions.set(OTHER, {id: OTHER, owner: 'foreign-owner'});
    const foreign = await company.hire({name: 'Synthetic Foreign Expert', icon: 'F', position: 'Engineer', expertise: ['testing'],
      sessionId: OTHER, owner: 'foreign-owner'});
    expect((await app.inject({url: url(foreign.id), cookies: {[OWNER_COOKIE]: token}})).statusCode).toBe(404);
    await company.update(eid, undefined, {position: 'CTO', permissions: {managePlans: true, recoverEmployees: true}});
    expect((await app.inject({url: url(eid), headers: {'x-reverie-parent-session': SID}})).statusCode).toBe(403);
    expect((await app.inject({url: url(eid), cookies: {[OWNER_COOKIE]: token},
      headers: {'x-reverie-parent-session': SID}})).statusCode).toBe(403);
    expect(requests).toEqual([]);
  });

  it('reports the native existing grant unchanged and queues only the exact owner CAS request', async () => {
    const read = await app.inject({url: url(eid), cookies: {[OWNER_COOKIE]: token}});
    expect(read.statusCode).toBe(200);expect(read.json().data.gpuAccess.applied).toEqual(native.applied);
    handler = (command, socket) => {
      expect(command).toEqual({action: 'gpu-access-request', employeeId: eid, expected: {...native.current, revision: 0}, enabled: false});
      native = {...native, revision: 1, requested: {enabled: false, deviceUuid: null, revision: 1}, state: 'pending'};
      socket.end(frame(native));
    };
    const saved = await app.inject({method: 'POST', url: url(eid), cookies: {[OWNER_COOKIE]: token},
      headers: {origin: 'http://localhost'}, payload: {expected: {...native.current, revision: 0}, enabled: false}});
    expect(saved.statusCode).toBe(200);expect(saved.json().data.gpuAccess).toMatchObject({state: 'pending', applied: {enabled: true}, active: {enabled: null}});
    expect(company.view().employees[0]).not.toHaveProperty('gpuAccess');
  });
  it('refuses stale or foreign binding and arbitrary device/path fields before requesting a change', async () => {
    for (const body of [{expected: {...native.current, sessionId: OTHER, revision: 0}, enabled: false},
      {expected: {...native.current, revision: 0}, enabled: true, deviceUuid: 'all'},
      {expected: {...native.current, revision: 0}, enabled: false, deviceUuid: DEVICE},
      {expected: {...native.current, revision: 0}, enabled: false, socket: '/untrusted/socket'}]) {
      const reply = await app.inject({method: 'POST', url: url(eid), cookies: {[OWNER_COOKIE]: token},
        headers: {origin: 'http://localhost'}, payload: body});
      expect([400, 409]).toContain(reply.statusCode);
    }
    expect(requests).toEqual([]);
    native = {...native, employeeId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'};
    expect((await app.inject({url: url(eid), cookies: {[OWNER_COOKIE]: token}})).statusCode).toBe(409);
  });
  it('rechecks the real owner session after native status I/O', async () => {
    handler = (_command, socket) => {
      void app.inject({method: 'POST', url: '/api/owner/logout', cookies: {[OWNER_COOKIE]: token},
        headers: {origin: 'http://localhost'}}).then(() => socket.end(frame(native)));
    };
    const reply = await app.inject({url: url(eid), cookies: {[OWNER_COOKIE]: token}});
    expect(reply.statusCode).toBe(403);expect(reply.json().success).toBe(false);
    expect(reply.json()).not.toHaveProperty('data');
  });

  it('does not acknowledge a result after the actual employee binding changes during native I/O', async () => {
    handler = (_command, socket) => {
      void company.rebind(eid, undefined, OTHER).then(() => socket.end(frame(native)));
    };
    const reply = await app.inject({url: url(eid), cookies: {[OWNER_COOKIE]: token}});
    expect(reply.statusCode).toBe(409);expect(reply.json().error).toContain('binding changed');
  });
  it('independent: never confirms a queued owner request from an unchanged revision acknowledgement', async () => {
    native = {...native, revision: 4, requested: {enabled: false, deviceUuid: null, revision: 4}, state: 'pending'};
    const reply = await app.inject({method: 'POST', url: url(eid), cookies: {[OWNER_COOKIE]: token},
      headers: {origin: 'http://localhost'}, payload: {expected: {...native.current, revision: 4}, enabled: false}});
    expect(requests).toHaveLength(1);
    expect(reply.statusCode).toBe(503);
    expect(reply.json().success).toBe(false);
  });
  it('independent: never confirms a result whose requested revision differs from the native status revision', async () => {
    native = {...native, revision: 5, requested: {enabled: false, deviceUuid: null, revision: 3}, state: 'pending'};
    const reply = await app.inject({method: 'POST', url: url(eid), cookies: {[OWNER_COOKIE]: token},
      headers: {origin: 'http://localhost'}, payload: {expected: {...native.current, revision: 4}, enabled: false}});
    expect(requests).toHaveLength(1);
    expect(reply.statusCode).toBe(503);
    expect(reply.json().success).toBe(false);
  });

});
