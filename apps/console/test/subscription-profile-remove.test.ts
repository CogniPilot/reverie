import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { getDataDir } from '../src/config/instance.js';
import {
  addSubscriptionProfile,
  readSubscriptionProfiles,
  removeSubscriptionProfile,
} from '../src/subscription-profiles.js';
import { registerSubscriptionProfileRoutes } from '../src/web/routes/subscription-profile-routes.js';
import type { SubscriptionUsageReader } from '../src/subscription-usage.js';

beforeEach(async () => {
  await fs.rm(join(getDataDir(), 'subscription-profiles.json'), { force: true });
});

describe('removeSubscriptionProfile', () => {
  it('unlists only the entry and leaves the login directory and its files on disk', async () => {
    const keep = await addSubscriptionProfile({ label: 'Keep', provider: 'openai' });
    const gone = await addSubscriptionProfile({ label: 'Gone', provider: 'openai' });
    await fs.mkdir(gone.configDir, { recursive: true });
    await fs.writeFile(join(gone.configDir, 'auth.json'), '{}');
    const removed = await removeSubscriptionProfile(gone.id);
    expect(removed?.id).toBe(gone.id);
    expect((await readSubscriptionProfiles()).map((p) => p.id)).toContain(keep.id);
    expect((await readSubscriptionProfiles()).map((p) => p.id)).not.toContain(gone.id);
    expect(await fs.readFile(join(gone.configDir, 'auth.json'), 'utf8')).toBe('{}');
    expect((await fs.stat(join(getDataDir(), 'subscription-profiles.json'))).mode & 0o777).toBe(0o600);
  });

  it('refuses the built-in defaults and answers null for an unknown id', async () => {
    await expect(removeSubscriptionProfile('openai-default')).rejects.toThrow('default accounts');
    await expect(removeSubscriptionProfile('anthropic-default')).rejects.toThrow('default accounts');
    expect(await removeSubscriptionProfile('openai-nope')).toBeNull();
  });

  it('serializes with concurrent additions without dropping either', async () => {
    const a = await addSubscriptionProfile({ label: 'A', provider: 'anthropic' });
    const [, b] = await Promise.all([removeSubscriptionProfile(a.id), addSubscriptionProfile({ label: 'B', provider: 'openai' })]);
    const ids = (await readSubscriptionProfiles()).map((p) => p.id);
    expect(ids).toContain(b.id);
    expect(ids).not.toContain(a.id);
  });
});

describe('DELETE /api/subscription-profiles/:id', () => {
  let app: FastifyInstance;
  let running: Record<string, string[]>;

  beforeEach(async () => {
    running = {};
    app = Fastify();
    registerSubscriptionProfileRoutes(app, {} as SubscriptionUsageReader, async (id) => running[id] ?? []);
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  it('removes an account and keeps its directory', async () => {
    const p = await addSubscriptionProfile({ label: 'Temp', provider: 'openai' });
    await fs.mkdir(p.configDir, { recursive: true });
    const r = await app.inject({ method: 'DELETE', url: `/api/subscription-profiles/${p.id}` });
    expect(r.statusCode).toBe(200);
    expect(r.json().data.removed).toEqual({ id: p.id, label: 'Temp', provider: 'openai' });
    expect((await readSubscriptionProfiles()).some((x) => x.id === p.id)).toBe(false);
    expect((await fs.stat(p.configDir)).isDirectory()).toBe(true);
  });

  it('is refused with 409 while sessions run on the account, and nothing changes', async () => {
    const p = await addSubscriptionProfile({ label: 'Busy', provider: 'openai' });
    running[p.id] = ['Otto'];
    const r = await app.inject({ method: 'DELETE', url: `/api/subscription-profiles/${p.id}` });
    expect(r.statusCode).toBe(409);
    expect(r.json().error ?? r.json().message).toContain('Otto');
    expect((await readSubscriptionProfiles()).some((x) => x.id === p.id)).toBe(true);
  });

  it('refuses defaults (400), unknown ids (404) and any agent caller (403)', async () => {
    const p = await addSubscriptionProfile({ label: 'Agentless', provider: 'openai' });
    expect((await app.inject({ method: 'DELETE', url: '/api/subscription-profiles/openai-default' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: '/api/subscription-profiles/openai-zzzz' })).statusCode).toBe(404);
    const agent = await app.inject({
      method: 'DELETE',
      url: `/api/subscription-profiles/${p.id}`,
      headers: { 'x-codeman-parent-session': 'x' },
    });
    expect(agent.statusCode).toBe(403);
    expect((await readSubscriptionProfiles()).some((x) => x.id === p.id)).toBe(true);
  });

  it('answers 500, not 400, when the write itself fails, and keeps the account', async () => {
    const p = await addSubscriptionProfile({ label: 'Unwritable', provider: 'openai' });
    const spy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('EIO'));
    const r = await app.inject({ method: 'DELETE', url: `/api/subscription-profiles/${p.id}` });
    spy.mockRestore();
    expect(r.statusCode).toBe(500);
    expect(JSON.stringify(r.json())).not.toContain('EIO');
    expect((await readSubscriptionProfiles()).some((x) => x.id === p.id)).toBe(true);
  });
});
