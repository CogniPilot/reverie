import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyStore } from '../src/company-store.js';
import { CompanyService } from '../src/company-service.js';
import { ChatroomService, type ChatSessionLike } from '../src/chatroom-service.js';
import { PlanMoves, type PlanMoveInput, type PlanMovePort } from '../src/plan-move.js';

describe('plan move rollback using real company and chatroom persistence', () => {
  let directory: string;
  let chat: ChatroomService;
  let company: CompanyService;
  const panes = new Map<string, ChatSessionLike>();

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'plan-move-company-'));
    panes.clear();
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
      chatrooms: chat,
      research: { start: vi.fn(), inspect: vi.fn(), stop: vi.fn() },
    });
  });

  afterEach(async () => {
    await chat?.stop();
    await rm(directory, { recursive: true, force: true });
  });

  it.each(['start', 'ready'] as const)(
    'restores identity, seats, coordinator role, DM and history after failed %s',
    async (failure) => {
      const employee = await company.hire({
        name: 'Casey',
        icon: 'C',
        position: 'Developer',
        expertise: ['console'],
        sessionId: 'old',
        researchEnabled: false,
      });
      const room = chat.createRoom('Workshop', undefined);
      chat.addMember(room.id, 'old', { role: 'coordinator', goal: 'Finish the task' });
      const dm = chat.openDm('old', undefined);
      const original = chat.post(dm.id, { kind: 'user', name: 'Owner' }, 'Keep this conversation', 'all', {
        deliver: false,
      });
      const stopped: string[] = [];
      const port: PlanMovePort = {
        load: async () => [],
        save: async () => {},
        snapshot: async () => ({ sessionId: 'old', name: employee.name, account: 'first', working: false }),
        idle: async () => {},
        create: async () => {
          const spawn = company.prepareSpawn({ employeeId: employee.id });
          await company.completeSpawn('candidate', spawn);
          expect(company.view().employees[0].sessionId).toBe('candidate');
          expect(panes.has('old')).toBe(true);
          return 'candidate';
        },
        start: async () => {
          if (failure === 'start') throw new Error('dead pane');
        },
        ready: async () => {
          if (failure === 'ready') throw new Error('dead pane');
        },
        beforeStop: async () => {},
        binding: () => company.view().employees.find((person) => person.id === employee.id)?.sessionId,
        exists: (id) => panes.has(id),
        rebind: async (id, sessionId, owner) => {
          await company.rebind(id, owner, sessionId);
        },
        stop: async (id) => {
          stopped.push(id);
          panes.delete(id);
          return [];
        },
        audit: async () => {},
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
      await vi.waitFor(async () => expect((await moves.get('move'))?.phase).toBe('failed'));
      expect(company.view().employees.map((person) => [person.id, person.sessionId])).toEqual([[employee.id, 'old']]);
      expect(chat.room(room.id)?.members).toMatchObject([
        { sessionId: 'old', role: 'coordinator', goal: 'Finish the task' },
      ]);
      expect(chat.room(dm.id)?.dm?.slice().sort()).toEqual(['old', 'user']);
      expect(chat.room(dm.id)?.members.map((member) => member.sessionId)).toEqual(['old']);
      expect(chat.isRetired('old')).toBe(false);
      expect(chat.isRetired('candidate')).toBe(true);
      expect(stopped).toEqual(['candidate']);
      expect(panes.has('old')).toBe(true);
      expect(chat.room(dm.id)?.messages.some((message) => message.id === original.id)).toBe(true);
      const persisted = new CompanyStore(join(directory, 'company.json'));
      await persisted.init();
      expect(persisted.snapshot().employees[0].sessionId).toBe('old');
    }
  );
});
