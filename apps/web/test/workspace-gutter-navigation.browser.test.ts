import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {expect,it} from 'vitest';
import {chromium} from 'playwright';
import {createServer,member,room,message} from './helpers/chat-app-harness.mjs';
it.each([{label:'desktop',width:1280,height:900},{label:'mobile',width:393,height:852},{label:'small-mobile',width:320,height:740}])('uses the gutter gear and returns tools to Company ($label)',async({label,width,height})=>{
 const pub=resolve(import.meta.dirname,'../src/web/public'),read=(name:string)=>readFileSync(resolve(pub,name),'utf8');
 const harness=readFileSync(resolve(import.meta.dirname,'helpers/chat-app-harness.mjs'),'utf8'),stub=harness.match(/window\.eval\(`([\s\S]*?)`\);/)![1];
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
 try{const page=await browser.newPage({viewport:{width,height}});page.setDefaultTimeout(5000);const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>{const url=new URL(route.request().url());return route.fulfill({contentType:route.request().resourceType()==='script'?'application/javascript':'text/html',body:route.request().resourceType()==='script'?'':'<!doctype html><html><head></head><body>'+(url.pathname==='/workspace'?'<a href="./" target="_top">Back to chat</a>':'')+'</body></html>'});});
 await page.goto('https://gutter-navigation-fixture.test/');
 for(const name of ['styles.css','chat-app.css'])await page.addStyleTag({content:read(name)});
 await page.addScriptTag({content:`${member.toString()} ${room.toString()} ${message.toString()} ${createServer.toString()}
 const user={kind:'user',name:'Owner'};window.ReverieUrlSession={sessionIdFromFragment:()=>null};window.__server=createServer([room('general','General',[])]);
 window.__server.company={canManage:true,settings:{ownerName:'Owner'},employees:[]};const prior=window.__server.handle;window.__server.handle=async(path,options={})=>{if(path.startsWith('/api/embassy'))return {ok:true,status:200,json:async()=>({success:true,data:{connections:[]}})};if(path==='/api/chatrooms/phone-status')return {ok:true,status:200,json:async()=>({success:true,data:{self:'owner',canSetOwn:true}})};return prior(path,options);};window.fetch=async()=>({ok:true,json:async()=>({avatars:[]})});${stub}`});
 for(const name of ['chatroom-ui.js','chat-media.js'])await page.addScriptTag({content:read(name)});
 await page.addScriptTag({content:'window.app=new ReverieApp();'});await page.addScriptTag({content:read('chat-app.js')});
 await page.waitForSelector('.ca-office-gear',{state:'attached'});
 await page.evaluate(()=>{const s=(window as any).reverieChat;if(innerWidth<768)s.toggleDrawer('channels');s.renderMachineStats?.({});});
 await page.locator('.ca-office-gear').click();await page.waitForSelector('.ca-office-pane:not([hidden])');
 await page.waitForTimeout(250);
 const geometry=await page.evaluate(()=>{const r=(s:string)=>{const a=document.querySelector(s)!.getBoundingClientRect();return {x:a.x,y:a.y,right:a.right,bottom:a.bottom,width:a.width,height:a.height};};return {gear:r('.ca-office-gear'),rail:r('.ca-rail'),pane:r('.ca-office-pane'),stats:r('.ca-machine-bar'),viewport:{width:innerWidth,height:innerHeight},buttons:[...document.querySelectorAll('.ca-office-pane button')].map(b=>b.textContent)};});
 expect(geometry.gear.x).toBeGreaterThanOrEqual(geometry.rail.x);expect(geometry.gear.right).toBeLessThanOrEqual(geometry.rail.right+1);expect(geometry.gear.right).toBeLessThanOrEqual(geometry.stats.x+1);expect(geometry.pane.bottom).toBeLessThanOrEqual(geometry.gear.y+1);expect(geometry.pane.x).toBeGreaterThanOrEqual(0);expect(geometry.pane.right).toBeLessThanOrEqual(width);expect(geometry.pane.y).toBeGreaterThanOrEqual(0);expect(geometry.buttons).toEqual(['Company','Board']);
 const links=await page.locator('.ca-office-pane button').evaluateAll(buttons=>buttons.map(b=>{const r=b.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom};}));expect(links[1].y).toBeGreaterThanOrEqual(links[0].bottom);expect(links[1].x).toBe(links[0].x);
 if(label==='small-mobile') {
   for(const viewport of [{width:320,height:568},{width:360,height:640},{width:320,height:740}]) {
     await page.setViewportSize(viewport);await page.waitForTimeout(250);
     const resized=await page.evaluate(()=>{const p=document.querySelector('.ca-office-pane')!.getBoundingClientRect(),g=document.querySelector('.ca-office-gear')!.getBoundingClientRect();return {left:p.left,right:p.right,top:p.top,bottom:p.bottom,gearTop:g.top,width:innerWidth};});
     expect(resized.bottom).toBeLessThanOrEqual(resized.gearTop+1);expect(resized.left).toBeGreaterThanOrEqual(0);expect(resized.right).toBeLessThanOrEqual(viewport.width);expect(resized.top).toBeGreaterThanOrEqual(0);
   }
 }
 if(process.env.NAV_SCREENSHOT_DIR){mkdirSync(process.env.NAV_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:resolve(process.env.NAV_SCREENSHOT_DIR,label+'-gutter.png')});writeFileSync(resolve(process.env.NAV_SCREENSHOT_DIR,label+'-geometry.json'),JSON.stringify(geometry,null,2));}
 await page.locator('.ca-office-pane button').first().focus();await page.keyboard.press('Escape');expect(await page.locator('.ca-office-gear').getAttribute('aria-expanded')).toBe('false');expect(await page.locator('.ca-office-gear').evaluate(e=>e===document.activeElement)).toBe(true);
 await page.keyboard.press('Enter');await expect.poll(async()=>page.locator('.ca-office-pane button').first().evaluate(e=>e===document.activeElement)).toBe(true);await page.keyboard.press('Tab');expect(await page.locator('.ca-office-pane button').nth(1).evaluate(e=>e===document.activeElement)).toBe(true);
 await page.locator('.ca-office-pane button').filter({hasText:'Company'}).click();await page.waitForSelector('.ca-company-tools-button');
 await page.locator('.ca-company-tools-button').click();await page.locator('[aria-label="Company tools"] button').filter({hasText:/^Workspace$/}).click();
 await page.waitForSelector('.ca-tool-page-head button');await expect.poll(async()=>page.frameLocator('.ca-page-frame').locator('a').textContent()).toBe('Back to Company / tools');
 await page.frameLocator('.ca-page-frame').locator('a').click();await page.waitForSelector('[aria-label="Company tools"]');expect(await page.evaluate(()=>(window as any).reverieChat.embed)).toBe('company');
 expect(await page.evaluate(()=>{const c=document.querySelector('.ca-company')!;return [...c.children].indexOf(c.querySelector('.ca-company-plans')!)<[...c.children].indexOf(c.querySelector('.ca-company-content')!);})).toBe(true);
 expect(errors).toEqual([]);
 }finally{await browser.close();}
},30000);
