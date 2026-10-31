import Fastify from 'fastify';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Session} from '../src/session.js';
import {WebServer} from '../src/web/server.js';
import {CompanyStore} from '../src/company-store.js';
import {CompanyService} from '../src/company-service.js';
import {registerSessionRuntimeRoutes,resumeOwnerStops,type LaptopAgentStop,type StopBounds} from '../src/web/routes/session-runtime-routes.js';
import {ownerStopPending,recordOwnerStop,useOwnerStopJournal} from '../src/owner-stop-journal.js';
import {chmodSync,mkdirSync,readdirSync,statSync} from 'node:fs';
import type {TerminalMultiplexer,MuxSession} from '../src/mux-interface.js';

const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{vi.unstubAllEnvs();vi.restoreAllMocks();for(const clean of cleanups.splice(0).reverse())await clean();});
async function setup(stop?:LaptopAgentStop,waitMs?:number,bounds?:StopBounds){
 const dir=await mkdtemp(join(tmpdir(),'dead-pane-owner-'));cleanups.push(()=>rm(dir,{recursive:true,force:true}));
 const mux={isAvailable:()=>true,muxSessionExists:vi.fn(()=>true),isPaneDead:vi.fn(()=>true),
  respawnPane:vi.fn(async()=>42),clearPaneExit:vi.fn()};
 const session=new Session({workingDir:dir,mode:'opencode',useMux:true,mux:mux as unknown as TerminalMultiplexer,
  muxSession:{sessionId:'owned',muxName:'reverie-owned',pid:41}as MuxSession,
  subscriptionProfile:{provider:'openai',id:'selected',label:'Selected'},openCodeConfig:{model:'selected/model',continueSession:'ses_selected'}});
 cleanups.push(async()=>{Object.assign(session,{ptyProcess:null,_muxSession:null});await session.stop(false);});
 session.setPaneExit({status:137,at:Date.now()});
 const store=new CompanyStore(join(dir,'company.json'));await store.init();
 const company=new CompanyService(store,{getSession:(id:string)=>id===session.id?session:undefined,
  chatrooms:{rooms:()=>[]},research:{}}as never);
 const employee=await company.hire({name:'Owned',icon:'🦉',position:'Engineer',expertise:['systems'],sessionId:session.id,researchEnabled:false}as never);
 const ctx={sessions:new Map([[session.id,session]]),persistSessionStateNow:vi.fn(),getSessionStateWithRespawn:(s:Session)=>s.toState(),broadcast:vi.fn()};
 const app=Fastify();registerSessionRuntimeRoutes(app,ctx as never,req=>req.headers.cookie==='fixture-owner=yes',undefined,company,undefined,stop,waitMs,bounds);
 await app.ready();cleanups.push(()=>app.close());
 return {app,session,mux,store,company,employee,ctx,url:`/api/company/employees/${employee.id}/restart`};
}
const headers={cookie:'fixture-owner=yes'};
describe('verified owner dead-pane recovery',()=>{
 it('recovers the saved worker recipe despite stale busy and performs no runtime reconfiguration',async()=>{
  vi.stubEnv('REVERIE_WORKER_SOCKET','/run/fixture/broker.sock');const f=await setup();
  vi.spyOn(f.session,'isWorking','get').mockReturnValue(true);vi.spyOn(f.session,'isBusy').mockReturnValue(true);
  const before=f.session.toState();const configure=vi.spyOn(f.session,'configureRuntime');const ordinary=vi.spyOn(f.session,'restartCli');
  const recover=vi.spyOn(f.session,'restartDeadCli').mockImplementation(async current=>{expect(current()).toBe(true);return true;});
  const response=await f.app.inject({method:'POST',url:f.url,headers,payload:{}});
  expect(response.statusCode,response.body).toBe(200);expect(recover).toHaveBeenCalledOnce();expect(configure).not.toHaveBeenCalled();expect(ordinary).not.toHaveBeenCalled();
  expect(f.session.toState()).toEqual(before);expect(f.company.view().employees[0].desiredRunning).toBe(true);
  expect(response.json().data.recovery).toBe('normal-launch-requested');
 });
 it('keeps owner stop authoritative during the awaited recovery and never retries',async()=>{
  const f=await setup();const ordinary=vi.spyOn(f.session,'restartCli');
  const recover=vi.spyOn(f.session,'restartDeadCli').mockImplementation(async current=>{
   await f.company.setDesiredRunning(f.session.id,false);expect(current()).toBe(false);return false;
  });
  const response=await f.app.inject({method:'POST',url:f.url,headers,payload:{}});
  expect(response.statusCode).toBe(409);expect(recover).toHaveBeenCalledOnce();expect(ordinary).not.toHaveBeenCalled();
  expect(f.company.view().employees[0].desiredRunning).toBe(false);
 });
 it('rejects a changed current generation before any second launch',async()=>{
  const f=await setup();vi.spyOn(f.session,'restartDeadCli').mockImplementation(async current=>{
   await f.store.update(s=>{s.employees[0].sessionGeneration++;});expect(current()).toBe(false);return false;
  });
  expect((await f.app.inject({method:'POST',url:f.url,headers,payload:{}})).statusCode).toBe(409);
 });
 it('lets a concurrent owner account change win without restoring the old account',async()=>{
  const f=await setup();vi.spyOn(f.session,'restartDeadCli').mockImplementation(async current=>{
   f.session.configureRuntime({mode:'codex',selection:{id:'new-profile',label:'New',provider:'openai'},
    env:{CODEX_HOME:'/fixture/new-account'},sourceKey:'subscription:new-profile'});
   expect(current()).toBe(false);return false;
  });
  expect((await f.app.inject({method:'POST',url:f.url,headers,payload:{}})).statusCode).toBe(409);
  expect(f.session.subscriptionProfile?.id).toBe('new-profile');
 });
 it.each(['foreign','wrong-confirm','task','off','vacation','live']as const)('retains the %s guard',async kind=>{
  const f=await setup();const recover=vi.spyOn(f.session,'restartDeadCli').mockResolvedValue(true);
  if(kind==='task')vi.spyOn(f.session,'runningTaskCount','get').mockReturnValue(1);
  if(kind==='off')await f.company.setDesiredRunning(f.session.id,false);
  if(kind==='vacation')await f.store.update(s=>{s.employees[0].onVacation=true;});
  if(kind==='live'){f.mux.isPaneDead.mockReturnValue(false);vi.spyOn(f.session,'isWorking','get').mockReturnValue(true);}
  const response=await f.app.inject({method:'POST',url:f.url,headers:kind==='foreign'?{}:headers,
   payload:kind==='wrong-confirm'?{forceRestart:true,confirmSessionId:'other'}:{}});
  expect(response.statusCode).toBe(kind==='foreign'?403:409);expect(recover).not.toHaveBeenCalled();
 });
 it('reports worker transport loss separately and never infers healthy from a missing exit',async()=>{
  const f=await setup();expect(f.session.runtimeHealth).toBe('dead');expect(f.company.view().employees[0].runtimeHealth).toBe('dead');
  vi.stubEnv('REVERIE_WORKER_SOCKET','/run/fixture/broker.sock');const worker=await setup();
  expect(worker.session.runtimeHealth).toBe('disconnected');expect(worker.session.runtimeHealthScope).toBe('terminal');
  worker.session.setPaneExit(undefined);expect(worker.session.runtimeHealth).toBe('unknown');
 });
 it('passes an atomic dead-only guard and checks owner intent after asynchronous preparation',async()=>{
  const f=await setup();let current=true;
  vi.spyOn(f.session,'applyFullAccessDefault').mockResolvedValue([]);
  vi.spyOn(f.session as never,'_prepareSelectedClaudeProfile' as never).mockResolvedValue(undefined as never);
  vi.spyOn(f.session as never,'_prepareManagedCodexTrust' as never).mockResolvedValue(undefined as never);
  vi.spyOn(f.session as never,'_buildRespawnPaneOptionsWithResumePin' as never).mockImplementation(async()=>{
   current=false;return {sessionId:f.session.id,workingDir:f.session.workingDir,mode:'opencode'}as never;
  });
  expect(await f.session.restartDeadCli(()=>current)).toBe(false);expect(f.mux.respawnPane).not.toHaveBeenCalled();
 });
 it('uses the real Session recovery consumer with atomic dead-only respawn and saved continuation',async()=>{
  const f=await setup();
  vi.spyOn(f.session,'applyFullAccessDefault').mockResolvedValue([]);
  vi.spyOn(f.session as never,'_prepareSelectedClaudeProfile' as never).mockResolvedValue(undefined as never);
  vi.spyOn(f.session as never,'_prepareManagedCodexTrust' as never).mockResolvedValue(undefined as never);
  vi.spyOn(f.session as never,'_scheduleFullAccessCheck' as never).mockResolvedValue([] as never);
  vi.spyOn(f.session as never,'_buildRespawnPaneOptionsWithResumePin' as never).mockResolvedValue({
   sessionId:f.session.id,workingDir:f.session.workingDir,mode:'opencode',openCodeConfig:{continueSession:'ses_selected'}
  }as never);
  const before=f.session.toState();const current=()=>true;
  expect(await f.session.restartDeadCli(current)).toBe(true);
  expect(f.mux.respawnPane).toHaveBeenCalledOnce();expect(f.mux.respawnPane.mock.calls[0][0]).toMatchObject({
   onlyIfDead:true,stillCurrent:current,openCodeConfig:{continueSession:'ses_selected'}
  });
  expect(f.session.paneExit).toBeUndefined();expect(f.session.toState().subscriptionProfile).toEqual(before.subscriptionProfile);
 });

 it('does not turn a clean worker transport exit into owner OFF while local clean exit still sweeps',async()=>{
  vi.stubEnv('REVERIE_WORKER_SOCKET','/run/fixture/broker.sock');const worker=await setup();
  await worker.company.setDesiredRunning(worker.session.id,true);
  worker.session.setPaneExit({status:0,at:Date.now()});
  vi.unstubAllEnvs();const local=await setup();local.session.setPaneExit({status:0,at:Date.now()});
  const cleanup=vi.fn(async()=>{});const server={mux:{getPaneExitReadCount:()=>2},
   sessions:new Map([[worker.session.id,worker.session],[local.session.id,local.session]]),
   cleanExitCloseAttempts:new Set<string>(),cleaningUp:new Set<string>(),cleanupSession:cleanup};
  const sweep=(WebServer.prototype as unknown as {closeCleanlyExitedSessions():void}).closeCleanlyExitedSessions;
  sweep.call(server);
  expect(cleanup).toHaveBeenCalledExactlyOnceWith(local.session.id,true,'agent exited cleanly (status 0)');
  expect(worker.company.view().employees[0].desiredRunning).toBe(true);
 });

});

