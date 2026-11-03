import { afterEach, expect, it, vi } from 'vitest';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChatroomService } from '../../src/chatroom-service.js';
import { ChatFileStore } from '../../src/chatroom-files.js';
import { registerChatroomRoutes } from '../../src/web/routes/chatroom-routes.js';
import { trustedFixtureOwner } from '../helpers/trusted-owner-fixture.js';
import { createRouteTestHarness } from './_route-test-utils.js';
import { createMockSession, type MockRouteContext } from '../mocks/index.js';
import { registerChatAttention } from '../../src/web/routes/chat-attention.js';
import type { ChatMessage, ChatRoom } from '../../src/chatroom-store.js';

const A = '0000002d-0035-4000-8000-000000000047';
const B = '00000038-0043-4000-8000-000000000060';
const headers = { 'x-reverie-parent-session': A };
afterEach(() => vi.unstubAllEnvs());
async function fixture(waitMs = 1000, activation: string | null = 'enabled') {
  vi.stubEnv('REVERIE_ADMIN_PHONE_WAKE', activation ?? undefined);
  const directory = await mkdtemp(join(tmpdir(), 'phone-attention-'));
  const listeners = new Set<(room: ChatRoom, message: ChatMessage) => void>();
  const broadcasts: unknown[] = [];
  let context: MockRouteContext | undefined;
  const service = new ChatroomService({ file: join(directory, 'rooms.json'),
    employeeOf: id => 'employee-' + id, getSession: id => context?.sessions.get(id), broadcast: (event, data) => broadcasts.push({ event, data }) });
  const subscribe = service.onMessage.bind(service);
  vi.spyOn(service, 'onMessage').mockImplementation(listener => {
    listeners.add(listener); const unsubscribe = subscribe(listener);
    return () => { listeners.delete(listener); unsubscribe(); };
  });
  const { app, ctx } = await createRouteTestHarness((f, c) => {
    context = c;
    c.sessions.set(A, createMockSession(A)); c.sessions.set(B, createMockSession(B));
    c.sessions.get(A).name = 'Jester'; c.sessions.get(A).mode = 'hands'; c.sessions.get(B).name = 'Peer';
    registerChatAttention(f, c, service as never, waitMs);
    f.addHook('onClose', async () => { await service.stop(); await rm(directory, { recursive: true, force: true }); });
  });
  await service.init();
  const room = service.createRoom('Office', undefined);
  service.addMember(room.id, A); service.addMember(room.id, B);
  let counter = 0;
  const emit = (target: ChatRoom, extra: Partial<ChatMessage> = {}) => {
    const message = { id: 'message-' + ++counter, roomId: target.id, at: counter, to: 'all', text: '@Jester private text',
      phoneWakes: target.members.map(member => member.sessionId),
      from: { kind: 'agent', sessionId: B, name: 'Peer' }, ...extra } as ChatMessage;
    target.messages.push(message);
    for (const listener of [...listeners]) listener(target, message);
    return message;
  };
  const wait = async () => {
    const pending = app.inject({ url: '/api/chatrooms/attention', headers }).then(response => response);
    await vi.waitFor(() => expect(listeners.size).toBe(1), { interval: 1 });
    return { pending };
  };
  return { app, ctx, service, directory, listeners, room, emit, wait, broadcasts };
}

it.each([null, '', 'true', 'disabled', 'ENABLED'])('defaults phone wake OFF without exact startup opt-in (%s)', async activation => {
  const f = await fixture(50, activation);
  try {
    expect(f.service.adminPhoneWakeEnabled).toBe(false);
    // Changing the environment after startup must not change the instance configuration.
    vi.stubEnv('REVERIE_ADMIN_PHONE_WAKE', 'enabled');
    const delivery = vi.spyOn(f.service.delivery, 'deliverMessage');
    const message = f.service.post(f.room.id, { kind: 'user', name: 'Owner', mark: 'owner_typed' }, '@Jester question');
    expect(f.service.room(f.room.id)!.messages.find(item => item.id === message.id)).not.toHaveProperty('phoneWakes');
    expect(delivery).toHaveBeenCalledOnce();
    expect(delivery.mock.calls[0][2]).toEqual([B]); // Hands stays post-only; existing native pane delivery is unchanged.
    expect(f.service.phoneAccepts(A, f.room.id, message.id)).toBe(false);
    expect((await f.app.inject({ url: '/api/chatrooms/attention', headers })).statusCode).toBe(503);
    expect(f.listeners.size).toBe(0);
  } finally { await f.app.close(); }
});

