/** Real cookie/API and private socket transport controls. The scripted socket
 * supplies protocol DATA only; it is not a native offer, controller or grant. */
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { createServer, type Server, type Socket } from 'node:net';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OfficeAuthService } from '../src/owner-auth/office.js';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { PoolInstallationController, registerPoolInstallationRoutes } from '../src/pool-installation-controller.js';

const purpose = 'host-pool-installation-consent-v1';
const offerNonce = '10000000-0000-4000-8000-000000000001';
const viewNonce = '10000000-0000-4000-8000-000000000002';
const ownerNonce = '10000000-0000-4000-8000-000000000003';
let directory: string, app: FastifyInstance, auth: OfficeAuthService, token: string;
let controller: PoolInstallationController, server: Server, sockets: Set<Socket>;
let mode: 'normal' | 'foreign' | 'replay', connections: number, views: number, consents: number;
let errors: unknown[];
function send(socket: Socket, value: unknown) {
  const raw = Buffer.from(JSON.stringify(value)),
    header = Buffer.alloc(4);
  header.writeUInt32BE(raw.length);
  socket.write(Buffer.concat([header, raw]));
}
beforeEach(async () => {
  vi.stubEnv('REVERIE_MULTIUSER', '0');
  directory = await mkdtemp(join(tmpdir(), 'pool-client-'));
  auth = new OfficeAuthService({
    store: new OwnerAuthStore(join(directory, 'owner.json')),
    auditFile: join(directory, 'audit.jsonl'),
    setupEnabled: true,
  });
  token = await auth.setup('fixture-owner', 'Synthetic-pool-client-42!', 'Synthetic-pool-client-42!', '127.0.0.1');
  mode = 'normal';
  connections = 0;
  views = 0;
  consents = 0;
  errors = [];
  sockets = new Set();
  const policy = {
    version: 1,
    purpose: 'reverie-docker-worker-pool-v1',
    deployment: 'fixture',
    instanceRoot: directory,
    engineId: '10000000-0000-4000-8000-000000000004',
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
      greeted = false;
    let offer: Record<string, unknown> | undefined;
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        if (!greeted) {
          if (buffer.length < 5) return;
          expect(buffer[0]).toBe('B'.charCodeAt(0));
          const size = buffer.readUInt32BE(1);
          if (buffer.length < size + 5) return;
          expect(JSON.parse(buffer.subarray(5, 5 + size).toString())).toEqual({
            purpose: 'host-pool-registration-v1',
            version: 1,
          });
          buffer = buffer.subarray(5 + size);
          greeted = true;
          socket.write('POOL_REGISTRATION_CHANNEL_V1\n');
        }
        while (buffer.length >= 4) {
          const size = buffer.readUInt32BE(0);
          if (buffer.length < size + 4) return;
          const frame = JSON.parse(buffer.subarray(4, 4 + size).toString());
          buffer = buffer.subarray(4 + size);
          if (frame.kind === 'pool-installation-view') {
            const principal = auth.registrationIdentity(token);
            offer = {
              kind: 'pool-installation-offer',
              purpose,
              version: 1,
              requestId: frame.requestId,
              offerNonce,
              requestDigest: 'd'.repeat(64),
              principal:
                mode === 'foreign' ? { ...principal, accountId: '10000000-0000-4000-8000-000000000005' } : principal,
              policy,
              expiresAtEpochMs: Date.now() + 60_000,
            };
            send(socket, offer);
            send(socket, challenge(offer, 'pool-installation-view-check', viewNonce));
          } else if (frame.kind === 'pool-installation-view-current') {
            views++;
            expect(frame.principal).toEqual(offer!.principal);
            expect(frame).not.toHaveProperty('consent');
            send(socket, { ...offer, kind: 'pool-installation-viewed' });
          } else if (frame.kind === 'pool-installation-consent') {
            consents++;
            expect(frame.consent).toBe(true);
            expect(frame.requestId).toBe(offer!.requestId);
            send(
              socket,
              challenge(offer!, 'pool-installation-owner-check', mode === 'replay' ? viewNonce : ownerNonce)
            );
          } else {
            expect(frame.kind).toBe('pool-installation-owner-current');
            expect(frame.consent).toBe(true);
            expect(frame.nonce).toBe(ownerNonce);
            send(socket, {
              kind: 'pool-installation-result',
              purpose,
              version: 1,
              requestId: offer!.requestId,
              phase: 'pool-configured',
              observed: { fixtureDataOnly: true },
            });
          }
        }
      } catch (error) {
        errors.push(error);
        socket.destroy();
      }
    });
  });
  const path = join(directory, 'broker.sock');
  await new Promise<void>((resolve) => server.listen(path, resolve));
  await chmod(path, 0o600);
  controller = new PoolInstallationController(auth, path);
  app = Fastify();
  await app.register(cookie);
  registerPoolInstallationRoutes(app, controller);
});
function challenge(offer: Record<string, unknown>, kind: string, nonce: string) {
  return {
    kind,
    purpose,
    version: 1,
    requestId: offer.requestId,
    nonce,
    offerNonce,
    requestDigest: offer.requestDigest,
    principal: offer.principal,
  };
}
afterEach(async () => {
  controller.close();
  auth.logout(token);
  await app.close();
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
const post = (suffix: string, payload: object, authenticated = true) =>
  app.inject({
    method: 'POST',
    url: '/api/company/resources/fleet/installation/' + suffix,
    payload,
    headers: {
      host: 'localhost',
      origin: 'http://localhost',
      ...(authenticated ? { cookie: 'reverie_owner=' + token } : {}),
    },
  });
const consentBody = { consent: true, offerNonce, requestDigest: 'd'.repeat(64) };

it('keeps the same connection and original view through explicit consent, without implying a native grant', async () => {
  const viewed = await post('view', {});
  expect(viewed.statusCode).toBe(200);
  expect(consents).toBe(0);
  const requestId = viewed.json().data.requestId;
  expect((await post('view', {})).json().data.requestId).toBe(requestId);
  const result = await post(requestId + '/consent', consentBody);
  expect(result.statusCode).toBe(200);
  expect(result.json().data.state).toBe('settled');
  expect(connections).toBe(1);
  expect(views).toBe(1);
  expect(consents).toBe(1);
  expect(errors).toEqual([]);
});
it('refuses a guest before opening a B connection', async () => {
  expect((await post('view', {}, false)).statusCode).toBe(403);
  expect(connections).toBe(0);
  expect(consents).toBe(0);
});
it('does not answer a foreign nomination and can view the unchanged correctly nominated offer later', async () => {
  mode = 'foreign';
  expect((await post('view', {})).statusCode).toBe(403);
  expect(views).toBe(0);
  expect(consents).toBe(0);
  mode = 'normal';
  expect((await post('view', {})).statusCode).toBe(200);
  expect(connections).toBe(2);
  expect(views).toBe(1);
  expect(consents).toBe(0);
  expect(errors).toEqual([]);
});
it('retains an unknown outcome and never resends consent after a repeated challenge nonce', async () => {
  mode = 'replay';
  const requestId = (await post('view', {})).json().data.requestId;
  expect((await post(requestId + '/consent', consentBody)).statusCode).toBe(503);
  const result = await post(requestId + '/result', {});
  expect(result.json().data.state).toBe('unknown');
  expect(result.json().data.blocksFurtherChanges).toBe(true);
  expect((await post(requestId + '/consent', consentBody)).statusCode).toBe(503);
  expect(consents).toBe(1);
  expect(connections).toBe(1);
  expect(errors).toEqual([]);
});
