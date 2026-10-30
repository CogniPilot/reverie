/** A movie on the company drive plays in a real browser from the preview URL (James 10-26: clicking it forced a download). */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { workspaceServer } from './helpers/workspace-server.js';
import { OWNER_COOKIE } from '../src/owner-auth/policy.js';

let browser: Browser;
let fixture: Awaited<ReturnType<typeof workspaceServer>>, origin: string;
beforeAll(async () => {
  fixture = await workspaceServer(async (app) => {
    app.get('/', async (_req, reply) => reply.type('text/html').send('<!doctype html><html><body></body></html>'));
  });
  origin = await fixture.app.listen({ port: 0, host: '127.0.0.1' });
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
  });
});
afterAll(async () => {
  await browser?.close();
  await fixture?.close();
});

it('streams a real recorded WebM into a playing <video> from the workspace preview URL', async () => {
  const context = await browser.newContext();
  await context.addCookies([{ name: OWNER_COOKIE, value: fixture.ownerCookie, url: origin }]);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  try {
    await page.goto(origin);
    // Record about a second of an animated canvas, as a simulation's screen capture would be.
    const recorded: number[] = await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 160; canvas.height = 120;
      const ctx = canvas.getContext('2d')!;
      const recorder = new MediaRecorder(canvas.captureStream(25), { mimeType: 'video/webm' });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => chunks.push(event.data);
      const done = new Promise((resolve) => (recorder.onstop = resolve));
      recorder.start(100);
      for (let frame = 0; frame < 30; frame++) {
        ctx.fillStyle = `hsl(${frame * 12} 80% 50%)`; ctx.fillRect(0, 0, 160, 120);
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      recorder.stop(); await done;
      return [...new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer())];
    });
    expect(recorded.length).toBeGreaterThan(1000);
    await writeFile(join(fixture.root, 'flight run λ.webm'), Buffer.from(recorded));
    await writeFile(join(fixture.root, 'trap.webm'), '<html><script>window.ran = true</script>');
    const play = (name: string) =>
      page.evaluate(async (src) => {
        const video = document.createElement('video');
        video.muted = true; video.playsInline = true; video.preload = 'auto';
        document.body.append(video);
        const outcome = await new Promise<string>((resolve) => {
          video.onerror = () => resolve('error');
          video.onloadeddata = () => resolve('loaded');
          video.src = src;
        });
        if (outcome !== 'loaded') return { outcome };
        await video.play();
        await new Promise((resolve) => setTimeout(resolve, 300));
        return { outcome, width: video.videoWidth, height: video.videoHeight, advanced: video.currentTime > 0 };
      }, `/api/workspace/file?path=${encodeURIComponent(name)}&preview=1`);
    expect(await play('flight run λ.webm')).toEqual({ outcome: 'loaded', width: 160, height: 120, advanced: true });
    expect(await play('trap.webm')).toEqual({ outcome: 'error' });
    expect(await page.evaluate(() => (window as unknown as { ran?: boolean }).ran)).toBeUndefined();
  } finally {
    await context.close();
  }
});