it('configuration-OFF preserves stored receipts while stripping public reads, mutations and broadcasts', async () => {
  const f = await fixture(50, null);
  try {
    const message = f.emit(f.room, { from: { kind: 'user', name: 'Owner', mark: 'owner_typed' }, text: 'historical owner question' });
    const receipts = [...message.phoneWakes!];
    expect(receipts).toContain(A);
    expect(f.service.phoneAccepts(A, f.room.id, message.id)).toBe(false);
    expect(f.service.view(f.room).messages.find(item => item.id === message.id)).toMatchObject({ text: message.text });
    expect(f.service.view(f.room).messages.find(item => item.id === message.id)).not.toHaveProperty('phoneWakes');
    expect(f.service.exactAgentRead(A, f.room.id, message.id).message).not.toHaveProperty('phoneWakes');
    expect(await f.service.editMessage(f.room.id, message.id, 'edited historical question', 'Owner', { ownerVerified: true })).not.toHaveProperty('phoneWakes');
    expect(await f.service.pinMessage(f.room.id, message.id, { kind: 'user', name: 'Owner' }, true)).not.toHaveProperty('phoneWakes');
    expect(f.service.pinned(f.room.id).find(item => item.id === message.id)).not.toHaveProperty('phoneWakes');
    f.service.post(f.room.id, { kind: 'user', name: 'Owner', mark: 'owner_typed' }, 'new question');
    expect(JSON.stringify(f.broadcasts)).not.toContain('phoneWakes');
    expect(message.phoneWakes).toEqual(receipts);
    await f.service.stop();
    const reloaded = new ChatroomService({ file: join(f.directory, 'rooms.json'), getSession: id => f.ctx.sessions.get(id), broadcast: () => {} });
    await reloaded.init();
    try {
      expect(reloaded.adminPhoneWakeEnabled).toBe(false);
      expect(reloaded.room(f.room.id)!.messages.find(item => item.id === message.id)?.phoneWakes).toEqual(receipts);
      expect(reloaded.phoneAccepts(A, f.room.id, message.id)).toBe(false);
      expect(reloaded.view(reloaded.room(f.room.id)!).messages.find(item => item.id === message.id)).not.toHaveProperty('phoneWakes');
    } finally { await reloaded.stop(); }
  } finally { await f.app.close(); }
});

it.each(['mention', 'address', 'reply', 'everyone', 'dm'])('wakes only the caller on a new %s with IDs only', async (kind) => {
  const f = await fixture();
  try {
    const own = f.emit(f.room, { from: { kind: 'agent', sessionId: A, name: 'Jester' }, text: 'earlier' });
    if (kind === 'dm') { f.room.kind = 'dm'; f.room.dm = ['user', A]; }
    const { pending } = await f.wait();
    const message = f.emit(f.room, kind === 'mention' ? {} : kind === 'address' ? { text: 'question', to: [A] } :
      kind === 'reply' ? { text: 'followup', replyTo: own.id } : kind === 'everyone' ? { text: '@everyone question' } : { text: 'private DM' });
    const response = await pending;
    expect(response.json()).toEqual({ success: true, data: { event: { roomId: f.room.id, messageId: message.id } } });
    expect(response.body).not.toContain(message.text);
    expect(f.listeners.size).toBe(0);
  } finally { await f.app.close(); }
});

it('uses Vibrate to filter general chatter, and ignores self/system/deleted posts and visibility failures', async () => {
  const f = await fixture();
  try {
    await f.service.setAlertMode(A, 'vibrate', 3600_000);
    const { pending } = await f.wait();
    f.emit(f.room, { text: 'general discussion' });
    f.emit(f.room, { from: { kind: 'user', name: 'Owner' }, text: 'general owner post' });
    f.emit(f.room, { text: 'email@Jester or @Jester-other' });
    f.emit(f.room, { from: { kind: 'agent', sessionId: A, name: 'Jester' } });
    f.emit(f.room, { from: { kind: 'system', name: 'system' } });
    f.emit(f.room, { deleted: { at: 1, by: 'owner' } });
    f.room.members = f.room.members.filter(member => member.sessionId !== A);
    f.emit(f.room);
    f.room.members.push({ sessionId: A, role: 'agent', joinedAt: 1, updatedAt: 1 });
    f.room.owner = 'another-owner'; f.emit(f.room); delete f.room.owner;
    f.room.archivedAt = 1; f.emit(f.room); delete f.room.archivedAt;
    f.room.kind = 'dm'; f.room.dm = ['user', B]; f.emit(f.room); delete f.room.kind; delete f.room.dm;
    expect(f.listeners.size).toBe(1);
    const message = f.emit(f.room);
    expect((await pending).json().data.event.messageId).toBe(message.id);
  } finally { await f.app.close(); }
});

