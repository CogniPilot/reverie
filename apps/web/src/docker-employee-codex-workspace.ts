/** Fixed read-only observation and last-moment cwd verification. No trust or launch grant. */
export const DOCKER_CODEX_WORKSPACE_PROGRAM = String.raw`
'use strict';
const fs = require('node:fs');
const { constants: C } = fs;
const args = process.argv.slice(1);
const fail = () => { throw Error('Managed Docker workspace changed'); };
const valid = p => typeof p === 'string' && p.startsWith('/') && !/[\0\r\n]/.test(p) && !p.split('/').includes('..') && p.length <= 4096;
const identity = s => ({ dev: String(s.dev), ino: String(s.ino) });
const same = (a,b) => a.dev === b.dev && a.ino === b.ino && a.isDirectory() === b.isDirectory();
const opened = [];
const open = (p, flags) => { const fd=fs.openSync(p,flags); opened.push(fd); return fd; };
const close = fd => { const i=opened.indexOf(fd); if(i<0) fail(); opened.splice(i,1); fs.closeSync(fd); };
let output;
try {
 if(fs.statfsSync('/proc').type!==0x9fa0) fail();
 if(args[0] === 'verify') {
  if(args.length !== 4 || !valid(args[1]) || !/^[0-9]{1,20}$/.test(args[2]) || !/^[1-9][0-9]{0,19}$/.test(args[3])) fail();
  const fd=open('.', C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);
  const s=fs.fstatSync(fd,{bigint:true}); if(String(s.dev)!==args[2] || String(s.ino)!==args[3] || fs.realpathSync('.')!==args[1]) fail();
  close(fd);
 } else if(args[0] === 'observe') {
  if(args.length !== 3 || !valid(args[1]) || !valid(args[2])) fail();
  const real=fs.realpathSync(args[1]), root=fs.realpathSync(args[2]);
  if(root!==args[2] || !(real===root || real.startsWith(root==='/' ? '/' : root+'/'))) fail();
  const fd=open(real,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW), before=fs.fstatSync(fd,{bigint:true});
  let hooksText=null, hooksFd, hooksDir;
  try { hooksDir=open('/proc/self/fd/'+fd+'/.codex',C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW); }
  catch(error) { if(error.code!=='ENOENT') throw error; }
  if(hooksDir!==undefined) {
   try { hooksFd=open('/proc/self/fd/'+hooksDir+'/hooks.json',C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK); }
   catch(error) { if(error.code!=='ENOENT') throw error; }
   if(hooksFd!==undefined) {
    const start=fs.fstatSync(hooksFd,{bigint:true});
    if(!start.isFile() || start.size>1048576n) fail();
    const bytes=Buffer.alloc(1048577); let total=0,n;
    while((n=fs.readSync(hooksFd,bytes,total,bytes.length-total,null))>0) { total+=n; if(total>1048576) fail(); }
    const end=fs.fstatSync(hooksFd,{bigint:true}), named=fs.lstatSync('/proc/self/fd/'+hooksDir+'/hooks.json',{bigint:true});
    if(start.dev!==end.dev || start.ino!==end.ino || start.size!==end.size || start.mtimeNs!==end.mtimeNs || start.ctimeNs!==end.ctimeNs || end.dev!==named.dev || end.ino!==named.ino || !named.isFile() || named.isSymbolicLink()) fail();
    hooksText=bytes.subarray(0,total).toString('utf8');
    if(!Buffer.from(hooksText).equals(bytes.subarray(0,total))) fail();
    close(hooksFd);
   }
   const dirAfter=fs.lstatSync('/proc/self/fd/'+fd+'/.codex',{bigint:true});
   if(!same(fs.fstatSync(hooksDir,{bigint:true}),dirAfter) || dirAfter.isSymbolicLink()) fail();
   close(hooksDir);
  }
  if(!same(before,fs.fstatSync(fd,{bigint:true})) || !same(before,fs.lstatSync(real,{bigint:true})) || fs.realpathSync(args[1])!==real) fail();
  output={ realPath:real, ...identity(before), hooksText };
  close(fd);
 } else fail();
 for(const fd of [...opened].reverse()) close(fd);
 if(output) process.stdout.write(JSON.stringify(output));
} catch { for(const fd of [...opened].reverse()) { try {close(fd);} catch {} } process.exitCode=1; }
`;
export interface DockerCodexWorkspace {
  readonly realPath: string;
  readonly dev: string;
  readonly ino: string;
  readonly hooksText: string | null;
}
