/** Fixed unprivileged, mkdir-only metadata program. No caller path or shell is
 * accepted. The controller separately owns the actual /scratch root/grant. */
export const EPHEMERAL_NODE = '/opt/reverie-worker-client/bin/node';
export const EPHEMERAL_PREPARE_PROGRAM = String.raw`
const fs=require('node:fs');
const ROOT='/restore-root', owned=new Set(), dirs=[];
const io=(fn,...args)=>new Promise((resolve,reject)=>fn(...args,(error,value)=>error?reject(error):resolve(value)));
const fail=()=>{throw Error('Ephemeral directory preparation unavailable');};
const timer=setTimeout(()=>process.exit(1),8000);
const flags=fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK;
const identity=s=>({dev:String(s.dev),ino:String(s.ino),uid:Number(s.uid),gid:Number(s.gid),mode:Number(s.mode&0o7777n)});
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
async function open(path,options){const fd=await io(fs.open,path,options);owned.add(fd);return fd;}
async function close(fd){if(!owned.delete(fd))fail();await io(fs.close,fd);}
async function bytes(fd,max){const data=Buffer.alloc(max+1);let size=0;while(size<data.length){const n=await io(fs.read,fd,data,size,data.length-size,null);if(!n)break;size+=n;}if(size>max)fail();return data.subarray(0,size);}
async function mount(fd){
 const file=await open('/proc/self/fdinfo/'+fd,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 if((await io(fs.statfs,'/proc/self/fd/'+file,{bigint:true})).type!==0x9fa0n)fail();
 const text=(await bytes(file,4096)).toString('utf8');await close(file);
 const found=[...text.matchAll(/^mnt_id:\s*([1-9][0-9]*)\s*$/gm)];if(found.length!==1)fail();return found[0][1];
}
async function frame(fd,max){
 const data=Buffer.alloc(max+1);let size=0;
 while(size<data.length){
  let n;try{n=await io(fs.read,fd,data,size,data.length-size,null);}
  catch(error){if(!['EAGAIN','EWOULDBLOCK'].includes(error.code))throw error;await new Promise(resolve=>setTimeout(resolve,5));continue;}
  if(!n)fail();size+=n;const lf=data.subarray(0,size).indexOf(10);
  if(lf>=0){if(lf!==size-1||size>max)fail();return data.subarray(0,lf);}if(size>=max)fail();
 }fail();
}
async function inputFrame(){
 // Fixed procfs fd indirection duplicates ONLY our inherited pipe. No caller path is accepted.
 const original=await io(fs.fstat,0,{bigint:true});if(!original.isFIFO())fail();await mount(0);
 const fd=await open('/proc/self/fd/0',fs.constants.O_RDONLY|fs.constants.O_NONBLOCK);
 const duplicate=await io(fs.fstat,fd,{bigint:true}),after=await io(fs.fstat,0,{bigint:true});
 for(const value of [duplicate,after])if(!value.isFIFO()||value.dev!==original.dev||value.ino!==original.ino||
   value.uid!==original.uid||value.gid!==original.gid||value.mode!==original.mode)fail();
 const body=await frame(fd,8192);await close(fd);await close(0);return body;
}
function directory(s,uid,gid){if(!s.isDirectory()||s.uid!==BigInt(uid)||s.gid!==BigInt(gid)||(s.mode&0o7777n)!==0o700n)fail();}
function keys(value,names){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==names.sort().join(','))fail();}
function validate(value){
 keys(value,['version','purpose','operationId','employeeId','sessionId','sessionGeneration','invocation','layout','root','forbidden']);
 if(!Number.isSafeInteger(value.invocation)||value.invocation<=0)fail();
 if(!Number.isSafeInteger(value.sessionGeneration)||value.sessionGeneration<=0)fail();
 if(value.version!==1||value.purpose!=='reverie-ephemeral-directory-restore-v1'||!['employees','operator-recovery','operator-sessions'].includes(value.layout))fail();
 for(const key of ['operationId','employeeId','sessionId'])if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value[key]))fail();
 keys(value.root,['dev','ino','uid','gid','mode']);
 if(!Number.isInteger(value.root.uid)||value.root.uid<=0||!Number.isInteger(value.root.gid)||value.root.gid<0||value.root.mode!==0o700)fail();
 if(!Array.isArray(value.forbidden)||value.forbidden.length>16)fail();
 for(const item of [value.root,...value.forbidden]){if(item!==value.root)keys(item,['dev','ino']);for(const key of ['dev','ino'])if(!/^(0|[1-9][0-9]{0,19})$/.test(item[key]))fail();}
 return value;
}
(async()=>{try{
 if(process.platform!=='linux')fail();process.umask(0o077);owned.add(0);
 const body=await inputFrame();const text=body.toString('utf8');if(!Buffer.from(text).equals(body))fail();
 const value=validate(JSON.parse(text)),uid=process.getuid(),gid=process.getgid();
 if(uid!==value.root.uid||gid!==value.root.gid)fail();
 const root=await open(ROOT,flags),stat=await io(fs.fstat,root,{bigint:true});directory(stat,uid,gid);
 if(!equal(identity(stat),value.root))fail();
 const rootMount=await mount(root);
 const forbidden=fact=>value.forbidden.some(item=>item.dev===fact.dev&&item.ino===fact.ino);
 if(forbidden(identity(stat)))fail();dirs.push({fd:root,path:ROOT,fact:identity(stat)});
 async function current(){for(const dir of dirs){const actual=await io(fs.fstat,dir.fd,{bigint:true}),named=await io(fs.lstat,dir.path,{bigint:true});directory(actual,uid,gid);directory(named,uid,gid);if(!equal(identity(actual),dir.fact)||!equal(identity(named),dir.fact)||await mount(dir.fd)!==rootMount)fail();}}
 const selected=value.layout==='employees'?value.employeeId:value.sessionId;
 for(const component of ['laptops',value.layout,selected,'tmp']){
  if(component.length>255||component.includes('/'))fail();await current();
  const parent=dirs.at(-1),path='/proc/self/fd/'+parent.fd+'/'+component;
  try{await io(fs.mkdir,path,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
  const fd=await open(path,flags),actual=await io(fs.fstat,fd,{bigint:true});directory(actual,uid,gid);
  const fact=identity(actual);if(forbidden(fact)||await mount(fd)!==rootMount)fail();
  dirs.push({fd,path,fact});await io(fs.fsync,parent.fd);await current();
 }
 for(const dir of dirs)await io(fs.fsync,dir.fd);await current();
 const ack={version:1,purpose:'reverie-ephemeral-directories-ready-v1',operationId:value.operationId,employeeId:value.employeeId,sessionId:value.sessionId,sessionGeneration:value.sessionGeneration,invocation:value.invocation,layout:value.layout,root:dirs[0].fact,scratch:dirs[3].fact,tmp:dirs[4].fact};
 for(const dir of [...dirs].reverse())await close(dir.fd);
 // All consuming closes precede ACK. Paths are diagnostic revalidation only;
 // the controller retains its own root/leaf FDs and checks actual destination mounts.
 let path=ROOT;for(const [index,component] of ['', 'laptops',value.layout,selected,'tmp'].entries()){
  if(component)path+='/'+component;const actual=await io(fs.lstat,path,{bigint:true});directory(actual,uid,gid);if(!equal(identity(actual),dirs[index].fact))fail();
 }
 if(owned.size)fail();const output=Buffer.from(JSON.stringify(ack)+'\n');let offset=0;while(offset<output.length){const n=await io(fs.write,1,output,offset,output.length-offset,null);if(n<=0)fail();offset+=n;}clearTimeout(timer);
}catch{for(const fd of [...owned]){owned.delete(fd);try{await io(fs.close,fd);}catch{}}clearTimeout(timer);process.stderr.write('Ephemeral directories not confirmed\n');process.exitCode=1;}})();
`;
/** Read-only physical identity of the two actual destination mount roots. */
export const EPHEMERAL_DESTINATION_PROGRAM = String.raw`
const fs=require('node:fs'),owned=[];
try{const result={version:1,purpose:'reverie-ephemeral-destination-v1'};
for(const [key,path] of [['scratch','/scratch'],['tmp','/tmp']]){
 const fd=fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);owned.push(fd);
 const s=fs.fstatSync(fd,{bigint:true});if(!s.isDirectory()||(s.mode&0o7777n)!==0o700n)throw Error();
 result[key]={dev:String(s.dev),ino:String(s.ino),uid:Number(s.uid),gid:Number(s.gid),mode:Number(s.mode&0o7777n)};
}while(owned.length){const fd=owned.pop();fs.closeSync(fd);}process.stdout.write(JSON.stringify(result)+'\n');
}catch{while(owned.length){const fd=owned.pop();try{fs.closeSync(fd);}catch{}}process.exitCode=1;}
`;
