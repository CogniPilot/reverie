/** Production approval markup, CSS and renderers with synthetic DTOs; no backend/provider success is simulated. */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright';
import { expect, it } from 'vitest';

const publicRoot = resolve(import.meta.dirname, '../src/web/public');
const read = (file: string) => readFileSync(join(publicRoot, file), 'utf8');
const index = read('index.html'),
  start = index.indexOf('  <div class="approvals-drawer" id="approvalsDrawer"'),
  end = index.indexOf('  <script defer src="owner-login-guard.js"', start);
if (start < 0 || end < start) throw new Error('Production approval drawer markup was not found');
const drawer = index.slice(start, end),
  origin = 'https://approval-layout.test';
const output = process.env.TEST_APPROVALS_SCREENSHOT_DIR;
async function fixture(page: Page) {
  const errors: string[] = [],
    blocked: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) {
      blocked.push('external:' + url.origin);
      return route.abort();
    }
    if (url.pathname === '/')
      return route.fulfill({
        contentType: 'text/html',
        body:
          '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main class="mobile-overview-row-wrap" id="stripFixture" aria-label="Synthetic mobile approval strip"></main>' +
          drawer +
          '</body></html>',
      });
    const path = resolve(publicRoot, '.' + url.pathname);
    if (path.startsWith(publicRoot + '/') && existsSync(path) && /\.(woff2?|svg|png)$/.test(path))
      return route.fulfill({ body: readFileSync(path) });
    blocked.push(url.pathname);
    return route.abort();
  });
  await page.goto(origin);
  for (const css of ['mobile-app.css', 'styles.css', 'mobile.css']) await page.addStyleTag({ content: read(css) });
  await page.addScriptTag({ content: `class ReverieApp {};window.ReverieApp=ReverieApp;` });
  for (const js of ['constants.js', 'approvals-ui.js', 'mobile-overview.js'])
    await page.addScriptTag({ content: read(js) });
  await page.addScriptTag({
    content: `
    window.__calls=[];window.__toasts=[];
    const reason='The current provider has not been verified for this approval. Delivery may be unconfirmed; keep your draft and do not replay the answer. Reopen the inbox to refresh readiness.';
    window.__items=['question','permission','idle'].map((kind,i)=>({id:'approval-'+i,sessionId:'synthetic-session-'+i,sessionName:'Synthetic employee with a long display name',kind,createdAt:Date.now()+i,answerState:'held',heldReason:reason,...(kind==='question'?{options:[{n:1,label:'Proceed once'},{n:2,label:'Cancel'}]}:{})}));
    window.app=new ReverieApp();app.approvals=new Map(__items.map(item=>[item.id,item]));app.sessions=new Map();
    app.loadAppSettingsFromStorage=()=>({approvalsInboxEnabled:true});app.showToast=(text,kind)=>__toasts.push({text,kind});app.setPendingHook=()=>{};app.clearPendingHooks=()=>{};app.selectSession=()=>{};
    app._apiJson=async(path,options)=>{__calls.push({path,method:options?.method||'GET'});if(options?.method)throw new Error('A layout fixture must never submit an answer');return {approvals:__items};};
    app.renderSessionTabs=()=>{const approval=app.approvals.get('approval-0');document.getElementById('stripFixture').replaceChildren(app._buildMobileOverviewApprovalStrip(approval,{}));};
    window.__setState=state=>{__items=__items.map(item=>({...item,answerState:state}));for(const item of __items)app._onApprovalUpdated(item);};
    document.getElementById('approvalsDrawer').classList.add('open');app.renderApprovals();
  `,
  });
  return { errors, blocked };
}

async function layout(page: Page, selector: string) {
  await page.locator(selector).evaluate(async (root) => {
    await Promise.all(root.getAnimations().map((animation) => animation.finished));
  });
  const problems = await page.locator(selector).evaluate((root) => {
    const width = document.documentElement.clientWidth,
      problems: string[] = [];
    for (const node of [root, ...root.querySelectorAll('button,input,[role="status"]')]) {
      const box = node.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      if (box.left < -0.5 || box.right > width + 0.5) problems.push('Outside viewport: ' + node.tagName);
      if (node instanceof HTMLButtonElement && node.scrollWidth > node.clientWidth + 1)
        problems.push('Clipped button: ' + node.textContent);
    }
    if (root.scrollWidth > root.clientWidth + 1) problems.push('Horizontal overflow');
    return problems;
  });
  expect(problems).toEqual([]);
}

for (const width of [320, 390, 1280])
  it(`renders truthful approval states and mobile controls at ${width}px`, async () => {
    const browser = await chromium.launch({
      headless: true,
      chromiumSandbox: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
    try {
      const page = await browser.newPage({ viewport: { width, height: 900 } }),
        state = await fixture(page);
      await page.locator('.approval-text-input').fill('Keep this draft across provider updates');
      for (const status of ['held', 'current']) {
        await page.evaluate((state) => {
          const value: unknown = Reflect.get(window, '__setState');
          if (typeof value !== 'function') throw new Error('Fixture state setter missing');
          Reflect.apply(value, window, [state]);
        }, status);
        expect(await page.locator('.approval-text-input').inputValue()).toBe('Keep this draft across provider updates');
        const buttons = page.locator('.approval-actions button');
        for (const button of await buttons.all()) expect(await button.isDisabled()).toBe(status === 'held');
        if (status === 'held')
          expect(await page.locator('.approval-held').first().textContent()).toContain('Delivery may be unconfirmed');
        await page.evaluate(
          () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))
        );
        if (output) {
          await mkdir(output, { recursive: true });
          await page
            .locator('#approvalsDrawer')
            .screenshot({ path: join(output, `inbox-${status}-${width}.png`), animations: 'disabled' });
        }
        await layout(page, '#approvalsDrawer');
        await page.locator('[aria-label="Close approvals inbox"]').click();
        await layout(page, '#stripFixture');
        const mobileButtons = page.locator('#stripFixture button');
        for (const button of await mobileButtons.all())
          if (status === 'held') {
            expect(await button.isDisabled()).toBe(true);
            await button.evaluate((node) => (node as HTMLButtonElement).click());
          } else expect(await button.isDisabled()).toBe(false);
        if (output)
          await page
            .locator('#stripFixture')
            .screenshot({ path: join(output, `strip-${status}-${width}.png`), animations: 'disabled' });
        await page.evaluate(() => {
          document.getElementById('approvalsDrawer')?.classList.add('open');
        });
      }
      expect(await page.evaluate(() => Reflect.get(window, '__calls'))).toEqual([]);
      expect(state.errors).toEqual([]);
      expect(state.blocked).toEqual([]);
    } finally {
      await browser.close();
    }
  });