describe('verified owner recovery of a wedged laptop agent (stop-agent)',()=>{
 // A live but stuck laptop agent: no task, not working, last input long ago, yet its status line keeps redrawing.
 // settleImpl models the laptop's answer to settling a stop whose answer was lost; by default the laptop never answers.
 async function wedged(stopImpl?:(f:Awaited<ReturnType<typeof setup>>,notAfter:number)=>Promise<unknown>,waitMs?:number,
  bounds?:Partial<StopBounds>&Record<string,number>,settleImpl?:(f:Awaited<ReturnType<typeof setup>>)=>Promise<unknown>){
  vi.stubEnv('REVERIE_WORKER_SOCKET','/run/fixture/broker.sock');
  let f!:Awaited<ReturnType<typeof setup>>;
  const fences:string[]=[];
  const stop=vi.fn(async(id:string,notAfter:number,fence:string)=>{expect(id).toBe(f.session.id);fences.push(fence);return stopImpl?stopImpl(f,notAfter):(f.mux.isPaneDead.mockReturnValue(true),{stopped:true});});
  let ended=false;
  const settle=vi.fn(async(id:string,fence:string)=>{expect([id,fence]).toEqual([f.session.id,fences.at(-1)]);
   if(ended)return {signalled:false};if(settleImpl)return settleImpl(f);throw new Error('the laptop has not answered');});
  f=await setup({stop,settle},waitMs,{dispatchMs:bounds?.dispatchMs??25_000,settleRetryMs:bounds?.settleRetryMs??20});
  f.mux.isPaneDead.mockReturnValue(false);
  cleanups.push(async()=>{ended=true;await new Promise(resolve=>setTimeout(resolve,60));});  // the laptop finally fences any open stop
  vi.spyOn(f.session,'isBusy').mockReturnValue(true);
  vi.spyOn(f.session,'lastActivityAt','get').mockReturnValue(Date.now());
  vi.spyOn(f.session,'lastSubmitAt','get').mockReturnValue(Date.now()-3*3600_000);
  const recover=vi.spyOn(f.session,'restartDeadCli').mockResolvedValue(true);
  return {...f,stop,settle,fences,recover};
 }
 const confirm=(f:{session:Session})=>({forceRestart:true,confirmSessionId:f.session.id});
 it('stops only that agent through the broker, then relaunches it through dead-pane recovery',async()=>{
  const f=await wedged();expect(f.session.hasDeadPane()).toBe(false);
  const response=await f.app.inject({method:'POST',url:f.url,headers,payload:confirm(f)});
  expect(response.statusCode,response.body).toBe(200);expect(response.json().data.recovery).toBe('normal-launch-requested');
  expect(f.stop).toHaveBeenCalledOnce();expect(f.recover).toHaveBeenCalledOnce();
 });
 it('never stops an agent without the owner confirming this exact session',async()=>{
  const f=await wedged();
  for(const payload of [{},{forceRestart:true},{forceRestart:true,confirmSessionId:'other'}])
   expect((await f.app.inject({method:'POST',url:f.url,headers,payload})).statusCode).toBe(409);
  expect((await f.app.inject({method:'POST',url:f.url,payload:confirm(f)})).statusCode).toBe(403);
  expect(f.stop).not.toHaveBeenCalled();expect(f.recover).not.toHaveBeenCalled();
 });
 it.each(['task','dialog','recent-input','off']as const)('refuses before stopping when %s',async kind=>{
  const f=await wedged();
  if(kind==='task')vi.spyOn(f.session,'runningTaskCount','get').mockReturnValue(1);
  if(kind==='dialog')vi.spyOn(f.session,'paneDialog','get').mockReturnValue('permission');
  if(kind==='recent-input')vi.spyOn(f.session,'lastSubmitAt','get').mockReturnValue(Date.now()-30_000);
  if(kind==='off')await f.company.setDesiredRunning(f.session.id,false);
  expect((await f.app.inject({method:'POST',url:f.url,headers,payload:confirm(f)})).statusCode).toBe(409);
  expect(f.stop).not.toHaveBeenCalled();expect(f.recover).not.toHaveBeenCalled();
 });
 it('reports a broker refusal and lets the owner try again',async()=>{
  // A definitive refusal arrives as {dispatched:false}; a thrown error is an unknown outcome (see the unconfirmed-stop tests).
  const f=await wedged(async()=>({action:'stop-agent',success:false,dispatched:false,error:'Laptop pane state is unavailable; nothing was stopped'}));
  const response=await f.app.inject({method:'POST',url:f.url,headers,payload:confirm(f)});
  expect(response.statusCode).toBe(409);expect(response.json().error).toContain('nothing was stopped');
  expect(f.recover).not.toHaveBeenCalled();
  f.stop.mockImplementation(async()=>{f.mux.isPaneDead.mockReturnValue(true);return {stopped:true};});
  expect((await f.app.inject({method:'POST',url:f.url,headers,payload:confirm(f)})).statusCode).toBe(200);
 });
 it('does not relaunch until the session itself reports the dead pane',async()=>{
  const f=await wedged(async()=>({stopped:true}),300);
  const response=await f.app.inject({method:'POST',url:f.url,headers,payload:confirm(f)});
  expect(response.statusCode).toBe(409);expect(response.json().error).toContain('has not reported the exit');
  expect(f.recover).not.toHaveBeenCalled();
 });
 it('is not used without the host laptop manager',async()=>{
  const f=await wedged();vi.stubEnv('REVERIE_WORKER_SOCKET','');
  await f.app.inject({method:'POST',url:f.url,headers,payload:confirm(f)});
  expect(f.stop).not.toHaveBeenCalled();
 });
 // The stop is asynchronous: the recovery owns the pane's input from before the request until it resolves.
 async function pausedStop(){
  let enter!:()=>void,release!:()=>void;
  const entered=new Promise<void>(resolve=>{enter=resolve;});const resume=new Promise<void>(resolve=>{release=resolve;});
  const f=await wedged(async state=>{enter();await resume;state.mux.isPaneDead.mockReturnValue(true);return {stopped:true};});
  const keys:string[]=[];
  Object.assign(f.mux,{sendInput:vi.fn(async(_id:string,text:string)=>{keys.push(text);return true;}),capturePaneText:vi.fn(()=>'')});
  return {...f,entered,release,keys};
 }
 it('refuses every input path while the stop is pending, so the stop never kills newly accepted work',async()=>{
  const f=await pausedStop();
  const pending=f.app.inject({method:'POST',url:f.url,headers,payload:confirm(f)});
  await f.entered;
  expect(await f.session.writeViaMux('new owner work\r',{fromUser:true})).toBe(false);
  expect(await f.session.writeViaMux('agent work\r',{agentInput:true})).toBe(false);
  expect(f.session.write('raw work\r')).toBe(false);
  expect(f.keys).toEqual([]);
  f.release();
  const response=await pending;
  expect(response.statusCode,response.body).toBe(200);expect(f.recover).toHaveBeenCalledOnce();
 });
 it('withholds a deferred verifier Enter from an earlier write while the stop is pending',async()=>{
  const f=await pausedStop();
  expect(await f.session.writeViaMux('earlier work\r',{fromUser:true})).toBe(true);
  const verifier=(f.session as unknown as {_submitVerifier?:{deps:{sendEnter():Promise<boolean>}}})._submitVerifier;
  expect(verifier).toBeDefined();
  f.keys.length=0;
  const pending=f.app.inject({method:'POST',url:f.url,headers,payload:confirm(f)});
  await f.entered;
  expect(await verifier!.deps.sendEnter()).toBe(false);expect(f.keys).toEqual([]);
  f.release();expect((await pending).statusCode).toBe(200);
 });
 it('does not stop the agent while input is still being typed into it',async()=>{
  const f=await wedged();let finish!:(sent:boolean)=>void;
  Object.assign(f.mux,{sendInput:vi.fn(()=>new Promise<boolean>(resolve=>{finish=resolve;}))});
  const typing=f.session.writeViaMux('typing now\r',{fromUser:true});
  const response=await f.app.inject({method:'POST',url:f.url,headers,payload:confirm(f)});
  expect(response.statusCode).toBe(409);expect(response.json().error).toContain('being typed');
  expect(f.stop).not.toHaveBeenCalled();expect(f.recover).not.toHaveBeenCalled();
  finish(true);await typing;
 });
 it('gives input back at once when the broker definitively refused before any signal',async()=>{
  const f=await wedged(async()=>({action:'stop-agent',success:false,dispatched:false,error:'Laptop pane state is unavailable; nothing was stopped'}));
  const keys:string[]=[];
  Object.assign(f.mux,{sendInput:vi.fn(async(_id:string,text:string)=>{keys.push(text);return true;})});
  const response=await f.app.inject({method:'POST',url:f.url,headers,payload:confirm(f)});
  expect(response.statusCode).toBe(409);expect(response.json().error).toContain('nothing was stopped');
  expect(await f.session.writeViaMux('after a refused stop\r',{fromUser:true})).toBe(true);
  expect(keys).toEqual(['after a refused stop\r']);expect(f.recover).not.toHaveBeenCalled();
 });
 it('does not ask for a stop while a start, restart or attach of the pane is in progress',async()=>{
  const f=await wedged();
  vi.spyOn(f.session,'paneLifecycleInFlight','get').mockReturnValue(true);
  const response=await f.app.inject({method:'POST',url:f.url,headers,payload:confirm(f)});
  expect(response.statusCode).toBe(409);expect(response.json().error).toContain('existing restart');
  expect(f.stop).not.toHaveBeenCalled();expect(ownerStopPending(f.session.id)).toBe(false);
  (f.session as unknown as {_paneLifecycleOps:number})._paneLifecycleOps=1;  // and the hold itself refuses meanwhile
  expect(f.session.holdInputForRecovery()).toBeUndefined();
  (f.session as unknown as {_paneLifecycleOps:number})._paneLifecycleOps=0;
 });
 it('passes the broker a dispatch deadline and a fresh fence for each stop',async()=>{
  const before=Date.now();const f=await wedged(undefined,undefined,{dispatchMs:25_000});
  await f.app.inject({method:'POST',url:f.url,headers,payload:confirm(f)});
  const notAfter=f.stop.mock.calls[0][1];
  expect(notAfter).toBeGreaterThanOrEqual(before+25_000);expect(notAfter).toBeLessThanOrEqual(Date.now()+25_000);
  f.mux.isPaneDead.mockReturnValue(false);await f.app.inject({method:'POST',url:f.url,headers,payload:confirm(f)});
  expect(f.fences).toHaveLength(2);for(const fence of f.fences)expect(fence).toMatch(/^[0-9a-f]{32}$/);
  expect(f.fences[0]).not.toBe(f.fences[1]);
 });
 it('keeps input and restarts held after an unconfirmed stop until the laptop fences it, then gives them back',async()=>{
  let answers=0;
  const f=await wedged(async()=>{throw Object.assign(new Error('client deadline exceeded'),{killed:true,signal:'SIGTERM'});},undefined,
   {dispatchMs:150,settleRetryMs:20},async()=>{if(++answers<4)throw new Error('the laptop has not answered');return {signalled:false};});
  const keys:string[]=[];
  Object.assign(f.mux,{sendInput:vi.fn(async(_id:string,text:string)=>{keys.push(text);return true;})});
  const response=await f.app.inject({method:'POST',url:f.url,headers,payload:confirm(f)});
  expect(response.statusCode).toBe(409);expect(response.json().error).toContain('stay held until the laptop confirms whether the stop ran');
  expect(await f.session.writeViaMux('too early\r',{fromUser:true})).toBe(false);
  // A second recovery cannot race the unresolved stop either.
  expect((await f.app.inject({method:'POST',url:f.url,headers,payload:confirm(f)})).statusCode).toBe(409);
  expect(f.stop).toHaveBeenCalledTimes(1);
  await vi.waitFor(()=>expect(f.settle).toHaveBeenCalledTimes(4));
  await vi.waitFor(async()=>expect(await f.session.writeViaMux('after the fence\r',{fromUser:true})).toBe(true));
  expect(keys).toEqual(['after the fence\r']);
 });
 it('no elapsed time releases an unconfirmed stop while the laptop does not answer',async()=>{
  const laptop:{answer?:unknown}={};
  const f=await wedged(async()=>{throw new Error('lost connection');},undefined,{dispatchMs:10,settleRetryMs:20},
   async()=>{if(laptop.answer)return laptop.answer;throw new Error('the laptop has not answered');});
  Object.assign(f.mux,{sendInput:vi.fn(async()=>true)});
  expect((await f.app.inject({method:'POST',url:f.url,headers,payload:confirm(f)})).statusCode).toBe(409);
  await new Promise(resolve=>setTimeout(resolve,400));  // far past the deadline and every engine-call bound used before
  expect(f.settle.mock.calls.length).toBeGreaterThan(3);
  expect(await f.session.writeViaMux('still held\r',{fromUser:true})).toBe(false);
  laptop.answer={signalled:false};
  await vi.waitFor(()=>expect((f.session as unknown as {_recoveryHold:boolean})._recoveryHold).toBe(false));
  expect(await f.session.writeViaMux('after the fence\r',{fromUser:true})).toBe(true);
 });
 it('gives input back once the laptop says the stop signalled and its exec has exited, and stops asking',async()=>{
  const f=await wedged(async()=>{throw new Error('lost connection');},undefined,{dispatchMs:10,settleRetryMs:20},async()=>({signalled:true}));
  expect((await f.app.inject({method:'POST',url:f.url,headers,payload:confirm(f)})).statusCode).toBe(409);
  await vi.waitFor(()=>expect((f.session as unknown as {_recoveryHold:boolean})._recoveryHold).toBe(false));
  await new Promise(resolve=>setTimeout(resolve,100));
  expect(f.settle).toHaveBeenCalledTimes(1);
  expect(ownerStopPending(f.session.id)).toBe(false);
 });
 it('a dead pane or viewer releases nothing: no input, no restart and no new pane until the laptop answers',async()=>{
  const f=await wedged(async state=>{setTimeout(()=>state.mux.isPaneDead.mockReturnValue(true),50);throw new Error('lost connection');},undefined,{dispatchMs:60_000});
  expect((await f.app.inject({method:'POST',url:f.url,headers,payload:confirm(f)})).statusCode).toBe(409);
  await new Promise(resolve=>setTimeout(resolve,300));
  expect(f.session.hasDeadPane()).toBe(true);
  expect(await f.session.writeViaMux('too early\r',{fromUser:true})).toBe(false);
  expect(ownerStopPending(f.session.id)).toBe(true);
  // The ordinary dead-pane restart is refused, and so is any pane replacement by the session itself.
  const relaunch=vi.spyOn(f.mux,'respawnPane');f.recover.mockRestore();
  expect((await f.app.inject({method:'POST',url:f.url,headers,payload:{}})).statusCode).toBe(409);
  expect(await f.session.restartCli()).toBe(false);
  expect(relaunch).not.toHaveBeenCalled();
 });
 // First review control (stop-agent-late-input-hold-r1, frozen as stop-recovery-late-input-control.test.ts), body unchanged.
 it('review: late accepted input cannot be killed by a pending stale-recovery stop',async()=>{
  let enter!:()=>void, release!:()=>void;
  const entered=new Promise<void>(resolve=>{enter=resolve});
  const resume=new Promise<void>(resolve=>{release=resolve});
  const trace:unknown[]=[];
  const f=await wedged(async state=>{
   trace.push('stop-request-entered');enter();await resume;
   trace.push({kind:'stop-signal-commit',lastSubmitAt:state.session.lastSubmitAt});
   state.mux.isPaneDead.mockReturnValue(true);return {stopped:true};
  });
  vi.spyOn(f.session,'lastSubmitAt','get').mockRestore();
  const keys:string[]=[];
  Object.assign(f.mux,{sendInput:vi.fn(async(_id:string,text:string)=>{keys.push(text);return true})});
  const pending=f.app.inject({method:'POST',url:f.url,headers,payload:confirm(f)});
  await entered;
  let wrote=false;
  try{wrote=await f.session.writeViaMux('new owner work\r',{fromUser:true});}
  finally{release();}
  const response=await pending;
  console.log('LATE-INPUT-TRACE',JSON.stringify({wrote,keys,status:response.statusCode,trace}));
  expect(wrote && response.statusCode===200,'new accepted input must not be followed by a successful stale-recovery kill').toBe(false);
 });
 // Review control (stop-recovery-e7b01e12-review-r1, stop-uncertain.private.test.ts), body unchanged.
 it('PRIVATE: an unconfirmed stop timeout cannot release input before the remote stop commits',async()=>{
  let remoteCommit!:()=>void;let remoteCommitted=false;
  const f=await wedged(async state=>{
   // Model the real bridge's client timeout: the independent broker operation
   // remains able to commit after the client has stopped waiting.
   remoteCommit=()=>{remoteCommitted=true;state.mux.isPaneDead.mockReturnValue(true)};
   throw Object.assign(new Error('reverie-worker-exec client deadline exceeded'),{killed:true,signal:'SIGTERM',code:null});
  });
  const keys:string[]=[];
  Object.assign(f.mux,{sendInput:vi.fn(async(_id:string,text:string)=>{keys.push(text);return true})});
  const response=await f.app.inject({method:'POST',url:f.url,headers,payload:confirm(f)});
  expect(response.statusCode).toBe(409);expect(f.recover).not.toHaveBeenCalled();
  const wrote=await f.session.writeViaMux('new work after an unconfirmed stop\r',{fromUser:true});
  remoteCommit();
  console.info('UNCERTAIN-STOP-WITNESS',JSON.stringify({wrote,keys,remoteCommitted,status:response.statusCode}));
  expect(wrote&&remoteCommitted).toBe(false);
 });
 // Review control (stop-recovery-2ce74d72-review-r3, stop-engine-bound.private.test.ts), body unchanged.
 it('PRIVATE: a client timeout cannot release input while its daemon request can still signal',async()=>{
  const bounds={dispatchMs:10,signalMs:10,noticeMs:10};let commit!:()=>void;let committed=false;
  const f=await wedged(async state=>{
   commit=()=>{committed=true;state.mux.isPaneDead.mockReturnValue(true);};
   throw Object.assign(new Error('engine client timeout; accepted daemon request not cancelled'),{killed:true,signal:'SIGKILL'});
  },undefined,bounds);
  const keys:string[]=[];Object.assign(f.mux,{sendInput:vi.fn(async(_id:string,text:string)=>{keys.push(text);return true;})});
  const response=await f.app.inject({method:'POST',url:f.url,headers,payload:confirm(f)});
  expect(response.statusCode).toBe(409);
  expect(await f.session.writeViaMux('before the assumed bound\r',{fromUser:true})).toBe(false);
  await new Promise(resolve=>setTimeout(resolve,180));
  const wrote=await f.session.writeViaMux('new work after the assumed bound\r',{fromUser:true});commit();
  console.info('ENGINE-SETTLE-BOUND-WITNESS',JSON.stringify({bounds,wrote,keys,committed,status:response.statusCode}));
  expect(wrote&&committed,'a deadline on the engine client is not cancellation of accepted daemon execution').toBe(false);
 });
});

