// Review control (stop-recovery-7e7bb483-review-r6, recovery-dead-viewer-unfenced.private.test.ts), unchanged below this line.
import Fastify from 'fastify';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Session} from '../src/session.js';
import {WebServer} from '../src/web/server.js';
import {CompanyStore} from '../src/company-store.js';
import {CompanyService} from '../src/company-service.js';
import {registerSessionRuntimeRoutes,resumeOwnerStops,runtimeSwitches,type LaptopAgentStop,type StopBounds} from '../src/web/routes/session-runtime-routes.js';
import {ownerStopPending,useOwnerStopJournal,recordOwnerStop} from '../src/owner-stop-journal.js';
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

describe('a dead old viewer does not fence an accepted stop',()=>{
 it('keeps its record until the broker fences an accepted request, even if the old viewer pane is dead',async()=>{
  vi.stubEnv('REVERIE_WORKER_SOCKET','/run/fixture/broker.sock');
  const settle=vi.fn(async()=>{throw new Error('accepted stop not yet scheduled; broker settle unavailable');});
  const f=await setup({stop:vi.fn(),settle});
  const journal=join(f.session.workingDir,'owner-stops');useOwnerStopJournal(journal);
  cleanups.push(async()=>{runtimeSwitches.delete(f.session.id);useOwnerStopJournal();});
  const notAfter=Date.now()+25_000;const fence='1'.repeat(32);
  recordOwnerStop(f.session.id,{fence,notAfter});
  // The website restarted while the broker control request was accepted but had not yet read its inner pane PID.
  // Its old outer viewer is dead. That alone says nothing about the broker request's ability to signal later.
  const keys:string[]=[];Object.assign(f.mux,{sendInput:vi.fn(async(_id:string,text:string)=>{keys.push(text);return true;})});
  await Promise.all(resumeOwnerStops({stop:vi.fn(),settle},id=>id===f.session.id?f.session:undefined,1));
  const pendingAfterResume=ownerStopPending(f.session.id);
  // Owner recovery is real route logic; only the external pane relaunch is represented by an inert fixture.
  vi.spyOn(f.session,'restartDeadCli').mockImplementation(async current=>{
   if(!current())return false;f.mux.isPaneDead.mockReturnValue(false);f.session.clearPaneExitForNewPane();return true;
  });
  const response=await f.app.inject({method:'POST',url:f.url,headers,payload:{}});
  const wrote=await f.session.writeViaMux('new work before delayed stop runs\r',{fromUser:true});
  // Broker.stop_agent obtains the pane PID when it runs, not when this request was accepted (separate actual-Broker control).
  const delayedStopCouldSignalNewPane=Date.now()<notAfter&&response.statusCode===200;
  console.info('DEAD-VIEWER-UNFENCED-WITNESS',JSON.stringify({pendingAfterResume,settlements:settle.mock.calls.length,
   restartStatus:response.statusCode,wrote,keys,delayedStopCouldSignalNewPane,withinDeadline:Date.now()<notAfter}));
  expect(wrote&&delayedStopCouldSignalNewPane,'dead old viewer is not a terminal decision on an accepted stop').toBe(false);
 });
});
