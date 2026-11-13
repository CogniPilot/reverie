/** Genuine owner cookie/verifier plus real canonical queue. No provider or engine. */
import { afterEach, expect, it, vi } from 'vitest';
import Fastify, { type FastifyRequest, type LightMyRequestResponse } from 'fastify';
import cookie from '@fastify/cookie';
import fs, { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { ownerVerifier } from '../src/owner-auth/marks.js';
import { OWNER_COOKIE, registerOwnerPolicy } from '../src/owner-auth/policy.js';
import {
  AUTH_COOKIE_NAME,
  humanTransportContinuation,
  registerAuthMiddleware,
  recheckTransportAuthentication,
} from '../src/web/middleware/auth.js';
import { createUser, updateUser, setPassword, invalidateUsersCache, touchLastLogin } from '../src/user-store.js';
import { registerCompanyRoutes } from '../src/web/routes/company-routes.js';
import { installRouteErrorHandler } from '../src/web/route-error-handler.js';
import { CompanyStore } from '../src/company-store.js';
import { CompanyService, type CompanyServiceDeps } from '../src/company-service.js';
import { EmployeeSchema } from '../src/company-types.js';
import type { SessionPort } from '../src/web/ports/session-port.js';

const EMPLOYEE = '11111111-1111-4111-8111-111111111111';
const SID = '22222222-2222-4222-8222-222222222222';
const PAT_ID = '88888888-8888-4888-8888-888888888888';
const PASSWORD = 'Synthetic-only-queue-auth-42';
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
afterEach(() => {
  invalidateUsersCache();
  vi.unstubAllEnvs();
});

type QueueCase = {
  action: 'retire' | 'restore' | 'permissions' | 'pat-revoke';
  transport: 'owner-cookie' | 'owner-login' | 'basic' | 'browser-cookie' | 'missing-middleware';
  change:
    | 'none'
    | 'logout'
    | 'logout-after-save'
    | 'disabled'
    | 'password'
    | 'demotion'
    | 'mode'
    | 'missing-proof'
    | 'role-aba'
    | 'mode-aba'
    | 'identity'
    | 'cookie';
};
const queueCases: QueueCase[] = [];
for (const action of ['retire', 'restore'] as const) {
  for (const transport of ['owner-cookie', 'owner-login'] as const)
    for (const change of ['none', 'logout'] as const) queueCases.push({ action, transport, change });
  queueCases.push({ action, transport: 'missing-middleware', change: 'missing-proof' });
  for (const change of ['role-aba', 'mode-aba', 'identity', 'cookie'] as const)
    queueCases.push({ action, transport: 'basic', change });
  for (const transport of ['basic', 'browser-cookie'] as const)
    for (const change of ['none', 'disabled', 'password', 'demotion', 'mode'] as const)
      queueCases.push({ action, transport, change });
}

for (const action of ['permissions', 'pat-revoke'] as const)
  for (const change of ['none', 'logout', 'logout-after-save'] as const)
    queueCases.push({ action, transport: 'owner-cookie', change });

it.each(queueCases)(
  '$action rechecks owner and $transport after canonical queue wait ($change)',
  async ({ action, transport, change }) => {
    const profileChange = action === 'permissions' || action === 'pat-revoke';
    const multi = transport === 'basic' || transport === 'browser-cookie';
    const revoke = change !== 'none';
    vi.stubEnv('REVERIE_MULTIUSER', multi ? '1' : '0');
    vi.stubEnv('REVERIE_PASSWORD', transport === 'owner-login' ? PASSWORD : '');
    const directory = await mkdtemp(join(tmpdir(), 'retirement-authority-'));
    vi.stubEnv('REVERIE_DATA_DIR', directory);
    invalidateUsersCache();
    if (multi) {
      await createUser({ username: 'queue-owner', role: 'admin', password: PASSWORD });
      await createUser({ username: 'backstop-admin', role: 'admin', password: PASSWORD });
    }
    const owner = new OwnerAuthService({
      store: new OwnerAuthStore(join(directory, 'owner.json')),
      auditFile: join(directory, 'owner-audit.jsonl'),
      setupEnabled: true,
    });
    const token = await owner.setup('queue-owner', PASSWORD, PASSWORD, '127.0.0.1');
    const store = new CompanyStore(join(directory, 'company.json'));
    await store.init();
    const employee = EmployeeSchema.parse({
      id: EMPLOYEE,
      ...(multi ? { owner: 'queue-owner' } : {}),
      sessionId: SID,
      sessionGeneration: 2,
      name: 'Synthetic reviewee',
      position: 'Reviewer',
      icon: 'R',
      expertise: ['synthetic'],
      permissions: action === 'pat-revoke' ? { publicationTokenIds: [PAT_ID] } : {},
      createdAt: 1,
      desiredRunning: false,
      onVacation: false,
    });
    await store.update((state) => {
      if (action === 'retire' || profileChange) state.employees.push(employee);
      else state.retired.push({ ...employee, retiredAt: 2 });
    });
    const before = store.snapshot();
    const sessions = new Map();
    const ctx = { sessions } as unknown as SessionPort;
    const bindings: string[] = [];
    const company = new CompanyService(store, {
      getSession: (id) => sessions.get(id),
      bindIdentity: (record) => {
        bindings.push(record.id);
      },
      chatrooms: { rooms: () => [] } as unknown as CompanyServiceDeps['chatrooms'],
      research: {
        start: async () => {
          throw Error('No runtime producer');
        },
        inspect: async () => undefined,
        stop: async () => {},
      },
    });
    const app = Fastify();
    await app.register(cookie);
    const authentication =
      transport === 'missing-middleware' ? undefined : registerAuthMiddleware(app, false, '', owner);
    registerOwnerPolicy(app, {
      service: owner,
      ctx,
      isCapabilityRequest: () => false,
      relations: {
        known: () => false,
        related: () => false,
        coordinated: () => false,
        upward: () => false,
        keeper: () => false,
        admin: () => false,
      },
    });
    const verify = ownerVerifier({ service: owner, ctx });
    const admitted = deferred();
    let originalRequest: FastifyRequest | undefined;
    registerCompanyRoutes(app, ctx, company, undefined, undefined, undefined, {
      verifiedOwner: (request) => {
        const actual = verify(request);
        if (actual && (request.method === 'POST' || request.method === 'PUT')) {
          originalRequest = request;
          admitted.release();
        }
        return actual;
      },
    });
    installRouteErrorHandler(app);
    await app.ready();
    expect(owner.policy()).toBe('enforce');
    let transportCookie: string | undefined;
    const basic = 'Basic ' + Buffer.from('queue-owner:' + PASSWORD).toString('base64');
    if (transport === 'browser-cookie') {
      const login = await app.inject({
        method: 'GET',
        url: '/api/company',
        headers: { host: 'localhost', cookie: `${OWNER_COOKIE}=${token}`, authorization: basic },
      });
      expect(login.statusCode, login.body).toBe(200);
      const issued = login.cookies.find((row) => row.name === AUTH_COOKIE_NAME);
      expect(issued).toBeDefined();
      transportCookie = `${AUTH_COOKIE_NAME}=${issued!.value}`;
    }
    const queued = deferred(),
      releaseWriter = deferred();
    // The earlier real canonical transaction owns its actual writer lock while
    // its optional beforeSave observer waits. No Store/auth method is mocked.
    const blocker = store.update(
      () => {},
      undefined,
      async () => {
        queued.release();
        await releaseWriter.promise;
      }
    );
    let pending: Promise<LightMyRequestResponse> | undefined;
    let restoreLateLogout: (() => void) | undefined;
    let canonicalRenames = 0;
    try {
      await queued.promise;
      pending = app.inject({
        method: profileChange ? 'PUT' : 'POST',
        url:
          `/api/company/employees/${EMPLOYEE}` +
          (action === 'permissions' ? '' : action === 'pat-revoke' ? `/publication-tokens/${PAT_ID}` : `/${action}`),
        headers: {
          host: 'localhost',
          origin: 'http://localhost',
          cookie: [`${OWNER_COOKIE}=${token}`, transportCookie].filter(Boolean).join('; '),
          ...(transport === 'basic' ? { authorization: basic } : {}),
        },
        payload:
          action === 'permissions'
            ? { permissions: { recoverEmployees: true } }
            : action === 'pat-revoke'
              ? { enabled: false }
              : {},
      });
      const responsePromise = Promise.resolve(pending);
      await Promise.race([
        admitted.promise,
        responsePromise.then((response) => {
          throw Error('Request ended before genuine owner admission: ' + response.statusCode);
        }),
      ]);
      // Observe the actual two queued transactions; never replace the writer.
      if (transport !== 'missing-middleware') await expect.poll(() => Reflect.get(store, 'queued')).toBe(2);
      expect(originalRequest).toBeDefined();
      expect(verify(originalRequest!)).toBe(true);
      if (change === 'logout') {
        owner.logout(token);
        expect(owner.session(token)).toBeUndefined();
        expect(verify(originalRequest!)).toBe(false);
      }
      if (multi) {
        if (change === 'disabled') await updateUser('queue-owner', { disabled: true });
        if (change === 'password') await setPassword('queue-owner', PASSWORD + '-changed');
        if (change === 'demotion') await updateUser('queue-owner', { role: 'user' });
        if (change === 'mode') vi.stubEnv('REVERIE_MULTIUSER', '0');
        expect(verify(originalRequest!)).toBe(true);
        if (change !== 'mode')
          expect(await recheckTransportAuthentication(originalRequest!)).toBe(
            !['disabled', 'password', 'demotion'].includes(change)
          );
        const continuation = humanTransportContinuation(originalRequest!)!;
        if (change === 'role-aba') {
          await updateUser('queue-owner', { role: 'user' });
          expect(await continuation()).toBe(false);
          await updateUser('queue-owner', { role: 'admin' });
          expect(await recheckTransportAuthentication(originalRequest!)).toBe(true);
          expect(await continuation()).toBe(false);
        }
        if (change === 'mode-aba') {
          vi.stubEnv('REVERIE_MULTIUSER', '0');
          expect(await continuation()).toBe(false);
          vi.stubEnv('REVERIE_MULTIUSER', '1');
          expect(await recheckTransportAuthentication(originalRequest!)).toBe(true);
          expect(await continuation()).toBe(false);
        }
        if (change === 'identity') originalRequest!.authUser = { ...originalRequest!.authUser! };
        if (change === 'cookie') {
          const successor = await owner.login('queue-owner', PASSWORD, '127.0.0.1');
          if (!('session' in successor)) throw Error('Genuine owner login did not return a cookie');
          originalRequest!.cookies[OWNER_COOKIE] = successor.session;
          expect(verify(originalRequest!)).toBe(true);
        }
      }
      if (change === 'logout-after-save') {
        const actualRename = fs.rename.bind(fs);
        const lateLogoutRename = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
          await actualRename(from, to);
          if (to === store.file && ++canonicalRenames === 2) {
            // The actual target rename has completed. The original canonical
            // writer still performs its own directory sync and checked close.
            owner.logout(token);
            expect(verify(originalRequest!)).toBe(false);
          }
        });
        restoreLateLogout = () => lateLogoutRename.mockRestore();
      }
      releaseWriter.release();
      await blocker;
      const response = await responsePromise;
      const disk = JSON.parse(await readFile(store.file, 'utf8'));
      if (profileChange) {
        expect(sessions.size).toBe(0);
        expect(store.snapshot()).toEqual(disk);
        if (response.statusCode === 200) {
          if (action === 'permissions') expect(disk.employees[0].permissions.recoverEmployees).toBe(true);
          else expect(disk.employees[0].permissions.publicationTokenIds).toEqual([]);
        }
      }
      console.info(
        'RETIREMENT_QUEUE_AUTH_OBSERVATION',
        JSON.stringify({
          action,
          ...(profileChange
            ? { permissionsBefore: before.employees[0].permissions, permissionsAfter: disk.employees[0].permissions }
            : {}),
          transport,
          change,
          status: response.statusCode,
          actualOwnerBefore: true,
          actualOwnerAfter: verify(originalRequest!),
          canonicalActive: store.snapshot().employees.some((row) => row.id === EMPLOYEE),
          canonicalRetired: store.snapshot().retired.some((row) => row.id === EMPLOYEE),
          diskActive: disk.employees.some((row: { id: string }) => row.id === EMPLOYEE),
          diskRetired: disk.retired.some((row: { id: string }) => row.id === EMPLOYEE),
          sessions: sessions.size,
          bindingCallbacks: bindings.length,
        })
      );
      if (change === 'logout-after-save') {
        expect(canonicalRenames).toBe(2);
        expect(response.statusCode, response.body).toBe(503);
        expect(response.body).toContain('may already be saved');
        expect(response.body).toContain('Sign in again');
        expect(response.body).not.toContain('Synthetic reviewee');
        expect(store.snapshot()).toEqual(disk);
        expect(bindings).toEqual([]);
        if (action === 'permissions') expect(disk.employees[0].permissions.recoverEmployees).toBe(true);
        else expect(disk.employees[0].permissions.publicationTokenIds).toEqual([]);
      } else if (revoke) {
        expect(response.statusCode, response.body).toBe(403);
        expect(store.snapshot()).toEqual(before);
        expect(disk).toEqual(before);
        expect(bindings).toEqual([]);
      } else if (profileChange) {
        expect(response.statusCode, response.body).toBe(200);
        expect(disk.employees.some((row: { id: string }) => row.id === EMPLOYEE)).toBe(true);
        expect(disk.retired).toEqual([]);
        expect(store.snapshot()).toEqual(disk);
        expect(bindings).toEqual(action === 'permissions' ? [EMPLOYEE] : []);
        if (action === 'permissions') expect(disk.employees[0].permissions.recoverEmployees).toBe(true);
        else expect(disk.employees[0].permissions.publicationTokenIds).toEqual([]);
      } else {
        expect(response.statusCode, response.body).toBe(200);
        expect(disk.employees.some((row: { id: string }) => row.id === EMPLOYEE)).toBe(action === 'restore');
        expect(disk.retired.some((row: { id: string }) => row.id === EMPLOYEE)).toBe(action === 'retire');
        expect(store.snapshot()).toEqual(disk);
        expect(bindings).toEqual(action === 'restore' ? [EMPLOYEE] : []);
      }
      expect(sessions.size).toBe(0);
    } finally {
      releaseWriter.release();
      await blocker;
      if (pending) await pending;
      restoreLateLogout?.();
      await app.close();
      for (const value of Object.values(authentication ?? {})) value?.dispose();
      // Join the actual user-store mutation chain after Basic's background login touch.
      if (multi) await touchLastLogin('queue-owner');
      invalidateUsersCache();
      await rm(directory, { recursive: true, force: true });
    }
  }
);

