import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyStore } from '../src/company-store.js';
import { CompanyService } from '../src/company-service.js';
import { ChatroomService, type ChatSessionLike } from '../src/chatroom-service.js';
import { PlanMoves, type PlanMoveInput, type PlanMovePort } from '../src/plan-move.js';
import { PlanMoveStore } from '../src/plan-move-store.js';
import type { RuntimeRecipe } from '../src/expert-runtime-recipe.js';

describe('plan move recovery using real company and chatroom persistence', () => {
  let directory: string;
  let chat: ChatroomService;
  let company: CompanyService;
  const panes = new Map<string, ChatSessionLike>();
  const recipes = new Map<string, RuntimeRecipe>();

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'plan-move-company-'));
    panes.clear();
    recipes.clear();
    for (const id of ['old', 'candidate'])
      panes.set(id, {
        id,
        name: 'Casey',
        mode: 'codex',
        owner: undefined,
        status: 'running',
        pid: 1,
        writeViaMux: async () => true,
      });
    for (const [id, account] of [['old', 'first'], ['candidate', 'second']]) recipes.set(id, {
      mode: 'codex', workingDir: '/scratch/casey', subscriptionProfile: { id: account, label: account, provider: 'openai' },
      configs: { codexConfig: { model: `model-${account}`, reasoningEffort: 'high' } },
    });
    chat = new ChatroomService({
      file: join(directory, 'rooms.json'),
      getSession: (id) => panes.get(id),
      broadcast: vi.fn(),
    });
    await chat.init();
    chat.delivery.stop();
    const store = new CompanyStore(join(directory, 'company.json'));
    await store.init();
    company = new CompanyService(store, {
      getSession: (id) => panes.get(id),
      runtimeRecipeOf: (id) => recipes.get(id),
      chatrooms: chat,
      research: { start: vi.fn(), inspect: vi.fn(), stop: vi.fn() },
    });
  });

  afterEach(async () => {
    await chat?.stop();
    await rm(directory, { recursive: true, force: true });
  });

  it.each(['start', 'ready', 'audit', 'beforeStop'] as const)(
    'preserves identity, seats, coordinator role, DM and history at the correct recovery boundary after failed %s',
    async (failure) => {
      const employee = await company.hire({
        name: 'Casey',
        icon: 'C',
        position: 'Developer',
        expertise: ['console'],
        sessionId: 'old',
        researchEnabled: false,
      });
      await company.saveRuntimeRecipe('old', recipes.get('old')!);
      await company.setDesiredRunning('old', true);
      const room = chat.createRoom('Workshop', undefined);
      chat.addMember(room.id, 'old', { role: 'coordinator', goal: 'Finish the task' });
      const dm = chat.openDm('old', undefined);
      const original = chat.post(dm.id, { kind: 'user', name: 'Owner' }, 'Keep this conversation', 'all', {
        deliver: false,
      });
      const stopped: string[] = [];
      const postStop = failure === 'start' || failure === 'ready';
      const phase = postStop ? 'recovery-required' : 'failed';
      // The move shows its final phase before its journal save finishes; its failure audit comes after that save.
      let settled = false;
      const journal = new PlanMoveStore(join(directory, 'moves.json'));
      const port: PlanMovePort = {
        load: () => journal.load(),
        save: (records) => journal.save(records),
        snapshot: async () => ({ sessionId: 'old', name: employee.name, account: 'first', working: false }),
        idle: async () => {},
        create: async () => {
          const spawn = company.prepareSpawn({ employeeId: employee.id });
          await company.completeSpawn('candidate', spawn);
          expect(company.view().employees[0].sessionId).toBe('candidate');
          expect(company.view().employees[0].runtimeRecipe?.subscriptionProfile?.id).toBe('second');
          expect(panes.has('old')).toBe(true);
          return 'candidate';
        },
        start: vi.fn(async () => {
          expect(panes.has('old')).toBe(false);
          expect(stopped).toEqual(['old']);
          expect((await journal.load())[0]).toMatchObject({ phase: 'starting', sourceStopRequested: true });
          if (failure === 'start') throw new Error('dead pane');
        }),
        ready: vi.fn(async () => {
          expect(panes.has('old')).toBe(false);
          if (failure === 'ready') throw new Error('dead pane');
        }),
        beforeStop: async () => { if (failure === 'beforeStop') throw new Error('Owner authority expired before stop'); },
        binding: () => company.view().employees.find((person) => person.id === employee.id)?.sessionId,
        exists: (id) => panes.has(id),
        rebind: vi.fn(async (id, sessionId, owner) => {
          await company.rebind(id, owner, sessionId);
        }),
        stop: async (id) => {
          stopped.push(id);
          await company.setDesiredRunning(id, false);
          panes.delete(id);
          return [];
        },
        audit: async record => {
          if (record.phase === phase) settled = true;
          if (failure === 'audit' && record.phase === 'stopping') throw new Error('Audit storage unavailable');
        },
      };
      const moves = new PlanMoves(port);
      const input: PlanMoveInput = {
        id: 'move',
        employeeId: employee.id,
        sessionId: 'old',
        fromAccount: 'first',
        toAccount: 'second',
        forceBusy: false,
        handoff: 'Resume the task.',
      };
      await moves.begin(input);
      await vi.waitFor(() => expect(settled).toBe(true));
      expect((await moves.get('move'))?.phase).toBe(phase);
      const current = postStop ? 'candidate' : 'old';
      const retired = postStop ? 'old' : 'candidate';
      expect(company.view().employees.map((person) => [person.id, person.sessionId])).toEqual([[employee.id, current]]);
      expect(chat.room(room.id)?.members).toMatchObject([
        { sessionId: current, role: 'coordinator', goal: 'Finish the task' },
      ]);
      expect(chat.room(dm.id)?.dm?.slice().sort()).toEqual([current, 'user']);
      expect(chat.room(dm.id)?.members.map((member) => member.sessionId)).toEqual([current]);
      expect(chat.isRetired(current)).toBe(false);
      expect(chat.isRetired(retired)).toBe(true);
      expect(stopped).toEqual(postStop ? ['old', 'candidate'] : ['candidate']);
      expect(panes.has('old')).toBe(!postStop);
      expect(panes.has('candidate')).toBe(false);
      expect(chat.room(dm.id)?.messages.some((message) => message.id === original.id)).toBe(true);
      const persisted = new CompanyStore(join(directory, 'company.json'));
      await persisted.init();
      expect(persisted.snapshot().employees[0].sessionId).toBe(current);
      expect(persisted.snapshot().employees[0].runtimeRecipe).toEqual(recipes.get(current));
      expect(persisted.snapshot().employees[0].desiredRunning).toBe(!postStop);
      expect((await new PlanMoveStore(journal.file).load())[0]).toMatchObject({
        phase, ...(postStop ? { sourceStopRequested: true } : {}),
      });
      if (postStop) {
        expect(port.rebind).not.toHaveBeenCalled();
        await expect(moves.begin({ ...input, id: 'unsafe-retry' })).rejects.toThrow('requiring recovery');
      } else {
        expect(port.start).not.toHaveBeenCalled();
        expect(port.ready).not.toHaveBeenCalled();
        expect(port.rebind).toHaveBeenCalledExactlyOnceWith(employee.id, 'old', undefined);
        expect((await journal.load())[0].sourceStopRequested).toBeUndefined();
      }
      await chat.stop(); // Flush the real service's debounced private persistence before reopening it.
      chat = new ChatroomService({ file: join(directory, 'rooms.json'), getSession: (id) => panes.get(id), broadcast: vi.fn() });
      await chat.init();
      chat.delivery.stop();
      expect(chat.room(room.id)?.members).toMatchObject([{ sessionId: current, role: 'coordinator', goal: 'Finish the task' }]);
      expect(chat.room(dm.id)?.dm?.slice().sort()).toEqual([current, 'user']);
      expect(chat.room(dm.id)?.messages.some((message) => message.id === original.id)).toBe(true);
    }
  );

  it('persists the actual destination recipe for future restarts, and restores it on a failed room rebind', async () => {
    const employee = await company.hire({ name: 'Casey', icon: 'C', position: 'Developer', expertise: ['console'], sessionId: 'old', researchEnabled: false });
    await company.saveRuntimeRecipe('old', recipes.get('old')!);
    const general = chat.createRoom('general', undefined); chat.addMember(general.id, 'old');
    await company.rebind(employee.id, undefined, 'candidate');
    const persisted = new CompanyStore(join(directory, 'company.json')); await persisted.init();
    expect(persisted.snapshot().employees[0]).toMatchObject({ id: employee.id, sessionId: 'candidate', runtimeRecipe: { subscriptionProfile: { id: 'second' }, configs: { codexConfig: { model: 'model-second' } } } });
    vi.spyOn(chat, 'replaceSession').mockRejectedValueOnce(new Error('Room storage unavailable'));
    await expect(company.rebind(employee.id, undefined, 'old')).rejects.toThrow('Room storage unavailable');
    expect(company.view().employees[0]).toMatchObject({ sessionId: 'candidate', runtimeRecipe: recipes.get('candidate') });
    const after = new CompanyStore(join(directory, 'company.json')); await after.init();
    expect(after.snapshot().employees[0].runtimeRecipe).toEqual(recipes.get('candidate'));
  });
});
