/** SOURCE ONLY until root admits one owned native attempt. No production server or employee access. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {parseArgs} from 'node:util';
import {execFileSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {canaryEntry,processSame,assertStaleIdle,ownerPolicyDependencies,ownerRequestOrigin,verifiedFixtureOwner,safeHttpObservation} from './stale-busy-spec.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const sha=raw=>createHash('sha256').update(raw).digest('hex');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let interrupted=false;
async function until(predicate,ms,message) {
  const deadline=Date.now()+ms;
  while(Date.now()<deadline){assert(!interrupted,'owned supervisor interrupted fixture');const value=await predicate();if(value)return value;await sleep(100);}
  throw Error(message);
}
function proc(pid){
  try{const base='/proc/'+pid;const fields=fs.readFileSync(base+'/stat','utf8').split(')').slice(1).join(')').trim().split(/\s+/);
    const result={pid,startTick:fields[19],state:fields[0],exe:null,cwd:null};
    for(const key of ['exe','cwd'])try{result[key]=fs.realpathSync(base+'/'+key);}catch(error){if(error.code!=='ENOENT')throw error;}
    return result;}
  catch(error){if(error.code==='ENOENT'||error.code==='ESRCH')return null;throw error;}
}
export async function run() {
  // The outer root-owned invocation supplies an empty, unique own fixture root and minimal environment.
  const {values}=parseArgs({options:{'run-owned-fixture':{type:'boolean'},pins:{type:'string'},'pins-sha256':{type:'string'},'lease-root':{type:'string'}}});
  assert(values['run-owned-fixture']&&values.pins&&/^[a-f0-9]{64}$/.test(values['pins-sha256']||''));
  assert(!process.env.VITEST && !process.env.NODE_ENV && !process.env.REVERIE_WORKER_SOCKET);
  const allowed=new Set(['HOME','PATH','SHELL','TERM','LANG','REVERIE_DATA_DIR','REVERIE_INSTANCE',
    'REVERIE_TMUX_SOCKET','REVERIE_API_URL','REVERIE_FLOCK_BIN','TMUX_TMPDIR','TMPDIR','SB_ROOT','SB_PYTHON','SB_BASH','SB_TMUX','SB_LIFETIME']);
  assert(Object.keys(process.env).every(key=>allowed.has(key)),'explicit fixture-only environment required');
  const root=fs.realpathSync(process.env.SB_ROOT||'');
  assert(fs.statSync(root).isDirectory() && fs.statSync(root).uid===process.getuid());
  assert.equal(path.dirname(root),fs.realpathSync(values['lease-root']));
  assert(/^fixture-[a-f0-9]{16}$/.test(path.basename(root)));
  const initial=fs.readdirSync(root);
  assert(['home','instance','tmp','native.log','SCOPE-BOUND.json'].every(name=>initial.includes(name)));
  assert(initial.every(name=>['home','instance','tmp','native.log','SUPERVISED-NODE.json','SCOPE-BOUND.json'].includes(name)),'fixture is not a fresh one-attempt directory');
  const scope=JSON.parse(fs.readFileSync(path.join(root,'SCOPE-BOUND.json')));
  assert.equal(scope.unit,'reverie-sb-'+path.basename(root).slice('fixture-'.length)+'.scope');
  assert.equal(fs.readFileSync('/proc/self/cgroup','utf8').trim(),'0::'+scope.controlGroup);
  assert.equal(process.env.HOME,path.join(root,'home'));
  assert.equal(process.env.REVERIE_DATA_DIR,path.join(root,'instance'));
  assert(/^sb-[a-f0-9]{16}$/.test(process.env.REVERIE_TMUX_SOCKET||''));
  const socketDir=fs.realpathSync(process.env.TMUX_TMPDIR||'');
  const socketStat=fs.lstatSync(socketDir);
  assert(socketDir.length<=60&&socketStat.isDirectory()&&socketStat.uid===process.getuid()&&(socketStat.mode&0o777)===0o700);
  assert.equal(fs.readdirSync(socketDir).length,0,'fresh dedicated socket directory required');
  const pinsRaw=fs.readFileSync(values.pins);assert.equal(sha(pinsRaw),values['pins-sha256']);
  const pins=JSON.parse(pinsRaw);assert(/^[a-f0-9]{40}$/.test(pins.commit));
  assert.equal(process.env.REVERIE_FLOCK_BIN,pins.runtime.tools.flock,'fixed immutable account-lock utility required');
  assert.equal(sha(fs.readFileSync(process.env.REVERIE_FLOCK_BIN)),pins.runtime.sha256.flock);
  const pkg=pins.package;assert(pkg.startsWith('/nix/store/')&&fs.realpathSync(pkg)===pkg);
  const dist=path.join(pkg,'lib/reverie/dist');
  assert(Object.keys(pins.modules).length>0&&Object.keys(pins.modules).length<=64);
  for(const [name,digest]of Object.entries(pins.modules)){
    assert(!path.isAbsolute(name)&&!name.split('/').includes('..')&&/^[a-zA-Z0-9_./-]+\.js$/.test(name));
    assert.equal(sha(fs.readFileSync(path.join(dist,name))),digest,name);
  }
  const output=(name,value)=>fs.writeFileSync(path.join(root,name),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
  const checkHttp=(response,expected,stage)=>{
    const accepted=(Array.isArray(expected)?expected:[expected]).includes(response.statusCode);
    if(!accepted)output('HTTP-ERROR-'+stage+'.json',{stage,expected,...safeHttpObservation(response)});
    assert(accepted,'Unexpected own-fixture HTTP status at '+stage+'; bounded metadata retained');
  };
  output('ATTEMPT.json',{kind:'OWNED_ISOLATED_NON_WORKER_NATIVE_STALE_BUSY',sourceCommit:pins.commit,
    runnerSHA256:sha(fs.readFileSync(fileURLToPath(import.meta.url))),pinsSHA256:sha(pinsRaw),
    startedAt:Date.now(),fixtureOnly:true});
  const load=async name=>import(pathToFileURL(path.join(dist,name)));
  const require=createRequire(path.join(pkg,'lib/reverie/package.json'));
  const Fastify=require('fastify');const cookie=require('@fastify/cookie');
  const {Session}=await load('session.js');const {TmuxManager}=await load('tmux-manager.js');
  const {restartEligibility}=await load('session-restart-policy.js');
  const {registerSessionRuntimeRoutes}=await load('web/routes/session-runtime-routes.js');
  const {OwnerAuthStore}=await load('owner-auth/store.js');const {OwnerAuthService}=await load('owner-auth/service.js');
  const {registerOwnerRoutes}=await load('owner-auth/routes.js');const {registerOwnerPolicy,OWNER_COOKIE}=await load('owner-auth/policy.js');
  const registry=await load('config/cli-registry/registry.js');const {writeRegistryFile}=await load('config/cli-registry/registry-writer.js');
  const {CliEntrySchema}=await load('config/cli-registry/schema.js');const {writeCustomModelHosts}=await load('custom-model-hosts.js');
  const {CompanyStore}=await load('company-store.js');const {CompanyService}=await load('company-service.js');
  const {EmployeeSchema}=await load('company-types.js');
  const bin=path.join(root,'bin');const workspace=path.join(root,'workspace');
  for(const dir of [bin,workspace,path.join(root,'programs')])fs.mkdirSync(dir,{mode:0o700});
  const payload=path.join(here,'stale-busy-program.py');const payloadHash=sha(fs.readFileSync(payload));
  const python=process.env.SB_PYTHON;assert(python?.startsWith('/nix/store/')&&fs.statSync(python).uid===0);
  for(const name of ['SB_PYTHON','SB_BASH','SB_TMUX']){
    const resolved=fs.realpathSync(process.env[name]);const st=fs.statSync(resolved);
    assert(resolved.startsWith('/nix/store/')&&st.uid===0&&st.isFile()&&!(st.mode&0o222)&&(st.mode&0o111));
  }
  const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
  fs.writeFileSync(path.join(bin,'tmux'),'#!'+process.env.SB_BASH+'\nexec '+quote(process.env.SB_TMUX)+' -f /dev/null "$@"\n',{flag:'wx',mode:0o700});
  fs.writeFileSync(path.join(bin,'sb-shell'),'#!'+process.env.SB_BASH+'\nexec '+quote(process.env.SB_BASH)+' --noprofile --norc "$@"\n',{flag:'wx',mode:0o700});
  process.env.PATH=bin+':'+process.env.PATH;
  process.env.SHELL=path.join(bin,'sb-shell');
  fs.writeFileSync(path.join(bin,'sb-canary'),'#!'+process.env.SB_BASH+'\nexec '+quote(python)+' -I -B '+quote(payload)+' '+quote(root)+'\n',{flag:'wx',mode:0o700});
  const entry=CliEntrySchema.parse(canaryEntry(registry.getCli('pi'),bin));
  await writeRegistryFile({version:1,clis:{'sb-canary':entry}});registry.reloadCliRegistry();
  assert.equal(registry.getCli('sb-canary').id,'sb-canary');
  await writeCustomModelHosts(process.env.REVERIE_DATA_DIR,[{id:'owned-local',label:'No-server fixture',baseUrl:'http://127.0.0.1:9',models:['fixture-model'],defaultModelId:'fixture-model'}]);
  const sessions=new Map();const mux=new TmuxManager();assert(mux.isAvailable());
  const sid=randomUUID();const eid=randomUUID();let session;
  output('FIXTURE-IDENTITY.json',{sid,eid,muxName:'reverie-'+sid.slice(0,8),socket:process.env.REVERIE_TMUX_SOCKET});
  const app=Fastify();await app.register(cookie);
  const owner=new OwnerAuthService({store:new OwnerAuthStore(path.join(root,'owner-auth.json')),auditFile:path.join(root,'owner-audit.jsonl'),setupEnabled:true});
  const ctx={sessions,mux,persistSessionStateNow:s=>output('state-'+randomUUID()+'.json',s.toState()),
    addSession:async s=>sessions.set(s.id,s),setupSessionListeners:async()=>{},
    discardPartiallyBuiltSession:async id=>{const s=sessions.get(id);if(s)await s.stop();sessions.delete(id);}};
  registerOwnerPolicy(app,ownerPolicyDependencies(owner,ctx,sessions));
  registerOwnerRoutes(app,owner,false);
  const companyStore=new CompanyStore(path.join(process.env.REVERIE_DATA_DIR,'company.json'));await companyStore.init();
  await companyStore.update(state=>state.employees.push(EmployeeSchema.parse({id:eid,sessionId:sid,sessionGeneration:1,name:'Owned canary',position:'Fixture',icon:'S',expertise:['fixture'],createdAt:Date.now(),desiredRunning:true})));
  const company=new CompanyService(companyStore,{getSession:id=>sessions.get(id),stopSession:async id=>sessions.get(id)?.stop(),
    chatrooms:{rooms:()=>[]},research:{stop:async()=>{throw Error('unexpected research effect')}}});
  const verified=verifiedFixtureOwner(owner,OWNER_COOKIE);
  registerSessionRuntimeRoutes(app,ctx,verified,undefined,company);
  const results=[];let terminal='FAILED';
  const interrupt=()=>{interrupted=true;};process.once('SIGTERM',interrupt);process.once('SIGINT',interrupt);
  const control=phase=>fs.writeFileSync(path.join(root,'control.json'),JSON.stringify({phase}));
  const records=()=>fs.readdirSync(path.join(root,'programs')).map(n=>JSON.parse(fs.readFileSync(path.join(root,'programs',n))));
  const sameProgram=record=>{const current=proc(record.pid);return current&&processSame(record,current);};
  const body={mode:'sb-canary',source:{kind:'local',endpointId:'owned-local'},model:'fixture-model'};
  try{
    await app.ready();
    const password='Fixture-'+randomBytes(24).toString('hex');
    const setup=await app.inject({method:'POST',url:'/api/owner/setup',headers:ownerRequestOrigin(),payload:{username:'fixture-owner',password,confirmation:password}});
    checkHttp(setup,200,'owner-setup');const ownCookie=setup.cookies.find(c=>c.name===OWNER_COOKIE);assert(ownCookie);
    const headers={...ownerRequestOrigin(),cookie:OWNER_COOKIE+'='+ownCookie.value};
    session=new Session({id:sid,name:'Owned canary',mode:'sb-canary',workingDir:workspace,mux,useMux:true,
      envOverrides:{SB_ROOT:root,SB_MODEL:'fixture-model',SB_BASE_URL:'http://127.0.0.1:9'}});
    session.setCustomModel({endpointId:'owned-local',modelId:'fixture-model',label:'No-server fixture',envKeys:['SB_MODEL','SB_BASE_URL']},{});
    sessions.set(sid,session);control('active');await session.startInteractive();
    assert(session.usesMux && session.muxName && mux.muxSessionExists(session.muxName),'direct PTY fallback is not admitted');
    const serverPid=Number(execFileSync(process.env.SB_TMUX,['-f','/dev/null','-L',process.env.REVERIE_TMUX_SOCKET,'display-message','-p','#{pid}'],{encoding:'utf8',timeout:5000}).trim());
    assert(Number.isInteger(serverPid)&&serverPid>1);output('MUX-OWNER.json',proc(serverPid));
    const first=await until(()=>records()[0],10000,'owned program never started');
    assert.equal(first.scriptSHA256,payloadHash);assert.equal(first.cwd,workspace);assert(sameProgram(first));
    await until(()=>session.isWorking&&session.lastActivityAt>Date.now()-2000,15000,'actual terminal work not observed');
    assert.deepEqual(restartEligibility(session),{blocked:true,recoverable:false});
    const post=payload=>app.inject({method:'POST',url:'/api/company/employees/'+eid+'/restart',headers,payload});
    const anonymous=await app.inject({method:'POST',url:'/api/company/employees/'+eid+'/restart',payload:{forceRestart:true,confirmSessionId:sid}});
    checkHttp(anonymous,[401,403],'anonymous-restart');assert(sameProgram(first));
    for(const payload of [{},{forceRestart:true,confirmSessionId:sid}]){const response=await post(payload);checkHttp(response,409,'active-restart');assert(sameProgram(first));}
    results.push({case:'actual-active-normal-and-force',status:'REFUSED_409',binding:{pid:first.pid,startTick:first.startTick}});
    control('idle');
    await until(()=>{const file=path.join(root,'phase-'+first.pid+'.json');return fs.existsSync(file)&&JSON.parse(fs.readFileSync(file)).phase==='idle';},3000,'program did not enter actual idle');
    await until(()=>Date.now()-session.lastActivityAt>=125000,135000,'actual activity did not become stale');
    assertStaleIdle(session,restartEligibility(session),'idle');assert(sameProgram(first));
    for(const payload of [{},{forceRestart:true},{forceRestart:true,confirmSessionId:randomUUID()}]){
      const response=await post(payload);checkHttp(response,409,'stale-unconfirmed-restart');assert(sameProgram(first));
    }
    const agent=await app.inject({method:'POST',url:'/api/sessions/'+sid+'/runtime',headers:{...headers,'x-reverie-parent-session':sid},payload:{...body,forceRestart:true,confirmSessionId:sid}});
    checkHttp(agent,[401,403],'agent-restart');assert(sameProgram(first));
    const foreign=await app.inject({method:'POST',url:'/api/sessions/'+randomUUID()+'/runtime',headers,payload:{...body,forceRestart:true,confirmSessionId:sid}});
    checkHttp(foreign,[403,404],'unknown-identity-restart');assert(sameProgram(first));
    const otherId=randomUUID();const other=new Session({id:otherId,name:'Unstarted fixture identity',mode:'sb-canary',workingDir:workspace,mux,useMux:true});
    sessions.set(otherId,other);
    const wrongTarget=await app.inject({method:'POST',url:'/api/sessions/'+otherId+'/runtime',headers,payload:{...body,forceRestart:true,confirmSessionId:sid}});
    checkHttp(wrongTarget,409,'wrong-target-restart');assert.equal(other.pid,null);assert(sameProgram(first));
    process.env.REVERIE_WORKER_SOCKET=path.join(root,'never-connected-worker.sock');
    try{const response=await post({forceRestart:true,confirmSessionId:sid});checkHttp(response,409,'attached-worker-restart');assert(response.json().error.includes('whole-session replacement'));assert(sameProgram(first));}
    finally{delete process.env.REVERIE_WORKER_SOCKET;}
    results.push({case:'stale-idle-wrong-confirm-agent-foreign-worker',status:'REFUSED_WITH_OLD_PROGRAM_PRESERVED'});
    const response=await post({forceRestart:true,confirmSessionId:sid});checkHttp(response,200,'confirmed-native-restart');
    const second=await until(()=>records().find(r=>!processSame(first,r)),10000,'no new inner program after successful route');
    await until(()=>!sameProgram(first),10000,'old inner program survived restart');
    assert(sameProgram(second));assert.equal(second.scriptSHA256,payloadHash);assert.equal(second.cwd,workspace);
    assert.equal(second.model,'fixture-model');assert.equal(second.endpoint,'http://127.0.0.1:9');
    const actual=proc(second.pid);assert.equal(actual.exe,fs.realpathSync(python));assert.equal(actual.cwd,workspace);
    assert.equal(records().length,2,'exactly one initial and one replacement program required');
    const employee=companyStore.snapshot().employees.find(e=>e.id===eid);
    assert.equal(employee.sessionId,sid);assert.equal(employee.sessionGeneration,1);assert.equal(employee.desiredRunning,true);
    const workspaceStat=fs.statSync(workspace);
    results.push({case:'owner-confirmed-stale-idle-nonworker',status:'RESTARTED_200',old:{pid:first.pid,startTick:first.startTick},new:{pid:second.pid,startTick:second.startTick},scriptSHA256:payloadHash,cwdPreserved:true,modelPreserved:true,workspace:{device:workspaceStat.dev,inode:workspaceStat.ino}});
    terminal='COLLECTED';
  }catch(error){output('FAILURE.json',{class:error.constructor.name,message:String(error.message).slice(0,500),results});throw error;}
  finally{
    process.removeListener('SIGTERM',interrupt);process.removeListener('SIGINT',interrupt);
    control('stop');
    for(const owned of sessions.values())await owned.stop().catch(()=>{terminal='SETTLEMENT_UNKNOWN';});
    mux.destroy();await app.close();
    const survivors=records().filter(sameProgram).map(r=>({pid:r.pid,startTick:r.startTick}));
    if(survivors.length)terminal='SETTLEMENT_UNKNOWN';
    output('TERMINAL.json',{terminal,results,survivors,fixtureOnly:true,workerReplacement:'NOT_IMPLEMENTED_NOT_PASSED',productionEffects:0});
  }
  assert.equal(terminal,'COLLECTED');
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv[2]!=='--run-owned-fixture')throw Error('Explicit isolated native attempt required; import/source inspection is inert');
  await run();
}