it.each([true, false])('awaits actual pre-rename authority guard (revoke=%s)', async (revoke) => {
  const directory = await mkdtemp(join(tmpdir(), 'retirement-writer-'));
  const store = new CompanyStore(join(directory, 'company.json'));
  await store.init();
  await store.update(() => undefined);
  const before = await readFile(store.file, 'utf8');
  const checking = deferred(),
    release = deferred();
  const refusal = Error('Original authority revoked before rename');
  let checks = 0,
    authorized = true;
  const publication = store.updateOutcome(
    (state) => {
      state.memories.push({
        id: 'synthetic-guard',
        employeeId: EMPLOYEE,
        at: 1,
        kind: 'note',
        text: 'Synthetic pending change',
      });
    },
    async () => {
      checks++;
      if (checks === 2) {
        checking.release();
        await release.promise;
      }
      if (!authorized) throw refusal;
    }
  );
  try {
    await checking.promise;
    expect(checks).toBe(2);
    expect(await readFile(store.file, 'utf8')).toBe(before);
    let returned = false;
    void publication.then(() => {
      returned = true;
    });
    await Promise.resolve();
    expect(returned).toBe(false);
    if (revoke) authorized = false;
    release.release();
    const outcome = await publication;
    if (revoke) {
      expect(outcome).toEqual({ state: 'not-issued', cause: refusal });
      expect(await readFile(store.file, 'utf8')).toBe(before);
      expect(store.snapshot()).toEqual(JSON.parse(before));
      // A known pre-rename refusal does not turn into sticky uncertainty.
      await expect(store.update(() => undefined)).resolves.toBeUndefined();
    } else {
      expect(outcome.state).toBe('committed');
      expect(JSON.parse(await readFile(store.file, 'utf8')).memories[0].text).toBe('Synthetic pending change');
    }
  } finally {
    release.release();
    await publication;
    await rm(directory, { recursive: true, force: true });
  }
});

