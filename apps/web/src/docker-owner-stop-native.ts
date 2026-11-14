/** Fixed common-HOME legacy fence protocol. Returned DATA is not an owner grant.
 * The Docker adapter separately owns source/image/configuration/record currency.
 * No shell, signal, process scan, arbitrary path, or deadline-as-settlement. */
import { DOCKER_PROVIDER_VIEW_ENV } from './docker-employee-provider-view-native.js';
export const DOCKER_OWNER_STOP_NODE = '/opt/reverie-worker-client/bin/node';
export const DOCKER_OWNER_STOP_NATIVE_TIMEOUT_MS = 8000;
export const DOCKER_OWNER_STOP_NATIVE_ENV: readonly string[] = Object.freeze([
  ...DOCKER_PROVIDER_VIEW_ENV.filter((_value, index) => index % 2 === 1),
  'HOME=/home/agent',
  'PATH=/bin',
]);
export interface DockerOwnerStopHomeAck {
  version: 1;
  purpose: 'reverie-owner-stop-home-v1';
  sessionId: string;
  sessionGeneration: number;
  sourceContainerId: string;
  homeDev: string;
  homeIno: string;
  uid: number;
  gid: number;
  mode: '0700';
}
export interface DockerOwnerStopFencedAck extends Omit<DockerOwnerStopHomeAck, 'purpose'> {
  purpose: 'reverie-owner-stop-fenced-v1';
  fenceSha256: string;
  outcome: 'fenced';
}
/** mode SID generation originalCID [expectedHOMEdev expectedHOMEino].
 * Only fence reads stdin: 32 lower hex bytes and at most one final newline.
 * observe-home must use a read-only HOME mount; fence uses the same HOME RW.
 * Files/directories are consumed once before ACK. Unknown effects stay held. */
