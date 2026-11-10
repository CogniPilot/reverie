/** Actual owner/company stores and AF_UNIX framing. The socket is a controlled
 * wire source, not native cgroup/provenance acceptance or a host executor. */
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { createServer, type Server, type Socket } from 'node:net';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { ownerVerifier } from '../src/owner-auth/marks.js';
import { CompanyStore } from '../src/company-store.js';
import { CompanyService } from '../src/company-service.js';
import { ChatroomStore } from '../src/chatroom-store.js';
import { EmployeeResourcesService, registerEmployeeResourceRoutes } from '../src/resource-employee-service.js';
import type { SessionPort } from '../src/web/ports/session-port.js';

let app: FastifyInstance, root: string, server: Server, service: EmployeeResourcesService;
let token: string, employeeId: string, sessionId: string;
let peers: Set<Socket>, frames: Record<string, unknown>[], connected: number;
let response: Record<string, unknown>;
const frame = (value: unknown) => {
  const body = Buffer.from(JSON.stringify(value)),
    header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
};
const headers = () => ({ host: 'localhost', origin: 'http://localhost', cookie: 'reverie_owner=' + token });
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'emp-api-'));
  const auth = new OwnerAuthService({
    store: new OwnerAuthStore(join(root, 'auth.json')),
    auditFile: join(root, 'audit.jsonl'),
    setupEnabled: true,
  });
  token = await auth.setup('FixtureOwner', 'Quasar!fixture-8-passphrase', 'Quasar!fixture-8-passphrase', '127.0.0.1');
  const store = new CompanyStore(join(root, 'company.json'));
  await store.init();
  const rooms = new ChatroomStore();
  sessionId = randomUUID();
  const sessions = new Map([[sessionId, { id: sessionId, name: 'Current employee' }]]);
  const company = new CompanyService(store, {
    getSession: (id) => sessions.get(id),
    chatrooms: {
      rooms: () => rooms.list(),
      room: (id) => rooms.get(id),
      addMember: (id, session, options) => rooms.addMember(id, session, options).member,
      removeMember: (id, session) => rooms.removeMember(id, session),
    },
    research: { start: vi.fn(), inspect: vi.fn(), stop: vi.fn() },
  });
  await company.hire({ name: 'Current employee', icon: '1', position: 'Engineer', expertise: ['systems'], sessionId });
  employeeId = company.view(undefined).employees[0].id;
  response = {
    version: 1,
    employeeId,
    sessionId,
    revision: 'b'.repeat(64),
    state: 'stopped',
    requested: { memoryHighMiB: 8192, memoryMaxMiB: 49152, cpuWeight: 100, allowedCpus: [0, 1], perfPolicy: 'task-v2' },
    observed: null,
    perfObserved: null,
    perfObservationReason: 'OWN_PROCESS_PROBE_REQUIRED',
    capabilities: {
      softMemoryLive: false,
      cpuWeightLive: false,
      hardMemoryReplacement: false,
      perfReplacement: false,
      gpuReplacement: false,
    },
    readOnly: true,
  };
  peers = new Set();
  frames = [];
  connected = 0;
  server = createServer((socket) => {
    connected++;
    peers.add(socket);
    socket.on('close', () => peers.delete(socket));
    let buffer = Buffer.alloc(0),
      greeted = false;
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!greeted) {
        if (buffer.length < 5) return;
        const size = buffer.readUInt32BE(1);
        if (buffer.length < size + 5) return;
        expect(buffer[0]).toBe('Q'.charCodeAt(0));
        expect(JSON.parse(buffer.subarray(5, 5 + size).toString())).toEqual({
          purpose: 'resource-ram-pool-v2',
          version: 2,
        });
        buffer = buffer.subarray(5 + size);
        greeted = true;
        socket.write('RESOURCE_READY\n');
      }
      while (buffer.length >= 4) {
        const size = buffer.readUInt32BE(0);
        if (buffer.length < size + 4) return;
        const value = JSON.parse(buffer.subarray(4, size + 4).toString()) as Record<string, unknown>;
        buffer = buffer.subarray(4 + size);
        frames.push(value);
        if (value.kind === 'resource-operation')
          socket.write(
            frame({
              kind: 'resource-owner-check',
              requestId: value.requestId,
              nonce: randomUUID(),
              stage: 'status',
              employeeId,
              approval: null,
            })
          );
        else socket.write(frame({ kind: 'resource-result', requestId: value.requestId, value: response }));
      }
    });
  });
  const socketPath = join(root, 'actor.sock');
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  await chmod(socketPath, 0o600);
  service = new EmployeeResourcesService(company, auth, socketPath);
  app = Fastify();
  await app.register(cookie);
  registerEmployeeResourceRoutes(
    app,
    ownerVerifier({ service: auth, ctx: { sessions } as unknown as SessionPort }),
    service
  );
});
afterEach(async () => {
  service?.close();
  for (const peer of peers ?? []) peer.destroy();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await app?.close();
  await rm(root, { recursive: true, force: true });
});
it('authenticates the original owner and current session without inferring stopped limits or perf', async () => {
  const result = await app.inject({
    method: 'GET',
    url: `/api/company/resources/employees/${employeeId}`,
    headers: headers(),
  });
  expect(result.statusCode).toBe(200);
  expect(result.headers['cache-control']).toBe('no-store');
  expect(result.json().data).toEqual(response);
  expect(frames[0]).toMatchObject({ verb: 'employee-status', employeeId, sessionId });
  expect(frames[1]).toMatchObject({ kind: 'resource-owner-current', stage: 'status', approval: null });
  expect(JSON.stringify(frames)).not.toContain(token);
});
it('refuses a foreign returned session instead of attributing its observation to the employee', async () => {
  response.sessionId = randomUUID();
  const result = await app.inject({
    method: 'GET',
    url: `/api/company/resources/employees/${employeeId}`,
    headers: headers(),
  });
  expect(result.statusCode).toBe(503);
  expect(result.json().data).toBeUndefined();
});
it('rejects anonymous and mixed guest/service headers before opening any native socket', async () => {
  for (const extra of [
    { cookie: '' },
    { authorization: 'Bearer arbitrary' },
    { 'x-reverie-parent-session': sessionId },
    { 'x-reverie-service-token': 'arbitrary' },
    { 'x-reverie-goal-proof': 'arbitrary' },
  ]) {
    const result = await app.inject({
      method: 'GET',
      url: `/api/company/resources/employees/${employeeId}`,
      headers: { ...headers(), ...extra },
    });
    expect(result.statusCode).toBe(403);
  }
  expect(connected).toBe(0);
  expect(frames).toHaveLength(0);
});
