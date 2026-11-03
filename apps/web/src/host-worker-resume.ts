/** Distinct host-native maintenance stream. No HTTP route or human/employee impersonation. */
import {createHash} from 'node:crypto';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
import type {CompanyState} from './company-types.js';
import type {SessionState} from './types.js';
import type {CompanyWakeReport} from './company-wake.js';
import {RuntimeRecipeSchema} from './expert-runtime-recipe.js';
import {nativeCodexThread,nativeOpenCodeThread,resolveResumeConversationId} from './reboot-restore.js';
import {isCleanPaneExit} from './pane-exit-sweep.js';

const PURPOSE='host-worker-resume-v1', MAX=8192;
const UUID=z.string().uuid().refine(x=>x===x.toLowerCase());
const SHA=z.string().regex(/^[a-f0-9]{64}$/);
const Binding=z.object({employeeId:UUID,sessionId:UUID,generation:z.number().int().positive().safe(),
  owner:z.string().nullable(),desiredRunning:z.boolean(),onVacation:z.boolean(),migrating:z.boolean(),
  recipeDigest:SHA}).strict();
const Expected=Binding.extend({savedDigest:SHA}).strict();
const Epoch=z.number().int().positive().safe();
const Describe=z.object({kind:z.literal('describe'),nonce:UUID,expiresAtEpochMs:Epoch,cohort:z.array(Binding).min(1).max(16)}).strict();
const Wake=z.object({kind:z.literal('wake'),nonce:UUID,expiresAtEpochMs:Epoch,operationId:UUID,employee:Expected}).strict();
const configKeys=['openCodeConfig','codexConfig','geminiConfig','antigravityConfig','piConfig','grokConfig','deepSeekConfig','ompConfig'];
const safeKeys=new Set(['model','continueSession','resumeSessionId','forkSession','reasoningEffort','thinking','effort',
  'autoAllowTools','dangerouslyBypassApprovals','approvalMode','sandboxMode']);
