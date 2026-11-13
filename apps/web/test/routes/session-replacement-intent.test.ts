/** Bug 19: a verified-owner replacement spawn (employeeId) records running intent on the NEW session through the
 * guarded owner transaction; agent callers, vacations and failed launches do not. Real routes, mock mux. */
import { trustedFixtureOwner } from '../helpers/trusted-owner-fixture.js';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fileIo, { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createMockRouteContext, type MockRouteContext } from '../mocks/index.js';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { installResponseEnvelope } from '../../src/web/response-envelope.js';
import { CompanyService } from '../../src/company-service.js';
import { CompanyStore } from '../../src/company-store.js';
import { ChatroomStore } from '../../src/chatroom-store.js';
import { Session } from '../../src/session.js';
import { PlanMoves, type PlanMoveInput } from '../../src/plan-move.js';
import { PlanMoveStore } from '../../src/plan-move-store.js';
import { planMoveExecutor, planMoveSessionResponse } from '../../src/plan-move-runtime.js';
import { CASES_DIR } from '../../src/web/route-helpers.js';

vi.mock('../../src/utils/cli-resolver.js', async (original) => ({
  ...(await original<typeof import('../../src/utils/cli-resolver.js')>()),
  isCliAvailable: () => true,
  resolveCliBinDir: () => '/usr/bin',
  missingCliMessage: () => null,
}));

