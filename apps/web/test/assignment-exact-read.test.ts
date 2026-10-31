import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoardStore } from '../src/board-store.js';
import { AssignmentStatusWatch, type AssignmentEmployee } from '../src/assignment-status-watch.js';
import { ChatroomService } from '../src/chatroom-service.js';
import { ChatFileStore } from '../src/chatroom-files.js';
import { renderForRecipient, answerLinkHint } from '../src/chatroom-delivery.js';
import { agentChatRead, type AgentDeps } from '../src/cli-agent.js';
import { registerChatroomRoutes } from '../src/web/routes/chatroom-routes.js';
import { createRouteTestHarness } from './routes/_route-test-utils.js';
import { createMockSession } from './mocks/index.js';
import { trustedFixtureOwner } from './helpers/trusted-owner-fixture.js';

const A = '0000002d-0035-4000-8000-000000000047';
const B = '00000038-0043-4000-8000-000000000060';
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.reverse()) await close(); cleanups.length = 0; });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'assignment-exact-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const sessions = new Map([A, B].map(id => [id, createMockSession(id)]));
  const employees: AssignmentEmployee[] = [
    { id: 'worker', name: 'Worker', sessionId: A, sessionGeneration: 1, desiredRunning: true, onVacation: false, reportsTo: 'manager' },
    { id: 'manager', name: 'Manager', sessionId: B, sessionGeneration: 1, desiredRunning: true, onVacation: false },
  ];
  const at = Date.now();
  const create = async () => {
    const service = new ChatroomService({ file: join(root, 'rooms.json'), database: join(root, 'chat.db'), now: () => at,
      getSession: id => sessions.get(id), employeeOf: id => employees.find(e => e.sessionId === id)?.id, broadcast: () => {} });
    await service.init(); service.delivery.stop(); cleanups.push(() => service.stop()); return service;
  };
  const service = await create();
  const room = service.createRoom('Room', undefined);
  service.addMember(room.id, A); service.addMember(room.id, B);
  const bot = { id: 'status', name: 'Status', rooms: [room.id], maxPerHour: 30 };
  const board = new BoardStore(join(root, 'board.json')); await board.init();
  await board.update({}, state => state.issues.push({ id: 'task', title: 'Fixture assignment', owner: 'worker', status: 'doing',
    tags: [], links: [], createdAt: at, updatedAt: at, end: at + 3600000, scale: 'hour' }));
  const watch = new AssignmentStatusWatch(join(root, 'watch.json'), { board, employees: () => employees,
    running: () => true, bot: () => bot, room: id => service.room(id), canDeliver: () => true, canEdit: () => true,
    // Real durable producer; worker delivery is suppressed in this owned fixture.
    post: (current, id, text, recipients, recent) => service.postDurableBotMessage(current, id, text, recent, recipients, false),
    delivered: () => false, audit: async () => {}, now: () => at });
  await watch.init(); await watch.configure({ version: 1, type: 'assignment-status', enabled: true, botId: bot.id,
    roomIds: [room.id], intervalMinutes: 60, responseMinutes: 5 }); await watch.tick();
  const entry = watch.status().entries[0]!;
  const message = service.room(room.id)!.messages.find(m => m.id === entry.promptId)!;
  expect(message).toBeDefined(); expect(message.id).not.toBe(entry.id);
  expect(message.text).toContain(`[assignment-checkin:${entry.id}]`);
  return { root, sessions, create, service, room, entry, message };
}

it('gives the actual assignment prompt id for a direct reply without confusing the ledger marker', async () => {
  const { room, message, entry } = await fixture();
  const line = renderForRecipient(room, message, A, () => 'Worker');
  expect(line).toContain(`[assignment-checkin:${entry.id}]`);
  expect(line).toContain(answerLinkHint(message.id));
  expect(line.split(answerLinkHint(message.id))).toHaveLength(2);
  expect(line).not.toContain(answerLinkHint(entry.id));
  room.members.find(member => member.sessionId === A)!.voice = true;
  expect(renderForRecipient(room, message, A, () => 'Worker').split(answerLinkHint(message.id))).toHaveLength(2);
});

