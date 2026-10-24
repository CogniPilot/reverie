import { afterEach, expect, it } from 'vitest';
import Fastify from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChatBotRegistry, parseBot } from '../src/chat-bots.js';
import { registerChatBotRoutes } from '../src/web/routes/chat-bot-routes.js';
import { trustedFixtureOwner } from './helpers/trusted-owner-fixture.js';
import { createHarness } from './helpers/chat-app-harness.mjs';
const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  for (const clean of cleanup.splice(0)) await clean();
});
it('round-trips catalog icons without accepting arbitrary URLs, paths or changing bot capabilities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bot-avatar-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'bots.json');
  const registry = new ChatBotRegistry(file);
  const bot = { name: 'Example', rooms: ['office'], maxPerHour: 12, icon: '/assets/avatars/pack-151.png' };
  await registry.set('example', bot);
  expect(new ChatBotRegistry(file).get('example')).toEqual({ id: 'example', ...bot });
  for (const icon of [
    'https://outside.test/image.png',
    '//outside.test/icon.png',
    '/api/avatars/private',
    '/assets/avatars/pack-152.png',
    '/assets/avatars/../private.png',
    'data:image/png;base64,aA==',
  ])
    expect(() => parseBot({ ...bot, icon }, 'example')).toThrow();
  expect(parseBot({ ...bot, icon: '/assets/avatars/pack-101.png' }, 'example').icon).toBe('/assets/avatars/pack-101.png');
  expect(parseBot({ ...bot, icon: '🔔' }, 'example').icon).toBe('🔔');
});
it('keeps deletion owner-only and refuses bots still referenced by routines', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bot-delete-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const registry = new ChatBotRegistry(join(root, 'bots.json'));
  await registry.set('example', { name: 'Example', rooms: ['office'] });
  const app = Fastify();
  cleanup.push(() => app.close());
  let linked = true;
  registerChatBotRoutes(app, registry, trustedFixtureOwner, () => linked);
  expect((await app.inject({ method: 'DELETE', url: '/api/chat-bots/example' })).statusCode).toBe(409);
  linked = false;
  const refused = await app.inject({
    method: 'DELETE',
    url: '/api/chat-bots/example',
    headers: { 'x-reverie-parent-session': 'agent' },
  });
  expect(refused.json().success).toBe(false);
  expect(registry.get('example')).toBeDefined();
  expect((await app.inject({ method: 'DELETE', url: '/api/chat-bots/example' })).json().success).toBe(true);
  expect(registry.get('example')).toBeUndefined();
});
it('renders a bot catalog icon in chat without treating remote URLs as images', async () => {
  const h = await createHarness();
  cleanup.push(() => h.window.close());
  const avatar = h.shell.avatarFor(
    { kind: 'bot', botId: 'example', name: 'Example', icon: '/assets/avatars/pack-151.png' },
    'Example'
  );
  expect(avatar.querySelector('img')!.getAttribute('src')).toBe('/assets/avatars/pack-151.png');
  const legacy = h.shell.avatarFor({ kind: 'bot', botId: 'saved', name: 'Saved', icon: '/assets/avatars/pack-101.png' }, 'Saved');
  expect(legacy.querySelector('img')!.getAttribute('src')).toBe('/assets/avatars/pack-101.png');
  const refused = h.shell.avatarFor(
    { kind: 'bot', botId: 'example', name: 'Example', icon: 'https://outside.test/private.png' },
    'Example'
  );
  expect(refused.querySelector('img')).toBeNull();
});
