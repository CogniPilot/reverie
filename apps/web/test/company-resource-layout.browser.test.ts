/** Production markup/CSS with closed synthetic APIs; never connects to an office. */
import { readFileSync, existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { expect, it } from 'vitest';
import { chromium, type Page } from 'playwright';
import { JSDOM } from 'jsdom';
import { createServer, member, room, message } from './helpers/chat-app-harness.mjs';
import { EmployeeMemoryDiagnostics, memoryPressureAdvisory } from '../src/resource-employee-data.js';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
const read = (name: string) => readFileSync(resolve(publicDir, name), 'utf8');
const harness = readFileSync(resolve(import.meta.dirname, 'helpers/chat-app-harness.mjs'), 'utf8');
const appStub = harness.match(/window\.eval\(`([\s\S]*?)`\);/)![1];
const employeeId = '11111111-2222-4333-8444-555555555555';
const sessionId = '33333333-4444-4555-8666-777777777777';

async function fixture(
  page: Page,
  options: {
    name?: string;
    resourceUnavailable?: boolean;
    retainedHiring?: boolean;
    pressure?: 'high' | 'stale';
    viewerObservation?: boolean;
    viewerReason?: 'native-health-unavailable' | 'backoff';
  } = {}
) {
  // Keep the shipped document structure, but bootstrap only the conversation
  // shell fixture. Every request stays inside this intercepted synthetic origin.
  const document = new JSDOM(read('index.html'));
  document.window.document.querySelectorAll('script,link').forEach((element) => element.remove());
  const html = document.serialize();
  document.window.close();
  // Canonical application projection in the test's server realm. The kernel
  // sample is synthetic; this is layout/consumer proof, not native acceptance.
  await page.exposeFunction('__projectSyntheticMemoryAdvisory', (value: unknown) =>
    memoryPressureAdvisory(EmployeeMemoryDiagnostics.parse(value), Date.now())
  );
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== 'https://settings-fixture.test') return route.abort();
    const file = resolve(publicDir, '.' + url.pathname);
    if (url.pathname !== '/' && file.startsWith(publicDir + '/') && existsSync(file) && /\.(js|css)$/.test(file))
      return route.fulfill({
        contentType: file.endsWith('.js') ? 'text/javascript' : 'text/css',
        body: readFileSync(file, 'utf8'),
      });
    return route.fulfill({ contentType: 'text/html', body: html });
  });
  await page.goto('https://settings-fixture.test/');
  for (const name of ['styles.css', 'chat-app.css']) await page.addStyleTag({ content: read(name) });
  await page.addScriptTag({
    content: `
    ${member.toString()} ${room.toString()} ${message.toString()} ${createServer.toString()}
    const user={kind:'user',name:'Fixture owner'};
    window.ReverieUrlSession={sessionIdFromFragment:()=>null};
    window.__server=createServer([room('general','General',[])]);
    window.__writes=[]; window.__resourceReads=0; window.__pressureMode=${JSON.stringify(options.pressure ?? '')};
    window.__viewerObservation='unconfirmed'; window.__viewerReason=${JSON.stringify(options.viewerReason ?? null)};
    window.__viewerRetryAfterMs=window.__viewerReason?5000:0;
    const employee={id:${JSON.stringify(employeeId)},sessionId:${JSON.stringify(sessionId)},sessionGeneration:2,
      name:${JSON.stringify(options.name ?? 'River')},position:'Compiler engineer',expertise:['Systems'],responsibilities:[],permissions:{},
      desiredRunning:${!options.pressure},onVacation:${!!options.pressure},runtimeHealth:'unknown',runtimeHealthScope:'terminal',
      workerViewerReconnect:${options.viewerObservation === true},
      effectiveBoardPermissions:{editBoardIssues:true,manageBoard:false,manageDecisions:false},
      boardPermissionSources:{editBoardIssues:'explicit',manageBoard:'explicit',manageDecisions:'explicit'}};
    const policy={memoryHighMiB:16384,memoryMaxMiB:49152,cpuWeight:100,perfEnabled:true};
    const image='sha256:'+'a'.repeat(64);
    const fleet={version:1,revision:'layout-revision',canPreview:true,blockers:[],images:[{id:image,label:'Verified worker image'}],
      pool:{desired:{memoryHighMiB:null,memoryMaxMiB:49152,cpuWeight:100,allowedCpus:[0,1,2,3]},observed:null},
      employees:[{employeeId:employee.id,name:employee.name,state:'running',reason:null,desired:policy,
        observed:{...policy,memoryHighMiB:8192},desiredImageId:image,observedImageId:image},
        {employeeId:'22222222-3333-4444-8555-666666666666',name:'Unverified employee',state:'unverified',
        reason:'Native observation unavailable',desired:policy,observed:null,desiredImageId:image,observedImageId:null}],
      operations:[],unmanagedLaptops:[]};
    window.__server.company={canManage:true,resourceReplacement:true,employees:[employee],settings:{ownerName:'Fixture owner',autoWakeEnabled:false}};
    const original=window.__server.handle;
    window.__server.handle=async(path,opts={})=>{
      const ok=data=>({ok:true,status:200,json:async()=>({success:true,data})});
      if(opts.method && opts.method!=='GET' && path!=='/api/company/resources/operations')window.__writes.push({path,method:opts.method,body:opts.body});
      if(path==='/api/chatrooms/phone-status')return ok({self:'owner',canSetOwn:true});
      if(path==='/api/owner/status')return ok({configured:true,signedIn:true,identity:{id:'owner',role:'owner'}});
      if(path==='/api/company/resources/fleet')return ok(fleet);
      if(path==='/api/company/resources/operations')return ok([]);
      if(path==='/api/company/employees/'+employee.id+'/reconnect/status' && ${options.viewerObservation === true}) {
        if(window.__holdViewerStatus)await new Promise(resolve=>{window.__finishViewerStatus=resolve;});
        return ok({reconnect:{state:window.__viewerReason||window.__viewerObservation==='unconfirmed'?'blocked':'idle',
          reason:window.__viewerReason||(window.__viewerObservation==='unconfirmed'?'pane-observation-unconfirmed':'viewer-not-disconnected'),
          observation:window.__viewerObservation==='unconfirmed'?'pane-observation-unconfirmed':'outer-pane-responsive',attempts:0,retryAfterMs:window.__viewerRetryAfterMs}});
      }
      if(path==='/api/company/resources/employees/'+employee.id+'/memory-diagnostics' && ${JSON.stringify(options.resourceUnavailable === true)})
        return {ok:false,status:503,json:async()=>({success:false,error:'Native resource observations are unavailable. Refresh resource status to check again.'})};
      if(path==='/api/company/resources/employees/'+employee.id+'/memory-diagnostics') {
        window.__resourceReads++;
        const resources={version:1,employeeId:employee.id,sessionId:employee.sessionId,
          revision:'a'.repeat(64),state:'running',requested:{memoryHighMiB:policy.memoryHighMiB,memoryMaxMiB:policy.memoryMaxMiB,
            cpuWeight:policy.cpuWeight,allowedCpus:[0,1,2,3],perfPolicy:'task-v2'},
          observed:{containerId:'b'.repeat(64),pid:1234,processStart:'123456',leafDevice:'27',leafInode:'65537',
            memoryHighBytes:'8589934592',memoryMaxBytes:'max',memoryCurrentBytes:'1610612736',memorySwapMaxBytes:'0',
            cpuWeight:100,cpuMax:'max 100000',allowedCpus:[0,1,2,3]},perfObserved:null,perfObservationReason:'OWN_PROCESS_PROBE_REQUIRED',
          capabilities:{softMemoryLive:true,cpuWeightLive:true,hardMemoryReplacement:false,perfReplacement:false,gpuReplacement:false},readOnly:true};
        const value={version:1,purpose:'employee-memory-diagnostics-v1',employeeId:employee.id,sessionId:employee.sessionId,
          sessionGeneration:'2',state:'observed',resources,readOnly:true,observation:{
            binding:{containerId:'b'.repeat(64),initPid:1234,initProcessStart:'123456',leafDevice:'27',leafInode:'65537'},
            sampledAtEpochMs:Date.now()-(window.__pressureMode==='stale'?60000:3000),sampleDurationUs:'321',
            pressure:{state:'available',some:{avg10Hundredths:window.__pressureMode?9400:1234,avg60Hundredths:200,avg300Hundredths:0,totalUs:'9007199254740993'},
              full:{avg10Hundredths:0,avg60Hundredths:0,avg300Hundredths:0,totalUs:'1'}},
            events:{state:'unavailable',reason:'malformed'}}};
        const advisory=await window.__projectSyntheticMemoryAdvisory(value);
        return ok({version:1,employeeId:employee.id,sessionId:employee.sessionId,sessionGeneration:'2',
          source:'native-compound',resources,diagnostics:{kind:'snapshot',value},advisory});
      }
      if(path.endsWith('/hiring-permission'))return ok({employeeId:employee.id,sessionId:employee.sessionId,enabled:false,source:'none'});
      if(path.endsWith('/gpu-access'))return ok({gpuAccess:{version:1,employeeId:employee.id,current:{sessionId:employee.sessionId,sessionGeneration:2},
        revision:0,choices:{known:true,devices:[{deviceUuid:'GPU-synthetic-fixture',model:'Synthetic GPU'}]},requested:null,
        applied:{known:true,enabled:false,deviceUuid:null},active:{known:false,running:true,enabled:null,deviceUuid:null},state:'unchanged'}});
      if(path==='/api/experts')return ok({settings:{maxHiresPerDay:5,maxActive:15,hireDelegates:[]},
        storageUncertain:${JSON.stringify(options.retainedHiring === true)},
        limits:{hiresLast24h:0,maxHiresPerDay:5,active:1,maxActive:15},
        hires:${options.retainedHiring ? `[{id:'synthetic-retained-hire',templateId:'reviewer',employeeId:employee.id,sessionId:employee.sessionId,by:'owner',reason:'Synthetic retained startup',hiredAt:Date.now(),status:'active',sessionLive:false,startup:{phase:'recovery-required',sessionGeneration:2},notice:'unconfirmed',audit:'unconfirmed'}]` : '[]'},experts:[]});
      if(path==='/api/publication/tokens')return ok({tokens:[]});
      return original(path,opts);
    };
    window.fetch=async()=>({ok:true,json:async()=>({avatars:[]})});
    ${appStub}
  `,
  });
  for (const name of ['chatroom-ui.js', 'chat-media.js', 'company-resources.js'])
    await page.addScriptTag({ content: read(name) });
  await page.addScriptTag({ content: 'window.app=new ReverieApp();' });
  // chatroom-ui loads the real shell through its ordinary asset loader.
  await page.waitForSelector('.ca-rail', { state: 'attached' });
}

