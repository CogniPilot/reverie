/** Source-only real auth/chat composition; no socket, GPU, Session spawn or native authority. */
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import Fastify,{type FastifyInstance} from 'fastify';
import cookie from '@fastify/cookie';
import {mkdtemp,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OwnerAuthStore} from '../src/owner-auth/store.js';
import {OwnerAuthService} from '../src/owner-auth/service.js';
import {registerOwnerPolicy,OWNER_COOKIE} from '../src/owner-auth/policy.js';
import {registerOwnerRoutes} from '../src/owner-auth/routes.js';
import {ownerVerifier} from '../src/owner-auth/marks.js';
import {registerAuthMiddleware,isCapabilityRequest} from '../src/web/middleware/auth.js';
import {ChatroomService} from '../src/chatroom-service.js';
import {ChatFileStore} from '../src/chatroom-files.js';
import {registerChatroomRoutes} from '../src/web/routes/chatroom-routes.js';
import {CompanyStore} from '../src/company-store.js';
import {registerBrowserJobEvidence} from '../src/browser-job-evidence.js';
import type {SessionPort} from '../src/web/ports/session-port.js';
import type {Session} from '../src/session.js';
const SID='00000000-0000-4000-8000-000000000001',EID='00000000-0000-4000-8000-000000000002';
const BASIC='Basic '+Buffer.from('fixture:synthetic-office-password').toString('base64');

