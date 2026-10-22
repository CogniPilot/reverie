import { afterEach, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRouteTestHarness } from './_route-test-utils.js';
import { createMockSession } from '../mocks/index.js';
import { ChatroomService } from '../../src/chatroom-service.js';
import { ChatFileStore } from '../../src/chatroom-files.js';
import { registerChatroomRoutes } from '../../src/web/routes/chatroom-routes.js';
import { STOCK_CLIS } from '../../src/config/cli-registry/stock.js';
import { CliEntrySchema } from '../../src/config/cli-registry/schema.js';
import { registryFilePath, reloadCliRegistry } from '../../src/config/cli-registry/registry.js';
import { modePollsChat, paneAcceptsChat } from '../../src/chatroom-delivery.js';

const A='0000002d-0035-4000-8000-000000000047', B='00000038-0043-4000-8000-000000000060', C='0000003e-004c-4000-8000-00000000006f';
function entry(id:string,poll=false){
 const base=structuredClone(STOCK_CLIS.find(e=>e.id==='pi')!);
 return {...base,id,stock:false,acceptsChat:false,capabilities:{...base.capabilities,...(poll?{chatDelivery:'poll'}:{})}};
}
afterEach(()=>reloadCliRegistry());
it('requires explicit polling capability, rejects conflicting typed/shell capabilities, and never guesses from a mode name',()=>{
 const polling=entry('poll-agent',true);
 expect(CliEntrySchema.safeParse(polling).success).toBe(true);
 expect(CliEntrySchema.safeParse({...polling,acceptsChat:true}).success).toBe(false);
 expect(CliEntrySchema.safeParse({...polling,kind:'shell'}).success).toBe(false);
 expect(CliEntrySchema.safeParse({...polling,capabilities:{...polling.capabilities,chatDelivery:'anything'}}).success).toBe(false);
 expect(modePollsChat('shell')).toBe(false);expect(modePollsChat('worker-loop-not-declared')).toBe(false);
});
it('normal owner/coordinator Add chooses polling transport; no pane delivery; restart keeps membership and removal revokes access',async()=>{
 mkdirSync(dirname(registryFilePath()),{recursive:true});
 writeFileSync(registryFilePath(),JSON.stringify({schemaVersion:1,clis:{'poll-agent':entry('poll-agent',true),'plain-agent':entry('plain-agent')}}),{mode:0o600});reloadCliRegistry();
 expect(modePollsChat('poll-agent')).toBe(true);expect(modePollsChat('plain-agent')).toBe(false);expect(paneAcceptsChat('poll-agent')).toBe(false);
 const dir=mkdtempSync(join(tmpdir(),'poll-member-'));const file=join(dir,'rooms.json');let service!:ChatroomService;
 const {app,ctx}=await createRouteTestHarness((f,c)=>{
  for(const id of [A,B,C])c.sessions.set(id,createMockSession(id));
  c.sessions.get(B).mode='poll-agent';c.sessions.get(C).mode='plain-agent';
  service=new ChatroomService({file,getSession:id=>c.sessions.get(id),broadcast:()=>{}});
  registerChatroomRoutes(f,c,service,new ChatFileStore(dir));
 });await service.init();
 const headers={'x-reverie-parent-session':B};
 try {
  const room=await app.inject({method:'POST',url:'/api/chatrooms',payload:{name:'Office',coordinatorSessionId:A}});expect(room.statusCode).toBe(200);const id=room.json().data.id;
  const add=(target:string,extra={},h={})=>app.inject({method:'POST',url:`/api/chatrooms/${id}/members`,headers:h,payload:{sessionId:target,...extra}});
  expect((await add(C)).statusCode).toBe(400);
  expect((await add(C,{chatDelivery:'poll'})).statusCode).toBe(400);
  expect((await add(C,{pollingLead:true,voice:true})).statusCode).toBe(400);
  expect((await add(C,{voice:true})).statusCode).toBe(400);
  expect((await add(C,{role:'coordinator'})).statusCode).toBe(400);
  const joined=await add(B,{postOnly:false},{'x-reverie-parent-session':A});expect(joined.statusCode).toBe(200);expect(joined.json().data.member.postOnly).toBe(true);
  const voice=await app.inject({method:'POST',url:`/api/chatrooms/${id}/members/${B}/status`,payload:{voice:true}});expect(voice.statusCode).toBe(200);expect(service.room(id)?.members.find(m=>m.sessionId===B)?.voice).toBe(true);
  const lead=await app.inject({method:'POST',url:`/api/chatrooms/${id}/coordinator`,payload:{sessionId:B}});expect(lead.statusCode).toBe(200);expect(service.room(id)?.members.find(m=>m.sessionId===B)?.role).toBe('coordinator');expect(service.room(id)?.members.find(m=>m.sessionId===B)?.postOnly).toBe(true);
  expect((await add(C,{postOnly:true})).statusCode).toBe(200);
  expect((await app.inject({method:'POST',url:`/api/chatrooms/${id}/members/${C}/status`,payload:{voice:true}})).statusCode).toBe(400);
  expect((await app.inject({method:'POST',url:`/api/chatrooms/${id}/coordinator`,payload:{sessionId:C}})).statusCode).toBe(400);
  expect(service.room(id)?.members.find(m=>m.sessionId===C)).toMatchObject({postOnly:true,role:'agent'});
  expect(service.room(id)?.members.find(m=>m.sessionId===B)).not.toHaveProperty('pollingLead');
  const list=await app.inject({method:'GET',url:'/api/chatrooms?member=self',headers});
  expect(list.json().data.rooms.map((r:any)=>r.id)).toContain(id);expect(Number.isFinite(list.json().data.rooms.find((r:any)=>r.id===id).lastMessageAt)).toBe(true);expect(list.json().data.features.pollingModes).toContain('poll-agent');expect(list.json().data.features.pollingModes).not.toContain('plain-agent');
  expect((await app.inject({method:'GET',url:`/api/chatrooms/${id}`,headers})).statusCode).toBe(200);
  expect((await app.inject({method:'POST',url:`/api/chatrooms/${id}/messages`,headers,payload:{text:'Polling answer',requireAgent:true}})).statusCode).toBe(200);
  await app.inject({method:'POST',url:`/api/chatrooms/${id}/messages`,payload:{text:'@agent room text must never enter a shell'}});
  await service.delivery.flushAll();expect((ctx.sessions.get(B) as any).writeBuffer).toEqual([]);
  const normalCreate=await app.inject({method:'POST',url:'/api/chatrooms',payload:{name:'Polling create',members:[{sessionId:B}]}});
  expect(normalCreate.statusCode).toBe(200);expect(normalCreate.json().data.members.find((m:any)=>m.sessionId===B).postOnly).toBe(true);
  const dm=service.openDm(B,undefined);const dmList=await app.inject({method:'GET',url:'/api/chatrooms?member=self',headers});expect(dmList.json().data.rooms.find((r:any)=>r.id===dm.id).kind).toBe('dm');
  const led=await app.inject({method:'POST',url:'/api/chatrooms',payload:{name:'Polling-led',members:[{sessionId:B,voice:true}],coordinatorSessionId:B}});expect(led.statusCode).toBe(200);expect(led.json().data.members.find((m:any)=>m.sessionId===B)).toMatchObject({role:'coordinator',voice:true,postOnly:true});
  const bad=await app.inject({method:'POST',url:'/api/chatrooms',payload:{name:'Refused',members:[{sessionId:C}],coordinatorSessionId:C}});expect(bad.statusCode).toBe(400);expect(service.rooms().some(r=>r.name==='Refused')).toBe(false);
  await service.stop();
  const restored=new ChatroomService({file,getSession:id=>ctx.sessions.get(id),broadcast:()=>{}});await restored.init();
  try{expect(restored.room(id)?.members.find(m=>m.sessionId===B)).toMatchObject({postOnly:true,voice:true,role:'coordinator'});await restored.delivery.flushAll();expect((ctx.sessions.get(B) as any).writeBuffer).toEqual([]);}finally{await restored.stop();}
  expect((await app.inject({method:'DELETE',url:`/api/chatrooms/${id}/members/${B}`})).statusCode).toBe(200);
  expect((await app.inject({method:'GET',url:`/api/chatrooms/${id}`,headers})).statusCode).toBe(404);
  expect((await app.inject({method:'POST',url:`/api/chatrooms/${id}/messages`,headers,payload:{text:'must refuse after removal',requireAgent:true}})).statusCode).toBe(404);
  expect((await app.inject({method:'GET',url:'/api/chatrooms?member=self',headers})).json().data.rooms.map((r:any)=>r.id)).not.toContain(id);
 }finally{await service.stop();await app.close();rmSync(dir,{recursive:true,force:true});}
});
