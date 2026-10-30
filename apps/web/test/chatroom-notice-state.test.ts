import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatroomNoticeState, noticeDigest, type NoticeRecord } from '../src/chatroom-notice-state.js';
import { ChatroomService } from '../src/chatroom-service.js';
import { ChatroomError, type ChatMessage, type ChatRoom } from '../src/chatroom-store.js';
import { createMockSession } from './mocks/index.js';

const A = '0000002d-0035-4000-8000-000000000047';
const B = '00000038-0043-4000-8000-000000000060';
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'notice-state-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

const row = (): NoticeRecord => ({
  recipient: { owner: 'alice', kind: 'employee', id: 'employee-a' },
  source: { roomId: 'room', messageId: 'message', digest: 'a'.repeat(64) },
  disposition: 'handled',
  recordedAt: 1000,
  proof: { kind: 'exact-read', receiptDigest: 'b'.repeat(64) },
});

describe('durable bounded own metadata', () => {
  it('commits atomically at0600, restarts and retries idempotently without copying message bodies/tokens', () => {
    const file = join(directory, 'state.json'),
      state = new ChatroomNoticeState(file);
    const check = vi.fn();
    const saved = state.commit(row(), check);
    expect(check).toHaveBeenCalledTimes(2);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const bytes = readFileSync(file, 'utf8');
    expect(new ChatroomNoticeState(file).commit({ ...row(), recordedAt: 2000 }, () => {})).toEqual(saved);
    expect(readFileSync(file, 'utf8')).toBe(bytes);
    const snapshot = state.forSource(row().recipient, 'room', 'message');
    snapshot[0]!.disposition = 'superseded';
    expect(state.forSource(row().recipient, 'room', 'message')[0]!.disposition).toBe('handled');
    expect(readdirSync(directory)).toEqual(['state.json']);
    expect(bytes).not.toContain('readToken');
    expect(new ChatroomNoticeState(file).forSource({ ...row().recipient, owner: 'bob' }, 'room', 'message')).toEqual(
      []
    );
  });
  it('revalidates before rename and retains the old committed bytes after drift', () => {
    const file = join(directory, 'state.json'),
      state = new ChatroomNoticeState(file);
    state.commit(row(), () => {});
    const before = readFileSync(file, 'utf8');
    let calls = 0;
    expect(() =>
      state.commit({ ...row(), source: { ...row().source, digest: 'c'.repeat(64) } }, () => {
        if (++calls === 2) throw new ChatroomError('Current binding changed', 'CONFLICT');
      })
    ).toThrow('Current binding changed');
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(readdirSync(directory)).toEqual(['state.json']);
    expect(state.forSource(row().recipient, 'room', 'message')).toHaveLength(1);
  });
  it.each(['{broken', '{"version":2,"records":[]}', '{"version":1,"records":[{}]}'])(
    'preserves corrupt/unknown schema and refuses writes: %s',
    (raw) => {
      const file = join(directory, 'state.json');
      writeFileSync(file, raw);
      const state = new ChatroomNoticeState(file);
      expect(state.available).toBe(false);
      expect(state.forSource(row().recipient, 'room', 'message')).toEqual([]);
      expect(() => state.commit(row(), () => {})).toThrow('unavailable');
      expect(readFileSync(file, 'utf8')).toBe(raw);
    }
  );
  it('refuses symlink metadata without reading or replacing its target', () => {
    const target = join(directory, 'target');
    writeFileSync(target, 'private fixture');
    const file = join(directory, 'state.json');
    symlinkSync(target, file);
    const state = new ChatroomNoticeState(file);
    expect(state.available).toBe(false);
    expect(() => state.commit(row(), () => {})).toThrow('unavailable');
    expect(readFileSync(target, 'utf8')).toBe('private fixture');
  });
  it('refuses a full history instead of evicting any identity', () => {
    const file = join(directory, 'state.json');
    const records = Array.from({ length: 10_000 }, (_, i) => ({
      ...row(),
      source: { ...row().source, messageId: 'm' + i },
    }));
    const raw = JSON.stringify({ version: 1, records });
    writeFileSync(file, raw);
    const state = new ChatroomNoticeState(file);
    expect(state.available).toBe(true);
    expect(() => state.commit(row(), () => {})).toThrow('full');
    expect(readFileSync(file, 'utf8')).toBe(raw);
    expect(state.forSource(row().recipient, 'room', 'm0')).toHaveLength(1);
    expect(state.forSource(row().recipient, 'room', 'm9999')).toHaveLength(1);
  });
  it('digest binds content/version but excludes transient transport and reactions', () => {
    const message = {
      id: 'id',
      roomId: 'room',
      at: 1,
      from: { kind: 'user', name: 'Owner' },
      to: 'all',
      text: 'original',
    } as ChatMessage;
    const digest = noticeDigest(message);
    expect(
      noticeDigest({
        ...message,
        phoneWakes: [A],
        pinned: { at: 2, by: 'Owner', kind: 'user' },
        reactions: {},
      } as ChatMessage)
    ).toBe(digest);
    expect(noticeDigest({ ...message, text: 'changed' })).not.toBe(digest);
    expect(noticeDigest({ ...message, edited: { at: 2 } })).not.toBe(digest);
    expect(noticeDigest({ ...message, from: { kind: 'user', name: 'Owner', mark: 'owner_typed' } })).not.toBe(digest);
    expect(noticeDigest({ ...message, deleted: { at: 2, by: 'owner' } })).not.toBe(digest);
  });
});

