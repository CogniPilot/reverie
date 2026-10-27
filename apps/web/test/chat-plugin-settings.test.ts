import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { ChatPluginSettingsStore } from '../src/chat-plugin-settings.js';
import { registerChatPluginRoutes } from '../src/web/routes/chat-plugin-routes.js';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { ownerVerifier } from '../src/owner-auth/marks.js';
import { OWNER_COOKIE, registerOwnerPolicy } from '../src/owner-auth/policy.js';
import type { SessionPort } from '../src/web/ports/session-port.js';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'chat-plugin-settings-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
const flags = { latex: true, python: true, modelica: false };

describe('instance plugin settings', () => {
  it('defaults off, stores only validated flags, and reloads the saved configuration after restart', async () => {
    const path = join(directory, 'chat-plugins.json');
    const store = new ChatPluginSettingsStore(path);
    expect(store.read()).toEqual({ latex: false, python: false, modelica: false });
    await store.save(flags);
    expect(new ChatPluginSettingsStore(path).read()).toEqual(flags);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(flags);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const copy = store.read();
    copy.python = false;
    expect(store.read()).toEqual(flags);
    for (const invalid of [{}, { ...flags, python: 'true' }, { ...flags, command: 'install' }, null]) {
      expect(() => store.save(invalid)).toThrow();
    }
    expect(store.read()).toEqual(flags);
    await writeFile(path, '{broken');
    expect(new ChatPluginSettingsStore(path).read().python).toBe(false);
  });
  it('uses the real owner cookie gate for writes and allows scoped agents to read shared flags', async () => {
    const auth = new OwnerAuthService({ store: new OwnerAuthStore(join(directory, 'auth.json')), setupEnabled: true });
    const password = 'Synthetic-constellation-57!';
    const token = await auth.setup('human', password, password, '127.0.0.1');
    const agent = '0000002d-0035-4000-8000-000000000047';
    const ctx = { sessions: new Map([[agent, { id: agent }]]) } as unknown as SessionPort;
    const app = Fastify();
    await app.register(fastifyCookie);
    registerOwnerPolicy(app, {
      service: auth,
      ctx,
      isCapabilityRequest: () => false,
      relations: {
        known: () => true,
        related: () => false,
        upward: () => false,
        keeper: () => false,
        admin: () => false,
      },
    });
    const store = new ChatPluginSettingsStore(join(directory, 'chat-plugins.json'));
    registerChatPluginRoutes(app, ownerVerifier({ service: auth, ctx }), undefined, store);
    try {
      const cookies = { [OWNER_COOKIE]: token };
      const read = await app.inject({ url: '/api/chat-plugins', headers: { 'x-reverie-parent-session': agent } });
      expect(read.statusCode).toBe(200);
      expect(read.json().data.canManage).toBe(false);
      expect(read.headers['cache-control']).toBe('no-store');
      for (const headers of [{ authorization: 'owner' }, { 'x-reverie-parent-session': agent }]) {
        const denied = await app.inject({
          method: 'PUT',
          url: '/api/chat-plugins',
          payload: flags,
          headers: { origin: 'http://localhost:80', ...headers },
          cookies,
        });
        // Cookie authorizes only its human caller; an agent header never inherits it.
        expect(denied.statusCode).toBe(headers.authorization ? 200 : 403);
      }
      expect(
        (
          await app.inject({
            method: 'PUT',
            url: '/api/chat-plugins',
            payload: flags,
            headers: { authorization: 'owner' },
          })
        ).statusCode
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: 'PUT',
            url: '/api/chat-plugins',
            payload: { ...flags, python: 'true' },
            headers: { origin: 'http://localhost:80' },
            cookies,
          })
        ).statusCode
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: 'PUT',
            url: '/api/chat-plugins',
            payload: flags,
            headers: { origin: 'http://localhost:80' },
            cookies,
          })
        ).statusCode
      ).toBe(200);
      expect(new ChatPluginSettingsStore(join(directory, 'chat-plugins.json')).read()).toEqual(flags);
      const snippet = {
        enabled: true,
        language: 'modelica',
        source: 'model X end X;',
        action: 'diagnostics',
        position: { line: 0, character: 0 },
      };
      const disabled = await app.inject({
        method: 'POST',
        url: '/api/chat-plugins/lsp',
        payload: snippet,
        headers: { origin: 'http://localhost:80' },
        cookies,
      });
      expect(disabled.statusCode).toBe(403);
      expect(disabled.json().errorCode).toBe('PLUGIN_DISABLED');
    } finally {
      await app.close();
    }
  });
});
