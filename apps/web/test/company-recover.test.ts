import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CompanyStore } from '../src/company-store.js';
import { CompanyError, CompanyService, type CompanyResearchBackend, type CompanyServiceDeps } from '../src/company-service.js';
import { RuntimeRecipeSchema } from '../src/expert-runtime-recipe.js';
import { ChatroomStore } from '../src/chatroom-store.js';
import type { RetiredSession } from '../src/chatroom-service.js';

describe('Explicitly authorized employee recovery', () => {
  let directory: string;
  let store: CompanyStore;
  let rooms: ChatroomStore;
  let service: CompanyService;
  let deps: CompanyServiceDeps;
  let sessions: Map<string, { id: string; name: string; owner?: string }>;
  let retired: RetiredSession[];
  let duringRooms: (() => Promise<void>) | undefined;
  let roomMoves: number;
  const backend = {} as CompanyResearchBackend;
  const add = (id: string, name: string, owner?: string) => sessions.set(id, { id, name, owner });
  const retire = (sessionId: string, successorId: string, owner?: string) =>
    retired.push({ sessionId, name: 'Coordinator', successorId, at: 1, owner, rooms: [] });

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'company-recover-'));
    store = new CompanyStore(join(directory, 'company.json'));
    await store.init();
    rooms = new ChatroomStore();
    sessions = new Map();
    retired = [];
    duringRooms = undefined;
    roomMoves = 0;
    deps = {
      getSession: (id) => sessions.get(id),
      chatrooms: {
        rooms: () => rooms.list(),
        room: (id) => rooms.get(id),
        addMember: (id, sessionId, options) => rooms.addMember(id, sessionId, options).member,
        setStatus: (id, sessionId, status) => rooms.setStatus(id, sessionId, status),
        replaceSession: async (oldId, newId, _by, canTouch) => {
          roomMoves++;
          await duringRooms?.();
          return rooms.replaceMember(oldId, newId, rooms.list().filter(canTouch)).map((r) => ({ id: r.id, name: r.name }));
        },
        retiredSessions: (canSee = () => true) => retired.filter((r) => canSee(r.owner)),
      },
      research: backend,
      now: () => Date.parse('2026-10-18T21:00:00Z'),
    };
    service = new CompanyService(store, deps);
    for (const [id, name] of [['cto-1', 'Reviewer'], ['coo-1', 'Worker'], ['dev-1', 'Rosa'], ['ops-new', 'Coordinator']]) add(id, name);
    const hire = (name: string, position: string, sessionId: string) =>
      service.hire({ name, icon: '🧭', position, expertise: ['ops'], sessionId, researchEnabled: false });
    const reviewer = await hire('Reviewer', 'CTO', 'cto-1');
    const worker = await hire('Worker', 'COO', 'coo-1');
    await service.update(reviewer.id, undefined, { permissions: { recoverEmployees: true } }, () => {});
    await service.update(worker.id, undefined, { permissions: { recoverEmployees: true } }, () => {});
    await hire('Rosa', 'Engineer', 'dev-1');
    await hire('Coordinator', 'Runtime engineer', 'ops-new');
    // A plan switch: ops-old (still running) was retired for ops-new, which then died.
    add('ops-old', 'Coordinator');
    retire('ops-old', 'ops-new');
    sessions.delete('ops-new');
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  const coordinator = () => service.view().employees.find((e) => e.name === 'Coordinator')!;
  const fails = async (work: Promise<unknown>, status: number) => {
    const error = await work.then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(CompanyError);
    expect((error as CompanyError).status).toBe(status);
  };

  const holdCompanyWriter = async () => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const done = store.update(() => {}, () => {}, async () => { entered(); await waiting; });
    await started;
    return { release, done };
  };

  it.each(['permission revoked', 'caller replaced', 'source resumed', 'retired link removed', 'retired link replaced'] as const)(
    'rechecks delegated recovery before a queued write when %s',
    async change => {
      const target = coordinator();
      const reviewer = service.view().employees.find(employee => employee.sessionId === 'cto-1')!;
      const room = rooms.create('Recovery', undefined);
      rooms.addMember(room.id, target.sessionId, { role: 'coordinator' });
      const held = await holdCompanyWriter();
      const ahead = change === 'permission revoked'
        ? service.update(reviewer.id, undefined, { permissions: { recoverEmployees: false } }, () => {})
        : Promise.resolve();
      const result = service.recover(target.id, undefined, 'cto-1', 'ops-old').then(
        () => undefined,
        error => error as unknown,
      );
      if (change === 'caller replaced') add('cto-1', 'Reviewer');
      if (change === 'source resumed') add('ops-new', 'Coordinator');
      if (change === 'retired link removed') retired = [];
      if (change === 'retired link replaced') retired = retired.map(row => ({ ...row }));
      held.release();
      await held.done;
      await ahead;
      const error = await result;
      expect(error).toBeInstanceOf(CompanyError);
      expect((error as CompanyError).status).toBe(409);
      expect(coordinator().sessionId).toBe(target.sessionId);
      expect(coordinator().bindingMigration).toBeUndefined();
      expect(roomMoves).toBe(0);
      expect(rooms.get(room.id)?.members.map(member => member.sessionId)).toEqual([target.sessionId]);
    },
  );

  it('finishes its committed migration after mid-room revocation but refuses the next fresh delegated action', async () => {
    const target = coordinator();
    const reviewer = service.view().employees.find(employee => employee.sessionId === 'cto-1')!;
    const room = rooms.create('Recovery', undefined);
    rooms.addMember(room.id, target.sessionId, { role: 'coordinator' });
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const waiting = new Promise<void>(resolve => { release = resolve; });
    duringRooms = async () => { entered(); await waiting; };
    const recovery = service.recover(target.id, undefined, 'cto-1', 'ops-old');
    await started;
    expect(coordinator()).toMatchObject({ sessionId: target.sessionId, sessionGeneration: target.sessionGeneration + 1,
      bindingMigration: { from: target.sessionId, to: 'ops-old' } });
    await service.update(reviewer.id, undefined, { permissions: { recoverEmployees: false } }, () => {});
    release();
    const result = await recovery;
    expect(result).toMatchObject({ id: target.id, sessionId: 'ops-old', sessionGeneration: target.sessionGeneration + 1 });
    expect(result.bindingMigration).toBeUndefined();
    expect(rooms.get(room.id)?.members.map(row => [row.sessionId, row.role])).toEqual([['ops-old', 'coordinator']]);
    const before = store.snapshot();
    await fails(service.recover(target.id, undefined, 'cto-1', 'ops-old'), 403);
    expect(store.snapshot()).toEqual(before);
    expect(roomMoves).toBe(1);
  });

  it('rechecks the exact delegate again after the actual temporary file is synced and before rename', async () => {
    const target = coordinator();
    const before = await fs.readFile(store.file);
    const open = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]).endsWith('.tmp')) {
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, 'sync').mockImplementationOnce(async () => {
          await sync();
          add('cto-1', 'A replacement caller');
        });
      }
      return handle;
    });
    await fails(service.recover(target.id, undefined, 'cto-1', 'ops-old'), 409);
    expect(await fs.readFile(store.file)).toEqual(before);
    expect(store.publicationUnconfirmed).toBe(false);
    expect(coordinator().bindingMigration).toBeUndefined();
    expect(roomMoves).toBe(0);
  });

  it.each([
    ['wake', 'queued'], ['wake', 'temporary synced'],
    ['restart', 'queued'], ['restart', 'temporary synced'],
  ] as const)('retains the correct original %s guard when recovery is refused at %s', async (kind, phase) => {
    const target = coordinator();
    const reviewer = service.view().employees.find(employee => employee.sessionId === 'cto-1')!;
    const restart = kind === 'restart' ? service.prepareRuntimeRestart(target.sessionId, undefined)! : undefined;
    const wake = kind === 'wake' ? service.prepareWake(target.id, target.sessionId)! : undefined;
    const lease = (restart ?? wake)!;
    expect(lease.current()).toBe(true);
    if (restart) await restart.claim();
    else expect(await service.claimWake(target.id, target.sessionId, Date.now(), false, () => lease.current())).toBe(true);
    const claimedTarget = coordinator();
    const before = await fs.readFile(store.file);
    if (phase === 'queued') {
      const held = await holdCompanyWriter();
      const revoke = service.update(reviewer.id, undefined, { permissions: { recoverEmployees: false } }, () => {});
      const recovery = service.recover(target.id, undefined, 'cto-1', 'ops-old').catch(error => error);
      held.release(); await held.done; await revoke;
      expect(await recovery).toMatchObject({ status: 409 });
      // The original lease has not been touched: admission refused before the
      // reservation mutator, while only the separate grant edit committed.
      expect(lease.current()).toBe(true);
    } else {
      const open = fs.open.bind(fs);
      vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
        const handle = await open(...args);
        if (String(args[0]).endsWith('.tmp')) {
          const sync = handle.sync.bind(handle);
          vi.spyOn(handle, 'sync').mockImplementationOnce(async () => {
            await sync(); add('cto-1', 'Replacement caller');
          });
        }
        return handle;
      });
      await fails(service.recover(target.id, undefined, 'cto-1', 'ops-old'), 409);
      expect(await fs.readFile(store.file)).toEqual(before);
      // Its earlier private cancellation is deliberately retained even though
      // no canonical rename or room migration was issued. Never revive it.
      expect(lease.current()).toBe(false);
    }
    expect(coordinator()).toEqual(claimedTarget);
    expect(store.publicationUnconfirmed).toBe(false);
    expect(roomMoves).toBe(0);
    expect(service.prepareWake(target.id, target.sessionId)).toBeUndefined();
    expect(() => service.prepareRuntimeRestart(target.sessionId, undefined)).toThrow('already restarting');
    lease.finish();
    expect(lease.current()).toBe(false);
    const fresh = service.prepareWake(target.id, target.sessionId)!;
    expect(fresh.current()).toBe(true);
    fresh.finish();
    expect(lease.current()).toBe(false);
  });

  it.each(['before rooms', 'during rooms'] as const)(
    'retains the actual published migration if its exact candidate is replaced %s', async phase => {
      const target = coordinator();
      const candidate = sessions.get('ops-old')!;
      const room = rooms.create('Recovery', undefined);
      rooms.addMember(room.id, target.sessionId, { role: 'coordinator' });
      if (phase === 'before rooms') {
        const rename = fs.rename.bind(fs);
        vi.spyOn(fs, 'rename').mockImplementationOnce(async (...args) => {
          await rename(...args);
          add('ops-old', 'A different runtime');
        });
      } else duringRooms = async () => { add('ops-old', 'A different runtime'); };
      const error = await service.recover(target.id, undefined, 'cto-1', 'ops-old').catch(error => error);
      expect(error).toBeInstanceOf(CompanyError);
      expect(error).toMatchObject({ status: 409, message: expect.stringContaining('publication is unconfirmed'),
        cause: expect.objectContaining({ message: 'Replacement session or owner changed' }) });
      const identity = { employeeId: target.id, replacesSessionId: target.sessionId };
      expect(service.replacementPublicationRecovery(error, candidate, identity, undefined)).toMatchObject({
        ...identity, sessionId: 'ops-old', reason: 'binding-publication-unconfirmed' });
      expect(service.replacementPublicationRecovery(error, sessions.get('ops-old')!, identity, undefined)).toBeUndefined();
      expect(coordinator()).toMatchObject({ sessionId: target.sessionId, sessionGeneration: target.sessionGeneration + 1,
        bindingMigration: { from: target.sessionId, to: 'ops-old' } });
      expect(roomMoves).toBe(phase === 'before rooms' ? 0 : 1);
      expect(sessions.get('ops-old')).toMatchObject({ name: 'A different runtime' });
    },
  );

  it.each(['changed', 'missing'] as const)('retains a published delegated migration when its candidate runtime recipe is %s', async change => {
    const target = coordinator();
    const originalRecipe = RuntimeRecipeSchema.parse({ mode: 'codex', workingDir: '/fixture', configs: {} });
    let recipe: typeof originalRecipe | undefined = structuredClone(originalRecipe);
    deps.runtimeRecipeOf = () => recipe;
    duringRooms = async () => { recipe = change === 'missing' ? undefined : { ...originalRecipe, mode: 'claude' }; };
    const error = await service.recover(target.id, undefined, 'cto-1', 'ops-old').catch(error => error);
    expect(error).toMatchObject({ message: expect.stringContaining('publication is unconfirmed'),
      cause: expect.objectContaining({ message: 'Replacement runtime recipe changed' }) });
    expect(coordinator()).toMatchObject({ sessionId: target.sessionId, runtimeRecipe: originalRecipe,
      sessionGeneration: target.sessionGeneration + 1, bindingMigration: { from: target.sessionId, to: 'ops-old' } });
    expect(roomMoves).toBe(1);
  });

  it('never migrates rooms after an actually renamed first reservation becomes unconfirmed', async () => {
    const target = coordinator();
    const room = rooms.create('Recovery', undefined);
    rooms.addMember(room.id, target.sessionId, { role: 'coordinator' });
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (...args) => {
      await rename(...args);
      throw new Error('Lost original canonical rename acknowledgement');
    });
    const error = await service.recover(target.id, undefined, 'cto-1', 'ops-old').catch(error => error);
    expect(error).toMatchObject({ message: expect.stringContaining('publication is unconfirmed') });
    expect(service.replacementPublicationRecovery(error, sessions.get('ops-old')!,
      { employeeId: target.id, replacesSessionId: target.sessionId }, undefined)).toBeDefined();
    expect(store.publicationUnconfirmed).toBe(true);
    expect(roomMoves).toBe(0);
    expect(rooms.get(room.id)?.members.map(row => row.sessionId)).toEqual([target.sessionId]);
    const reloaded = new CompanyStore(join(directory, 'company.json')); await reloaded.init();
    expect(reloaded.snapshot().employees.find(row => row.id === target.id)).toMatchObject({
      sessionId: target.sessionId, sessionGeneration: target.sessionGeneration + 1,
      bindingMigration: { from: target.sessionId, to: 'ops-old' } });
  });

  it('does not overwrite a newer employee binding after the original room operation has started', async () => {
    const target = coordinator();
    add('ops-successor', 'A newer owned runtime');
    duringRooms = async () => {
      await store.update(state => {
        const row = state.employees.find(employee => employee.id === target.id)!;
        row.sessionId = 'ops-successor';
        row.sessionGeneration += 1;
        row.bindingMigration = { id: 'newer-operation', from: target.sessionId, to: 'ops-successor' };
      });
    };
    const error = await service.recover(target.id, undefined, 'cto-1', 'ops-old').catch(error => error);
    expect(error).toMatchObject({ message: expect.stringContaining('publication is unconfirmed'),
      cause: expect.objectContaining({ message: 'Binding migration ownership changed' }) });
    expect(coordinator()).toMatchObject({ sessionId: 'ops-successor', sessionGeneration: target.sessionGeneration + 2,
      bindingMigration: { id: 'newer-operation', from: target.sessionId, to: 'ops-successor' } });
    expect(sessions.get('ops-successor')).toMatchObject({ name: 'A newer owned runtime' });
    expect(roomMoves).toBe(1);
  });

  it('lets a granted CTO move a gone employee, with every room seat, back onto its retired predecessor', async () => {
    const room = rooms.create('Ops', undefined);
    rooms.addMember(room.id, 'ops-new', { role: 'coordinator' });
    expect((await service.recover(coordinator().id, undefined, 'cto-1', 'ops-old')).sessionId).toBe('ops-old');
    expect(rooms.get(room.id)?.members.map((m) => [m.sessionId, m.role])).toEqual([['ops-old', 'coordinator']]);
  });

  it('lets a granted COO do the same', async () => {
    expect((await service.recover(coordinator().id, undefined, 'coo-1', 'ops-old')).sessionId).toBe('ops-old');
  });

  it('a CTO or COO title alone grants no recovery rights, including after reload', async () => {
    for (const title of ['CTO', 'COO']) {
      const employee = service.view().employees.find((e) => e.position === title)!;
      await service.update(employee.id, undefined, { permissions: { recoverEmployees: false } }, () => {});
      await fails(service.recover(coordinator().id, undefined, employee.sessionId, 'ops-old'), 403);
    }
    const reloaded = new CompanyStore(join(directory, 'company.json'));
    await reloaded.init();
    expect(reloaded.snapshot().employees.every((e) => !e.permissions.recoverEmployees)).toBe(true);
  });

  it('lets an explicitly granted expert recover regardless of their title and honors revocation', async () => {
    const engineer = service.view().employees.find((e) => e.sessionId === 'dev-1')!;
    expect(engineer.permissions.recoverEmployees).toBe(false);
    await service.update(engineer.id, undefined, { permissions: { recoverEmployees: true } }, () => {});
    await service.update(engineer.id, undefined, { permissions: { recoverEmployees: false } }, () => {});
    await fails(service.recover(coordinator().id, undefined, 'dev-1', 'ops-old'), 403);
    await service.update(engineer.id, undefined, { permissions: { recoverEmployees: true } }, () => {});
    expect((await service.recover(coordinator().id, undefined, 'dev-1', 'ops-old')).sessionId).toBe('ops-old');
  });

  it('refuses a session renamed to the employee: a name is not identity', async () => {
    add('imposter', 'Coordinator');
    await fails(service.recover(coordinator().id, undefined, 'cto-1', 'imposter'), 409);
    // A retired record for some other successor is not enough either.
    retire('imposter', 'someone-else');
    await fails(service.recover(coordinator().id, undefined, 'cto-1', 'imposter'), 409);
    expect(coordinator().sessionId).toBe('ops-new');
  });

  it('refuses a caller without the grant, without an employee binding, or whose session is gone', async () => {
    await fails(service.recover(coordinator().id, undefined, 'dev-1', 'ops-old'), 403);
    add('stray', 'Reviewer');
    await fails(service.recover(coordinator().id, undefined, 'stray', 'ops-old'), 403);
    sessions.delete('cto-1');
    await fails(service.recover(coordinator().id, undefined, 'cto-1', 'ops-old'), 403);
    expect(coordinator().sessionId).toBe('ops-new');
  });

  it('refuses a live source, self-recovery, a foreign or missing destination and an unknown employee', async () => {
    add('ops-new', 'Coordinator');
    await fails(service.recover(coordinator().id, undefined, 'cto-1', 'ops-old'), 409);
    sessions.delete('ops-new');
    const reviewer = service.view().employees.find((e) => e.name === 'Reviewer')!;
    await fails(service.recover(reviewer.id, undefined, 'cto-1', 'ops-old'), 403);
    add('foreign', 'Coordinator', 'another-owner');
    retire('foreign', 'ops-new', 'another-owner');
    await fails(service.recover(coordinator().id, undefined, 'cto-1', 'foreign'), 400);
    await fails(service.recover(coordinator().id, undefined, 'cto-1', 'missing'), 400);
    await fails(service.recover('no-such-employee', undefined, 'cto-1', 'ops-old'), 404);
    expect(coordinator().sessionId).toBe('ops-new');
  });
});
