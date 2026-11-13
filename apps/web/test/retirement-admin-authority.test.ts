/** Real policy/Relations/auth proofs; synthetic Sessions are never started. */
import { afterEach, expect, it, vi } from 'vitest';
import Fastify, { type LightMyRequestResponse } from 'fastify';
import cookie from '@fastify/cookie';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { addAdmin, removeAdmin } from '../src/owner-auth/admin.js';
import { ownerVerifier } from '../src/owner-auth/marks.js';
import { registerOwnerPolicy } from '../src/owner-auth/policy.js';
import { relations } from '../src/owner-auth/relations.js';
import { registerAuthMiddleware } from '../src/web/middleware/auth.js';
import { registerCompanyRoutes } from '../src/web/routes/company-routes.js';
import { installRouteErrorHandler } from '../src/web/route-error-handler.js';
import { CompanyStore } from '../src/company-store.js';
import { CompanyService, type CompanyServiceDeps } from '../src/company-service.js';
import { EmployeeSchema } from '../src/company-types.js';
import { Session } from '../src/session.js';
import type { SessionPort } from '../src/web/ports/session-port.js';

const ACTOR = '33333333-3333-4333-8333-333333333333';
const ACTOR_SID = '44444444-4444-4444-8444-444444444444';
const TARGET = '55555555-5555-4555-8555-555555555555';
const TARGET_SID = '66666666-6666-4666-8666-666666666666';
const PASSWORD = 'Synthetic-admin-transport-42';
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
afterEach(() => vi.unstubAllEnvs());

