/** Fixed metadata-only source reader. Its private exec pipe may carry auth to
 * the controller; no secret enters argv, the move journal or container logs. */
export const DOCKER_PLAN_SOURCE_HOLD_PROGRAM = 'setInterval(() => {}, 1000);';
export const DOCKER_PLAN_SOURCE_READ_PROGRAM = String.raw`
const fs=require('node:fs'),crypto=require('node:crypto');
const HOME='/home/agent',ACCOUNT='/source-account';
const fds=[],checks=[];let output;
function no(){throw Error('Source read unconfirmed');}
const deadline=performance.now()+8000;function time(){if(performance.now()>deadline)no();}
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/,hex=/^[0-9a-f]{64}$/,decimal=/^(0|[1-9][0-9]{0,19})$/;
const [mode,homeDev,homeIno,provider,kind,operation,projection,accountId,nativeId,accountDev,accountIno,historicalContextDigest]=process.argv.slice(1);
function component(s){time();return typeof s==='string'&&s.length>0&&Buffer.byteLength(s)<=255&&s!=='.'&&s!=='..'&&!/[\x00-\x1f\x7f/\\]/.test(s);}
function mount(fd){const text=fs.readFileSync('/proc/self/fdinfo/'+fd,'utf8'),m=/^mnt_id:\s+([0-9]+)$/m.exec(text);if(!m)no();return m[1];}
function stamp(s){return[s.dev,s.ino,s.uid,s.gid,s.mode,s.nlink,s.size,s.mtimeNs,s.ctimeNs].join(':');}
function canonical(v){if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';if(v&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';return JSON.stringify(v);}
function hash(v){return crypto.createHash('sha256').update(v).digest('hex');}
function object(v,keys){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!==keys.slice().sort().join(','))no();return v;}
function owned(s,dir){if((dir?!s.isDirectory():!s.isFile())||s.uid!==BigInt(process.getuid())||(s.mode&0o022n)!==0n||(!dir&&s.nlink!==1n))no();}
function root(path,dev,ino){const fd=fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);fds.push(fd);const s=fs.fstatSync(fd,{bigint:true}),mountId=mount(fd);owned(s,true);if(String(s.dev)!==dev||String(s.ino)!==ino)no();const named=()=>fs.lstatSync(path,{bigint:true});if(stamp(s)!==stamp(named()))no();checks.push(()=>{if(mount(fd)!==mountId||stamp(fs.fstatSync(fd,{bigint:true}))!==stamp(s)||stamp(named())!==stamp(s))no();});return fd;}
function child(parent,name){if(!component(name))no();const path='/proc/self/fd/'+parent+'/'+name,fd=fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);fds.push(fd);const s=fs.fstatSync(fd,{bigint:true}),mountId=mount(fd);owned(s,true);if(mountId!==mount(parent)||stamp(s)!==stamp(fs.lstatSync(path,{bigint:true})))no();checks.push(()=>{if(mount(fd)!==mountId||stamp(fs.fstatSync(fd,{bigint:true}))!==stamp(s)||stamp(fs.lstatSync(path,{bigint:true}))!==stamp(s))no();});return fd;}
function walk(parent,parts){if(!Array.isArray(parts)||parts.length<1||parts.length>32||parts.some(x=>!component(x))||parts.reduce((n,p)=>n+Buffer.byteLength(p)+1,0)>4096)no();for(const part of parts)parent=child(parent,part);return parent;}
function read(parent,name,limit,collect,privateFile=false){if(!component(name))no();const path='/proc/self/fd/'+parent+'/'+name,fd=fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);fds.push(fd);const s=fs.fstatSync(fd,{bigint:true});owned(s,false);if(mount(fd)!==mount(parent)||(privateFile&&(s.mode&0o077n)!==0n))no();if(s.size<0n||s.size>BigInt(limit)||stamp(fs.lstatSync(path,{bigint:true}))!==stamp(s))no();const hasher=crypto.createHash('sha256'),chunks=[];let offset=0;for(;;){time();const b=Buffer.alloc(Math.min(65536,limit+1-offset)),n=fs.readSync(fd,b,0,b.length,offset);offset+=n;if(offset>limit)no();if(!n)break;const bytes=b.subarray(0,n);hasher.update(bytes);if(collect)chunks.push(bytes);}if(BigInt(offset)!==s.size||stamp(fs.fstatSync(fd,{bigint:true}))!==stamp(s)||stamp(fs.lstatSync(path,{bigint:true}))!==stamp(s))no();checks.push(()=>{if(stamp(fs.fstatSync(fd,{bigint:true}))!==stamp(s)||stamp(fs.lstatSync(path,{bigint:true}))!==stamp(s))no();});return{sha256:hasher.digest('hex'),bytes:collect?Buffer.concat(chunks):undefined};}
function json(parent,name,limit,privateFile=false){const readback=read(parent,name,limit,true,privateFile),text=readback.bytes.toString('utf8');if(!Buffer.from(text).equals(readback.bytes))no();return{value:JSON.parse(text),text};}
function generation(home){if(!uuid.test(operation||'')||!hex.test(projection||'')||!/^[a-zA-Z0-9_-]{1,100}$/.test(accountId||''))no();const parent=walk(home,['.reverie','plan-moves',operation,'generation-'+projection]);const item=json(parent,'manifest.json',65536),manifest=object(item.value,['version','purpose','material','context']);if(JSON.stringify(manifest)!==item.text||manifest.version!==1||manifest.purpose!=='reverie-plan-generation-v1')no();const material=object(manifest.material,['version','purpose','operationId','sessionId','provider','accountId','authDigest','context']);if(material.version!==1||material.purpose!=='reverie-plan-material-v1'||material.operationId!==operation||material.provider!==provider||material.accountId!==accountId||!uuid.test(material.sessionId||'')||!hex.test(material.authDigest||'')||hash(canonical(material))!==projection)no();if(!hex.test(historicalContextDigest||'')||hash(JSON.stringify(manifest.context))!==historicalContextDigest)no();object(manifest.context,['roles','conversationDigest']);if(!Array.isArray(manifest.context.roles)||manifest.context.roles.length>5)no();for(const role of manifest.context.roles){object(role,['role','dev','ino']);if(!decimal.test(role.dev)||!decimal.test(role.ino))no();}const config=child(parent,provider==='anthropic'?'claude':'codex'),s=fs.fstatSync(config,{bigint:true});if(!decimal.test(accountDev||'')||!decimal.test(accountIno||'')||String(s.dev)!==accountDev||String(s.ino)!==accountIno)no();return{parent,manifest,material,config};}
function entries(parent){const names=fs.readdirSync('/proc/self/fd/'+parent);if(names.length>4096||names.some(n=>!component(n)))no();return names.sort();}
function context(rootFd,source){
 const history=provider==='anthropic'?'projects':'sessions',role=provider==='anthropic'?'claude-projects':'codex-sessions';
 const top=child(rootFd,history),found=[];let visited=0;
 function search(fd,relative,depth){if(depth>12||++visited>4096)no();for(const name of entries(fd)){
  const path='/proc/self/fd/'+fd+'/'+name,s=fs.lstatSync(path,{bigint:true});
  if(s.isSymbolicLink())continue;
  if(s.isDirectory()){if(s.uid!==BigInt(process.getuid())||(s.mode&0o022n)!==0n)no();search(child(fd,name),relative.concat(name),depth+1);}
  else if(s.isFile()&&(provider==='anthropic'?name===nativeId+'.jsonl':name.endsWith('-'+nativeId+'.jsonl'))){const value=read(fd,name,512*1024*1024,false);found.push({nativeId,relative:relative.concat(name),sha256:value.sha256});if(found.length>1)no();}
 }}
 if(!uuid.test(nativeId||''))no();search(top,[history],0);if(found.length!==1)no();
 const roles=[role],instruction=provider==='anthropic'?'CLAUDE.md':'AGENTS.md';try{if(source.kind!=='home')throw Object.assign(Error(),{code:'ENOENT'});fs.lstatSync('/proc/self/fd/'+rootFd+'/'+instruction);read(rootFd,instruction,1024*1024,false);roles.push(provider==='anthropic'?'claude-instructions':'codex-instructions');}catch(e){if(e.code!=='ENOENT')throw e;}
 return{source,roles,conversation:found[0]};
}
try{
 if(process.argv.length!==13)no();
 if(fs.statfsSync('/proc').type!==0x9fa0||!decimal.test(homeDev||'')||!decimal.test(homeIno||'')||!['home','context','auth'].includes(mode)||!['anthropic','openai'].includes(provider))no();
 const status=fs.readFileSync('/proc/self/status','utf8');if(!/^NoNewPrivs:\s+1$/m.test(status)||!['CapInh','CapPrm','CapEff','CapAmb'].every(k=>new RegExp('^'+k+':\\s+0+$','m').test(status)))no();
 const home=root(HOME,homeDev,homeIno),homeStat=fs.fstatSync(home,{bigint:true});if((homeStat.mode&0o777n)!==0o700n)no();
 if(mode==='home')output={version:1,purpose:'reverie-plan-source-home-v1',homeDev,homeIno,uid:process.getuid(),gid:process.getgid()};
 else if(mode==='auth'){
  if(kind!=='generation')no();const g=generation(home),auth=json(g.config,provider==='anthropic'?'.credentials.json':'auth.json',128*1024,true);if(!auth.value||typeof auth.value!=='object'||Array.isArray(auth.value))no();output={version:1,purpose:'reverie-plan-source-auth-v1',operationId:operation,projectionDigest:projection,accountId,provider,installedAuthDigest:g.material.authDigest,observedAuthDigest:hash(auth.text),auth:auth.text};
 }else{
  let rootFd,source;
  if(kind==='legacy'){const relative=[provider==='anthropic'?'.claude':'.codex'];rootFd=walk(home,relative);const s=fs.fstatSync(rootFd,{bigint:true});source={kind:'home',relative,dev:String(s.dev),ino:String(s.ino)};}
  else if(kind==='account'){if(!decimal.test(accountDev||'')||!decimal.test(accountIno||''))no();rootFd=root(ACCOUNT,accountDev,accountIno);source={kind:'intake',dev:accountDev,ino:accountIno};}
  else if(kind==='generation'){
   const g=generation(home),m=g.material.context;if(!m||!m.source)no();
   if(m.source.kind==='home'){
    rootFd=walk(home,m.source.relative);const st=fs.fstatSync(rootFd,{bigint:true});if(String(st.dev)!==m.source.dev||String(st.ino)!==m.source.ino)no();
    const name=provider==='anthropic'?'projects':'sessions',expected='/home/agent/'+m.source.relative.join('/')+'/'+name;
    if(fs.readlinkSync('/proc/self/fd/'+g.config+'/'+name)!==expected)no();const history=child(rootFd,name),stHistory=fs.fstatSync(history,{bigint:true}),saved=g.manifest.context.roles.find(r=>r.role===(provider==='anthropic'?'claude-projects':'codex-sessions'));if(!saved||saved.dev!==String(stHistory.dev)||saved.ino!==String(stHistory.ino))no();source=m.source;
   }else if(m.source.kind==='intake'){
    rootFd=g.config;const history=child(rootFd,provider==='anthropic'?'projects':'sessions'),stHistory=fs.fstatSync(history,{bigint:true}),saved=g.manifest.context.roles.find(r=>r.role===(provider==='anthropic'?'claude-projects':'codex-sessions'));if(!saved||saved.dev!==String(stHistory.dev)||saved.ino!==String(stHistory.ino))no();const st=fs.fstatSync(rootFd,{bigint:true});source={kind:'home',relative:['.reverie','plan-moves',operation,'generation-'+projection,provider==='anthropic'?'claude':'codex'],dev:String(st.dev),ino:String(st.ino)};
   }else if(m.source.kind==='none'){
    if(!Array.isArray(g.manifest.context.roles)||g.manifest.context.roles.length!==0||g.manifest.context.conversationDigest!==null)no();
    rootFd=g.config;const st=fs.fstatSync(rootFd,{bigint:true});
    source={kind:'home',relative:['.reverie','plan-moves',operation,'generation-'+projection,provider==='anthropic'?'claude':'codex'],dev:String(st.dev),ino:String(st.ino)};
   }else no();
  }else no();
  output={version:1,purpose:'reverie-plan-source-context-v1',provider,context:context(rootFd,source)};
 }
 for(const check of checks)check();
}catch{output=undefined;}
let closeFailed=false;for(const fd of fds.reverse()){try{fs.closeSync(fd);}catch{closeFailed=true;}}
if(output===undefined||closeFailed){process.stderr.write('Source metadata refused or unconfirmed\n');process.exitCode=1;}else process.stdout.write(JSON.stringify(output)+'\n');
`;