async function fixture() {
  let now = 1000000;
  const sessions = new Map([
    [A, createMockSession(A)],
    [B, createMockSession(B)],
  ]);
  sessions.get(A)!.name = 'Reviewer';
  sessions.get(B)!.name = 'Peer';
  const bindings = new Map([
    [A, 'employee-a'],
    [B, 'employee-b'],
  ]);
  const file = join(directory, 'rooms.json');
  const create = () =>
    new ChatroomService({
      file,
      getSession: (id) => sessions.get(id),
      employeeOf: (id) => bindings.get(id),
      deferDeliveryRecovery: true,
      now: () => now++,
      broadcast: () => {},
    });
  let service = create();
  await service.init();
  const room = service.createRoom('Office');
  service.addMember(room.id, A);
  service.addMember(room.id, B);
  const question = (text = '@Reviewer a pending request', target: ChatRoom = room) =>
    service.post(target.id, { kind: 'user', name: 'Owner', mark: 'owner_typed' }, text, 'all', { deliver: false });
  const handle = (message: ChatMessage, extra = {}) =>
    service.resolveNotice(A, {
      roomId: message.roomId,
      messageId: message.id,
      readToken: service.exactAgentRead(A, message.roomId, message.id).readToken,
      disposition: 'handled',
      ...extra,
    });
  return {
    get service() {
      return service;
    },
    sessions,
    bindings,
    room,
    question,
    handle,
    advance: (ms: number) => {
      now += ms;
    },
    restart: async () => {
      await service.stop();
      service = create();
      await service.init();
    },
  };
}

