import {writeFileSync} from 'node:fs';
import {afterAll,afterEach,beforeAll,beforeEach,expect,it} from 'vitest';
import {chromium,type Browser,type Page} from 'playwright';
import {startEmbassyPreview} from './helpers/embassy-preview.mjs';
let browser:Browser,page:Page,preview:any;let pageErrors:string[]=[];
const key='embassy-v1|https://relay.example.test:8443|'+'A'.repeat(43);
const fragment='#'+new URLSearchParams({embassy:'1',host:'https://relay.example.test:8443',key}).toString();
beforeAll(async()=>{preview=await startEmbassyPreview();browser=await chromium.launch({headless:true});});
afterAll(async()=>{await page?.close();await browser?.close();await preview?.close();});
beforeEach(async()=>{await page?.close();pageErrors=[];page=await browser.newPage({viewport:{width:1280,height:800}});page.on('pageerror',error=>pageErrors.push(error.message));await page.goto(preview.url,{waitUntil:'domcontentloaded'});await page.waitForSelector('.eg-channel');});
afterEach(()=>expect(pageErrors).toEqual([]));
it('tab → room uses the actual channel feed/composer, sends text/emoji and supports Disable',async()=>{
 await page.evaluate(()=>{window.__feed=window.app._chatEls.feed;window.__composer=window.app._chatEls.composer;});
 await page.locator('[data-key="page:embassies"]').click();await page.locator('.eg-directory-room').click();await page.waitForSelector('.eg-post');
 expect(await page.evaluate(()=>window.__feed===window.reverieChat.embassy.feed&&window.__composer===window.reverieChat.embassy.form)).toBe(true);
 expect(await page.locator('.ca-page iframe').count()).toBe(0);expect(page.url()).not.toContain('/embassy/');expect(await page.locator('.eg-feed').textContent()).toContain('UNTRUSTED EXTERNAL');
 await page.locator('.eg-input').fill('Hello companies 😃');await page.locator('.chatroom-send').click();await page.waitForFunction(()=>document.querySelector('.eg-feed')?.textContent.includes('Hello companies 😃'));
 expect(await page.evaluate(()=>window.__server.posts.length)).toBe(0);
 const own=page.locator('.eg-post').filter({hasText:'Hello companies 😃'});expect(await own.locator('.eg-own').textContent()).toBe('Sent from this console');expect(await own.locator('.eg-trust').count()).toBe(0);
 await page.getByRole('button',{name:'Disable',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.eg-status')?.textContent==='Disabled here');expect(await page.locator('.chatroom-send').isDisabled()).toBe(true);
 if(process.env.EMBASSY_UI_SCREENSHOT_DIR)await page.screenshot({path:process.env.EMBASSY_UI_SCREENSHOT_DIR+'/embassy-tab-desktop.png'});
});
it('real local encoder → PNG → real local decoder stages the exact key without automatic join',async()=>{
 await page.getByRole('button',{name:'Add embassy channel',exact:true}).click();await page.getByLabel('Invite key',{exact:true}).fill(key);await page.getByRole('button',{name:'Show QR',exact:true}).click();await page.locator('.eg-qr-canvas').waitFor({state:'visible'});
 const encoded=await page.locator('.eg-qr-canvas').evaluate((c:any)=>c.toDataURL('image/png'));
 expect(await page.locator('.eg-share-link').inputValue()).toContain(fragment);
 await page.getByRole('button',{name:'Cancel',exact:true}).click();await page.getByRole('button',{name:'Add embassy channel',exact:true}).click();await page.getByRole('button',{name:'Scan/paste link',exact:true}).click();
 await page.locator('.eg-qr-file').setInputFiles({name:'synthetic-invite.png',mimeType:'image/png',buffer:Buffer.from(encoded.split(',')[1],'base64')});
 await page.waitForFunction(()=>document.querySelector('.eg-key')?.value.startsWith('embassy-v1|'));expect(await page.locator('.eg-key').inputValue()).toBe(key);
 expect(await page.evaluate(()=>window.__eg.calls.filter(c=>c.method==='POST').length)).toBe(0);
 expect(JSON.stringify(preview.requests)).not.toContain('A'.repeat(43));expect(await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}))).not.toContain(key);
});
it('startup fragments are scrubbed before any action and require explicit host confirmation',async()=>{
 await page.goto(preview.url+'/'+fragment,{waitUntil:'domcontentloaded'});await page.locator('.eg-dialog').waitFor();expect(new URL(page.url()).hash).toBe('');expect(await page.evaluate(()=>window.__atAppConstruction)).toBe('');expect(await page.locator('script[src*="chat-app.js"]').count()).toBe(1);expect(await page.locator('.eg-key').inputValue()).toBe(key);
 expect(await page.evaluate(()=>window.__eg.calls.filter(c=>c.method==='POST').length)).toBe(0);expect(JSON.stringify(preview.requests)).not.toContain('A'.repeat(43));
 await page.getByRole('button',{name:'Check host',exact:true}).click();await page.getByRole('button',{name:'Connect',exact:true}).waitFor();expect(await page.evaluate(()=>window.__eg.calls.filter(c=>c.path.endsWith('/join')).length)).toBe(0);
 await page.getByRole('button',{name:'Connect',exact:true}).click();await page.locator('.eg-view').waitFor();expect(new URL(page.url()).origin).toBe(preview.url);
});
it('camera denial keeps paste usable and a hostile/mismatched URL is never navigated',async()=>{
 await page.evaluate(()=>Object.defineProperty(navigator,'mediaDevices',{value:undefined,configurable:true}));
 await page.getByRole('button',{name:'Add embassy channel',exact:true}).click();await page.getByRole('button',{name:'Scan/paste link',exact:true}).click();await page.getByRole('button',{name:'Scan with camera',exact:true}).click();expect(await page.locator('.eg-join-status').textContent()).toContain('Camera unavailable');
 await page.getByLabel('Invite link',{exact:true}).fill('https://evil.example/?leak='+encodeURIComponent(key));await page.getByRole('button',{name:'Use link',exact:true}).click();expect(await page.locator('.eg-join-status').textContent()).toContain('Invalid invite');expect(new URL(page.url()).origin).toBe(preview.url);expect(await page.evaluate(()=>window.__eg.calls.filter(c=>c.method==='POST').length)).toBe(0);
});
it('narrow light/dark layouts retain the familiar composer with no horizontal overflow',async()=>{
 await page.setViewportSize({width:390,height:844});await page.evaluate(()=>window.reverieChat.toggleDrawer('channels'));await page.locator('[data-key="page:embassies"]').click();await page.locator('.eg-directory-room').click();await page.waitForSelector('.eg-post');
 await page.waitForFunction(()=>getComputedStyle(document.querySelector('.ca-side')).visibility==='hidden');
 for(const theme of ['paper-gray','daylight-blue']){
  await page.evaluate(s=>document.documentElement.dataset.skin=s,theme);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=390)).toBe(true);
  expect(await page.locator('.chatroom-input').isVisible()).toBe(true);expect(await page.locator('.chatroom-tool[aria-label*="Emoji" i]').count()).toBe(1);
  if(process.env.EMBASSY_UI_SCREENSHOT_DIR)await page.screenshot({path:process.env.EMBASSY_UI_SCREENSHOT_DIR+'/embassy-tab-390-'+theme+'.png'});
 }
});
it('the styled join dialog stays inside desktop and phone viewports with reachable actions',async()=>{
 for(const width of [1280,390]){
  await page.setViewportSize({width,height:844});await page.evaluate(()=>window.reverieChat.embassy.joinDialog());await page.locator('.eg-dialog').waitFor();
  const rect=await page.locator('.eg-dialog').boundingBox();expect(rect.x).toBeGreaterThanOrEqual(0);expect(rect.x+rect.width).toBeLessThanOrEqual(width);expect(rect.y).toBeGreaterThanOrEqual(0);expect(rect.y+rect.height).toBeLessThanOrEqual(844);
  const action=page.getByRole('button',{name:'Check host',exact:true});expect(await action.isVisible()).toBe(true);expect((await action.boundingBox()).height).toBeGreaterThanOrEqual(40);
  if(process.env.EMBASSY_UI_SCREENSHOT_DIR)await page.screenshot({path:process.env.EMBASSY_UI_SCREENSHOT_DIR+'/styled-join-'+width+'.png'});
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
 }
});
it('directory shows Connected and a clear Disconnect action without changing local rooms',async()=>{
 await page.locator('[data-key="page:embassies"]').click();expect(await page.locator('.eg-connection-state').textContent()).toBe('Connected');
 page.once('dialog',dialog=>dialog.accept());await page.locator('.eg-disconnect').click();await page.waitForFunction(()=>document.querySelector('.eg-connection-state')?.textContent==='Disconnected');
 expect(await page.locator('.eg-disconnect').isDisabled()).toBe(true);expect(await page.evaluate(()=>window.__server.posts.length)).toBe(0);
});
