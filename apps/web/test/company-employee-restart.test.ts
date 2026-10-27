import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompanyService } from '../src/company-service.js';
import { CompanyStore } from '../src/company-store.js';
import { ChatroomService, type ChatSessionLike } from '../src/chatroom-service.js';

interface Pane extends ChatSessionLike {
  isWorking: boolean;
  writes: string[];
}

// Real company/chatroom services, real persistence, fake pane IO only. Calling
// rebind alone must migrate identity: the test never calls replaceSession for it.
describe('permanent employee across three runtime replacements', () => {
  let directory: string;
  let company: CompanyService;
  let companyStore: CompanyStore;
  let chat: ChatroomService;
  let clock: number;
  const panes = new Map<string, Pane>();
  const threads = new Map<string, string>();

  function pane(id: string, owner?: string): Pane {
    const writes: string[] = [];
    const value: Pane = {
      id,
      name: 'Worker',
      owner,
      mode: 'opencode',
      status: 'running',
      pid: 1,
      isWorking: true,
      writes,
      writeViaMux: async (text, options) => {
        writes.push(text);
        options?.onOutcome?.('submitted');
        return true;
      },
    };
    panes.set(id, value);
    return value;
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'employee-restart-'));
    clock = Date.now();
    panes.clear();
    threads.clear();
    for (let i = 0; i <= 3; i++) pane(`worker-${i}`);
    companyStore = new CompanyStore(join(directory, 'company.json'));
    await companyStore.init();
    chat = new ChatroomService({
      file: join(directory, 'chatrooms.json'),
      getSession: (id) => panes.get(id),
      broadcast: vi.fn(),
      now: () => clock,
    });
    await chat.init();
    // No background poll: each delivery check explicitly flushes the queue.
    chat.delivery.stop();
    company = new CompanyService(companyStore, {
      getSession: (id) => panes.get(id),
      chatrooms: chat,
      threadOf: (id) => threads.get(id),
      now: () => clock,
      research: { start: vi.fn(), inspect: vi.fn(), stop: vi.fn() },
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await chat?.stop();
    await rm(directory, { recursive: true, force: true });
  });

  async function employee(sessionId = 'worker-0') {
    return company.hire({
      name: 'Worker',
      icon: '🦊',
      position: 'COO',
      expertise: ['coordination'],
      sessionId,
      researchEnabled: false,
    });
  }

  it('keeps one employee and room seat, coordinator role, DM and history through three rebinds', async () => {
    const hired = await employee();
    const memory = await company.remember(hired.id, undefined, 'Keep the dragon story');
    const room = chat.createRoom('reverie', undefined);
    chat.addMember(room.id, 'worker-0', { role: 'coordinator', goal: 'Coordinate', icon: '🦊' });
    const dm = chat.openDm('worker-0', undefined);
    const message = chat.post(
      room.id,
      { kind: 'agent', name: 'Worker', sessionId: 'worker-0' },
      'Original thread handoff',
      'all',
      { deliver: false }
    );
    const direct = chat.post(dm.id, { kind: 'user', name: 'Owner' }, 'Original DM history', 'all', { deliver: false });

    for (let i = 1; i <= 3; i++) {
      const current = `worker-${i}`;
      await company.rebind(hired.id, undefined, current);
      expect(company.view().employees.map((e) => [e.id, e.sessionId])).toEqual([[hired.id, current]]);
      expect(company.view().employees[0].sessionGeneration).toBe(i + 1);
      expect(company.view().memories).toContainEqual(memory);
      for (const original of [room, dm]) {
        const present = chat.room(original.id)!;
        expect(present.members.filter((m) => m.sessionId.startsWith('worker-')).map((m) => m.sessionId)).toEqual([
          current,
        ]);
        expect(chat.view(present).members.filter((m) => m.name === 'Worker')).toHaveLength(1);
      }
      expect(chat.view(chat.room(room.id)!).coordinatorId).toBe(current);
      expect(chat.room(room.id)!.members.find((m) => m.sessionId === current)).toMatchObject({
        goal: 'Coordinate',
        icon: '🦊',
      });
      expect(chat.openDm(current, undefined).id).toBe(dm.id);
      // Public history stays exact while internal phone eligibility travels with the stored record.
      expect(chat.view(chat.room(room.id)!).messages).toContainEqual(message);
      expect(chat.view(chat.room(dm.id)!).messages).toContainEqual(direct);
      // The author of an old message stays the original runtime, not rewritten.
      expect(message.from).toMatchObject({ sessionId: 'worker-0' });
      expect(chat.room(room.id)!.messages.find(item => item.id === message.id)!.from).toMatchObject({ sessionId: 'worker-0' });
      for (let old = 0; old < i; old++) expect(chat.roomsFor(`worker-${old}`)).toEqual([]);
    }
    await chat.stop();
    await chat.init();
    chat.delivery.stop();
    const loaded = new CompanyStore(companyStore.file);
    await loaded.init();
    expect(loaded.snapshot().employees).toHaveLength(1);
    expect(loaded.snapshot().employees[0]).toMatchObject({ id: hired.id, sessionId: 'worker-3' });
    expect(chat.openDm('worker-3', undefined).id).toBe(dm.id);
    expect(chat.view(chat.room(dm.id)!).messages).toContainEqual(direct);
  });

  it('drops old queued deliveries and resolves each new mention to only the current runtime', async () => {
    const hired = await employee();
    const room = chat.createRoom('work', undefined);
    chat.addMember(room.id, 'worker-0');
    for (let i = 1; i <= 3; i++) {
      const old = panes.get(`worker-${i - 1}`)!;
      const current = panes.get(`worker-${i}`)!;
      old.isWorking = true;
      chat.post(room.id, { kind: 'user', name: 'Owner' }, `@Worker queued before restart ${i}`);
      expect(chat.delivery.pendingFor(old.id)).toBeGreaterThan(0);
      await company.rebind(hired.id, undefined, current.id);
      expect(chat.delivery.pendingFor(old.id)).toBe(0);
      const recipients = chat.resolveRecipients(chat.room(room.id)!, ['Worker']);
      expect(recipients).toEqual([current.id]);
      chat.post(room.id, { kind: 'user', name: 'Owner' }, `@Worker new runtime ${i}`, recipients);
      for (const value of panes.values()) value.isWorking = false;
      clock += 10_000;
      await chat.delivery.flushAll();
      expect(current.writes.some((line) => line.includes(`new runtime ${i}`))).toBe(true);
      for (let retired = 0; retired < i; retired++) expect(panes.get(`worker-${retired}`)!.writes).toEqual([]);
      // Clear the just-served runtime's writes to distinguish any later stale send.
      current.writes.length = 0;
      for (const value of panes.values()) value.isWorking = true;
    }
  });

  it('does not merge another employee merely because its name is also Worker', async () => {
    const hired = await employee();
    pane('different-employee');
    // Old stores can contain duplicate display names. Seed that persisted legacy
    // state directly: new hires intentionally require distinct company names.
    const other = { ...hired, id: 'legacy-other-employee', sessionId: 'different-employee' };
    await companyStore.update(state => { state.employees.push(other); });
    await companyStore.init();
    const room = chat.createRoom('other employee room', undefined);
    chat.addMember(room.id, 'different-employee');
    for (let i = 1; i <= 3; i++) await company.rebind(hired.id, undefined, `worker-${i}`);
    expect(company.view().employees).toHaveLength(2);
    expect(company.view().employees.find((e) => e.id === other.id)?.sessionId).toBe('different-employee');
    expect(chat.room(room.id)!.members.map((m) => m.sessionId)).toEqual(['different-employee']);
  });

  it('does not leave the employee bound to the successor when membership migration fails', async () => {
    const hired = await employee();
    const room = chat.createRoom('migration failure', undefined);
    chat.addMember(room.id, 'worker-0');
    const before = structuredClone(chat.room(room.id));
    vi.spyOn(chat, 'replaceSession').mockRejectedValueOnce(new Error('migration failed'));
    await expect(company.rebind(hired.id, undefined, 'worker-1')).rejects.toThrow('migration failed');
    expect(company.view().employees[0].sessionId).toBe('worker-0');
    expect(company.view().employees[0].sessionGeneration).toBe(3);
    expect(chat.room(room.id)).toEqual(before);
  });

  it('does not undo a bind that a concurrent rebind has since moved on', async () => {
    const hired = await employee();
    chat.addMember(chat.createRoom('race', undefined).id, 'worker-0');
    vi.spyOn(chat, 'replaceSession').mockImplementationOnce(async () => {
      // While this move is in flight another rebind lands on a third session.
      await companyStore.update((state) => {
        state.employees[0].sessionId = 'worker-2';
      });
      throw new Error('migration failed');
    });
    await expect(company.rebind(hired.id, undefined, 'worker-1')).rejects.toThrow('migration failed');
    expect(company.view().employees[0].sessionId).toBe('worker-2');
  });

  it('posts no move notice for a move that was rolled back', async () => {
    const hired = await employee();
    const room = chat.createRoom('notices', undefined);
    chat.addMember(room.id, 'worker-0');
    vi.spyOn(chat as any, 'changed').mockImplementationOnce(() => {
      throw new Error('broadcast failed');
    });
    await expect(company.rebind(hired.id, undefined, 'worker-1')).rejects.toThrow('broadcast failed');
    expect(JSON.stringify(chat.room(room.id)!.messages)).not.toContain('moved to a new session');
  });

  it('keeps the move when its audit line cannot be written', async () => {
    const hired = await employee();
    const room = chat.createRoom('audit', undefined);
    chat.addMember(room.id, 'worker-0');
    vi.spyOn(chat as any, 'audit').mockRejectedValue(new Error('disk full'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await company.rebind(hired.id, undefined, 'worker-1');
    expect(company.view().employees[0].sessionId).toBe('worker-1');
    expect(chat.room(room.id)!.members.map((m) => m.sessionId)).toEqual(['worker-1']);
    expect(JSON.stringify(chat.room(room.id)!.messages)).toContain('moved to a new session');
    expect(warn).toHaveBeenCalled();
  });

  it('leaves no room half-moved when the second of three rooms fails mid-migration', async () => {
    const hired = await employee();
    const rooms = ['one', 'two', 'three'].map((name) => chat.createRoom(name, undefined));
    for (const r of rooms) chat.addMember(r.id, 'worker-0', { role: r === rooms[0] ? 'coordinator' : 'agent' });
    const dm = chat.openDm('worker-0', undefined);
    const before = [...rooms, dm].map((r) => structuredClone(chat.room(r.id)!.members));
    const dmBefore = [...chat.room(dm.id)!.dm!];
    const real = (chat as any).changed.bind(chat);
    let calls = 0;
    vi.spyOn(chat as any, 'changed').mockImplementation((...args: unknown[]) => {
      if (++calls === 2) throw new Error('room two failed');
      return real(...args);
    });
    await expect(company.rebind(hired.id, undefined, 'worker-1')).rejects.toThrow('room two failed');
    expect(company.view().employees[0].sessionId).toBe('worker-0');
    [...rooms, dm].forEach((r, i) => expect(chat.room(r.id)!.members).toEqual(before[i]));
    expect(chat.room(dm.id)!.dm).toEqual(dmBefore);
    // Nothing was retired, so the next attempt starts clean and moves all of them.
    vi.restoreAllMocks();
    await company.rebind(hired.id, undefined, 'worker-1');
    for (const r of [...rooms, dm]) {
      expect(chat.room(r.id)!.members.map((m) => m.sessionId)).toEqual(['worker-1']);
    }
  });

  it('keeps the employee\'s thread across sessions: adopted when known, kept when the successor has none, restored on a failed move', async () => {
    threads.set('worker-0', 'ses_first');
    const hired = await employee();
    expect(hired.threadId).toBe('ses_first');
    // A fresh, never-resumed successor (no thread of its own) leaves the person's thread alone.
    await company.rebind(hired.id, undefined, 'worker-1');
    expect(company.view().employees[0].threadId).toBe('ses_first');
    // A successor that runs a thread brings it.
    threads.set('worker-2', 'ses_second');
    await company.rebind(hired.id, undefined, 'worker-2');
    expect(company.view().employees[0].threadId).toBe('ses_second');
    // A failed move undoes the thread with the binding.
    threads.set('worker-3', 'ses_third');
    vi.spyOn(chat, 'replaceSession').mockRejectedValueOnce(new Error('migration failed'));
    const room = chat.createRoom('thread rollback', undefined);
    chat.addMember(room.id, 'worker-2');
    await expect(company.rebind(hired.id, undefined, 'worker-3')).rejects.toThrow('migration failed');
    expect(company.view().employees[0]).toMatchObject({ sessionId: 'worker-2', threadId: 'ses_second' });
    // The owner can seed or clear it, and the next replacement is told it.
    await company.setThread(hired.id, undefined, 'ses_seed');
    expect(company.prepareSpawn({ employeeId: hired.id }).threadId).toBe('ses_seed');
    await company.setThread(hired.id, undefined, null);
    expect(company.prepareSpawn({ employeeId: hired.id }).threadId).toBeUndefined();
    await expect(company.setThread('nobody', undefined, 'x')).rejects.toThrow('Unknown employee');
  });

  it('refuses a foreign-owner target without changing membership, identity or history', async () => {
    const hired = await employee();
    pane('foreign-worker', 'another-owner');
    const room = chat.createRoom('private', undefined);
    chat.addMember(room.id, 'worker-0');
    const before = structuredClone(chat.room(room.id));
    await expect(company.rebind(hired.id, undefined, 'foreign-worker')).rejects.toThrow('owned');
    expect(company.view().employees[0].sessionId).toBe('worker-0');
    expect(chat.room(room.id)).toEqual(before);
  });
});
