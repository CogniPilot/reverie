/** Fixed own-job Node producer. Only the protected parent pipe can renew authority.
 * No remote CDP/listener, caller source, host-file API or actor selector exists.
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {captureFixedJob} from './slam-driver.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex');
function read(file,maximum=1048576){assert(fs.realpathSync(file)===file);const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const a=fs.fstatSync(fd,{bigint:true});assert(a.isFile()&&a.uid===BigInt(process.getuid())&&a.nlink===1n&&(a.mode&0o777n)===0o600n&&a.size<=BigInt(maximum));const chunks=[];let size=0;while(size<=maximum){const chunk=Buffer.alloc(Math.min(65536,maximum+1-size)),n=fs.readSync(fd,chunk);if(!n)break;chunks.push(chunk.subarray(0,n));size+=n;}const stamp=s=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':');assert(size===Number(a.size)&&size<=maximum&&stamp(a)===stamp(fs.fstatSync(fd,{bigint:true}))&&stamp(a)===stamp(fs.lstatSync(file,{bigint:true})),'private input changed');return Buffer.concat(chunks,size);}finally{fs.closeSync(fd);}}
export function assertBrokerConfig(file,expected){assert(/^[a-f0-9]{64}$/.test(expected)&&sha(read(file))===expected,'current broker configuration changed');}
function exclusive(file,value){const raw=Buffer.from(JSON.stringify(value,null,2)+'\n');assert(raw.length<=1048576);const fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);try{fs.writeFileSync(fd,raw);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}const d=fs.openSync(path.dirname(file),fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);try{fs.fsyncSync(d);}finally{fs.closeSync(d);}}
function birth(pid){const row=fs.readFileSync('/proc/'+pid+'/stat','utf8').split(')').slice(1).join(')').trim().split(/\s+/);return {pid,startTick:row[19],state:row[0]};}
function controller(input,policy,scope){const c=input.controller;assert(Number.isSafeInteger(c.pid)&&c.pid>1&&/^\d+$/.test(c.startTick));const r=birth(c.pid);assert(r.startTick===c.startTick&&!['Z','X'].includes(r.state));assert(fs.realpathSync('/proc/'+c.pid+'/exe')===c.exe&&c.exe.startsWith('/nix/store/'));
  assert(fs.realpathSync(c.workerModule)===c.workerModule&&c.workerModule.startsWith('/nix/store/')&&sha(fs.readFileSync(c.workerModule))===policy.pythonSource['worker.py']);
  const cmd=fs.readFileSync('/proc/'+c.pid+'/cmdline');assert(cmd.length<=16384);const argv=cmd.toString().split('\0');assert(argv.includes(c.workerModule)&&argv.includes(input.brokerConfigPath),'actual fixed broker entry unavailable');
  assertBrokerConfig(input.brokerConfigPath,input.brokerConfigSHA256);
  const group=fs.readFileSync('/proc/'+c.pid+'/cgroup','utf8').trim();assert(group.startsWith('0::/')&&group!=='0::'+scope.controlGroup&&!group.startsWith('0::'+scope.controlGroup+'/'));
  assert(Number.isSafeInteger(c.operationLockFD)&&c.operationLockFD>2&&c.operationLockFD<4096);const lock=path.join(path.dirname(input.task),'.ops',path.basename(input.task)+'.lock'),a=fs.statSync(lock),b=fs.statSync('/proc/'+c.pid+'/fd/'+c.operationLockFD);assert(a.isFile()&&a.uid===process.getuid()&&a.nlink===1&&(a.mode&0o777)===0o600&&a.dev===b.dev&&a.ino===b.ino);const info=fs.readFileSync('/proc/'+c.pid+'/fdinfo/'+c.operationLockFD,'utf8');assert(info.length<=16384&&/lock:\s+\d+: FLOCK\s+ADVISORY\s+WRITE\s+/.test(info),'actual retained operation lock unavailable');assert(birth(c.pid).startTick===c.startTick);
}
export function childEnvironment(policy,root){
 const env={HOME:path.join(root,'home'),LANG:'C.UTF-8',PATH:[...new Set(Object.values(policy.tools).map(t=>path.dirname(t.path)))].join(':'),TMPDIR:path.join(root,'tmp'),XDG_RUNTIME_DIR:path.join(root,'runtime'),XDG_CACHE_HOME:path.join(root,'cache'),XDG_CONFIG_HOME:path.join(root,'config'),VK_DRIVER_FILES:policy.vulkanIcd.path};
 return env;
}
export class FixedGuard {
 constructor(input,output,policySHA256,recheck,onFailure){this.input=input;this.output=output;this.digest=policySHA256;this.recheck=recheck;this.onFailure=onFailure;this.sequence=0;this.pending=null;this.closed=false;this.buffer=Buffer.alloc(0);this.data=b=>this.receive(b);this.eof=()=>this.fail(Error('protected controller EOF'));input.on('data',this.data);input.on('end',this.eof);input.on('error',this.eof);input.on('close',this.eof);}
 fail(error){if(this.closed)return;this.closed=true;if(this.pending){clearTimeout(this.pending.timer);this.pending.reject(error);this.pending=null;}this.onFailure(error);}
 receive(chunk){try{assert(!this.closed);assert(this.buffer.length+chunk.length<=8192);this.buffer=Buffer.concat([this.buffer,chunk]);let end;while((end=this.buffer.indexOf(10))>=0){assert(end<=4096&&this.pending);const line=this.buffer.subarray(0,end);this.buffer=this.buffer.subarray(end+1);const value=JSON.parse(line);assert(Object.keys(value).sort().join(',')==='allowed,policySHA256,sequence'&&value.sequence===this.pending.sequence&&value.policySHA256===this.digest&&value.allowed===true);this.recheck();const done=this.pending;this.pending=null;clearTimeout(done.timer);done.resolve();}}catch(error){this.fail(error);}}
 request(){return new Promise((resolve,reject)=>{try{assert(!this.closed&&!this.pending);this.recheck();const sequence=++this.sequence,timer=setTimeout(()=>this.fail(Error('protected authority renewal deadline')),10000);this.pending={sequence,resolve,reject,timer};this.output.write(JSON.stringify({kind:'FIXED_JOB_GUARD',sequence,policySHA256:this.digest})+'\n');}catch(error){reject(error);this.fail(error);}});}
 close(){this.input.off('data',this.data);for(const event of ['end','close','error'])this.input.off(event,this.eof);this.fail(Error('job completed'));this.input.destroy();}
}
export class JobClock {
 constructor(limits,expired){this.limits=limits;this.expired=expired;this.start=performance.now();this.phase='setup';this.deadline=this.start+limits.setupSeconds*1000;this.arm();}
 arm(){clearTimeout(this.timer);this.timer=setTimeout(()=>{this.phase='expired';this.expired();},Math.max(1,this.deadline-performance.now()));this.timer.unref();}
 check(){assert(this.phase!=='expired'&&performance.now()<this.deadline,'fixed job phase deadline');}
 capture(){this.check();assert(this.phase==='setup','capture phase cannot restart');this.phase='capture';this.deadline=Math.min(performance.now()+this.limits.captureSeconds*1000,this.start+this.limits.runtimeSeconds*1000);this.arm();}
 close(){clearTimeout(this.timer);}
}
export async function main(argv){
 assert(argv.length===4&&argv[0]==='--input'&&argv[2]==='--policy');const inputPath=fs.realpathSync(argv[1]),input=JSON.parse(read(inputPath)),policyPath=fs.realpathSync(argv[3]),raw=read(policyPath),policy=JSON.parse(raw);assert(sha(raw)===input.policySHA256);
 const root=path.join(input.task,'f'),group=fs.readFileSync('/proc/self/cgroup','utf8').trim();assert(group.startsWith('0::/')&&path.basename(group.slice(3))==='reverie-gpu-job-'+input.operationId+'.scope');const scope={jobId:input.operationId,policySHA256:input.policySHA256,controlGroup:group.slice(3),memoryBytes:input.spec.memory_bytes,pids:input.spec.pids,cpus:input.spec.cpus,runtimeSeconds:input.spec.runtime_seconds,stopSeconds:input.spec.stop_seconds};assert(fs.realpathSync('/proc/self/exe')===policy.tools.node.path&&process.cwd()===path.join(root,'work')&&process.env.HOME===path.join(root,'home'));controller(input,policy,scope);
 let browserServer,browser;const closeBrowser=()=>{void browser?.close().catch(()=>{});},clock=new JobClock(policy.limits,closeBrowser),channel=new FixedGuard(process.stdin,process.stdout,input.policySHA256,()=>controller(input,policy,scope),closeBrowser);const guard=async()=>{clock.check();await channel.request();clock.check();};
 const save=async(name,value)=>{assert(/^[A-Z0-9.-]{1,64}\.json$/i.test(name));if(name==='WORKER-SOURCE-PROOF.json')clock.capture();exclusive(path.join(root,'artifacts',name),value);};let result={state:'FAILED_NO_REPLAY'},stage='native-admission';
 try{
   await guard();const require=createRequire(import.meta.url),dependency=require.resolve('playwright/package.json');assert(dependency.startsWith('/nix/store/')&&fs.realpathSync(dependency)===dependency&&fs.statSync(dependency).uid===0&&(fs.statSync(dependency).mode&0o222)===0,'installed immutable Playwright dependency required');const {chromium}=require('playwright');
   // Bus entries are used solely by the outer systemd client. Neither the
   // browser nor driver helpers receive the broker's user bus or environment.
   const env=childEnvironment(policy,root);for(const key of Object.keys(process.env))delete process.env[key];Object.assign(process.env,env);
   stage='sandboxed-hardware-browser';browserServer=await chromium.launchServer({headless:true,chromiumSandbox:true,executablePath:policy.tools.chromium.path,timeout:15000,env,args:['--enable-gpu','--use-gl=angle','--use-angle=vulkan','--enable-features=Vulkan','--disable-vulkan-surface','--ignore-gpu-blocklist']});browser=await chromium.connect(browserServer.wsEndpoint(),{timeout:10000});
   const b=browserServer.process(),before=birth(b.pid);assert(fs.readFileSync('/proc/'+b.pid+'/cgroup','utf8').trim()===group);exclusive(path.join(root,'BROWSER-PID.json'),before);stage='fixed-public-capture';const policyForDriver={...policy,tools:{...policy.tools,nvidiaSMI:policy.tools.nvidiaSMI}};
   const captured=await captureFixedJob({browser,browserPID:b.pid,scope,policy:policyForDriver,output:path.join(root,'capture'),guard,save});await guard();result={state:'CAPTURE_COMPLETED_NOT_RELEASE_ACCEPTANCE',capture:captured};
 }catch(error){result={state:'FAILED_NO_REPLAY',stage,class:error?.constructor?.name,errorSHA256:sha(String(error?.message||''))};}
 finally{const errors=[];try{if(browser)await browser.close();}catch(e){errors.push({stage:'browser-close',class:e?.constructor?.name});}try{if(browserServer)await browserServer.close();}catch(e){errors.push({stage:'browser-server-close',class:e?.constructor?.name});}if(errors.length)result={state:'FAILED_CLEANUP_UNCONFIRMED',errors,earlierState:result.state};clock.close();channel.close();exclusive(path.join(root,'NODE-RESULT.json'),result);}
 assert(result.state==='CAPTURE_COMPLETED_NOT_RELEASE_ACCEPTANCE','fixed capture failed; preserve partial artifacts');return result;
}
if(process.argv[1]&&fs.realpathSync(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2)).catch(e=>{console.error(JSON.stringify({kind:'FIXED_JOB_FAILED',class:e?.constructor?.name,errorSHA256:sha(String(e?.message||''))}));process.exitCode=1;});
