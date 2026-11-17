/** Production markup/CSS with closed synthetic APIs; never connects to an office. */
import { readFileSync, existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { expect, it } from 'vitest';
import { chromium, type Page, type Route } from 'playwright';
import { JSDOM } from 'jsdom';
import { createServer, member, room, message } from './helpers/chat-app-harness.mjs';
import { EmployeeMemoryDiagnostics, memoryPressureAdvisory } from '../src/resource-employee-data.js';

type LayoutWindow = Window & {
  reverieChat: { openCompanySettings(): Promise<void>; openCompany(section: string): Promise<void> };
  __writes: unknown[];
};
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
    boxedRecovery?: 'approval' | 'held';
    dockerResources?: boolean;
    resourceActions?: string[];
    originalRequests?: boolean;
  } = {}
) {
  // Keep the shipped document structure, but bootstrap only the conversation
  // shell fixture. Every request stays inside this intercepted synthetic origin.
  const document = new JSDOM(read('index.html'));
  document.window.document.querySelectorAll('script,link').forEach((element: Element) => element.remove());
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
      name:${JSON.stringify(options.name ?? 'River')},position:'Compiler engineer',expertise:['Systems'],responsibilities:[],permissions:${options.boxedRecovery ? JSON.stringify({ recoverEmployees: true, manageOffice: false, manageGoals: false, moveOwnPlan: true, managePlans: false }) : '{}'},
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
    window.__server.company={canManage:true,boxedRuntime:${!!options.boxedRecovery},resourceReplacement:${!options.boxedRecovery},employees:[employee],settings:{ownerName:'Fixture owner',autoWakeEnabled:false}};
    const original=window.__server.handle;
    window.__server.handle=async(path,opts={})=>{
      const ok=data=>({ok:true,status:200,json:async()=>({success:true,data})});
      if(opts.method && opts.method!=='GET' && path!=='/api/company/resources/operations')window.__writes.push({path,method:opts.method,body:opts.body});
      if(path==='/api/company/employees/'+employee.id+'/docker-policy' && ${!!options.boxedRecovery}) {
        const held=${JSON.stringify(options.boxedRecovery)};
        const resourcePolicy={memoryHighBytes:24*1024**3,memoryMaxBytes:48*1024**3,swapMaxBytes:0,pidsMax:512,
          cpuWeight:100,allowedCpus:Array.from({length:32},(_,i)=>i),
          pool:{memoryMaxBytes:48*1024**3,swapMaxBytes:0,pidsMax:8192,cpuWeight:100,allowedCpus:Array.from({length:32},(_,i)=>i)}};
        const operationId='44444444-5555-4666-8777-888888888888';
        const source={sessionId:employee.sessionId,sessionGeneration:employee.sessionGeneration,
          sourceDigest:'a'.repeat(64),containerId:'b'.repeat(64),imageId:'sha256:'+'c'.repeat(64),
          destinationImageId:'sha256:'+'d'.repeat(64),state:'stopped',enforcement:'unverified'};
        const operation={operationId,state:'held',phase:'provider-issued',allowedActions:['observe'],
          code:'DOCKER_CONTINUATION_EFFECT_UNCONFIRMED'};
        return ok({...source,operationId:held==='held'?operationId:null,policy:held==='held'?resourcePolicy:null,
          policyDigest:held==='held'?'e'.repeat(64):null,canApprovePolicy:held==='approval',
          proposedPolicy:held==='approval'?resourcePolicy:undefined,proposedPolicyDigest:'e'.repeat(64),
          allowedActions:held==='held'?['observe']:['approve-policy'],
          ...(held==='held'?{operation,originalRequest:{operationId,sessionId:employee.sessionId,
            sessionGeneration:employee.sessionGeneration,containerId:source.containerId,imageId:source.imageId,
            expectedDestinationImageId:source.destinationImageId,expectedPolicyDigest:'e'.repeat(64),enterOffice:true}}:{})});
      }
      if(path==='/api/company/docker-resources/original-attempts')return ok(${JSON.stringify(options.originalRequests ? JSON.parse(readFileSync(new URL('./fixtures/docker-resource-original-attempts.json', import.meta.url), 'utf8')).created.pending : { items: [], next: null, enforcement: 'not-observed' })});
      if(path==='/api/company/docker-resources')return ok({allowedActions:['approve-default'],desired:{revision:'33333333-3333-4333-8333-333333333333',scope:'all-current-and-future',memoryHighBytes:48*1024**3},employees:[{employeeId:employee.id,sessionId:employee.sessionId,sessionGeneration:employee.sessionGeneration,state:'not-observed',enforcement:'not-observed'}]});
      if(path==='/api/company/employees/'+employee.id+'/docker-resources')return ok({employeeId:employee.id,sessionId:employee.sessionId,sessionGeneration:employee.sessionGeneration,revision:'33333333-3333-4333-8333-333333333333',actualMemoryHighBytes:16*1024**3,memoryMaxBytes:64*1024**3,actualLimits:{memoryHighBytes:16*1024**3,memoryMaxBytes:64*1024**3,swapMaxBytes:0,pidsMax:512,cpuWeight:100,allowedCpus:Array.from({length:32},(_,index)=>index),cpuQuota:'unlimited'},approved:true,approvalSource:'original-policy',approvedRevision:null,enforcement:'fresh-native-readback',allowedActions:${JSON.stringify(options.resourceActions ?? ['apply'])}});
      if(path==='/api/company/employees/'+employee.id+'/docker-pool/status')return ok({sessionId:employee.sessionId,sessionGeneration:employee.sessionGeneration,state:'held',code:'DOCKER_POOL_ORIGINAL_ACK_MISSING',allowedActions:[]});
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
  for (const name of ['chatroom-ui.js', 'chat-media.js', 'company-resources.js', 'docker-employee-recovery.js'])
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
      expect(await dialog.textContent()).toContain('This viewer check does not measure employee or chat readiness');
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
        'This viewer check does not measure employee or chat readiness'
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

it.each([320, 1280])(
  'retains visible viewer read failures and isolates closed pending dialogs at %ipx',
  async (width) => {
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
      await fixture(page, { viewerObservation: true });
      await page.evaluate((employeeId) => {
        type Reply = { ok: boolean; status: number; json(): Promise<unknown> };
        const w = window as unknown as {
          __server: { handle(path: string, options?: unknown): Promise<Reply> };
          __nextViewerRead: 'failed' | 'normal' | 'hold';
          __releaseClosedViewerRead(): void;
        };
        const original = w.__server.handle;
        w.__nextViewerRead = 'failed';
        w.__server.handle = async (path, options) => {
          const reply = await original(path, options);
          if (path !== '/api/company/employees/' + employeeId + '/reconnect/status') return reply;
          const fault = w.__nextViewerRead;
          w.__nextViewerRead = 'normal';
          if (fault === 'failed')
            return {
              ok: false,
              status: 503,
              json: async () => ({
                success: false,
                error: 'Synthetic viewer status unavailable. Refresh to check again.',
              }),
            };
          // The response is already captured. Closing must not let this older
          // reply paint either the detached dialog or a newly opened one.
          if (fault === 'hold')
            await new Promise<void>((resolve) => {
              w.__releaseClosedViewerRead = resolve;
            });
          return reply;
        };
      }, employeeId);
      await page.evaluate(() => (window as unknown as LayoutWindow).reverieChat.openCompany('people'));
      const statusButton = page.locator('#ca-company-people').getByRole('button', {
        name: 'Terminal reconnect status',
        exact: true,
      });
      await statusButton.click();
      const dialog = page.getByRole('dialog', { name: 'Terminal status for River', exact: true });
      const report = dialog.getByRole('status');
      await expect
        .poll(() => report.textContent())
        .toBe('Synthetic viewer status unavailable. Refresh to check again.');
      const refresh = dialog.getByRole('button', { name: 'Refresh terminal status', exact: true });
      expect(await refresh.isEnabled()).toBe(true);
      await page.evaluate(() => {
        (window as unknown as { __viewerObservation: string }).__viewerObservation = 'responsive';
      });
      await refresh.click();
      await expect.poll(() => report.textContent()).toContain('The terminal viewer responded.');
      expect(await report.textContent()).toContain('This viewer check does not measure employee or chat readiness.');
      expect(await page.evaluate(() => (window as unknown as LayoutWindow).__writes)).toHaveLength(2);
      await page.evaluate(() => {
        const w = window as unknown as { __nextViewerRead: string; __viewerObservation: string };
        w.__nextViewerRead = 'hold';
        w.__viewerObservation = 'unconfirmed';
      });
      await refresh.click();
      await expect.poll(() => refresh.isDisabled()).toBe(true);
      await dialog.getByRole('button', { name: 'Close terminal status', exact: true }).click();
      expect(await dialog.count()).toBe(0);
      await page.evaluate(() => {
        const w = window as unknown as { __viewerObservation: string; __viewerReason: string };
        w.__viewerObservation = 'responsive';
        w.__viewerReason = 'native-health-unavailable';
      });
      await statusButton.click();
      const reopened = page.getByRole('dialog', { name: 'Terminal status for River', exact: true });
      await expect.poll(() => reopened.getByRole('status').textContent()).toContain('native health is unconfirmed');
      const currentText = await reopened.getByRole('status').textContent();
      const cachedStatus = () =>
        page.evaluate(
          ({ employeeId, sessionId }) => {
            const w = window as unknown as {
              reverieChat: {
                viewerReconnectStatus(employee: { id: string; sessionId: string; sessionGeneration: number }): unknown;
              };
            };
            return w.reverieChat.viewerReconnectStatus({ id: employeeId, sessionId, sessionGeneration: 2 });
          },
          { employeeId, sessionId }
        );
      const currentStatus = await cachedStatus();
      expect(currentStatus).toMatchObject({
        reason: 'native-health-unavailable',
        observation: 'outer-pane-responsive',
      });
      await page.evaluate(async () => {
        (window as unknown as { __releaseClosedViewerRead(): void }).__releaseClosedViewerRead();
        await new Promise(requestAnimationFrame);
      });
      expect(await reopened.getByRole('status').textContent()).toBe(currentText);
      expect(await cachedStatus()).toEqual(currentStatus);
      expect(await reopened.count()).toBe(1);
      expect(await page.evaluate(() => (window as unknown as LayoutWindow).__writes)).toEqual(
        [1, 2, 3, 4].map(() => ({
          path: `/api/company/employees/${employeeId}/reconnect/status`,
          method: 'POST',
          body: { sessionId, sessionGeneration: 2 },
        }))
      );
      const bounds = await reopened.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
      expect(bounds!.y).toBeGreaterThanOrEqual(0);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(901);
      if (process.env.TEST_RESOURCE_SCREENSHOT_DIR) {
        await mkdir(process.env.TEST_RESOURCE_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({
          path: join(process.env.TEST_RESOURCE_SCREENSHOT_DIR, `viewer-closed-read-${width}.png`),
        });
      }
      await reopened.getByRole('button', { name: 'Close terminal status', exact: true }).click();
      expect(await reopened.count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  }
);

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
      await page.evaluate(() => (window as unknown as LayoutWindow).reverieChat.openCompanySettings());
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
      expect(await page.evaluate(() => (window as unknown as LayoutWindow).__writes)).toEqual([]);
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
    await page.evaluate(() => (window as unknown as LayoutWindow).reverieChat.openCompanySettings());
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
    expect(await page.evaluate(() => (window as unknown as LayoutWindow).__writes)).toEqual([]);
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
      await page.evaluate(() => (window as unknown as LayoutWindow).reverieChat.openCompanySettings());
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
      expect(await page.evaluate(() => (window as unknown as LayoutWindow).__writes)).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });

for (const width of [320, 1280])
  for (const state of ['approval', 'held'] as const)
    it(`keeps Docker recovery ${state} readable and actionable at ${width}px`, async () => {
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
        await fixture(page, { boxedRecovery: state });
        await page.evaluate(() =>
          (
            window as unknown as { reverieChat: { openCompany(section: string): Promise<void> } }
          ).reverieChat.openCompany('people')
        );
        await page.getByRole('button', { name: 'Edit profile for River', exact: true }).click();
        const profile = page.getByRole('dialog', { name: 'Edit profile: River', exact: true });
        await profile.getByRole('tab', { name: 'Permissions', exact: true }).click();
        const recovery = profile.getByRole('region', { name: 'Docker session recovery', exact: true });
        await recovery.locator('table').waitFor({ state: 'attached' });
        if (state === 'held') {
          expect(
            await recovery.locator('.ca-recovery-policy-details').evaluate((el) => (el as HTMLDetailsElement).open)
          ).toBe(false);
          await recovery.getByText('Approved resource policy details', { exact: true }).click();
        }
        await recovery.scrollIntoViewIfNeeded();
        expect(await recovery.locator('caption').textContent()).toBe(
          state === 'approval' ? 'Proposed resource policy — approval required' : 'Approved resource policy'
        );
        expect(await recovery.getByRole('cell', { name: '24 GiB', exact: true }).count()).toBe(1);
        expect(await recovery.getByRole('cell', { name: '0–31', exact: true }).count()).toBe(1);
        if (state === 'held') {
          expect(await recovery.locator('[role="alert"]').textContent()).toContain(
            'previous recovery step could not be confirmed'
          );
          expect(await recovery.locator('.ca-recovery-details').evaluate((el) => (el as HTMLDetailsElement).open)).toBe(
            false
          );
          await recovery.locator('.ca-recovery-details summary').click();
          expect(await recovery.locator('.ca-recovery-details').evaluate((el) => (el as HTMLDetailsElement).open)).toBe(
            true
          );
          await recovery.locator('.ca-recovery-details summary').click();
          expect(await recovery.locator('.ca-recovery-details').evaluate((el) => (el as HTMLDetailsElement).open)).toBe(
            false
          );
        }
        if (state === 'held') await recovery.getByText('Approved resource policy details', { exact: true }).click();
        const controls = recovery.locator('button');
        expect(await controls.allTextContents()).toEqual(
          state === 'approval'
            ? ['Refresh recovery status', 'Approve displayed limits and recover']
            : ['Refresh recovery status', 'Check original recovery']
        );
        const output = process.env.TEST_RESOURCE_SCREENSHOT_DIR;
        if (output) {
          await mkdir(output, { recursive: true });
          await page.screenshot({ path: join(output, `docker-recovery-${state}-${width}.png`) });
        }
        const geometry = await recovery.evaluate((element) => {
          const body = element.closest('.ca-profile-editor-body')!,
            bounds = body.getBoundingClientRect();
          return {
            overflow: body.scrollWidth > body.clientWidth + 1,
            buttons: [...element.querySelectorAll('button')].map((button) => {
              const r = button.getBoundingClientRect();
              return {
                height: r.height,
                left: r.left,
                right: r.right,
                content: button.scrollWidth > button.clientWidth + 1,
              };
            }),
            left: bounds.left,
            right: bounds.right,
          };
        });
        expect(geometry.overflow).toBe(false);
        for (const button of geometry.buttons) {
          expect(button.height).toBeGreaterThanOrEqual(44);
          expect(button.left).toBeGreaterThanOrEqual(geometry.left);
          expect(button.right).toBeLessThanOrEqual(geometry.right + 1);
          expect(button.content).toBe(false);
        }
        expect(await profile.getByLabel('Soft RAM (MiB)', { exact: true }).count()).toBe(0);
        expect(await page.evaluate(() => (window as unknown as { __writes: unknown[] }).__writes)).toEqual([]);
        expect(errors).toEqual([]);
      } finally {
        await browser.close();
      }
    });

for (const width of [320, 1280])
  it(`shows desired and actual Docker RAM without overflow at ${width}px`, async () => {
    const browser = await chromium.launch({
      headless: true,
      chromiumSandbox: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
    try {
      const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await fixture(page, { boxedRecovery: 'held', dockerResources: true });
      await page.evaluate(() => (window as unknown as LayoutWindow).reverieChat.openCompanySettings());
      const settings = page.getByRole('dialog', { name: 'Company settings', exact: true });
      const company = settings.getByRole('region', { name: 'Docker employee resource defaults', exact: true });
      await company
        .getByText('Owner-approved soft RAM default: 48 GiB for current and future employees.', { exact: true })
        .waitFor();
      expect(await company.textContent()).toContain('not fresh enforcement');
      expect(
        await company
          .locator('details')
          .filter({ hasText: 'Approved default details' })
          .evaluate((el) => (el as HTMLDetailsElement).open)
      ).toBe(false);
      await company.scrollIntoViewIfNeeded();
      expect(await company.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      if (process.env.TEST_RESOURCE_SCREENSHOT_DIR) {
        await mkdir(process.env.TEST_RESOURCE_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({
          path: join(process.env.TEST_RESOURCE_SCREENSHOT_DIR, `docker-resource-company-${width}.png`),
        });
      }
      await settings.getByRole('button', { name: 'Close company settings', exact: true }).click();
      await page.evaluate(() => (window as unknown as LayoutWindow).reverieChat.openCompany('people'));
      await page.getByRole('button', { name: 'Edit profile for River', exact: true }).click();
      const profile = page.getByRole('dialog', { name: 'Edit profile: River', exact: true });
      await profile.getByRole('tab', { name: 'Permissions', exact: true }).click();
      const panel = profile.getByRole('region', { name: 'Docker resources for River', exact: true });
      await panel.getByText('Fresh native readback', { exact: true }).waitFor();
      expect(await panel.textContent()).toContain('Owner-approved default: 48 GiB');
      expect(await panel.locator('caption').textContent()).toBe('Running CPU and memory limits');
      expect(await panel.locator('table').textContent()).toContain('CPU weight100');
      expect(await panel.locator('table').textContent()).toContain('Allowed CPUs0–31');
      expect(await panel.locator('table').textContent()).toContain('Process limit512');
      expect(await panel.textContent()).toContain('DOCKER_POOL_ORIGINAL_ACK_MISSING');
      await panel.scrollIntoViewIfNeeded();
      const geometry = await panel.evaluate((el) => ({
        width: el.clientWidth,
        scroll: el.scrollWidth,
        ratio: window.devicePixelRatio,
        buttons: [...el.querySelectorAll('button')].map((b) => ({
          height: b.getBoundingClientRect().height,
          overflow: b.scrollWidth > b.clientWidth + 1,
        })),
      }));
      expect(geometry.ratio).toBe(1);
      expect(geometry.scroll).toBeLessThanOrEqual(geometry.width + 1);
      for (const b of geometry.buttons) {
        expect(b.height).toBeGreaterThanOrEqual(44);
        expect(b.overflow).toBe(false);
      }
      const output = process.env.TEST_RESOURCE_SCREENSHOT_DIR;
      if (output) {
        await mkdir(output, { recursive: true });
        await panel.locator('table').scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(output, `docker-cpu-memory-profile-${width}.png`) });
      }
      expect(await page.evaluate(() => (window as unknown as LayoutWindow).__writes)).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });

for (const width of [320, 1280])
  it(`keeps explicit original resource controls readable at ${width}px`, async () => {
    const browser = await chromium.launch({
      headless: true,
      chromiumSandbox: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
    try {
      const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await fixture(page, {
        boxedRecovery: 'held',
        dockerResources: true,
        resourceActions: ['continue-original', 'abandon-original'],
      });
      await page.evaluate(() => (window as unknown as LayoutWindow).reverieChat.openCompany('people'));
      await page.getByRole('button', { name: 'Edit profile for River', exact: true }).click();
      const profile = page.getByRole('dialog', { name: 'Edit profile: River', exact: true });
      await profile.getByRole('tab', { name: 'Permissions', exact: true }).click();
      const panel = profile.getByRole('region', { name: 'Docker resources for River', exact: true });
      await panel.getByRole('button', { name: 'Continue original resource application', exact: true }).waitFor();
      expect(
        await panel.getByRole('button', { name: 'Abandon unstarted resource application', exact: true }).count()
      ).toBe(1);
      expect(await panel.getByRole('button', { name: 'Apply approved soft RAM default', exact: true }).count()).toBe(0);
      expect(await panel.textContent()).toContain('it does not stop a container or change running limits');
      await panel.scrollIntoViewIfNeeded();
      const geometry = await panel.evaluate((el) => ({
        ratio: window.devicePixelRatio,
        width: el.clientWidth,
        scroll: el.scrollWidth,
        buttons: [...el.querySelectorAll('button')].map((button) => ({
          height: button.getBoundingClientRect().height,
          overflow: button.scrollWidth > button.clientWidth + 1,
        })),
      }));
      expect(geometry.ratio).toBe(1);
      expect(geometry.scroll).toBeLessThanOrEqual(geometry.width + 1);
      for (const button of geometry.buttons) {
        expect(button.height).toBeGreaterThanOrEqual(44);
        expect(button.overflow).toBe(false);
      }
      // Trial clicks prove both actions can be scrolled clear of the fixed footer,
      // without dispatching a resource update in this layout-only acceptance.
      await panel
        .getByRole('button', { name: 'Continue original resource application', exact: true })
        .click({ trial: true });
      await panel
        .getByRole('button', { name: 'Abandon unstarted resource application', exact: true })
        .click({ trial: true });
      if (process.env.TEST_RESOURCE_SCREENSHOT_DIR) {
        await mkdir(process.env.TEST_RESOURCE_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({
          path: join(process.env.TEST_RESOURCE_SCREENSHOT_DIR, `docker-resource-original-${width}.png`),
        });
      }
      expect(await page.evaluate(() => (window as unknown as LayoutWindow).__writes)).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });

for (const width of [320, 1280])
  it(`keeps former-binding resource recovery readable at ${width}px`, async () => {
    const browser = await chromium.launch({
      headless: true,
      chromiumSandbox: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
    try {
      const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await fixture(page, { boxedRecovery: 'held', dockerResources: true, originalRequests: true });
      await page.evaluate(() => (window as unknown as LayoutWindow).reverieChat.openCompanySettings());
      const settings = page.getByRole('dialog', { name: 'Company settings', exact: true });
      await settings.getByText('Original resource request recovery', { exact: true }).click();
      const panel = settings.getByRole('region', { name: 'Original resource requests', exact: true });
      const retire = panel.getByRole('button', { name: 'Retire unstarted request', exact: true });
      await retire.waitFor();
      expect(await panel.textContent()).toContain('Original execution outcome is unknown');
      expect(await panel.textContent()).not.toContain('River');
      await panel.getByText('Original request identifiers', { exact: true }).click();
      const geometry = await panel.evaluate((el) => ({
        ratio: window.devicePixelRatio,
        width: el.clientWidth,
        scroll: el.scrollWidth,
        buttons: [...el.querySelectorAll('button')].map((b) => ({
          height: b.getBoundingClientRect().height,
          overflow: b.scrollWidth > b.clientWidth + 1,
        })),
      }));
      expect(geometry.ratio).toBe(1);
      expect(geometry.scroll).toBeLessThanOrEqual(geometry.width + 1);
      for (const button of geometry.buttons) {
        expect(button.height).toBeGreaterThanOrEqual(44);
        expect(button.overflow).toBe(false);
      }
      await panel.getByRole('button', { name: 'Check original helper', exact: true }).click({ trial: true });
      await retire.click({ trial: true });
      if (process.env.TEST_RESOURCE_SCREENSHOT_DIR) {
        await mkdir(process.env.TEST_RESOURCE_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({
          path: join(process.env.TEST_RESOURCE_SCREENSHOT_DIR, `docker-resource-former-binding-${width}.png`),
        });
      }
      expect(await page.evaluate(() => (window as unknown as LayoutWindow).__writes)).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });

// Same real Plans methods as the DOM suite, with shipped markup/styles and an
// intercepted synthetic origin. This cannot authorize a real plan operation.
const planEmployee = {
  id: '11111111-1111-4111-8111-111111111111',
  sessionId: '22222222-2222-4222-8222-222222222222',
  name: 'Synthetic plan employee',
};
async function planLayoutFixture(page: Page, respond: (route: Route) => Promise<void>) {
  const originalHtml = read('company-plans.html');
  const document = new JSDOM(originalHtml);
  document.window.document
    .querySelectorAll('script:not(#company-plans-bootstrap)')
    .forEach((el: Element) => el.remove());
  const html = document.serialize();
  document.window.close();
  const accounts = [
    { id: 'first', name: 'Original synthetic plan', provider: 'openai' },
    { id: 'second', name: 'Destination synthetic plan', provider: 'anthropic' },
  ];
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== 'https://plans-layout-fixture.test') return route.abort();
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
    if (url.pathname === '/company-board.css')
      return route.fulfill({ contentType: 'text/css', body: read('company-board.css') });
    if (url.pathname.startsWith('/api/plans/')) return respond(route);
    return route.abort();
  });
  await page.goto('https://plans-layout-fixture.test/');
  const methods = originalHtml.slice(
    originalHtml.indexOf('function planMemberHtml('),
    originalHtml.indexOf('// Codex banked resets:')
  );
  await page.addScriptTag({
    content: `const B={planBurn:${JSON.stringify(accounts)}};
      let planAllocations={employees:[${JSON.stringify(planEmployee)}],accounts:[]};
      let pendingPlanRequests=[],planMembersBusy=false,planMembersError=false;
      const fmt=()=>'', esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      ${methods}
      window.__openPlanMove=openPlanMove;
      window.__showPlanMove=record=>{
        const dialog=document.getElementById('moveDlg');
        dialog.showModal();showPlanMoveProgress(dialog,record,${JSON.stringify(planEmployee.name)});
      };`,
  });
}

type ForcePlanBody = { id: string; employeeId: string; sessionId: string; toAccount: string; handoff: string };
const forceWarning = `Force ${planEmployee.name} to move now? This skips their handoff approval. The current session is stopped before the replacement starts and becomes ready. Unfinished work may be interrupted, and downtime or recovery may be required.`;
const heldPlanMove = (id: string) => ({
  id,
  employeeId: planEmployee.id,
  oldSession: planEmployee.sessionId,
  newSession: '44444444-4444-4444-8444-444444444444',
  toAccount: 'second',
  phase: 'recovery-required',
  backend: 'docker',
  sourceCleanupVerified: true,
  allowedActions: ['continue-original'],
});
async function planConsumerFixture(page: Page, respond: (route: Route, pathname: string) => Promise<void>) {
  await planLayoutFixture(page, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/plans/moves/preview')
      return route.fulfill({
        json: { success: true, data: { account: 'first', mode: 'codex', sessionId: planEmployee.sessionId } },
      });
    if (pathname === '/api/plans/move-impact')
      return route.fulfill({ status: 503, json: { success: false, error: 'Synthetic estimate unavailable' } });
    if (pathname === '/api/plans/requests/recent') return route.fulfill({ json: { success: true, data: [] } });
    if (pathname === '/api/plans/allocations')
      return route.fulfill({ json: { success: true, data: { employees: [planEmployee], accounts: [] } } });
    return respond(route, pathname);
  });
}
async function openPlanConsumer(page: Page) {
  await page.evaluate(
    (id) =>
      (window as unknown as { __openPlanMove(id: string, destination: string): Promise<void> }).__openPlanMove(
        id,
        'second'
      ),
    planEmployee.id
  );
  return page.getByRole('dialog', { name: 'Move employee to another plan', exact: true });
}
async function planConsumerBounds(
  page: Page,
  panel: ReturnType<Page['getByRole']>,
  width: number,
  controls: string[],
  screenshot: string
) {
  const height = width === 320 ? 640 : 900;
  expect(await panel.evaluate((el) => el.scrollWidth > el.clientWidth + 1)).toBe(false);
  const bounds = await panel.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(height);
  for (const name of controls) {
    const control = panel.getByRole('button', { name, exact: true });
    await control.scrollIntoViewIfNeeded();
    const rect = await control.boundingBox();
    expect(rect).not.toBeNull();
    expect(rect!.height).toBeGreaterThanOrEqual(32);
    expect(rect!.x).toBeGreaterThanOrEqual(0);
    expect(rect!.x + rect!.width).toBeLessThanOrEqual(width);
    expect(rect!.y).toBeGreaterThanOrEqual(0);
    expect(rect!.y + rect!.height).toBeLessThanOrEqual(height);
  }
  if (process.env.TEST_RESOURCE_SCREENSHOT_DIR) {
    await mkdir(process.env.TEST_RESOURCE_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: join(process.env.TEST_RESOURCE_SCREENSHOT_DIR, screenshot + '-' + width + '.png') });
  }
}
function planTextContrast(foreground: string, background: string): number {
  const luminance = (color: string) => {
    const channels = color
      .match(/[\d.]+/g)!
      .slice(0, 3)
      .map(Number)
      .map((value) => {
        const channel = value / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
    return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
  };
  const a = luminance(foreground),
    b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
async function planConsumerBrowser(
  width: number,
  run: (page: Page) => Promise<void>,
  colorScheme: 'light' | 'dark' = 'light'
) {
  const browser = await chromium.launch({
    headless: true,
    chromiumSandbox: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {}),
  });
  try {
    const page = await browser.newPage({
      viewport: { width, height: width === 320 ? 640 : 900 },
      deviceScaleFactor: 1,
      colorScheme,
    });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
}

for (const colorScheme of ['light', 'dark'] as const)
  for (const width of [320, 1280])
    it(`distinguishes blocked force mutations from original-status inspection in ${colorScheme} at ${width}px`, async () => {
      await planConsumerBrowser(
        width,
        async (page) => {
          const writes: ForcePlanBody[] = [],
            reads: string[] = [];
          await planConsumerFixture(page, async (route, pathname) => {
            expect(route.request().method()).toBe('POST');
            if (pathname === '/api/plans/moves/force') {
              writes.push(route.request().postDataJSON());
              return route.abort('failed');
            }
            if (writes[0] && pathname === '/api/plans/moves/' + writes[0].id + '/status') {
              reads.push(pathname);
              return route.fulfill({ json: { success: true, data: heldPlanMove(writes[0].id) } });
            }
            throw Error('Unexpected themed force consumer request: ' + pathname);
          });
          const panel = await openPlanConsumer(page);
          expect(await page.locator('html').getAttribute('data-theme')).toBe(colorScheme);
          page.once('dialog', (dialog) => dialog.accept());
          await panel.getByRole('button', { name: 'Force move now', exact: true }).click();
          const inspect = panel.getByRole('button', { name: 'Check original move', exact: true });
          await inspect.waitFor();
          const appearance = await panel.evaluate((element) => {
            const style = (selector: string) => {
              const button = element.querySelector<HTMLButtonElement>(selector)!;
              const value = getComputedStyle(button);
              return {
                disabled: button.disabled,
                border: value.borderTopStyle,
                color: value.color,
                background: value.backgroundColor,
                cursor: value.cursor,
                opacity: value.opacity,
              };
            };
            return {
              request: style('[type="submit"]'),
              force: style('[data-force]'),
              inspect: style('[data-inspect]'),
              errorColor: getComputedStyle(element.querySelector('[role="alert"]')!).color,
              panelBackground: getComputedStyle(element).backgroundColor,
            };
          });
          for (const blocked of [appearance.request, appearance.force]) {
            expect(blocked.disabled).toBe(true);
            expect(blocked.border).toBe('dashed');
            expect(blocked.color).not.toBe(appearance.inspect.color);
            expect(blocked.background).not.toBe(appearance.inspect.background);
            expect(blocked.cursor).toBe('not-allowed');
            expect(blocked.opacity).toBe('1');
            expect(planTextContrast(blocked.color, blocked.background)).toBeGreaterThanOrEqual(4.5);
          }
          expect(appearance.inspect.disabled).toBe(false);
          expect(appearance.inspect.border).toBe('solid');
          expect(appearance.inspect.cursor).toBe('pointer');
          expect(planTextContrast(appearance.inspect.color, appearance.inspect.background)).toBeGreaterThanOrEqual(4.5);
          expect(planTextContrast(appearance.errorColor, appearance.panelBackground)).toBeGreaterThanOrEqual(4.5);
          await inspect.focus();
          await page.keyboard.press('Tab');
          expect(
            await panel
              .getByRole('button', { name: 'Cancel', exact: true })
              .evaluate((el) => el === document.activeElement)
          ).toBe(true);
          await page.keyboard.press('Shift+Tab');
          expect(
            await inspect.evaluate(
              (el) =>
                el.matches(':focus-visible') &&
                getComputedStyle(el).outlineStyle !== 'none' &&
                parseFloat(getComputedStyle(el).outlineWidth) >= 1
            )
          ).toBe(true);
          await planConsumerBounds(
            page,
            panel,
            width,
            ['Check original move', 'Cancel'],
            'plan-force-disabled-' + colorScheme
          );
          if (process.env.TEST_RESOURCE_SCREENSHOT_DIR)
            await writeFile(
              join(process.env.TEST_RESOURCE_SCREENSHOT_DIR, `plan-force-disabled-${colorScheme}-${width}.json`),
              JSON.stringify({ colorScheme, width, appearance }, null, 2) + '\n'
            );
          expect(writes).toHaveLength(1);
          expect(reads).toEqual([]);
          await page.keyboard.press('Enter');
          await panel.getByRole('button', { name: 'Recover original move', exact: true }).waitFor();
          expect(reads).toEqual(['/api/plans/moves/' + writes[0]!.id + '/status']);
          expect(writes).toHaveLength(1);
          const readbackText = await panel
            .locator('[data-move-sessions], [data-recovery-info]')
            .evaluateAll((elements) =>
              elements.map((element) => ({
                text: element.textContent,
                color: getComputedStyle(element).color,
                background: getComputedStyle(element.closest('dialog')!).backgroundColor,
                opacity: getComputedStyle(element).opacity,
              }))
            );
          for (const value of readbackText) {
            expect(value.text).toBeTruthy();
            expect(value.opacity).toBe('1');
            expect(planTextContrast(value.color, value.background)).toBeGreaterThanOrEqual(4.5);
          }
          expect(readbackText[0]!.text).toContain(planEmployee.sessionId);
          expect(readbackText[0]!.text).toContain(heldPlanMove(writes[0]!.id).newSession);
          expect(await panel.getByRole('status').textContent()).toBe('Recovery required');
          await planConsumerBounds(
            page,
            panel,
            width,
            ['Recover original move', 'Refresh status'],
            'plan-force-readback-' + colorScheme
          );
          if (process.env.TEST_RESOURCE_SCREENSHOT_DIR)
            await writeFile(
              join(process.env.TEST_RESOURCE_SCREENSHOT_DIR, `plan-force-readback-${colorScheme}-${width}.json`),
              JSON.stringify(
                {
                  colorScheme,
                  width,
                  text: readbackText.map((value) => ({
                    ...value,
                    contrast: planTextContrast(value.color, value.background),
                  })),
                },
                null,
                2
              ) + '\n'
            );
        },
        colorScheme
      );
    });

// Actual Chromium consumers of the shipped Plans closure, with closed synthetic
// API replies. These assert user actions/protocol scope, not native move effects.
for (const width of [320, 1280]) {
  it(`declines the actual force warning without sending a force operation at ${width}px`, async () => {
    await planConsumerBrowser(width, async (page) => {
      const writes: string[] = [],
        warnings: string[] = [];
      await planConsumerFixture(page, async (route, pathname) => {
        writes.push(pathname);
        return route.fulfill({ status: 500, json: { success: false, error: 'Unexpected business request' } });
      });
      const panel = await openPlanConsumer(page);
      page.once('dialog', async (dialog) => {
        warnings.push(dialog.message());
        await dialog.dismiss();
      });
      await panel.getByRole('button', { name: 'Force move now', exact: true }).click();
      expect(warnings).toEqual([forceWarning]);
      expect(writes).toEqual([]);
      expect(await panel.getByRole('button', { name: 'Force move now', exact: true }).isEnabled()).toBe(true);
      expect(await panel.getByRole('button', { name: 'Request move', exact: true }).isEnabled()).toBe(true);
      await planConsumerBounds(page, panel, width, ['Force move now', 'Cancel'], 'plan-force-declined');
    });
  });

  it(`accepts the force warning as one original operation and blocks duplicate GUI submission at ${width}px`, async () => {
    await planConsumerBrowser(width, async (page) => {
      const writes: ForcePlanBody[] = [],
        warnings: string[] = [];
      let release = () => {};
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      await planConsumerFixture(page, async (route, pathname) => {
        if (pathname === '/api/plans/moves/force') {
          expect(route.request().method()).toBe('POST');
          writes.push(route.request().postDataJSON());
          await pending;
          return route.fulfill({ status: 202, json: { success: true, data: heldPlanMove(writes[0]!.id) } });
        }
        throw Error('Unexpected force consumer request: ' + pathname);
      });
      try {
        const panel = await openPlanConsumer(page),
          force = panel.getByRole('button', { name: 'Force move now', exact: true });
        page.once('dialog', async (dialog) => {
          warnings.push(dialog.message());
          await dialog.accept();
        });
        await force.click();
        await expect.poll(() => writes.length).toBe(1);
        expect(warnings).toEqual([forceWarning]);
        expect(await force.isDisabled()).toBe(true);
        expect(await panel.getByRole('button', { name: 'Request move', exact: true }).isDisabled()).toBe(true);
        await force.evaluate((button) => (button as HTMLButtonElement).click());
        expect(writes).toHaveLength(1);
        expect(writes[0]).toEqual({
          id: expect.stringMatching(/^force-[a-f0-9]{32}$/),
          employeeId: planEmployee.id,
          sessionId: planEmployee.sessionId,
          toAccount: 'second',
          handoff:
            'The owner forced this plan move without waiting for a fresh handoff. Continue as the same employee using your existing identity, workspace and memory. Inspect saved checkpoints and recent owner messages before resuming; do not repeat uncertain side effects.',
        });
        release();
        await panel.getByRole('button', { name: 'Recover original move', exact: true }).waitFor();
        expect(await panel.locator('[data-move-sessions]').textContent()).toContain(planEmployee.sessionId);
        await planConsumerBounds(
          page,
          panel,
          width,
          ['Recover original move', 'Refresh status'],
          'plan-force-accepted'
        );
        expect(writes).toHaveLength(1);
      } finally {
        release();
      }
    });
  });

  it(`retains a lost force reply and checks only the original ID without blind replay at ${width}px`, async () => {
    await planConsumerBrowser(width, async (page) => {
      const writes: ForcePlanBody[] = [],
        reads: string[] = [];
      await planConsumerFixture(page, async (route, pathname) => {
        if (pathname === '/api/plans/moves/force') {
          expect(route.request().method()).toBe('POST');
          writes.push(route.request().postDataJSON());
          return route.abort('failed');
        }
        if (writes[0] && pathname === '/api/plans/moves/' + writes[0].id + '/status') {
          expect(route.request().method()).toBe('POST');
          reads.push(pathname);
          const record = heldPlanMove(writes[0].id);
          return route.fulfill({
            json: {
              success: true,
              data: reads.length === 1 ? { ...record, employeeId: '99999999-9999-4999-8999-999999999999' } : record,
            },
          });
        }
        throw Error('Unexpected lost-force consumer request: ' + pathname);
      });
      const panel = await openPlanConsumer(page);
      page.once('dialog', (dialog) => dialog.accept());
      await panel.getByRole('button', { name: 'Force move now', exact: true }).click();
      const inspect = panel.getByRole('button', { name: 'Check original move', exact: true });
      await inspect.waitFor();
      expect(writes).toHaveLength(1);
      expect(reads).toEqual([]);
      expect(await panel.getByRole('alert').textContent()).toContain(writes[0]!.id);
      expect(await panel.getByRole('button', { name: 'Force move now', exact: true }).isDisabled()).toBe(true);
      expect(await panel.getByRole('button', { name: 'Request move', exact: true }).isDisabled()).toBe(true);
      await planConsumerBounds(page, panel, width, ['Check original move', 'Cancel'], 'plan-force-original-unknown');
      await inspect.click();
      await expect.poll(() => panel.getByRole('alert').textContent()).toContain('original record scope changed');
      expect(reads).toEqual(['/api/plans/moves/' + writes[0]!.id + '/status']);
      expect(writes).toHaveLength(1);
      await inspect.click();
      await panel.getByRole('button', { name: 'Recover original move', exact: true }).waitFor();
      expect(reads).toEqual(Array(2).fill('/api/plans/moves/' + writes[0]!.id + '/status'));
      expect(writes).toHaveLength(1);
    });
  });

  it(`recovers only an explicitly confirmed original Docker move and rechecks its exact tuple at ${width}px`, async () => {
    await planConsumerBrowser(width, async (page) => {
      const move = heldPlanMove('33333333-3333-4333-8333-333333333333');
      const order: string[] = [],
        writes: Array<{ path: string; body: unknown }> = [];
      let foreign = true,
        release = () => {};
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      await planConsumerFixture(page, async (route, pathname) => {
        order.push(pathname);
        if (pathname === '/api/plans/moves/' + move.id + '/status') {
          expect(route.request().method()).toBe('POST');
          return route.fulfill({
            json: {
              success: true,
              data: foreign ? { ...move, newSession: '99999999-9999-4999-8999-999999999999' } : move,
            },
          });
        }
        if (pathname === '/api/plans/moves/' + move.id + '/resolve') {
          expect(route.request().method()).toBe('POST');
          writes.push({ path: pathname, body: route.request().postDataJSON() });
          await pending;
          return route.fulfill({
            status: 202,
            json: {
              success: true,
              data: { ...move, phase: 'completed', allowedActions: [], sourceViewRetirement: { state: 'completed' } },
            },
          });
        }
        throw Error('Unexpected recovery consumer request: ' + pathname);
      });
      try {
        await page.evaluate(
          (record) => (window as unknown as { __showPlanMove(record: unknown): void }).__showPlanMove(record),
          move
        );
        const panel = page.getByRole('dialog', { name: 'Move employee to another plan', exact: true });
        const recover = panel.getByRole('button', { name: 'Recover original move', exact: true });
        expect(await recover.isEnabled()).toBe(true);
        expect(writes).toEqual([]);
        expect(order).toEqual([]);
        await recover.click();
        await expect.poll(() => panel.getByRole('status').textContent()).toContain('Recovery was not requested');
        expect(writes).toEqual([]);
        expect(order).toEqual(['/api/plans/moves/' + move.id + '/status']);
        foreign = false;
        await panel.getByRole('button', { name: 'Refresh status', exact: true }).click();
        await expect.poll(() => recover.isEnabled()).toBe(true);
        await planConsumerBounds(page, panel, width, ['Recover original move', 'Refresh status'], 'plan-held-recovery');
        await recover.click();
        await expect.poll(() => writes.length).toBe(1);
        expect(order.slice(-2)).toEqual([
          '/api/plans/moves/' + move.id + '/status',
          '/api/plans/moves/' + move.id + '/resolve',
        ]);
        expect(writes).toEqual([
          {
            path: '/api/plans/moves/' + move.id + '/resolve',
            body: {
              action: 'continue-original',
              oldSession: move.oldSession,
              newSession: move.newSession,
              toAccount: move.toAccount,
            },
          },
        ]);
        expect(await recover.isDisabled()).toBe(true);
        release();
        await panel.waitFor({ state: 'hidden' });
        expect(writes).toHaveLength(1);
      } finally {
        release();
      }
    });
  });
}
for (const width of [320, 1280])
  it(`keeps an unknown original plan request accessible at ${width}px`, async () => {
    const browser = await chromium.launch({
      headless: true,
      chromiumSandbox: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
    try {
      const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const employee = planEmployee;
      const sent: Array<{ path: string; body: { id: string } }> = [];
      await planLayoutFixture(page, async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === '/api/plans/moves/preview')
          return route.fulfill({
            json: { success: true, data: { account: 'first', mode: 'codex', sessionId: employee.sessionId } },
          });
        if (url.pathname === '/api/plans/requests') {
          sent.push({ path: url.pathname, body: route.request().postDataJSON() });
          return route.fulfill({
            status: 500,
            json: {
              success: false,
              error: {
                code: 'OPERATION_FAILED',
                message:
                  'The original request response could not be confirmed. Check the original request before another change.',
              },
            },
          });
        }
        return route.fulfill({ status: 404, json: { success: false, error: 'Synthetic observation unavailable' } });
      });
      await page.evaluate(
        (id) =>
          (window as unknown as { __openPlanMove(id: string, account: string): Promise<void> }).__openPlanMove(
            id,
            'second'
          ),
        employee.id
      );
      const dialog = page.getByRole('dialog', { name: 'Move employee to another plan', exact: true });
      await dialog.getByRole('button', { name: 'Request move', exact: true }).click();
      const inspect = dialog.getByRole('button', { name: 'Check original request', exact: true });
      await inspect.waitFor();
      expect(sent).toHaveLength(1);
      expect(await dialog.getByRole('alert').textContent()).toContain(sent[0]!.body.id);
      expect(await dialog.getByRole('button', { name: 'Force move now', exact: true }).isDisabled()).toBe(true);
      expect(await dialog.getByRole('button', { name: 'Request move', exact: true }).isDisabled()).toBe(true);
      const geometry = await dialog.evaluate((el) => ({
        ratio: window.devicePixelRatio,
        overflow: el.scrollWidth > el.clientWidth + 1,
      }));
      expect(geometry.ratio).toBe(1);
      expect(geometry.overflow).toBe(false);
      expect(await inspect.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(32); // Existing Plans button baseline.
      await inspect.click({ trial: true });
      if (process.env.TEST_RESOURCE_SCREENSHOT_DIR) {
        await mkdir(process.env.TEST_RESOURCE_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({
          path: join(process.env.TEST_RESOURCE_SCREENSHOT_DIR, `plan-original-unknown-${width}.png`),
        });
      }
      expect(sent).toHaveLength(1); // Trial click never repeats the mutation or consumes a status.
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });

// A completed move and its source-view cleanup are separate facts. Exercise
// the shipped progress client in Chromium; all replies below remain synthetic.
for (const { width, colorScheme } of [320, 1280].flatMap((width) =>
  (['light', 'dark'] as const).map((colorScheme) => ({ width, colorScheme }))
))
  it(`keeps completed plan cleanup visible and requires an explicit lost-reply retry in ${colorScheme} at ${width}px`, async () => {
    const browser = await chromium.launch({
      headless: true,
      chromiumSandbox: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
    let releaseRefresh = () => {},
      releaseCleanup = () => {};
    try {
      const height = width === 320 ? 640 : 900;
      const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const move = {
        id: '33333333-3333-4333-8333-333333333333',
        employeeId: planEmployee.id,
        oldSession: planEmployee.sessionId,
        newSession: '44444444-4444-4444-8444-444444444444',
        phase: 'completed',
        toAccount: 'second',
        backend: 'docker',
      };
      let posts = 0;
      let pauseRefresh = false;
      let refreshEntered = false,
        cleanupEntered = false;
      const refreshReply = new Promise<void>((resolve) => (releaseRefresh = resolve));
      const cleanupReply = new Promise<void>((resolve) => (releaseCleanup = resolve));
      const writes: Array<{ path: string; body: unknown }> = [];
      const held = {
        ...move,
        sourceViewRetirement: { state: 'unconfirmed', error: 'Previous terminal cleanup unconfirmed' },
        allowedActions: ['continue-original'],
      };
      await planLayoutFixture(page, async (route) => {
        const request = route.request(),
          path = new URL(request.url()).pathname;
        const reply = (data: unknown) => route.fulfill({ json: { success: true, data } });
        if (path === `/api/plans/moves/${move.id}/status`) {
          if (pauseRefresh) {
            refreshEntered = true;
            await refreshReply;
          }
          return reply(held);
        }
        if (path === `/api/plans/moves/${move.id}/resolve`) {
          writes.push({ path, body: request.postDataJSON() });
          if (++posts === 1)
            return route.fulfill({ status: 503, json: { success: false, error: 'Cleanup reply lost' } });
          cleanupEntered = true;
          await cleanupReply;
          return reply({ ...move, sourceViewRetirement: { state: 'completed' }, allowedActions: [] });
        }
        if (path === '/api/plans/requests/recent') return reply([]);
        if (path === '/api/plans/allocations') return reply({ employees: [planEmployee], accounts: [] });
        throw Error('Unexpected plan fixture request: ' + path);
      });
      await page.evaluate(
        (record) => (window as unknown as { __showPlanMove(record: unknown): void }).__showPlanMove(record),
        { ...move, sourceViewRetirement: { state: 'pending' }, allowedActions: [] }
      );
      const dialog = page.getByRole('dialog', { name: 'Move employee to another plan', exact: true });
      expect(await dialog.isVisible()).toBe(true); // It must survive pending post-publication cleanup.
      const clean = dialog.getByRole('button', { name: 'Clean up previous terminal', exact: true });
      await clean.waitFor(); // Normal polling discovers the API-approved original action.
      expect(writes).toEqual([]);
      await clean.click();
      await expect.poll(() => dialog.getByRole('status').textContent()).toContain('Recovery outcome unconfirmed');
      const statusText = await dialog.getByRole('status').textContent();
      expect(statusText).toMatch(/^Plan moved/);
      expect(statusText!.match(/Previous terminal cleanup unconfirmed/g)).toHaveLength(1);
      expect(statusText).not.toContain('refresh status without replaying');
      expect(await page.locator('html').getAttribute('data-theme')).toBe(colorScheme);
      expect(await clean.isDisabled()).toBe(true);
      expect(posts).toBe(1);
      const statusBounds = await dialog.getByRole('status').boundingBox();
      expect(statusBounds).not.toBeNull();
      expect(statusBounds!.y).toBeGreaterThanOrEqual(0);
      expect(statusBounds!.y + statusBounds!.height).toBeLessThanOrEqual(height);
      if (process.env.TEST_RESOURCE_SCREENSHOT_DIR) {
        await mkdir(process.env.TEST_RESOURCE_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({
          path: join(process.env.TEST_RESOURCE_SCREENSHOT_DIR, `plan-cleanup-lost-reply-${colorScheme}-${width}.png`),
        });
      }
      pauseRefresh = true;
      await dialog.getByRole('button', { name: 'Refresh status', exact: true }).click();
      await expect.poll(() => refreshEntered).toBe(true);
      expect(await dialog.isVisible()).toBe(true);
      expect(await clean.isDisabled()).toBe(true);
      expect(posts).toBe(1);
      pauseRefresh = false;
      releaseRefresh();
      await expect.poll(() => clean.isEnabled()).toBe(true);
      expect(posts).toBe(1); // Observation cannot dispatch the cleanup again.
      expect(await dialog.evaluate((element) => element.scrollWidth > element.clientWidth + 1)).toBe(false);
      for (const control of [clean, dialog.getByRole('button', { name: 'Refresh status', exact: true })]) {
        const bounds = await control.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.height).toBeGreaterThanOrEqual(32);
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(height);
      }
      if (process.env.TEST_RESOURCE_SCREENSHOT_DIR) {
        await mkdir(process.env.TEST_RESOURCE_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({
          path: join(process.env.TEST_RESOURCE_SCREENSHOT_DIR, `plan-completed-cleanup-${colorScheme}-${width}.png`),
        });
      }
      await clean.click();
      await expect.poll(() => cleanupEntered).toBe(true);
      expect(await dialog.isVisible()).toBe(true);
      expect(await clean.isDisabled()).toBe(true);
      expect(posts).toBe(2);
      releaseCleanup();
      await dialog.waitFor({ state: 'hidden' });
      expect(posts).toBe(2);
      expect(writes.map(({ body }) => body)).toEqual([
        {
          action: 'continue-original',
          oldSession: move.oldSession,
          newSession: move.newSession,
          toAccount: move.toAccount,
        },
        {
          action: 'continue-original',
          oldSession: move.oldSession,
          newSession: move.newSession,
          toAccount: move.toAccount,
        },
      ]);
      expect(errors).toEqual([]);
    } finally {
      releaseRefresh();
      releaseCleanup();
      await browser.close();
    }
  });