it('rejects target parameters, owner/service/prefix callers, and a second connection for the same agent', async () => {
  const f = await fixture();
  try {
    for (const callerHeaders of [{}, { 'x-reverie-service-token': 'fixture', ...headers }, { 'x-reverie-parent-session': A.slice(0, 8) }]) {
      expect((await f.app.inject({ url: '/api/chatrooms/attention', headers: callerHeaders })).statusCode).toBe(403);
    }
    expect((await f.app.inject({ url: '/api/chatrooms/attention?target=' + B, headers })).statusCode).toBe(400);
    const { pending } = await f.wait();
    expect((await f.app.inject({ url: '/api/chatrooms/attention', headers })).statusCode).toBe(409);
    f.emit(f.room);
    expect((await pending).statusCode).toBe(200);
    expect(f.listeners.size).toBe(0);
  } finally { await f.app.close(); }
});

it('bounds idle waits and releases its listener on server close', async () => {
  const f = await fixture(30);
  const idle = await f.app.inject({ url: '/api/chatrooms/attention', headers });
  expect(idle.json().data.event).toBeNull();
  expect(f.listeners.size).toBe(0);
  const { pending } = await f.wait();
  await f.app.close();
  expect((await pending).json().data.event).toBeNull();
  expect(f.listeners.size).toBe(0);
});

it('releases the subscription when the phone disconnects', async () => {
  const f = await fixture();
  try {
    const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
    const request = http.get(address + '/api/chatrooms/attention', { headers });
    request.on('error', () => {});
    await vi.waitFor(() => expect(f.listeners.size).toBe(1));
    request.destroy();
    await vi.waitFor(() => expect(f.listeners.size).toBe(0));
  } finally { await f.app.close(); }
});

it.each([
  ['ring', 'peer', 'general conversation', true],
  ['vibrate', 'peer', 'general conversation', false],
  ['vibrate', 'peer', '@Jester please respond', true],
  ['vibrate', 'owner', 'owner question', true],
  ['silent', 'peer', '@Jester please respond', false],
  ['silent', 'owner', 'owner question', false],
  ['silent', 'owner', '@Jester please respond', true],
  ['silent', 'owner', '@everyone please respond', true],
] as const)('event wake follows %s phone policy for %s: %s', async (mode, sender, text, accepted) => {
  const f = await fixture(50);
  try {
    await f.service.setAlertMode(A, mode, 3600_000);
    const { pending } = await f.wait();
    const message = f.service.post(f.room.id, sender === 'owner' ? { kind: 'user', name: 'Owner', mark: 'owner_typed' } :
      { kind: 'agent', sessionId: B, name: 'Peer' }, text);
    expect(f.service.phoneAccepts(A, f.room.id, message.id)).toBe(accepted);
    expect((await pending).json().data.event).toEqual(accepted ? { roomId: f.room.id, messageId: message.id } : null);
    expect(message).not.toHaveProperty('phoneWakes');
    expect(f.service.view(f.room).messages.find(item => item.id === message.id)).not.toHaveProperty('phoneWakes');
  } finally { await f.app.close(); }
});

it('uses changed phone policy while a request is pending and never resurrects discarded traffic after unmute/reload', async () => {
  const f = await fixture();
  try {
    const { pending } = await f.wait();
    await f.service.setAlertMode(A, 'silent', 3600_000);
    const muted = f.service.post(f.room.id, { kind: 'agent', sessionId: B, name: 'Peer' }, '@Jester muted');
    expect(f.listeners.size).toBe(1);
    await f.service.setAlertMode(A, 'ring', 3600_000);
    expect(f.service.phoneAccepts(A, f.room.id, muted.id)).toBe(false);
    const fresh = f.service.post(f.room.id, { kind: 'agent', sessionId: B, name: 'Peer' }, 'ordinary Ring traffic');
    expect((await pending).json().data.event.messageId).toBe(fresh.id);
    await f.service.stop();
    const reloaded = new ChatroomService({ file: join(f.directory, 'rooms.json'), employeeOf: id => 'employee-' + id,
      getSession: id => f.ctx.sessions.get(id), broadcast: () => {} });
    await reloaded.init();
    try { expect(reloaded.phoneAccepts(A, f.room.id, muted.id)).toBe(false); }
    finally { await reloaded.stop(); }
  } finally { await f.app.close(); }
});