describe('an unsettled owner stop across a website restart',()=>{
 // A fresh website process: a new Session for the same id and live pane, and the stop journal read again from disk.
 async function restartedWebsite(f:Awaited<ReturnType<typeof setup>>){
  useOwnerStopJournal(journal);
  const restored=new Session({...f.session.toState(),id:f.session.id,useMux:true,mux:f.mux as unknown as TerminalMultiplexer,
   muxSession:{sessionId:'owned',muxName:'reverie-owned',pid:41}as MuxSession});
  cleanups.push(async()=>{Object.assign(restored,{ptyProcess:null,_muxSession:null});await restored.stop(false);});
  f.ctx.sessions.set(f.session.id,restored);
  return restored;
 }
 let journal='';
 afterEach(()=>useOwnerStopJournal());
 async function unconfirmed(settle:LaptopAgentStop['settle']){
  vi.stubEnv('REVERIE_WORKER_SOCKET','/run/fixture/broker.sock');
  const laptop={stop:vi.fn(async()=>{throw new Error('accepted remote exec; response lost');}),settle:vi.fn(settle)};
  const f=await setup(laptop,20,{dispatchMs:25_000,settleRetryMs:20});f.mux.isPaneDead.mockReturnValue(false);
  journal=join(f.session.workingDir,'owner-stops');useOwnerStopJournal(journal);
  vi.spyOn(f.session,'lastSubmitAt','get').mockReturnValue(Date.now()-3*3600_000);
  const keys:string[]=[];Object.assign(f.mux,{sendInput:vi.fn(async(_id:string,text:string)=>{keys.push(text);return true;})});
  const response=await f.app.inject({method:'POST',url:f.url,headers,payload:{forceRestart:true,confirmSessionId:f.session.id}});
  expect(response.statusCode).toBe(409);
  return {...f,laptop,keys};
 }
 it('writes the stop down before asking for it, so a restarted website keeps the input held and refuses a second recovery',async()=>{
  const laptopSays:{answer?:unknown}={};const f=await unconfirmed(async()=>{if(laptopSays.answer)return laptopSays.answer;throw new Error('settlement unavailable');});
  expect(readdirSync(journal)).toEqual([`${f.session.id}.json`]);
  expect(statSync(join(journal,`${f.session.id}.json`)).mode&0o777).toBe(0o600);
  const restored=await restartedWebsite(f);
  expect(ownerStopPending(f.session.id)).toBe(true);
  expect(await restored.writeViaMux('owner work after the restart\r',{fromUser:true})).toBe(false);
  expect(restored.write('raw work\r')).toBe(false);
  expect(restored.holdInputForRecovery()).toBeUndefined();
  expect((await f.app.inject({method:'POST',url:f.url,headers,payload:{forceRestart:true,confirmSessionId:f.session.id}})).statusCode).toBe(409);
  expect(f.laptop.stop).toHaveBeenCalledTimes(1);
  expect(f.keys).toEqual([]);
  // The restarted website resumes settling the same fence; only the laptop's answer gives the input back.
  const fence=f.laptop.stop.mock.calls[0][2];
  laptopSays.answer={signalled:false};
  await Promise.all(resumeOwnerStops(f.laptop,(id)=>f.ctx.sessions.get(id),20));
  await vi.waitFor(()=>expect(ownerStopPending(f.session.id)).toBe(false));
  expect(f.laptop.settle.mock.calls.every(([id,asked])=>id===f.session.id&&asked===fence)).toBe(true);
  expect(readdirSync(journal)).toEqual([]);
  expect(await restored.writeViaMux('after the fence\r',{fromUser:true})).toBe(true);
  expect(f.keys).toEqual(['after the fence\r']);
 });
 it('after a restart, a dead pane releases nothing; only the laptop saying the stop signalled and exited does',async()=>{
  const laptopSays:{answer?:unknown}={};
  const f=await unconfirmed(async()=>{if(laptopSays.answer)return laptopSays.answer;throw new Error('settlement unavailable');});
  const restored=await restartedWebsite(f);
  f.mux.isPaneDead.mockReturnValue(true);vi.spyOn(restored,'hasDeadPane').mockReturnValue(true);
  await Promise.all(resumeOwnerStops(f.laptop,(id)=>f.ctx.sessions.get(id),20));
  await new Promise(resolve=>setTimeout(resolve,150));
  expect(ownerStopPending(f.session.id)).toBe(true);
  expect(await restored.writeViaMux('too early\r',{fromUser:true})).toBe(false);
  await expect(restored.startInteractive()).rejects.toThrow('unsettled owner stop');  // no new process in that pane
  laptopSays.answer={signalled:true};
  await vi.waitFor(()=>expect(ownerStopPending(f.session.id)).toBe(false));
 });
 it('refuses to ask for a stop it cannot write down, and gives the input back',async()=>{
  vi.stubEnv('REVERIE_WORKER_SOCKET','/run/fixture/broker.sock');
  const laptop={stop:vi.fn(async()=>({stopped:true})),settle:vi.fn(async()=>({signalled:false}))};
  const f=await setup(laptop,20,{dispatchMs:25_000,settleRetryMs:20});f.mux.isPaneDead.mockReturnValue(false);
  const locked=join(f.session.workingDir,'locked');mkdirSync(locked,{mode:0o500});cleanups.push(async()=>chmodSync(locked,0o700));
  useOwnerStopJournal(join(locked,'owner-stops'));  // the website cannot create its record there
  vi.spyOn(f.session,'lastSubmitAt','get').mockReturnValue(Date.now()-3*3600_000);
  const keys:string[]=[];Object.assign(f.mux,{sendInput:vi.fn(async(_id:string,text:string)=>{keys.push(text);return true;})});
  const response=await f.app.inject({method:'POST',url:f.url,headers,payload:{forceRestart:true,confirmSessionId:f.session.id}});
  expect(response.statusCode).toBe(503);expect(response.json().error).toContain('nothing was stopped');
  expect(laptop.stop).not.toHaveBeenCalled();
  expect(await f.session.writeViaMux('after a refused stop\r',{fromUser:true})).toBe(true);expect(keys).toEqual(['after a refused stop\r']);
 });
 it('clears the record once a stop is definitive, so a restart holds nothing',async()=>{
  vi.stubEnv('REVERIE_WORKER_SOCKET','/run/fixture/broker.sock');
  const pane={dead:false};
  const laptop={stop:vi.fn(async()=>{pane.dead=true;return {stopped:true};}),settle:vi.fn(async()=>({signalled:false}))};
  const f=await setup(laptop,500,{dispatchMs:25_000,settleRetryMs:20});f.mux.isPaneDead.mockImplementation(()=>pane.dead);
  journal=join(f.session.workingDir,'owner-stops');useOwnerStopJournal(journal);
  vi.spyOn(f.session,'lastSubmitAt','get').mockReturnValue(Date.now()-3*3600_000);
  vi.spyOn(f.session,'restartDeadCli').mockResolvedValue(true);
  expect((await f.app.inject({method:'POST',url:f.url,headers,payload:{forceRestart:true,confirmSessionId:f.session.id}})).statusCode).toBe(200);
  useOwnerStopJournal(journal);
  expect(ownerStopPending(f.session.id)).toBe(false);expect(readdirSync(journal)).toEqual([]);
 });
 // Review control (stop-recovery-69878950-review-r5, recovery-server-recreate.private.test.ts), body unchanged.
 it('does not admit new work into the same native pane while its accepted stop remains unknown',async()=>{
  vi.stubEnv('REVERIE_WORKER_SOCKET','/run/fixture/broker.sock');
  let queued=false,signalled=false;let cutoff=0;
  const stop={stop:vi.fn(async(_id:string,notAfter:number,_fence:string)=>{queued=true;cutoff=notAfter;throw new Error('accepted remote exec; response lost');}),
   settle:vi.fn(async()=>{throw new Error('remote settlement still unavailable');})};
  const f=await setup(stop,20,{dispatchMs:25_000,settleRetryMs:20});f.mux.isPaneDead.mockReturnValue(false);
  vi.spyOn(f.session,'lastSubmitAt','get').mockReturnValue(Date.now()-3*3600_000);
  const response=await f.app.inject({method:'POST',url:f.url,headers,payload:{forceRestart:true,confirmSessionId:f.session.id}});
  expect(response.statusCode).toBe(409);expect(queued).toBe(true);
  const keys:string[]=[];Object.assign(f.mux,{sendInput:vi.fn(async(_id:string,text:string)=>{keys.push(text);return true;})});
  expect(await f.session.writeViaMux('before website restoration\r',{fromUser:true})).toBe(false);
  // Server.stop persists toState without killing the native pane. restoreMuxSessions makes a new Session with the
  // same mux/session id and saved recipe. Execute that actual Session constructor/serialization boundary, without
  // starting a real website, provider, tmux, broker or model. The fake remote request remains accepted and unsettled.
  const saved=f.session.toState();
  const restored=new Session({...saved,id:f.session.id,useMux:true,mux:f.mux as unknown as TerminalMultiplexer,
   muxSession:{sessionId:'owned',muxName:'reverie-owned',pid:41}as MuxSession});
  cleanups.push(async()=>{Object.assign(restored,{ptyProcess:null,_muxSession:null});await restored.stop(false);});
  f.ctx.sessions.set(f.session.id,restored);
  const wrote=await restored.writeViaMux('new work after website restoration\r',{fromUser:true});
  expect(Date.now()).toBeLessThan(cutoff); // an actual signal-site deadline has not expired
  signalled=true;f.mux.isPaneDead.mockReturnValue(true);
  console.info('RECOVERY-RECREATION-WITNESS',JSON.stringify({queued,wrote,keys,signalled,withinDeadline:Date.now()<cutoff,settlements:stop.settle.mock.calls.length}));
  expect(wrote&&signalled,'restored viewer may not admit work that a still-accepted stop can kill').toBe(false);
 });
});

