import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { dataPath, getDataDir } from '../../src/config/instance.js';
import Fastify from 'fastify';
import {
  registerSubscriptionProfileRoutes,
  subscriptionLaunch,
} from '../../src/web/routes/subscription-profile-routes.js';
import { SubscriptionUsageReader } from '../../src/subscription-usage.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';

const apps: ReturnType<typeof Fastify>[] = [];
beforeEach(async () => {
  await fs.rm(join(getDataDir(), 'subscription-profiles.json'), { force: true });
});
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
async function app() {
  const instance = Fastify();
  apps.push(instance);
  registerSubscriptionProfileRoutes(instance, new SubscriptionUsageReader('test'));
  instance.post('/api/sessions', (req) => ({ success: true, data: subscriptionLaunch(req) }));
  installRouteErrorHandler(instance);
  await instance.ready();
  return instance;
}
describe('subscription profile API', () => {
  it('selects a known account before a session launch and never accepts arbitrary credentials', async () => {
    const server = await app();
    const profiles = (await server.inject('/api/subscription-profiles')).json().data.profiles;
    expect(profiles).toHaveLength(2);
    const byId = (id: string) => profiles.find((p: { id: string }) => p.id === id);
    expect(byId('anthropic-default').modes).not.toContain('opencode');
    expect(byId('openai-default').modes).toContain('opencode');
    const selected = await server.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { mode: 'codex', subscriptionProfileId: 'openai-default' },
    });
    expect(selected.statusCode).toBe(200);
    expect(selected.json().data.selection.id).toBe('openai-default');
    const bad = await server.inject({
      method: 'POST',
      url: '/api/subscription-profiles',
      payload: { label: 'Bad', provider: 'openai', accessToken: 'SECRET' },
    });
    expect(bad.statusCode).toBe(400);
  });
  it('refuses unknown accounts, incompatible agents and conflicting credential overrides', async () => {
    const server = await app();
    for (const payload of [
      { mode: 'codex', subscriptionProfileId: 'missing' },
      { mode: 'codex', subscriptionProfileId: 'anthropic-default' },
      { mode: 'codex', subscriptionProfileId: 'openai-default', envOverrides: { CODEX_HOME: '/somewhere-else' } },
      { mode: 'codex', subscriptionProfileId: 'openai-default', customModel: { endpointId: 'gpu' } },
    ])
      expect((await server.inject({ method: 'POST', url: '/api/sessions', payload })).statusCode).toBe(400);
  });
  it('renames a profile by label only and rejects anything else in the body', async () => {
    const server = await app();
    const ok = await server.inject({
      method: 'PATCH',
      url: '/api/subscription-profiles/openai-default',
      payload: { label: '  Codex user@example.com ' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.profile.label).toBe('Codex user@example.com');
    const listed = (await server.inject('/api/subscription-profiles')).json().data.profiles;
    expect(listed.find((p: { id: string }) => p.id === 'openai-default').label).toBe('Codex user@example.com');
    for (const payload of [
      { label: 'X', configDir: '/elsewhere' },
      { label: 'X', provider: 'anthropic' },
      { label: '' },
      {},
    ])
      expect(
        (await server.inject({ method: 'PATCH', url: '/api/subscription-profiles/openai-default', payload })).statusCode
      ).toBe(400);
    const missing = await server.inject({
      method: 'PATCH',
      url: '/api/subscription-profiles/nope',
      payload: { label: 'Codex user@example.com' },
    });
    expect(missing.statusCode).toBe(404);
  });
  it('records a rename in the admin audit log, and a refused or failed one leaves no line', async () => {
    const audit = dataPath('admin-audit.jsonl');
    await fs.rm(audit, { force: true });
    const server = await app();
    const ok = await server.inject({
      method: 'PATCH',
      url: '/api/subscription-profiles/openai-default',
      payload: { label: 'Codex audit@example.com' },
    });
    expect(ok.statusCode).toBe(200);
    await server.inject({
      method: 'PATCH',
      url: '/api/subscription-profiles/nope',
      payload: { label: 'Codex x@example.com' },
    });
    await server.inject({
      method: 'PATCH',
      url: '/api/subscription-profiles/openai-default',
      headers: { 'x-codeman-parent-session': 'not-an-id' },
      payload: { label: 'Codex y@example.com' },
    });
    const lines = (await fs.readFile(audit, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      action: 'profile_rename',
      target: 'openai-default',
      detail: { from: 'Default Codex', to: 'Codex audit@example.com' },
    });
  });
  it('refuses a rename from any agent caller, whatever the header value', async () => {
    const server = await app();
    for (const id of ['11111111-2222-4333-8444-555555555555', 'not-an-id', '']) {
      const res = await server.inject({
        method: 'PATCH',
        url: '/api/subscription-profiles/openai-default',
        headers: { 'x-codeman-parent-session': id },
        payload: { label: 'Codex agent@example.com' },
      });
      expect(res.statusCode).toBe(403);
    }
    const listed = (await server.inject('/api/subscription-profiles')).json().data.profiles;
    expect(listed.find((p: { id: string }) => p.id === 'openai-default').label).not.toBe('Codex agent@example.com');
  });
});
