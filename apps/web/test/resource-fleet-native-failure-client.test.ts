/** Real owner cookie/context and private Q socket; scripted frames are DATA,
 * never a native installation, controller, execution or cleanup certificate. */
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { createServer, type Server, type Socket } from 'node:net';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { ResourceOwnerAuthority } from '../src/resource-owner-authority.js';
import { FleetNativeClient, NativeFleetMigrationFailureError } from '../src/resource-fleet-native-client.js';

const purpose = 'resource-fleet-maintenance-v1';
const operation = '10000000-0000-4000-8000-000000000001';
const preview = '10000000-0000-4000-8000-000000000002';
const nonce = (n: number) => `10000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const approval = {
  operationId: operation,
  previewId: preview,
  cohortDigest: 'a'.repeat(64),
  poolPolicyDigest: 'b'.repeat(64),
  coverageDigest: 'c'.repeat(64),
  revisionDigest: 'd'.repeat(64),
};
type Mode =
  | 'normal'
  | 'foreign-request'
  | 'foreign-approval'
  | 'unsafe-code'
  | 'extra-field'
  | 'confirmed-outcome'
  | 'revoked'
  | 'before-consent';
let directory: string, app: FastifyInstance, auth: OwnerAuthService, authority: ResourceOwnerAuthority;
let token: string, server: Server, client: FleetNativeClient | undefined, mode: Mode;
let error: unknown, errors: unknown[], connections: number, consents: number;
let sockets: Set<Socket>;
function send(socket: Socket, value: unknown) {
  const raw = Buffer.from(JSON.stringify(value)),
    header = Buffer.alloc(4);
  header.writeUInt32BE(raw.length);
  socket.write(Buffer.concat([header, raw]));
}
beforeEach(async () => {
  vi.stubEnv('REVERIE_MULTIUSER', '0');
  directory = await mkdtemp(join(tmpdir(), 'fleet-failure-'));
  auth = new OwnerAuthService({
    store: new OwnerAuthStore(join(directory, 'owner.json')),
    auditFile: join(directory, 'audit.jsonl'),
    setupEnabled: true,
  });
  const password = 'Synthetic-fleet-test-42!';
  token = await auth.setup('FixtureOwner', password, password, '127.0.0.1');
  authority = new ResourceOwnerAuthority(auth);
  mode = 'normal';
  errors = [];
  error = undefined;
  client = undefined;
  connections = 0;
  consents = 0;
  sockets = new Set();
  const policy = {
    version: 1,
    purpose: 'reverie-docker-worker-pool-v1',
    deployment: 'fixture',
    instanceRoot: directory,
    engineId: nonce(8),
    anchorImage: 'sha256:' + 'a'.repeat(64),
    controllerImage: 'sha256:' + 'b'.repeat(64),
    websiteContainer: 'c'.repeat(64),
    brokerUid: process.getuid!(),
    brokerGid: process.getgid!(),
    memoryMaxMiB: 49152,
    poolTasksMax: 8192,
    cpuWeight: 100,
    allowedCpus: [0, 1],
    employeeMemoryHighMiB: {},
  };
  server = createServer((socket) => {
    connections++;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0),
      greeted = false,
      request: Record<string, unknown> | undefined;
    const failure = () => {
      if (mode === 'revoked') auth.logout(token);
      const frame = {
        kind: 'fleet-migration-failure',
        purpose,
        version: 1,
        requestId: request!.requestId,
        approval,
        outcome: 'unconfirmed',
        code: 'WORKER_POOL_CONTROLLER_CONNECT_DEADLINE',
      };
      send(socket, {
        ...frame,
        ...(mode === 'foreign-request' ? { requestId: nonce(99) } : {}),
        ...(mode === 'foreign-approval' ? { approval: { ...approval, coverageDigest: 'f'.repeat(64) } } : {}),
        ...(mode === 'unsafe-code' ? { code: 'PRIVATE /home/example/config' } : {}),
        ...(mode === 'extra-field' ? { message: 'untrusted detail' } : {}),
        ...(mode === 'confirmed-outcome' ? { outcome: 'failed-before-effect' } : {}),
      });
    };
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        if (!greeted) {
          if (buffer.length < 5) return;
          const size = buffer.readUInt32BE(1);
          if (buffer.length < size + 5) return;
          expect(buffer[0]).toBe('Q'.charCodeAt(0));
          expect(JSON.parse(buffer.subarray(5, size + 5).toString())).toEqual({ purpose, version: 1 });
          buffer = buffer.subarray(size + 5);
          greeted = true;
          socket.write('FLEET_MAINTENANCE_CHANNEL_V1\n');
        }
        while (buffer.length >= 4) {
          const size = buffer.readUInt32BE(0);
          if (buffer.length < size + 4) return;
          const frame = JSON.parse(buffer.subarray(4, size + 4).toString());
          buffer = buffer.subarray(size + 4);
          if (frame.kind === 'fleet-preview') {
            request = frame;
            if (mode === 'before-consent') {
              failure();
              continue;
            }
            send(socket, {
              kind: 'fleet-preview-owner-check',
              purpose,
              version: 1,
              requestId: frame.requestId,
              principal: frame.principal,
              nonce: nonce(3),
            });
          } else if (frame.kind === 'fleet-preview-owner-current') {
            send(socket, {
              kind: 'fleet-preview',
              purpose,
              version: 1,
              requestId: request!.requestId,
              approval,
              policy,
              status: 'awaiting-maintenance-consent',
              expiresAtEpochMs: Date.now() + 30_000,
            });
          } else if (frame.kind === 'fleet-maintenance') {
            consents++;
            request = frame;
            send(socket, {
              kind: 'fleet-maintenance-owner-check',
              purpose,
              version: 1,
              requestId: frame.requestId,
              principal: frame.principal,
              nonce: nonce(4),
              approval,
              verb: 'migrate-pool',
            });
          } else {
            expect(frame.kind).toBe('fleet-maintenance-owner-current');
            expect(frame.nonce).toBe(nonce(4));
            failure();
          }
        }
      } catch (cause) {
        errors.push(cause);
        socket.destroy();
      }
    });
  });
  const path = join(directory, 'q.sock');
  await new Promise<void>((resolve) => server.listen(path, resolve));
  await chmod(path, 0o600);
  app = Fastify();
  await app.register(cookie);
  app.post('/preview', async (request, reply) => {
    try {
      client = await FleetNativeClient.open(path, authority, request);
      return await client.preview();
    } catch (cause) {
      error = cause;
      return reply.code(503).send({ error: cause instanceof Error ? cause.message : 'unknown' });
    }
  });
  app.post('/apply', async (request, reply) => {
    try {
      return await client!.migrate(request);
    } catch (cause) {
      error = cause;
      return reply.code(503).send({ error: cause instanceof Error ? cause.message : 'unknown' });
    }
  });
});
afterEach(async () => {
  client?.close();
  authority?.close();
  for (const socket of sockets ?? []) socket.destroy();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await app?.close();
  await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
  expect(errors).toEqual([]);
});
const post = (url: string, payload: unknown = {}) =>
  app.inject({
    method: 'POST',
    url,
    payload,
    headers: { host: 'localhost', origin: 'http://localhost', cookie: 'reverie_owner=' + token },
  });
const apply = () =>
  post('/apply', {
    previewId: preview,
    expectedRevision: approval.revisionDigest,
    consent: true,
    verb: 'migrate-pool',
  });

it('rejects immediately with the same-Q safe diagnostic and never reconnects or resends consent', async () => {
  expect((await post('/preview')).statusCode).toBe(200);
  const binding = client!.ownerBinding();
  expect(Object.isFrozen(binding) && Object.isFrozen(binding.principal)).toBe(true);
  expect(Object.keys(binding).sort()).toEqual(['owner', 'ownerScopeDigest', 'principal']);
  expect(() => authority.assertContext(binding as never)).toThrow();
  const started = Date.now();
  const response = await apply();
  expect(Date.now() - started).toBeLessThan(2_000);
  expect(response.statusCode).toBe(503);
  expect(error).toBeInstanceOf(NativeFleetMigrationFailureError);
  expect((error as NativeFleetMigrationFailureError).diagnostic).toMatchObject({
    approval,
    outcome: 'unconfirmed',
    code: 'WORKER_POOL_CONTROLLER_CONNECT_DEADLINE',
  });
  expect(response.json().error).toContain('Do not resend consent');
  await apply();
  expect(connections).toBe(1);
  expect(consents).toBe(1);
});
it.each(['foreign-request', 'foreign-approval', 'unsafe-code', 'extra-field', 'confirmed-outcome', 'revoked'] as const)(
  'refuses %s as an authenticated diagnostic',
  async (selected) => {
    mode = selected;
    expect((await post('/preview')).statusCode).toBe(200);
    expect((await apply()).statusCode).toBe(503);
    expect(error).not.toBeInstanceOf(NativeFleetMigrationFailureError);
    expect(connections).toBe(1);
    expect(consents).toBe(1);
  }
);
it('refuses a failure frame before original migration consent', async () => {
  mode = 'before-consent';
  expect((await post('/preview')).statusCode).toBe(503);
  expect(error).not.toBeInstanceOf(NativeFleetMigrationFailureError);
  expect(consents).toBe(0);
});
