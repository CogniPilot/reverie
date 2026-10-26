/** Real browser + real JSON bridge + actual route guards; destructive ports are owned counters only. */
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { registerLaptopPowerRoutes } from '../src/web/routes/laptop-power-routes.js';

describe('office power confirmation in Chromium with an isolated backend', () => {
 let browser: Browser, page: Page, server: ReturnType<typeof Fastify>, url: string;
 let owner = true, stops = 0, actions: string[] = []; const posts: unknown[] = [];
 const priorSocket = process.env.REVERIE_WORKER_SOCKET;
 beforeAll(async () => {
  process.env.REVERIE_WORKER_SOCKET = '/owned-fixture-only'; server = Fastify();
  server.addHook('preHandler', async request => { if (request.method === 'POST') posts.push(structuredClone(request.body)); });
  registerLaptopPowerRoutes(server, { verifiedOwner: (() => owner) as any, stopIntent: async () => { stops++; }, power: async action => { actions.push(action); return action === 'status' ? { runningLaptops: 3 } : { acknowledged: true }; } });
  for (const name of ['settings-ui.js', 'api-client.js', 'chat-app.css', 'styles.css']) {
   const body = await readFile(resolve(import.meta.dirname, '../src/web/public', name), 'utf8');
   server.get('/'+name, async (_req, reply) => reply.type(name.endsWith('.css') ? 'text/css' : 'application/javascript').send(body));
  }
  server.get('/', async (_req, reply) => reply.type('text/html').send('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/chat-app.css"></head><body><button id="power" onclick="void app.officePower(action)">Power</button><p id="officePowerResult"></p><script>window.ReverieApp=class{};window.action="shutdown";</script><script src="/api-client.js"></script><script src="/settings-ui.js"></script><script>window.app=new ReverieApp();</script></body></html>'));
  url = await server.listen({ host: '127.0.0.1', port: 0 });
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
 });
 afterAll(async () => { await page?.close(); await browser?.close(); await server?.close(); if (priorSocket === undefined) delete process.env.REVERIE_WORKER_SOCKET; else process.env.REVERIE_WORKER_SOCKET = priorSocket; });
 beforeEach(async () => { await page?.close(); owner = true; stops = 0; actions = []; posts.length = 0; page = await browser.newPage({ viewport: { width: 900, height: 700 } }); await page.goto(url); });
 it.each([['shutdown','Shut down Reverie'],['stop-laptops','Stop all laptops'],['restart-website','Restart website']])('shows real buttons and reaches the fixture route once for %s', async (action, label) => {
  await page.evaluate(a => { (window as any).action = a; }, action); await page.locator('#power').click();
  const dialog = page.getByRole('alertdialog'); await dialog.waitFor(); expect(await dialog.getByRole('button', { name: 'Cancel', exact: true }).isVisible()).toBe(true); expect(posts).toEqual([]); expect(stops).toBe(0);
  await dialog.getByRole('button', { name: label, exact: true }).click(); await page.waitForFunction(() => !(window as any).app._officePowerPending);
  expect(posts).toEqual([{ confirmed: true }]); expect(actions).toEqual(['status', action]); expect(stops).toBe(action === 'restart-website' ? 0 : 1); expect(await dialog.count()).toBe(0);
 });
 it.each(['Cancel','Escape'])('does not submit any power action on %s', async how => {
  await page.locator('#power').click(); const dialog = page.getByRole('alertdialog'); await dialog.waitFor();
  if (how === 'Cancel') await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); else await page.keyboard.press('Escape');
  await page.waitForFunction(() => !(window as any).app._officePowerPending); expect(posts).toEqual([]); expect(stops).toBe(0); expect(actions).toEqual(['status']); expect(await dialog.count()).toBe(0); expect(await page.locator('#power').evaluate(e => e === document.activeElement)).toBe(true);
 });
 it('denies an unverified owner before displaying confirmation', async () => {
  owner = false; await page.locator('#power').click(); await page.waitForFunction(() => document.getElementById('officePowerResult')?.textContent?.includes('unavailable')); expect(await page.getByRole('alertdialog').count()).toBe(0); expect(posts).toEqual([]); expect(actions).toEqual([]); expect(stops).toBe(0);
 });
 it('keeps backend owner revalidation if authority disappears while dialog is open', async () => {
  await page.locator('#power').click(); const dialog = page.getByRole('alertdialog'); await dialog.waitFor(); owner = false; await dialog.getByRole('button', { name: 'Shut down Reverie', exact: true }).click(); await page.waitForFunction(() => !(window as any).app._officePowerPending); expect(stops).toBe(0); expect(actions).toEqual(['status']); expect(await page.locator('#officePowerResult').textContent()).toContain('owner');
 });
 it('keeps both buttons inside desktop and mobile viewports', async () => {
  for (const [name,width,height] of [['desktop',900,700],['mobile',390,844]] as const) {
   await page.setViewportSize({width,height}); await page.locator('#power').click(); const dialog = page.getByRole('alertdialog'); await dialog.waitFor();
   const geometry = await dialog.evaluate(e => { const r=e.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight,scroll:e.scrollWidth,client:e.clientWidth}; });
   expect(geometry.left).toBeGreaterThanOrEqual(0); expect(geometry.right).toBeLessThanOrEqual(width); expect(geometry.top).toBeGreaterThanOrEqual(0); expect(geometry.bottom).toBeLessThanOrEqual(height); expect(geometry.scroll).toBeLessThanOrEqual(geometry.client);
   if (process.env.POWER_UI_ARTIFACTS) { await mkdir(process.env.POWER_UI_ARTIFACTS,{recursive:true}); await page.screenshot({path:join(process.env.POWER_UI_ARTIFACTS,name+'-confirmation.png')}); }
   await dialog.getByRole('button',{name:'Cancel',exact:true}).click(); await page.waitForFunction(() => !(window as any).app._officePowerPending);
  }
  expect(posts).toEqual([]); expect(stops).toBe(0);
 });
});