describe('current exact recipient/source attention boundary', () => {
  it('read/summary/unrelated posts never clear an owner request, including across restart', async () => {
    const f = await fixture();
    try {
      const question = f.question();
      f.service.acknowledgeAgentRead(A, f.room.id, [question]);
      f.service.post(f.room.id, { kind: 'agent', sessionId: A, name: 'Reviewer' }, 'unrelated later work', 'all', {
        deliver: false,
      });
      f.service.exactAgentRead(A, f.room.id, question.id);
      const before = f.service.turnSummary(A);
      expect(before.messages).toContainEqual(
        expect.objectContaining({ messageId: question.id, attention: { disposition: 'pending' }, transport: 'unknown' })
      );
      await f.restart();
      expect(f.service.turnSummary(A).messages).toContainEqual(
        expect.objectContaining({ messageId: question.id, state: 'reply-pending' })
      );
      f.handle(question);
      expect(f.service.turnSummary(A).messages).not.toContainEqual(expect.objectContaining({ messageId: question.id }));
      await f.restart();
      expect(f.service.turnSummary(A).total).toBe(0);
    } finally {
      await f.service.stop();
    }
  });
  it('handling preserves queued/uncertain transport and exact-read ACK remains separate', async () => {
    const f = await fixture();
    try {
      const question = f.question();
      f.service.delivery.holdForInspection(A, [{ roomId: f.room.id, messageId: question.id }]);
      const queued = vi
        .spyOn(f.service.delivery, 'queuedMessagesFor')
        .mockReturnValue([{ roomId: f.room.id, messageId: question.id }]);
      const ack = vi.spyOn(f.service.delivery, 'acknowledgeRead');
      const seen = f.service.lastSeen(A, f.room.id);
      const read = f.service.exactAgentRead(A, f.room.id, question.id);
      f.service.resolveNotice(A, {
        roomId: f.room.id,
        messageId: question.id,
        readToken: read.readToken,
        disposition: 'handled',
      });
      expect(ack).not.toHaveBeenCalled();
      expect(f.service.lastSeen(A, f.room.id)).toEqual(seen);
      expect(f.service.turnSummary(A).messages).toContainEqual(
        expect.objectContaining({
          messageId: question.id,
          attention: expect.objectContaining({ disposition: 'handled' }),
          state: 'delivery-unconfirmed',
          transport: 'delivery-unconfirmed',
        })
      );
      expect(f.service.delivery.inspectionFor(A)).toEqual([{ roomId: f.room.id, messageId: question.id }]);
      await f.service.acknowledgeExactAgentRead(A, f.room.id, question.id, read.readToken);
      expect(ack).toHaveBeenCalledExactlyOnceWith(A, f.room.id, [question.id]);
      queued.mockRestore();
    } finally {
      await f.service.stop();
    }
  });
  it('drops a handled notice that is only still queued for the pane, and counts what still needs attention', async () => {
    const f = await fixture();
    try {
      const handled = f.question('first owner request');
      const open = f.question('second owner request');
      vi.spyOn(f.service.delivery, 'queuedMessagesFor').mockReturnValue(
        [handled, open].map((m) => ({ roomId: f.room.id, messageId: m.id }))
      );
      const before = f.service.turnSummary(A);
      expect(before.messages.map((m) => m.messageId)).toEqual(expect.arrayContaining([handled.id, open.id]));
      expect(before.text).toContain(`: ${before.total} need your attention.`);
      const read = f.service.exactAgentRead(A, f.room.id, handled.id);
      f.service.resolveNotice(A, { roomId: f.room.id, messageId: handled.id, readToken: read.readToken, disposition: 'handled' });
      const after = f.service.turnSummary(A);
      expect(after.messages.map((m) => m.messageId)).not.toContain(handled.id); // queued, but handled: not news
      expect(after.messages.map((m) => m.messageId)).toContain(open.id);
      expect(after.total).toBe(before.total - 1);
      expect(after.text).toContain(`: ${after.total} need${after.total === 1 ? 's' : ''} your attention.`);
    } finally {
      await f.service.stop();
    }
  });
  it('counts a handled notice whose delivery is uncertain as listed but not as needing attention', async () => {
    const f = await fixture();
    try {
      const question = f.question();
      f.service.delivery.holdForInspection(A, [{ roomId: f.room.id, messageId: question.id }]);
      const read = f.service.exactAgentRead(A, f.room.id, question.id);
      f.service.resolveNotice(A, { roomId: f.room.id, messageId: question.id, readToken: read.readToken, disposition: 'handled' });
      const summary = f.service.turnSummary(A);
      expect(summary.messages.map((m) => m.messageId)).toContain(question.id);
      const open = summary.messages.filter((m) => m.attention?.disposition === 'pending').length;
      expect(summary.text).toContain(`: ${open} need${open === 1 ? 's' : ''} your attention.`);
    } finally {
      await f.service.stop();
    }
  });
  it.each(['edited', 'deleted'])('invalidates a %s linked reply below the read cursor', async (change) => {
    const f = await fixture();
    try {
      const q = f.question('peer notice');
      const response = f.service.post(
        f.room.id,
        { kind: 'agent', sessionId: A, name: 'Reviewer' },
        'exact answer',
        'all',
        { replyTo: q.id, deliver: false }
      );
      f.service.markSeen(A, f.room.id, response.id);
      expect(f.service.turnSummary(A).total).toBe(0);
      const raw = f.room.messages.find((m) => m.id === response.id)!;
      if (change === 'edited') raw.edited = { at: response.at + 1 };
      else raw.deleted = { at: response.at + 1, by: 'owner' };
      expect(f.service.turnSummary(A).messages).toContainEqual(
        expect.objectContaining({ messageId: q.id, attention: { disposition: 'pending' } })
      );
    } finally {
      await f.service.stop();
    }
  });
  it('source edit invalidates explicit proof even below a newer seen marker; unchanged retry is idempotent', async () => {
    const f = await fixture();
    try {
      const q = f.question();
      const first = f.handle(q);
      const again = f.handle(q);
      expect(again).toEqual(first);
      const newMessage = f.question('new source');
      f.service.markSeen(A, f.room.id, newMessage.id);
      expect(f.service.turnSummary(A).messages).not.toContainEqual(expect.objectContaining({ messageId: q.id }));
      const raw = f.room.messages.find((m) => m.id === q.id)!;
      raw.text = 'edited source';
      raw.edited = { at: newMessage.at + 1 };
      expect(f.service.turnSummary(A).messages).toContainEqual(
        expect.objectContaining({
          messageId: q.id,
          sourceDigest: noticeDigest(raw),
          attention: { disposition: 'pending' },
        })
      );
      f.handle(raw);
      expect(f.service.turnSummary(A).messages).not.toContainEqual(expect.objectContaining({ messageId: q.id }));
    } finally {
      await f.service.stop();
    }
  });
  it('supersession keeps source/history and replacement reference; replacement drift reopens source', async () => {
    const f = await fixture();
    try {
      const q = f.question(),
        replacement = f.question('@Reviewer changed dependency');
      const ref = {
        roomId: f.room.id,
        messageId: replacement.id,
        readToken: f.service.exactAgentRead(A, f.room.id, replacement.id).readToken,
      };
      const result = f.handle(q, { disposition: 'superseded', replacement: ref });
      expect(result.attention).toMatchObject({ disposition: 'superseded', replacement: { messageId: replacement.id } });
      expect(f.service.turnSummary(A).messages.map((m) => m.messageId)).toEqual([replacement.id]);
      f.room.messages.find((m) => m.id === replacement.id)!.text = 'a newer version';
      expect(f.service.turnSummary(A).messages).toContainEqual(
        expect.objectContaining({ messageId: q.id, attention: { disposition: 'pending' } })
      );
      expect(f.room.messages.some((m) => m.id === q.id)).toBe(true);
    } finally {
      await f.service.stop();
    }
  });
  it('foreign/wrong-thread replies and changed employee bindings cannot inherit handling', async () => {
    const f = await fixture();
    try {
      const q = f.question();
      f.service.post(f.room.id, { kind: 'agent', sessionId: B, name: 'Reviewer' }, 'foreign answer', 'all', {
        replyTo: q.id,
        deliver: false,
      });
      f.service.post(f.room.id, { kind: 'agent', sessionId: A, name: 'Reviewer' }, 'wrong thread', 'all', {
        replyTo: f.question('another thread').id,
        deliver: false,
      });
      expect(f.service.turnSummary(A).messages).toContainEqual(expect.objectContaining({ messageId: q.id }));
      f.handle(q);
      f.bindings.set(A, 'different-employee');
      expect(f.service.turnSummary(A).messages).toContainEqual(expect.objectContaining({ messageId: q.id }));
    } finally {
      await f.service.stop();
    }
  });
  it('rebound same-session identity cannot inherit a stamped old linked reply', async () => {
    const f = await fixture();
    try {
      const q = f.question();
      f.service.post(f.room.id, { kind: 'agent', sessionId: A, name: 'Reviewer' }, 'old identity answer', 'all', {
        replyTo: q.id,
        deliver: false,
      });
      expect(f.service.turnSummary(A).total).toBe(0);
      f.bindings.set(A, 'replacement-employee');
      expect(f.service.turnSummary(A).messages).toContainEqual(
        expect.objectContaining({ messageId: q.id, attention: { disposition: 'pending' } })
      );
    } finally {
      await f.service.stop();
    }
  });
  it.each(['expired', 'pid', 'employee', 'owner', 'source', 'membership', 'phone'])(
    'refuses changed exact-read %s binding before committing',
    async (change) => {
      const f = await fixture();
      try {
        const q = f.question(change === 'phone' ? 'ordinary owner notice' : undefined),
          read = f.service.exactAgentRead(A, f.room.id, q.id);
        if (change === 'expired') f.advance(60001);
        if (change === 'pid') f.sessions.get(A)!.pid = 43;
        if (change === 'employee') f.bindings.set(A, 'another');
        if (change === 'owner') f.sessions.get(A)!.owner = 'bob';
        if (change === 'source') f.room.messages.find((m) => m.id === q.id)!.text = 'changed';
        if (change === 'membership') f.room.members = f.room.members.filter((m) => m.sessionId !== A);
        if (change === 'phone') await f.service.setAlertMode(A, 'silent', 10000);
        expect(() =>
          f.service.resolveNotice(A, {
            roomId: f.room.id,
            messageId: q.id,
            readToken: read.readToken,
            disposition: 'handled',
          })
        ).toThrow();
        expect(() => readFileSync(join(directory, 'chat-notice-state.json'))).toThrow();
      } finally {
        await f.service.stop();
      }
    }
  );
  it('corrupt storage does not suppress current eligible notices or overwrite original evidence', async () => {
    const f = await fixture();
    try {
      const q = f.question('ordinary notice');
      f.service.markSeen(A, f.room.id, q.id);
      await f.service.stop();
      writeFileSync(join(directory, 'chat-notice-state.json'), '{broken');
      await f.restart();
      expect(f.service.turnSummary(A).messages).toContainEqual(
        expect.objectContaining({ messageId: q.id, attention: { disposition: 'pending' } })
      );
      expect(() => f.handle(q)).toThrow('unavailable');
      expect(readFileSync(join(directory, 'chat-notice-state.json'), 'utf8')).toBe('{broken');
    } finally {
      await f.service.stop();
    }
  });
});

