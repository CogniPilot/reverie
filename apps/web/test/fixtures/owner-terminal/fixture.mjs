// OWNED TEST ONLY: actual accepted Authority with controlled session/native ports.
import fs from 'node:fs';
import readline from 'node:readline';
import {OwnerLaptopTerminalAuthority} from './dist/owner-laptop-terminal-authority.js';
import {OwnerLedgerBridge} from './dist/owner-ledger-bridge.js';
import {connectOwnerTerminal} from './fixture-connect.mjs';
const target=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
let owner=true, observerCount=0;
const authority=new OwnerLaptopTerminalAuthority({
 verifiedOwner:()=>owner,
 officeAuth:{session:()=>owner?{restricted:false,role:'owner'}:undefined,
  identity:()=>owner?{id:'owner',username:'Owned fixture',role:'owner',primary:true}:undefined},
 ingress:{externalOrigin:'https://owner.test',assertRequestBinding:()=>undefined},
 observeLaptop:async()=>{observerCount++;return {...target};},
 protectedChannel:{assertCurrent:async()=>undefined},
});
const request={headers:{origin:'https://owner.test',host:'owner.test'},cookies:{reverie_owner:'OWNED_FIXTURE_ONLY'}};
const sock=await connectOwnerTerminal();
let lastCommand;
const write=sock.write.bind(sock);
sock.write=(...args)=>{const raw=args[0];if(Buffer.isBuffer(raw)&&raw.length>4){try{if(JSON.parse(raw.subarray(4).toString()).kind==='command')lastCommand=Buffer.from(raw);}catch{}}return write(...args);};
const bridge=new OwnerLedgerBridge(sock,authority);
console.log(JSON.stringify({event:'ready'}));
const lines=readline.createInterface({input:process.stdin});
lines.on('line',line=>{
 const message=JSON.parse(line);
 if(message.control){
  if(message.control==='owner-off')owner=false;
  if(message.control==='shutdown')authority.shutdown();
  if(message.control==='new-incarnation')target.containerId='2'.repeat(64);
  if(message.control==='replay')write(lastCommand);
  if(message.control==='forged-owner'){
   const body=Buffer.from(JSON.stringify({kind:'command',n:1,operationId:'11111111-1111-4111-8111-111111111111',action:'issue',handle:'22222222-2222-4222-8222-222222222222',employeeId:target.employeeId,cols:80,rows:24,lifetimeSeconds:30,owner:true,scopeDigest:'a'.repeat(64)}));
   const head=Buffer.alloc(4);head.writeUInt32BE(body.length);write(Buffer.concat([head,body]));
  }
  if(message.control==='oversize'){const head=Buffer.alloc(4);head.writeUInt32BE(8193);write(head);}
  if(message.control==='truncated'){write(Buffer.from([0,0]));sock.end();}
  if(message.control==='close')bridge.close();
  console.log(JSON.stringify({event:'control',control:message.control}));return;
 }
 void(async()=>{
  try{
   let value;
   if(message.action==='issue')value=await bridge.issue(request,target.employeeId,80,24,30);
   else value=await bridge.metadata(request,message.reference,message.action==='revoke');
   console.log(JSON.stringify({event:'result',value,observerCount}));
  }catch(error){console.log(JSON.stringify({event:'error',state:error.state??'refused',observerCount}));}
 })();
});
