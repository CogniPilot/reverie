import { readFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { createServer, member, room, message } from './helpers/chat-app-harness.mjs';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const read = (name: string) => readFileSync(resolve(PUBLIC, name), 'utf8');
const harness = readFileSync(resolve(import.meta.dirname, 'helpers/chat-app-harness.mjs'), 'utf8');
const appStub = harness.match(/window\.eval\(`([\s\S]*?)`\);/)![1];
const A = '00000026-002d-4000-8000-00000000003c';
const raw = 'Discuss $E=mc^2$\n$$\\int_0^1 x^2 \\, dx = \\frac{1}{3}$$';

describe('optional math in the actual chat shell, Chromium', () => {
  let browser: Browser, page: Page;
  let assets: string[], external: string[], errors: string[];
  beforeAll(async () => {
    browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
  });
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    await page?.close();
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.setDefaultTimeout(10000);
    assets = [];
    external = [];
    errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== 'http://math-chat.test') {
        external.push(url.href);
        return route.abort();
      }
      if (url.pathname === '/')
        return route.fulfill({
          contentType: 'text/html',
          body: '<!doctype html><html><head></head><body></body></html>',
        });
      const path = url.pathname.slice(1);
      if (path.includes('..') || !/^(?:vendor\/katex-0\.19\.0\/|chat-math-(?:sanitizer|renderer)\.js$)/.test(path))
        return route.abort();
      assets.push(path);
      return route.fulfill({
        contentType: (
          { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' } as Record<string, string>
        )[extname(path)],
        body: readFileSync(resolve(PUBLIC, path)),
      });
    });
    await page.goto('http://math-chat.test/', { waitUntil: 'domcontentloaded' });
    for (const file of ['styles.css', 'chat-app.css', 'chat-plugins.css', 'chat-math-plugin.css'])
      await page.addStyleTag({ content: read(file) });
    await page.addScriptTag({
      content: `
      ${member.toString()}
      ${room.toString()}
      ${message.toString()}
      ${createServer.toString()}
      const user = { kind: 'user', name: 'Owner' };
      window.ReverieUrlSession = { sessionIdFromFragment: () => null };
      window.__server = createServer([room('r1', 'General', [member('${A}', 'Maple')], { messages: [message('m1', 'r1', {kind:'agent', sessionId:'${A}', name:'Maple'}, ${JSON.stringify(raw)}, 1000)] })]);
      let pluginFlags = {latex:false,python:false,modelica:false};
      window.fetch = (url, init = {}) => {
        if (init.method === 'PUT') pluginFlags = JSON.parse(init.body);
        return Promise.resolve({ok:true,json:async()=>({success:true,data:{enabled:pluginFlags,available:{python:false,modelica:false},canManage:true}})});
      };
      ${appStub}
    `,
    });
    for (const file of ['chatroom-ui.js', 'chat-media.js']) await page.addScriptTag({ content: read(file) });
    await page.addScriptTag({
      content: `window.app = new ReverieApp(); window.app.sessions.set('${A}', {id:'${A}', name:'Maple', mode:'claude'});`,
    });
    for (const file of ['chat-app.js', 'vendor/dompurify.min.js', 'chat-plugins.js', 'chat-math-plugin.js'])
      await page.addScriptTag({ content: read(file) });
    await page.waitForSelector('.ca-msg');
  });
  async function setEnabled(enabled: boolean) {
    await page.evaluate(() => (window as any).ReverieChatPlugins.openSettings());
    await page.locator('.chat-plugin-choice').filter({ hasText: 'LaTeX math' }).locator('input').setChecked(enabled);
    await page.getByText('Saved for everyone.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
  }

  it('enables through shared settings, toggles original source, edits a draft and sends the exact math source', async () => {
    expect(assets).toEqual([]);
    expect(await page.locator('.chat-math-toolbar').count()).toBe(0);
    await setEnabled(true);
    await page.waitForSelector('.chat-math-message-preview .katex');
    expect(await page.locator('.chat-math-message-preview .katex').count()).toBe(2);
    const msg = page.locator('.chatroom-msg-text').first();
    await msg.getByRole('button', { name: 'Show source', exact: true }).click();
    expect(await msg.locator('.chat-math-message-source').textContent()).toBe(raw);
    await msg.getByRole('button', { name: 'Show rendered', exact: true }).click();
    const input = page.locator('textarea.chatroom-input');
    const draft = 'Prove $a^2+b^2=c^2$\n$$\\sqrt{2}$$';
    await input.fill(draft);
    const composer = page.locator('.chatroom-composer');
    await composer.getByRole('button', { name: 'Preview math', exact: true }).click();
    expect(await composer.locator('.katex').count()).toBe(2);
    await composer.getByRole('button', { name: 'Edit source', exact: true }).click();
    expect(await input.inputValue()).toBe(draft);
    await input.press('End');
    await input.pressSequentially(' + detail');
    const edited = await input.inputValue();
    await composer.getByRole('button', { name: 'Preview math', exact: true }).click();
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.waitForFunction(() => (window as any).__server.posts.length === 1);
    expect(await page.evaluate(() => (window as any).__server.posts[0].text)).toBe(edited);
    if (process.env.CHAT_MATH_SCREENSHOT) await page.screenshot({ path: process.env.CHAT_MATH_SCREENSHOT });
    await setEnabled(false);
    expect(await page.locator('.chat-math-toolbar').count()).toBe(0);
    expect(await input.isVisible()).toBe(true);
    expect(external).toEqual([]);
    expect(errors).toEqual([]);
    expect(assets).toContain('vendor/katex-0.19.0/katex.min.js');
  });

  it('keeps mobile controls usable and never requests formula resource URLs', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setEnabled(true);
    await page.waitForSelector('.chat-math-toolbar');
    const input = page.locator('textarea.chatroom-input');
    const hostile = '$\\includegraphics{https://outside.invalid/image}$';
    await input.fill(hostile);
    const composer = page.locator('.chatroom-composer');
    await composer.getByRole('button', { name: 'Preview math', exact: true }).click();
    expect(await composer.locator('.chat-math-composer-preview').textContent()).toBe(hostile);
    expect(await composer.locator('img').count()).toBe(0);
    for (const button of await composer.locator('.chat-math-button').all()) {
      const box = await button.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    }
    await setEnabled(false);
    expect(await input.inputValue()).toBe(hostile);
    expect(external).toEqual([]);
    expect(errors).toEqual([]);
  });
});
