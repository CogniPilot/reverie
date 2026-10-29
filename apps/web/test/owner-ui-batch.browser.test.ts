import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { chromium, type Page } from 'playwright';
import { createServer, member, room, message } from './helpers/chat-app-harness.mjs';

// Real-browser checks for the owner UI batch (James 10-27..10-29): the composer box keeps a readable width beside the
// voice selector, the gear panel is one top rule with Workspace in it, and an MP4 attachment is an inline player.
const pub = resolve(import.meta.dirname, '../src/web/public');
const read = (n: string) => readFileSync(resolve(pub, n), 'utf8');
const shots = process.env.REVERIE_SCREENSHOT_DIR;
if (shots) mkdirSync(shots, { recursive: true });

async function open(page: Page) {
  const harness = readFileSync(resolve(import.meta.dirname, 'helpers/chat-app-harness.mjs'), 'utf8');
  const stub = harness.match(/window\.eval\(`([\s\S]*?)`\);/)![1];
  await page.route('**/*', (route) =>
    route.fulfill({
      contentType: route.request().resourceType() === 'script' ? 'application/javascript' : 'text/html',
      body:
        route.request().resourceType() === 'script'
          ? ''
          : '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body></body></html>',
    })
  );
  await page.goto('https://owned-ui-batch.test/');
  for (const n of ['styles.css', 'chat-app.css']) await page.addStyleTag({ content: read(n) });
  await page.addScriptTag({
    content: `${member.toString()} ${room.toString()} ${message.toString()} ${createServer.toString()}
 window.ReverieUrlSession={sessionIdFromFragment:()=>null};
 const general=room('general','General',[member('a','Sam')]);
 general.messages=[message('m1','general',{kind:'agent',sessionId:'a',name:'Sam'},'lap video',Date.now(),{attachments:[{id:'clip',name:'lap.mp4',type:'video/mp4',size:10}]})];
 window.__server=createServer([general]);window.__server.company={canManage:true,settings:{ownerName:'Owner'},employees:[]};
 const prior=window.__server.handle;window.__server.handle=async(path,options={})=>{const ok=data=>({ok:true,status:200,json:async()=>({success:true,data})});if(path.startsWith('/api/embassy'))return ok({connections:[]});if(path==='/api/chatrooms/phone-status')return ok({self:'owner',canSetOwn:true});if(path==='/api/system/stats')return ok({cpu:4,memory:{percent:26},disks:{available:true,filesystems:[{labels:['fixture'],totalBytes:100,availableBytes:10}]}});if(path==='/api/system/gpu')return ok({available:true,utilization:22});return prior(path,options);};
 window.fetch=async()=>({ok:true,json:async()=>({avatars:[]})});${stub}`,
  });
  for (const n of ['chatroom-ui.js', 'chat-media.js']) await page.addScriptTag({ content: read(n) });
  await page.addScriptTag({ content: 'window.app=new ReverieApp();' });
  await page.addScriptTag({ content: read('chat-app.js') });
  await page.waitForSelector('.ca-office-gear', { state: 'attached' });
  await page.evaluate(() => (window as any).reverieChat.stopStats?.());
}

for (const width of [360, 700, 1280]) {
  it(`keeps the chat box readable beside the voice selector at ${width}px`, async () => {
    const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
    try {
      const page = await browser.newPage({ viewport: { width, height: 800 } });
      await open(page);
      await page.waitForSelector('.chatroom-composer .chatroom-input');
      const g = await page.evaluate(() => {
        // The hands-free selector as hands-free.js builds it, with its longest label.
        const row = document.querySelector('.chatroom-composer-row')!;
        const select = document.createElement('select');
        select.className = 'chatroom-handsfree';
        for (const label of ['Voice: Off', 'Hands-free in panel', 'Browser dictation']) select.append(new Option(label));
        row.append(select);
        const input = document.querySelector('.chatroom-composer .chatroom-input') as HTMLTextAreaElement;
        input.value = 'Also, for .png files, the file viewer says preview unavailable';
        const r = input.getBoundingClientRect();
        const composer = document.querySelector('.chatroom-composer')!.getBoundingClientRect();
        return { input: r.width, composer: composer.width, em: parseFloat(getComputedStyle(input).fontSize), scroll: document.documentElement.scrollWidth, vw: innerWidth };
      });
      if (shots) await page.locator('.chatroom-composer').screenshot({ path: `${shots}/composer-${width}.png` });
      expect(g.input).toBeGreaterThanOrEqual(Math.min(g.composer - 24, 12 * g.em) - 1);
      expect(g.scroll).toBe(g.vw);
    } finally {
      await browser.close();
    }
  });
}

it('opens the gear panel as one top rule with Company, Board and Workspace', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await open(page);
    await page.locator('.ca-office-gear').click();
    await page.waitForSelector('.ca-office-pane:not([hidden])');
    const pane = await page.evaluate(() => {
      const el = document.querySelector('.ca-root > .ca-office-pane') as HTMLElement;
      const s = getComputedStyle(el);
      return {
        top: s.borderTopWidth, left: s.borderLeftWidth, right: s.borderRightWidth, radius: s.borderTopLeftRadius, shadow: s.boxShadow,
        labels: [...el.querySelectorAll('button')].map((b) => b.textContent),
      };
    });
    if (shots) await page.screenshot({ path: `${shots}/gear-panel.png`, clip: { x: 0, y: 600, width: 400, height: 300 } });
    expect(pane).toEqual({ top: '1px', left: '0px', right: '0px', radius: '0px', shadow: 'none', labels: ['Company', 'Board', 'Workspace'] });
  } finally {
    await browser.close();
  }
});

it('shows an MP4 attachment as an inline player, and falls back to the card when it is not a playable video', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
  try {
    // Player: the file request stays open (as a real video loads), so nothing errors.
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await open(page);
    await page.route('**/api/chatrooms/general/files/clip', () => {});
    await (page.evaluate(() => (window as any).reverieChat.renderFeed?.() ?? (window as any).reverieChat.selectRoom('general')));
    const video = await page.waitForSelector('video.chatroom-video', { state: 'attached', timeout: 5000 }).then(() =>
      page.evaluate(() => {
        const v = document.querySelector('video.chatroom-video') as HTMLVideoElement;
        return { controls: v.controls, preload: v.preload, src: v.getAttribute('src'), label: v.getAttribute('aria-label') };
      })
    );
    expect(video.controls).toBe(true);
    expect(video.preload).toBe('metadata');
    expect(video.src).toContain('/api/chatrooms/general/files/clip');
    expect(video.label).toBe('lap.mp4');
    // Fallback: the fixture server answers with HTML, which the browser cannot play, so the download card replaces it.
    const fallback = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await open(fallback);
    await fallback.waitForSelector('a.chatroom-file', { timeout: 5000 });
    expect(await fallback.locator('video.chatroom-video').count()).toBe(0);
    expect(await fallback.locator('a.chatroom-file .chatroom-file-name').textContent()).toBe('lap.mp4');
  } finally {
    await browser.close();
  }
});
