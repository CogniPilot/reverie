/**
 * A bot's posts show its current picture (changing a bot's profile image left its earlier posts with the
 * old one). The picture is read by the bot's stable id when people's views show messages; the stored history, agents'
 * reads and the notice digests keep what each post was made with, and saving a new picture re-announces the rooms so open
 * views redraw.
 */
import { afterEach, expect, it } from 'vitest';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatroomService } from '../src/chatroom-service.js';
import { ChatBotRegistry } from '../src/chat-bots.js';
import { registerChatBotRoutes } from '../src/web/routes/chat-bot-routes.js';
import { trustedFixtureOwner } from './helpers/trusted-owner-fixture.js';
import { createMockSession } from './mocks/index.js';

const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { for (const clean of cleanup.splice(0)) await clean(); });

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'bot-avatar-history-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const registry = new ChatBotRegistry(join(dir, 'bots.json'));
  const events: Array<{ event: string; data: { roomId?: string } }> = [];
  const service = new ChatroomService({ file: join(dir, 'chatrooms.json'), getSession: () => undefined,
    broadcast: (event, data) => void events.push({ event, data: data as { roomId?: string } }), botOf: (id) => registry.get(id) });
  cleanup.push(() => service.stop());
  const office = service.createRoom('Office', undefined).id;
  const other = service.createRoom('Other', undefined).id;
  const bot = await registry.set('notifier', { name: 'Notifier', rooms: [office], icon: '/assets/avatars/pack-01.png' });
  return { registry, service, events, office, other, bot };
}

it('shows a bot\'s current picture on its earlier posts without rewriting what was stored', async () => {
  const { registry, service, office, bot } = await setup();
  const posted = service.postAsBot(bot, office, 'Build finished.', 0);
  expect(posted.from).toMatchObject({ kind: 'bot', botId: 'notifier', icon: '/assets/avatars/pack-01.png' });
  await registry.set('notifier', { name: 'Notifier', rooms: [office], icon: '/assets/avatars/pack-101.png' });
  const shown = () => service.view(service.room(office)!).messages.find((m) => m.id === posted.id)!;
  expect(shown().from).toMatchObject({ kind: 'bot', botId: 'notifier', icon: '/assets/avatars/pack-101.png' });
  // The stored message is unchanged: only the presentation follows the bot.
  expect(service.room(office)!.messages.find((m) => m.id === posted.id)!.from).toMatchObject({ icon: '/assets/avatars/pack-01.png' });
  // A bot that now has no picture keeps the one each post was made with; a removed bot does too.
  await registry.set('notifier', { name: 'Notifier', rooms: [office] });
  expect(shown().from).toMatchObject({ icon: '/assets/avatars/pack-01.png' });
  await registry.remove('notifier');
  expect(shown().from).toMatchObject({ icon: '/assets/avatars/pack-01.png' });
});

it('saving a new picture re-announces the rooms the bot may have posted in, and only then', async () => {
  const { registry, service, events, office, other, bot } = await setup();
  service.postAsBot(bot, office, 'Build finished.', 0);
  const app = Fastify();
  cleanup.push(() => app.close());
  registerChatBotRoutes(app, registry, trustedFixtureOwner, () => false, (saved) => service.botChanged(saved.id, saved.rooms));
  const put = (body: object) => app.inject({ method: 'PUT', url: '/api/chat-bots/notifier', payload: body });
  const changed = () => events.filter((e) => e.event === 'chatroom:changed').map((e) => e.data.roomId);
  events.length = 0;
  expect((await put({ name: 'Notifier', rooms: [office], icon: '/assets/avatars/pack-01.png', maxPerHour: 30 })).json().success).toBe(true);
  expect(changed()).toEqual([]); // same picture: nothing to redraw
  expect((await put({ name: 'Notifier', rooms: [office], icon: '/assets/avatars/pack-101.png' })).json().success).toBe(true);
  expect(changed()).toEqual([office]);
  expect(changed()).not.toContain(other);
  // An agent cannot change it, so nothing is announced.
  events.length = 0;
  const refused = await app.inject({ method: 'PUT', url: '/api/chat-bots/notifier', headers: { 'x-reverie-parent-session': 'agent' },
    payload: { name: 'Notifier', rooms: [office], icon: '🔔' } });
  expect(refused.json().success).toBe(false);
  expect(changed()).toEqual([]);
});

it('keeps a bot notice\'s digest when only the bot\'s picture changes, and agents read the post as it was made', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-avatar-digest-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const registry = new ChatBotRegistry(join(dir, 'bots.json'));
  const agent = createMockSession('00000041-0042-4000-8000-000000000043');
  agent.name = 'Reviewer';
  const service = new ChatroomService({ file: join(dir, 'chatrooms.json'), getSession: (id) => (id === agent.id ? agent : undefined),
    employeeOf: (id) => (id === agent.id ? 'employee-a' : undefined), deferDeliveryRecovery: true, broadcast: () => {},
    botOf: (id) => registry.get(id) });
  cleanup.push(() => service.stop());
  await service.init();
  const room = service.createRoom('Office').id;
  service.addMember(room, agent.id);
  const bot = await registry.set('notifier', { name: 'Notifier', rooms: [room], icon: '/assets/avatars/pack-01.png' });
  const posted = service.postAsBot(bot, room, '@Reviewer the build failed', 0);
  const digest = () => service.turnSummary(agent.id).messages.find((m) => m.messageId === posted.id)?.sourceDigest;
  const before = digest();
  expect(before).toMatch(/^[0-9a-f]{64}$/);
  await registry.set('notifier', { name: 'Notifier', rooms: [room], icon: '/assets/avatars/pack-101.png' });
  expect(digest()).toBe(before);
  // Agents read the stored sender: the new picture is for people's views only.
  expect(service.exactAgentRead(agent.id, room, posted.id).message.from).toMatchObject({ icon: '/assets/avatars/pack-01.png' });
});

it('a bot notice an agent marks handled leaves its summary, whether the picture changed before or after', async () => {
  for (const order of ['changed first', 'handled first'] as const) {
    const dir = mkdtempSync(join(tmpdir(), 'bot-avatar-handled-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const registry = new ChatBotRegistry(join(dir, 'bots.json'));
    const agent = createMockSession('00000041-0042-4000-8000-000000000043');
    agent.name = 'Reviewer';
    const service = new ChatroomService({ file: join(dir, 'chatrooms.json'), getSession: (id) => (id === agent.id ? agent : undefined),
      employeeOf: (id) => (id === agent.id ? 'employee-a' : undefined), deferDeliveryRecovery: true, broadcast: () => {},
      botOf: (id) => registry.get(id) });
    cleanup.push(() => service.stop());
    await service.init();
    const room = service.createRoom('Office').id;
    service.addMember(room, agent.id);
    const bot = await registry.set('notifier', { name: 'Notifier', rooms: [room], icon: '/assets/avatars/pack-01.png' });
    const posted = service.postAsBot(bot, room, '@Reviewer the build failed', 0);
    const listed = () => service.turnSummary(agent.id).messages.map((m) => m.messageId);
    const recolor = () => registry.set('notifier', { name: 'Notifier', rooms: [room], icon: '/assets/avatars/pack-101.png' });
    const handle = () => service.resolveNotice(agent.id, { roomId: room, messageId: posted.id,
      readToken: service.exactAgentRead(agent.id, room, posted.id).readToken, disposition: 'handled' });
    expect(listed(), order).toContain(posted.id);
    if (order === 'changed first') { await recolor(); handle(); } else { handle(); await recolor(); }
    expect(listed(), order).not.toContain(posted.id);
  }
});
