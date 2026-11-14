/** Actual canonical Company/owner auth and stop files. No native stop or helper
 * is admitted, including when current labels/HOME could describe a replacement. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { mkdtempSync, mkdirSync, renameSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyStore } from '../src/company-store.js';
import { CompanyService, type CompanyServiceDeps } from '../src/company-service.js';
import { EmployeeSchema } from '../src/company-types.js';
import { DockerOwnerStopDiagnostic } from '../src/docker-owner-stop-status.js';
import { registerDockerOwnerStopRoutes } from '../src/web/routes/docker-owner-stop-routes.js';
import { recordOwnerStop, ownerStopPending, useOwnerStopJournal } from '../src/owner-stop-journal.js';
import { PackagedDockerEngineCommand } from '../src/docker-engine-command.js';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { ownerVerifier } from '../src/owner-auth/marks.js';
import { registerOwnerPolicy } from '../src/owner-auth/policy.js';
import { registerAuthMiddleware } from '../src/web/middleware/auth.js';
import { ownerFor } from '../src/web/route-helpers.js';
import {
  DockerWorkerIdentityAuthentication,
  registerDockerWorkerIdentity,
  dockerWorkerIdentityOf,
  DOCKER_WORKER_IDENTITY_HEADER,
} from '../src/docker-worker-identity.js';
import type { SessionPort } from '../src/web/ports/session-port.js';

const eid = '11111111-1111-4111-8111-111111111111',
  sid = '22222222-2222-4222-8222-222222222222';
const actorId = '33333333-3333-4333-8333-333333333333',
  actorSid = '44444444-4444-4444-8444-444444444444';
const fence = '0123456789abcdef0123456789abcdef',
  request = { sessionId: sid, sessionGeneration: 3 };
const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  useOwnerStopJournal();
  vi.restoreAllMocks();
});
async function fixture(pending = true) {
  const root = mkdtempSync(join(tmpdir(), 'stop-status-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const stops = join(root, 'owner-stops');
  useOwnerStopJournal(stops);
  if (pending) recordOwnerStop(sid, { fence, notAfter: 1 });
  const companyStore = new CompanyStore(join(root, 'company.json'));
  await companyStore.init();
  const sessions = new Map([[actorSid, { id: actorSid, owner: undefined }]]);
  const company = new CompanyService(companyStore, {
    getSession: (id: string) => sessions.get(id),
    chatrooms: { rooms: () => [] },
    research: {},
  } as unknown as CompanyServiceDeps);
  await companyStore.update((state) => {
    state.employees = [
      EmployeeSchema.parse({
        id: eid,
        sessionId: sid,
        sessionGeneration: 3,
        name: 'Synthetic target',
        icon: 'X',
        position: 'Engineer',
        expertise: ['testing'],
        createdAt: 1,
        onVacation: true,
        desiredRunning: false,
      }),
      EmployeeSchema.parse({
        id: actorId,
        sessionId: actorSid,
        sessionGeneration: 1,
        name: 'Synthetic CTO',
        icon: 'M',
        position: 'CTO',
        expertise: ['testing'],
        createdAt: 1,
        onVacation: false,
        desiredRunning: true,
        permissions: { recoverEmployees: true, manageOffice: false },
      }),
    ];
  });
  const run = vi
    .spyOn(PackagedDockerEngineCommand.prototype, 'run')
    .mockRejectedValue(Error('No Engine action admitted'));
  const create = vi
    .spyOn(PackagedDockerEngineCommand.prototype, 'create')
    .mockRejectedValue(Error('No helper creation admitted'));
  const service = new DockerOwnerStopDiagnostic(company, () => {});
  return { root, stops, company, sessions, service, run, create };
}
function expectNoEffects(f: Awaited<ReturnType<typeof fixture>>) {
  expect(f.run).not.toHaveBeenCalled();
  expect(f.create).not.toHaveBeenCalled();
}

describe('legacy owner-stop diagnostic', () => {
  it('never expires or adopts a replacement HOME under the same SID/generation', async () => {
    const f = await fixture(),
      file = join(f.stops, sid + '.json');
    const before = readFileSync(file),
      inode = statSync(file).ino;
    const home = join(f.root, 'home');
    mkdirSync(home, { mode: 0o700 });
    const oldHomeInode = statSync(home).ino;
    renameSync(home, home + '-retained');
    mkdirSync(home, { mode: 0o700 });
    expect(statSync(home).ino).not.toBe(oldHomeInode);
    f.run.mockResolvedValue(
      JSON.stringify([{ Id: 'b'.repeat(64), Mounts: [{ Source: home, Destination: '/home/agent' }] }])
    );
    expect(f.service.status(eid, undefined)).toEqual({
      state: 'pending',
      ...request,
      allowedActions: [],
      code: 'DOCKER_OWNER_STOP_LEGACY_SCOPE_UNCONFIRMED',
    });
    expect(() => f.service.reconcile(eid, request, undefined)).toThrow('DOCKER_OWNER_STOP_LEGACY_SCOPE_UNCONFIRMED');
    useOwnerStopJournal(f.stops);
    expect(() => f.service.reconcile(eid, request, undefined)).toThrow('DOCKER_OWNER_STOP_LEGACY_SCOPE_UNCONFIRMED');
    expect(readFileSync(file)).toEqual(before);
    expect(statSync(file).ino).toBe(inode);
    expect(ownerStopPending(sid)).toBe(true);
    expectNoEffects(f);
  });
  it('reports no pending stop without claiming settlement or offering a repair action', async () => {
    const f = await fixture(false);
    expect(f.service.status(eid, undefined)).toEqual({ state: 'not-required', ...request, allowedActions: [] });
    expect(f.service.reconcile(eid, request, undefined)).toEqual({
      state: 'not-required',
      ...request,
      allowedActions: [],
    });
    expectNoEffects(f);
  });
  it('keeps an unreadable journal conservatively pending without inventing historical scope', async () => {
    const f = await fixture(false);
    writeFileSync(f.stops, 'synthetic non-directory');
    expect(f.service.status(eid, undefined)).toMatchObject({
      state: 'pending',
      allowedActions: [],
      code: 'DOCKER_OWNER_STOP_LEGACY_SCOPE_UNCONFIRMED',
    });
    expect(() => f.service.reconcile(eid, request, undefined)).toThrow('DOCKER_OWNER_STOP_LEGACY_SCOPE_UNCONFIRMED');
    expectNoEffects(f);
  });
  it('refuses a stale target and current identity/runtime revocation without changing its journal', async () => {
    const f = await fixture();
    expect(() => f.service.reconcile(eid, { ...request, sessionGeneration: 2 }, undefined)).toThrow(
      'DOCKER_OWNER_STOP_TARGET_CHANGED'
    );
    expect(() => f.service.reconcile(eid, { ...request, sessionId: actorSid }, undefined)).toThrow(
      'DOCKER_OWNER_STOP_TARGET_CHANGED'
    );
    let calls = 0;
    expect(() =>
      f.service.status(eid, undefined, undefined, () => {
        if (++calls === 2) throw Error('Actual request proof revoked');
      })
    ).toThrow('Actual request proof revoked');
    expect(() =>
      new DockerOwnerStopDiagnostic(f.company, () => {
        throw Error('Original runtime revoked');
      }).status(eid, undefined)
    ).toThrow('Original runtime revoked');
    expect(ownerStopPending(sid)).toBe(true);
    expectNoEffects(f);
  });
  it('uses actual HTTP owner/private-worker proofs and independent current manageOffice permission', async () => {
    const f = await fixture();
    const ownerAuth = new OwnerAuthService({
      store: new OwnerAuthStore(join(f.root, 'owner.json')),
      auditFile: join(f.root, 'owner-audit.jsonl'),
      setupEnabled: true,
    });
    const token = await ownerAuth.setup(
      'fixture-owner',
      'Synthetic-only-Ocean42!',
      'Synthetic-only-Ocean42!',
      '127.0.0.1'
    );
    const binding = {
      employeeId: actorId,
      owner: undefined,
      sessionId: actorSid,
      sessionGeneration: 1,
      containerId: '9'.repeat(64),
      credentialId: '55555555-5555-4555-8555-555555555555',
    };
    let identityCurrent = true;
    const identity = new DockerWorkerIdentityAuthentication(
      '66666666-6666-4666-8666-666666666666',
      Buffer.alloc(32, 0x51),
      { binding: () => (identityCurrent ? binding : undefined), keyCurrent: () => identityCurrent }
    );
    const workerToken = identity.issue(binding, () => true);
    const app = Fastify();
    await app.register(cookie);
    registerDockerWorkerIdentity(app, identity, '', { requireMachineProof: true });
    const authState = registerAuthMiddleware(app, false, '', ownerAuth);
    const ctx = { sessions: f.sessions } as unknown as SessionPort;
    registerOwnerPolicy(app, {
      service: ownerAuth,
      ctx,
      isCapabilityRequest: () => false,
      relations: {
        known: (id) => id === actorSid,
        related: (a, b) => a === b,
        coordinated: () => false,
        upward: () => false,
        keeper: () => false,
        admin: () => false,
      },
    });
    app.addHook('preHandler', (req, _reply, done) => {
      if (req.headers['x-fixture-revoke-owner'] === '1') ownerAuth.logout(token);
      done();
    });
    registerDockerOwnerStopRoutes(app, f.service, {
      verifiedOwner: ownerVerifier({ service: ownerAuth, ctx }),
      worker: dockerWorkerIdentityOf,
      owner: ownerFor,
    });
    await app.ready();
    cleanups.push(async () => {
      await app.close();
      for (const value of Object.values(authState)) value?.dispose();
    });
    const prefix = '/api/company/employees/' + eid + '/docker-stop';
    const ownerHeaders = { cookie: 'reverie_owner=' + token, origin: 'http://localhost', host: 'localhost' };
    const workerHeaders = { [DOCKER_WORKER_IDENTITY_HEADER]: workerToken, 'x-reverie-parent-session': actorSid };
    for (const headers of [{ 'x-reverie-parent-session': actorSid }, workerHeaders]) {
      expect((await app.inject({ method: 'GET', url: prefix + '/status', headers })).statusCode).toBe(403);
      expect(
        (await app.inject({ method: 'POST', url: prefix + '/reconcile', headers, payload: request })).statusCode
      ).toBe(403);
    }
    await f.company.store.update((state) => {
      state.employees[1]!.permissions.manageOffice = true;
    });
    const status = await app.inject({ method: 'GET', url: prefix + '/status', headers: workerHeaders });
    expect(status.statusCode).toBe(200);
    expect(status.json().data).toMatchObject({ state: 'pending', ...request, allowedActions: [] });
    const held = await app.inject({
      method: 'POST',
      url: prefix + '/reconcile',
      headers: ownerHeaders,
      payload: request,
    });
    expect(held.statusCode).toBe(409);
    expect(held.json().error).toEqual({ code: 'DOCKER_OWNER_STOP_LEGACY_SCOPE_UNCONFIRMED', allowedActions: [] });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: prefix + '/reconcile',
          headers: ownerHeaders,
          payload: { ...request, fence, sourceContainerId: 'a'.repeat(64) },
        })
      ).statusCode
    ).toBe(400);
    await f.company.store.update((state) => {
      state.employees[1]!.permissions.manageOffice = false;
    });
    expect((await app.inject({ method: 'GET', url: prefix + '/status', headers: workerHeaders })).statusCode).toBe(403);
    identityCurrent = false;
    expect((await app.inject({ method: 'GET', url: prefix + '/status', headers: workerHeaders })).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: prefix + '/status',
          headers: {
            ...ownerHeaders,
            'x-fixture-revoke-owner': '1',
          },
        })
      ).statusCode
    ).toBe(403);
    expect(ownerStopPending(sid)).toBe(true);
    expectNoEffects(f);
  });
});