it('keeps synchronous pre-rename validation adjacent to actual canonical rename issuance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'retirement-sync-writer-'));
  const store = new CompanyStore(join(directory, 'company.json'));
  await store.init();
  await store.update(() => undefined);
  let checks = 0;
  const events: string[] = [];
  const actualRename = fs.rename.bind(fs);
  const rename = vi.spyOn(fs, 'rename').mockImplementation((from, to) => {
    if (to === store.file) events.push('actual-rename-issued');
    // Observe the actual original writer call; never replace its publication.
    return actualRename(from, to);
  });
  try {
    const outcome = await store.updateOutcome(
      (state) => {
        state.memories.push({ id: 'sync-guard', employeeId: EMPLOYEE, at: 1, kind: 'note', text: 'Same-turn guard' });
      },
      () => {
        if (++checks === 2) {
          events.push('pre-rename-validated');
          queueMicrotask(() => {
            events.push('queued-revocation');
          });
        }
      }
    );
    expect(outcome.state).toBe('committed');
    expect(checks).toBe(2);
    expect(JSON.parse(await readFile(store.file, 'utf8')).memories[0].text).toBe('Same-turn guard');
    expect(events).toEqual(['pre-rename-validated', 'actual-rename-issued', 'queued-revocation']);
  } finally {
    rename.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});