describe('fixed browser job canonical evidence',()=>{
 let dir:string,app:FastifyInstance,owner:OwnerAuthService,chat:ChatroomService,company:CompanyStore;
 let room:string,cue:string,request:string,ownerCookie:string,session:Session;
 const call=(method:'GET'|'POST'|'PUT',url:string,payload?:unknown,headers:Record<string,string>={})=>app.inject({method,url,headers:{host:'localhost',origin:'http://localhost',...headers},...(payload===undefined?{}:{payload})});
 const read=(headers:Record<string,string>={authorization:BASIC,'x-reverie-parent-session':SID})=>call('GET',`/api/chatrooms/${room}/messages/${request}/browser-job-evidence`,undefined,headers);
 beforeEach(async()=>{
  vi.stubEnv('REVERIE_PASSWORD','synthetic-office-password');vi.stubEnv('REVERIE_USERNAME','fixture');
  dir=await mkdtemp(join(await realpath(tmpdir()),'browser-source-'));
  const recipe={mode:'codex',workingDir:join(dir,'project'),model:'fixture-model',configs:{}};
  session={id:SID,owner:undefined,name:'Synthetic member',mode:'codex',workingDir:recipe.workingDir,pid:null,subscriptionProfile:undefined,
   toState:()=>({model:'fixture-model'}),getCustomModelForPersist:()=>undefined}as unknown as Session;
  const sessions=new Map([[SID,session]]),ctx={sessions}as unknown as SessionPort;
  app=Fastify();await app.register(cookie);owner=new OwnerAuthService({store:new OwnerAuthStore(join(dir,'owner.json')),auditFile:join(dir,'audit.jsonl'),setupEnabled:true});
  registerAuthMiddleware(app,false,'',owner);registerOwnerPolicy(app,{service:owner,ctx,isCapabilityRequest:req=>isCapabilityRequest(req,''),relations:{known:id=>sessions.has(id),related:(a,b)=>a===b,coordinated:()=>false,upward:()=>false,keeper:()=>false,admin:()=>false}});registerOwnerRoutes(app,owner,false);
  chat=new ChatroomService({file:join(dir,'chat.json'),getSession:id=>sessions.get(id),broadcast:()=>{},deferDeliveryRecovery:true});await chat.init();
  company=new CompanyStore(join(dir,'company.json'));await company.init();await company.update(s=>{s.employees.push({id:EID,createdAt:Date.now(),name:'Synthetic member',icon:'🧪',position:'Member',expertise:['testing'],sessionId:SID,sessionGeneration:3,runtimeRecipe:recipe,desiredRunning:true,permissions:{recoverEmployees:false,moveOwnPlan:false,managePlans:false},onVacation:false,researchEnabled:false,sleepEnabled:false,dreamEnabled:false,wakeAttempts:[]});});
  registerChatroomRoutes(app,ctx,chat,new ChatFileStore(join(dir,'files')),ownerVerifier({service:owner,ctx}),undefined,()=>EID,{human:req=>owner.identity(req.cookies?.[OWNER_COOKIE]),messageOwner:id=>owner.isMessageOwner(id)});
  registerBrowserJobEvidence(app,{sessions:ctx,chat,company,currentOwner:id=>owner.isMessageOwner(id),policy:{service:owner,ctx}});await app.ready();
  const setup=await call('POST','/api/owner/setup',{username:'fixture-owner',password:'SyntheTic-Capture-42!Ocean',confirmation:'SyntheTic-Capture-42!Ocean'});expect(setup.statusCode).toBe(200);ownerCookie=OWNER_COOKIE+'='+setup.cookies.find(c=>c.name===OWNER_COOKIE)!.value;
  const created=await call('POST','/api/chatrooms',{name:'Synthetic job room',members:[{sessionId:SID}]},{cookie:ownerCookie});expect(created.statusCode).toBe(200);room=created.json().data.id;
  const posted=await call('POST',`/api/chatrooms/${room}/messages`,{text:'The selected member may run the fixed public capture.'},{cookie:ownerCookie});expect(posted.statusCode).toBe(200);cue=posted.json().data.message.id;
  const req=await call('POST',`/api/chatrooms/${room}/messages`,{text:'/browser-job slam-office640',replyTo:cue},{authorization:BASIC,'x-reverie-parent-session':SID});expect(req.statusCode).toBe(200);request=req.json().data.message.id;
 });
 afterEach(async()=>{await app?.close();await chat?.stop();vi.unstubAllEnvs();await rm(dir,{recursive:true,force:true});});
 it('composes actual normal owner-marked cue and agent source, returns only bounded current facts',async()=>{
  const response=await read();expect(response.statusCode).toBe(200);const d=response.json().data;expect(d.actor).toMatchObject({employeeId:EID,sessionId:SID,sessionGeneration:3});expect(d.source.replyTo).toBe(cue);expect(d.ownerCue.mark).toBe('owner_typed');expect(d).not.toHaveProperty('text');expect(d).not.toHaveProperty('permit');expect(d.actor.recipeSHA256).toMatch(/^[a-f0-9]{64}$/);
 });
 it('requires real Basic boundary and refuses owner-cookie or alternate identity borrowing',async()=>{
  for(const h of [{},{'x-reverie-parent-session':SID},{authorization:'Basic Zm9vOmJhcg==','x-reverie-parent-session':SID},{cookie:ownerCookie,'x-reverie-parent-session':SID},{authorization:BASIC,'x-reverie-parent-session':SID.slice(0,8)},{authorization:BASIC,'x-reverie-parent-session':'00000000-0000-4000-8000-000000000003'}])expect([401,403]).toContain((await read(h)).statusCode);
 });
 it('OFF, vacation and migration state refuse instead of gaining authority from title',async()=>{
  for(const delta of [{desiredRunning:false},{onVacation:true},{bindingMigration:{id:'move',from:SID,to:'00000000-0000-4000-8000-000000000003'}}]){await company.update(s=>Object.assign(s.employees[0]!,delta));expect((await read()).statusCode).toBe(403);await company.update(s=>{s.employees[0]!.desiredRunning=true;s.employees[0]!.onVacation=false;delete s.employees[0]!.bindingMigration;});}
 });
 it('changed account/model recipe and current owner cue revocation refuse',async()=>{
  await company.update(s=>{s.employees[0]!.runtimeRecipe!.model='changed-model';});expect((await read()).statusCode).toBe(403);
  await company.update(s=>{s.employees[0]!.runtimeRecipe!.model='fixture-model';});chat.room(room)!.messages.find(m=>m.id===cue)!.edited={at:Date.now()};expect((await read()).statusCode).toBe(403);
 });
 it('request deletion/alternate reply/changed command cannot be canonical authority',async()=>{
  const m=chat.room(room)!.messages.find(m=>m.id===request)!;m.deleted={at:Date.now(),by:'user'};expect((await read()).statusCode).toBe(403);delete m.deleted;m.text='quoted /browser-job slam-office640';expect((await read()).statusCode).toBe(403);
 });
 it('archived, nonmember and mismatched canonical room facts refuse',async()=>{
  const r=chat.room(room)!;r.archivedAt=Date.now();expect((await read()).statusCode).toBe(403);delete r.archivedAt;
  const members=r.members;r.members=[];expect((await read()).statusCode).toBe(403);r.members=members;
  const source=r.messages.find(m=>m.id===request)!;source.roomId='00000000-0000-4000-8000-000000000099';expect((await read()).statusCode).toBe(403);
 });
 it('runtime thread advancement is allowed while account switches remain bound',async()=>{
  session.toState=()=>({model:'fixture-model',runtimeThreads:{codex:'synthetic-current-thread'}})as ReturnType<Session['toState']>;expect((await read()).statusCode).toBe(200);
  session.subscriptionProfile={id:'synthetic-other-account',label:'Synthetic alternate',provider:'openai'};expect((await read()).statusCode).toBe(403);
 });
 it('an absent running intent or a user-kind cue without a server owner mark grants nothing',async()=>{
  await company.update(s=>{delete s.employees[0]!.desiredRunning;});expect((await read()).statusCode).toBe(403);await company.update(s=>{s.employees[0]!.desiredRunning=true;});
  const c=chat.room(room)!.messages.find(m=>m.id===cue)!;if(c.from.kind!=='user')throw Error('synthetic cue');delete c.from.mark;expect((await read()).statusCode).toBe(403);
 });
});
