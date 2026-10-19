import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {chromium,type Browser,type Page} from 'playwright';
import {createServer,member,room,message} from './helpers/chat-app-harness.mjs';
const root=resolve(import.meta.dirname,'../src/web/public');
const read=(name:string)=>readFileSync(resolve(root,name),'utf8');
const harness=readFileSync(resolve(import.meta.dirname,'helpers/chat-app-harness.mjs'),'utf8');
const appStub=harness.match(/window\.eval\(`([\s\S]*?)`\);/)![1];
let browser:Browser,page:Page;
beforeAll(async()=>{browser=await chromium.launch({headless:true});});
afterAll(async()=>{await browser?.close();});
beforeEach(async()=>{
 await page?.close();page=await browser.newPage({viewport:{width:1280,height:720}});
 await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><head></head><body></body></html>'}));
 await page.goto('https://embassy-ui.test/');
 await page.addStyleTag({content:read('styles.css')});await page.addStyleTag({content:read('chat-app.css')});
 await page.addScriptTag({content:`
 ${member.toString()} ${room.toString()} ${message.toString()} ${createServer.toString()}
 const user={kind:'user',name:'Owner'};
 window.CodemanUrlSession={sessionIdFromFragment:()=>null};window.__server=createServer([room('r1','General',[member('local','Local')])]);
 window.fetch=()=>Promise.resolve({ok:true});
 window.__eg={calls:[],failPost:false,connections:['one','two'].map(id=>({id,origin:'https://'+id+'.example.test',roomId:'remote-'+id,roomName:'Shared room',hostCompany:'Remote',guest:{company:'Visitor',identity:'Guest'},expiresAt:Date.now()+3600000,enabled:true,status:'live',postCount:1})),histories:{one:[{ackId:'p1',sequence:1,at:1,text:'<img src=x> @everyone /command',author:{company:'Remote',identity:'Visitor'},trust:'guest'}],two:[{ackId:'p2',sequence:1,at:1,text:'Another independent conversation',author:{company:'Other',identity:'Guest'},trust:'guest'}]}};
 const oldHandle=window.__server.handle;
 window.__server.handle=async(path,opts={})=>{
  if(!path.startsWith('/api/embassy-guest'))return oldHandle(path,opts);
  const e=window.__eg;e.calls.push({path,...opts});let data;const method=opts.method||'GET';
  if(path==='/api/embassy-guest'){if(e.denied)return {ok:false,status:403,json:async()=>({success:false,error:'Embassy rooms require a signed-in owner',errorCode:'FORBIDDEN'})};data={connections:e.connections};}
  else if(path.endsWith('/preview'))data={origin:'https://relay.example.test'};
  else if(path.endsWith('/join'))data=e.connections[0];
  else {const id=path.split('/')[3];const c=e.connections.find(c=>c.id===id);
   if(method==='PUT'){c.enabled=opts.body.enabled;c.status=c.enabled?'live':'disabled';data=c;}
   else if(method==='DELETE'){c.enabled=false;c.status='left';data=c;}
   else if(method==='POST'){if(e.failPost)return {ok:false,status:502,json:async()=>({success:false,error:'Not confirmed'})};data={post:{ackId:'accepted'}};}
   else {const after=Number(new URL(path,location.origin).searchParams.get('after')||0);const posts=e.histories[id].filter(p=>p.sequence>after);data={posts,next:posts.at(-1)?.sequence||after};}
  }
  return {ok:true,status:200,json:async()=>({success:true,data})};
 };
 ${appStub}
 `});
 for(const f of ['chatroom-ui.js','chat-media.js'])await page.addScriptTag({content:read(f)});
 await page.addScriptTag({content:'window.app=new CodemanApp();'});await page.addScriptTag({content:read('chat-app.js')});
 await page.waitForSelector('.eg-channel');
});
it('CAT1-CAT3 shows real category rows, keyboard collapse and independently bound conversations',async()=>{
 expect(await page.locator('.eg-channel').count()).toBe(2);
 if(process.env.EMBASSY_UI_SCREENSHOT_DIR)await page.screenshot({path:process.env.EMBASSY_UI_SCREENSHOT_DIR+'/embassy-category-desktop.png'});
 const toggle=page.getByRole('button',{name:'Embassies',exact:true});await toggle.focus();await page.keyboard.press('Space');expect(await toggle.getAttribute('aria-expanded')).toBe('false');expect(await page.locator('.eg-channel').first().isVisible()).toBe(false);
 await page.keyboard.press('Enter');expect(await toggle.getAttribute('aria-expanded')).toBe('true');await page.locator('[data-connection="one"]').click();await page.waitForSelector('.eg-post');expect(await page.locator('.eg-origin').textContent()).toContain('one.example.test');
 await page.locator('[data-connection="two"]').click();await page.waitForFunction(()=>document.querySelector('.eg-text')?.textContent==='Another independent conversation');expect(await page.locator('.eg-origin').textContent()).toContain('two.example.test');
 expect(await page.locator('.eg-view iframe').count()).toBe(0);
});
it('CAT4 keeps room unread independently across collapse, switch and local read-cursor restoration',async()=>{
 await page.locator('[data-connection="one"]').click();await page.waitForSelector('.eg-post');expect(await page.locator('[data-connection="two"] .eg-unread').textContent()).toBe('1');
 await page.getByRole('button',{name:'Embassies',exact:true}).click();expect(await page.locator('.eg-unread-total').textContent()).toBe('1');
 const before=await page.evaluate(()=>({one:localStorage.getItem('reverie:embassy:one:read'),two:localStorage.getItem('reverie:embassy:two:read'),posts:window.__server.posts.length}));expect(before).toEqual({one:'1',two:null,posts:0});
 await page.evaluate(async()=>{const ui=window.reverieChat.embassy;ui.close();ui.posts.clear();await ui.refresh();});
 expect(await page.locator('.eg-unread-total').textContent()).toBe('1');
});
it('host preview does not join until confirmed and clears the invite before showing the host',async()=>{
 await page.getByRole('button',{name:'Add embassy channel',exact:true}).click();await page.getByLabel('Invite key', {exact:true}).fill('PRIVATE_INVITE');await page.getByRole('button',{name:'Check host',exact:true}).click();
 await page.getByRole('button',{name:'Connect',exact:true}).waitFor();expect(await page.locator('.eg-key').inputValue()).toBe('');expect(await page.locator('.eg-join-status').textContent()).toContain('https://relay.example.test');
 expect(await page.evaluate(()=>window.__eg.calls.filter(c=>c.path.endsWith('/join')).length)).toBe(0);
 await page.getByRole('button',{name:'Connect',exact:true}).click();await page.waitForSelector('.eg-view');expect(await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}))).not.toContain('PRIVATE_INVITE');
});
it('Disable freezes the composer and retains history; uncertain retries reuse the same identity',async()=>{
 await page.locator('[data-connection="one"]').click();await page.waitForSelector('.eg-post');await page.locator('.eg-input').fill('Keep one request');await page.evaluate(()=>window.__eg.failPost=true);await page.locator('.eg-composer button').click();await page.getByRole('button',{name:'Retry same message',exact:true}).waitFor();await page.getByRole('button',{name:'Retry same message',exact:true}).click();
 const calls=await page.evaluate(()=>window.__eg.calls.filter(c=>c.method==='POST'&&c.path.endsWith('/posts')).map(c=>c.body));expect(calls).toHaveLength(2);expect(calls[0]).toEqual(calls[1]);
 await page.getByRole('button',{name:'Disable',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.eg-status')?.textContent==='Disabled here');expect(await page.locator('.eg-composer button').isDisabled()).toBe(true);expect(await page.locator('.eg-post').count()).toBe(1);
 if(process.env.EMBASSY_UI_SCREENSHOT_DIR)await page.screenshot({path:process.env.EMBASSY_UI_SCREENSHOT_DIR+'/embassy-disabled-here.png'});
});
it('CAT6 renders hostile labels safely at 390px in light and dark with no horizontal overflow',async()=>{
 await page.setViewportSize({width:390,height:844});await page.evaluate(()=>{window.__eg.connections[0].roomName='<script>'+('Long room '.repeat(20));});await page.evaluate(async()=>{await window.reverieChat.embassy.refresh();window.reverieChat.toggleDrawer('channels');});
 await page.locator('[data-connection="one"]').click();await page.waitForSelector('.eg-post');
 await page.waitForFunction(()=>getComputedStyle(document.querySelector('.ca-side')).visibility==='hidden');
 for(const theme of ['dark','light']){
  await page.evaluate(t=>document.documentElement.dataset.skin=t==='light'?'paper-gray':'daylight-blue',theme);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=390)).toBe(true);expect(await page.locator('.eg-feed img').count()).toBe(0);
  expect(await page.locator('.eg-text').textContent()).toContain('<img src=x>');
  if(process.env.EMBASSY_UI_SCREENSHOT_DIR)await page.screenshot({path:process.env.EMBASSY_UI_SCREENSHOT_DIR+'/embassy-390-'+theme+'.png'});
 }
});

it('refused owner access shows setup/login guidance and keeps all guest controls hidden',async()=>{
 await page.locator('[data-connection="one"]').click();await page.waitForSelector('.eg-post');
 await page.evaluate(async()=>{window.__eg.denied=true;await window.reverieChat.embassy.refresh();});
 expect(await page.locator('.eg-category').count()).toBe(0);expect(await page.locator('.eg-view').count()).toBe(0);
 expect(await page.locator('.eg-access-note').textContent()).toContain('run reverie owner bootstrap');expect(await page.getByRole('link',{name:'Owner sign-in',exact:true}).getAttribute('href')).toBe('/owner/login');
 if(process.env.EMBASSY_UI_SCREENSHOT_DIR)await page.screenshot({path:process.env.EMBASSY_UI_SCREENSHOT_DIR+'/embassy-owner-required.png'});
 await page.evaluate(async()=>{window.__eg.denied=false;await window.reverieChat.embassy.refresh();});expect(await page.locator('.eg-channel').count()).toBe(2);expect(await page.locator('.eg-access-note').count()).toBe(0);
});
