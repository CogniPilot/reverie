import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { createServer, member, room, message } from './helpers/chat-app-harness.mjs';

// The Voice control sits beside Send, and its panel stays inside the viewport with no sideways scroll: on a 320 px and a
// 393 px phone, in landscape and on a desktop, with Car mode and spoken replies reachable in one tap.
const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const read = (name: string) => readFileSync(resolve(PUBLIC, name), 'utf8');
const harness = readFileSync(resolve(import.meta.dirname, 'helpers/chat-app-harness.mjs'), 'utf8');
const appStub = harness.match(/window\.eval\(`([\s\S]*?)`\);/)![1];
const A = '00000026-002d-4000-8000-00000000003c';
const B = '00000038-0043-4000-8000-000000000060';

describe('Voice control and panel, Chromium', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
    });
  });
  afterAll(async () => { await browser?.close(); });

  async function render(width: number, height: number) {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.route('**/*', (route) => new URL(route.request().url()).pathname === '/'
      ? route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body></body></html>' })
      : route.abort());
    await page.goto('http://voice-layout.test/', { waitUntil: 'domcontentloaded' });
    for (const file of ['styles.css', 'chat-app.css']) await page.addStyleTag({ content: read(file) });
    await page.addScriptTag({
      content: `
      ${member.toString()}
      ${room.toString()}
      ${message.toString()}
      ${createServer.toString()}
      window.ReverieUrlSession = { sessionIdFromFragment: () => null };
      window.__server = createServer([room('r1', 'General', [member('${A}', 'Maple', { voice: true }), member('${B}', 'Bo')], { messages: [] })]);
      window.fetch = () => Promise.resolve({ ok: true, json: async () => ({ success: true, data: {} }) });
      ${appStub}
    `,
    });
    for (const file of ['chatroom-ui.js', 'vendor/dompurify.min.js', 'sanitize-html.js', 'chat-media.js'])
      await page.addScriptTag({ content: read(file) });
    await page.addScriptTag({ content: `window.app = new ReverieApp(); window.app.sessions.set('${A}', {id:'${A}', name:'Maple', mode:'claude'});
      const modes = new Map();
      window.app._speakRepliesMode = (id) => modes.get(id) || 'off';
      window.app._setSpeakReplies = (id, mode) => { if (mode === 'off') modes.delete(id); else modes.set(id, mode); };
      window.app.openCarMode = () => { window.carOpened = true; };` });
    await page.addScriptTag({ content: read('chat-app.js') });
    await page.waitForSelector('.ca-voice-btn');
    return page;
  }

  for (const [width, height] of [[320, 844], [393, 852], [844, 390], [1280, 844]])
    it(`keeps Voice and its panel on screen at ${width}x${height}`, async () => {
      const page = await render(width, height);
      try {
        const inside = async (selector: string) => {
          const box = (await page.locator(selector).boundingBox())!;
          expect(box, selector).not.toBeNull();
          expect(box.x).toBeGreaterThanOrEqual(-0.5);
          expect(box.y).toBeGreaterThanOrEqual(-0.5);
          expect(box.x + box.width).toBeLessThanOrEqual(width + 0.5);
          expect(box.y + box.height).toBeLessThanOrEqual(height + 0.5);
        };
        expect(await page.locator('.ca-head-speak').count()).toBe(0);
        await inside('.ca-voice-btn');
        await page.locator('.ca-voice-btn').click();
        await inside('.ca-voice-panel');
        await inside('.ca-voice-car');
        for (const label of ['Off', 'Replies to me', 'Everyone']) await inside(`[aria-label="Spoken replies: ${label}"]`);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.locator('[aria-label="Spoken replies: Everyone"]').click();
        expect(await page.locator('[aria-label="Spoken replies: Everyone"]').getAttribute('aria-pressed')).toBe('true');
        await page.locator('.ca-voice-car').click();
        expect(await page.evaluate(() => (window as any).carOpened)).toBe(true);
        expect(await page.locator('.ca-voice-panel').count()).toBe(0);
      } finally { await page.close(); }
    });
});