export const DOCKER_OWNER_STOP_NATIVE_PROGRAM = String.raw`
const fs = require('node:fs');
const crypto = require('node:crypto');
const HOME = '/home/agent';
const owned = new Set();
const io = (fn, ...args) => new Promise((resolve, reject) => fn(...args, (error, value) => error ? reject(error) : resolve(value)));
const fail = () => { throw Error('Owner stop fence unavailable'); };
const timer = setTimeout(() => process.exit(1), ${DOCKER_OWNER_STOP_NATIVE_TIMEOUT_MS});
const stamp = s => [s.dev,s.ino,s.uid,s.gid,s.mode,s.nlink,s.size,s.mtimeNs,s.ctimeNs].join(':');
const directoryStamp = s => [s.dev,s.ino,s.uid,s.gid,s.mode].join(':');
const uid = process.getuid?.(), gid = process.getgid?.();
async function open(path, flags, mode) {
  const fd = await io(fs.open,path,flags,mode); owned.add(fd); return fd;
}
async function close(fd) {
  if (!owned.delete(fd)) fail();
  await io(fs.close,fd);
}
function directory(s) {
  if (!s.isDirectory() || s.uid!==BigInt(uid) || s.gid!==BigInt(gid) || (s.mode & 0o7777n)!==0o700n) fail();
}
async function currentDirectory(fd,path,expected) {
  const actual=await io(fs.fstat,fd,{bigint:true}), named=await io(fs.lstat,path,{bigint:true});
  directory(actual);directory(named);
  if(directoryStamp(actual)!==expected || directoryStamp(named)!==expected) fail();
}
function regular(s) {
  if (!s.isFile() || s.uid!==BigInt(uid) || s.gid!==BigInt(gid) || s.nlink<1n ||
    (s.mode & 0o7022n)!==0n || (s.mode & 0o111n)!==0n) fail();
}
// Stop markers are nonsecret protocol DATA. Retained own staging hardlinks
// may remain after interruption; credentials/keys never use this rule.
async function verifiedFile(fd,path) {
  const before=await io(fs.fstat,fd,{bigint:true});regular(before);if(before.size!==7n) fail();
  const content=Buffer.alloc(8);let offset=0;
  while(offset<content.length) { const n=await io(fs.read,fd,content,offset,content.length-offset,offset);if(n===0) break;offset+=n; }
  if(offset!==7 || !content.subarray(0,offset).equals(Buffer.from('fenced\n'))) fail();
  await io(fs.fsync,fd);
  const after=await io(fs.fstat,fd,{bigint:true}),named=await io(fs.lstat,path,{bigint:true});regular(after);regular(named);
  if(stamp(before)!==stamp(after) || stamp(named)!==stamp(after)) fail();
  return after;
}
async function readFence() {
  const bytes=Buffer.alloc(34);let count=0;
  for (;;) {
    const n=await io(fs.read,0,bytes,count,bytes.length-count,null);
    if(n===0) break;
    count+=n;if(count>33 || count===bytes.length) fail();
  }
  const text=bytes.subarray(0,count).toString('utf8');
  if(!/^[a-f0-9]{32}\n?$/.test(text)) fail();
  return text.slice(0,32);
}
(async()=>{
  try {
    if(!Number.isInteger(uid) || uid<=0 || !Number.isInteger(gid) || gid<0) fail();
    const [mode,sessionId,generation,sourceContainerId,expectedDev,expectedIno]=process.argv.slice(1);
    if(!['observe-home','fence'].includes(mode) || process.argv.length!==(mode==='fence'?7:5) ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(sessionId||'') ||
      !/^[1-9][0-9]{0,15}$/.test(generation||'') || !Number.isSafeInteger(Number(generation)) ||
      String(Number(generation))!==generation || !/^[a-f0-9]{64}$/.test(sourceContainerId||'')) fail();
    let fence;
    if(mode==='fence') {
      if(!/^(?:0|[1-9][0-9]*)$/.test(expectedDev||'') || !/^[1-9][0-9]*$/.test(expectedIno||'')) fail();
      fence=await readFence();
    }
    owned.add(0);await close(0);
    const home=await open(HOME,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    const homeStat=await io(fs.fstat,home,{bigint:true});directory(homeStat);
    const homeIdentity=directoryStamp(homeStat);
    await currentDirectory(home,HOME,homeIdentity);
    const base={version:1,purpose:'reverie-owner-stop-home-v1',sessionId,sessionGeneration:Number(generation),sourceContainerId,
      homeDev:String(homeStat.dev),homeIno:String(homeStat.ino),uid,gid,mode:'0700'};
    if(mode==='fence' && (base.homeDev!==expectedDev || base.homeIno!==expectedIno)) fail();
    let ack=base, directoryIdentity, fileIdentity;
    if(mode==='fence') {
      const homeRef='/proc/self/fd/'+home, dirPath=homeRef+'/.reverie-stop';
      try { await io(fs.mkdir,dirPath,{mode:0o700}); } catch(error) { if(error.code!=='EEXIST') throw error; }
      await currentDirectory(home,HOME,homeIdentity);
      const dir=await open(dirPath,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
      const dirStat=await io(fs.fstat,dir,{bigint:true});directory(dirStat);directoryIdentity=directoryStamp(dirStat);
      await currentDirectory(dir,dirPath,directoryIdentity);
      const leaf='reverie-stop-'+fence, filePath='/proc/self/fd/'+dir+'/'+leaf;
      let file;
      try { file=await open(filePath,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK); }
      catch(error) {
        if(error.code!=='ENOENT') throw error;
        // Complete + close a unique private staging file before no-overwrite
        // publication. Orphans never obstruct another attempt and are retained.
        const stagePath='/proc/self/fd/'+dir+'/.fenced-stage-'+crypto.randomBytes(16).toString('hex');
        const stage=await open(stagePath,fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
        const freshStage=await io(fs.fstat,stage,{bigint:true});regular(freshStage);if(freshStage.nlink!==1n) fail();
        const data=Buffer.from('fenced\n');let offset=0;
        while(offset<data.length) { const n=await io(fs.write,stage,data,offset,data.length-offset,offset);if(n<=0) fail();offset+=n; }
        const complete=await verifiedFile(stage,stagePath);if(complete.nlink!==1n) fail();
        await close(stage);
        if(stamp(await io(fs.lstat,stagePath,{bigint:true}))!==stamp(complete)) fail();
        await currentDirectory(dir,dirPath,directoryIdentity);await currentDirectory(home,HOME,homeIdentity);
        let published=false;
        try { await io(fs.link,stagePath,filePath);published=true; }
        catch(linkError) { if(linkError.code!=='EEXIST') throw linkError; }
        await io(fs.fsync,dir);
        file=await open(filePath,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
        const actual=await io(fs.fstat,file,{bigint:true});
        if(published && (actual.dev!==complete.dev || actual.ino!==complete.ino)) fail();
      }
      const final=await verifiedFile(file,filePath);fileIdentity=stamp(final);
      await currentDirectory(dir,dirPath,directoryIdentity);await currentDirectory(home,HOME,homeIdentity);
      await close(file);
      if(stamp(await io(fs.lstat,filePath,{bigint:true}))!==fileIdentity) fail();
      await io(fs.fsync,dir);await currentDirectory(dir,dirPath,directoryIdentity);
      await close(dir);
      await io(fs.fsync,home);await currentDirectory(home,HOME,homeIdentity);
      ack={...base,purpose:'reverie-owner-stop-fenced-v1',fenceSha256:crypto.createHash('sha256').update(fence).digest('hex'),outcome:'fenced'};
    }
    await currentDirectory(home,HOME,homeIdentity);await close(home);
    const finalHome=await io(fs.lstat,HOME,{bigint:true});directory(finalHome);if(directoryStamp(finalHome)!==homeIdentity) fail();
    if(mode==='fence') {
      const finalDir=await io(fs.lstat,HOME+'/.reverie-stop',{bigint:true});directory(finalDir);
      const finalFile=await io(fs.lstat,HOME+'/.reverie-stop/reverie-stop-'+fence,{bigint:true});regular(finalFile);
      if(directoryStamp(finalDir)!==directoryIdentity || stamp(finalFile)!==fileIdentity) fail();
    }
    if(owned.size!==0) fail();
    const output=Buffer.from(JSON.stringify(ack)+'\n');let offset=0;
    while(offset<output.length) { const n=await io(fs.write,1,output,offset,output.length-offset,null);if(n<=0) fail();offset+=n; }
    clearTimeout(timer);
  } catch {
    for(const fd of [...owned]) { owned.delete(fd);try { await io(fs.close,fd); } catch {} }
    clearTimeout(timer);process.stderr.write('Owner stop fence not confirmed\n');process.exitCode=1;
  }
})();
`;
