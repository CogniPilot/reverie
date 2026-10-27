import { it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRouteTestHarness } from './_route-test-utils.js';
import { createMockSession } from '../mocks/index.js';
import { ChatroomService } from '../../src/chatroom-service.js';
import { ChatFileStore } from '../../src/chatroom-files.js';
import { registerChatroomRoutes } from '../../src/web/routes/chatroom-routes.js';

it('phone permissions: verified owner any, coordinator agents, member self; strict payload and durable refusal', async () => {
 const a='0000002d-0035-4000-8000-000000000047', b='00000038-0043-4000-8000-000000000060', c='0000003e-004c-4000-8000-00000000006f';
 const dir=mkdtempSync(join(tmpdir(),'phone-api-')); let service!:ChatroomService;
 const employeeOf=(id:string)=>[a,b,c].includes(id)?`employee-${id}`:undefined;
 const {app,ctx}=await createRouteTestHarness((f,ctx)=>{
  for(const id of [a,b,c])ctx.sessions.set(id,createMockSession(id));
  ctx.sessions.get(c)!.owner='other';
  service=new ChatroomService({file:join(dir,'rooms.json'),employeeOf,getSession:id=>ctx.sessions.get(id),broadcast:()=>{}});
  registerChatroomRoutes(f,ctx,service,new ChatFileStore(dir),req=>req.headers.cookie==='verified-owner',undefined,employeeOf);
 });
 await service.init();
 const write=(target:string,who:string|undefined,mode='silent',extra={})=>app.inject({method:'PUT',url:`/api/chatrooms/phone-status/${target}`,headers:who==='owner'?{cookie:'verified-owner'}:who?{'x-reverie-parent-session':who}:{},payload:{mode,...extra}});
 try {
  expect((await write(b,undefined)).statusCode).toBe(403);
  expect((await write(b,'owner')).statusCode).toBe(200);
  expect(service.alertMode(b)?.mode).toBe('silent');
  const before=readFileSync(join(dir,'employee-alert-modes.json'),'utf8');
  expect((await write(b,a,'ring')).statusCode).toBe(403);
  expect(readFileSync(join(dir,'employee-alert-modes.json'),'utf8')).toBe(before);
  expect((await write(b,b,'vibrate')).statusCode).toBe(200);
  expect((await write('owner',b)).statusCode).toBe(403);
  expect((await write('owner','owner')).statusCode).toBe(200);
  expect((await write(c,'owner')).statusCode).toBe(403);
  expect((await write(b,a.slice(0,8))).statusCode).toBe(403);
  for(const extra of [{by:'owner'},{durationMs:1},{focus:true},{owner:'other'}]) expect((await write(b,'owner','ring',extra)).statusCode).toBe(400);
  expect((await write(b,'owner','bad')).statusCode).toBe(400);
  const room=await app.inject({method:'POST',url:'/api/chatrooms',headers:{cookie:'verified-owner'},payload:{name:'Reverie',members:[{sessionId:b}],coordinatorSessionId:a}});
  expect(room.statusCode).toBe(200);
  expect((await write(b,a,'ring')).statusCode).toBe(200);
  expect(service.alertMode(b)).toBeUndefined();
  expect((await app.inject({method:'PUT',url:`/api/chatrooms/${room.json().data.id}/archive`,headers:{cookie:'verified-owner'},payload:{archived:true}})).statusCode).toBe(200);
  expect((await write(b,a)).statusCode).toBe(403);
  const audit=readFileSync(join(dir,'rooms.json.audit.jsonl'),'utf8');
  expect(audit).toContain('phone-status-request'); expect(audit).toContain(`"by":"${a}"`);
  const copy=new ChatroomService({file:join(dir,'rooms.json'),employeeOf,getSession:id=>ctx.sessions.get(id),broadcast:()=>{}});
  expect(copy.ownerPhoneStatus()?.mode).toBe('silent'); await copy.stop();
 }finally{await service.stop();await app.close();}
});

it('audit failure and permission revocation during audit refuse without changing persisted mode',async()=>{
 const a='0000002d-0035-4000-8000-000000000047';const dir=mkdtempSync(join(tmpdir(),'phone-commit-'));
 const service=new ChatroomService({file:join(dir,'rooms.json'),employeeOf:()=> 'employee-a',getSession:()=>undefined,broadcast:()=>{throw Error('broadcast unavailable');}});
 await service.init();
 try {
  await service.setPhoneStatus(undefined,a,'vibrate','owner',()=>{});
  const before=readFileSync(join(dir,'employee-alert-modes.json'),'utf8');
  const audit=(service as any).audit.bind(service);
  (service as any).audit=async()=>{throw Error('audit unavailable');};
  await expect(service.setPhoneStatus(undefined,a,'silent','owner',()=>{})).rejects.toThrow('audit unavailable');
  expect(readFileSync(join(dir,'employee-alert-modes.json'),'utf8')).toBe(before);
  expect(service.alertMode(a)?.mode).toBe('vibrate');
  let allowed=true;
  (service as any).audit=async(entry:unknown)=>{await audit(entry);allowed=false;};
  await expect(service.setPhoneStatus(undefined,a,'silent','owner',()=>{if(!allowed)throw Error('permission revoked');})).rejects.toThrow('permission revoked');
  expect(readFileSync(join(dir,'employee-alert-modes.json'),'utf8')).toBe(before);
  expect(service.alertMode(a)?.mode).toBe('vibrate');
 }finally{await service.stop();}
});
