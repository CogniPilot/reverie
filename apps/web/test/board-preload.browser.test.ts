import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { chromium, type Page } from 'playwright';
import { createServer, member, room, message } from './helpers/chat-app-harness.mjs';
async function setup(page: Page) {
  const pub=resolve(import.meta.dirname,'../src/web/public'),read=(name:string)=>readFileSync(resolve(pub,name),'utf8');
  const stub=readFileSync(resolve(import.meta.dirname,'helpers/chat-app-harness.mjs'),'utf8').match(/window\.eval\(`([\s\S]*?)`\);/)![1];
  const state={documents:0,reads:0,writes:0,rev:1,owner:true};const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{const w=window as any;w.__intervals=new Map();const add=window.setInterval.bind(window),clear=window.clearInterval.bind(window);w.setInterval=(fn:any,ms:number,...args:any[])=>{const id=add(fn,ms,...args);w.__intervals.set(id,ms);return id;};w.clearInterval=(id:number)=>{w.__intervals.delete(id);clear(id);};});
  await page.route('**/*',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(route.request().method()!=='GET'){state.writes++;return route.fulfill({status:405,json:{success:false}});}
    if(path==='/board'){state.documents++;await new Promise(r=>setTimeout(r,180));return route.fulfill({contentType:'text/html',body:read('board.html')});}
    if(path==='/company-board.css')return route.fulfill({contentType:'text/css',body:read('company-board.css')});
    if(path==='/api/board'){state.reads++;const rev=state.rev;await new Promise(r=>setTimeout(r,100));if(!state.owner)return route.fulfill({status:403,json:{success:false}});const now=Date.now();return route.fulfill({json:{success:true,data:{rev,built:now,timeZone:'UTC',company:{name:'Revision '+rev},issues:[{id:'fixture',title:'Task revision '+rev,ownerLabel:'Fixture',status:'doing',priority:'normal',tags:[],links:[],details:'',scale:'hour',start:now-36e5,end:now+36e5}],roster:[],milestones:[],polls:[],pins:[],wins:[],blockers:[],decisions:[],structuredDecisionWrites:true}}});}
    return route.fulfill({contentType:route.request().resourceType()==='script'?'application/javascript':'text/html',body:route.request().resourceType()==='script'?'':'<!doctype html><html><body></body></html>'});
  });
  await page.goto('https://owned-board-preload.test/');for(const name of ['styles.css','chat-app.css'])await page.addStyleTag({content:read(name)});
  await page.addScriptTag({content:`${member.toString()} ${room.toString()} ${message.toString()} ${createServer.toString()}
    const user={kind:'user',name:'Owner'};window.__owner=true;window.ReverieUrlSession={sessionIdFromFragment:()=>null};window.__server=createServer([room('general','General',[])]);window.__server.company={canManage:true,settings:{ownerName:'Owner'},employees:[]};const prior=window.__server.handle;
    window.__server.handle=async(p,o={})=>{const ok=data=>({ok:true,status:200,json:async()=>({success:true,data})});if(p==='/api/company')return ok({...window.__server.company,canManage:window.__owner});if(p==='/api/chatrooms/phone-status')return ok({self:window.__owner?'owner':'agent',canSetOwn:window.__owner});if(p==='/api/office/me')return ok({person:{id:'owner',role:window.__owner?'owner':'limited',primary:true,name:'Owner'}});return prior(p,o);};window.fetch=async()=>({ok:true,json:async()=>({avatars:[]})});${stub}`});
  for(const name of ['chatroom-ui.js','chat-media.js'])await page.addScriptTag({content:read(name)});await page.addScriptTag({content:'window.app=new ReverieApp();'});await page.addScriptTag({content:read('chat-app.js')});
  await page.waitForFunction(()=>Boolean((window as any).reverieChat._boardCache));
  const frame=()=>page.frames().find(f=>new URL(f.url()).pathname==='/board')!;
  await expect.poll(()=>Boolean(frame())).toBe(true);await frame().waitForFunction(()=>document.getElementById('co')?.textContent==='Revision 1');
  return {state,errors,frame};
}
it('preloads one real Gantt document, suspends hidden work and refreshes data on return without another document load',async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
  try{const page=await browser.newPage({viewport:{width:1280,height:900}});const {state,errors,frame}=await setup(page);
    expect(state.documents).toBe(1);expect(state.reads).toBe(1);expect(await frame().evaluate('window.__intervals.size')).toBe(0);expect(await frame().evaluate('readyForActions')).toBe(false);expect(await frame().locator('#tl .bar').count()).toBe(1);
    const original=await page.locator('.ca-board-frame').elementHandle();const times:number[]=[];
    for(const rev of [1,2]){if(rev===2){await page.evaluate(()=>(window as any).reverieChat.closePage());expect(await frame().evaluate('window.__intervals.size')).toBe(0);expect(await frame().evaluate('readyForActions')).toBe(false);expect(await frame().evaluate('post("/api/board/decisions/fixture/clear",{}).then(()=>false,()=>true)')).toBe(true);state.rev=2;}
      const start=performance.now();await page.evaluate(()=>(window as any).reverieChat.openPage('board'));await page.waitForFunction(()=>(window as any).reverieChat.embed==='board');await frame().waitForFunction(rev=>document.getElementById('co')?.textContent==='Revision '+rev&&(window as any).eval('readyForActions'),rev);times.push(performance.now()-start);
      expect(await frame().evaluate('[...window.__intervals.values()].sort((a,b)=>a-b)')).toEqual([10000,30000]);expect(await frame().locator('#tl .bar').count()).toBe(1);
    }
    expect(await original!.evaluate(e=>e===document.querySelector('.ca-board-frame'))).toBe(true);expect(state.documents).toBe(1);expect(state.reads).toBe(3);expect(state.writes).toBe(0);expect(errors).toEqual([]);
    const output=process.env.TEST_BOARD_PRELOAD_OUTPUT;if(output){mkdirSync(output,{recursive:true});await page.screenshot({path:resolve(output,'board-return.png')});writeFileSync(resolve(output,'measurement.json'),JSON.stringify({state,times,controlledDocumentDelayMs:180,controlledAPIDelayMs:100,errors},null,2));}
  }finally{await browser.close();}
},30000);
it('discards retained content on current authority loss and rejects unrelated authority messages',async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
  try{const page=await browser.newPage({viewport:{width:390,height:844}});const {state,errors,frame}=await setup(page);
    await page.evaluate(()=>{const s=(window as any).reverieChat;window.dispatchEvent(new MessageEvent('message',{origin:'https://foreign.test',source:s._boardCache.frame.contentWindow,data:{type:'board-auth-lost'}}));window.dispatchEvent(new MessageEvent('message',{origin:location.origin,source:window,data:{type:'board-auth-lost'}}));});expect(await page.locator('.ca-board-frame').count()).toBe(1);
    await page.evaluate(()=>(window as any).reverieChat.openPage('board'));await frame().waitForFunction('readyForActions');
    state.owner=false;await page.evaluate(()=>{(window as any).__owner=false;});await frame().evaluate('load()');await page.waitForFunction(()=>!(window as any).reverieChat._boardCache);expect(await page.locator('.ca-board-frame').count()).toBe(0);expect(state.writes).toBe(0);expect(errors).toEqual([]);
  }finally{await browser.close();}
},30000);
