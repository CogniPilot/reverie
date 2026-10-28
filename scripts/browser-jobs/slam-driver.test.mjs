/** Inert consequential controls; no browser, worker or scientific program is run. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import https from 'node:https';
import {EventEmitter} from 'node:events';
import {fixedTarget,allowedURL,assertHardware,assertSandboxArgs,parseSandboxPage,transformWorker,loadApprovedCapture,parseGpuRows,fetchPublicAsset,assertLiveProcess,finishContext,createWorkerStateReader} from './slam-driver.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
const target=fixedTarget('https://example.invalid/public/');
const expected={vendorId:4318,deviceId:999,driverVersion:'1.2.3',rendererSHA256:sha('ANGLE (NVIDIA Device, Vulkan 1.3)')};
const graphics={api:'WebGL 2',vendor:'NVIDIA',renderer:'ANGLE (NVIDIA Device, Vulkan 1.3)'},system={gpu:{devices:[{vendorId:4318,deviceId:999,driverVersion:'1.2.3'}]}};
test('only the selected HTTPS origin and path can reach a reviewed public asset',()=>{
 assert(allowedURL('https://example.invalid/public/assets/a.js',target));
 for(const value of ['https://other.invalid/public/a','http://example.invalid/public/a','https://example.invalid/private/a','https://example.invalid/public/../private/a','https://example.invalid/public/a?v=1','https://name@example.invalid/public/a'])assert.equal(allowedURL(value,target),false);
 for(const value of ['http://example.invalid/public/','https://u:p@example.invalid/public/','https://example.invalid/public/?query=1','https://example.invalid/public/#f'])assert.throws(()=>fixedTarget(value));
});
test('named hardware Vulkan renderer and independently reported adapter driver are both required',()=>{
 assertHardware(graphics,system,expected);
 for(const value of ['ANGLE SwiftShader Vulkan','llvmpipe (LLVM)','ANGLE (NVIDIA Device, OpenGL)'])assert.throws(()=>assertHardware({...graphics,renderer:value},system,expected));
 for(const v of [{gpu:{devices:[]}},{gpu:{devices:[{vendorId:0,deviceId:0,driverVersion:''}]}},{}])assert.throws(()=>assertHardware(graphics,v,expected));
});
test('actual sandbox-disabling arguments cannot be repaired by a JSON verified flag',()=>{
 assertSandboxArgs(['chromium','--headless','--enable-gpu']);
 for(const v of ['--no-sandbox','--no-sandbox=false','--disable-gpu-sandbox','--disable-seccomp-filter-sandbox','--disable-namespace-sandbox'])assert.throws(()=>assertSandboxArgs(['chromium',v]));
});
test('native sandbox report requires both seccomp and an engaged first layer',()=>{
 assert.equal(parseSandboxPage('Namespace Sandbox Yes\nSUID Sandbox No\nSeccomp-BPF sandbox Yes').namespace,true);
 assert.equal(parseSandboxPage('Namespace Sandbox No\nSUID Sandbox Yes\nSeccomp-BPF sandbox Yes').suid,true);
 for(const value of ['sandboxVerified=true','Namespace Sandbox No\nSUID Sandbox No\nSeccomp-BPF sandbox Yes','Namespace Sandbox Yes\nSeccomp-BPF sandbox No'])assert.throws(()=>parseSandboxPage(value));
});
test('instrumentation binds all three byte identities and leaves original suffix intact',()=>{
 const original=Buffer.from('export const untouched = 7;\n');function hook(){globalThis.retained=[];}
 const v=transformWorker(original,hook);assert(v.body.subarray(v.body.length-original.length).equals(original));assert.equal(v.originalSHA256,sha(original));assert.equal(v.transformedSHA256,sha(v.body));assert.notEqual(v.hookSHA256,v.originalSHA256);
 assert.throws(()=>transformWorker(Buffer.from([255]),hook));
});
test('approved capture executes only hashed bytes and refuses a changed script or scientific contract',async t=>{
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'fixed-capture-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const file=path.join(root,'approved.mjs');
 const source='export const TARGET={url:"https://example.invalid/public/",resolution:"640x360",cameraHz:5,frames:3000,simSeconds:600,maxOutputBytes:268435456};export function capturePage(){}export function retainNativeMemory(){}export function readCorrectionState(){}';
 await fs.writeFile(file,source,{mode:0o600});const p={targetURL:target.href,capture:{path:file,sha256:sha(source)}};await loadApprovedCapture(p);
 await fs.writeFile(file,source+'\n// Changed');await assert.rejects(loadApprovedCapture(p),/bytes changed/);
 const changed=source.replace('cameraHz:5','cameraHz:4');await fs.writeFile(file,changed);await assert.rejects(loadApprovedCapture({...p,capture:{path:file,sha256:sha(changed)}}));
});

test('negative/zero adapter identities and changed selected physical renderer refuse',()=>{for(const deviceId of [-1,0])assert.throws(()=>assertHardware(graphics,{gpu:{devices:[{vendorId:4318,deviceId,driverVersion:'1.2.3'}]}},expected));assert.throws(()=>assertHardware(graphics,system,{...expected,deviceId:1}));});
test('GPU indices are joined to UUID only in complete stable nonduplicate inventories',()=>{const text='2, GPU-00000000-0000-0000-0000-000000000001, 0x223010DE, 555.42';const [v]=parseGpuRows(text);assert.equal(v.vendorId,4318);assert.equal(v.deviceId,8752);assert.equal(v.index,2);for(const t of [text+'\n'+text,text.replace('GPU-','bad-'),text.replace('0x223010DE','-1')])assert.throws(()=>parseGpuRows(t));});

test('declared and streaming overflow close the own HTTPS request before returning a body',async t=>{for(const declared of [true,false]){let destroyed=0,method;const original=https.request;https.request=(_url,options,callback)=>{method=options.method;const request=new EventEmitter();request.destroy=()=>{destroyed++;};request.end=()=>queueMicrotask(()=>{const response=new EventEmitter();response.headers=declared?{'content-length':'5'}:{};response.statusCode=200;response.destroy=()=>{destroyed++;};callback(response);if(!declared)response.emit('data',Buffer.alloc(5));});return request;};try{await assert.rejects(fetchPublicAsset('https://example.invalid/public/file',target,4),/byte bound/);assert(destroyed>=2);assert.equal(method,'GET');}finally{https.request=original;}}assert.throws(()=>fetchPublicAsset('https://example.invalid/public/file',target,4,'POST'));});

test('GPU UUID case aliases cannot describe two distinct physical devices',()=>{const a='0, GPU-abcdefab-0000-0000-0000-000000000001, 0x223010DE, 555.42';assert.throws(()=>parseGpuRows(a+'\n'+a.replace('0,','1,').replace('abcdefab','ABCDEFAB')));assert.equal(parseGpuRows(a.replace('abcdefab','ABCDEFAB'))[0].uuid,'GPU-abcdefab-0000-0000-0000-000000000001');});
test('partial artifact failure cannot skip context cleanup and dead GPU processes refuse',async()=>{let closed=0;await assert.rejects(finishContext({close:async()=>{closed++;}},async()=>{throw Error('owned artifact failure');}),/artifact failure/);assert.equal(closed,1);const p={startTick:'1',cgroup:'0::/own',state:'S'};assertLiveProcess(p,p);for(const state of ['Z','X'])assert.throws(()=>assertLiveProcess({...p,state},p));});
function stateFixture(){let guarded=0;const evaluated=[];function reader(layout){return {stateSide:layout.stateSide,revision:layout.stateSide==='previous'?17:23};}const worker={url:()=>target.href+'assets/native.js',evaluate:async(fn,arg)=>{evaluated.push({fn,arg});return fn(arg);}};const layout={pages:3,state_runs:[],stateSide:'untrusted-layout-side'},capture={readCorrectionState:reader},policy={assets:{'/public/assets/native.js':{requiredForCapture:true}},nativeWorkerPath:'/public/assets/native.js'},assets=new Map([['/public/assets/native.js',{}]]),page={workers:()=>[worker]};return {layout,capture,policy,assets,page,worker,evaluated,get guarded(){return guarded;},guard:async()=>{guarded++;},failures:[],pageErrors:[]};}
test('explicit previous and next select the requested carries without mutating the pinned layout',async()=>{const f=stateFixture(),read=createWorkerStateReader(f);assert.equal((await read({stateSide:'previous'})).revision,17);assert.equal((await read({stateSide:'next'})).revision,23);assert.deepEqual(f.evaluated.map(x=>x.arg.stateSide),['previous','next']);assert(f.evaluated.every(x=>x.fn===f.capture.readCorrectionState));assert.equal(f.layout.stateSide,'untrusted-layout-side');assert.equal(f.guarded,2);});
test('missing invalid inherited or extra state-side selectors refuse before guard or worker I/O',async()=>{const f=stateFixture(),read=createWorkerStateReader(f);for(const value of [undefined,null,{},'previous',[],{stateSide:'other'},{stateSide:true},{stateSide:'next',command:'ignored'},Object.create({stateSide:'previous'})])await assert.rejects(read(value),/explicit previous\/next/);assert.equal(f.guarded,0);assert.equal(f.evaluated.length,0);});
test('wrong-side worker replies and missing required assets are never native state evidence',async()=>{const f=stateFixture(),read=createWorkerStateReader(f);f.worker.evaluate=async()=>({stateSide:'next'});await assert.rejects(read({stateSide:'previous'}),/state-side binding mismatch/);f.assets.clear();await assert.rejects(read({stateSide:'next'}),/required loaded native/);});
test('only exact paired compiler revision URLs are admitted, never general query relaxation',()=>{
 const revision='a'.repeat(40),names=['vendor/rumoca/rumoca_bind_wasm.js','vendor/rumoca/rumoca_bind_wasm_bg.wasm'];
 const assets=Object.fromEntries(names.map(name=>[target.pathname+name,{sha256:'b'.repeat(64),maxBytes:1048576,requiredForCapture:true,compilerRevision:revision}]));
 for(const name of names){const url=target.href+name;assert(allowedURL(url+'?revision='+revision,target,assets));
  for(const suffix of ['', '?revision='+'b'.repeat(40),'?revision='+revision+'&revision='+revision,'?revision='+revision+'&x=1','?x=1&revision='+revision,'?%72evision='+revision,'?revision=%61'+revision.slice(1),'?revision='+revision.toUpperCase(),'?Revision='+revision,'?revision='+revision+'#fragment'])assert.equal(allowedURL(url+suffix,target,assets),false);
 }
 assert.equal(allowedURL(target.href+'assets/native.js?revision='+revision,target,assets),false);
 assert.equal(allowedURL('https://other.invalid/public/'+names[0]+'?revision='+revision,target,assets),false);
 assert.equal(allowedURL(target.href+names[0]+'?revision='+revision,target),false);
});
test('bounded compiler transport preserves exact query and original method/redirect/size refusals',async()=>{
 const revision='a'.repeat(40),name=target.pathname+'vendor/rumoca/rumoca_bind_wasm.js',assets={[name]:{compilerRevision:revision}},url=target.origin+name+'?revision='+revision;
 let sent,status=200;const original=https.request;
 https.request=(requestURL,options,callback)=>{sent={requestURL,method:options.method};const request=new EventEmitter();request.destroy=()=>{};request.end=()=>queueMicrotask(()=>{const response=new EventEmitter();response.headers={'content-length':'3'};response.statusCode=status;response.destroy=()=>{};callback(response);response.emit('data',Buffer.from('abc'));response.emit('end');});return request;};
 try{assert.equal((await fetchPublicAsset(url,target,3,'GET',assets)).body.toString(),'abc');assert.deepEqual(sent,{requestURL:url,method:'GET'});
  assert.throws(()=>fetchPublicAsset(url,target,3,'POST',assets));await assert.rejects(fetchPublicAsset(url,target,2,'GET',assets),/byte bound/);
  status=302;await assert.rejects(fetchPublicAsset(url,target,3,'GET',assets),/status\/redirect refused/);
 }finally{https.request=original;}
});