describe('bug 19: owner replacement spawns record running intent on the new session', () => {
  let directory: string;
  let app: FastifyInstance;
  let ctx: MockRouteContext;
  let company: CompanyService;
  let store: CompanyStore;
  async function openApp(envelope = false) {
    app = Fastify();
    await app.register(fastifyCookie);
    registerSessionRoutes(app, ctx, { company, verifiedOwner: trustedFixtureOwner });
    if (envelope) installResponseEnvelope(app);
    installRouteErrorHandler(app);
    await app.ready();
  }
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'reverie-replacement-intent-'));
    store = new CompanyStore(join(directory, 'company.json'));
    await store.init();
    ctx = createMockRouteContext();
    const rooms = new ChatroomStore();
    company = new CompanyService(store, {
      getSession: (id) => ctx.sessions.get(id),
      chatrooms: {
        rooms: () => rooms.list(),
        room: (id) => rooms.get(id),
        addMember: (id, sessionId, options) => rooms.addMember(id, sessionId, options).member,
      },
      research: { start: vi.fn(), inspect: vi.fn(), stop: vi.fn() },
    });
    await openApp();
  });
  afterEach(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const owner = (extra = {}) =>
    app.inject({ method: 'POST', url: '/api/sessions', payload: { workingDir: directory, mode: 'claude', ...extra } });
  const agent = (parent: string, extra = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { 'x-reverie-parent-session': parent },
      payload: { workingDir: directory, mode: 'claude', ...extra },
    });
  const hireStopped = async () => {
    const abe = await company.hire({
      name: 'Abe',
      icon: '🔭',
      position: 'Scientist',
      expertise: ['x'],
      sessionId: 'test-session-1',
      researchEnabled: false,
    } as never);
    await company.setDesiredRunning('test-session-1', false); // the owner's Stop
    return abe;
  };
  const employee = () => company.view().employees[0]!;

  it('owner Stop, then an owner replacement: bound to the new session with running intent', async () => {
    const abe = await hireStopped();
    const replaced = await owner({ employeeId: abe.id });
    expect(replaced.statusCode, replaced.body).toBe(200);
    const created = replaced.json().session.id;
    expect(employee().sessionId).toBe(created);
    expect(employee().desiredRunning).toBe(true);
    // The transaction is closed: a later owner restart of the new session is not blocked as "already restarting".
    expect(() => company.prepareRuntimeRestart(created, undefined)?.finish()).not.toThrow();
  });

  it("refuses the employee's unapproved self replacement without changing running intent", async () => {
    const abe = await hireStopped();
    const before = structuredClone(store.snapshot());
    const original = ctx.sessions.get('test-session-1');
    const originalSessions = [...ctx.sessions];
    const replaced = await agent('test-session-1', { employeeId: abe.id });
    expect(replaced.statusCode, replaced.body).toBe(403);
    expect(store.snapshot()).toEqual(before);
    expect(employee().sessionId).toBe('test-session-1');
    expect(employee().desiredRunning).toBe(false);
    expect([...ctx.sessions]).toEqual(originalSessions);
    expect(ctx.sessions.get('test-session-1')).toBe(original);
    expect(ctx.addSession).not.toHaveBeenCalled();
    expect(ctx.setupSessionListeners).not.toHaveBeenCalled();
    expect(ctx.store.incrementSessionsCreated).not.toHaveBeenCalled();
    expect(ctx.persistSessionState).not.toHaveBeenCalled();
    expect(ctx.cleanupSession).not.toHaveBeenCalled();
    expect(ctx.discardPartiallyBuiltSession).not.toHaveBeenCalled();
    expect(ctx.broadcast).not.toHaveBeenCalled();
    expect(() => company.prepareRuntimeRestart('test-session-1', undefined)?.finish()).not.toThrow();
  });

  it('refuses an unverified owner replacement without registration or cleanup', async () => {
    const abe = await hireStopped();
    await app.close();
    app = Fastify();
    await app.register(fastifyCookie);
    registerSessionRoutes(app, ctx, { company, verifiedOwner: () => false });
    installRouteErrorHandler(app);
    await app.ready();
    const before = structuredClone(store.snapshot());
    const original = ctx.sessions.get('test-session-1');
    const originalSessions = [...ctx.sessions];
    const replaced = await owner({ employeeId: abe.id });
    expect(replaced.statusCode, replaced.body).toBe(403);
    expect(store.snapshot()).toEqual(before);
    expect(employee().sessionId).toBe('test-session-1');
    expect(employee().desiredRunning).toBe(false);
    expect([...ctx.sessions]).toEqual(originalSessions);
    expect(ctx.sessions.get('test-session-1')).toBe(original);
    expect(ctx.addSession).not.toHaveBeenCalled();
    expect(ctx.setupSessionListeners).not.toHaveBeenCalled();
    expect(ctx.store.incrementSessionsCreated).not.toHaveBeenCalled();
    expect(ctx.persistSessionState).not.toHaveBeenCalled();
    expect(ctx.cleanupSession).not.toHaveBeenCalled();
    expect(ctx.discardPartiallyBuiltSession).not.toHaveBeenCalled();
    expect(ctx.broadcast).not.toHaveBeenCalled();
    expect(() => company.prepareRuntimeRestart('test-session-1', undefined)?.finish()).not.toThrow();
  });

  it('a vacationing employee keeps its stop', async () => {
    const abe = await hireStopped();
    await store.update((state) => {
      state.employees[0]!.onVacation = true;
    });
    const replaced = await owner({ employeeId: abe.id });
    expect(replaced.statusCode, replaced.body).toBe(200);
    expect(employee().desiredRunning).toBe(false);
  });

  it('a failed replacement launch rolls the claim back and leaves no open transaction', async () => {
    const abe = await hireStopped();
    ctx.addSession.mockRejectedValueOnce(new Error('synthetic launch failure'));
    const failed = await owner({ employeeId: abe.id });
    expect(failed.statusCode).toBeGreaterThanOrEqual(400);
    expect(employee().sessionId).toBe('test-session-1');
    expect(employee().desiredRunning).toBe(false);
    expect(() => company.prepareRuntimeRestart('test-session-1', undefined)?.finish()).not.toThrow();
    const retried = await owner({employeeId: abe.id});
    expect(retried.statusCode, retried.body).toBe(200);
    expect(employee().sessionId).toBe(retried.json().session.id);
  });

  it.each([
    ...(['create', 'quick-start', 'move'] as const).flatMap(route =>
      (['reserve', 'publish'] as const).map(phase => ({ route, phase, interference: 'none' as const }))),
    ...(['newer-binding', 'target-replaced', 'persist-failure'] as const).map(interference =>
      ({ route: 'create' as const, phase: 'publish' as const, interference })),
  ])('retains exact $route target when $phase rename succeeds but directory sync reports failure ($interference)', async ({ route, phase, interference }) => {
    ctx._session.workingDir = directory;
    const abe = await hireStopped();
    await app.close();
    await openApp(true);
    const actualOpen = fileIo.open.bind(fileIo);
    const syncHooks: Array<{ mockRestore(): void }> = [];
    const cleaned: string[] = [];
    let applied = false;
    let publishedSid: string | undefined;
    let target: unknown;
    let successor: Session | undefined;
    let canonicalAtFault: Record<string, unknown> | undefined;
    let actualFailure: unknown;
    const actualRebind = company.rebind.bind(company);
    const rebind = vi.spyOn(company, 'rebind').mockImplementation(async (...args) => {
      try { return await actualRebind(...args); } catch (error) {
        actualFailure = error;
        if (interference === 'newer-binding' || interference === 'target-replaced') {
          successor = new Session({ id: interference === 'target-replaced' ? (target as Session).id : randomUUID(),
            owner: interference === 'target-replaced' ? 'foreign' : undefined, workingDir: directory });
          ctx.sessions.set(successor.id, successor as never);
          if (interference === 'newer-binding') {
            const newer = new CompanyStore(store.file); await newer.init();
            await newer.update(state => {
              const row = state.employees.find(e => e.id === abe.id)!;
              row.sessionId = successor!.id; row.sessionGeneration++; row.desiredRunning = false;
            });
          }
        }
        throw error;
      }
    });
    const start = vi.spyOn(Session.prototype, 'startInteractive').mockResolvedValue();
    const caseName = 'synthetic-canonical-' + phase;
    if (interference === 'persist-failure')
      ctx.persistSessionStateNow.mockImplementationOnce(() => { throw new Error('synthetic diagnostic persistence failure'); });
    ctx.cleanupSession.mockImplementation(async id => {
      cleaned.push(id);
      ctx.sessions.delete(id);
    });
    const boundary = vi.spyOn(fileIo, 'open').mockImplementation(async (path, flags, mode) => {
      const handle = await actualOpen(path, flags, mode);
      if (path === directory && flags === 'r') {
        const actualSync = handle.sync.bind(handle);
        syncHooks.push(vi.spyOn(handle, 'sync').mockImplementation(async () => {
          await actualSync();
          const row = JSON.parse(await readFile(store.file, 'utf8')).employees.find((e: { id: string }) => e.id === abe.id);
          const reached = phase === 'reserve' ? row.bindingMigration?.from === abe.sessionId
            : row.sessionId !== abe.sessionId && !row.bindingMigration;
          if (!applied && reached) {
            applied = true;
            publishedSid = phase === 'reserve' ? row.bindingMigration.to : row.sessionId;
            target = ctx.sessions.get(publishedSid!);
            canonicalAtFault = row;
            throw new Error('synthetic directory sync failure after actual canonical rename');
          }
        }));
      }
      return handle;
    });
    try {
      let failed: Awaited<ReturnType<typeof owner>> | undefined;
      let moves: PlanMoves | undefined;
      let moveInput: PlanMoveInput | undefined;
      let moveStore: PlanMoveStore | undefined;
      if (route === 'move') {
        const runtime = planMoveExecutor({
          company, sessions: ctx.sessions, mux: { ...ctx.mux, isPaneDead: () => false }, cleanup: ctx.cleanupSession, authorized: () => true,
          plans: {
            allocations: async () => ({ generatedAt: 1, accounts: [{ id: 'first', sessionIds: [abe.sessionId] }] }) as never,
            account: async id => ({ id, provider: 'anthropic', label: id, isDefault: true }) as never,
          },
          chat: { rooms: () => [], post: vi.fn(), auditEntry: vi.fn(async () => {}) },
          request: async (method, url, payload) => {
            failed = await app.inject({ method, url, ...(payload === undefined ? {} : { payload: JSON.stringify(payload), headers: { 'content-type': 'application/json' } }) });
            return planMoveSessionResponse(failed.statusCode, failed.json());
          },
        });
        moveStore = new PlanMoveStore(join(directory, 'moves.json'));
        moves = new PlanMoves({ ...runtime, load: () => moveStore!.load(), save: records => moveStore!.save(records) });
        moveInput = { id: 'synthetic-canonical-move', employeeId: abe.id, sessionId: abe.sessionId,
          fromAccount: 'first', toAccount: 'second', forceBusy: false, handoff: 'Resume the synthetic task.' };
        await moves.begin(moveInput);
        await vi.waitFor(async () => expect((await moves!.get(moveInput!.id))?.phase).toBe('recovery-required'));
      } else {
        failed = route === 'create' ? await owner({ employeeId: abe.id })
          : await app.inject({ method: 'POST', url: '/api/quick-start', payload: { employeeId: abe.id, caseName, mode: 'claude' } });
      }
      expect(applied).toBe(true);
      expect(publishedSid).toBeTruthy();
      expect(canonicalAtFault).toMatchObject({ id: abe.id, name: abe.name, permissions: abe.permissions,
        sessionId: phase === 'reserve' ? abe.sessionId : publishedSid,
        sessionGeneration: abe.sessionGeneration + 1, desiredRunning: true });
      const persisted = JSON.parse(await readFile(store.file, 'utf8')).employees.find((e: { id: string }) => e.id === abe.id);
      expect(persisted).toMatchObject(interference === 'newer-binding'
        ? { sessionId: successor!.id, sessionGeneration: abe.sessionGeneration + 2, desiredRunning: false }
        : canonicalAtFault!);
      expect(cleaned).toEqual([]);
      expect(ctx.sessions.get(publishedSid!)).toBe(interference === 'target-replaced' ? successor : target);
      expect(failed!.statusCode, failed!.body).toBe(409);
      expect(failed!.json()).toMatchObject({ recoveryRequired: true, employeeId: abe.id, sessionId: publishedSid,
        reason: 'binding-publication-unconfirmed', replacementClaim: 'held' });
      if (interference === 'target-replaced') {
        expect(failed!.json().retainedSession).toBe('ownership-lost');
        expect(ctx.persistSessionStateNow).not.toHaveBeenCalled();
      }
      if (interference === 'persist-failure') expect(failed!.json().sessionPersistence).toBe('unconfirmed');
      const identity = { employeeId: abe.id, replacesSessionId: abe.sessionId };
      expect(company.replacementPublicationRecovery(actualFailure, target as object, identity, undefined)).toMatchObject({ sessionId: publishedSid });
      for (const lookalike of [JSON.parse(JSON.stringify(actualFailure)), Object.create(Object.getPrototypeOf(actualFailure))])
        expect(company.replacementPublicationRecovery(lookalike, target as object, identity, undefined)).toBeUndefined();
      expect(company.replacementPublicationRecovery(actualFailure, {}, identity, undefined)).toBeUndefined();
      expect(company.replacementPublicationRecovery(actualFailure, target as object, { ...identity, employeeId: 'another' }, undefined)).toBeUndefined();
      expect(company.replacementPublicationRecovery(actualFailure, target as object, identity, 'foreign')).toBeUndefined();
      expect(store.publicationUnconfirmed).toBe(true);
      const bytes = await readFile(store.file, 'utf8');
      await expect(store.update(state => { state.employees[0].name = 'Must not publish'; })).rejects.toThrow('writer is held');
      expect(await readFile(store.file, 'utf8')).toBe(bytes);
      await expect(store.init()).rejects.toThrow('writer is held');
      const retried = await owner({ employeeId: abe.id });
      expect(retried.statusCode).toBe(409);
      expect(ctx.cleanupSession).not.toHaveBeenCalled();
      if (route === 'move') {
        await vi.waitFor(async () => expect((await moveStore!.load())[0]?.phase).toBe('recovery-required'));
        expect((await moveStore!.load())[0]).toMatchObject({ phase: 'recovery-required', oldSession: abe.sessionId });
        expect((await moves!.get(moveInput!.id))!.newSession).toBeUndefined();
        await expect(moves!.assertAvailable(abe.id)).rejects.toThrow('already has a move');
        await expect(moves!.begin({ ...moveInput!, id: 'must-not-replay' })).rejects.toThrow('already has a move');
      }
      expect(start).toHaveBeenCalledTimes(route === 'quick-start' ? 1 : 0);
    } finally {
      boundary.mockRestore();
      for (const hook of syncHooks) hook.mockRestore();
      start.mockRestore();
      rebind.mockRestore();
      await successor?.stop(false);
      if (route === 'quick-start') await rm(join(CASES_DIR, caseName), { recursive: true, force: true });
    }
  });

  it('a replacement of a running employee keeps it running (the thread claim stop is not the owner Stop)', async () => {
    const abe = await company.hire({
      name: 'Abe',
      icon: '🔭',
      position: 'Scientist',
      expertise: ['x'],
      sessionId: 'test-session-1',
      researchEnabled: false,
    } as never);
    await company.setDesiredRunning('test-session-1', true);
    const replaced = await owner({ employeeId: abe.id });
    expect(replaced.statusCode, replaced.body).toBe(200);
    expect(employee().desiredRunning).toBe(true);
  });

  it('a known authority refusal before canonical rename does not poison the writer', async () => {
    await hireStopped();
    const bytes = await readFile(store.file, 'utf8');
    const refused = new Error('synthetic authority revoked before publication');
    const actualOpen = fileIo.open.bind(fileIo);
    const hooks: Array<{ mockRestore(): void }> = [];
    let revoked = false;
    const boundary = vi.spyOn(fileIo, 'open').mockImplementation(async (path, flags, mode) => {
      const handle = await actualOpen(path, flags, mode);
      if (typeof path === 'string' && path.startsWith(store.file + '.') && path.endsWith('.tmp') && flags === 'wx') {
        const sync = handle.sync.bind(handle);
        hooks.push(vi.spyOn(handle, 'sync').mockImplementation(async () => { await sync(); revoked = true; }));
      }
      return handle;
    });
    try {
      const outcome = await store.updateOutcome(state => { state.employees[0].name = 'Must not publish'; }, () => {
        if (revoked) throw refused;
      });
      expect(revoked).toBe(true);
      expect(outcome).toEqual({ state: 'not-issued', cause: refused });
      expect(store.publicationUnconfirmed).toBe(false);
      expect(await readFile(store.file, 'utf8')).toBe(bytes);
    } finally {
      boundary.mockRestore();
      for (const hook of hooks) hook.mockRestore();
    }
    await store.update(state => { state.employees[0].name = 'Still writable'; });
    expect(employee().name).toBe('Still writable');
  });

  it('a dispatched rename error stays uncertain even with unchanged bytes, and an old receipt cannot poison a new call', async () => {
    await hireStopped();
    const bytes = await readFile(store.file, 'utf8');
    const actualRename = fileIo.rename.bind(fileIo);
    const fault = new Error('synthetic rename acknowledgement failure');
    const boundary = vi.spyOn(fileIo, 'rename').mockImplementation(async (from, to) => {
      if (to === store.file) throw fault;
      return actualRename(from, to);
    });
    let outcome: Awaited<ReturnType<CompanyStore['updateOutcome']>>;
    try { outcome = await store.updateOutcome(state => { state.employees[0].name = 'Must remain uncertain'; }); }
    finally { boundary.mockRestore(); }
    expect(outcome.state).toBe('unconfirmed');
    if (outcome.state !== 'unconfirmed') throw new Error('Expected the actual writer receipt');
    const receipt = outcome.receipt;
    expect(store.isPublicationReceipt(receipt)).toBe(true);
    expect(store.isPublicationReceipt(Object.create(Object.getPrototypeOf(receipt)))).toBe(false);
    expect(await readFile(store.file, 'utf8')).toBe(bytes);
    expect(store.publicationUnconfirmed).toBe(true);
    const fresh = new CompanyStore(store.file); await fresh.init();
    expect(fresh.isPublicationReceipt(receipt)).toBe(false);
    const refused = await fresh.updateOutcome(() => { throw receipt; });
    expect(refused).toEqual({ state: 'not-issued', cause: receipt });
    expect(fresh.publicationUnconfirmed).toBe(false);
    expect(await readFile(store.file, 'utf8')).toBe(bytes);
  });

  it('a public lookalike cannot mint private publication retention or prevent exact-owned known-refusal cleanup', async () => {
    const abe = await hireStopped(); await app.close(); await openApp(true);
    const refusal = Object.assign(new Error('Employee binding publication is unconfirmed'), {
      recoveryRequired: true, reason: 'binding-publication-unconfirmed', employeeId: abe.id,
    });
    const complete = vi.spyOn(company, 'completeSpawn').mockRejectedValueOnce(refusal);
    ctx.cleanupSession.mockImplementation(async id => { ctx.sessions.delete(id); });
    try {
      const failed = await owner({ employeeId: abe.id });
      expect(failed.statusCode).toBeGreaterThanOrEqual(400);
      expect(failed.json().recoveryRequired).toBeUndefined();
      expect(ctx.cleanupSession).toHaveBeenCalledOnce();
      expect(employee()).toMatchObject({ sessionId: abe.sessionId, desiredRunning: false });
      const retry = await owner({ employeeId: abe.id });
      expect(retry.statusCode, retry.body).toBe(200);
    } finally { complete.mockRestore(); }
  });

  it.each(['create', 'quick'] as const)('retains the original %s attempt when actual cleanup refuses instead of rolling back intent', async route => {
    ctx._session.workingDir = directory;
    const abe = await hireStopped(); await app.close(); await openApp(true);
    const complete = vi.spyOn(company, 'completeSpawn').mockRejectedValue(new Error('synthetic known binding refusal'));
    const start = vi.spyOn(Session.prototype, 'startInteractive').mockResolvedValue();
    ctx.cleanupSession.mockRejectedValue(new Error('Candidate cleanup required: original native stop authority unavailable'));
    try {
      const failed = route === 'create' ? await owner({employeeId: abe.id}) : await app.inject({method: 'POST',
        url: '/api/quick-start', payload: {employeeId: abe.id, caseName: 'synthetic-cleanup', workingDir: directory, mode: 'claude'}});
      expect(failed.statusCode, failed.body).toBe(409);
      expect(failed.json()).toMatchObject({recoveryRequired: true, reason: 'candidate-cleanup-unconfirmed',
        employeeId: abe.id, replacementClaim: 'held', sessionId: expect.any(String)});
      const id = failed.json().sessionId;
      expect(ctx.sessions.has(id)).toBe(true);
      expect(ctx.cleanupSession).toHaveBeenCalledWith(id, true, route === 'create' ? 'spawn_failed' : 'quick_start_error',
        {session: ctx.sessions.get(id), owner: undefined});
      expect(employee()).toMatchObject({id: abe.id, sessionId: abe.sessionId, desiredRunning: true});
      expect(store.publicationUnconfirmed).toBe(false);
      const count = complete.mock.calls.length;
      const retry = await owner({employeeId: abe.id});
      expect(retry.statusCode).toBe(409); expect(complete).toHaveBeenCalledTimes(count);
    } finally {complete.mockRestore(); start.mockRestore();}
  });

  it.each(['object', 'owner'] as const)('refuses a changed target %s before rename without cleaning up its successor', async kind => {
    const abe = await hireStopped();
    await app.close(); await openApp(true);
    const actualOpen = fileIo.open.bind(fileIo);
    const hooks: Array<{ mockRestore(): void }> = [];
    let applied = false;
    let target: Session | undefined;
    let successor: Session | undefined;
    const boundary = vi.spyOn(fileIo, 'open').mockImplementation(async (path, flags, mode) => {
      const handle = await actualOpen(path, flags, mode);
      if (typeof path === 'string' && path.startsWith(store.file + '.') && path.endsWith('.tmp') && flags === 'wx') {
        const sync = handle.sync.bind(handle);
        hooks.push(vi.spyOn(handle, 'sync').mockImplementation(async () => {
          await sync();
          const row = JSON.parse(await readFile(path, 'utf8')).employees.find((e: { id: string }) => e.id === abe.id);
          if (!applied && row.bindingMigration) {
            applied = true; target = ctx.sessions.get(row.bindingMigration.to) as unknown as Session;
            if (kind === 'owner') { target.owner = 'foreign'; successor = target; }
            else {
              successor = new Session({ id: target.id, owner: 'foreign', workingDir: directory });
              ctx.sessions.set(target.id, successor as never);
            }
          }
        }));
      }
      return handle;
    });
    try {
      const failed = await owner({ employeeId: abe.id });
      expect(applied).toBe(true);
      expect(failed.statusCode, failed.body).toBe(409);
      expect(failed.json()).toMatchObject({recoveryRequired: true, reason: 'candidate-cleanup-unconfirmed',
        retainedSession: 'ownership-lost', replacementClaim: 'held', employeeId: abe.id, sessionId: target!.id});
      expect(ctx.cleanupSession).not.toHaveBeenCalled();
      expect(ctx.sessions.get(target!.id)).toBe(successor);
      expect(employee()).toMatchObject({ id: abe.id, sessionId: abe.sessionId, sessionGeneration: abe.sessionGeneration, desiredRunning: true });
      expect(employee().bindingMigration).toBeUndefined();
      expect(store.publicationUnconfirmed).toBe(false);
    } finally {
      boundary.mockRestore();
      for (const hook of hooks) hook.mockRestore();
      await target?.stop(false); if (successor !== target) await successor?.stop(false);
    }
    await store.update(() => {});
  });
});