const cases = [
  'current',
  'list-revoked',
  'session-replaced',
  'owner-ABA',
  'credential-revoked',
  'account-epoch',
  'target-generation',
  'legacy-current',
  'legacy-mode-changed',
  'legacy-without-hook',
  'pre-handler-revoked',
] as const;
it.each(cases)('restore keeps genuine admin scope across queue: %s', async (change) => {
  const legacy = change.startsWith('legacy');
  vi.stubEnv('REVERIE_MULTIUSER', '0');
  vi.stubEnv('REVERIE_PASSWORD', legacy ? '' : PASSWORD);
  vi.stubEnv('REVERIE_USERNAME', 'synthetic-admin');
  const directory = await mkdtemp(join(tmpdir(), 'retirement-admin-'));
  const owner = new OwnerAuthService({
    store: new OwnerAuthStore(join(directory, 'owner.json')),
    auditFile: join(directory, 'owner-audit.jsonl'),
    setupEnabled: true,
  });
  await owner.setup('queue-owner', 'Synthetic-owner-only-queue-42', 'Synthetic-owner-only-queue-42', '127.0.0.1');
  await addAdmin(owner.store, ACTOR);
  const store = new CompanyStore(join(directory, 'company.json'));
  await store.init();
  const actor = EmployeeSchema.parse({
    id: ACTOR,
    sessionId: ACTOR_SID,
    sessionGeneration: 2,
    name: 'Synthetic admin',
    position: 'Reviewer',
    icon: 'R',
    expertise: ['synthetic'],
    permissions: {},
    createdAt: 1,
    desiredRunning: true,
  });
  const target = EmployeeSchema.parse({
    id: TARGET,
    sessionId: TARGET_SID,
    sessionGeneration: 2,
    name: 'Synthetic retired',
    position: 'Reviewer',
    icon: 'R',
    expertise: ['synthetic'],
    permissions: {},
    createdAt: 1,
    desiredRunning: false,
  });
  await store.update((state) => {
    state.employees.push(actor);
    state.retired.push({ ...target, retiredAt: 2 });
  });
  const before = store.snapshot();
  const originalSession = new Session({ id: ACTOR_SID, workingDir: directory, mode: 'shell', useMux: false });
  const sessions = new Map([[ACTOR_SID, originalSession]]);
  const ctx = { sessions } as unknown as SessionPort;
  const bound: string[] = [];
  const company = new CompanyService(store, {
    getSession: (id) => sessions.get(id),
    bindIdentity: (row) => {
      bound.push(row.id);
    },
    chatrooms: { rooms: () => [] } as unknown as CompanyServiceDeps['chatrooms'],
    research: {
      start: async () => {
        throw Error('No provider');
      },
      inspect: async () => undefined,
      stop: async () => {},
    },
  });
  const app = Fastify();
  await app.register(cookie);
  const authentication = change === 'legacy-without-hook' ? undefined : registerAuthMiddleware(app, false, '', owner);
  registerOwnerPolicy(app, {
    service: owner,
    ctx,
    isCapabilityRequest: () => false,
    relations: relations({
      known: (id) => sessions.has(id),
      recordedParent: () => undefined,
      predecessor: () => undefined,
      rooms: () => [],
      keepers: () => [],
      admins: () => owner.admins(),
      employeeOf: (sid) => store.snapshot().employees.find((row) => row.sessionId === sid)?.id,
    }),
  });
  registerCompanyRoutes(app, ctx, company, undefined, undefined, undefined, {
    verifiedOwner: ownerVerifier({ service: owner, ctx }),
  });
  if (change === 'pre-handler-revoked')
    app.addHook('preHandler', async () => {
      await removeAdmin(owner.store, ACTOR);
    });
  installRouteErrorHandler(app);
  await app.ready();
  const entered = deferred(),
    release = deferred();
  const blocker = store.update(
    (state) => {
      if (change === 'target-generation') state.retired.find((row) => row.id === TARGET)!.sessionGeneration++;
    },
    undefined,
    async () => {
      entered.release();
      await release.promise;
    }
  );
  let pending: Promise<LightMyRequestResponse> | undefined;
  try {
    await entered.promise;
    pending = app.inject({
      method: 'POST',
      url: `/api/company/employees/${change === 'pre-handler-revoked' ? '77777777-7777-4777-8777-777777777777' : TARGET}/restore`,
      headers: {
        host: 'localhost',
        origin: 'http://localhost',
        'x-reverie-parent-session': ACTOR_SID,
        ...(legacy ? {} : { authorization: 'Basic ' + Buffer.from('synthetic-admin:' + PASSWORD).toString('base64') }),
      },
      payload: {},
    });
    const result = Promise.resolve(pending);
    if (change !== 'legacy-without-hook' && change !== 'pre-handler-revoked') {
      // Read actual queue depth; no auth/writer/relation method is mocked.
      await Promise.race([
        expect.poll(() => Reflect.get(store, 'queued')).toBe(2),
        result.then((response) => {
          throw Error('Restore ended before real queue admission: ' + response.statusCode);
        }),
      ]);
      if (change === 'list-revoked') await removeAdmin(owner.store, ACTOR);
      if (change === 'session-replaced')
        sessions.set(ACTOR_SID, new Session({ id: ACTOR_SID, workingDir: directory, mode: 'shell', useMux: false }));
      if (change === 'owner-ABA') {
        originalSession.owner = 'different-owner';
        originalSession.owner = undefined;
      }
      // Same actual private map used by /api/auth/revoke; no boolean auth substitute.
      if (change === 'credential-revoked') authentication!.authSessions!.clear();
      if (change === 'account-epoch') await owner.logoutEverywhere('127.0.0.1');
      if (change === 'legacy-mode-changed') vi.stubEnv('REVERIE_PASSWORD', PASSWORD);
    }
    release.release();
    await blocker;
    const response = await result;
    const saved = JSON.parse(await readFile(store.file, 'utf8'));
    const allowed = change === 'current' || change === 'legacy-current';
    expect(response.statusCode, response.body).toBe(allowed ? 200 : change === 'target-generation' ? 409 : 403);
    if (allowed) {
      expect(saved.employees.some((row: { id: string }) => row.id === TARGET)).toBe(true);
      expect(saved.retired.some((row: { id: string }) => row.id === TARGET)).toBe(false);
      expect(bound).toEqual([TARGET]);
    } else {
      expect(saved.employees.some((row: { id: string }) => row.id === TARGET)).toBe(false);
      expect(saved.retired.some((row: { id: string }) => row.id === TARGET)).toBe(true);
      if (change !== 'target-generation') expect(saved).toEqual(before);
      expect(bound).toEqual([]);
    }
    expect(sessions.size).toBe(1);
    expect(store.snapshot()).toEqual(saved);
  } finally {
    release.release();
    await blocker;
    if (pending) await pending;
    await app.close();
    for (const value of Object.values(authentication ?? {})) value?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
