import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatDb } from '../src/chat-db.js';
import { ChatroomService } from '../src/chatroom-service.js';
import type { ChatMessage, ChatRoom } from '../src/chatroom-store.js';
import { createMockSession } from './mocks/index.js';

const A = '0000002d-0035-4000-8000-000000000047',
  B = '00000038-0043-4000-8000-000000000060';
const fixtures: Array<{ directory: string; service: ChatroomService; db: ChatDb }> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) {
    await f.service.stop();
    f.db.close();
    rmSync(f.directory, { recursive: true, force: true });
  }
});
const owner = (id: string, at = 1): ChatMessage => ({
  id,
  roomId: 'room',
  at,
  from: { kind: 'user', name: 'Owner', mark: 'owner_typed' },
  text: '@Reviewer original request',
  to: 'all',
});
const peer = (id: string, at: number): ChatMessage => ({
  id,
  roomId: 'room',
  at,
  from: { kind: 'agent', sessionId: B, employeeId: 'employee-b', name: 'Peer' },
  text: 'ordinary later traffic',
  to: 'all',
});
async function fixture(messages: ChatMessage[], roomOwner = 'alice') {
  const directory = mkdtempSync(join(tmpdir(), 'notice-index-')),
    file = join(directory, 'chat.db');
  const db = ChatDb.open(file);
  const room = {
    id: 'room',
    name: 'Office',
    owner: roomOwner,
    createdAt: 0,
    members: [
      { sessionId: A, role: 'agent', goal: '', progress: '', joinedAt: 0, updatedAt: 0 },
      { sessionId: B, role: 'agent', goal: '', progress: '', joinedAt: 0, updatedAt: 0 },
    ],
    messages,
  } as ChatRoom;
  db.sync([room], 1000);
  const sessions = new Map([
    [A, createMockSession(A)],
    [B, createMockSession(B)],
  ]);
  sessions.get(A)!.name = 'Reviewer';
  sessions.get(B)!.name = 'Peer';
  sessions.get(A)!.owner = 'alice';
  sessions.get(B)!.owner = 'alice';
  const service = new ChatroomService({
    file: join(directory, 'rooms.json'),
    database: file,
    getSession: (id) => sessions.get(id),
    employeeOf: (id) => (id === A ? 'employee-a' : 'employee-b'),
    deferDeliveryRecovery: true,
    broadcast: () => {},
    now: () => 1000000,
  });
  await service.init();
  const f = { directory, db, service, sessions };
  fixtures.push(f);
  return f;
}

it('uses durable owner/reply indexes and bounded cursors, with no sort or peer-history table scan', async () => {
  const f = await fixture([
    owner('q1'),
    owner('q2'),
    owner('q3'),
    ...Array.from({ length: 1001 }, (_, i) => peer('peer-' + i, 10 + i)),
  ]);
  const budget = { rows: 2, bytes: 8192 },
    first = f.db.noticeHistory('room', budget);
  expect(first.messages.map((m) => m.id)).toEqual(['q3', 'q2']);
  expect(first.complete).toBe(false);
  expect(first.before).toEqual({ at: 1, id: 'q2' });
  const next = f.db.noticeHistory('room', { rows: 1000, bytes: 8 * 1024 * 1024 }, first.before);
  expect(next.messages.map((m) => m.id)).toEqual(['q1']);
  expect(next.complete).toBe(true);
  const plans = [
    f.db.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT data FROM messages INDEXED BY messages_owner_notice WHERE room_id=? AND json_extract(data,'$.from.kind')='user' AND json_extract(data,'$.from.mark') IN ('owner_typed','owner_spoken') AND (at,id)<(?,?) ORDER BY at DESC,id DESC LIMIT ?"
      )
      .all('room', 2, 'q4', 3),
    f.db.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT data FROM messages INDEXED BY messages_notice_reply WHERE room_id=? AND json_extract(data,'$.from.kind')='agent' AND json_extract(data,'$.replyTo') IS NOT NULL AND json_extract(data,'$.replyTo') IN (SELECT value FROM json_each(?)) LIMIT ?"
      )
      .all('room', '["q1"]', 3),
  ];
  expect(JSON.stringify(plans[0])).toContain('USING INDEX messages_owner_notice');
  expect(JSON.stringify(plans[1])).toContain('USING INDEX messages_notice_reply');
  expect(JSON.stringify(plans)).not.toContain('TEMP B-TREE');
});