for (const width of [320, 1280])
  for (const reason of ['native-health-unavailable', 'backoff'] as const)
    it(`keeps ${reason} distinct from an outer response with a bounded retry at ${width}px`, async () => {
      const browser = await chromium.launch({
        headless: true,
        chromiumSandbox: true,
        ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
          ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
          : {}),
      });
      try {
        const page = await browser.newPage({ viewport: { width, height: 900 } }),
          errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await fixture(page, { viewerObservation: true, viewerReason: reason });
        await page.evaluate(() => {
          (window as unknown as { __viewerObservation: string }).__viewerObservation = 'responsive';
        });
        await page.evaluate(() =>
          (
            window as unknown as { reverieChat: { openCompany(section: string): Promise<void> } }
          ).reverieChat.openCompany('people')
        );
        const company = page.locator('#ca-company-people');
        expect(await company.locator('.ca-reconnect-viewer').count()).toBe(0);
        await company.getByRole('button', { name: 'Terminal reconnect status', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Terminal status for River', exact: true }),
          report = dialog.locator('[role="status"]');
        await expect
          .poll(() => report.textContent())
          .toContain(
            reason === 'native-health-unavailable'
              ? 'native health is unconfirmed'
              : 'waiting before another reconnect attempt'
          );
        expect(await report.textContent()).toContain('terminal viewer responded');
        expect(await report.textContent()).toContain('Retry the viewer connection in 5s');
        expect(await report.textContent()).not.toMatch(/native-health-unavailable|backoff|idle:|attempts|pressure/);
        const actual = await dialog.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return {
            dx: Math.abs((r.left + r.right) / 2 - innerWidth / 2),
            dy: Math.abs((r.top + r.bottom) / 2 - innerHeight / 2),
            overflow:
              r.left < 0 ||
              r.right > innerWidth + 1 ||
              r.top < 0 ||
              r.bottom > innerHeight + 1 ||
              el.scrollWidth > el.clientWidth + 1 ||
              el.scrollHeight > el.clientHeight + 1,
          };
        });
        expect(actual.dx).toBeLessThanOrEqual(2);
        expect(actual.dy).toBeLessThanOrEqual(2);
        expect(actual.overflow).toBe(false);
        const screenshots = process.env.TEST_RESOURCE_SCREENSHOT_DIR;
        if (screenshots) {
          await mkdir(screenshots, { recursive: true });
          await page.screenshot({ path: join(screenshots, `viewer-${reason}-${width}.png`) });
        }
        expect(await page.evaluate(() => (window as unknown as { __writes: unknown[] }).__writes)).toEqual([
          {
            path: `/api/company/employees/${employeeId}/reconnect/status`,
            method: 'POST',
            body: { sessionId, sessionGeneration: 2 },
          },
        ]);
        expect(await company.locator('.ca-company-state').textContent()).toBe('Agent health unknown');
        expect(errors).toEqual([]);
      } finally {
        await browser.close();
      }
    });

