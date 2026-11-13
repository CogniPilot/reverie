import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { workspaceServer } from './helpers/workspace-server.js';
import { OWNER_COOKIE } from '../src/owner-auth/policy.js';
import { createServer, member, room, message } from './helpers/chat-app-harness.mjs';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
const read = (name: string) => readFileSync(resolve(publicDir, name), 'utf8');
const harness = readFileSync(resolve(import.meta.dirname, 'helpers/chat-app-harness.mjs'), 'utf8');
const appStub = harness.match(/window\.eval\(`([\s\S]*?)`\);/)![1];
// Only the chat shell's company/phone identity is synthetic. The owner cookie
// and all Workspace authentication, file routes and filesystem effects are real.
const shellOwnerFixture = `
  window.__server.company = { employees: [], settings: { ownerName: 'Workspace fixture owner' }, canManage: true };
  window.__server.navigationOwnerAllowed = true;
  const shellHandle = window.__server.handle;
  window.__server.handle = (path, opts = {}) => {
    if (path === '/api/chatrooms/phone-status' && (!opts.method || opts.method === 'GET')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({
        success: true, data: { self: 'owner', canSetOwn: window.__server.navigationOwnerAllowed }
      }) });
    }
    return shellHandle(path, opts);
  };
`;
let browser: Browser;
let fixture: Awaited<ReturnType<typeof workspaceServer>>, origin: string;
beforeAll(async () => {
  fixture = await workspaceServer(async (app) => {
    app.get('/', async (_req, reply) =>
      reply
        .type('text/html')
        .send(
          '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body></body></html>'
        )
    );
  });
  origin = await fixture.app.listen({ port: 0, host: '127.0.0.1' });
  const archive = Buffer.alloc(25 * 1024 * 1024);
  for (let i = 0; i < archive.length; i++) archive[i] = i % 251;
  await writeFile(join(fixture.root, 'archive λ with spaces.zip'), archive);
  const sample = join(fixture.root, 'handoffs', '2026-10-23', 'brooke');
  await mkdir(sample, { recursive: true });
  for (let i = 1; i <= 47; i++) await mkdir(join(sample, `project-review-${String(i).padStart(2, '0')}`));
  await writeFile(
    join(sample, 'README.md'),
    '# Project notes\n\nShared files for review.\n\n- Research results\n- Design documents\n- Release notes\n'
  );
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {}),
  });
});
afterAll(async () => {
  await browser?.close();
  await fixture?.close();
});

