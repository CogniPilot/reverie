import { DOCKER_PROVIDER_VIEW_ENV } from './docker-employee-provider-view-native.js';
import { dockerPlanGeneration, type DockerPlanGeneration } from './docker-plan-install-data.js';
/** Fixed credential observation. A pre-dispatch initial call removes only its
 * newly-created Codex bootstrap cache; live observation leaves caches intact.
 * Only the actor's selected generation earns context; stdout is never account material. */
import { z } from 'zod';
export const DOCKER_PLAN_ACCOUNT_STATUS_PROGRAM = String.raw`
'use strict';
const cp=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const held=[];
function refuse(){throw Error('Selected account observation changed');}
function identity(s){return [s.dev,s.ino,s.uid,s.gid,s.mode].map(String).join(':');}
function fileStamp(s){return [identity(s),String(s.size),String(s.mtimeNs),String(s.ctimeNs),String(s.nlink)];}
function named(fd,name){return '/proc/self/fd/'+fd+'/'+name;}
function directory(p){
 const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);held.push(fd);
 const stat=fs.fstatSync(fd,{bigint:true});if(!stat.isDirectory()||Number(stat.uid)!==process.getuid())refuse();
 return {fd,path:p,identity:identity(stat)};
}
function current(d){if(identity(fs.fstatSync(d.fd,{bigint:true}))!==d.identity||identity(fs.lstatSync(d.path,{bigint:true}))!==d.identity)refuse();}
function names(d){current(d);const n=fs.readdirSync('/proc/self/fd/'+d.fd).sort();if(n.length>16)refuse();return n;}
function absent(d,n){try{fs.lstatSync(named(d.fd,n));return false;}catch(e){if(e.code==='ENOENT')return true;throw e;}}
function snapshot(d){return names(d).map(n=>{const p=named(d.fd,n),s=fs.lstatSync(p,{bigint:true});if(!s.isFile()||s.nlink!==1n)refuse();return [n,identity(s),String(s.size),String(s.mtimeNs),String(s.ctimeNs)];});}
function initialConfig(){
 const p=process.env.CODEX_HOME;if(!p||!path.isAbsolute(p)||fs.realpathSync(p)!==p)refuse();
 const d=directory(p);if((Number(fs.fstatSync(d.fd).mode)&0o077)!==0||!absent(d,'tmp'))refuse();
 return {d,before:snapshot(d),executable:codexExecutable()};
}
function claudeProbeConfig(){
 const p=process.env.CLAUDE_CONFIG_DIR;if(!p||!path.isAbsolute(p)||fs.realpathSync(p)!==p)refuse();
 const d=directory(p);if((Number(fs.fstatSync(d.fd).mode)&0o077)!==0)refuse();
 const file=named(d.fd,'.credentials.json');
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);held.push(fd);
 const stat=fs.fstatSync(fd,{bigint:true}), before=JSON.stringify(fileStamp(stat));
 if(!stat.isFile()||Number(stat.uid)!==process.getuid()||stat.nlink!==1n||
    stat.size<=0n||stat.size>65536n||(Number(stat.mode)&0o077)!==0)refuse();
 const bytes=Buffer.alloc(Number(stat.size));
 const check=()=>{current(d);if(JSON.stringify(fileStamp(fs.fstatSync(fd,{bigint:true})))!==before||
    JSON.stringify(fileStamp(fs.lstatSync(file,{bigint:true})))!==before)refuse();};
 try{
  if(fs.readSync(fd,bytes,0,bytes.length,0)!==bytes.length)refuse();
  check();
  const scratch=directory(fs.mkdtempSync('/tmp/reverie-claude-auth-'));
  try{
   fs.writeFileSync(named(scratch.fd,'.credentials.json'),bytes,{flag:'wx',mode:0o600});
   return {scratch,check};
  }catch(e){current(scratch);fs.rmSync(scratch.path,{recursive:true});throw e;}
 }finally{bytes.fill(0);}
}
function codexExecutable(){
 const root=(process.env.REVERIE_DATA||'/instances/default')+'/tools/lib/node_modules/@openai/';
 const suffix='codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex';
 const options=[root+'codex/node_modules/@openai/'+suffix,root+suffix];
 const matches=options.filter(p=>{try{return fs.lstatSync(p).isFile();}catch(e){if(e.code==='ENOENT')return false;throw e;}});
 if(matches.length!==1)refuse();const p=fs.realpathSync(matches[0]);if(p!==matches[0])refuse();
 const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);held.push(fd);const s=fs.fstatSync(fd,{bigint:true});
 if(!s.isFile()||(Number(s.uid)!==0&&Number(s.uid)!==process.getuid())||(Number(s.mode)&0o022)!==0||(Number(s.mode)&0o111)===0)refuse();
 const magic=Buffer.alloc(4);if(fs.readSync(fd,magic,0,4,0)!==4||magic.toString('hex')!=='7f454c46')refuse();
 return {p,fd,stamp:fileStamp(s)};
}
function currentExecutable(e){if(JSON.stringify(fileStamp(fs.fstatSync(e.fd,{bigint:true})))!==JSON.stringify(e.stamp)||JSON.stringify(fileStamp(fs.lstatSync(e.p,{bigint:true})))!==JSON.stringify(e.stamp))refuse();}
function currentLeaf(leaf){current(leaf.parent);const s=fs.lstatSync(leaf.p,{bigint:true});if(identity(s)!==leaf.identity||String(s.size)!==leaf.size||(leaf.link!==null&&fs.readlinkSync(leaf.p)!==leaf.link))refuse();}
function removeOwnedBootstrap(scope){
 const {d,before,executable}=scope;current(d);const after=names(d);if(JSON.stringify(after.filter(n=>n!=='tmp'))!==JSON.stringify(before.map(v=>v[0])))refuse();
 for(const value of before){const s=fs.lstatSync(named(d.fd,value[0]),{bigint:true});if(JSON.stringify([value[0],identity(s),String(s.size),String(s.mtimeNs),String(s.ctimeNs)])!==JSON.stringify(value))refuse();}
 currentExecutable(executable);if(absent(d,'tmp'))return;
 const tmp=directory(named(d.fd,'tmp')),dirs=[tmp],leaves=[];
 const top=names(tmp);if(top.length&&JSON.stringify(top)!=='["arg0-linux"]')refuse();
 if(top.length){const arg0=directory(named(tmp.fd,'arg0-linux'));dirs.push(arg0);
  for(const name of names(arg0)){
   if(!/^codex-arg0[A-Za-z0-9]{6}$/.test(name))refuse();
   const entry=directory(named(arg0.fd,name));dirs.push(entry);
   const files=names(entry);if(JSON.stringify(files)!=='[".lock","apply_patch","applypatch","codex-linux-sandbox"]')refuse();
   for(const file of files){const p=named(entry.fd,file),s=fs.lstatSync(p,{bigint:true});if(Number(s.uid)!==process.getuid()||s.nlink!==1n)refuse();
    if(file==='.lock'){if(!s.isFile()||s.size!==0n)refuse();}
    else if(!s.isSymbolicLink()||fs.readlinkSync(p)!==executable.p)refuse();
    leaves.push({p,parent:entry,identity:identity(s),size:String(s.size),link:s.isSymbolicLink()?fs.readlinkSync(p):null});
   }
  }
 }
 // Validate the entire newly-created tree before the first unlink. Never use recursive removal.
 current(d);for(const dir of dirs)current(dir);
 currentExecutable(executable);for(const leaf of leaves)currentLeaf(leaf);
 for(const leaf of leaves){currentLeaf(leaf);fs.unlinkSync(leaf.p);}
 for(const dir of dirs.reverse()){current(dir);if(names(dir).length)refuse();fs.rmdirSync(dir.path);}
 current(d);if(!absent(d,'tmp')||JSON.stringify(snapshot(d))!==JSON.stringify(before))refuse();
}
let claudeScope;
try{
 const provider=process.argv[1],initial=process.argv[2]==='initial';
 if(!['anthropic','openai'].includes(provider)||process.argv.length!==(initial?3:2))throw Error();
 const scope=provider==='openai'&&initial?initialConfig():undefined;
 if(provider==='anthropic')claudeScope=claudeProbeConfig();
 const args=provider==='anthropic'?['auth','status','--json']:['login','status'];
 const env=claudeScope?{...process.env,CLAUDE_CONFIG_DIR:claudeScope.scratch.path}:process.env;
 const result=cp.spawnSync(provider==='anthropic'?'claude':'codex',args,{env,encoding:'utf8',timeout:8000,maxBuffer:65536,windowsHide:true});
 if(result.error||result.signal||result.status!==0)throw Error();
 if(provider==='anthropic'){
  const value=JSON.parse(result.stdout);if(value?.loggedIn!==true||value.apiProvider!=='firstParty'||typeof value.authMethod!=='string'||!value.authMethod)throw Error();
  claudeScope.check();
  current(claudeScope.scratch);fs.rmSync(claudeScope.scratch.path,{recursive:true});claudeScope=undefined;
 }else if(!/^Logged in(?:\s|$)/i.test((result.stdout+'\n'+result.stderr).trim()))throw Error();
 if(scope)removeOwnedBootstrap(scope);
 process.stdout.write(JSON.stringify({version:1,purpose:'reverie-plan-account-status-v1',provider,authenticated:true})+'\n');
}catch{process.stderr.write('Native selected account status unconfirmed\n');process.exitCode=1;}
finally{
 if(claudeScope)try{current(claudeScope.scratch);fs.rmSync(claudeScope.scratch.path,{recursive:true});}catch{process.exitCode=1;}
 for(const fd of held.reverse())try{fs.closeSync(fd);}catch{process.exitCode=1;}
}
`;
export const DockerPlanAccountStatus = z
  .object({
    version: z.literal(1),
    purpose: z.literal('reverie-plan-account-status-v1'),
    provider: z.enum(['anthropic', 'openai']),
    authenticated: z.literal(true),
  })
  .strict();

/** Pure fixed argv DATA. The caller separately proves the current target. */
export function dockerPlanAccountStatusArguments(
  input: DockerPlanGeneration,
  readMode: 'initial' | 'live' = 'live'
): readonly string[] {
  const paths = dockerPlanGeneration(input);
  if (readMode !== 'initial' && readMode !== 'live') throw Error('Fixed account status mode required');
  return [
    'exec',
    ...DOCKER_PROVIDER_VIEW_ENV,
    '--env',
    (input.provider === 'anthropic' ? 'CLAUDE_CONFIG_DIR=' : 'CODEX_HOME=') + paths.configDir,
    '--workdir',
    '/',
    input.containerId,
    '/opt/reverie-worker-client/bin/node',
    '--no-global-search-paths',
    '--no-addons',
    '--input-type=commonjs',
    '-e',
    DOCKER_PLAN_ACCOUNT_STATUS_PROGRAM,
    '--',
    input.provider,
    ...(readMode === 'initial' ? ['initial'] : []),
  ];
}
