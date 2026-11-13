import { acknowledgeMuxFixture } from './helpers/acknowledged-mux-fixture.js';
// Review control (stop-recovery-5649a994-review-r7, recovery-stop-during-prepare.private.test.ts), unchanged below this line.
// Review control (stop-recovery-7e7bb483-review-r6, recovery-dead-viewer-unfenced.private.test.ts), unchanged below this line.
import Fastify from 'fastify';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {Session} from '../src/session.js';
import {WebServer} from '../src/web/server.js';
import {CompanyStore} from '../src/company-store.js';
import {CompanyService} from '../src/company-service.js';
import {registerSessionRuntimeRoutes,resumeOwnerStops,runtimeSwitches,type LaptopAgentStop,type StopBounds} from '../src/web/routes/session-runtime-routes.js';
import {ownerStopPending,useOwnerStopJournal,recordOwnerStop} from '../src/owner-stop-journal.js';
import {chmodSync,mkdirSync,readdirSync,statSync} from 'node:fs';
import type {TerminalMultiplexer,MuxSession,RespawnPaneOptions} from '../src/mux-interface.js';
import type {PaneLiveness} from '../src/signal-target.js';

const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{vi.unstubAllEnvs();vi.restoreAllMocks();for(const clean of cleanups.splice(0).reverse())await clean();});
async function setup(stop?:LaptopAgentStop,waitMs?:number,bounds?:StopBounds,newPaneState:'live'|'dead'|'unreadable'='live'){
 const dir=await mkdtemp(join(tmpdir(),'dead-pane-owner-'));cleanups.push(()=>rm(dir,{recursive:true,force:true}));
 const subject:MuxSession={sessionId:randomUUID(),muxName:'reverie-owned',pid:41,owner:undefined,
  workingDir:dir,createdAt:Date.now(),mode:'opencode',attached:true};
 const registered=new Map([[subject.sessionId,subject]]),pane:{state:'live'|'dead'|'unreadable'}={state:'dead'};
 const mux={isAvailable:()=>true,muxSessionExists:vi.fn(()=>true),isPaneDead:vi.fn(()=>true),
  getSession:(id:string)=>registered.get(id)??null,
  readPaneLiveness:vi.fn(async(name:string):Promise<PaneLiveness>=>{
   const rows=[...registered.values()].filter(row=>row.muxName===name);
   if(!rows.length)return {state:'missing'};
   if(rows.length!==1)return {state:'ambiguous'};
   if(!Number.isSafeInteger(rows[0].pid)||rows[0].pid<=0)return {state:'unreadable'};
   return pane.state==='live'?{state:'live',pid:rows[0].pid}:{state:pane.state};
  }),
  respawnPane:vi.fn(async(options:RespawnPaneOptions)=>{
   if(options.admitted&&!options.admitted())return null;
   const original=registered.get(options.sessionId);if(original!==subject)return null;
   await acknowledgeMuxFixture(options);original.pid=42;pane.state=newPaneState;return original.pid;
  }),clearPaneExit:vi.fn()};
 const session=new Session({id:subject.sessionId,owner:subject.owner,workingDir:dir,mode:'opencode',useMux:true,mux:mux as unknown as TerminalMultiplexer,
  muxSession:subject,
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
 return {app,session,mux,subject,registered,store,company,employee,ctx,url:`/api/company/employees/${employee.id}/restart`};
}
const headers={cookie:'fixture-owner=yes'};
function stubRestartPreparation(session:Session){
 vi.spyOn(session,'applyFullAccessDefault').mockResolvedValue(false);
 vi.spyOn(session as never,'_prepareSelectedClaudeProfile' as never).mockResolvedValue(undefined as never);
 vi.spyOn(session as never,'_prepareManagedCodexTrust' as never).mockResolvedValue(undefined as never);
 vi.spyOn(session as never,'_scheduleFullAccessCheck' as never).mockResolvedValue([] as never);
}
function stubRespawnOptions(session:Session){
 vi.spyOn(session as never,'_buildRespawnPaneOptionsWithResumePin' as never).mockResolvedValue({
  sessionId:session.id,workingDir:session.workingDir,mode:'opencode'}as never);
}


describe('an owner stop accepted during asynchronous pane preparation',()=>{
 it.each(['dead','unreadable']as const)('keeps an attempted restart unconfirmed when the original new pane is %s',async(state)=>{
  vi.stubEnv('REVERIE_WORKER_SOCKET','/run/fixture/broker.sock');
  const f=await setup(undefined,undefined,undefined,state);
  f.mux.isPaneDead.mockReturnValue(false);f.session.setPaneExit(undefined);
  stubRestartPreparation(f.session);stubRespawnOptions(f.session);
  const intent=f.company.prepareRuntimeRestart(f.session.id,undefined);expect(intent).toBeDefined();
  await intent!.claim();cleanups.push(async()=>{intent!.finish();});
  await expect(f.session.restartCli()).rejects.toThrow('Provider launch outcome is unconfirmed');
  expect(f.session.providerDispatchHeld).toBe(true);
  expect(f.registered.get(f.session.id)).toBe(f.subject);expect(f.subject.pid).toBe(42);
  expect(f.mux.readPaneLiveness).toHaveBeenCalledWith(f.subject.muxName);
  expect(f.mux.respawnPane).toHaveBeenCalledOnce();expect(ownerStopPending(f.session.id)).toBe(false);
  await expect(f.session.restartCli()).rejects.toThrow('Provider launch outcome is unconfirmed');
  expect(f.mux.respawnPane).toHaveBeenCalledOnce();
 });
 it('refuses an already-started restart at the actual pane replacement boundary',async()=>{
  vi.stubEnv('REVERIE_WORKER_SOCKET','/run/fixture/broker.sock');
  const settle=vi.fn(async()=>{throw new Error('accepted stop remains unknown');});
  const stop=vi.fn(async()=>{throw new Error('accepted stop, response lost');});
  const f=await setup({stop,settle},20,{dispatchMs:25_000,settleRetryMs:20});
  const journal=join(f.session.workingDir,'owner-stops');useOwnerStopJournal(journal);
  cleanups.push(async()=>{runtimeSwitches.delete(f.session.id);useOwnerStopJournal();});
  f.mux.isPaneDead.mockReturnValue(false);f.session.setPaneExit(undefined);
  vi.spyOn(f.session,'lastSubmitAt','get').mockReturnValue(Date.now()-3*3600_000);
  stubRestartPreparation(f.session);
  let release!:()=>void,entered!:()=>void;const preparing=new Promise<void>(r=>entered=r);
  const wait=new Promise<void>(r=>release=r);
  vi.spyOn(f.session as never,'_buildRespawnPaneOptionsWithResumePin' as never).mockImplementation(async()=>{
   entered();await wait;return {sessionId:f.session.id,workingDir:f.session.workingDir,mode:'opencode'}as never;
  });
  // Same real intent transaction that session-routes ownerRestart claims before restartCli.
  const intent=f.company.prepareRuntimeRestart(f.session.id,undefined);expect(intent).toBeDefined();
  await intent!.claim();cleanups.push(async()=>{intent!.finish();});
  const restart=f.session.restartCli();await preparing;
  const response=await f.app.inject({method:'POST',url:f.url,headers,payload:{forceRestart:true,confirmSessionId:f.session.id}});
  const heldBeforeReplacement=ownerStopPending(f.session.id);
  f.mux.isPaneDead.mockReturnValue(true); // old pane exits while the accepted stop is still unsettled
  release();const restarted=await restart;
  console.info('LATE-STOP-PREPARE-WITNESS',JSON.stringify({stopStatus:response.statusCode,heldBeforeReplacement,
   lifecycleInFlightAtStop:true,stopDispatched:stop.mock.calls.length>0,oldPaneExitedBeforeReplacement:true,restarted,replacements:f.mux.respawnPane.mock.calls.length,heldAfterReplacement:ownerStopPending(f.session.id)}));
  expect(response.statusCode).toBe(409);
  // Either refuse this stop before dispatch or prevent the restart from replacing the pane until settlement.
  if(stop.mock.calls.length){
   expect(heldBeforeReplacement).toBe(true);
   expect(f.mux.respawnPane,'no new process may enter a pane held by an unsettled stop').not.toHaveBeenCalled();
  }
 });
 it('never replaces a held pane that dies between the initial guard and the later liveness read',async()=>{
  vi.stubEnv('REVERIE_WORKER_SOCKET','/run/fixture/broker.sock');
  const f=await setup();const journal=join(f.session.workingDir,'owner-stops');useOwnerStopJournal(journal);
  cleanups.push(async()=>{runtimeSwitches.delete(f.session.id);useOwnerStopJournal();});
  recordOwnerStop(f.session.id,{fence:'2'.repeat(32),notAfter:Date.now()+25_000});
  // The original pane is alive for both admission reads and exits before the fresh branch read.
  f.mux.isPaneDead.mockReset().mockReturnValueOnce(false).mockReturnValueOnce(false).mockReturnValue(true);
  vi.spyOn(f.session,'applyFullAccessDefault').mockResolvedValue([]);
  vi.spyOn(f.session as never,'_prepareSelectedClaudeProfile' as never).mockResolvedValue(undefined as never);
  vi.spyOn(f.session as never,'_prepareManagedCodexTrust' as never).mockResolvedValue(undefined as never);
  vi.spyOn(f.session as never,'_ensurePaneDialogScan' as never).mockImplementation(()=>{});
  vi.spyOn(f.session as never,'_armPaneSettle' as never).mockImplementation(()=>{});
  stubRespawnOptions(f.session);
  vi.spyOn(f.session as never,'_attachExistingMuxClient' as never).mockImplementation(()=>{});
  const operation=f.session.startInteractive();
  let error:unknown;try{await operation;}catch(e){error=e;}
  console.info('HELD-PANE-EXIT-WITNESS',JSON.stringify({replacements:f.mux.respawnPane.mock.calls.length,
   pending:ownerStopPending(f.session.id),error:error instanceof Error?error.message:null}));
  expect(f.mux.respawnPane,'a second pane read may not bypass the hold').not.toHaveBeenCalled();
 });

 it('still allows attaching only to an already-live pane while its record exists',async()=>{
  const f=await setup();const journal=join(f.session.workingDir,'owner-stops');useOwnerStopJournal(journal);
  cleanups.push(async()=>{runtimeSwitches.delete(f.session.id);useOwnerStopJournal();});
  recordOwnerStop(f.session.id,{fence:'3'.repeat(32),notAfter:Date.now()+25_000});
  f.mux.isPaneDead.mockReturnValue(false);
  const attach=vi.spyOn(f.session as never,'_attachExistingMuxClient' as never).mockImplementation(()=>{});
  const answer=await(f.session as unknown as {_setupOrAttachMuxSession:(o:unknown)=>Promise<{isRestored:boolean}>})._setupOrAttachMuxSession({
   respawnPaneOptions:{},createSessionOptions:{},spawnErrLabel:'inert live-only attach'});
  expect(answer.isRestored).toBe(true);expect(attach).toHaveBeenCalledOnce();
  expect(f.mux.respawnPane).not.toHaveBeenCalled();expect(ownerStopPending(f.session.id)).toBe(true);
 });

});
