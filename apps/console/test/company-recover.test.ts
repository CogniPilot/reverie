import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CompanyStore } from '../src/company-store.js';
import { CompanyError, CompanyService, type CompanyResearchBackend } from '../src/company-service.js';
import { ChatroomStore } from '../src/chatroom-store.js';
import type { RetiredSession } from '../src/chatroom-service.js';

describe('CTO/COO recovery of an employee whose session is gone', () => {
  let directory: string;
  let store: CompanyStore;
  let rooms: ChatroomStore;
  let service: CompanyService;
  let sessions: Map<string, { id: string; name: string; owner?: string }>;
  let retired: RetiredSession[];
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
    service = new CompanyService(store, {
      getSession: (id) => sessions.get(id),
      chatrooms: {
        rooms: () => rooms.list(),
        room: (id) => rooms.get(id),
        addMember: (id, sessionId, options) => rooms.addMember(id, sessionId, options).member,
        replaceSession: async (oldId, newId, _by, canTouch) =>
          rooms.replaceMember(oldId, newId, rooms.list().filter(canTouch)).map((r) => ({ id: r.id, name: r.name })),
        retiredSessions: (canSee = () => true) => retired.filter((r) => canSee(r.owner)),
      },
      research: backend,
      now: () => Date.parse('2026-10-18T21:00:00Z'),
    });
    for (const [id, name] of [['cto-1', 'Reviewer'], ['coo-1', 'Worker'], ['dev-1', 'Rosa'], ['ops-new', 'Coordinator']]) add(id, name);
    const hire = (name: string, position: string, sessionId: string) =>
      service.hire({ name, icon: '🧭', position, expertise: ['ops'], sessionId, researchEnabled: false });
    await hire('Reviewer', 'CTO', 'cto-1');
    await hire('Worker', 'COO', 'coo-1');
    await hire('Rosa', 'Engineer', 'dev-1');
    await hire('Coordinator', 'Runtime engineer', 'ops-new');
    // A plan switch: ops-old (still running) was retired for ops-new, which then died.
    add('ops-old', 'Coordinator');
    retire('ops-old', 'ops-new');
    sessions.delete('ops-new');
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const coordinator = () => service.view().employees.find((e) => e.name === 'Coordinator')!;
  const fails = async (work: Promise<unknown>, status: number) => {
    const error = await work.then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(CompanyError);
    expect((error as CompanyError).status).toBe(status);
  };

  it('lets the CTO move a gone employee, with every room seat, back onto its retired predecessor', async () => {
    const room = rooms.create('Ops', undefined);
    rooms.addMember(room.id, 'ops-new', { role: 'coordinator' });
    expect((await service.recover(coordinator().id, undefined, 'cto-1', 'ops-old')).sessionId).toBe('ops-old');
    expect(rooms.get(room.id)?.members.map((m) => [m.sessionId, m.role])).toEqual([['ops-old', 'coordinator']]);
  });

  it('lets the COO do the same', async () => {
    expect((await service.recover(coordinator().id, undefined, 'coo-1', 'ops-old')).sessionId).toBe('ops-old');
  });

  it('refuses a session renamed to the employee: a name is not identity', async () => {
    add('imposter', 'Coordinator');
    await fails(service.recover(coordinator().id, undefined, 'cto-1', 'imposter'), 409);
    // A retired record for some other successor is not enough either.
    retire('imposter', 'someone-else');
    await fails(service.recover(coordinator().id, undefined, 'cto-1', 'imposter'), 409);
    expect(coordinator().sessionId).toBe('ops-new');
  });

  it('refuses a caller that is not the CTO or COO, is not bound, or is gone itself', async () => {
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
