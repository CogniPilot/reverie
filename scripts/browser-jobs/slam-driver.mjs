/** Fixed public-target capture adapter. No browser/network/science on import.
 * A host-private reviewed policy selects the sole URL/script/manifest; requests
 * never choose JavaScript, CDP, host paths, launch flags or scientific parameters.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import https from 'node:https';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
const sha=raw=>createHash('sha256').update(raw).digest('hex');
const forbidden=/swiftshader|llvmpipe|lavapipe|softpipe|software|basic render/i;
export function fixedTarget(value){
  const u=new URL(value);assert(u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&!u.search&&!u.hash&&u.pathname.endsWith('/'),'fixed HTTPS public target required');return u;
}
export function allowedURL(raw,target,assets){
  const u=new URL(raw);if(!(u.protocol==='https:'&&u.origin===target.origin&&u.pathname.startsWith(target.pathname)&&!u.username&&!u.password&&!u.hash))return false;
  const revision=assets?.[u.pathname]?.compilerRevision;
  if(revision!==undefined)return typeof revision==='string'&&/^[a-f0-9]{40}$/.test(revision)&&['vendor/rumoca/rumoca_bind_wasm.js','vendor/rumoca/rumoca_bind_wasm_bg.wasm'].includes(u.pathname.slice(target.pathname.length))&&u.search==='?revision='+revision;
  return !u.search;
}
export function assertHardware(graphics,system,expected){
  assert(graphics?.api==='WebGL 2'&&typeof graphics.renderer==='string'&&typeof graphics.vendor==='string');
  const text=graphics.renderer+' '+graphics.vendor;
  assert(!forbidden.test(text)&&/ANGLE.*Vulkan/i.test(graphics.renderer)&&/nvidia|geforce|radeon|intel|adreno|mali|powervr|amd|qualcomm/i.test(text),'hardware ANGLE Vulkan renderer required');
  assert(Array.isArray(system?.gpu?.devices)&&system.gpu.devices.length>0&&system.gpu.devices.length<=16,'actual CDP GPU identity required');
  assert(system.gpu.devices.every(d=>Number.isInteger(d.vendorId)&&d.vendorId>0&&d.vendorId<=65535&&Number.isInteger(d.deviceId)&&d.deviceId>0&&d.deviceId<=65535&&typeof d.driverVersion==='string'&&d.driverVersion.length>0&&d.driverVersion.length<=128),'actual GPU adapter/driver required');
  const selected=system.gpu.devices[0];assert(expected&&selected.vendorId===expected.vendorId&&selected.deviceId===expected.deviceId&&selected.driverVersion===expected.driverVersion&&sha(graphics.renderer)===expected.rendererSHA256,'selected primary GPU/driver/renderer binding differs');return {graphics,selected,devices:system.gpu.devices};
}
export function assertSandboxArgs(argv){assert(Array.isArray(argv)&&argv.length<256&&!argv.some(a=>/^--(?:no-sandbox|disable-gpu-sandbox|disable-seccomp-filter-sandbox|disable-namespace-sandbox)(?:=|$)/.test(a)),'sandbox-disabling launch refused');}
export function parseSandboxPage(text){
  assert(typeof text==='string'&&text.length<=32768,'bounded native sandbox report required');
  const yes=name=>new RegExp(name+'\\s+(?:Yes|Enabled)\\b','i').test(text);
  // Actual native chrome://sandbox report, not the untrusted public application.
  assert(yes('Seccomp-BPF sandbox')&&(yes('Namespace Sandbox')||yes('SUID Sandbox')),'actual Chromium sandbox unavailable');
  return {seccomp:true,namespace:yes('Namespace Sandbox'),suid:yes('SUID Sandbox'),reportSHA256:sha(text)};
}
function status(pid){
  const base='/proc/'+pid,raw=fs.readFileSync(base+'/stat','utf8'),row=raw.slice(raw.lastIndexOf(')')+1).trim().split(/\s+/),s=fs.readFileSync(base+'/status','utf8');assert(s.length<=65536);
  return {pid,startTick:row[19],state:row[0],parentPID:Number(row[1]),seccomp:Number(s.match(/^Seccomp:\s*(\d+)$/m)?.[1]),noNewPrivileges:Number(s.match(/^NoNewPrivs:\s*(\d+)$/m)?.[1]),cgroup:fs.readFileSync(base+'/cgroup','utf8').trim()};
}
function memberOfBrowser(pid,browser){
  const seen=new Set();for(let n=0;n<12;n++){if(pid===browser.pid)return true;assert(!seen.has(pid)&&pid>1,'process ancestry unavailable');seen.add(pid);pid=status(pid).parentPID;}return false;
}
export async function proveRuntime(browser,browserPID,scope,policy){
  const root=status(browserPID);assert(root.cgroup==='0::'+scope.controlGroup&&root.state!=='Z');
  const argv=fs.readFileSync('/proc/'+browserPID+'/cmdline');assert(argv.length<=65536);assertSandboxArgs(argv.toString().split('\0').filter(Boolean));
  const native=await browser.newPage();let sandbox;
  try{await native.goto('chrome://sandbox',{waitUntil:'domcontentloaded',timeout:10000});sandbox=parseSandboxPage(await native.locator('body').innerText());}finally{await native.close();}
  const page=await browser.newPage();let graphics;
  try{graphics=await page.evaluate(()=>{const g=document.createElement('canvas').getContext('webgl2');if(!g)return {api:'unavailable'};const e=g.getExtension('WEBGL_debug_renderer_info'),v={api:'WebGL 2',renderer:String(g.getParameter(e?e.UNMASKED_RENDERER_WEBGL:g.RENDERER)),vendor:String(g.getParameter(e?e.UNMASKED_VENDOR_WEBGL:g.VENDOR))};g.getExtension('WEBGL_lose_context')?.loseContext();return v;});
    const cdp=await browser.newBrowserCDPSession();try{
      const system=await cdp.send('SystemInfo.getInfo'),processes=await cdp.send('SystemInfo.getProcessInfo'),hardware=assertHardware(graphics,system,policy.hardware);
      const renderer=processes.processInfo.filter(p=>p.type==='renderer');assert(renderer.length>0&&renderer.length<=16,'actual renderer process missing');
      const sandboxed=renderer.map(p=>{assert(Number.isSafeInteger(p.id)&&p.id>1);const r=status(p.id);assert(r.cgroup===root.cgroup&&r.seccomp===2&&r.noNewPrivileges===1&&memberOfBrowser(p.id,root),'actual own renderer kernel sandbox missing');return {pid:r.pid,startTick:r.startTick,seccomp:r.seccomp,noNewPrivileges:r.noNewPrivileges};});
      const gpu=processes.processInfo.filter(p=>p.type==='GPU');assert(gpu.length===1&&memberOfBrowser(gpu[0].id,root),'exact own GPU process unavailable');const gpuProcess=status(gpu[0].id);assert(gpuProcess.cgroup===root.cgroup);const physical=await physicalGPU(gpuProcess,policy);assert(physical.vendorId===hardware.selected.vendorId&&physical.deviceId===hardware.selected.deviceId&&physical.driverVersion===hardware.selected.driverVersion,'CDP and physical GPU differ');
      return {sandboxVerified:true,rendererVerified:true,hardware,physical,sandbox,sandboxedRenderers:sandboxed,browser:{pid:root.pid,startTick:root.startTick}};
    }finally{await cdp.detach();}
  }finally{await page.close();}
}
/** Fixed HTTPS GET/HEAD, no redirects/auth/proxy and bounded bytes while reading. */
export function fetchPublicAsset(url,target,maximum,method='GET',assets){
  assert(allowedURL(url,target,assets)&&Number.isSafeInteger(maximum)&&maximum>0&&maximum<=134217728&&['GET','HEAD'].includes(method));
  return new Promise((resolve,reject)=>{const chunks=[];let count=0,done=false;const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);if(error)reject(error);else resolve(value);};
    const request=https.request(url,{method,agent:false,maxHeaderSize:16384,headers:{'accept-encoding':'identity'}},response=>{
      const fail=error=>{response.destroy();request.destroy();finish(error);};
      if(response.statusCode!==200)return fail(Error('fixed public asset status/redirect refused'));
      const length=response.headers['content-length'];if(length!==undefined&&(!/^\d+$/.test(length)||BigInt(length)>BigInt(maximum)))return fail(Error('public asset declared byte bound'));
      if(response.headers['content-encoding']&&response.headers['content-encoding']!=='identity')return fail(Error('unsupported encoded HTTP representation'));
      response.on('data',chunk=>{count+=chunk.length;if(count>maximum)return fail(Error('public asset streaming byte bound'));chunks.push(chunk);});response.on('error',error=>finish(error));
      response.on('end',()=>finish(null,{status:response.statusCode,headers:Object.fromEntries(Object.entries(response.headers).filter(([,v])=>typeof v==='string')),body:Buffer.concat(chunks)}));
    });const timer=setTimeout(()=>{request.destroy();finish(Error('public asset absolute timeout'));},30000);request.on('error',error=>finish(error));request.end();
  });
}
export function parseGpuRows(text){
  assert(typeof text==='string'&&text.length<=65536);const rows=text.trim().split('\n').filter(Boolean).map(line=>{const a=line.split(',').map(x=>x.trim());assert(a.length===4&&/^\d+$/.test(a[0])&&/^GPU-[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12}$/.test(a[1])&&/^0x[A-Fa-f0-9]{8}$/.test(a[2])&&/^\d+(?:\.\d+)+$/.test(a[3]));assert(Number.isSafeInteger(Number(a[0]))&&Number(a[0])>=0&&Number(a[0])<64);const pci=parseInt(a[2].slice(2),16);return {index:Number(a[0]),uuid:'GPU-'+a[1].slice(4).toLowerCase(),vendorId:pci&65535,deviceId:pci>>>16,driverVersion:a[3]};});assert(rows.length>0&&rows.length<=64&&new Set(rows.map(x=>x.uuid)).size===rows.length&&new Set(rows.map(x=>x.index)).size===rows.length);return rows;
}
async function physicalGPU(process,policy){
  const tool=policy.tools.nvidiaSMI,file=fs.realpathSync(tool.path),info=fs.statSync(file);assert(file===tool.path&&file.startsWith('/nix/store/')&&info.uid===0&&(info.mode&0o222)===0&&info.size<=16777216&&sha(fs.readFileSync(file))===tool.sha256);
  const invoke=async args=>{const {stdout}=await exec(file,args,{timeout:5000,killSignal:'SIGKILL',maxBuffer:65536,env:{PATH:path.dirname(file),LANG:'C',LC_ALL:'C'}});return stdout;};
  const query=['--query-gpu=index,uuid,pci.device_id,driver_version','--format=csv,noheader,nounits'];const before=parseGpuRows(await invoke(query));
  const text=await invoke(['pmon','-c','1','-s','um']),owners=[];assert(text.length<=65536);
  for(const line of text.split('\n')){if(!line.trim()||line.trim().startsWith('#'))continue;const fields=line.trim().split(/\s+/);if(fields[1]==='-')continue;assert(/^\d+$/.test(fields[0])&&/^\d+$/.test(fields[1]));owners.push({index:Number(fields[0]),pid:Number(fields[1])});}
  const own=owners.filter(x=>x.pid===process.pid);assert(own.length===1,'physical GPU process attribution unavailable');const after=parseGpuRows(await invoke(query));assert(JSON.stringify(before)===JSON.stringify(after),'GPU index/UUID inventory changed');const selected=before.filter(x=>x.index===own[0].index);assert(selected.length===1&&selected[0].uuid===('GPU-'+policy.hardware.uuid.slice(4).toLowerCase()),'selected physical GPU UUID differs');const current=status(process.pid);assertLiveProcess(current,process);return {...selected[0],process:{pid:process.pid,startTick:process.startTick},otherContextsObserved:owners.some(x=>x.index===own[0].index&&x.pid!==process.pid)};
}
export function assertLiveProcess(current,expected){assert(current&&current.startTick===expected.startTick&&current.cgroup===expected.cgroup&&!['Z','X'].includes(current.state),'own GPU process changed/dead');}
export async function finishContext(context,savePartial){let first;try{await savePartial();}catch(error){first=error;}try{await context.close();}catch(error){if(first)throw new AggregateError([first,error],'partial artifact and context cleanup failed');throw error;}if(first)throw first;}
export function transformWorker(original,hook){
  assert(Buffer.isBuffer(original)&&original.length<=8388608&&typeof hook==='function');new TextDecoder('utf-8',{fatal:true}).decode(original);
  const prefix=Buffer.from(';('+hook.toString()+')();\n');return {body:Buffer.concat([prefix,original]),originalSHA256:sha(original),hookSHA256:sha(prefix),transformedSHA256:sha(Buffer.concat([prefix,original]))};
}
export function readPinned(file,maximum,expected){
  assert(path.isAbsolute(file)&&fs.realpathSync(file)===file&&Number.isSafeInteger(maximum)&&maximum>0&&maximum<=2097152);const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{
    const before=fs.fstatSync(fd),stamp=s=>[s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs].join(':');assert(before.isFile()&&before.nlink===1&&before.size<=maximum);
    const chunks=[];let total=0;for(;;){const b=Buffer.alloc(Math.min(65536,maximum+1-total)),n=fs.readSync(fd,b,0,b.length,null);if(!n)break;total+=n;assert(total<=maximum,'approved file byte bound');chunks.push(b.subarray(0,n));}
    assert(total===before.size&&stamp(before)===stamp(fs.fstatSync(fd))&&stamp(before)===stamp(fs.lstatSync(file)),'approved file changed');const raw=Buffer.concat(chunks);assert(sha(raw)===expected,'approved source/manifest bytes changed');return raw;
  }finally{fs.closeSync(fd);}
}
export async function loadApprovedCapture(policy){
  const file=path.resolve(policy.capture.path);assert(file===policy.capture.path&&fs.realpathSync(file)===file);const s=fs.statSync(file);assert(s.isFile()&&s.size<=65536);
  const source=readPinned(file,65536,policy.capture.sha256);
  // Import exactly the bytes hashed above; a later path replacement cannot select code.
  const capture=await import('data:text/javascript;base64,'+source.toString('base64'));
  const t=capture.TARGET;assert(t.resolution==='640x360'&&t.cameraHz===5&&t.frames===3000&&t.simSeconds===600&&t.maxOutputBytes===268435456);
  assert.equal(t.url,policy.targetURL);assert(['capturePage','retainNativeMemory','readCorrectionState'].every(k=>typeof capture[k]==='function'));return capture;
}
export function createWorkerStateReader({guard,failures,pageErrors,policy,assets,page,capture,layout}){
  return async request=>{
    assert(request&&Object.getPrototypeOf(request)===Object.prototype&&Object.keys(request).length===1&&Object.hasOwn(request,'stateSide')&&['previous','next'].includes(request.stateSide),'explicit previous/next native state side required');
    const stateSide=request.stateSide;await guard();assert(failures.length===0&&pageErrors.length===0,'loaded application failed');
    for(const [name,v]of Object.entries(policy.assets))if(v.requiredForCapture)assert(assets.has(name),'required loaded native/source asset absent');
    const workers=page.workers().filter(w=>new URL(w.url()).pathname===policy.nativeWorkerPath);assert(workers.length===1,'exact native worker unavailable');
    const result=await workers[0].evaluate(capture.readCorrectionState,{...layout,stateSide});assert(result&&result.stateSide===stateSide,'native worker state-side binding mismatch');return result;
  };
}
export async function captureFixedJob({browser,browserPID,scope,policy,output,guard,save}){
  // guard is the fixed host adapter's protected current-authority lease, not a
  // request-selected callback. Installed bootstrap must supply the real port.
  assert(typeof guard==='function'&&typeof save==='function');await guard();const target=fixedTarget(policy.targetURL),capture=await loadApprovedCapture(policy);
  const manifestRaw=readPinned(policy.manifest.path,2097152,policy.manifest.sha256);const manifest=JSON.parse(manifestRaw),layout=manifest.profiles?.['640x360']?.models?.step;
  assert(layout&&manifest.profiles['640x360'].sourceSha256===policy.profileSourceSHA256,'pinned native640 profile unavailable');
  const identity=await proveRuntime(browser,browserPID,scope,policy);await guard();identity.externalEnvelopeActive=true;identity.scope=scope;
  await save('RUNTIME-PROOF.json',identity);const context=await browser.newContext({viewport:{width:1440,height:1000},deviceScaleFactor:1,serviceWorkers:'block'}),assets=new Map(),failures=[];let workerProof;
  try{
    assert(typeof context.routeWebSocket==='function','bounded WebSocket policy unavailable');await context.routeWebSocket('**',socket=>socket.close({code:1008,reason:'Fixed public capture has no WebSocket protocol'}));
    await context.route('**/*',async route=>{
      try{assert(['GET','HEAD'].includes(route.request().method()),'fixed public capture permits only GET/HEAD');const url=route.request().url();assert(allowedURL(url,target,policy.assets),'request outside fixed public target');const u=new URL(url),selected=policy.assets[u.pathname];assert(selected&&/^[a-f0-9]{64}$/.test(selected.sha256),'unreviewed public asset');
        const response=await fetchPublicAsset(u.href,target,selected.maxBytes,route.request().method(),policy.assets);assert(response.status===200,'public asset status changed');const body=response.body,headers={...response.headers};if(route.request().method()==='HEAD'){await route.fulfill({status:200,headers,body:Buffer.alloc(0)});return;}assert(sha(body)===selected.sha256,'loaded asset differs');let transformed=body;
        assets.set(u.pathname,{url:u.href,bytes:body.length,sha256:sha(body),representation:'HTTP identity representation with bounded streaming',contentEncoding:headers['content-encoding']||null,status:response.status});
        if(u.pathname===policy.nativeWorkerPath){workerProof=transformWorker(body,capture.retainNativeMemory);assert(workerProof.hookSHA256===policy.hookSHA256,'approved hook changed');transformed=workerProof.body;delete headers['content-length'];delete headers['content-encoding'];delete headers.etag;headers['cache-control']='no-store';}
        await route.fulfill({status:response.status,headers,body:transformed});
      }catch(error){failures.push({class:error?.constructor?.name,messageSHA256:sha(String(error?.message||''))});await route.abort();}
    });
    const page=await context.newPage(),pageErrors=[];page.on('pageerror',e=>pageErrors.push({class:e.name,messageSHA256:sha(e.message)}));
    await page.goto(target.href,{waitUntil:'domcontentloaded',timeout:30000});await page.waitForFunction(()=>window.__slamLab?.initialized&&window.__slamLab?.ready,{},{timeout:120000});
    await page.evaluate(()=>window.__slamLab.runtime.pause());await page.waitForFunction(()=>!window.__slamLab.runtime.busy,{},{timeout:15000});
    assert(failures.length===0&&workerProof,'native instrumentation failed');await save('WORKER-SOURCE-PROOF.json',{originalSHA256:workerProof.originalSHA256,hookSHA256:workerProof.hookSHA256,transformedSHA256:workerProof.transformedSHA256});await guard();
    const workerState=createWorkerStateReader({guard,failures,pageErrors,policy,assets,page,capture,layout});
    const result=await capture.capturePage(page,{output,manifest,workerState,identity});await guard();assert(failures.length===0&&pageErrors.length===0);
    await save('LOADED-ASSETS.json',{assets:[...assets.values()],failures,pageErrors});return result;
  }finally{await finishContext(context,()=>save('LOADED-ASSETS-PARTIAL.json',{assets:[...assets.values()],failures,worker:workerProof?{originalSHA256:workerProof.originalSHA256,hookSHA256:workerProof.hookSHA256,transformedSHA256:workerProof.transformedSHA256}:null}));}
}