function need(ok:unknown, reason='Native host recovery unavailable'):asserts ok {if(!ok)throw new Error(reason);}
// The lower native frame codec uses ASCII JSON, independently of digest key order.
const text=(value:unknown)=>JSON.stringify(value).replace(/[^\x20-\x7e]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
function ordered(value:unknown):unknown {
  if(Array.isArray(value))return value.map(ordered);
  if(value!==null&&typeof value==='object')return Object.fromEntries(Object.entries(value)
    .filter(([,v])=>v!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>[k,ordered(v)]));
  need(value===null||typeof value==='string'||typeof value==='boolean'||
    (typeof value==='number'&&Number.isSafeInteger(value)),'Unsupported native resume metadata');return value;
}
export const resumeDigest=(value:unknown)=>createHash('sha256').update(text(ordered(value))).digest('hex');

/** Kernel mount facts, not a server greeting, establish the host socket boundary. */
export function resumeSocketMount(mountinfo:string,directory:string):string {
  need(mountinfo.length<=1024*1024&&directory.startsWith('/'));
  const decode=(field:string)=>field.replace(/\\(040|011|012|134)/g,(_,octal:string)=>String.fromCharCode(parseInt(octal,8)));
  const rows=mountinfo.split('\n').filter(Boolean).map(line=>{
    const halves=line.split(' - '),fields=halves[0].split(' ');
    need(halves.length===2&&fields.length>=6);
    return {line,point:decode(fields[4]),options:fields[5].split(',')};
  }).filter(row=>directory===row.point||directory.startsWith(row.point==='/'?'/':row.point+'/'));
  rows.sort((a,b)=>b.point.length-a.point.length);
  need(rows.length>0&&rows[0].point===directory&&rows[0].options.includes('ro')&&
    !rows[0].options.includes('rw')&&rows.filter(row=>row.point===directory).length===1,
    'Native host socket needs its read-only directory mount');
  return rows[0].line;
}
function socketCustody(socketPath:string):{identity:string;current:()=>boolean} {
  need(path.isAbsolute(socketPath)&&path.normalize(socketPath)===socketPath&&
    fs.realpathSync(socketPath)===socketPath);
  const directory=path.dirname(socketPath);
  const mount=()=>{
    const fd=fs.openSync('/proc/self/mountinfo','r');
    try {const chunks:Buffer[]=[];let size=0;
      for(;;){const buffer=Buffer.alloc(16384),count=fs.readSync(fd,buffer,0,buffer.length,null);
        if(!count)break;size+=count;need(size<=1024*1024);chunks.push(buffer.subarray(0,count));}
      return resumeSocketMount(Buffer.concat(chunks).toString('utf8'),directory);
    }finally{fs.closeSync(fd);}
  };
  const identity=()=>{const row=fs.lstatSync(socketPath,{bigint:true});
    need(row.isSocket()&&row.uid===BigInt(process.getuid!())&&(row.mode&0o777n)===0o600n&&row.nlink===1n);
    const parent=fs.lstatSync(directory,{bigint:true});
    need(parent.isDirectory()&&(parent.mode&0o022n)===0n);
    return {socket:[row.dev,row.ino,row.uid,row.mode,row.ctimeNs].join(':'),
      parent:[parent.dev,parent.ino,parent.mode].join(':')};};
  const firstMount=mount(),first=identity();
  return {identity:first.socket,current:()=>{try{const now=identity();
    return mount()===firstMount&&now.socket===first.socket&&now.parent===first.parent&&
      fs.realpathSync(socketPath)===socketPath;}catch{return false;}}};
}
function frame(value:unknown):Buffer {const raw=Buffer.from(text(value));need(raw.length>0&&raw.length<=MAX);
  const head=Buffer.alloc(4);head.writeUInt32BE(raw.length);return Buffer.concat([head,raw]);}

export interface HostResumeDeps {
  company():Pick<CompanyState,'employees'>;
  saved(sessionId:string):SessionState|undefined;
  live(sessionId:string):boolean;
  wake(employeeId:string,stillCurrent:()=>boolean):Promise<CompanyWakeReport>;
}

/** Fingerprint only the normal launch/continuation settings, never output/environment/credentials. */
export function savedResumeDigest(saved:SessionState|undefined):string {
  if(!saved)return resumeDigest({absent:true});
  const record=saved as unknown as Record<string,unknown>;
  const configs:Record<string,Record<string,unknown>>={};
  for(const key of configKeys){const value=record[key];if(value&&typeof value==='object')
    configs[key]=Object.fromEntries(Object.entries(value).filter(([k])=>safeKeys.has(k)));}
  const custom=record.customModel as {endpointId?:unknown;modelId?:unknown}|undefined;
  const recipe=RuntimeRecipeSchema.parse({mode:saved.mode,workingDir:saved.workingDir,model:saved.model,effort:saved.effort,
    subscriptionProfile:saved.subscriptionProfile,runtimeThreads:saved.runtimeThreads,configs,
    customModel:custom?{endpointId:custom.endpointId,modelId:custom.modelId}:undefined});
  return resumeDigest({id:saved.id,owner:saved.owner??null,recipe,advisorModel:saved.advisorModel??null,
    resume:nativeCodexThread(saved)??nativeOpenCodeThread(saved)??resolveResumeConversationId(saved),
    intentionallyStopped:saved.status==='stopped',cleanPaneExit:isCleanPaneExit(saved.paneExit),
    respawnBlocked:saved.respawnBlocked===true,remoteOrDocker:!!(saved.remote||saved.docker)});
}

export class HostResumeHandler {
  #flight=false;
  #consumed=new Set<string>();
  constructor(private readonly deps:HostResumeDeps){}
  snapshot():z.infer<typeof Expected>[] {
    const employees=this.deps.company().employees;
    need(employees.length>0&&employees.length<=16);
    const rows=employees.map(e=>{
      const saved=this.deps.saved(e.sessionId);
      const eligible=e.desiredRunning===true&&!e.onVacation&&!e.bindingMigration;
      need(!eligible||(!!saved&&saved.owner===e.owner),'Saved employee runtime unavailable');
      return Expected.parse({employeeId:e.id,sessionId:e.sessionId,generation:e.sessionGeneration,owner:e.owner??null,
        desiredRunning:e.desiredRunning,onVacation:e.onVacation,migrating:!!e.bindingMigration,
        recipeDigest:resumeDigest(RuntimeRecipeSchema.parse(e.runtimeRecipe)),savedDigest:savedResumeDigest(saved)});
    }).sort((a,b)=>a.employeeId<b.employeeId?-1:a.employeeId>b.employeeId?1:0);
    need(new Set(rows.map(r=>r.employeeId)).size===rows.length&&new Set(rows.map(r=>r.sessionId)).size===rows.length);
    return rows;
  }
  async dispatch(value:unknown,streamCurrent:()=>boolean=()=>true):Promise<unknown> {
    need(!this.#flight,'Native resume stream already active');this.#flight=true;
    try {
      const described=Describe.safeParse(value);
      if(described.success){const remaining=described.data.expiresAtEpochMs-Date.now();
        need(streamCurrent()&&remaining>0&&remaining<=120_000);
        const rows=this.snapshot();need(text(rows.map(({savedDigest,...row})=>row))===text(described.data.cohort));
        return {cohort:rows,snapshotDigest:resumeDigest(rows)};}
      const request=Wake.parse(value),expected=request.employee;
      const remaining=request.expiresAtEpochMs-Date.now();need(remaining>0&&remaining<=120_000);
      const deadline=performance.now()+remaining;
      const stillCurrent=()=>streamCurrent()&&performance.now()<deadline;
      const key=request.operationId+':'+expected.employeeId;
      need(!this.#consumed.has(key)&&this.#consumed.size<4096,'Native recovery is not replayable');
      const current=()=>this.snapshot().find(r=>r.employeeId===expected.employeeId);
      need(stillCurrent()&&text(current())===text(expected),'Employee binding or saved runtime changed');
      need(expected.desiredRunning&&!expected.onVacation&&!expected.migrating,'Employee is stopped or unavailable');
      // Mark before any awaited normal launch. ACK loss never authorizes resending.
      this.#consumed.add(key);
      const wasLive=this.deps.live(expected.sessionId);
      const result=await this.deps.wake(expected.employeeId,()=>stillCurrent()&&text(current())===text(expected));
      const after=current();
      // Normal launch may update running status but must retain the approved
      // identity/recipe/continuation. No old context is retargeted to a new SID.
      need(stillCurrent()&&after&&text(after)===text(expected),'Employee changed during native recovery');
      need(result.awakened.includes(expected.employeeId)||
        (wasLive&&this.deps.live(expected.sessionId)&&!result.skipped.length),'Normal employee recovery was not confirmed');
      return {employeeId:expected.employeeId,sessionId:expected.sessionId,generation:expected.generation,
        state:wasLive?'already-live':'awakened'};
    } finally {this.#flight=false;}
  }
}

/** Server-selected worker socket only. Registration carries no process/owner claims. */
export class HostWorkerResumeStream {
  #socket?:net.Socket;#buffer=Buffer.alloc(0);#ready=false;#busy=false;#closed=false;
  #stopped=false;#attempts=0;#incarnation?:string;#retry?:NodeJS.Timeout;
  constructor(private readonly path:string|undefined,private readonly handler:HostResumeHandler){}
  start():void {
    if(!this.path)return;
    if(!this.path.startsWith('/')||Buffer.byteLength(this.path)>=108){this.#stopped=true;return;}
    this.#connect();
  }
  #connect():void {
    if(this.#stopped||this.#socket||this.#busy)return;
    need(this.path);
    let custody:ReturnType<typeof socketCustody>;
    try{custody=socketCustody(this.path);}catch{this.#schedule();return;}
    // Exhaustion permits custody observations only. A new trusted kernel socket
    // gets a fresh registration budget; the handler and its consumed wakes persist.
    if(custody.identity!==this.#incarnation){this.#incarnation=custody.identity;this.#attempts=0;}
    if(this.#attempts>=120){this.#schedule();return;}
    this.#attempts++;this.#closed=false;this.#buffer=Buffer.alloc(0);this.#ready=false;
    const current=custody.current;
    const socket=this.#socket=net.createConnection(this.path);
    socket.setTimeout(60_000);socket.on('timeout',()=>socket.destroy());
    socket.on('connect',()=>{if(!current()){socket.destroy();return;}const raw=Buffer.from(text({version:1,purpose:PURPOSE,kind:'register'}));
      const head=Buffer.alloc(5);head[0]='Y'.charCodeAt(0);head.writeUInt32BE(raw.length,1);socket.write(Buffer.concat([head,raw]));});
    socket.on('data',chunk=>{try{need(current());if(this.#socket===socket)this.#data(chunk,socket,current);}catch{socket.destroy();}});
    socket.on('error',()=>socket.destroy());socket.on('close',()=>{
      if(this.#socket!==socket)return;this.#closed=true;this.#socket=undefined;this.#schedule();});
  }
  #schedule():void {
    if(this.#stopped||this.#busy||this.#retry)return;
    this.#retry=setTimeout(()=>{this.#retry=undefined;this.#connect();},5000);this.#retry.unref();
  }
  close():void {this.#stopped=true;this.#closed=true;if(this.#retry)clearTimeout(this.#retry);this.#socket?.destroy();}
  #send(value:unknown,socket:net.Socket):void {need(!this.#closed&&this.#socket===socket&&!socket.destroyed);socket.write(frame(value));}
  #data(chunk:Buffer,socket:net.Socket,current:()=>boolean):void {
    need(!this.#closed&&this.#buffer.length+chunk.length<=MAX+64);
    this.#buffer=Buffer.concat([this.#buffer,chunk]);
    if(!this.#ready){const greeting=Buffer.from('HOST_RESUME_READY\n');
      need(this.#buffer.subarray(0,Math.min(this.#buffer.length,greeting.length)).equals(greeting.subarray(0,Math.min(this.#buffer.length,greeting.length))));
      if(this.#buffer.length<greeting.length)return;this.#buffer=this.#buffer.subarray(greeting.length);this.#ready=true;
      this.#attempts=0;socket.setTimeout(0);}
    while(this.#buffer.length>=4){const length=this.#buffer.readUInt32BE(0);need(length>0&&length<=MAX);
      if(this.#buffer.length<length+4)return;
      const raw=this.#buffer.subarray(4,length+4);this.#buffer=this.#buffer.subarray(length+4);
      const body=new TextDecoder('utf8',{fatal:true}).decode(raw);const value=JSON.parse(body);need(text(value)===body);
      need(!this.#busy&&typeof value.nonce==='string'&&UUID.safeParse(value.nonce).success);this.#busy=true;
      const nonce=value.nonce;const heartbeat=setInterval(()=>{try{this.#send({kind:'progress',nonce},socket);}catch{socket.destroy();}},1000);
      void this.handler.dispatch(value,()=>current()&&!this.#closed&&this.#socket===socket&&!socket.destroyed)
        .then(result=>this.#send({kind:'result',nonce,value:result},socket))
        .catch(()=>socket.destroy()).finally(()=>{clearInterval(heartbeat);this.#busy=false;if(this.#closed)this.#schedule();});
    }
  }
}
