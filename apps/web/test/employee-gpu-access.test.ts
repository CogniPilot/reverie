/** Real owner policy/auth plus owned UDS framing; no real broker/device/lifecycle actions. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { createServer, type Server, type Socket } from 'node:net';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EmployeeGpuClient,
  EmployeeGpuStatus,
  registerEmployeeGpuRoutes,
  type EmployeeGpuStatusValue,
} from '../src/employee-gpu-access.js';
import { CompanyService } from '../src/company-service.js';
import { CompanyStore } from '../src/company-store.js';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { bootstrap, issueServiceToken, setPolicy } from '../src/owner-auth/admin.js';
import { OWNER_COOKIE, SERVICE_HEADER, registerOwnerPolicy } from '../src/owner-auth/policy.js';
import { ownerVerifier } from '../src/owner-auth/marks.js';
import { registerOwnerRoutes } from '../src/owner-auth/routes.js';
import type { SessionPort } from '../src/web/ports/session-port.js';

const SID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const DEVICE = 'GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const frame = (value: unknown) => {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
};
const result = (command: Record<string, unknown>, status: unknown) =>
  frame({ kind: 'resource-result', requestId: command.requestId, value: status });
let dir: string, server: Server, sockets: Set<Socket>, requests: Record<string, unknown>[];
let replies: Record<string, unknown>[];
let handler: (command: Record<string, unknown>, socket: Socket) => void;
let challenge: (command: Record<string, unknown>, socket: Socket) => void;
let socketPath: string;
async function broker() {
  dir = await mkdtemp(join(tmpdir(), 'employee-gpu-'));
  socketPath = join(dir, 'control.sock');
  sockets = new Set();
  requests = [];
  replies = [];
  challenge = (command, socket) =>
    socket.write(
      frame({
        kind: 'resource-owner-check',
        requestId: command.requestId,
        nonce: randomUUID(),
        stage: command.verb,
        employeeId: command.employeeId,
        approval: command.approval ?? null,
      })
    );
  server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let data = Buffer.alloc(0),
      hello = false;
    let selected: Record<string, unknown> | undefined;
    socket.on('data', (chunk) => {
      data = Buffer.concat([data, chunk]);
      if (!hello) {
        if (data.length < 5) return;
        const size = data.readUInt32BE(1);
        if (data.length < size + 5) return;
        expect(data[0]).toBe(81);
        expect(JSON.parse(data.subarray(5, 5 + size).toString())).toEqual({
          purpose: 'resource-ram-pool-v2',
          version: 2,
        });
        data = data.subarray(5 + size);
        hello = true;
        socket.write('RESOURCE_READY\n');
      }
      while (data.length >= 4) {
        const size = data.readUInt32BE(0);
        if (data.length < 4 + size) return;
        const value = JSON.parse(data.subarray(4, 4 + size).toString());
        data = data.subarray(4 + size);
        if (value.kind === 'resource-operation') {
          expect(selected).toBeUndefined();
          selected = value;
          requests.push(value);
          challenge(value, socket);
        } else {
          expect(selected).toBeDefined();
          expect(value).toMatchObject({
            kind: 'resource-owner-current',
            purpose: 'resource-ram-pool-v2',
            requestId: selected!.requestId,
            stage: selected!.verb,
            approval: selected!.approval ?? null,
          });
          expect(value.ownerScopeDigest).toMatch(/^[0-9a-f]{64}$/);
          expect(value.principal.accountId).toMatch(/^[0-9a-f-]{36}$/);
          replies.push(value);
          handler(selected!, socket);
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  await chmod(socketPath, 0o600);
}
afterEach(async () => {
  for (const socket of sockets ?? []) socket.destroy();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (dir) await rm(dir, { recursive: true, force: true });
});
const status = (employeeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'): EmployeeGpuStatusValue => ({
  version: 1,
  employeeId,
  current: { sessionId: SID, sessionGeneration: 1, bindingDigest: 'b'.repeat(64) },
  revision: 0,
  choices: { known: true, devices: [{ deviceUuid: DEVICE, model: 'Synthetic NVIDIA GPU' }] },
  requested: null,
  applied: { known: true, enabled: true, deviceUuid: DEVICE, source: 'legacy-session' },
  active: { known: false, running: true, enabled: null, deviceUuid: null },
  state: 'unchanged',
});

describe('owner GPU HTTP and protected Q boundary', () => {
  let app: FastifyInstance, company: CompanyService, eid: string, token: string, serviceToken: string;
  let native: EmployeeGpuStatusValue, client: EmployeeGpuClient;
  let sessions: Map<string, { id: string; owner: string | undefined }>;
  beforeEach(async () => {
    await broker();
    const store = new CompanyStore(join(dir, 'company.json'));
    await store.init();
    sessions = new Map([SID, OTHER].map((id) => [id, { id, owner: undefined }]));
    company = new CompanyService(store, {
      getSession: (id) => sessions.get(id),
      chatrooms: {
        rooms: () => [],
        room: () => undefined,
        addMember: () => {
          throw Error('No room mutation');
        },
        removeMember: () => {},
      },
      research: { start: vi.fn(), inspect: vi.fn(), stop: vi.fn() },
    });
    eid = (
      await company.hire({
        name: 'Synthetic Expert',
        icon: 'S',
        position: 'Engineer',
        expertise: ['testing'],
        sessionId: SID,
      })
    ).id;
    native = status(eid);
    handler = (command, socket) => socket.end(result(command, native));
    const authStore = new OwnerAuthStore(join(dir, 'owner.json'));
    const { oneTimePassword } = await bootstrap(authStore, 'synthetic-owner');
    await setPolicy(authStore, 'enforce', { forceLockoutRisk: true });
    serviceToken = await issueServiceToken(authStore, 'synthetic-service');
    const auth = new OwnerAuthService({ store: authStore, auditFile: join(dir, 'owner-audit.jsonl') });
    app = Fastify();
    await app.register(fastifyCookie);
    const ctx = { sessions } as unknown as SessionPort;
    registerOwnerPolicy(app, {
      service: auth,
      ctx,
      isCapabilityRequest: () => false,
      relations: {
        known: (id) => sessions.has(id),
        related: (a, b) => a === b,
        upward: () => false,
        keeper: () => false,
        admin: () => false,
      },
    });
    registerOwnerRoutes(app, auth, false);
    client = new EmployeeGpuClient(socketPath, auth);
    registerEmployeeGpuRoutes(app, company, client, ownerVerifier({ service: auth, ctx }));
    await app.ready();
    const login = await app.inject({
      method: 'POST',
      url: '/api/owner/login',
      payload: { username: 'synthetic-owner', password: oneTimePassword },
    });
    const changed = await app.inject({
      method: 'POST',
      url: '/api/owner/password',
      headers: { origin: 'http://localhost' },
      cookies: { [OWNER_COOKIE]: login.cookies.find((cookie) => cookie.name === OWNER_COOKIE)!.value },
      payload: { current: oneTimePassword, next: 'Quasar!9-lantern-cobalt' },
    });
    expect(changed.statusCode).toBe(200);
    token = changed.cookies.find((cookie) => cookie.name === OWNER_COOKIE)!.value;
  });
  afterEach(async () => {
    client?.close();
    await app?.close();
  });
  const url = (id: string) => '/api/company/employees/' + id + '/gpu-access';
  it('keeps anonymous, agent, service, foreign origin and identity-spoofing writes away from control', async () => {
    expect((await app.inject({ url: url(eid) })).statusCode).toBe(401);
    expect((await app.inject({ url: url(eid), headers: { 'x-reverie-parent-session': SID } })).statusCode).toBe(403);
    expect((await app.inject({ url: url(eid), headers: { [SERVICE_HEADER]: serviceToken } })).statusCode).toBe(403);
    const body = { expected: { ...native.current, revision: 0 }, enabled: false };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: url(eid),
          cookies: { [OWNER_COOKIE]: token },
          headers: { origin: 'http://foreign.invalid' },
          payload: body,
        })
      ).statusCode
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: url(eid),
          cookies: { [OWNER_COOKIE]: token },
          headers: { origin: 'http://localhost' },
          payload: { ...body, owner: true },
        })
      ).statusCode
    ).toBe(400);
    expect(requests).toEqual([]);
  });
  it('does not expose another owner employee or turn delegated plan/recovery permissions into GPU authority', async () => {
    sessions.set(OTHER, { id: OTHER, owner: 'foreign-owner' });
    const foreign = await company.hire({
      name: 'Synthetic Foreign Expert',
      icon: 'F',
      position: 'Engineer',
      expertise: ['testing'],
      sessionId: OTHER,
      owner: 'foreign-owner',
    });
    expect((await app.inject({ url: url(foreign.id), cookies: { [OWNER_COOKIE]: token } })).statusCode).toBe(404);
    await company.update(eid, undefined, {
      position: 'CTO',
      permissions: { managePlans: true, recoverEmployees: true },
    }, () => {});
    expect((await app.inject({ url: url(eid), headers: { 'x-reverie-parent-session': SID } })).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          url: url(eid),
          cookies: { [OWNER_COOKIE]: token },
          headers: { 'x-reverie-parent-session': SID },
        })
      ).statusCode
    ).toBe(403);
    expect(requests).toEqual([]);
  });

  it('reports the native existing grant unchanged and queues only the exact owner CAS request', async () => {
    const read = await app.inject({ url: url(eid), cookies: { [OWNER_COOKIE]: token } });
    expect(read.statusCode).toBe(200);
    expect(read.json().data.gpuAccess.applied).toEqual(native.applied);
    expect(requests[0]).toEqual({
      kind: 'resource-operation',
      requestId: expect.any(String),
      verb: 'gpu-status',
      employeeId: eid,
      sessionId: SID,
    });
    expect(read.headers['cache-control']).toBe('no-store');
    handler = (command, socket) => {
      expect(command).toEqual({
        kind: 'resource-operation',
        requestId: expect.any(String),
        verb: 'gpu-request',
        employeeId: eid,
        approval: { expected: { ...native.current, revision: 0 }, enabled: false },
      });
      native = {
        ...native,
        revision: 1,
        requested: { enabled: false, deviceUuid: null, revision: 1 },
        state: 'pending',
      };
      socket.end(result(command, native));
    };
    const saved = await app.inject({
      method: 'POST',
      url: url(eid),
      cookies: { [OWNER_COOKIE]: token },
      headers: { origin: 'http://localhost' },
      payload: { expected: { ...native.current, revision: 0 }, enabled: false },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().data.gpuAccess).toMatchObject({
      state: 'pending',
      applied: { enabled: true },
      active: { enabled: null },
    });
    expect(company.view().employees[0]).not.toHaveProperty('gpuAccess');
    expect(replies).toHaveLength(2);
    expect(replies[1].approval).toEqual(requests[1].approval);
  });
  it('refuses stale or foreign binding and arbitrary device/path fields before requesting a change', async () => {
    for (const body of [
      { expected: { ...native.current, sessionId: OTHER, revision: 0 }, enabled: false },
      { expected: { ...native.current, revision: 0 }, enabled: true, deviceUuid: 'all' },
      { expected: { ...native.current, revision: 0 }, enabled: false, deviceUuid: DEVICE },
      { expected: { ...native.current, revision: 0 }, enabled: false, socket: '/untrusted/socket' },
    ]) {
      const reply = await app.inject({
        method: 'POST',
        url: url(eid),
        cookies: { [OWNER_COOKIE]: token },
        headers: { origin: 'http://localhost' },
        payload: body,
      });
      expect([400, 409]).toContain(reply.statusCode);
    }
    expect(requests).toEqual([]);
    native = { ...native, employeeId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
    expect((await app.inject({ url: url(eid), cookies: { [OWNER_COOKIE]: token } })).statusCode).toBe(409);
  });
  it('rechecks the real owner session after native status I/O', async () => {
    handler = (command, socket) => {
      void app
        .inject({
          method: 'POST',
          url: '/api/owner/logout',
          cookies: { [OWNER_COOKIE]: token },
          headers: { origin: 'http://localhost' },
        })
        .then(() => socket.end(result(command, native)));
    };
    const reply = await app.inject({ url: url(eid), cookies: { [OWNER_COOKIE]: token } });
    expect(reply.statusCode).toBe(403);
    expect(reply.json().success).toBe(false);
    expect(reply.json()).not.toHaveProperty('data');
  });

  it('does not acknowledge a result after the actual employee binding changes during native I/O', async () => {
    handler = (command, socket) => {
      void company.rebind(eid, undefined, OTHER).then(() => socket.end(result(command, native)));
    };
    const reply = await app.inject({ url: url(eid), cookies: { [OWNER_COOKIE]: token } });
    expect(reply.statusCode).toBe(409);
    expect(reply.json().error).toContain('binding changed');
  });
  it('independent: never confirms a queued owner request from an unchanged revision acknowledgement', async () => {
    native = { ...native, revision: 4, requested: { enabled: false, deviceUuid: null, revision: 4 }, state: 'pending' };
    const reply = await app.inject({
      method: 'POST',
      url: url(eid),
      cookies: { [OWNER_COOKIE]: token },
      headers: { origin: 'http://localhost' },
      payload: { expected: { ...native.current, revision: 4 }, enabled: false },
    });
    expect(requests).toHaveLength(1);
    expect(reply.statusCode).toBe(503);
    expect(reply.json().success).toBe(false);
  });
  it('independent: never confirms a result whose requested revision differs from the native status revision', async () => {
    native = { ...native, revision: 5, requested: { enabled: false, deviceUuid: null, revision: 3 }, state: 'pending' };
    const reply = await app.inject({
      method: 'POST',
      url: url(eid),
      cookies: { [OWNER_COOKIE]: token },
      headers: { origin: 'http://localhost' },
      payload: { expected: { ...native.current, revision: 4 }, enabled: false },
    });
    expect(requests).toHaveLength(1);
    expect(reply.statusCode).toBe(503);
    expect(reply.json().success).toBe(false);
  });

  it('refuses a foreign GPU approval before replying to its owner challenge', async () => {
    const body = { expected: { ...native.current, revision: 0 }, enabled: false };
    challenge = (command, socket) =>
      socket.write(
        frame({
          kind: 'resource-owner-check',
          requestId: command.requestId,
          nonce: randomUUID(),
          stage: 'gpu-request',
          employeeId: eid,
          approval: { ...body, expected: { ...body.expected, revision: 1 } },
        })
      );
    const response = await app.inject({
      method: 'POST',
      url: url(eid),
      cookies: { [OWNER_COOKIE]: token },
      headers: { origin: 'http://localhost' },
      payload: body,
    });
    expect(response.statusCode).toBe(503);
    expect(requests).toHaveLength(1);
    expect(replies).toEqual([]);
  });
  it('requires the actual owner challenge before accepting a GPU result', async () => {
    challenge = (command, socket) => socket.end(result(command, native));
    const response = await app.inject({ url: url(eid), cookies: { [OWNER_COOKIE]: token } });
    expect(response.statusCode).toBe(503);
    expect(requests).toHaveLength(1);
    expect(replies).toEqual([]);
  });
  it('keeps a lost queue acknowledgement unknown and sends no repeat request', async () => {
    handler = (_command, socket) => socket.end();
    const response = await app.inject({
      method: 'POST',
      url: url(eid),
      cookies: { [OWNER_COOKIE]: token },
      headers: { origin: 'http://localhost' },
      payload: { expected: { ...native.current, revision: 0 }, enabled: false },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toContain('not confirmed');
    expect(requests).toHaveLength(1);
    expect(replies).toHaveLength(1);
  });
  it('applies the exact saved revision through its own owner challenge without sending a startup command', async () => {
    const approval = { ...native.current, revision: 5, deviceUuid: null };
    native = {
      ...native,
      current: { ...native.current, bindingDigest: 'c'.repeat(64) },
      revision: 5,
      requested: { enabled: false, deviceUuid: null, revision: 5 },
      applied: { known: true, enabled: false, deviceUuid: null, source: 'employee' },
      active: { known: true, running: false, enabled: false, deviceUuid: null },
      state: 'applied',
    };
    const response = await app.inject({
      method: 'POST',
      url: url(eid) + '/apply',
      cookies: { [OWNER_COOKIE]: token },
      headers: { origin: 'http://localhost' },
      payload: approval,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.gpuAccess).toEqual(native);
    expect(requests).toEqual([
      { kind: 'resource-operation', requestId: expect.any(String), verb: 'gpu-apply', employeeId: eid, approval },
    ]);
    expect(replies).toEqual([expect.objectContaining({ stage: 'gpu-apply', approval })]);
  });
  it('preserves older native reads and only exposes readiness from the current exact employee', async () => {
    native = {
      ...native,
      revision: 5,
      requested: { enabled: false, deviceUuid: null, revision: 5 },
      active: { known: true, running: false, enabled: false, deviceUuid: null },
      state: 'pending',
    };
    const read = () => app.inject({ url: url(eid), cookies: { [OWNER_COOKIE]: token } });
    const currentChallenge = challenge;
    // The older broker closes before it can issue an owner challenge for the new verb.
    challenge = (command, socket) => {
      if (command.verb === 'gpu-apply-status') return void socket.end();
      currentChallenge(command, socket);
    };
    const fallback = await read();
    expect(fallback.statusCode).toBe(200);
    expect(fallback.json().data.gpuAccess).toEqual(native);
    expect(requests.map(({ verb }) => verb)).toEqual(['gpu-status', 'gpu-apply-status']);
    expect(replies).toHaveLength(1);

    challenge = currentChallenge;
    let selectedEmployee = OTHER;
    handler = (command, socket) =>
      socket.end(
        result(
          command,
          command.verb === 'gpu-apply-status' ? { ...native, employeeId: selectedEmployee, canApply: true } : native
        )
      );
    const foreign = await read();
    expect(foreign.statusCode).toBe(200);
    expect(foreign.json().data.gpuAccess).toEqual(native);
    selectedEmployee = eid;
    const current = await read();
    expect(current.statusCode).toBe(200);
    expect(current.json().data.gpuAccess.canApply).toBe(true);
    expect(replies.at(-1)).toMatchObject({
      stage: 'gpu-apply-status',
      ownerScopeDigest: replies.at(-2)?.ownerScopeDigest,
      expiresAtEpochMs: replies.at(-2)?.expiresAtEpochMs,
    });
    expect(requests.map(({ verb }) => verb)).toEqual([
      'gpu-status',
      'gpu-apply-status',
      'gpu-status',
      'gpu-apply-status',
      'gpu-status',
      'gpu-apply-status',
    ]);
  });
  it('keeps original status private if the owner is revoked during the optional readiness read', async () => {
    native = {
      ...native,
      revision: 5,
      requested: { enabled: false, deviceUuid: null, revision: 5 },
      active: { known: true, running: false, enabled: false, deviceUuid: null },
      state: 'pending',
    };
    handler = (command, socket) => {
      if (command.verb !== 'gpu-apply-status') return void socket.end(result(command, native));
      void app
        .inject({
          method: 'POST',
          url: '/api/owner/logout',
          cookies: { [OWNER_COOKIE]: token },
          headers: { origin: 'http://localhost' },
        })
        .then(() => socket.end());
    };
    const response = await app.inject({ url: url(eid), cookies: { [OWNER_COOKIE]: token } });
    expect(response.statusCode).toBe(403);
    expect(response.json()).not.toHaveProperty('data');
    expect(requests.map(({ verb }) => verb)).toEqual(['gpu-status', 'gpu-apply-status']);
  });
  it('rejects a stale Apply binding before Q and never repeats an unconfirmed Apply', async () => {
    const approval = { ...native.current, revision: 5, deviceUuid: DEVICE };
    const apply = (payload: unknown) =>
      app.inject({
        method: 'POST',
        url: url(eid) + '/apply',
        cookies: { [OWNER_COOKIE]: token },
        headers: { origin: 'http://localhost' },
        payload: payload as object,
      });
    expect((await apply({ ...approval, sessionId: OTHER })).statusCode).toBe(409);
    expect((await apply({ ...approval, revision: 0 })).statusCode).toBe(400);
    expect(requests).toEqual([]);
    handler = (_command, socket) => socket.end();
    const response = await apply(approval);
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toContain('not confirmed');
    expect(requests).toEqual([expect.objectContaining({ verb: 'gpu-apply', approval })]);
    expect(replies).toHaveLength(1);
  });
  it('rejects malformed native data and never leaks private socket or refusal text', async () => {
    for (const kind of ['oversized', 'extra', 'schema', 'refusal']) {
      handler = (command, socket) => {
        if (kind === 'oversized') {
          const header = Buffer.alloc(4);
          header.writeUInt32BE(2 ** 30);
          socket.end(header);
        } else if (kind === 'extra') {
          socket.end(frame({ kind: 'resource-result', requestId: command.requestId, value: native, extra: true }));
        } else if (kind === 'schema') {
          socket.end(result(command, { ...native, command: 'never-accepted' }));
        } else
          socket.end(
            frame({ kind: 'resource-refused', requestId: command.requestId, reason: 'SYNTHETIC_PRIVATE_REASON' })
          );
      };
      const response = await app.inject({ url: url(eid), cookies: { [OWNER_COOKIE]: token } });
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain('SYNTHETIC_PRIVATE_REASON');
      expect(response.body).not.toContain(socketPath);
    }
    expect(requests).toHaveLength(4);
  });
  it('keeps the original bounded deadline when the peer retains the channel', async () => {
    let admitted!: () => void;
    const accepted = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    handler = () => admitted();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pending = app
        .inject({ url: url(eid), cookies: { [OWNER_COOKIE]: token } })
        .then((response) => response.statusCode);
      await accepted;
      await vi.advanceTimersByTimeAsync(35001);
      expect(await pending).toBe(503);
      expect(requests).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it('refuses duplicate physical identities and keeps active access unconfirmed', () => {
    expect(
      EmployeeGpuStatus.safeParse({
        ...status(),
        choices: { known: true, devices: [status().choices.devices[0], status().choices.devices[0]] },
      }).success
    ).toBe(false);
    expect(EmployeeGpuStatus.parse(status()).active.enabled).toBeNull();
  });
});
