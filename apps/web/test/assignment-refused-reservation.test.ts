import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registerBotWatches } from '../src/bot-watches-runtime.js';
import { ChatroomService } from '../src/chatroom-service.js';
import { ChatBotRegistry } from '../src/chat-bots.js';
import { BoardStore } from '../src/board-store.js';
import type { CompanyEmployee } from '../src/company-types.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function fixture() {
  vi.stubEnv('REVERIE_ADMIN_PHONE_WAKE', 'enabled');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'assignment-refused-'));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  let at = Date.now();
  const employees = [
    { id: 'worker', name: 'Worker', sessionId: 'sid', sessionGeneration: 1,
      desiredRunning: true, onVacation: false, reportsTo: 'manager' },
    { id: 'manager', name: 'Manager', sessionId: 'mgr', sessionGeneration: 1,
      desiredRunning: true, onVacation: false },
  ] as CompanyEmployee[];
  const chat = new ChatroomService({
    file: path.join(root, 'chat.json'), database: path.join(root, 'chat.db'),
    now: () => at, broadcast: () => {},
    employeeOf: (sid) => employees.find((e) => e.sessionId === sid)?.id,
    getSession: (sid) => ({ id: sid, name: sid, mode: 'hands', status: 'idle',
      pid: 1, isWorking: false, writeViaMux: async () => false }),
  });
  await chat.init();
  cleanups.push(() => chat.stop());
  const room = chat.createRoom('Fixture room', undefined);
  chat.addMember(room.id, 'sid');
  chat.addMember(room.id, 'mgr');
  const bots = new ChatBotRegistry(path.join(root, 'bots.json'));
  await bots.set('status', { name: 'Status', rooms: [room.id], maxPerHour: 3 });
  const board = new BoardStore(path.join(root, 'board.json'));
  await board.init();
  await board.update({}, (s) => s.issues.push({ id: 'task', title: 'Fixture assignment',
    owner: 'worker', status: 'doing', tags: [], links: [], createdAt: at, updatedAt: at,
    end: at + 3600000, scale: 'hour' }));
  const open = async () => {
    const app = Fastify();
    cleanups.push(() => app.close());
    return registerBotWatches(app, { dataPath: (n) => path.join(root, n), bots, board, chat,
      employees: () => employees, running: () => true, multiUser: false,
      verifiedOwner: () => false, now: () => at });
  };
  const runtime = await open();
  await runtime.assignments.configure({ version: 1, type: 'assignment-status', enabled: true,
    botId: 'status', roomIds: [room.id], intervalMinutes: 60, responseMinutes: 5 });
  const messages = () => chat.room(room.id)!.messages.filter((m) => m.from.kind === 'bot');
  return { runtime, chat, bots, board, room, open, messages, now: () => at,
    advance: (ms: number) => { at += ms; },
    answer: () => {
      at += 1000;
      chat.post(room.id, { kind: 'agent', sessionId: 'sid', employeeId: 'worker', name: 'Worker' },
        'On track', 'all', { deliver: false, replyTo: runtime.assignments.status().entries[0]!.promptId });
    },
    seedOldPosts: () => {
      for (let i = 0; i < 2; i++) chat.postDurableBotMessage(bots.get('status')!, room.id,
        'Earlier fixture notice', i, 'all', false);
      at += 600000;
    },
  };
}

