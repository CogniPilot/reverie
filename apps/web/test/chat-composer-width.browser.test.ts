import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { createServer, member, room, message } from './helpers/chat-app-harness.mjs';

// The chat text box keeps a readable width however narrow the chat column gets, with the composer's tools wrapping
// below it rather than squeezing it (James 10-29: the box was one character wide beside the voice selector).
const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const read = (name: string) => readFileSync(resolve(PUBLIC, name), 'utf8');
const harness = readFileSync(resolve(import.meta.dirname, 'helpers/chat-app-harness.mjs'), 'utf8');
const appStub = harness.match(/window\.eval\(`([\s\S]*?)`\);/)![1];
const A = '00000026-002d-4000-8000-00000000003c';
const B = '00000038-0043-4000-8000-000000000060';

describe('Chat composer width, Chromium', () => {
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
    await page.goto('http://composer-width.test/', { waitUntil: 'domcontentloaded' });
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
    await page.addScriptTag({ content: `window.app = new ReverieApp(); window.app.sessions.set('${A}', {id:'${A}', name:'Maple', mode:'claude'});` });
    await page.addScriptTag({ content: read('chat-app.js') });
    await page.waitForSelector('.chatroom-input');
    return page;
  }

  // Phones, the narrow desktop window of the report (688 px with the channel list and member panel open) and wider.
  for (const [width, height] of [[320, 844], [393, 852], [560, 900], [688, 933], [768, 933], [900, 933], [1280, 844]])
    it(`keeps the text box readable and every composer tool on screen at ${width}x${height}`, async () => {
      const page = await render(width, height);
      try {
        // Also with the widest control the composer has carried: the listening-mode select of the report, beside the mic.
        await page.evaluate(() => {
          const select = document.createElement('select');
          select.className = 'chatroom-handsfree chatroom-voice-control';
          select.innerHTML = '<option>Voice: Off</option><option>Voice: Listening when spoken to</option>';
          document.querySelector('.chatroom-mic, .chatroom-composer-row')!.after(select);
        });
        const layout = await page.evaluate(() => {
          const box = document.querySelector('.chatroom-input')!;
          const input = box.getBoundingClientRect();
          const composer = document.querySelector('.chatroom-composer')!;
          // The floor the CSS promises: min-width min(100%, 12em), 100% being the composer's content width. Fonts and
          // the tools beside the box change how far above it the box lands, so the test asks for this, not a fixed width.
          const pad = getComputedStyle(composer);
          const floor = Math.min(composer.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight),
            12 * parseFloat(getComputedStyle(box).fontSize));
          const tools = [...composer.querySelectorAll('button, select')]
            .map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
          return { input: input.width, floor, inputHeight: input.height, right: Math.max(...tools.map((r) => r.right)),
            scrolls: document.documentElement.scrollWidth > window.innerWidth };
        });
        expect(layout.input, 'text box width against its CSS floor').toBeGreaterThanOrEqual(layout.floor - 0.5);
        expect(layout.input, 'text box width').toBeGreaterThanOrEqual(96); // and never a sliver, whatever the floor
        expect(layout.inputHeight, 'text box height').toBeLessThan(120); // not wrapped a letter per line
        expect(layout.right).toBeLessThanOrEqual(width + 0.5);
        expect(layout.scrolls).toBe(false);
      } finally { await page.close(); }
    });
});
