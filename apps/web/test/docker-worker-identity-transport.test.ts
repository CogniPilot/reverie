/** Real Fastify middleware/policy fixtures; no engine or provider effects. */
import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DockerWorkerIdentityAuthentication,
  registerDockerWorkerIdentity,
  dockerWorkerIdentityOf,
  DOCKER_WORKER_IDENTITY_HEADER,
  type DockerWorkerIdentityBinding,
} from '../src/docker-worker-identity.js';
import {
  registerAuthMiddleware,
  humanTransportContinuation,
  credentiallessTransportCurrent,
} from '../src/web/middleware/auth.js';
import { callerOf, registerOwnerPolicy, ownerEventReadAdmission } from '../src/owner-auth/policy.js';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { ownerFor } from '../src/web/route-helpers.js';
import type { SessionPort } from '../src/web/ports/session-port.js';

const binding: DockerWorkerIdentityBinding = {
  employeeId: '22222222-2222-4222-8222-222222222222',
  sessionId: '33333333-3333-4333-8333-333333333333',
  sessionGeneration: 1,
  owner: undefined,
  containerId: 'a'.repeat(64),
  credentialId: '44444444-4444-4444-8444-444444444444',
};
const stranger = '55555555-5555-4555-8555-555555555555';
const apps: FastifyInstance[] = [],
  directories: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
  delete process.env.REVERIE_PASSWORD;
  delete process.env.REVERIE_MULTIUSER;
});
async function fixture(
  policy: 'off' | 'log' | 'enforce',
  password = true,
  register = true,
  transport: { requireMachineProof?: boolean; basePath?: string; owner?: boolean } = {}
) {
  if (password) process.env.REVERIE_PASSWORD = 'synthetic-password';
  else delete process.env.REVERIE_PASSWORD;
  const dir = await mkdtemp(join(tmpdir(), 'docker-identity-'));
  directories.push(dir);
  const store = new OwnerAuthStore(join(dir, 'owner.json'));
  if (!transport.owner) await writeFile(store.markerFile, policy + '\n', { mode: 0o600 });
  const service = new OwnerAuthService({ store, auditFile: join(dir, 'audit.jsonl'), setupEnabled: transport.owner });
  const ownerCookie = transport.owner
    ? await service.setup('synthetic-owner', 'Bright-river-factory-742!', 'Bright-river-factory-742!', '127.0.0.1')
    : undefined;
  const basePath = transport.basePath ?? '';
  const ctx = {
    sessions: new Map([
      [binding.sessionId, { id: binding.sessionId, owner: undefined }],
      [stranger, { id: stranger, owner: undefined }],
    ]),
  } as unknown as SessionPort;
  let selected: DockerWorkerIdentityBinding | undefined = { ...binding };
  const auth = new DockerWorkerIdentityAuthentication('11111111-1111-4111-8111-111111111111', Buffer.alloc(32, 0x51), {
    binding: () => selected,
    keyCurrent: () => true,
  });
  const token = auth.issue(binding, () => true);
  const app = Fastify();
  apps.push(app);
  await app.register(fastifyCookie);
  if (register) registerDockerWorkerIdentity(app, auth, basePath, transport);
  registerAuthMiddleware(app, false, basePath, service);
  registerOwnerPolicy(app, {
    service,
    ctx,
    isCapabilityRequest: () => false,
    relations: {
      known: () => true,
      related: (a, b) => a === b,
      coordinated: () => false,
      upward: () => false,
      keeper: () => false,
      admin: () => false,
    },
  });
  app.get(basePath + '/api/sessions', async (req) => ({
    caller: callerOf(req, { service, ctx }),
    owner: ownerFor(req),
    human: humanTransportContinuation(req) !== undefined,
    credentialless: credentiallessTransportCurrent(req),
    globalEvents: ownerEventReadAdmission(req)?.current(),
  }));
  app.post(basePath + '/api/sessions/:id/input', async () => ({ accepted: true }));
  app.put(basePath + '/api/settings', async () => ({ changed: true }));
  let callbackEffects = 0;
  for (const path of ['/api/hook-event', '/api/status-telemetry', '/api/v1/hook-event', '/api/v1/status-telemetry'])
    app.post(basePath + path, async () => ({ effects: ++callbackEffects }));
  app.get(basePath + '/api/sessions/:id/terminal', async (req) => {
    const original = dockerWorkerIdentityOf(req)!;
    selected = undefined;
    delete req.headers[DOCKER_WORKER_IDENTITY_HEADER];
    return { current: original.current(), caller: callerOf(req, { service, ctx }) };
  });
  await app.ready();
  const headers = { [DOCKER_WORKER_IDENTITY_HEADER]: token, 'x-reverie-parent-session': binding.sessionId };
  return { app, auth, headers, ownerCookie, callbackEffects: () => callbackEffects };
}
describe('actual boxed worker transport', () => {
  it.each(['off', 'log', 'enforce'] as const)(
    'requires actual machine proof for boxed parent hints under policy %s',
    async (policy) => {
      const f = await fixture(policy, true, true, { requireMachineProof: true });
      const authorization = 'Basic ' + Buffer.from('admin:synthetic-password').toString('base64');
      for (const parent of [binding.sessionId, stranger, stranger.slice(0, 8), ''])
        expect(
          (
            await f.app.inject({
              url: '/api/sessions',
              headers: { authorization, 'x-reverie-parent-session': parent },
            })
          ).statusCode
        ).toBe(403);
      expect((await f.app.inject({ url: '/api/sessions', headers: f.headers })).statusCode).toBe(200);
      expect(
        (
          await f.app.inject({
            url: '/api/sessions',
            headers: { ...f.headers, 'x-reverie-parent-session': stranger },
          })
        ).statusCode
      ).toBe(403);
    }
  );
  it.each(['', '/office'])(
    'requires boxed callback proof with base path %s, including aliases and queries',
    async (basePath) => {
      const f = await fixture('off', true, true, { requireMachineProof: true, basePath });
      const authorization = 'Basic ' + Buffer.from('admin:synthetic-password').toString('base64');
      for (const path of [
        '/api/hook-event',
        '/api/status-telemetry',
        '/api/v1/hook-event',
        '/api/v1/status-telemetry',
      ]) {
        const url = basePath + path + '?synthetic=1';
        expect(
          (
            await f.app.inject({
              method: 'POST',
              url,
              headers: { authorization },
              payload: { sessionId: stranger },
            })
          ).statusCode
        ).toBe(403);
        expect(f.callbackEffects()).toBe(0);
      }
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: basePath + '/api/v1/hook-event',
            headers: f.headers,
            payload: { sessionId: stranger },
          })
        ).statusCode
      ).toBe(403);
    }
  );
  it('preserves the actual signed-in owner without a parent hint in boxed mode', async () => {
    const f = await fixture('enforce', true, true, { requireMachineProof: true, owner: true });
    expect(f.ownerCookie).toBeTypeOf('string');
    expect(
      (
        await f.app.inject({
          method: 'PUT',
          url: '/api/settings',
          cookies: { reverie_owner: f.ownerCookie! },
          headers: { origin: 'http://localhost' },
          payload: {},
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await f.app.inject({
          method: 'PUT',
          url: '/api/settings',
          cookies: { reverie_owner: f.ownerCookie! },
          headers: { 'x-reverie-parent-session': stranger },
          payload: {},
        })
      ).statusCode
    ).toBe(403);
  });
  it('preserves the legacy parent-hint transport only when boxed enforcement is not selected', async () => {
    const f = await fixture('off');
    const response = await f.app.inject({
      url: '/api/sessions',
      headers: {
        authorization: 'Basic ' + Buffer.from('admin:synthetic-password').toString('base64'),
        'x-reverie-parent-session': stranger,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().caller).toEqual({ kind: 'agent', session: stranger });
  });

  it.each(['/api/hook-event', '/api/status-telemetry'])(
    'binds callback body target at %s to the authenticated SID',
    async (path) => {
      const f = await fixture('off');
      expect(
        (await f.app.inject({ method: 'POST', url: path, headers: f.headers, payload: { sessionId: stranger } }))
          .statusCode
      ).toBe(403);
      expect(f.callbackEffects()).toBe(0);
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: path,
            headers: f.headers,
            payload: { sessionId: binding.sessionId },
          })
        ).statusCode
      ).toBe(200);
      expect(f.callbackEffects()).toBe(1);
    }
  );
  it.each(['off', 'log', 'enforce'] as const)(
    'keeps machine route and relationship scope under human policy %s',
    async (policy) => {
      const f = await fixture(policy);
      const probe = await f.app.inject({ url: '/api/sessions', headers: f.headers });
      expect(probe.statusCode).toBe(200);
      expect(probe.json()).toEqual({
        caller: { kind: 'agent', session: binding.sessionId },
        human: false,
        credentialless: false,
        globalEvents: false,
      });
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: '/api/sessions/' + binding.sessionId + '/input',
            headers: f.headers,
            payload: {},
          })
        ).statusCode
      ).toBe(200);
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: '/api/sessions/' + stranger + '/input',
            headers: f.headers,
            payload: {},
          })
        ).statusCode
      ).toBe(403);
      expect(
        (await f.app.inject({ method: 'PUT', url: '/api/settings', headers: f.headers, payload: {} })).statusCode
      ).toBe(403);
    }
  );
  it('does not record credentialless human authority when no human password is configured', async () => {
    const f = await fixture('off', false);
    const response = await f.app.inject({ url: '/api/sessions', headers: f.headers });
    expect(response.statusCode).toBe(200);
    expect(response.json().human).toBe(false);
    expect(response.json().credentialless).toBe(false);
  });
  it('requires the real registration hook, not just a valid signed header', async () => {
    const f = await fixture('off', true, false);
    expect((await f.app.inject({ url: '/api/sessions', headers: f.headers })).statusCode).toBe(403);
  });
  it('refuses wrong/full-prefix SID and all mixed human/agent credentials before handlers', async () => {
    const f = await fixture('off');
    for (const headers of [
      { ...f.headers, 'x-reverie-parent-session': stranger },
      { ...f.headers, 'x-reverie-parent-session': binding.sessionId.slice(0, 8) },
      { ...f.headers, authorization: 'Basic ' + Buffer.from('admin:synthetic-password').toString('base64') },
      { ...f.headers, cookie: 'reverie_owner=synthetic' },
      { ...f.headers, 'x-reverie-service-token': 'synthetic' },
    ])
      expect((await f.app.inject({ url: '/api/sessions', headers })).statusCode).toBe(403);
  });
  it('never falls back to a parent hint after the actual token proof is revoked', async () => {
    const f = await fixture('off');
    const res = await f.app.inject({ url: '/api/sessions/' + binding.sessionId + '/terminal', headers: f.headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ current: false, caller: { kind: 'invalid' } });
  });
  it('refuses unsupported multi-user machine adapter and live mode changes', async () => {
    const f = await fixture('off');
    process.env.REVERIE_MULTIUSER = '1';
    expect((await f.app.inject({ url: '/api/sessions', headers: f.headers })).statusCode).toBe(403);
  });
  it('preserves existing human compatibility policy off', async () => {
    const f = await fixture('off');
    const authorization = 'Basic ' + Buffer.from('admin:synthetic-password').toString('base64');
    expect(
      (await f.app.inject({ method: 'PUT', url: '/api/settings', headers: { authorization }, payload: {} })).statusCode
    ).toBe(200);
  });
});
