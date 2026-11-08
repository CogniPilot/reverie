/** Real owner/session/CompanyStore fixtures. No listener, PTY, engine or Q
 * authority is fabricated; native reply values below are metadata DATA only. */
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanyStore } from '../src/company-store.js';
import { CompanyService } from '../src/company-service.js';
import { Session } from '../src/session.js';
import { expertRuntimeRecipe } from '../src/expert-runtime-recipe.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import {
  ResourceOwnerAuthority,
  type RamResourceApproval,
  type RamResourceOwnerBinding,
  type RamResourcePreviewContext,
  type ResourceOwnerBinding,
  type RamResourceSessionIntent,
} from '../src/resource-owner-authority.js';
import { ramResourceWorkerLaunch } from '../src/resource-worker-launch.js';
import { ResourceSessionLaunchTask } from '../src/resource-native-client.js';
import { RamResourceSessionPublication, ResourceSessionPublication } from '../src/resource-session-publication.js';
import type { SessionPort } from '../src/web/ports/session-port.js';
import type { TerminalMultiplexer } from '../src/mux-interface.js';

const password = 'Quasar!fixture-8-passphrase';
const mux = new Proxy(
  {},
  {
    get: (_target, name) => () => {
      throw new Error('NATIVE_MUX_FORBIDDEN:' + String(name));
    },
  }
) as TerminalMultiplexer;
let directory: string, app: FastifyInstance, auth: OwnerAuthService, authority: ResourceOwnerAuthority;
let company: CompanyService, store: CompanyStore, source: Session, token: string;
let preview: RamResourcePreviewContext, binding: RamResourceOwnerBinding, legacy: ResourceOwnerBinding;
let approval: RamResourceApproval, sessions: Map<string, Session>, port: SessionPort;
const claimed = () => ({
  reference: randomUUID(),
  sessionId: approval.targetSid,
  state: 'PREPARING' as const,
  publicationIntentDigest: 'c'.repeat(64),
});
const headers = () => ({ host: 'localhost', origin: 'http://localhost', cookie: 'reverie_owner=' + token });
const publication = () => new RamResourceSessionPublication(authority, preview, company, port, mux, approval.targetSid);
beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), 'ram-publication-'));
  auth = new OwnerAuthService({
    store: new OwnerAuthStore(join(directory, 'owner.json')),
    auditFile: join(directory, 'audit.jsonl'),
    setupEnabled: true,
  });
  token = await auth.setup('FixtureOwner', password, password, '127.0.0.1');
  authority = new ResourceOwnerAuthority(auth);
  source = new Session({
    id: randomUUID(),
    workingDir: directory,
    mode: 'codex',
    name: 'Worker',
    resumeSessionId: 'preserved-old-thread',
    runtimeThreads: { original: 'preserved-old-thread' },
    codexConfig: { model: 'fixture-model', resumeSessionId: 'preserved-old-thread' },
    envOverrides: { FIXTURE_SETTING: 'preserved' },
    mux,
    useMux: true,
  });
  vi.spyOn(source, 'stop').mockImplementation(async () => {
    throw new Error('SOURCE_STOP_FORBIDDEN');
  });
  sessions = new Map([[source.id, source]]);
  store = new CompanyStore(join(directory, 'company.json'));
  await store.init();
  company = new CompanyService(store, {
    getSession: (id) => sessions.get(id),
    runtimeRecipeOf: (id) => (sessions.has(id) ? expertRuntimeRecipe(sessions.get(id)!) : undefined),
    chatrooms: { rooms: () => [], room: () => undefined, addMember: vi.fn(), replaceSession: vi.fn(async () => {}) },
    research: { start: vi.fn(), inspect: vi.fn(), stop: vi.fn() },
  });
  const employee = await company.hire({
    name: 'Worker',
    icon: '🦊',
    position: 'Engineer',
    expertise: ['systems'],
    sessionId: source.id,
    researchEnabled: false,
  });
  await company.setDesiredRunning(source.id, true);
  await company.saveRuntimeRecipe(source.id, expertRuntimeRecipe(source));
  approval = {
    employeeId: employee.id,
    draftId: randomUUID(),
    operationId: randomUUID(),
    reservationId: randomUUID(),
    targetSid: randomUUID(),
    profileVersion: '18446744073709551615',
    profileDigest: 'a'.repeat(64),
    previewDigest: 'b'.repeat(64),
    ramPolicyDigest: 'd'.repeat(64),
  };
  app = Fastify();
  await app.register(cookie);
  app.post('/preview', async (req) => {
    preview = authority.captureRamPreview(req, employee.id);
    return {};
  });
  app.post('/apply', async (req) => {
    binding = authority.bindRam(authority.captureRam(req, approval));
    return {};
  });
  app.post('/legacy', async (req) => {
    const { ramPolicyDigest: _ram, ...old } = { ...approval, profileVersion: '1' };
    legacy = authority.bind(authority.capture(req, old));
    return {};
  });
  for (const url of ['/preview', '/apply', '/legacy'])
    expect((await app.inject({ method: 'POST', url, headers: headers() })).statusCode).toBe(200);
  port = {
    sessions,
    addSession: vi.fn(async (session) => {
      sessions.set(session.id, session);
      return {} as never;
    }),
    setupSessionListeners: vi.fn(async () => {}),
    persistSessionStateNow: vi.fn(),
    persistSessionState: vi.fn(),
    cleanupSession: vi.fn(async () => {
      throw new Error('CLEANUP_FORBIDDEN');
    }),
    discardPartiallyBuiltSession: vi.fn(async () => {
      throw new Error('DISCARD_FORBIDDEN');
    }),
    reapplyPersistedSessionState: vi.fn(),
    getSessionStateWithRespawn: vi.fn(),
  };
});
afterEach(async () => {
  authority?.close();
  await app?.close();
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

it('publishes the exact RAM target through normal Company CAS without native start or v1 coercion', async () => {
  const before = structuredClone(company.registeredEmployees()[0]),
    old = source.toState();
  const selected = publication(),
    published = await selected.publish(binding, approval, claimed());
  selected.assertPublished(binding, published);
  const candidate = sessions.get(approval.targetSid)!;
  expect(candidate).toBeInstanceOf(Session);
  expect(candidate.pid).toBeFalsy();
  expect(candidate.muxName).toBeFalsy();
  expect(candidate.getEnvOverridesForPersist()).toEqual(source.getEnvOverridesForPersist());
  expect(candidate.toState().runtimeThreads).toEqual({});
  expect(candidate.toState().codexConfig?.resumeSessionId).toBeUndefined();
  expect(source.toState()).toEqual(old);
  expect(company.registeredEmployees()[0]).toEqual({
    ...before,
    sessionId: approval.targetSid,
    sessionGeneration: before.sessionGeneration + 1,
    runtimeRecipe: expertRuntimeRecipe(candidate),
  });
  expect(published.prepareLaunch()).toBeDefined();
  expect(() => published.prepareLaunch()).toThrow();
  expect(source.stop).not.toHaveBeenCalled();
  expect(port.cleanupSession).not.toHaveBeenCalled();
  expect(() => JSON.stringify(published)).toThrow('server-private');
  expect(() => new ResourceSessionPublication(authority, preview as never, company, port, mux, randomUUID())).toThrow();
});

it('rejects a substitution in every original RAM approval field before creating a candidate', async () => {
  const selected = publication();
  for (const field of Object.keys(approval) as (keyof RamResourceApproval)[]) {
    const value = field.endsWith('Digest') ? 'e'.repeat(64) : field === 'profileVersion' ? '2' : randomUUID();
    await expect(selected.publish(binding, { ...approval, [field]: value }, claimed())).rejects.toThrow();
  }
  expect(port.addSession).not.toHaveBeenCalled();
  expect(sessions.size).toBe(1);
});

it('refuses copied preview, legacy binding and a different actual owner session', async () => {
  expect(
    () => new RamResourceSessionPublication(authority, { ...preview }, company, port, mux, approval.targetSid)
  ).toThrow();
  await expect(
    publication().publish(legacy as unknown as RamResourceOwnerBinding, approval, claimed())
  ).rejects.toThrow();
  const login = await auth.login('FixtureOwner', password, '127.0.0.1');
  expect(login.next).toBe('done');
  if (login.next !== 'done' || !login.session) throw new Error('Actual second owner login required');
  token = login.session;
  expect((await app.inject({ method: 'POST', url: '/apply', headers: headers() })).statusCode).toBe(200);
  await expect(publication().publish(binding, approval, claimed())).rejects.toThrow();
  expect(port.addSession).not.toHaveBeenCalled();
});
it('never accepts an actual RAM command join as a legacy launch task with a v1 owner binding', async () => {
  const selected = publication(),
    native = claimed();
  const before = company.registeredEmployees()[0];
  await selected.publish(binding, approval, native);
  const intent: RamResourceSessionIntent = Object.freeze({
    purpose: 'resource-ram-pool-v2',
    owner: undefined,
    ownerScopeDigest: binding.digest,
    sourceSid: source.id,
    sourceGeneration: before.sessionGeneration,
    approval: Object.freeze({ ...approval }),
  });
  const launch = ramResourceWorkerLaunch(binding, intent, native.reference);
  const record = {
    id: approval.operationId,
    employeeId: approval.employeeId,
    name: 'Worker',
    owner: undefined,
    oldSession: source.id,
    newSession: approval.targetSid,
    fromAccount: 'same',
    toAccount: 'same',
    purpose: 'runtime-refresh' as const,
    phase: 'creating' as const,
    at: Date.now(),
    resourceOwnerScope: legacy.digest,
    resourceIntent: {
      operationId: approval.operationId,
      reservationId: approval.reservationId,
      profileVersion: '1',
      profileDigest: approval.profileDigest,
      previewDigest: approval.previewDigest,
    },
  };
  expect(
    () => new ResourceSessionLaunchTask(sessions.get(approval.targetSid)!, launch, legacy, record, native.reference)
  ).toThrow();
  expect(port.cleanupSession).not.toHaveBeenCalled();
  expect(source.stop).not.toHaveBeenCalled();
});

it('retains partial normal metadata and forbids replay when logout follows candidate registration', async () => {
  const selected = publication();
  vi.mocked(port.addSession).mockImplementationOnce(async (session) => {
    sessions.set(session.id, session);
    auth.logout(token);
    return {} as never;
  });
  await expect(selected.publish(binding, approval, claimed())).rejects.toThrow();
  expect(sessions.has(approval.targetSid)).toBe(true);
  expect(company.registeredEmployees()[0].sessionId).toBe(source.id);
  await expect(selected.publish(binding, approval, claimed())).rejects.toThrow();
  expect(port.addSession).toHaveBeenCalledTimes(1);
  expect(source.stop).not.toHaveBeenCalled();
  expect(port.cleanupSession).not.toHaveBeenCalled();
});

/** The actual temp FileHandle writes/syncs/closes normally; the owned fixture
 * changes current authority/source only after real sync, before real rename. */
function afterActualCompanyTempSync(change: () => void) {
  const open = fs.open.bind(fs);
  let observed = 0;
  vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (String(args[0]).startsWith(store.file + '.') && args[1] === 'wx') {
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, 'sync').mockImplementation(async () => {
        await sync();
        observed++;
        change();
      });
    }
    return handle;
  });
  return () => observed;
}
it('rechecks actual logout after temp sync and leaves canonical company bytes unchanged', async () => {
  const before = await fs.readFile(store.file),
    selected = publication();
  const observed = afterActualCompanyTempSync(() => auth.logout(token));
  await expect(selected.publish(binding, approval, claimed())).rejects.toThrow();
  expect(observed()).toBe(1);
  expect(await fs.readFile(store.file)).toEqual(before);
  expect(sessions.has(approval.targetSid)).toBe(true);
  expect(company.registeredEmployees()[0].sessionId).toBe(source.id);
});
it('rechecks the exact original Session settings after temp sync before canonical rename', async () => {
  const before = await fs.readFile(store.file),
    selected = publication();
  const observed = afterActualCompanyTempSync(() => source.setNice({ niceValue: 3 }));
  await expect(selected.publish(binding, approval, claimed())).rejects.toThrow('Approved resource source changed');
  expect(observed()).toBe(1);
  expect(await fs.readFile(store.file)).toEqual(before);
  expect(sessions.has(approval.targetSid)).toBe(true);
});
it('does not create a Session or readiness outcome for OFF or vacation configuration-only states', async () => {
  await company.setDesiredRunning(source.id, false);
  expect(publication).toThrow();
  await company.setDesiredRunning(source.id, true);
  await store.update((state) => {
    state.employees[0].onVacation = true;
  });
  expect(publication).toThrow();
  expect(sessions.size).toBe(1);
  expect(port.addSession).not.toHaveBeenCalled();
  expect(source.stop).not.toHaveBeenCalled();
});
it('refuses a foreign canonical employee or pending binding migration before candidate registration', async () => {
  await store.update((state) => {
    state.employees[0].owner = 'ForeignOwner';
  });
  expect(publication).toThrow();
  await store.update((state) => {
    delete state.employees[0].owner;
    state.employees[0].bindingMigration = { id: randomUUID(), from: source.id, to: randomUUID() };
  });
  expect(publication).toThrow();
  expect(port.addSession).not.toHaveBeenCalled();
  expect(sessions.size).toBe(1);
  expect(source.stop).not.toHaveBeenCalled();
});
it('returns the original actual Session launch rejection and never substitutes a readiness result', async () => {
  const selected = publication(),
    reply = claimed();
  const published = await selected.publish(binding, approval, reply);
  const candidate = sessions.get(approval.targetSid)!;
  const primary = new Error('OWNED_SESSION_START_REFUSED');
  const start = vi.spyOn(candidate, 'startInteractive').mockRejectedValue(primary);
  const task = published.prepareLaunch();
  task.begin(reply.reference);
  await expect(task.wait()).rejects.toBe(primary);
  expect(() => task.begin(reply.reference)).toThrow();
  expect(start).toHaveBeenCalledTimes(1);
  expect(() => published.readiness().assertCurrent()).toThrow();
});