it('retains explicit handling of an archived owner request without any delivery ACK', async () => {
  const q = owner('original'),
    f = await fixture([q, ...Array.from({ length: 1001 }, (_, i) => peer('p' + i, 10 + i))]);
  f.service.markSeen(A, 'room', 'p1000');
  expect(f.service.turnSummary(A).messages).toContainEqual(
    expect.objectContaining({ messageId: q.id, state: 'reply-pending' })
  );
  const ack = vi.spyOn(f.service.delivery, 'acknowledgeRead');
  const { readToken } = f.service.exactAgentRead(A, 'room', q.id);
  f.service.resolveNotice(A, { roomId: 'room', messageId: q.id, readToken, disposition: 'handled' });
  expect(f.service.turnSummary(A).messages).not.toContainEqual(expect.objectContaining({ messageId: q.id }));
  expect(ack).not.toHaveBeenCalled();
  q.text = '@Reviewer changed archived request';
  q.edited = { at: 2000 };
  f.db.db.prepare('UPDATE messages SET data=? WHERE room_id=? AND id=?').run(JSON.stringify(q), 'room', q.id);
  expect(f.service.turnSummary(A).messages).toContainEqual(
    expect.objectContaining({ messageId: q.id, attention: { disposition: 'pending' } })
  );
});

it('recognizes a valid archived linked answer and reopens after that answer is edited', async () => {
  const q = owner('original'),
    answer = {
      ...peer('answer', 2),
      replyTo: q.id,
      from: { kind: 'agent', sessionId: A, employeeId: 'employee-a', name: 'Reviewer' },
    } as ChatMessage;
  const f = await fixture([q, answer, ...Array.from({ length: 1001 }, (_, i) => peer('p' + i, 10 + i))]);
  f.service.markSeen(A, 'room', 'p1000');
  expect(f.service.turnSummary(A).messages).not.toContainEqual(expect.objectContaining({ messageId: q.id }));
  answer.edited = { at: 2000 };
  f.db.db.prepare('UPDATE messages SET data=? WHERE room_id=? AND id=?').run(JSON.stringify(answer), 'room', answer.id);
  expect(f.service.turnSummary(A).messages).toContainEqual(
    expect.objectContaining({ messageId: q.id, attention: { disposition: 'pending' } })
  );
});

it('keeps bounded discovery explicit, and the next own page exposes every examined source reference', async () => {
  const f = await fixture(Array.from({ length: 1005 }, (_, i) => owner('q' + String(i).padStart(4, '0'), i + 1)));
  const first = f.service.turnSummary(A);
  expect(first.historyCoverage?.state).toBe('bounded');
  expect(first.text).toContain('counts cover examined sources only');
  expect(first.text.length).toBeLessThanOrEqual(3000);
  const before = first.historyCoverage!.rooms[0]!.before!;
  const second = f.service.turnSummary(A, { roomId: 'room', before });
  expect(second.historyCoverage?.state).toBe('complete');
  expect(second.sourceReferences).toHaveLength(5);
  expect(second.sourceReferences!.map((m) => m.messageId)).toContain('q0000');
});

it('reports byte-budget refusal without implicitly resolving the unseen owner source', async () => {
  const f = await fixture([owner('q')]);
  expect(f.db.noticeHistory('room', { rows: 1000, bytes: 1 })).toMatchObject({ messages: [], complete: false });
  expect(f.service.turnSummary(A).messages).toContainEqual(
    expect.objectContaining({ messageId: 'q', attention: { disposition: 'pending' } })
  );
});

it('checks current owner/membership/phone before exposing historical owner sources', async () => {
  const f = await fixture([owner('foreign')], 'bob');
  const query = vi.spyOn(ChatDb.prototype, 'noticeHistory');
  expect(f.service.turnSummary(A).total).toBe(0);
  expect(query).not.toHaveBeenCalled();
  expect(() => f.service.turnSummary(A, { roomId: 'room' })).toThrow('visible');
});

it('refuses a historical page for a no-longer-live caller instead of returning false empty coverage', async () => {
  const f = await fixture([owner('q')]);
  f.sessions.get(A)!.pid = null;
  expect(() => f.service.turnSummary(A, { roomId: 'room' })).toThrow('live own session');
  expect(f.service.turnSummary(A).total).toBe(0); // Existing ordinary-summary behavior preserved.
});

it('refuses a future database schema before creating any new notice index', async () => {
  const f = await fixture([owner('q')]);
  await f.service.stop();
  f.db.db.exec('DROP INDEX messages_owner_notice; DROP INDEX messages_notice_reply;');
  f.db.db.prepare("UPDATE meta SET value='2' WHERE key='schema_version'").run();
  expect(() => ChatDb.open(join(f.directory, 'chat.db'))).toThrow('has schema 2');
  expect(f.db.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('messages_owner_notice','messages_notice_reply')").all()).toEqual([]);
  expect(f.db.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()!.value).toBe('2');
});