describe('assignment reservations through real runtime admission and SQLite chat', () => {
  it('releases refused manager reservations and retries once when actual hourly admission recovers', async () => {
    const f = await fixture();
    f.seedOldPosts();
    await f.runtime.assignments.tick();
    expect(f.runtime.assignments.status().entries[0]?.phase).toBe('asked');
    f.advance(301000);
    for (let i = 0; i < 5; i++) await f.runtime.assignments.tick();
    expect(f.messages()).toHaveLength(3); // No manager message committed.
    expect(f.runtime.assignments.store.snapshot().posts).toHaveLength(1);
    expect(f.runtime.assignments.status().entries[0]?.notifiedManager).toBeUndefined();
    expect(f.board.snapshot().issues.filter((i) => i.id !== 'task')).toHaveLength(1);
    // Earlier actual notices expire; keep the prompt and its quota reservation.
    f.advance(3000000);
    const reopened = await f.open();
    await reopened.assignments.tick();
    await reopened.assignments.tick();
    expect(f.messages()).toHaveLength(4);
    expect(f.messages().at(-1)?.to).toEqual(['mgr']);
    expect(reopened.assignments.store.snapshot().posts).toHaveLength(2);
    expect(f.board.snapshot().issues.filter((i) => i.id !== 'task')).toHaveLength(1);
  });

  it('releases a refused prompt reservation and retains its normal retry cooldown', async () => {
    const f = await fixture();
    f.seedOldPosts();
    await f.bots.set('status', { ...f.bots.get('status')!, maxPerHour: 2 });
    await f.runtime.assignments.tick();
    expect(f.runtime.assignments.status().entries[0]?.phase).toBe('not-delivered');
    expect(f.runtime.assignments.store.snapshot().posts).toEqual([]);
    await f.runtime.assignments.tick();
    expect(f.runtime.assignments.status().entries).toHaveLength(1);
    expect(f.messages()).toHaveLength(2);
    f.advance(3600001);
    const reopened = await f.open();
    await reopened.assignments.tick();
    await reopened.assignments.tick();
    expect(f.messages()).toHaveLength(3);
    expect(reopened.assignments.store.snapshot().posts).toHaveLength(1);
    expect(reopened.assignments.status().entries.at(-1)?.phase).toBe('asked');
  });

  it('releases refused acknowledgement reservations and retries the acknowledgement without applying the reply twice', async () => {
    const f = await fixture();
    f.seedOldPosts();
    await f.runtime.assignments.tick();
    f.answer();
    for (let i = 0; i < 5; i++) await f.runtime.assignments.tick();
    expect(f.messages()).toHaveLength(3);
    expect(f.runtime.assignments.store.snapshot().posts).toHaveLength(1);
    const response = f.runtime.assignments.status().entries[0]!.response!;
    expect(response.applied).toBe(true);
    expect(response.ackAttempted).toBe(false);
    f.advance(3000000);
    const reopened = await f.open();
    await reopened.assignments.tick();
    await reopened.assignments.tick();
    expect(f.messages()).toHaveLength(4);
    expect(f.messages().at(-1)?.text).toContain('[assignment-response:');
    expect(reopened.assignments.status().entries[0]!.response!.messageId).toBe(response.messageId);
    expect(reopened.assignments.status().entries[0]!.history).toEqual([]);
    expect(reopened.assignments.store.snapshot().posts).toHaveLength(2);
  });

  it.each(['prompt', 'manager', 'acknowledgement'] as const)(
    'retains an ambiguous %s reservation and reconciles across restart without duplicate delivery', async (kind) => {
      const f = await fixture();
      if (kind !== 'prompt') await f.runtime.assignments.tick();
      if (kind === 'manager') f.advance(301000);
      if (kind === 'acknowledgement') f.answer();
      const original = f.chat.postDurableBotMessage.bind(f.chat);
      const failed = vi.spyOn(f.chat, 'postDurableBotMessage').mockImplementation((...args) => {
        original(...args);
        throw Error('Fixture durable commit with lost acknowledgement');
      });
      if (kind === 'prompt') {
        await f.runtime.assignments.tick();
        expect(f.runtime.assignments.status().entries[0]?.phase).toBe('unknown');
      } else await expect(f.runtime.assignments.tick()).rejects.toThrow('lost acknowledgement');
      const quota = f.runtime.assignments.store.snapshot().posts;
      expect(quota).toHaveLength(kind === 'prompt' ? 1 : 2);
      expect(f.messages()).toHaveLength(quota.length);
      failed.mockRestore();
      const reopened = await f.open();
      await reopened.assignments.tick();
      await reopened.assignments.tick();
      expect(f.messages()).toHaveLength(quota.length);
      expect(reopened.assignments.store.snapshot().posts).toEqual(quota);
      if (kind === 'manager') expect(reopened.assignments.status().entries[0]?.notifiedManager).toBe('mgr');
      if (kind === 'acknowledgement') expect(reopened.assignments.status().entries[0]?.response?.ackAttempted).toBe(true);
    }
  );

  it('removes exactly the refused slot while preserving an earlier reservation at the same timestamp', async () => {
    const f = await fixture();
    f.seedOldPosts();
    await f.runtime.assignments.tick();
    f.advance(301000);
    await f.runtime.assignments.store.update((s) => { s.posts.push(f.now()); });
    const before = f.runtime.assignments.store.snapshot().posts;
    await f.runtime.assignments.tick();
    expect(f.runtime.assignments.store.snapshot().posts).toEqual(before);
    expect(f.messages()).toHaveLength(3);
    expect(f.runtime.assignments.status().entries[0]?.notifiedManager).toBeUndefined();
  });

  it('retains quota conservatively if the reserved array changes before the known refusal is saved', async () => {
    const f = await fixture();
    await f.runtime.assignments.tick();
    f.advance(301000);
    const before = f.runtime.assignments.store.snapshot().posts;
    vi.spyOn(f.chat, 'checkBotPost').mockImplementation(() => {
      void f.runtime.assignments.store.update((s) => { s.posts.push(f.now() + 1); });
      throw Error('Fixture admission refused while another quota update was queued');
    });
    await f.runtime.assignments.tick();
    expect(f.runtime.assignments.store.snapshot().posts).toEqual([...before, f.now(), f.now() + 1]);
    expect(f.runtime.assignments.status().entries[0]?.notifiedManager).toBeUndefined();
    expect(f.messages()).toHaveLength(1);
  });
});
