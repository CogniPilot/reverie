/** Isolated real owner-auth/chat source; no production server or cookie. Inert import. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {parseArgs} from 'node:util';
import {pathToFileURL,fileURLToPath} from 'node:url';
import readline from 'node:readline';

const sha=raw=>createHash('sha256').update(raw).digest('hex');
export async function run(){
  const {values}=parseArgs({options:{'owned-fixture':{type:'boolean'},root:{type:'string'},pins:{type:'string'},'pins-sha256':{type:'string'}}});
  assert(values['owned-fixture']&&/^[a-f0-9]{64}$/.test(values['pins-sha256']||''));
  const raw=fs.readFileSync(values.pins);assert.equal(sha(raw),values['pins-sha256']);const pins=JSON.parse(raw);
  const root=fs.realpathSync(values.root),st=fs.statSync(root);
  assert(st.isDirectory()&&st.uid===process.getuid()&&(st.mode&0o777)===0o700);
  assert(/^cancel-fixture-[a-f0-9]{32}$/.test(path.basename(root)));
  assert.equal(process.env.HOME,path.join(root,'home'));assert.equal(process.env.REVERIE_DATA_DIR,path.join(root,'instance'));
  assert.equal(process.env.REVERIE_ADMIN_PHONE_WAKE,'enabled');
  const allowed=new Set(['HOME','PATH','LANG','REVERIE_DATA_DIR','REVERIE_ADMIN_PHONE_WAKE','REVERIE_OWNER_CODING_EVIDENCE']);
  assert(Object.keys(process.env).every(key=>allowed.has(key)));
  const pkg=pins.console;assert(pkg.startsWith('/nix/store/')&&fs.realpathSync(pkg)===pkg);
  const dist=path.join(pkg,'lib/reverie/dist');
  for(const[name,digest]of Object.entries(pins.consoleModules)){
    assert(/^[a-zA-Z0-9_./-]+\.js$/.test(name)&&!name.split('/').includes('..'));
    assert.equal(sha(fs.readFileSync(path.join(dist,name))),digest,name);
  }
  const load=name=>import(pathToFileURL(path.join(dist,name)));const require=createRequire(path.join(pkg,'lib/reverie/package.json'));
  const Fastify=require('fastify'),cookie=require('@fastify/cookie');
  const {isCapabilityRequest}=await load('web/middleware/auth.js');
  const {OwnerAuthStore}=await load('owner-auth/store.js'),{OwnerAuthService}=await load('owner-auth/service.js');
  const {registerOwnerPolicy,OWNER_COOKIE}=await load('owner-auth/policy.js'),{registerOwnerRoutes}=await load('owner-auth/routes.js');
  const {ownerVerifier}=await load('owner-auth/marks.js');
  const {ChatroomService}=await load('chatroom-service.js'),{registerChatroomRoutes}=await load('web/routes/chatroom-routes.js');
  const {ChatFileStore}=await load('chatroom-files.js'),{agentMessage}=await load('chatroom-agent-message.js');
  const sid=randomUUID();
  // This logical polling member uses its actual connected parent consumer PID.
  // It remains a controlled fixture port, not native agent
  // authentication or a launched employee. No title/pid grants owner authority.
  const member={id:sid,name:'Cancellation fixture',mode:'hands',pid:process.ppid,status:'idle'};
  const sessions=new Map([[sid,member]]),ctx={sessions};
  const app=Fastify();await app.register(cookie);
  const owner=new OwnerAuthService({store:new OwnerAuthStore(path.join(root,'owner-auth.json')),auditFile:path.join(root,'owner-audit.jsonl'),setupEnabled:true});
  const relations={known:id=>sessions.has(id),related:(a,b)=>a===b,coordinated:()=>false,upward:()=>false,keeper:()=>false,admin:()=>false};
  registerOwnerPolicy(app,{service:owner,ctx,relations,isCapabilityRequest:req=>isCapabilityRequest(req,'')});registerOwnerRoutes(app,owner,false);
  const verified=ownerVerifier({service:owner,ctx});
  const service=new ChatroomService({file:path.join(root,'instance','chatrooms.json'),getSession:id=>sessions.get(id),broadcast:()=>{}});
  await service.init();
  registerChatroomRoutes(app,ctx,service,new ChatFileStore(path.join(root,'files')),verified,undefined,()=>undefined,
    {human:req=>owner.identity(req.cookies?.[OWNER_COOKIE]),messageOwner:id=>owner.isMessageOwner(id)});
  await app.ready();
  const secret='Fixture-'+randomBytes(24).toString('hex');
  const browser={host:'localhost',origin:'http://localhost'};
  const setup=await app.inject({method:'POST',url:'/api/owner/setup',headers:browser,payload:{username:'fixture-owner',password:secret,confirmation:secret}});
  assert.equal(setup.statusCode,200);const cookieValue=setup.cookies.find(c=>c.name===OWNER_COOKIE)?.value;assert(cookieValue);
  const headers={...browser,cookie:OWNER_COOKIE+'='+cookieValue};
  const create=async name=>{
    const response=await app.inject({method:'POST',url:'/api/chatrooms',headers,payload:{name,members:[{sessionId:sid}]}});
    assert.equal(response.statusCode,200);return response.json().data.id;
  };
  const room=await create('Owned cancellation fixture'),foreign=await create('Foreign fixture scope');
  const permitted=new Set([room,foreign]);
  const canonical=(selected,message)=>agentMessage(message,service.phoneAccepts(sid,selected,message.id),id=>owner.isMessageOwner(id));
  const reply=value=>process.stdout.write(JSON.stringify(value)+'\n');
  reply({ok:true,binding:{roomId:room,foreignRoomId:foreign,sessionId:sid,ownerSetup:true,logicalPollingFixture:true}});
  try{
    const input=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
    for await(const line of input){
      assert(Buffer.byteLength(line)<=65536);const request=JSON.parse(line);assert(typeof request.op==='string');
      if(request.op==='close'){assert.deepEqual(Object.keys(request),['op']);reply({ok:true});break;}
      if(request.op==='rooms'){
        assert.deepEqual(Object.keys(request),['op']);
        reply({ok:true,rooms:service.rooms().filter(r=>!r.archivedAt&&r.members.some(m=>m.sessionId===sid)).map(r=>({id:r.id}))});continue;
      }
      assert(permitted.has(request.roomId));
      if(request.op==='owner-post'||request.op==='anonymous-post'){
        assert.deepEqual(Object.keys(request).sort(),['op','roomId','text']);assert(typeof request.text==='string'&&request.text.length<=500);
        const response=await app.inject({method:'POST',url:'/api/chatrooms/'+request.roomId+'/messages',
          headers:request.op==='owner-post'?headers:browser,payload:{text:request.text}});
        if(request.op==='anonymous-post'){assert([401,403].includes(response.statusCode));reply({ok:true,status:response.statusCode});continue;}
        assert.equal(response.statusCode,200);const message=response.json().data.message;
        reply({ok:true,message:canonical(request.roomId,message)});
      }else if(request.op==='read'){
        assert.deepEqual(Object.keys(request).sort(),['op','roomId']);
        const selected=service.rooms().find(r=>r.id===request.roomId);assert(selected);
        const view=service.view(selected,{limit:100});
        reply({ok:true,messages:view.messages.map(m=>canonical(request.roomId,m)),members:view.members});
      }else if(request.op==='exact'){
        assert.deepEqual(Object.keys(request).sort(),['messageId','op','roomId']);
        const value=service.exactAgentRead(sid,request.roomId,request.messageId);
        reply({ok:true,message:canonical(request.roomId,value.message)});
      }else if(request.op==='agent-post'){
        assert.deepEqual(Object.keys(request).sort(),['op','replyTo','roomId','text']);
        assert(typeof request.text==='string'&&request.text.length<=3000);
        const message=service.post(request.roomId,{kind:'agent',sessionId:sid,name:member.name},request.text,'all',{replyTo:request.replyTo||undefined});
        reply({ok:true,message:canonical(request.roomId,message)});
      }else throw Error('unknown fixed fixture operation');
    }
  }finally{await service.stop();await app.close();process.stdin.destroy();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assert.equal(process.argv[2],'--owned-fixture');await run();
}
