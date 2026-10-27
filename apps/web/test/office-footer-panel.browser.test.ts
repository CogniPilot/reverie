import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { chromium } from 'playwright';
import { createServer, member, room, message } from './helpers/chat-app-harness.mjs';
for (const config of [
  { label: 'desktop', width: 1280, height: 900, touch: false, reduced: false },
  { label: 'phone', width: 320, height: 740, touch: true, reduced: false },
  { label: 'reduced-motion', width: 1120, height: 760, touch: false, reduced: true },
]) {
  it(`joins the pull-up panel to the fixed meters with usable input (${config.label})`, async () => {
    const pub = resolve(import.meta.dirname, '../src/web/public');
    const read = (n: string) => readFileSync(resolve(pub, n), 'utf8');
    const harness = readFileSync(resolve(import.meta.dirname, 'helpers/chat-app-harness.mjs'), 'utf8');
    const stub = harness.match(/window\.eval\(`([\s\S]*?)`\);/)![1];
    const browser = await chromium.launch({
      headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    });
    try {
      const page = await browser.newPage({
        viewport: { width: config.width, height: config.height },
        hasTouch: config.touch,
        isMobile: config.touch,
        reducedMotion: config.reduced ? 'reduce' : 'no-preference',
      });
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.route('**/*', (route) =>
        route.fulfill({
          contentType: route.request().resourceType() === 'script' ? 'application/javascript' : 'text/html',
          body:
            route.request().resourceType() === 'script'
              ? ''
              : '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body></body></html>',
        })
      );
      await page.goto('https://owned-footer.test/');
      for (const n of ['styles.css', 'chat-app.css']) await page.addStyleTag({ content: read(n) });
      await page.addScriptTag({
        content: `${member.toString()} ${room.toString()} ${message.toString()} ${createServer.toString()}
 const user={kind:'user',name:'Owner'};window.ReverieUrlSession={sessionIdFromFragment:()=>null};window.__server=createServer([room('general','General',[])]);window.__server.company={canManage:true,settings:{ownerName:'Owner'},employees:[]};const prior=window.__server.handle;window.__server.handle=async(path,options={})=>{const ok=data=>({ok:true,status:200,json:async()=>({success:true,data})});if(path.startsWith('/api/embassy'))return ok({connections:[]});if(path==='/api/chatrooms/phone-status')return ok({self:'owner',canSetOwn:true});if(path==='/api/system/stats')return ok({cpu:4,memory:{percent:26},disks:{available:true,filesystems:[{labels:['fixture'],totalBytes:100,availableBytes:10}]}});if(path==='/api/system/gpu')return ok({available:true,utilization:22});return prior(path,options);};window.fetch=async()=>({ok:true,json:async()=>({avatars:[]})});${stub}`,
      });
      for (const n of ['chatroom-ui.js', 'chat-media.js']) await page.addScriptTag({ content: read(n) });
      await page.addScriptTag({ content: 'window.app=new ReverieApp();' });
      await page.addScriptTag({ content: read('chat-app.js') });
      await page.waitForSelector('.ca-office-gear', { state: 'attached' });
      await page.waitForFunction(() => document.querySelectorAll('.ca-machine-bar .ca-stat').length === 4);
      await page.evaluate(() => {
        (window as any).reverieChat.stopStats();
        if (innerWidth < 768) (window as any).reverieChat.toggleDrawer('channels');
      });
      await page.waitForTimeout(220);
      const geometry = () =>
        page.evaluate(() => {
          const box = (s: string) => {
            const r = document.querySelector(s)!.getBoundingClientRect();
            return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
          };
          return {
            meter: box('.ca-machine-bar'),
            profile: box('.ca-user'),
            gear: box('.ca-office-gear'),
            pane: box('.ca-office-pane'),
            animation: getComputedStyle(document.querySelector('.ca-office-pane')!).animationName,
            viewportWidth: innerWidth,
            scrollWidth: document.documentElement.scrollWidth,
          };
        });
      const before = await geometry();
      if (config.touch) await page.locator('.ca-office-gear').tap();
      else await page.locator('.ca-office-gear').click();
      for (let i = 0; i < 3; i++) {
        expect(
          await page.evaluate(() => {
            const r = document.querySelector('.ca-machine-bar .ca-stat')!.getBoundingClientRect();
            return !!document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('.ca-machine-bar');
          })
        ).toBe(true);
        await page.waitForTimeout(35);
      }
      await page.waitForTimeout(150);
      const opened = await geometry();
      const assertJoined = (g: Awaited<ReturnType<typeof geometry>>) => {
        expect(g.pane.left).toBeCloseTo(g.meter.left, 1);
        expect(g.pane.right).toBeCloseTo(g.meter.right, 1);
        expect(g.pane.bottom).toBeCloseTo(g.meter.top, 1);
        expect(g.gear.top + g.gear.height / 2).toBeCloseTo(g.meter.top + g.meter.height / 2, 1);
        expect(g.gear.right).toBeLessThanOrEqual(g.meter.left);
        expect(g.pane.top).toBeGreaterThanOrEqual(0);
        expect(g.scrollWidth).toBe(g.viewportWidth);
      };
      assertJoined(opened);
      expect(opened.meter).toEqual(before.meter);
      expect(opened.profile).toEqual(before.profile);
      if (config.reduced) expect(opened.animation).toBe('none');
      await page.locator('.ca-office-pane button').nth(1).focus();
      await page.setViewportSize({
        width: config.touch ? 360 : config.width - 80,
        height: config.touch ? 640 : config.height - 80,
      });
      await page.waitForTimeout(200);
      const resized = await geometry();
      assertJoined(resized);
      expect(
        await page
          .locator('.ca-office-pane button')
          .nth(1)
          .evaluate((b) => b === document.activeElement)
      ).toBe(true);
      if (config.touch) {
        await page.evaluate(() => (window as any).reverieChat.toggleDrawer(null));
        await page.waitForTimeout(220);
        await page.setViewportSize({ width: 320, height: 568 });
        await page.waitForTimeout(100);
        await page.evaluate(() => (window as any).reverieChat.toggleDrawer('channels'));
        await page.waitForTimeout(220);
        assertJoined(await geometry());
        await page.locator('.ca-office-pane button').nth(1).focus();
      }
      await page.evaluate(() => {
        const g = document.querySelector('.ca-rail-group') as HTMLElement;
        if (g) g.style.minHeight = '1800px';
        const rail = document.querySelector('.ca-rail')!;
        rail.scrollTop = 100;
      });
      await page.waitForTimeout(120);
      assertJoined(await geometry());
      await page.keyboard.press('Escape');
      expect(await page.locator('.ca-office-gear').getAttribute('aria-expanded')).toBe('false');
      expect(await page.locator('.ca-office-gear').evaluate((b) => b === document.activeElement)).toBe(true);
      expect(await page.locator('.ca-office-pane').isVisible()).toBe(false);
      if (config.touch) await page.locator('.ca-office-gear').tap();
      else await page.keyboard.press('Enter');
      await page.waitForTimeout(200);
      assertJoined(await geometry());
      expect(errors).toEqual([]);
      if (process.env.FOOTER_PANEL_SCREENSHOTS) {
        mkdirSync(process.env.FOOTER_PANEL_SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: resolve(process.env.FOOTER_PANEL_SCREENSHOTS, config.label + '.png') });
        writeFileSync(
          resolve(process.env.FOOTER_PANEL_SCREENSHOTS, config.label + '.json'),
          JSON.stringify({ before, opened, resized, errors }, null, 2)
        );
      }
    } finally {
      await browser.close();
    }
  }, 30000);
}