describe('no new process at the mux while an owner stop is unsettled',()=>{
 afterEach(()=>useOwnerStopJournal());
 it('TmuxManager.respawnPane refuses before any tmux command when it is not admitted',async()=>{
  const {TmuxManager}=await import('../src/tmux-manager.js');
  vi.spyOn(TmuxManager.prototype as never,'loadSessions').mockImplementation(()=>{});
  const mux=new TmuxManager();
  (mux as unknown as {sessions:Map<string,unknown>}).sessions.set('held-session',{muxName:'reverie-held',sessionId:'held-session',pid:41,mode:'opencode'});
  const env=vi.spyOn(mux as never,'_configureCliEnv' as never).mockImplementation((()=>{}) as never);
  const dir=await mkdtemp(join(tmpdir(),'mux-admission-'));cleanups.push(()=>rm(dir,{recursive:true,force:true}));
  expect(await mux.respawnPane({sessionId:'held-session',workingDir:dir,mode:'opencode',admitted:()=>false} as never)).toBeNull();
  expect(env).not.toHaveBeenCalled();  // refused before the pane's environment, let alone its launch, is touched
 });
 it('every respawn a Session asks for carries an admission that follows the durable record while the mux works',async()=>{
  const f=await setup();
  const journal=join(f.session.workingDir,'owner-stops');useOwnerStopJournal(journal);
  vi.spyOn(f.session,'applyFullAccessDefault').mockResolvedValue([]);
  vi.spyOn(f.session as never,'_prepareSelectedClaudeProfile' as never).mockResolvedValue(undefined as never);
  vi.spyOn(f.session as never,'_prepareManagedCodexTrust' as never).mockResolvedValue(undefined as never);
  vi.spyOn(f.session as never,'_scheduleFullAccessCheck' as never).mockResolvedValue([] as never);
  vi.spyOn(f.session as never,'_buildRespawnPaneOptionsWithResumePin' as never).mockResolvedValue({sessionId:f.session.id,workingDir:f.session.workingDir,mode:'opencode'} as never);
  let admittedDuringLaunch:boolean|undefined;
  f.mux.respawnPane.mockImplementation(async(options:{admitted?:()=>boolean})=>{
   // A stop is recorded while the mux is still working on the launch: its own final check must now refuse.
   recordOwnerStop(f.session.id,{fence:'2'.repeat(32),notAfter:Date.now()+25_000});
   admittedDuringLaunch=options.admitted?.();
   return admittedDuringLaunch?42:null;
  });
  expect(await f.session.restartDeadCli(()=>true)).toBe(false);
  expect(f.mux.respawnPane).toHaveBeenCalledOnce();
  expect(admittedDuringLaunch).toBe(false);
 });
});
