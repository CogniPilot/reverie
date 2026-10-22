import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatroomService } from '../src/chatroom-service.js';
import { PendingDeliveryStore } from '../src/chatroom-pending-delivery.js';
import { agentChatRead, type AgentDeps, type RequestOptions } from '../src/cli-agent.js';

const A = '0000002d-0035-4000-8000-000000000047';
const B = '00000038-0043-4000-8000-000000000060';
describe('exact reads beyond the recent-message window', () => {
  let service: ChatroomService;
  let now: number;
  let owner: string | undefined;
  let directory: string;
  let worker: { pid: number };
  let employee: string;
  beforeEach(async () => {
    now = 1000000;
    owner = undefined;
    directory = mkdtempSync(join(tmpdir(), 'exact-read-'));
    employee = 'employee-a';
    const sessions = new Map([A, B].map((id) => [id, { id, name: id, pid: 42, mode: 'opencode', status: 'idle', get owner() { return owner; }, isWorking: true, writeViaMux: async () => true }]));
    worker = sessions.get(A)!;
    service = new ChatroomService({ file: join(directory, 'rooms.json'), database: join(directory, 'chat.db'), now: () => now,
      getSession: (id) => sessions.get(id), employeeOf: () => employee, broadcast: () => {} });
    await service.init();
    service.delivery.stop();
  });
  afterEach(async () => { await service.stop(); });
  const held = () => {
    const room = service.createRoom('Shared', undefined);
    service.addMember(room.id, A);
    service.addMember(room.id, B);
    const message = service.post(room.id, { kind: 'user', name: 'owner' }, 'original held item', 'all', { deliver: false });
    service.delivery.holdForInspection(A, [{ roomId: room.id, messageId: message.id }]);
    return { room, message };
  };
  it('reads the archived exact item and releases only after explicit exact acknowledgement', async () => {
    const { room, message } = held();
    const pending = PendingDeliveryStore.openRecoverable(join(directory, 'chat-pending-delivery.db')).store;
    pending.add({ id: 'held', roomId: room.id, messageId: message.id, sessionId: A, at: message.at, state: 'uncertain', passive: false });
    for (let i = 0; i < 1001; i++) service.post(room.id, { kind: 'agent', sessionId: B, name: 'B' }, `later ${i}`, 'all', { deliver: false });
    expect(service.view(room, { limit: 2000 }).messages.some((m) => m.id === message.id)).toBe(false);
    const read = service.exactAgentRead(A, room.id, message.id);
    expect(read.message.text).toBe('original held item');
    expect(service.deliveryStatus(A).blocked).toBe(true);
    await expect(service.acknowledgeExactAgentRead(B, room.id, message.id, read.readToken)).rejects.toThrow();
    await expect(service.acknowledgeExactAgentRead(A, 'wrong-room', message.id, read.readToken)).rejects.toThrow();
    expect(pending.list().some((p) => p.id === 'held')).toBe(true);
    await service.acknowledgeExactAgentRead(A, room.id, message.id, read.readToken);
    expect(service.deliveryStatus(A).blocked).toBe(false);
    expect(pending.list().some((p) => p.id === 'held')).toBe(false);
    expect(service.exactAgentRead(A, room.id, message.id).message.text).toBe('original held item');
    await expect(service.acknowledgeExactAgentRead(A, room.id, message.id, read.readToken)).rejects.toThrow();
    pending.close();
  });
  it('refuses expired receipts without releasing the hold', async () => {
    const { room, message } = held();
    const read = service.exactAgentRead(A, room.id, message.id);
    now += 60001;
    await expect(service.acknowledgeExactAgentRead(A, room.id, message.id, read.readToken)).rejects.toThrow();
    expect(service.deliveryStatus(A).blocked).toBe(true);
  });
  it('refuses edits and current ownership changes without releasing the hold', async () => {
    const { room, message } = held();
    const read = service.exactAgentRead(A, room.id, message.id);
    await service.editMessage(room.id, message.id, 'edited content', 'owner');
    await expect(service.acknowledgeExactAgentRead(A, room.id, message.id, read.readToken)).rejects.toThrow();
    const fresh = service.exactAgentRead(A, room.id, message.id);
    owner = 'other-owner';
    await expect(service.acknowledgeExactAgentRead(A, room.id, message.id, fresh.readToken)).rejects.toThrow();
    expect(service.deliveryStatus(A).blocked).toBe(true);
  });
  it('refuses worker replacement and employee rebinding without releasing the hold', async () => {
    const { room, message } = held();
    const read = service.exactAgentRead(A, room.id, message.id);
    worker.pid = 43;
    await expect(service.acknowledgeExactAgentRead(A, room.id, message.id, read.readToken)).rejects.toThrow('binding changed');
    const fresh = service.exactAgentRead(A, room.id, message.id);
    employee = 'employee-b';
    await expect(service.acknowledgeExactAgentRead(A, room.id, message.id, fresh.readToken)).rejects.toThrow('binding changed');
    expect(service.deliveryStatus(A).blocked).toBe(true);
  });
  it('does not grant nonmembers exact-message access or leak inaccessible hold locations', () => {
    const { room, message } = held();
    const other = service.createRoom('Private', undefined);
    const secret = service.post(other.id, { kind: 'agent', sessionId: B, name: 'B' }, 'private', 'all', { deliver: false });
    expect(() => service.exactAgentRead(A, other.id, secret.id)).toThrow();
    expect(() => service.exactAgentRead(A, room.id, secret.id)).toThrow();
    service.delivery.holdForInspection(A, [{ roomId: other.id, messageId: secret.id }]);
    expect(service.deliveryStatus(A).held).toEqual([{ roomId: room.id, messageId: message.id }]);
  });
});

it('CLI exact read acknowledges only after an exact response and only with explicit intent', async () => {
  const calls: RequestOptions[] = [];
  const outputs: string[] = [];
  let bad = false;
  const deps: AgentDeps = { ctx: { apiUrl: 'http://example.test', selfId: A }, json: true,
    io: { out: (s) => outputs.push(s), err: () => {}, exit: () => {} },
    request: async (_ctx, request) => {
      calls.push(request);
      const data = request.path === '/api/v1/chatrooms' ? { rooms: [{ id: 'room', name: 'Room', members: [] }] }
        : request.method === 'POST' ? { acknowledged: 'message' }
        : { message: { id: bad ? 'wrong' : 'message', at: 1, from: { kind: 'user', name: 'user' }, text: 'read me', to: 'all' }, readToken: 'token' };
      return { status: 200, text: '', json: { success: true, data } };
    } };
  expect(await agentChatRead(deps, { room: 'Room', limit: 1, message: 'message' })).toBe(0);
  expect(calls.some((c) => c.method === 'POST')).toBe(false);
  calls.length = 0;
  expect(await agentChatRead(deps, { room: 'Room', limit: 1, message: 'message', acknowledge: true })).toBe(0);
  expect(calls.at(-1)?.body).toEqual({ readToken: 'token' });
  calls.length = 0;
  bad = true;
  expect(await agentChatRead(deps, { room: 'Room', limit: 1, message: 'message', acknowledge: true })).not.toBe(0);
  expect(calls.some((c) => c.method === 'POST')).toBe(false);
});
