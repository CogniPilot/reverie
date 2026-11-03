/**
 * A member's reply to a message proves that message reached it. A reply to a held (unconfirmed) message releases that
 * hold, so the "earlier messages may not have reached you" pointer stops repeating and new lines are no longer kept
 * waiting on it. Only the replying member's own hold on that exact message is released.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatroomService } from '../src/chatroom-service.js';

const A = '0000002d-0035-4000-8000-000000000047';
const B = '00000038-0043-4000-8000-000000000060';
describe('a reply releases the hold on the message it answers', () => {
  let service: ChatroomService;
  beforeEach(async () => {
    const directory = mkdtempSync(join(tmpdir(), 'reply-hold-'));
    const sessions = new Map([A, B].map((id) => [id, { id, name: id, pid: 42, mode: 'opencode', status: 'idle', isWorking: true, writeViaMux: async () => true }]));
    service = new ChatroomService({ file: join(directory, 'rooms.json'), database: join(directory, 'chat.db'), now: () => 1_000_000,
      getSession: (id) => sessions.get(id), employeeOf: (id) => 'employee-' + id, broadcast: () => {} });
    await service.init();
    service.delivery.stop();
  });
  afterEach(async () => { await service.stop(); });
  const setup = () => {
    const room = service.createRoom('Shared', undefined);
    service.addMember(room.id, A);
    service.addMember(room.id, B);
    const asked = service.post(room.id, { kind: 'user', name: 'owner' }, 'please check the build', 'all', { deliver: false });
    const other = service.post(room.id, { kind: 'user', name: 'owner' }, 'and the docs', 'all', { deliver: false });
    service.delivery.holdForInspection(A, [{ roomId: room.id, messageId: asked.id }, { roomId: room.id, messageId: other.id }]);
    service.delivery.holdForInspection(B, [{ roomId: room.id, messageId: asked.id }]);
    return { room, asked, other };
  };
  const held = (id: string) => service.delivery.inspectionFor(id).map((m) => m.messageId).sort();

  it('releases only the replier\'s hold on the answered message', () => {
    const { room, asked, other } = setup();
    service.post(room.id, { kind: 'agent', sessionId: A, name: 'A' }, 'build is green', 'all', { deliver: false, replyTo: asked.id });
    expect(held(A)).toEqual([other.id]);
    expect(held(B)).toEqual([asked.id]);
    expect(service.deliveryStatus(A).blocked).toBe(true);
  });

  it("another member's reply releases only that member's hold", () => {
    const { room, asked, other } = setup();
    service.post(room.id, { kind: 'agent', sessionId: B, name: 'B' }, 'looking', 'all', { deliver: false, replyTo: asked.id });
    expect(held(B)).toEqual([]);
    expect(held(A)).toEqual([asked.id, other.id].sort());
  });

  it('a post that replies to nothing, or that a user makes, releases nothing', () => {
    const { room, asked, other } = setup();
    service.post(room.id, { kind: 'agent', sessionId: A, name: 'A' }, 'build is green', 'all', { deliver: false });
    service.post(room.id, { kind: 'user', name: 'owner' }, 'thanks', 'all', { deliver: false, replyTo: asked.id });
    expect(held(A)).toEqual([asked.id, other.id].sort());
  });

  it('unblocks the session once every held message is answered', () => {
    const { room, asked, other } = setup();
    for (const id of [asked.id, other.id])
      service.post(room.id, { kind: 'agent', sessionId: A, name: 'A' }, 'done', 'all', { deliver: false, replyTo: id });
    expect(held(A)).toEqual([]);
    expect(service.deliveryStatus(A).blocked).toBe(false);
  });
});
