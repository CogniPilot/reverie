import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { expect, it } from 'vitest';
import { chromium } from 'playwright';
import { createServer, member, room, message } from './helpers/chat-app-harness.mjs';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
const read = (name: string) => readFileSync(resolve(publicDir, name), 'utf8');
const harness = readFileSync(resolve(import.meta.dirname, 'helpers/chat-app-harness.mjs'), 'utf8');
const appStub = harness.match(/window\.eval\(`([\s\S]*?)`\);/)![1];

for (const width of [1280, 390]) it(`keeps profile actions usable and adds and grants a PAT explicitly at ${width}px`, async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head></head><body></body></html>' }));
    await page.goto('https://profile-fixture.test/');
    for (const name of ['styles.css', 'chat-app.css']) await page.addStyleTag({ content: read(name) });
    await page.addScriptTag({ content: `
      ${member.toString()} ${room.toString()} ${message.toString()} ${createServer.toString()}
      const user={kind:'user',name:'Owner'};
      window.ReverieUrlSession={sessionIdFromFragment:()=>null};
      window.__server=createServer([room('general','General',[])]);
      window.__writes=[]; const tokens=[];
      const employee={id:'publisher',sessionId:'runtime',sessionGeneration:2,name:'Publisher',position:'Coordinator',
        expertise:[],responsibilities:[],permissions:{publicationTokenIds:[]},
        effectiveBoardPermissions:{editBoardIssues:true,manageBoard:true,manageDecisions:true},
        boardPermissionSources:{editBoardIssues:'explicit',manageBoard:'explicit',manageDecisions:'explicit'}};
      window.__server.company={canManage:true,employees:[employee],settings:{ownerName:'Owner'}};
      const original=window.__server.handle;
      window.__server.handle=async(path,opts={})=>{
        const ok=data=>({ok:true,status:200,json:async()=>({success:true,data})});
        if(path==='/api/chatrooms/phone-status')return ok({self:'owner',canSetOwn:true});
        if(path==='/api/publication/tokens' && (!opts.method || opts.method==='GET'))return ok({tokens:structuredClone(tokens)});
        if(path==='/api/publication/tokens' && opts.method==='POST'){
          window.__writes.push({path,method:opts.method,body:{...opts.body}});
          const token={id:'00000001-0001-4001-8001-000000000001',name:opts.body.name,repositories:opts.body.repositories,createdAt:1,updatedAt:1};
          tokens.push(token);return ok({token});
        }
        if(path==='/api/company/employees/publisher/publication-tokens/00000001-0001-4001-8001-000000000001'){
          window.__writes.push({path,method:opts.method,body:{...opts.body}});
          employee.permissions.publicationTokenIds=opts.body.enabled?['00000001-0001-4001-8001-000000000001']:[];
          return ok({employee:structuredClone(employee)});
        }
        return original(path,opts);
      };
      window.fetch=async()=>({ok:true,json:async()=>({avatars:[]})});
      ${appStub}
    ` });
    for (const name of ['chatroom-ui.js', 'chat-media.js']) await page.addScriptTag({ content: read(name) });
    await page.addScriptTag({ content: 'window.app=new ReverieApp();' });
    await page.addScriptTag({ content: read('chat-app.js') });
    await page.waitForSelector('.ca-rail', { state: 'attached' });
    await page.evaluate(() => (window as any).reverieChat.openCompany('people'));
    await page.getByRole('button', { name:'Edit profile for Publisher', exact:true }).click();
    const profile = page.getByRole('dialog', { name:'Edit profile: Publisher', exact:true });
    await profile.getByRole('tab', { name:'Permissions', exact:true }).click();
    const bounds = await profile.evaluate(element => {
      const body=element.querySelector('.ca-profile-editor-body')!, footer=element.querySelector('.ca-profile-footer')!;
      return { bodyBottom:body.getBoundingClientRect().bottom, footerTop:footer.getBoundingClientRect().top,
        dialogBottom:element.getBoundingClientRect().bottom, height:innerHeight };
    });
    expect(bounds.bodyBottom).toBeLessThanOrEqual(bounds.footerTop + 1);
    expect(bounds.dialogBottom).toBeLessThanOrEqual(bounds.height);
    const patTab=profile.getByRole('tab', { name:'GitHub PATs', exact:true });
    expect((await patTab.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await patTab.click();
    const manage=profile.getByRole('button', { name:'Manage PATs', exact:true });
    expect(await manage.isVisible()).toBe(true);
    expect(await page.evaluate(() => (window as any).__writes)).toEqual([]);
    const manageBox = (await manage.boundingBox())!;
    await page.mouse.click(manageBox.x + manageBox.width / 2, manageBox.y + manageBox.height / 2);
    const tokensDialog=page.getByRole('region', { name:'Manage PATs', exact:true });
    const editorBounds = await tokensDialog.evaluate(element => ({
      right: element.getBoundingClientRect().right,
      closeRight: element.querySelector('[aria-label="Close Manage PATs"]')!.getBoundingClientRect().right,
      bodyRight: element.closest('.ca-profile-editor-body')!.getBoundingClientRect().right,
    }));
    expect(editorBounds.right).toBeLessThanOrEqual(editorBounds.bodyRight);
    expect(editorBounds.closeRight).toBeLessThanOrEqual(editorBounds.bodyRight);
    if(process.env.TEST_PAT_SCREENSHOT_DIR){
      await mkdir(process.env.TEST_PAT_SCREENSHOT_DIR,{recursive:true});
      await page.screenshot({path:join(process.env.TEST_PAT_SCREENSHOT_DIR,`profile-pat-form-${width}.png`)});
    }
    await tokensDialog.getByLabel('PAT name', { exact:true }).fill('Invalid Name');
    expect(await tokensDialog.getByLabel('PAT name', { exact:true }).evaluate((input:HTMLInputElement)=>input.checkValidity())).toBe(false);
    await tokensDialog.getByLabel('PAT name', { exact:true }).fill('release-pat');
    await tokensDialog.getByLabel('Declared repositories (optional)').fill('example/repository');
    await tokensDialog.getByLabel('PAT value (write-only)').fill('FAKE_BROWSER_TEST_PAT');
    await tokensDialog.getByRole('button', { name:'Add PAT', exact:true }).click();
    await page.waitForFunction(() => (window as any).__writes.length===1);
    expect(await tokensDialog.getByLabel('PAT value (write-only)').inputValue()).toBe('');
    expect(await tokensDialog.textContent()).not.toContain('FAKE_BROWSER_TEST_PAT');
    await tokensDialog.getByRole('button', { name:'Close Manage PATs', exact:true }).click();
    const grant=profile.getByRole('checkbox', { name:'Access to release-pat for Publisher', exact:true });
    await grant.waitFor(); expect(await grant.isChecked()).toBe(false);
    await grant.check();
    await page.waitForFunction(() => (window as any).__writes.length===2);
    const writes=await page.evaluate(() => (window as any).__writes);
    expect(writes[1]).toEqual({path:'/api/company/employees/publisher/publication-tokens/00000001-0001-4001-8001-000000000001',method:'PUT',body:{enabled:true}});
    expect(await profile.textContent()).toContain('PAT access saved.');
    if(process.env.TEST_PAT_SCREENSHOT_DIR){
      await mkdir(process.env.TEST_PAT_SCREENSHOT_DIR,{recursive:true});
      await page.screenshot({path:join(process.env.TEST_PAT_SCREENSHOT_DIR,`profile-pat-${width}.png`)});
    }
  } finally { await browser.close(); }
});