describe('bulk handle-before selection (agent and bot senders only)', () => {
  it('lists only pending agent/bot notices before the cutoff, never the owner, and drops them once handled', async () => {
    const f = await fixture();
    try {
      const svc = f.service;
      const peer = { kind: 'agent', sessionId: B, name: 'Peer' } as const;
      const done = svc.post(f.room.id, peer, 'already handled', 'all', { deliver: false });
      const open = svc.post(f.room.id, peer, 'still pending', 'all', { deliver: false });
      const bot = svc.post(f.room.id, { kind: 'bot', botId: 'fixture-bot', name: 'Fixture Bot' }, 'bot note', 'all', { deliver: false });
      const owner = f.question('@Reviewer an owner request');
      f.handle(done);
      f.advance(10);
      const cutoff = Date.now() + 10 ** 12; // after everything above in the fixture clock
      const select = (before: number) =>
        (svc.turnSummary(A, undefined, { roomId: f.room.id, before }).sourceReferences ?? []).map((r) => r.messageId);
      const later = svc.post(f.room.id, peer, 'after the cutoff', 'all', { deliver: false });
      expect(select(later.at)).toEqual(expect.arrayContaining([open.id, bot.id]));
      expect(select(later.at)).not.toContain(done.id); // handled already
      expect(select(later.at)).not.toContain(owner.id); // never the owner
      expect(select(later.at)).not.toContain(later.id); // not before the cutoff
      expect(select(cutoff)).toContain(later.id);
      for (const id of select(later.at)) f.handle(svc.store.require(f.room.id).messages.find((m) => m.id === id)!);
      expect(select(later.at)).toEqual([]);
      // The owner's request still needs attention.
      expect(svc.turnSummary(A).messages.map((m) => m.messageId)).toContain(owner.id);
      expect(() => svc.turnSummary(A, undefined, { roomId: 'no-such-room', before: cutoff })).toThrow();
    } finally {
      await f.service.stop();
    }
  });
});
