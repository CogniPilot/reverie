import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {canaryEntry,assertStaleIdle,processSame,safeHttpObservation} from './stale-busy-spec.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const pkg=process.env.SB_TEST_PACKAGE;
assert(pkg?.startsWith('/nix/store/'),'explicit immutable package required for compiled source controls');
const load=name=>import(pathToFileURL(path.join(pkg,'lib/reverie/dist',name)));
const {STOCK_CLIS}=await load('config/cli-registry/stock.js');
const {CliEntrySchema}=await load('config/cli-registry/schema.js');
const {restartEligibility}=await load('session-restart-policy.js');

test('actual installed registry schema accepts benign custom entry without provider/hook/account discovery',()=>{
  const base=STOCK_CLIS.find(c=>c.id==='pi');
  const entry=CliEntrySchema.parse(canaryEntry(base,'/owned/fixture/bin'));
  assert.equal(entry.capabilities.hooks,'none');assert.equal(entry.capabilities.transcript,'none');
  assert.equal(entry.capabilities.agentSkillInjection,false);
  assert.equal(entry.capabilities.customModelInjection.kind,'env');
  assert.deepEqual(entry.launch.variants,[{id:'owned',args:[{lit:'sb-canary'}]}]);
  assert.deepEqual(entry.discovery.binaries,['sb-canary']);assert(!entry.capabilities.mcpConfig);
  assert.equal(base.id,'pi');
});
test('actual installed policy requires active and exact stale oracles',()=>{
  const now=300000,stale={isBusy:()=>true,isWorking:true,runningTaskCount:0,lastSubmitAt:0,lastActivityAt:1,paneDialog:null};
  assertStaleIdle(stale,restartEligibility(stale,now),'idle',now);
  for(const fields of [{lastActivityAt:now},{lastSubmitAt:now},{runningTaskCount:1},{paneDialog:'permission'}, {lastActivityAt:NaN}]){
    const state={...stale,...fields};assert.equal(restartEligibility(state,now).recoverable,false);
    assert.throws(()=>assertStaleIdle(state,restartEligibility(state,now),'idle',now));
  }
});
test('idle physical program and PID-start identity are separate required evidence',()=>{
  const stale={isBusy:()=>true,isWorking:true,runningTaskCount:0,lastSubmitAt:0,lastActivityAt:1,paneDialog:null};
  assert.throws(()=>assertStaleIdle(stale,{blocked:true,recoverable:true},'active',300000));
  assert.equal(processSame({pid:1,startTick:'2'},{pid:1,startTick:'3'}),false);
  assert.equal(processSame({pid:1,startTick:'2'},{pid:2,startTick:'2'}),false);
});
test('native entrypoint import is inert',async()=>{await import('./stale-busy-native.mjs');});
test('actual compiled native fixture exports load with empty owned home and no provider environment',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sb-import-'));
  try{
    fs.mkdirSync(path.join(root,'home'));fs.mkdirSync(path.join(root,'instance'));
    const required={'session.js':['Session'],'tmux-manager.js':['TmuxManager'],
      'web/routes/session-runtime-routes.js':['registerSessionRuntimeRoutes'],
      'owner-auth/service.js':['OwnerAuthService'],'owner-auth/store.js':['OwnerAuthStore'],
      'owner-auth/routes.js':['registerOwnerRoutes'],'owner-auth/policy.js':['registerOwnerPolicy'],
      'config/cli-registry/registry.js':['getCli','reloadCliRegistry'],
      'config/cli-registry/registry-writer.js':['writeRegistryFile'],
      'company-store.js':['CompanyStore'],'company-service.js':['CompanyService']};
    const program=`import assert from 'node:assert/strict';import {pathToFileURL}from'node:url';
      const required=${JSON.stringify(required)};for(const [name,exports]of Object.entries(required)){
        const loaded=await import(pathToFileURL(${JSON.stringify(path.join(pkg,'lib/reverie/dist/'))}+name));
        for(const key of exports)assert.equal(typeof loaded[key],'function',name+':'+key);
      }console.log('EXPORTS_ONLY_PASS_NO_CONSTRUCTORS');`;
    const result=spawnSync(process.execPath,['--input-type=module','-e',program],{
      env:{HOME:path.join(root,'home'),REVERIE_DATA_DIR:path.join(root,'instance')},encoding:'utf8',timeout:15000});
    assert.equal(result.status,0,result.stderr);assert(result.stdout.includes('EXPORTS_ONLY_PASS_NO_CONSTRUCTORS'));
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('HTTP failure metadata cannot echo arbitrary response text, credentials or headers',()=>{
  const secret='OWNED-SYNTHETIC-SECRET-NOT-FOR-OUTPUT';
  const observed=safeHttpObservation({statusCode:500,headers:{'set-cookie':secret},body:JSON.stringify({statusCode:500,error:'Internal Server Error',message:secret,data:{token:secret}})});
  assert.equal(observed.status,500);assert.equal(observed.messageClass,'UNCLASSIFIED_OR_ABSENT');
  assert.equal(observed.bodySHA256.length,64);assert.equal(observed.messageSHA256.length,64);
  assert(!JSON.stringify(observed).includes(secret));assert(!Object.hasOwn(observed,'headers'));
  assert.equal(safeHttpObservation({statusCode:500,body:JSON.stringify({message:'deps.isCapabilityRequest is not a function'})}).messageClass,'OWNER_POLICY_CAPABILITY_PREDICATE_MISSING');
});
test('actual installed owner policy/setup/runtime composition enforces origin, cookie and agent boundaries before native startup',()=>{
  const flock=process.env.SB_TEST_FLOCK;
  assert(flock?.startsWith('/nix/store/')&&fs.realpathSync(flock)===flock,'explicit immutable account-lock utility required');
  const st=fs.statSync(flock);assert(st.uid===0&&st.isFile()&&!(st.mode&0o222)&&(st.mode&0o111));
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sb-auth-'));
  try{
    fs.mkdirSync(path.join(root,'home'),{mode:0o700});fs.mkdirSync(path.join(root,'instance'),{mode:0o700});
    const program=`import assert from 'node:assert/strict';import path from'node:path';import {randomBytes}from'node:crypto';import{createRequire}from'node:module';import{pathToFileURL}from'node:url';
      const pkg=${JSON.stringify(pkg)},root=${JSON.stringify(root)};
      const require=createRequire(path.join(pkg,'lib/reverie/package.json'));const Fastify=require('fastify'),cookie=require('@fastify/cookie');
      const load=name=>import(pathToFileURL(path.join(pkg,'lib/reverie/dist',name)));
      const {ownerPolicyDependencies,ownerRequestOrigin,verifiedFixtureOwner,safeHttpObservation}=await import(${JSON.stringify(pathToFileURL(path.join(here,'stale-busy-spec.mjs')).href)});
      const {OwnerAuthStore}=await load('owner-auth/store.js');const {OwnerAuthService}=await load('owner-auth/service.js');
      const {registerOwnerPolicy,OWNER_COOKIE}=await load('owner-auth/policy.js');const{registerOwnerRoutes}=await load('owner-auth/routes.js');
      const {registerSessionRuntimeRoutes}=await load('web/routes/session-runtime-routes.js');
      const app=Fastify();await app.register(cookie);const sessions=new Map(),ctx={sessions};
      const owner=new OwnerAuthService({store:new OwnerAuthStore(path.join(root,'instance/owner-auth.json')),auditFile:path.join(root,'instance/owner-audit.jsonl'),setupEnabled:true});
      const deps=ownerPolicyDependencies(owner,ctx,sessions);assert.equal(deps.isCapabilityRequest({}),false);
      assert.deepEqual(Object.keys(deps.relations).sort(),['admin','coordinated','keeper','known','related','upward']);
      registerOwnerPolicy(app,deps);registerOwnerRoutes(app,owner,false);registerSessionRuntimeRoutes(app,ctx,verifiedFixtureOwner(owner,OWNER_COOKIE));
      const requireStatus=(response,status)=>assert.equal(response.statusCode,status,JSON.stringify(safeHttpObservation(response)));
      const password='Fixture-'+randomBytes(24).toString('hex'),payload={username:'fixture-owner',password,confirmation:password};
      try{
        const broken=Fastify();await broken.register(cookie);
        try{
          const {isCapabilityRequest:omitted,...oldDependencies}=ownerPolicyDependencies(owner,ctx,sessions);
          registerOwnerPolicy(broken,oldDependencies);registerOwnerRoutes(broken,owner,false);await broken.ready();
          const failed=await broken.inject({method:'POST',url:'/api/owner/setup',headers:ownerRequestOrigin(),payload});
          requireStatus(failed,500);assert.equal(safeHttpObservation(failed).messageClass,'OWNER_POLICY_CAPABILITY_PREDICATE_MISSING');assert(owner.setupAvailable());
        }finally{await broken.close();}
        await app.ready();assert.equal(owner.policy(),'enforce');
        requireStatus(await app.inject({method:'POST',url:'/api/owner/setup',payload}),403);assert(owner.setupAvailable());
        requireStatus(await app.inject({method:'POST',url:'/api/owner/setup',headers:{host:'localhost',origin:'http://foreign.invalid'},payload}),403);assert(owner.setupAvailable());
        const setup=await app.inject({method:'POST',url:'/api/owner/setup',headers:ownerRequestOrigin(),payload});requireStatus(setup,200);
        const owned=setup.cookies.find(c=>c.name===OWNER_COOKIE);assert(owned);assert.equal(owner.identity(owned.value).role,'owner');
        const headers={...ownerRequestOrigin(),cookie:OWNER_COOKIE+'='+owned.value};
        const url='/api/sessions/11111111-2222-4333-8444-555555555555/runtime';
        requireStatus(await app.inject({method:'POST',url,headers,payload:{}}),404);
        requireStatus(await app.inject({method:'POST',url,headers:ownerRequestOrigin(),payload:{}}),401);
        requireStatus(await app.inject({method:'POST',url,headers:{...headers,origin:'http://foreign.invalid'},payload:{}}),403);
        requireStatus(await app.inject({method:'POST',url,headers:{...headers,'x-reverie-parent-session':'11111111-2222-4333-8444-555555555555'},payload:{}}),403);
        assert.equal(sessions.size,0);console.log('ACTUAL_OWNER_SETUP_POLICY_RUNTIME_GATES_PASS_NO_NATIVE_START');
      }finally{await app.close();}`;
    const result=spawnSync(process.execPath,['--input-type=module','-e',program],{env:{HOME:path.join(root,'home'),REVERIE_DATA_DIR:path.join(root,'instance'),REVERIE_FLOCK_BIN:flock},encoding:'utf8',timeout:15000});
    assert.equal(result.status,0,result.stderr);assert(result.stdout.includes('ACTUAL_OWNER_SETUP_POLICY_RUNTIME_GATES_PASS_NO_NATIVE_START'));
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