for (const viewportWidth of [1905, 390, 320])
  it(`uses real authenticated browse/preview/download/upload at ${viewportWidth}px and retains the draft`, async () => {
    const phone = viewportWidth < 650;
    const context = await browser.newContext({
      viewport: { width: viewportWidth, height: phone ? 844 : 973 },
      hasTouch: phone,
      isMobile: phone,
      acceptDownloads: true,
    });
    await context.addCookies([{ name: OWNER_COOKIE, value: fixture.ownerCookie, url: origin }]);
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await page.goto(origin);
      for (const name of ['styles.css', 'chat-app.css']) await page.addStyleTag({ content: read(name) });
      await page.addScriptTag({
        content: `${member.toString()} ${room.toString()} ${message.toString()} ${createServer.toString()}\nwindow.ReverieUrlSession = { sessionIdFromFragment: () => null }; window.__server = createServer([room('r1','General',[],{ messages: [] })]); ${shellOwnerFixture} ${appStub}`,
      });
      for (const name of ['chatroom-ui.js', 'chat-media.js']) await page.addScriptTag({ content: read(name) });
      await page.addScriptTag({ content: 'window.app = new ReverieApp();' });
      await page.addScriptTag({ content: read('chat-app.js') });
      await page.locator('.ca-root').waitFor();
      const composer = page.locator('.chatroom-input');
      await composer.fill('Keep this unsent draft λ');
      // Exercise the actual footer launcher on both layouts (the phone also uses its drawer).
      if (phone) await page.getByRole('button', { name: 'Open channels', exact: true }).click();
      const office = page.getByRole('button', { name: 'Office settings', exact: true });
      if (phone) expect((await office.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      expect(await office.getAttribute('aria-expanded')).toBe('false');
      await office.click();
      expect(await office.getAttribute('aria-expanded')).toBe('true');
      await page.getByRole('button', { name: 'Workspace', exact: true }).waitFor();
      await office.press('Enter');
      expect(await office.getAttribute('aria-expanded')).toBe('false');
      expect(await page.getByRole('button', { name: 'Workspace', exact: true }).isVisible()).toBe(false);
      await page.evaluate('window.__server.navigationOwnerAllowed = false');
      await office.press('Enter');
      await page.getByRole('button', { name: 'Terminal settings', exact: true }).waitFor();
      expect(await page.getByRole('button', { name: 'Workspace', exact: true }).count()).toBe(0);
      await office.press('Enter');
      await page.evaluate('window.__server.navigationOwnerAllowed = true');
      await office.press('Enter');
      expect(await office.getAttribute('aria-expanded')).toBe('true');
      await page.getByRole('button', { name: 'Workspace', exact: true }).click();
      const frame = page.frameLocator('iframe[title="Workspace"]');
      await frame.getByRole('button', { name: 'Workspace', exact: true }).waitFor();
      expect(await frame.locator('.page-title').isVisible()).toBe(false);
      expect(await frame.locator('#preview').isVisible()).toBe(false);
      await frame.getByRole('searchbox', { name: 'Search this folder' }).fill('Projects');
      expect(await frame.locator('#files button').count()).toBe(1);
      await frame.getByRole('searchbox', { name: 'Search this folder' }).fill('');
      await frame.getByRole('button', { name: /Projects Folder/ }).click();
      await frame.getByRole('button', { name: /hello λ.txt/ }).waitFor();
      const directPending = page.waitForEvent('download');
      await frame.getByRole('link', { name: 'Download hello λ.txt', exact: true }).click();
      const direct = await directPending;
      expect(direct.suggestedFilename()).toBe('hello λ.txt');
      expect(await readFile((await direct.path())!)).toEqual(
        await readFile(join(fixture.root, 'Projects', 'hello λ.txt'))
      );
      expect(await frame.locator('#upload').isDisabled()).toBe(true);
      expect(await frame.locator('#uploadReason').textContent()).toContain('root only');
      await frame.getByRole('button', { name: /hello λ.txt/ }).click();
      await frame.locator('pre').waitFor();
      expect(await frame.locator('pre').textContent()).toContain('<img');
      expect(await frame.locator('#preview img').count()).toBe(0);
      expect(await frame.locator('#files button[aria-pressed="true"]').count()).toBe(1);
      await frame.getByRole('button', { name: 'Close preview', exact: true }).click();
      expect(await frame.locator('#preview').isVisible()).toBe(false);
      await frame.getByRole('button', { name: 'Workspace', exact: true }).click();
      await frame.getByRole('button', { name: /picture.png/ }).click();
      await frame.locator('#preview img').waitFor();
      await page.waitForFunction(() => {
        const doc = document.querySelector<HTMLIFrameElement>('iframe[title="Workspace"]')?.contentDocument;
        return !!doc?.querySelector<HTMLImageElement>('#preview img')?.naturalWidth;
      });
      await frame.getByRole('button', { name: /archive λ with spaces.zip/ }).click();
      const pending = page.waitForEvent('download');
      await frame.getByRole('link', { name: 'Download file', exact: true }).click();
      const download = await pending;
      expect(download.suggestedFilename()).toBe('archive λ with spaces.zip');
      expect(
        (await readFile((await download.path())!)).equals(
          await readFile(join(fixture.root, 'archive λ with spaces.zip'))
        )
      ).toBe(true);
      const name = `${phone ? 'phone-' + viewportWidth : 'desktop'} upload λ.txt`,
        bytes = Buffer.from('Exact uploaded λ\r\n<script>never()</script>\0');
      await frame.locator('#upload').setInputFiles({ name, mimeType: 'text/plain', buffer: bytes });
      await frame
        .getByRole('status')
        .filter({ hasText: `Uploaded ${name}.` })
        .waitFor();
      expect(await readFile(join(fixture.root, name))).toEqual(bytes);
      await frame.locator('#upload').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from('replace') });
      await frame.getByRole('status').filter({ hasText: 'already exists' }).waitFor();
      expect(await readFile(join(fixture.root, name))).toEqual(bytes);
      await frame.getByRole('button', { name: /Empty Folder/ }).click();
      await frame.locator('#empty-state').filter({ hasText: 'no visible files' }).waitFor();
      await frame.getByRole('button', { name: 'Up a folder' }).click();
      await frame.getByRole('button', { name: /Projects Folder/ }).waitFor();
      const width = await frame.locator('body').evaluate((el) => ({ scroll: el.scrollWidth, inner: innerWidth }));
      expect(width.scroll).toBeLessThanOrEqual(width.inner);
      if (process.env.WORKSPACE_SCREENSHOT_DIR) {
        for (const name of ['handoffs', '2026-10-23', 'brooke'])
          await frame.getByRole('button', { name: `${name} Folder`, exact: true }).click();
        await frame.getByRole('status').filter({ hasText: '48 items' }).waitFor();
        if (!phone) await page.getByRole('button', { name: 'Office settings', exact: true }).click();
        expect(await frame.locator('#preview').isVisible()).toBe(false);
        const deepWidth = await frame.locator('body').evaluate((el) => ({ scroll: el.scrollWidth, inner: innerWidth }));
        expect(deepWidth.scroll).toBeLessThanOrEqual(deepWidth.inner);
        expect(
          await frame
            .locator('#breadcrumbs button')
            .evaluateAll((buttons) => buttons.every((button) => button.scrollWidth <= button.clientWidth))
        ).toBe(true);
        await page.screenshot({
          path: join(
            process.env.WORKSPACE_SCREENSHOT_DIR,
            `workspace-${phone ? (viewportWidth === 320 ? 'phone-320' : 'phone') : 'desktop'}.png`
          ),
        });
        await frame.getByRole('searchbox', { name: 'Search this folder' }).fill('README');
        await frame.getByRole('button', { name: 'README.md', exact: true }).click();
        await frame.locator('pre').waitFor();
        if (phone) {
          expect(
            await frame.locator('#up').evaluate((button) => button.getBoundingClientRect().top)
          ).toBeGreaterThanOrEqual(0);
          const targets = await frame
            .locator(
              '#up, #refresh, .upload, #sort, .row-download, #preview button, #preview a, footer a, .help summary'
            )
            .evaluateAll((nodes) =>
              nodes
                .filter((node) => node.getClientRects().length > 0)
                .map((node) => ({
                  label: node.getAttribute('aria-label') || node.textContent,
                  width: node.getBoundingClientRect().width,
                  height: node.getBoundingClientRect().height,
                }))
            );
          for (const target of targets) {
            expect(target.width, target.label || '').toBeGreaterThanOrEqual(44);
            expect(target.height, target.label || '').toBeGreaterThanOrEqual(44);
          }
        }
        await page.screenshot({
          path: join(
            process.env.WORKSPACE_SCREENSHOT_DIR,
            `workspace-${phone ? (viewportWidth === 320 ? 'phone-320' : 'phone') : 'desktop'}-preview.png`
          ),
        });
      }
      // Embedded tools return through the shell's Company/tools adapter, then
      // its real Back to chat action restores the unsent conversation draft.
      await frame.getByRole('link', { name: 'Back to Company / tools', exact: true }).click();
      await page.getByRole('menu', { name: 'Company tools', exact: true }).waitFor();
      await page.keyboard.press('Escape');
      await page.locator('.ca-company').getByRole('button', { name: 'Back to chat', exact: true }).click();
      await composer.waitFor({ state: 'visible' });
      expect(await composer.inputValue()).toBe('Keep this unsent draft λ');
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

for (const width of [1280, 390])
  it(`opens a named chat file link in the authenticated Drive folder at ${width}px`, async () => {
    const context = await browser.newContext({ viewport:{width,height:844} });
    await context.addCookies([{name:OWNER_COOKIE,value:fixture.ownerCookie,url:origin}]);
    const page=await context.newPage();page.setDefaultTimeout(8000);
    const requests:string[]=[];page.on('request',request=>requests.push(new URL(request.url()).pathname));
    const absolute=join(fixture.root,'Projects','hello λ.txt');
    const text=`Read [API fixture source review](<${absolute}>) and [CI run](https://example.com/run).`;
    try {
      await page.goto(origin);
      for(const name of ['styles.css','chat-app.css']) await page.addStyleTag({content:read(name)});
      await page.addScriptTag({content:`
        ${member.toString()} ${room.toString()} ${message.toString()} ${createServer.toString()}
        const user={kind:'user',name:'Owner'};
        window.ReverieBase={url:path=>path};
        window.ReverieUrlSession={sessionIdFromFragment:()=>null};
        window.__server=createServer([room('r1','General',[],{messages:[message('linked','r1',user,${JSON.stringify(text)},1000)]})]);
        ${appStub}
      `});
      for(const name of ['chatroom-ui.js','chat-media.js','panels-ui.js']) await page.addScriptTag({content:read(name)});
      await page.addScriptTag({content:'window.app=new ReverieApp();app.activeSessionId="unrelated-fixture-session";'});
      await page.addScriptTag({content:read('chat-app.js')});
      const composer=page.locator('.chatroom-input');await composer.fill('Unsent draft stays here');
      const link=page.getByRole('link',{name:'API fixture source review',exact:true});
      expect(await link.textContent()).toBe('API fixture source review');
      expect(await page.getByRole('link',{name:'CI run',exact:true}).getAttribute('href')).toBe('https://example.com/run');
      await link.click();
      const frame=page.frameLocator('iframe[title="Workspace"]');
      await frame.locator('#files button[aria-pressed="true"]').waitFor();
      expect(await frame.locator('#files button[aria-pressed="true"]').getAttribute('data-path')).toBe('Projects/hello λ.txt');
      expect(await frame.locator('#breadcrumbs').textContent()).toContain('Projects');
      await frame.locator('#preview pre').waitFor();
      expect(await frame.locator('#preview pre').textContent()).toContain('Hello λ');
      expect(requests.some(path=>path.startsWith('/api/sessions/'))).toBe(false);
      expect(requests).toContain('/api/workspace/resolve');
      if(process.env.WORKSPACE_SCREENSHOT_DIR)
        await page.screenshot({path:join(process.env.WORKSPACE_SCREENSHOT_DIR,`chat-drive-link-${width}.png`)});
      await page.goBack();
      await composer.waitFor({state:'visible'});expect(await composer.inputValue()).toBe('Unsent draft stays here');
      // The copied/native link also resolves through fresh owner authorization on the Drive page.
      await page.goto(origin+'/workspace?'+new URLSearchParams({file:absolute}));
      await page.locator('#files button[aria-pressed="true"]').waitFor();
      expect(await page.locator('#files button[aria-pressed="true"]').getAttribute('data-path')).toBe('Projects/hello λ.txt');
    } finally {await context.close();}
  });