for (const width of [320, 1280])
  it(`shows read-only outer viewer uncertainty and a separate responsive observation at ${width}px`, async () => {
    const browser = await chromium.launch({
      headless: true,
      chromiumSandbox: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
    try {
      const page = await browser.newPage({ viewport: { width, height: 900 } }),
        errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await fixture(page, { viewerObservation: true });
      await page.evaluate(() =>
        (window as unknown as { reverieChat: { openCompany(section: string): Promise<void> } }).reverieChat.openCompany(
          'people'
        )
      );
      const settings = page.locator('#ca-company-people');
      expect(await settings.locator('.ca-reconnect-viewer').count()).toBe(0);
      await settings.getByRole('button', { name: 'Terminal reconnect status', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Terminal status for River', exact: true });
      await expect
        .poll(() => dialog.locator('[role="status"]').textContent())
        .toContain('terminal viewer could not be checked');
      expect(await dialog.textContent()).toContain('Employee and chat readiness are still unconfirmed');
      expect(await dialog.textContent()).toContain('does not restart the employee or resend chat input');
      const geometry = () =>
        dialog.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return {
            horizontal: Math.abs((r.left + r.right) / 2 - innerWidth / 2),
            vertical: Math.abs((r.top + r.bottom) / 2 - innerHeight / 2),
            overflow:
              r.left < 0 ||
              r.right > innerWidth + 1 ||
              r.top < 0 ||
              r.bottom > innerHeight + 1 ||
              el.scrollWidth > el.clientWidth + 1 ||
              el.scrollHeight > el.clientHeight + 1,
          };
        });
      const checkLayout = async () => {
        const actual = await geometry();
        expect(actual.overflow).toBe(false);
        expect(actual.horizontal).toBeLessThanOrEqual(2);
        expect(actual.vertical).toBeLessThanOrEqual(2);
        for (const button of await dialog.locator('.ca-viewer-status-actions button').all()) {
          const rect = await button.boundingBox();
          expect(rect!.height).toBeGreaterThanOrEqual(44);
          expect(rect!.width).toBeGreaterThanOrEqual(96);
        }
      };
      await checkLayout();
      const screenshots = process.env.TEST_RESOURCE_SCREENSHOT_DIR;
      if (screenshots) {
        await mkdir(screenshots, { recursive: true });
        await page.screenshot({ path: join(screenshots, `viewer-unconfirmed-${width}.png`) });
      }
      await page.evaluate(() => {
        const fixture = window as unknown as { __viewerObservation: string; __viewerRetryAfterMs: number };
        fixture.__viewerObservation = 'responsive';
        fixture.__viewerRetryAfterMs = 2500;
      });
      await dialog.getByRole('button', { name: 'Refresh terminal status', exact: true }).click();
      await expect.poll(() => dialog.locator('[role="status"]').textContent()).toContain('terminal viewer responded');
      expect(await dialog.locator('[role="status"]').textContent()).toContain(
        'Employee and chat readiness are still unconfirmed'
      );
      expect(await dialog.locator('[role="status"]').textContent()).toContain('Retry the viewer connection in 3s');
      expect(await dialog.locator('[role="status"]').textContent()).not.toMatch(
        /idle:|viewer-not-disconnected|attempts 0/
      );
      await checkLayout();
      if (screenshots) await page.screenshot({ path: join(screenshots, `viewer-outer-responsive-${width}.png`) });
      await page.evaluate(() => {
        (window as unknown as { __holdViewerStatus: boolean }).__holdViewerStatus = true;
      });
      await dialog.getByRole('button', { name: 'Refresh terminal status', exact: true }).click();
      await expect
        .poll(() => dialog.getByRole('button', { name: 'Refresh terminal status', exact: true }).isDisabled())
        .toBe(true);
      await page.evaluate(async () => {
        const fixture = window as unknown as {
          __server: { company: { employees: Array<{ sessionGeneration: number }> } };
          reverieChat: { loadOwner(): Promise<void> };
          __finishViewerStatus(): void;
        };
        fixture.__server.company.employees[0].sessionGeneration = 3;
        await fixture.reverieChat.loadOwner();
        fixture.__finishViewerStatus();
      });
      await expect
        .poll(() => dialog.locator('[role="status"]').textContent())
        .toContain('binding or recovery permission changed');
      const writes = await page.evaluate(() => (window as unknown as { __writes: unknown[] }).__writes);
      expect(writes).toEqual(
        [1, 2, 3].map(() => ({
          path: `/api/company/employees/${employeeId}/reconnect/status`,
          method: 'POST',
          body: { sessionId, sessionGeneration: 2 },
        }))
      );
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });

for (const width of [320, 390, 1280])
  it(`shows a server-projected sampled pressure warning and clears its severity on a stale refresh at ${width}px`, async () => {
    const browser = await chromium.launch({
      headless: true,
      chromiumSandbox: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
    try {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await fixture(page, { pressure: 'high' });
      await page.evaluate(() =>
        (window as unknown as { reverieChat: { openCompanySettings(): void } }).reverieChat.openCompanySettings()
      );
      const settings = page.getByRole('dialog', { name: 'Company settings', exact: true });
      await settings.getByRole('button', { name: 'Resource permissions for River', exact: true }).click();
      const profile = page.getByRole('dialog', { name: 'Edit profile: River', exact: true });
      await profile.getByRole('tab', { name: 'Permissions', exact: true }).click();
      const resources = profile.locator('.ca-employee-resources');
      const details = resources.locator('details.ca-memory-details');
      const disclosure = details.locator('summary');
      expect(await details.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(false);
      expect(await details.getByRole('table').isVisible()).toBe(false);
      const warning = resources.locator('[data-memory-advisory][role="alert"]');
      await warning.waitFor({ state: 'visible' });
      await warning.scrollIntoViewIfNeeded();
      expect(await warning.textContent()).toContain('High memory stalls were observed');
      expect(await resources.locator('.ca-memory-sample-time').isVisible()).toBe(true);
      expect(await warning.textContent()).toContain('inspect current jobs');
      expect(await resources.getByRole('button', { name: 'Apply RAM and CPU limits', exact: true }).isEnabled()).toBe(
        true
      );
      const overflow = () =>
        page.evaluate(
          () =>
            document.documentElement.scrollWidth > innerWidth + 1 ||
            [...document.querySelectorAll('.ca-profile-editor-body')].some((e) => e.scrollWidth > e.clientWidth + 1)
        );
      expect(await overflow()).toBe(false);
      const screenshotDir = process.env.TEST_RESOURCE_SCREENSHOT_DIR;
      if (screenshotDir) {
        await mkdir(screenshotDir, { recursive: true });
        await page.screenshot({ path: join(screenshotDir, `memory-pressure-warning-${width}.png`) });
      }
      await disclosure.focus();
      await page.keyboard.press('Enter');
      expect(await details.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(true);
      expect(await details.getByRole('table').isVisible()).toBe(true);
      expect(await details.textContent()).toContain('9007199254740993 microseconds');
      expect(await resources.locator('[data-memory-advisory-time]').textContent()).toContain('Server evaluated');
      expect(await overflow()).toBe(false);
      if (screenshotDir) await page.screenshot({ path: join(screenshotDir, `memory-pressure-details-${width}.png`) });
      await page.evaluate(() => {
        (window as unknown as { __pressureMode: string }).__pressureMode = 'stale';
      });
      await resources.getByRole('button', { name: 'Refresh resource status for River', exact: true }).click();
      await expect
        .poll(() => resources.locator('[data-memory-advisory]').textContent())
        .toContain('unknown (stale-sample)');
      expect(await details.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(true);
      expect(await resources.locator('[data-memory-advisory][role="alert"]').count()).toBe(0);
      await disclosure.focus();
      await page.keyboard.press('Enter');
      expect(await details.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(false);
      await resources.locator('[data-memory-advisory]').scrollIntoViewIfNeeded();
      expect(
        await resources.locator('[data-memory-advisory]').evaluate((element) => {
          const r = element.getBoundingClientRect();
          return r.top >= 0 && r.bottom <= innerHeight;
        })
      ).toBe(true);
      expect(await overflow()).toBe(false);
      if (screenshotDir) await page.screenshot({ path: join(screenshotDir, `memory-pressure-stale-${width}.png`) });
      expect(await page.evaluate(() => (window as unknown as { __writes: unknown[] }).__writes)).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });

for (const width of [1280, 390, 320])
  it(`keeps company resource and employee permission controls usable at ${width}px`, async () => {
    const browser = await chromium.launch({
      headless: true,
      chromiumSandbox: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
    try {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await fixture(page);
      await page.evaluate(() => (window as any).reverieChat.openCompanySettings());
      const settings = page.getByRole('dialog', { name: 'Company settings', exact: true });
      await settings.getByRole('button', { name: 'Resource permissions for River', exact: true }).waitFor();
      expect(await settings.getByRole('tab', { name: 'Employees', exact: true }).getAttribute('aria-selected')).toBe(
        'true'
      );
      expect(await settings.locator('.ca-fleet-summary').textContent()).toContain('Not verified');
      expect(
        await settings.locator('.ca-fleet-maintenance').evaluate((element: HTMLDetailsElement) => element.open)
      ).toBe(false);
      expect(await settings.locator('.ca-fleet-rollout').evaluate((element: HTMLDetailsElement) => element.open)).toBe(
        false
      );
      expect(
        await settings
          .locator('button:visible')
          .evaluateAll((elements) =>
            elements.every((element) => !!element.textContent?.trim() && element.scrollWidth <= element.clientWidth + 1)
          )
      ).toBe(true);
      const geometry = await settings.evaluate((element) => {
        const box = element.getBoundingClientRect(),
          close = element.querySelector('[aria-label="Close company settings"]')!.getBoundingClientRect();
        return {
          left: box.left,
          right: box.right,
          bottom: box.bottom,
          height: innerHeight,
          closeTop: close.top,
          closeBottom: close.bottom,
          bodyWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
        };
      });
      expect(geometry.left).toBeGreaterThanOrEqual(0);
      expect(geometry.right).toBeLessThanOrEqual(width);
      expect(geometry.bottom).toBeLessThanOrEqual(geometry.height);
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.bodyWidth + 1);
      await settings.locator('.ca-company-settings-content').evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      expect(await settings.getByRole('button', { name: 'Close company settings', exact: true }).isVisible()).toBe(
        true
      );
      const tabs = settings.getByRole('tablist');
      await tabs.getByRole('tab', { name: 'Employees', exact: true }).focus();
      await page.keyboard.press('ArrowRight');
      expect(await tabs.getByRole('tab', { name: 'Hiring', exact: true }).getAttribute('aria-selected')).toBe('true');
      expect(await settings.getByLabel('Hires in any 24 hours', { exact: true }).isVisible()).toBe(true);
      await tabs.getByRole('tab', { name: 'Employees', exact: true }).click();
      const screenshotDir = process.env.TEST_RESOURCE_SCREENSHOT_DIR;
      if (screenshotDir) {
        await mkdir(screenshotDir, { recursive: true });
        await page.screenshot({ path: join(screenshotDir, `company-fleet-${width}.png`) });
      }
      await settings.getByRole('button', { name: 'Resource permissions for River', exact: true }).click();
      const profile = page.getByRole('dialog', { name: 'Edit profile: River', exact: true });
      await profile.getByRole('tab', { name: 'Permissions', exact: true }).click();
      expect(
        await profile
          .getByRole('tab')
          .evaluateAll((elements) => elements.every((element) => element.scrollWidth <= element.clientWidth + 1))
      ).toBe(true);
      const resources = profile.getByRole('region', { name: 'Laptop resources', exact: true });
      await resources.getByLabel('Soft RAM (MiB)', { exact: true }).waitFor();
      await resources.scrollIntoViewIfNeeded();
      const layout = await resources.evaluate((element) => {
        const fields = [...element.querySelectorAll<HTMLInputElement>('input[type="number"]')].map((input) => ({
          label: input.getAttribute('aria-label'),
          width: input.getBoundingClientRect().width,
          right: input.getBoundingClientRect().right,
          parentRight: input.parentElement!.getBoundingClientRect().right,
        }));
        const body = element.closest('.ca-profile-editor-body')!;
        return { fields, bodyWidth: body.clientWidth, scrollWidth: body.scrollWidth };
      });
      for (const field of layout.fields) {
        expect(field.width).toBeGreaterThan(100);
        expect(field.right).toBeLessThanOrEqual(field.parentRight + 1);
      }
      expect(layout.scrollWidth).toBeLessThanOrEqual(layout.bodyWidth + 1);
      expect(await resources.getByRole('group', { name: 'Laptop GPU access', exact: true }).isVisible()).toBe(true);
      expect(
        await resources.getByRole('heading', { name: 'Hard RAM ceiling (restart required)', exact: true }).count()
      ).toBe(1);
      expect(await resources.getByLabel('Soft RAM (MiB)', { exact: true }).count()).toBe(1);
      const resourceRefresh = resources.getByRole('button', { name: 'Refresh resource status for River', exact: true });
      await resourceRefresh.click();
      await expect
        .poll(() => page.evaluate(() => (window as unknown as { __resourceReads: number }).__resourceReads))
        .toBe(2);
      await expect.poll(() => resourceRefresh.isEnabled()).toBe(true);
      expect(await resources.getByText('Memory pressure sample', { exact: true }).isVisible()).toBe(true);
      const pressureDetails = resources.locator('details.ca-memory-details');
      expect(await pressureDetails.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(false);
      expect(await resources.getByText('Unavailable (malformed)', { exact: true }).isVisible()).toBe(false);
      await pressureDetails.locator('summary').click();
      expect(await resources.getByText('Unavailable (malformed)', { exact: true }).isVisible()).toBe(true);
      await pressureDetails.locator('summary').click();
      expect(await resources.getByRole('button', { name: 'Apply RAM and CPU limits', exact: true }).isEnabled()).toBe(
        true
      );
      expect(await resources.getByLabel('Laptop memory for River in MiB', { exact: true }).count()).toBe(1);
      expect(await profile.getByLabel('Hiring permission for River', { exact: true }).count()).toBe(1);
      const saved = await profile.locator('.ca-profile-footer').boundingBox();
      expect(saved!.y + saved!.height).toBeLessThanOrEqual(900);
      if (screenshotDir) {
        await page.screenshot({ path: join(screenshotDir, `employee-resources-${width}.png`) });
        await resources.locator('.ca-profile-memory').scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(screenshotDir, `employee-hard-ceiling-${width}.png`) });
        await writeFile(
          join(screenshotDir, `layout-${width}.json`),
          JSON.stringify({ geometry, layout, errors }, null, 2)
        );
      }
      expect(await page.evaluate(() => (window as any).__writes)).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });

it('shows an unavailable-resource error and long synthetic employee name without losing controls at 320px', async () => {
  const browser = await chromium.launch({
    headless: true,
    chromiumSandbox: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {}),
  });
  try {
    const page = await browser.newPage({ viewport: { width: 320, height: 900 } });
    const name = 'SyntheticWorkerWithAnUnusuallyLongUnbrokenDisplayNameForLayoutChecks';
    await fixture(page, { name, resourceUnavailable: true });
    await page.evaluate(() => (window as any).reverieChat.openCompanySettings());
    const settings = page.getByRole('dialog', { name: 'Company settings', exact: true });
    const open = settings.getByRole('button', { name: `Resource permissions for ${name}`, exact: true });
    await open.waitFor();
    expect(
      await settings
        .locator('.ca-company-settings-content')
        .evaluate((element) => element.scrollWidth <= element.clientWidth + 1)
    ).toBe(true);
    const screenshotDir = process.env.TEST_RESOURCE_SCREENSHOT_DIR;
    if (screenshotDir) {
      await mkdir(screenshotDir, { recursive: true });
      await page.screenshot({ path: join(screenshotDir, 'company-unknown-long-name-320.png') });
    }
    await open.click();
    const profile = page.getByRole('dialog', { name: `Edit profile: ${name}`, exact: true });
    await profile.getByRole('tab', { name: 'Permissions', exact: true }).click();
    expect(
      await profile
        .getByRole('tab')
        .evaluateAll((elements) => elements.every((element) => element.scrollWidth <= element.clientWidth + 1))
    ).toBe(true);
    const resources = profile.getByRole('region', { name: 'Laptop resources', exact: true });
    const status = resources.locator('.ca-employee-resources [role="status"]');
    await expect.poll(() => status.textContent()).toBe('Running limits are unconfirmed.');
    await resources.scrollIntoViewIfNeeded();
    expect(await resources.locator('[role="alert"]').first().textContent()).toContain(
      'Native resource observations are unavailable'
    );
    expect(
      await resources.getByRole('button', { name: `Refresh resource status for ${name}`, exact: true }).isEnabled()
    ).toBe(true);
    expect(await resources.getByRole('button', { name: 'Apply RAM and CPU limits', exact: true }).count()).toBe(0);
    const geometry = await profile.evaluate((element) => ({
      width: element.clientWidth,
      scrollWidth: element.scrollWidth,
      close: element.querySelector('.ca-profile-edit-heading > button')!.getBoundingClientRect().right,
      right: element.getBoundingClientRect().right,
    }));
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width + 1);
    expect(geometry.close).toBeLessThanOrEqual(geometry.right);
    if (screenshotDir)
      await page.screenshot({ path: join(screenshotDir, 'employee-resource-error-long-name-320.png') });
    expect(await page.evaluate(() => (window as any).__writes)).toEqual([]);
  } finally {
    await browser.close();
  }
});

for (const width of [1280, 390, 320])
  it(`keeps retained-hire diagnostics readable and prevents uncertain hiring writes at ${width}px`, async () => {
    const browser = await chromium.launch({
      headless: true,
      chromiumSandbox: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
    try {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await fixture(page, { retainedHiring: true, name: 'Synthetic ' + 'longname'.repeat(10) });
      await page.evaluate(() => (window as any).reverieChat.openCompanySettings());
      const dialog = page.getByRole('dialog', { name: 'Company settings', exact: true });
      await dialog.getByRole('tab', { name: 'Hiring', exact: true }).click();
      const form = dialog.getByRole('form', { name: 'Hiring', exact: true });
      const save = form.getByRole('button', { name: 'Save hiring settings', exact: true });
      await expect.poll(() => save.isDisabled()).toBe(true);
      await expect
        .poll(() => form.locator('[role="alert"]').textContent())
        .toContain('A hiring write was not confirmed');
      await form.getByText('Active hires · 1', { exact: true }).click();
      const record = form.locator('.ca-company-hire-record');
      expect(await record.textContent()).toContain('Startup recovery-required. Identity retained.');
      expect(await record.textContent()).toContain('The employee was retained.');
      expect(await record.textContent()).toContain('The original hire session is not present.');
      await record.scrollIntoViewIfNeeded();
      const output = process.env.TEST_RESOURCE_SCREENSHOT_DIR;
      if (output) {
        await mkdir(output, { recursive: true });
        await page.screenshot({ path: join(output, `retained-hiring-${width}.png`) });
      }
      const clippedText = await form.evaluate((element) => {
        const content = element.closest('.ca-company-settings-content')!.getBoundingClientRect();
        return [...element.querySelectorAll('p,strong,summary')].flatMap((node) => {
          const range = document.createRange();
          range.selectNodeContents(node);
          return [...range.getClientRects()]
            .filter((rect) => rect.width > 0 && (rect.left < content.left - 1 || rect.right > content.right + 1))
            .map(() => node.textContent);
        });
      });
      expect(clippedText).toEqual([]);
      const geometry = await dialog.evaluate((element) => ({
        width: element.clientWidth,
        scrollWidth: element.scrollWidth,
        closeRight: element.querySelector('[aria-label="Close company settings"]')!.getBoundingClientRect().right,
        right: element.getBoundingClientRect().right,
      }));
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width + 1);
      expect(geometry.closeRight).toBeLessThanOrEqual(geometry.right + 1);
      await form.dispatchEvent('submit');
      expect(await page.evaluate(() => (window as any).__writes)).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });
