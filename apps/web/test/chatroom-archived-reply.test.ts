import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { ChatDb } from '../src/chat-db.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatroomService } from '../src/chatroom-service.js';
import { ChatroomStore, MAX_MESSAGES_PER_ROOM, type ChatMessage } from '../src/chatroom-store.js';
import { ChatFileStore } from '../src/chatroom-files.js';
import { registerChatroomRoutes } from '../src/web/routes/chatroom-routes.js';
import { trustedFixtureOwner } from './helpers/trusted-owner-fixture.js';
import { createRouteTestHarness } from './routes/_route-test-utils.js';
import { createMockSession } from './mocks/index.js';

const A = '0000002d-0035-4000-8000-000000000047';
const B = '00000038-0043-4000-8000-000000000060';
const C = '00000049-0052-4000-8000-000000000071';
const UNKNOWN = '00000000-0000-4000-8000-000000000099';

describe('replies beyond the recent-message window', () => {
  let service: ChatroomService;
  let directory: string;
  let fixtureRoot: string, seedDirectory: string;
  let seed: Awaited<ReturnType<typeof buildArchivedTargets>>;
  let seedCounts: { rooms: number; messages: number };
  const opened = new Set<string>();
  const close = async () => {
    await service.stop();
    opened.delete(directory);
  };
  const open = async () => {
    service = makeService();
    opened.add(directory);
    await service.init();
    service.delivery.stop();
  };
  const closedDatabases = (root: string) => {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      expect(lstatSync(path).isSymbolicLink()).toBe(false);
      expect(/-(wal|shm)$/.test(entry.name)).toBe(false);
      if (entry.isDirectory()) closedDatabases(path);
    }
  };
  const sessions = new Map([A, B, C].map((id) => [id, {
    id, name: id === B ? 'Bobby' : 'Alice', pid: 42, mode: 'opencode',
    status: 'idle', isWorking: true, writeViaMux: async () => true,
  }]));
  const makeService = () => new ChatroomService({ file: join(directory, 'rooms.json'),
    database: join(directory, 'chat.db'), getSession: id => sessions.get(id),
    employeeOf: id => `employee-${id}`, broadcast: () => {} });
  // This setup used to share each case's 30s budget; do not reduce it to the 10s hook default.
  beforeAll(async () => {
    vi.stubEnv('REVERIE_ADMIN_PHONE_WAKE', 'enabled');
    fixtureRoot = mkdtempSync(join(tmpdir(), 'archived-reply-suite-'));
    seedDirectory = join(fixtureRoot, 'closed-real-seed');
    mkdirSync(seedDirectory, { mode: 0o700 });
    directory = seedDirectory;
    await open();
    try {
      // Earn history once through ALL real durable posts and eviction checks.
      seed = await buildArchivedTargets();
    } finally {
      // stop flushes pending state, waits archive gzip and closes every DB.
      await close();
    }
    const db = ChatDb.open(join(seedDirectory, 'chat.db'));
    try {
      const checkpoint = db.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
      expect(checkpoint?.busy).toBe(0);
      seedCounts = db.counts();
      expect(seedCounts.rooms).toBe(2);
      // Membership events also legitimately occupy history rows.
      expect(seedCounts.messages).toBeGreaterThan(MAX_MESSAGES_PER_ROOM + 3);
    } finally {
      db.close();
    }
    closedDatabases(seedDirectory);
    vi.unstubAllEnvs();
  }, 30_000);
  beforeEach(async () => {
    vi.stubEnv('REVERIE_ADMIN_PHONE_WAKE', 'enabled');
    directory = mkdtempSync(join(fixtureRoot, 'empty-case-'));
    await open();
  });
  afterEach(async () => {
    await close();
    vi.unstubAllEnvs();
  });
  afterAll(() => {
    // Never remove a fixture whose service did not confirm its DB closure.
    expect(opened.size).toBe(0);
    if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
  });

  async function archivedTargets() {
    await close();
    directory = mkdtempSync(join(fixtureRoot, 'independent-archive-case-'));
    closedDatabases(seedDirectory);
    // The source is CLOSED and checkpointed, including its archive. Each case
    // gets distinct inodes; no active SQLite/WAL file is ever copied.
    for (const name of readdirSync(seedDirectory)) {
      cpSync(join(seedDirectory, name), join(directory, name), { recursive: true, force: false, errorOnExist: true });
    }
    expect(statSync(join(directory, 'chat.db')).ino).not.toBe(statSync(join(seedDirectory, 'chat.db')).ino);
    closedDatabases(directory);
    expect(existsSync(join(directory, 'chat.db-wal'))).toBe(false);
    const db = ChatDb.open(join(directory, 'chat.db'));
    try {
      expect(db.counts()).toEqual(seedCounts);
    } finally {
      db.close();
    }
    closedDatabases(directory);
    await open();
    const room = service.room(seed.room.id)!;
    expect(room.messages.some((message) => message.id === seed.target.id || message.id === seed.deleted.id)).toBe(
      false
    );
    expect(service.exactAgentRead(A, room.id, seed.target.id).message.text).toBe(seed.target.text);
    return {
      room,
      target: structuredClone(seed.target),
      deleted: structuredClone(seed.deleted),
      foreign: structuredClone(seed.foreign),
    };
  }
  async function buildArchivedTargets() {
    const room = service.createRoom('Shared', undefined);
    service.addMember(room.id, A);
    service.addMember(room.id, B);
    service.setRoomWake(room.id, 'mentions');
    service.setMemberNotify(room.id, B, 'mentions');
    await service.setAlertMode(B, 'ring', 60_000);
    const target = service.post(room.id, { kind: 'agent', sessionId: B, name: 'Bobby' },
      'archived parent context', 'all', { deliver: false });
    const deleted = service.post(room.id, { kind: 'user', name: 'owner' },
      'deleted parent', 'all', { deliver: false });
    await service.deleteMessage(room.id, deleted.id, 'owner');
    const other = service.createRoom('Other', undefined);
    const foreign = service.post(other.id, { kind: 'user', name: 'owner' },
      'other room parent', 'all', { deliver: false });
    for (let i = 0; i <= MAX_MESSAGES_PER_ROOM; i++) {
      service.post(room.id, { kind: 'agent', sessionId: A, name: 'Alice' },
        `later ${i}`, 'all', { deliver: false });
    }
    expect(room.messages.some(message => message.id === target.id || message.id === deleted.id)).toBe(false);
    expect(service.exactAgentRead(A, room.id, target.id).message.text).toBe(target.text);
    return { room, target, deleted, foreign };
  }

  it('accepts the exact-readable parent and preserves quoting, wake policy and restart recovery', async () => {
    const { room, target } = await archivedTargets();
    const queued = vi.spyOn(service.delivery, 'enqueue');
    const reply = service.post(room.id, { kind: 'agent', sessionId: A, name: 'Alice' },
      'answer without a mention', 'all', { replyTo: target.id });
    const delivery = queued.mock.calls.find(call => call[0] === B && call[3]?.messageId === reply.id);
    expect(delivery).toBeDefined();
    expect(delivery![2]).toContain('archived parent context');
    expect(delivery![3]?.passive).not.toBe(true);
    expect(service.phoneAccepts(B, room.id, reply.id)).toBe(true);
    expect(room.messages.some(message => message.id === target.id)).toBe(false);
    expect(room.messages.length).toBeLessThanOrEqual(MAX_MESSAGES_PER_ROOM);
    await close();

    service = makeService();
    const recovered = vi.spyOn(service.delivery, 'enqueue');
    await service.init();
    opened.add(directory);
    service.delivery.stop();
    const restored = recovered.mock.calls.find(call => call[0] === B && call[3]?.messageId === reply.id);
    expect(restored).toBeDefined();
    expect(restored![2]).toContain('archived parent context');
    expect(restored![3]?.passive).toBe(false);
    expect(service.exactAgentRead(A, room.id, reply.id).message.replyTo).toBe(target.id);
    expect(service.room(room.id)!.messages.some(message => message.id === target.id)).toBe(false);
    expect(service.post(room.id, { kind: 'agent', sessionId: A, name: 'Alice' },
      'another answer', 'all', { deliver: false, replyTo: target.id }).replyTo).toBe(target.id);
  });

  it('keeps membership, room identity, deletion and strict request validation at the HTTP boundary', async () => {
    const { room, target, deleted, foreign } = await archivedTargets();
    const { app } = await createRouteTestHarness((fastify, context) => {
      for (const id of [A, B, C]) context.sessions.set(id, createMockSession(id));
      registerChatroomRoutes(fastify, context, service, new ChatFileStore(directory), trustedFixtureOwner);
    });
    const url = `/api/chatrooms/${room.id}/messages`;
    const headers = { 'x-reverie-parent-session': A };
    try {
      expect((await app.inject({ method: 'GET', url: url + '/' + target.id, headers })).statusCode).toBe(200);
      const accepted = await app.inject({ method: 'POST', url, headers,
        payload: { text: 'HTTP answer', replyTo: target.id, requireAgent: true } });
      expect(accepted.statusCode).toBe(200);
      expect(accepted.json().data.message.replyTo).toBe(target.id);
      const before = service.room(room.id)!.messages.map(message => message.id);
      for (const replyTo of [deleted.id, foreign.id, UNKNOWN]) {
        expect((await app.inject({ method: 'POST', url, headers,
          payload: { text: 'refused', replyTo, requireAgent: true } })).statusCode).toBe(400);
      }
      expect((await app.inject({ method: 'POST', url,
        headers: { 'x-reverie-parent-session': C },
        payload: { text: 'outsider', replyTo: target.id, requireAgent: true } })).statusCode).toBe(404);
      expect((await app.inject({ method: 'POST', url, headers,
        payload: { text: 'untrusted parent', replyTo: target.id, replyTarget: target, requireAgent: true } })).statusCode).toBe(400);
      expect(service.room(room.id)!.messages.map(message => message.id)).toEqual(before);
    } finally { await app.close(); }
  });

  it('keeps the quote when posting the reply itself evicts the oldest recent parent', () => {
    const room = service.createRoom('Boundary', undefined);
    const target = service.post(room.id, { kind: 'user', name: 'owner' },
      'parent at the eviction boundary', 'all', { deliver: false });
    service.addMember(room.id, A);
    service.addMember(room.id, B);
    while (room.messages.length < MAX_MESSAGES_PER_ROOM) {
      service.post(room.id, { kind: 'agent', sessionId: A, name: 'Alice' },
        'later', 'all', { deliver: false });
    }
    expect(room.messages[0].id).toBe(target.id);
    const queued = vi.spyOn(service.delivery, 'enqueue');
    const reply = service.post(room.id, { kind: 'agent', sessionId: A, name: 'Alice' },
      'boundary answer', 'all', { replyTo: target.id });
    expect(room.messages.some(message => message.id === target.id)).toBe(false);
    const delivery = queued.mock.calls.find(call => call[0] === B && call[3]?.messageId === reply.id);
    expect(delivery).toBeDefined();
    expect(delivery![2]).toContain('parent at the eviction boundary');
  });

  it('does not create a reply for a deleted, unknown or foreign archived target', async () => {
    const { room, deleted, foreign } = await archivedTargets();
    const before = room.messages.map(message => message.id);
    for (const replyTo of [deleted.id, foreign.id, UNKNOWN]) {
      expect(() => service.post(room.id, { kind: 'agent', sessionId: A, name: 'Alice' },
        'refused', 'all', { deliver: false, replyTo })).toThrow('not in this room');
    }
    expect(room.messages.map(message => message.id)).toEqual(before);
  });
});

describe('store historical-parent resolver', () => {
  it.each(['wrong-room', 'wrong-id', 'deleted', 'missing'] as const)('refuses %s resolver output', kind => {
    const lookup = vi.fn((_roomId: string, _messageId: string): ChatMessage | undefined => candidate);
    const store = new ChatroomStore([], lookup);
    const room = store.create('Shared', undefined);
    const original = store.post(room.id, { kind: 'user', name: 'owner' }, 'original');
    let candidate: ChatMessage | undefined = { ...original };
    room.messages.length = 0;
    if (kind === 'wrong-room') candidate.roomId = 'foreign-room';
    if (kind === 'wrong-id') candidate.id = 'different-id';
    if (kind === 'deleted') candidate.deleted = { at: 1, by: 'owner' };
    if (kind === 'missing') candidate = undefined;
    expect(() => store.post(room.id, { kind: 'user', name: 'owner' }, 'reply', 'all', 2,
      { replyTo: original.id })).toThrow('not in this room');
    expect(room.messages).toEqual([]);
  });
  it('does not resolve past a current tombstone or admit a reply after lookup failure', () => {
    const lookup = vi.fn((): ChatMessage | undefined => { throw new Error('history unavailable'); });
    const store = new ChatroomStore([], lookup);
    const room = store.create('Shared', undefined);
    const original = store.post(room.id, { kind: 'user', name: 'owner' }, 'original');
    store.tombstone(room.id, original.id, 'owner', 1);
    expect(() => store.post(room.id, { kind: 'user', name: 'owner' }, 'reply', 'all', 2,
      { replyTo: original.id })).toThrow('not in this room');
    expect(lookup).not.toHaveBeenCalled();
    room.messages.length = 0;
    expect(() => store.post(room.id, { kind: 'user', name: 'owner' }, 'reply', 'all', 2,
      { replyTo: original.id })).toThrow('history unavailable');
    expect(room.messages).toEqual([]);
  });
});
