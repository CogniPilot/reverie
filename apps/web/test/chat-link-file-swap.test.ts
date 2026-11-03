/**
 * A linked file is served only if the file opened is still the file a fresh check finds. The shared drive is writable by
 * agents, so a folder on the path can be swapped for a symlink between the check and the open. These tests make that swap
 * happen at the open, as an attacker winning the race would, and expect a refusal instead of the other file.
 */
import fs from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatFileStore } from '../src/chatroom-files.js';
import { ChatroomService } from '../src/chatroom-service.js';
import { registerChatroomRoutes } from '../src/web/routes/chatroom-routes.js';
import { trustedFixtureOwner } from './helpers/trusted-owner-fixture.js';
import { createRouteTestHarness } from './routes/_route-test-utils.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });

/** Links reports/plan.txt on a temporary shared drive, then reads it with a swap of reports/ made at the open. */
async function readWithSwapAtOpen(swapBack: boolean) {
  const base = mkdtempSync(join(tmpdir(), 'link-swap-'));
  roots.push(base);
  const shared = join(base, 'shared'), outside = join(base, 'server-only');
  await fs.mkdir(join(shared, 'reports'), { recursive: true });
  await fs.mkdir(outside);
  const plan = join(shared, 'reports', 'plan.txt');
  await fs.writeFile(plan, 'shared plan');
  await fs.writeFile(join(outside, 'plan.txt'), 'SERVER-ONLY SECRET');
  vi.stubEnv('REVERIE_SHARED_WORKSPACE_PATH', shared);
  let service!: ChatroomService;
  const harness = await createRouteTestHarness((app, ctx) => {
    service = new ChatroomService({ file: join(base, 'chatrooms.json'), database: join(base, 'chat.db'), getSession: (id) => ctx.sessions.get(id), broadcast: () => {} });
    registerChatroomRoutes(app, ctx, service, new ChatFileStore(join(base, 'files')), trustedFixtureOwner);
  });
  try {
    await service.init();
    const room = service.createRoom('Office', undefined);
    const call = (method: 'GET' | 'POST', url: string, payload?: unknown) => harness.app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
    const file = (await call('POST', `/api/chatrooms/${room.id}/links`, { path: plan })).json().data.file;
    expect((await call('POST', `/api/chatrooms/${room.id}/messages`, { text: 'plan', attachments: [file.id] })).statusCode).toBe(200);
    const url = `/api/chatrooms/${room.id}/files/${file.id}`;
    expect((await call('GET', url)).body).toBe('shared plan');
    const open = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (path, ...rest) => {
      if (path !== plan) return open(path, ...rest);
      await fs.rename(join(shared, 'reports'), join(shared, 'reports.old'));
      await fs.symlink(outside, join(shared, 'reports'));
      const handle = await open(path, ...rest);
      if (swapBack) {
        await fs.rm(join(shared, 'reports'));
        await fs.rename(join(shared, 'reports.old'), join(shared, 'reports'));
      }
      return handle;
    });
    return await call('GET', url);
  } finally {
    await service.stop();
    await harness.app.close();
  }
}

it('refuses a linked file when a folder on its path became a symlink at the open', async () => {
  const read = await readWithSwapAtOpen(false);
  expect(read.body).not.toContain('SERVER-ONLY SECRET');
  expect(read.statusCode).toBe(403);
});

it('refuses it too when the folder is swapped back right after the open, so a fresh check alone would pass', async () => {
  const read = await readWithSwapAtOpen(true);
  expect(read.body).not.toContain('SERVER-ONLY SECRET');
  expect(read.statusCode).toBe(403);
  expect(read.json().error).toBe('That file changed while it was opened; try again.');
});