it('respects post-only/notify membership changes instead of treating a mention as an independent grant', async () => {
  const f = await fixture();
  try {
    const { pending } = await f.wait();
    const member = f.room.members.find(item => item.sessionId === A)!;
    f.ctx.sessions.get(A)!.mode = 'codex'; // Explicit typed post-only is distinct from polling transport's post-only flag.
    member.postOnly = true;
    const blocked = f.service.post(f.room.id, { kind: 'user', name: 'Owner', mark: 'owner_typed' }, '@Jester blocked');
    expect(f.listeners.size).toBe(1);
    delete member.postOnly;
    expect(f.service.phoneAccepts(A, f.room.id, blocked.id)).toBe(false);
    member.notify = 'mentions';
    f.service.post(f.room.id, { kind: 'agent', sessionId: B, name: 'Peer' }, 'not addressed');
    expect(f.listeners.size).toBe(1);
    const fresh = f.service.post(f.room.id, { kind: 'agent', sessionId: B, name: 'Peer' }, '@Jester addressed');
    expect((await pending).json().data.event.messageId).toBe(fresh.id);
  } finally { await f.app.close(); }
});

it.each(['ring', 'vibrate', 'silent'] as const)('own DM respects %s instead of bypassing the phone setting', async mode => {
  const f = await fixture(50);
  try {
    f.room.kind = 'dm'; f.room.dm = ['user', A];
    await f.service.setAlertMode(A, mode, 3600_000);
    const { pending } = await f.wait();
    const message = f.service.post(f.room.id, { kind: 'user', name: 'Owner', mark: 'owner_typed' }, 'plain owner DM');
    expect((await pending).json().data.event).toEqual(mode === 'silent' ? null : { roomId: f.room.id, messageId: message.id });
  } finally { await f.app.close(); }
});

it.each(['enabled', null])('normal history and exact reads keep stored receipts private and recheck phone policy (%s)', async activation => {
  vi.stubEnv('REVERIE_ADMIN_PHONE_WAKE', activation ?? undefined);
  const directory = await mkdtemp(join(tmpdir(), 'phone-policy-read-'));
  let service!: ChatroomService;
  const { app } = await createRouteTestHarness((f, c) => {
    c.sessions.set(A, createMockSession(A)); c.sessions.get(A).name = 'Jester'; c.sessions.get(A).mode = 'hands';
    service = new ChatroomService({ file: join(directory, 'rooms.json'), employeeOf: id => 'employee-' + id,
      getSession: id => c.sessions.get(id), broadcast: () => {} });
    registerChatroomRoutes(f, c, service, new ChatFileStore(directory), trustedFixtureOwner);
  });
  await service.init();
  try {
    const room = service.createRoom('Office', undefined); service.addMember(room.id, A);
    const message = service.post(room.id, { kind: 'user', name: 'Owner', mark: 'owner_typed' }, 'Ring question');
    // Model an existing nonempty receipt when restarting the same schema-aware image OFF.
    service.room(room.id)!.messages.find(item => item.id === message.id)!.phoneWakes = [A];
    const read = await app.inject({ url: `/api/chatrooms/${room.id}/messages`, headers });
    const found = read.json().data.messages.find((item: ChatMessage) => item.id === message.id);
    expect(found).toMatchObject({ phoneWake: activation === 'enabled', text: 'Ring question' });
    expect(found).not.toHaveProperty('phoneWakes');
    const exact = await app.inject({ url: `/api/chatrooms/${room.id}/messages/${message.id}`, headers });
    expect(exact.json().data.message).toMatchObject({ phoneWake: activation === 'enabled', text: 'Ring question' });
    expect(exact.json().data.message).not.toHaveProperty('phoneWakes');
    expect(service.room(room.id)!.messages.find(item => item.id === message.id)!.phoneWakes).toEqual([A]);
    await service.setAlertMode(A, 'silent', 3600_000);
    const current = await app.inject({ url: `/api/chatrooms/${room.id}/messages/${message.id}`, headers });
    expect(current.json().data.message).toMatchObject({ id: message.id, phoneWake: false });
    const muted = await app.inject({ url: `/api/chatrooms/${room.id}/messages`, headers });
    expect(muted.json().data.messages.find((item: ChatMessage) => item.id === message.id)).toMatchObject({ phoneWake: false, text: 'Ring question' });
    delete service.room(room.id)!.messages.find(item => item.id === message.id)!.phoneWakes;
    await service.setAlertMode(A, 'ring', 3600_000);
    const legacy = await app.inject({ url: `/api/chatrooms/${room.id}/messages`, headers });
    expect(legacy.json().data.messages.find((item: ChatMessage) => item.id === message.id)).toMatchObject({ phoneWake: false, text: 'Ring question' });
  } finally { await service.stop(); await app.close(); await rm(directory, { recursive: true, force: true }); }
});
