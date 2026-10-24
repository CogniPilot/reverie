import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { createServer, member, room, message } from './helpers/chat-app-harness.mjs';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
const read = (name: string) => readFileSync(resolve(publicDir, name), 'utf8');
const harness = readFileSync(resolve(import.meta.dirname, 'helpers/chat-app-harness.mjs'), 'utf8');
const appStub = harness.match(/window\.eval\(`([\s\S]*?)`\);/)![1];
let browser: Browser, page: Page;
let requests: unknown[] = [];
beforeAll(async () => {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {}),
  });
});
afterAll(async () => {
  await page?.close();
  await browser?.close();
});
beforeEach(async () => {
  await page?.close();
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  requests = [];
  await page.route('**/*', async (route) => {
    if (route.request().url().endsWith('/api/chat-plugins/lsp')) {
      requests.push(route.request().postDataJSON());
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            diagnosticsReceived: true,
            diagnostics: [{ line: 0, character: 2, message: '<script>unsafe()</script> type mismatch' }],
            completions: [{ label: 'safe_completion', detail: 'type info' }],
            hover: 'Real variable <img src=x>',
          },
        }),
      });
    }
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head></head><body></body></html>' });
  });
  await page.goto('http://chat-plugins.test/');
  for (const name of ['styles.css', 'chat-app.css', 'chat-plugins.css'])
    await page.addStyleTag({ content: read(name) });
  await page.addScriptTag({
    content: `
    ${member.toString()} ${room.toString()} ${message.toString()} ${createServer.toString()}
    const user = { kind: 'user', name: 'Owner' };
    window.ReverieUrlSession = { sessionIdFromFragment: () => null };
    window.__server = createServer([room('r1','General',[],{messages:[message('m1','r1',user,${JSON.stringify('```python\nx: int = "oops"\n```\n```modelica\nmodel X\n Real x;\nend X;\n```')},1000)]})]);
    ${appStub}
  `,
  });
  for (const name of ['chatroom-ui.js', 'chat-media.js']) await page.addScriptTag({ content: read(name) });
  await page.addScriptTag({ content: 'window.app = new ReverieApp();' });
  for (const name of ['chat-app.js', 'chat-plugins.js', 'chat-language-plugins.js'])
    await page.addScriptTag({ content: read(name) });
  await page.locator('.ca-plugins-open').waitFor();
});

it('keeps real chat fences unchanged while disabled, requires explicit opt-in/action, and treats results as text', async () => {
  const original = await page.locator('.chatroom-codeblock').first().textContent();
  expect(await page.locator('.chat-plugin-actions').count()).toBe(0);
  expect(requests).toEqual([]);
  await page.getByRole('button', { name: 'Optional chat plugins' }).click();
  await page.getByLabel(/Python —/).check();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  expect(await page.getByRole('button', { name: 'Python assistance', exact: true }).count()).toBe(1);
  expect(requests).toEqual([]);
  await page.getByRole('button', { name: 'Python assistance', exact: true }).click();
  const source = page.getByLabel('Python source');
  await source.fill('x: int = "private scratch"');
  expect(requests).toEqual([]);
  await page.getByRole('button', { name: 'Check', exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector('.chat-plugin-output')?.textContent?.includes('type mismatch')
  );
  expect(requests).toHaveLength(1);
  expect((requests[0] as any).source).toContain('private scratch');
  expect(await page.locator('.chat-plugin-output script').count()).toBe(0);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain(
    'private scratch'
  );
  await page.getByRole('button', { name: 'Complete', exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector('.chat-plugin-output')?.textContent?.includes('safe_completion')
  );
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  expect(await page.locator('.chatroom-codeblock').first().textContent()).toBe(original + 'Python assistance');
  await page.getByRole('button', { name: 'Optional chat plugins' }).click();
  await page.getByLabel(/Python —/).uncheck();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  expect(await page.locator('.chatroom-codeblock').first().textContent()).toBe(original);
});

it('keeps the Plugins text button inside the header and exposes the same settings in More actions', async () => {
  for (const width of [940, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const button = page.getByRole('button', { name: 'Optional chat plugins' });
    const box = await button.boundingBox();
    const header = await page.locator('.ca-head').boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(68);
    expect(box!.x).toBeGreaterThanOrEqual(header!.x);
    expect(box!.x + box!.width).toBeLessThanOrEqual(header!.x + header!.width + 1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
  }
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Chat plugins', exact: true }).click();
  await page.getByRole('heading', { name: 'Optional chat plugins', exact: true }).waitFor();
});

it('offers Modelica in a narrow browser with accessible controls and reversible preferences', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Optional chat plugins' }).click();
  await page.getByLabel(/Modelica —/).check();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Modelica assistance', exact: true }).click();
  expect(await page.getByLabel('Modelica source').inputValue()).toContain('model X');
  const bounds = await page.locator('.chat-language-editor').boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(await page.getByRole('button', { name: 'Hover', exact: true }).isVisible()).toBe(true);
  if (process.env.CHAT_PLUGIN_SCREENSHOT) await page.screenshot({ path: process.env.CHAT_PLUGIN_SCREENSHOT });
  await page.getByRole('button', { name: 'Hover', exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector('.chat-plugin-output')?.textContent?.includes('Real variable')
  );
  expect(await page.locator('.chat-plugin-output img').count()).toBe(0);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Optional chat plugins' }).click();
  await page.getByLabel(/Modelica —/).uncheck();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  expect(await page.getByRole('button', { name: 'Modelica assistance', exact: true }).count()).toBe(0);
});
