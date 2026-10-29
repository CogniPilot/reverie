import Fastify from 'fastify';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Session} from '../src/session.js';
import {WebServer} from '../src/web/server.js';
import {CompanyStore} from '../src/company-store.js';
import {CompanyService} from '../src/company-service.js';
import {registerSessionRuntimeRoutes} from '../src/web/routes/session-runtime-routes.js';
import type {TerminalMultiplexer,MuxSession} from '../src/mux-interface.js';

const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{vi.unstubAllEnvs();vi.restoreAllMocks();for(const clean of cleanups.splice(0).reverse())await clean();});
async function setup(){
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
 const app=Fastify();registerSessionRuntimeRoutes(app,ctx as never,req=>req.headers.cookie==='fixture-owner=yes',undefined,company);
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
