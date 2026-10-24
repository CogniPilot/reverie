/** Real browser + HTTP parsers + real owner login; all state and senders are synthetic. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { expect, it } from 'vitest';
import { chromium } from 'playwright';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { bootstrap, setPolicy } from '../src/owner-auth/admin.js';
import { ownerVerifier } from '../src/owner-auth/marks.js';
import { registerOwnerPolicy } from '../src/owner-auth/policy.js';
import { registerOwnerRoutes } from '../src/owner-auth/routes.js';
import { registerBotsPageRoutes } from '../src/web/routes/bots-page-routes.js';
import { registerChatBotRoutes } from '../src/web/routes/chat-bot-routes.js';
import { registerCronRoutes } from '../src/web/routes/cron-routes.js';
import { ChatBotRegistry } from '../src/chat-bots.js';
import { CronService, type CronDeps } from '../src/cron/cron-service.js';
import type { CronJob, CronJobRun } from '../src/types/cron.js';

it('uses actual owner HTTP routes to create a bot/routine, edit content and delete with a bodyless request', async () => {
  const task = await mkdtemp(join(tmpdir(), 'bots-http-'));
  const app = Fastify();
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {}),
  });
  try {
    const store = new OwnerAuthStore(join(task, 'owner.json'));
    const password = (await bootstrap(store, 'fixture-owner')).oneTimePassword;
    await setPolicy(store, 'enforce', { forceLockoutRisk: true });
    const service = new OwnerAuthService({ store, auditFile: join(task, 'audit.jsonl') });
    const ctx = { sessions: new Map() } as never;
    const verifiedOwner = ownerVerifier({ service, ctx });
    await app.register(cookie);
    registerOwnerPolicy(app, {
      service,
      ctx,
      isCapabilityRequest: () => false,
      relations: {
        known: () => false,
        related: () => false,
        upward: () => false,
        keeper: () => false,
        admin: () => false,
      },
    });
    registerOwnerRoutes(app, service, false);
    registerBotsPageRoutes(app, verifiedOwner);
    const bots = new ChatBotRegistry(join(task, 'bots.json'));
    registerChatBotRoutes(app, bots, verifiedOwner);
    const jobs: Record<string, CronJob> = {},
      runs: Record<string, CronJobRun> = {};
    const cron = new CronService({
      sessions: new Map(),
      broadcast() {},
      store: {
        getCronJobs: () => jobs,
        getCronJob: (id: string) => jobs[id] || null,
        setCronJob: (id: string, job: CronJob) => {
          jobs[id] = job;
        },
        removeCronJob: (id: string) => {
          delete jobs[id];
        },
        getCronJobRuns: () => runs,
        setCronJobRun: (id: string, run: CronJobRun) => {
          runs[id] = run;
        },
        removeCronJobRun: (id: string) => {
          delete runs[id];
        },
      },
    } as unknown as CronDeps);
    registerCronRoutes(app, { cron } as never, verifiedOwner);
    app.get('/api/chatrooms', async () => ({ success: true, data: { rooms: [{ id: 'office', name: 'office' }] } }));
    app.get('/api/company', async () => ({ success: true, data: { employees: [] } }));
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    const context = await browser.newContext();
    expect(
      (
        await context.request.post(base + '/api/owner/login', { data: { username: 'fixture-owner', password } })
      ).status()
    ).toBe(200);
    expect(
      (
        await context.request.post(base + '/api/owner/password', {
          headers: { Origin: base },
          data: { current: password, next: 'Fuchsia!river73-lanternQuartz' },
        })
      ).status()
    ).toBe(200);
    const page = await context.newPage();
    await page.goto(base + '/bots');
    await page.getByRole('button', { name: 'Set up a bot', exact: true }).click();
    const bot = page.getByRole('dialog', { name: 'Set up a bot' });
    await bot.getByLabel('Identifier', { exact: true }).fill('fixture');
    await bot.getByLabel('Name', { exact: true }).fill('Fixture helper');
    await bot.getByLabel('#office', { exact: true }).check();
    await bot.getByRole('button', { name: 'Save bot' }).click();
    await page.locator('#bot-dialog').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'New routine', exact: true }).click();
    const routine = page.getByRole('dialog', { name: 'New routine' });
    await routine.getByLabel('Name', { exact: true }).fill('Fixture routine');
    await routine.getByLabel('Message', { exact: true }).fill('Original message');
    await routine.getByRole('button', { name: 'Save routine' }).click();
    await page.getByText('Created by: Owner', { exact: true }).waitFor();
    expect(cron.listJobs()).toHaveLength(1);
    expect(cron.listJobs()[0].enabled).toBe(false);
    await page.getByRole('button', { name: 'Edit content' }).click();
    const editor = page.locator('#content-dialog');
    await editor.getByRole('textbox', { name: 'Message', exact: true }).fill('Edited message');
    await editor.getByRole('button', { name: 'Save content' }).click();
    await editor.waitFor({ state: 'hidden' });
    expect(cron.listJobs()[0].postText).toBe('Edited message');
    page.once('dialog', (dialog) => {
      void dialog.accept();
    });
    const response = page.waitForResponse((response) => response.request().method() === 'DELETE');
    await page.getByRole('button', { name: 'Delete routine' }).click();
    const deleted = await response;
    expect(deleted.status()).toBe(200);
    expect(deleted.request().headers()['content-type']).toBeUndefined();
    await page.getByText('No routines yet. Choose New routine to set one up.', { exact: true }).waitFor();
    expect(cron.listJobs()).toEqual([]);
    expect(bots.list()).toHaveLength(1);
  } finally {
    await browser.close();
    await app.close();
    await rm(task, { recursive: true, force: true });
  }
});
