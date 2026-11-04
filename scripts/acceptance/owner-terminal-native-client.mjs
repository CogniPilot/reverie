/** Isolated H acceptance backend stand-in; no HTTP, credentials or personal instance.
 * The companion fixture binds its explicitly selected image and immutable
 * runtime-selected engine into this private input; this client has no defaults.
 */
import fs from 'node:fs';
import net from 'node:net';
import crypto from 'node:crypto';
const cfg=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const socket=net.createConnection(cfg.bootstrapSocket);
let buffer=Buffer.alloc(0),ready=false,pending;
const expires=Date.now()+180000,scope='a'.repeat(64);
function send(value){const raw=Buffer.from(JSON.stringify(value));const prefix=Buffer.alloc(4);prefix.writeUInt32BE(raw.length);socket.write(Buffer.concat([prefix,raw]));}
const connected=new Promise((resolve,reject)=>{socket.on('error',reject);socket.on('data',chunk=>{
 buffer=Buffer.concat([buffer,chunk]);
 if(!ready){if(buffer.length<6)return;if(buffer.subarray(0,6).toString()!=='READY\n')throw Error('real H READY absent');buffer=buffer.subarray(6);ready=true;resolve();}
 while(buffer.length>=4){const size=buffer.readUInt32BE();if(size>8192)throw Error('frame bound');if(buffer.length<size+4)return;const value=JSON.parse(buffer.subarray(4,size+4));buffer=buffer.subarray(size+4);
  if(value.kind==='authority-check')send({...value,kind:'authority',scopeDigest:scope,expiresAtEpochMs:expires,target:cfg.target});
  else if(value.kind==='result'){if(!pending)throw Error('unexpected result');const p=pending;pending=undefined;clearTimeout(p.timer);p.resolve(value);}
  else throw Error('unexpected frame '+value.kind);
 }
});});
let sequence=0;
async function command(action,extra={}){if(pending)throw Error('overlap');const result=new Promise((resolve,reject)=>{pending={resolve,reject,timer:setTimeout(()=>reject(Error('command timeout '+action)),10000)};});
 send({kind:'command',n:++sequence,operationId:crypto.randomUUID(),action,handle:cfg.handle,employeeId:cfg.target.employeeId,...extra});const value=await result;if(value.state!=='ok')throw Error('H operation '+action+' '+value.state);return value.value;}
try{
 await connected;
 const issued=await command('issue',{cols:80,rows:24,lifetimeSeconds:120});
 const reference=issued.request.authorizationRef,shell=issued.request.shellId;
 const opened=await command('open',{reference,payload:null});if(opened.state!=='OPEN')throw Error('not open');
 await command('resize',{reference,payload:[100,30]});
 const marker='H_FIXTURE_OK_'+cfg.token;
 await command('input',{reference,payload:Buffer.from("printf 'H_FIXTURE_OK_%s\\n' '"+cfg.token+"'\n").toString('base64')});
 let output='',found=false;
 for(let i=0;i<40;i++){const value=await command('poll',{reference,payload:null});output+=Buffer.from(value.output,'base64').toString();if(output.split(/\r?\n/).some(line=>line===marker)){found=true;break;}await new Promise(r=>setTimeout(r,25));}
 if(!found)throw Error('independent PTY marker not observed');
 const ended=await command('end',{reference,payload:null});if(ended.state!=='SETTLED')throw Error('guest settlement absent');
 console.log(JSON.stringify({state:'H_ISOLATED_PTY_ACCEPTANCE_PASS',realBootstrapReady:true,shellId:shell,issuedReference:reference,markerObserved:true,inputOperations:1,resizeOperations:1,settled:true,ownerAuth:'synthetic private backend authority stand-in; no browser authentication exercised'}));
 socket.on('close',()=>process.exit(0));
}catch(error){console.error(error.stack);socket.destroy();process.exitCode=1;}
