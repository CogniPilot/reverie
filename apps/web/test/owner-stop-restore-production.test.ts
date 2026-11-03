// Review control (stop-recovery-restore-production-path-r1, recovery-real-restore.private.test.ts), unchanged below this line.
import Fastify from 'fastify';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Session} from '../src/session.js';
import {WebServer} from '../src/web/server.js';
import {CompanyStore} from '../src/company-store.js';
import {CompanyService} from '../src/company-service.js';
import {registerSessionRuntimeRoutes,type LaptopAgentStop,type StopBounds} from '../src/web/routes/session-runtime-routes.js';
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

describe('unknown stop protection through actual production restoreMuxSessions',()=>{
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
  // Invoke the actual production restoreMuxSessions constructor/wiring, with external effects replaced by owned fixtures.
  const server=Object.create(WebServer.prototype) as any;
  const muxRecord={sessionId:f.session.id,muxName:'reverie-owned',pid:41,workingDir:saved.workingDir,mode:saved.mode,name:saved.name};
  Object.assign(f.mux,{reconcileSessions:vi.fn(async()=>({alive:[f.session.id],dead:[],discovered:[]})),getSessions:vi.fn(()=>[muxRecord]),startStatsCollection:vi.fn()});
  Object.assign(server,{mux:f.mux,sessions:new Map(),store:{getSession:()=>saved},lastRecordedTokens:new Map(),respawnControllers:new Map(),
   planRebootRestoreOffer:vi.fn(async()=>{}),getClaudeModeConfig:vi.fn(async()=>({claudeMode:'default',allowedTools:[]})),
   setupSessionListeners:vi.fn(async()=>{}),persistSessionState:vi.fn(),ensureHooksForRecoveredWorkspaces:vi.fn(async()=>{})});
  vi.spyOn(Session.prototype,'startInteractive').mockResolvedValue(undefined);
  expect(await server.restoreMuxSessions()).toBe(true);
  const restored=server.sessions.get(f.session.id) as Session;expect(restored).toBeInstanceOf(Session);
  cleanups.push(async()=>{Object.assign(restored,{ptyProcess:null,_muxSession:null});await restored.stop(false);});
  f.ctx.sessions.set(f.session.id,restored);
  const wrote=await restored.writeViaMux('new work after website restoration\r',{fromUser:true});
  expect(Date.now()).toBeLessThan(cutoff); // an actual signal-site deadline has not expired
  signalled=true;f.mux.isPaneDead.mockReturnValue(true);
  console.info('ACTUAL-RESTORE-METHOD-WITNESS',JSON.stringify({queued,wrote,keys,signalled,withinDeadline:Date.now()<cutoff,settlements:stop.settle.mock.calls.length}));
  expect(wrote&&signalled,'restored viewer may not admit work that a still-accepted stop can kill').toBe(false);
 });
});
