import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { chromium } from 'playwright';
import { COMPANY_ROLE_TEMPLATES } from '../src/company-role-templates.js';
import { createServer, member, room, message } from './helpers/chat-app-harness.mjs';

it('uses the real Chromium wizard through editable role, identity, work, review, cancel and a fixture hire', async () => {
  const publicDir = resolve(import.meta.dirname, '../src/web/public');
  const read = (name: string) => readFileSync(resolve(publicDir, name), 'utf8');
  const harness = readFileSync(resolve(import.meta.dirname, 'helpers/chat-app-harness.mjs'), 'utf8');
  const appStub = harness.match(/window\.eval\(`([\s\S]*?)`\);/)![1];
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html data-skin="daylight-blue"><head></head><body></body></html>' }));
    await page.goto('https://hire-fixture.test/');
    for (const name of ['styles.css', 'chat-app.css']) await page.addStyleTag({ content: read(name) });
    await page.addScriptTag({ content: `
      ${member.toString()} ${room.toString()} ${message.toString()} ${createServer.toString()}
      const user={kind:'user',name:'Owner'};
      window.ReverieUrlSession={sessionIdFromFragment:()=>null};
      window.__server=createServer([room('general','General',[])]);
      window.__hires=[];
      window.__server.company={canManage:true,employees:[],settings:{ownerName:'Owner'}};
      const original=window.__server.handle;
      window.__server.handle=async(path,opts={})=>{
        const ok=data=>({ok:true,status:200,json:async()=>({success:true,data})});
        if(path==='/api/chatrooms/phone-status')return ok({self:'owner',canSetOwn:true});
        if(path==='/api/company/hire-options')return ok({roles:${JSON.stringify(COMPANY_ROLE_TEMPLATES)},harnesses:[{id:'codex',label:'Codex'}],sources:[{id:'fixture',kind:'subscription',label:'Fixture plan',modes:['codex'],defaultMode:'codex'}]});
        if(path==='/api/voice/options')return ok({voices:[]});
        if(path==='/api/company/hire'){window.__hires.push(opts.body);const employee={...opts.body,id:'fixture-person',sessionId:'fixture-runtime',available:true};window.__server.company.employees.push(employee);return ok({employee,sessionId:employee.sessionId});}
        return original(path,opts);
      };
      window.fetch=async()=>({ok:true,json:async()=>({avatars:[]})});
      ${appStub}
    ` });
    for (const name of ['chatroom-ui.js', 'chat-media.js']) await page.addScriptTag({ content: read(name) });
    await page.addScriptTag({ content: 'window.app=new ReverieApp();' });
    await page.addScriptTag({ content: read('chat-app.js') });
    await page.waitForSelector('.ca-rail');
    await page.evaluate(() => (window as any).reverieChat.openCompany('people'));
    const plus = page.locator('.ca-company-people-heading').getByRole('button', { name: 'Hire', exact: true });
    await plus.click();
    const wizard = page.locator('.ca-company-hire');
    const cancel = wizard.getByRole('button', { name: 'Cancel hire', exact: true });
    for (let step = 0; step < 4; step++) {
      expect(await cancel.isVisible()).toBe(true);
      expect(await wizard.locator('.ca-hire-progress').textContent()).toContain(`Step ${step + 1}`);
      if (step === 0) { await wizard.locator('[name=roleTemplate]').selectOption('software'); await wizard.locator('[name=position]').fill('Flight software engineer'); await wizard.locator('[name=responsibilities]').fill('Review recorded flight data'); }
      if (step === 1) { await wizard.locator('[name=name]').fill('Rowan'); await wizard.locator('[name=personality]').fill('Patient and precise'); }
      if (step === 2) { await wizard.locator('[name=plan]').selectOption('subscription:fixture'); await wizard.locator('[name=managePlans]').check(); await wizard.locator('[name=moveOwnPlan]').check(); }
      if (step < 3) await wizard.getByRole('button', { name: 'Next', exact: true }).click();
    }
    expect(await wizard.locator('.ca-hire-review').textContent()).toContain('Flight software engineer');
    expect(await page.evaluate(() => (window as any).__hires.length)).toBe(0);
    if (process.env.TEST_WIZARD_SCREENSHOT) await page.screenshot({ path: process.env.TEST_WIZARD_SCREENSHOT, fullPage: true });
    await cancel.click(); expect(await wizard.isVisible()).toBe(false);
    expect(await plus.getAttribute('aria-expanded')).toBe('false');
    expect(await page.evaluate(() => (window as any).__hires.length)).toBe(0);
    await plus.click();
    expect(await wizard.locator('.ca-hire-review').textContent()).toContain('Patient and precise');
    await wizard.locator('button[type=submit]').click();
    await page.locator('.ca-company-chart').getByText('Rowan', { exact: true }).waitFor();
    const bodies = await page.evaluate(() => (window as any).__hires);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ name: 'Rowan', position: 'Flight software engineer', responsibilities: ['Review recorded flight data'], personality: 'Patient and precise', mode: 'codex', source: { kind: 'subscription', profileId: 'fixture' }, permissions: { recoverEmployees: false, moveOwnPlan: true, managePlans: true, editBoardIssues: true, manageBoard: false, manageDecisions: false } });
    expect(bodies[0]).not.toHaveProperty('model'); expect(bodies[0]).not.toHaveProperty('effort');
  } finally { await browser.close(); }
});