it('reads real durable check-in message ids through the actual route/CLI, while refusing ledger ids and prefixes', async () => {
  const f = await fixture();
  const { app } = await createRouteTestHarness((fastify, ctx) => {
    for (const [id, session] of f.sessions) ctx.sessions.set(id, session);
    registerChatroomRoutes(fastify, ctx, f.service, new ChatFileStore(f.root), trustedFixtureOwner);
  });
  cleanups.push(() => app.close());
  const url = `/api/chatrooms/${f.room.id}/messages/`;
  const headers = { 'x-reverie-parent-session': A };
  expect((await app.inject({ method: 'GET', url: url + f.message.id, headers })).statusCode).toBe(200);
  for (const id of [f.entry.id, f.message.id.slice(0, 8)]) {
    const response = await app.inject({ method: 'GET', url: url + id, headers });
    expect(response.statusCode).toBe(404); expect(response.json().errorCode).toBe('NOT_FOUND');
  }
  const outputs: string[] = [];
  const deps: AgentDeps = { ctx: { apiUrl: 'http://fixture.invalid', selfId: A }, json: true,
    io: { out: text => outputs.push(text), err: () => {}, exit: () => {} },
    request: async (_ctx, request) => {
      expect(request.method).toBe('GET');
      const response = await app.inject({ method: 'GET', url: request.path.replace('/api/v1/', '/api/'), headers });
      return { status: response.statusCode, text: response.body, json: response.json() };
    } };
  expect(await agentChatRead(deps, { room: f.room.id, limit: 1, message: f.message.id })).toBe(0);
  expect(JSON.parse(outputs[0]!).message.id).toBe(f.message.id);
  const other = f.service.createRoom('Other', undefined); f.service.addMember(other.id, A);
  expect((await app.inject({ method: 'GET', url: `/api/chatrooms/${other.id}/messages/${f.message.id}`, headers })).statusCode).toBe(404);
  f.service.removeMember(f.room.id, A);
  expect((await app.inject({ method: 'GET', url: url + f.message.id, headers })).statusCode).toBe(404);
});

it('finds the same typed check-in after archival and service reopen', async () => {
  const f = await fixture();
  for (let i = 0; i < 1001; i++) f.service.post(f.room.id, { kind: 'user', name: 'Fixture user' }, `later ${i}`, 'all', { deliver: false });
  expect(f.service.room(f.room.id)!.messages.some(m => m.id === f.message.id)).toBe(false);
  expect(f.service.exactAgentRead(A, f.room.id, f.message.id).message.id).toBe(f.message.id);
  await f.service.stop();
  const reopened = await f.create();
  expect(reopened.exactAgentRead(A, f.room.id, f.message.id).message.text).toBe(f.message.text);
  expect(() => reopened.exactAgentRead(A, f.room.id, f.entry.id)).toThrow('No such message');
  f.sessions.get(A)!.pid = null;
  expect(() => reopened.exactAgentRead(A, f.room.id, f.message.id)).toThrow('No visible room');
});

it('keeps ordinary bots, acknowledgements, lookalikes and other recipients unchanged', async () => {
  const { room, message, entry } = await fixture();
  const cases = [
    { ...message, text: 'Ordinary scheduled notice' },
    { ...message, text: `[assignment-checkin:${entry.id}] Worker: recorded On track.` },
    { ...message, text: message.text.replace(entry.id, 'not-a-checkin-id') },
    { ...message, to: 'all' as const },
    { ...message, to: [B] },
    { ...message, from: { kind: 'agent' as const, sessionId: B, name: 'Manager' } },
  ];
  for (const candidate of cases) expect(renderForRecipient(room, candidate, A, () => 'Worker')).not.toContain(answerLinkHint(message.id));
});
