import {readFileSync} from 'node:fs';
import {afterEach,expect,it,vi} from 'vitest';
import {createHarness,room,member} from './helpers/chat-app-harness.mjs';
const src=readFileSync(new URL('../src/web/public/chat-app.js',import.meta.url),'utf8');
const origin='https://relay.example.test:8443',roomId='420a20cc-1288-4faa-8f45-b6f908cf4a20',requestId='d7f74718-8792-476d-a609-331da7c5611d',handle='a'.repeat(32),connectionId='bd2161d7-0c0e-41f8-83d2-c6c720c22ac2';
const qr=`embassy-v2|${origin}|${roomId}|${'A'.repeat(43)}`,requestQr=`embassy-pair-v1|${origin}|${requestId}|3BCD-5FGH`;
const opened:any[]=[];
afterEach(()=>{for(const h of opened.splice(0))h.dom.window.close();vi.restoreAllMocks();});
async function setup(){
 const h=await createHarness({loadShell:false,sessions:[{id:'local',name:'Local',mode:'claude'}],rooms:[room('r1','General',[member('local','Local')])]});opened.push(h);h.window.TextEncoder=TextEncoder;
 const calls:any[]=[],drawn:any[]=[],rows:any[]=[],state:any={host:'ready',pair:'pending',deny:false,createFailure:false,deleteFailure:false,guestResponse:null,lookupResponse:null,delayed:null,hostPosts:[]};
 const original=h.app._api;
 h.app._api=async(path:string,options:any={})=>{
  if(!/^\/api\/embassy-(guest|host|pairing)/.test(path))return original.call(h.app,path,options);
  calls.push({path,...options});let data:any;
  if(state.deny)return {ok:false,status:403,json:async()=>({success:false,error:{code:'OWNER_ONLY',message:'owner only'}})};
  if(path==='/api/embassy-guest')data={connections:rows};
  else if(path.startsWith('/api/embassy-guest/'))data={posts:[],next:0};
  else if(path.startsWith('/api/embassy-host/posts')){
   if(options.method==='POST'){const post={ackId:'b89a36db-b8a5-453f-95d2-198df41dd537',sequence:state.hostPosts.length+1,at:Date.now(),text:options.body.text,author:{company:'Host company',identity:'Owner'}};state.hostPosts.push(post);data={post};}
   else data={posts:state.hostPosts,next:state.hostPosts.length};
  }
  else if(path==='/api/embassy-host')data={status:state.host,origin,room:{id:roomId,name:'Shared room'}};
  else if(path==='/api/embassy-host/invites'&&options.method==='POST'){
   if(state.delayed)return state.delayed();
   if(state.createFailure)return {ok:false,status:502,json:async()=>({error:{code:'EMBASSY_UNREACHABLE'}})};
   data={inviteId:'invite1',qr,expiresAt:Date.now()+600000};
  }else if(path==='/api/embassy-host/invites')data=[];
  else if(path==='/api/embassy-host/lookup')data=state.lookupResponse||{requestId,state:'pending',guest:{company:'Other company',identity:'Student'},expiresAt:Date.now()+600000};
  else if(path==='/api/embassy-host/approve')data={state:'approved'};
  else if(path==='/api/embassy-host/reject')data={state:'rejected'};
  else if(path==='/api/embassy-pairing'&&options.method==='POST')data=state.guestResponse||{handle,origin,state:'pending',requestQr,code:'3BCD-5FGH',room:{id:roomId,name:'Shared room'},hostCompany:'Host company',expiresAt:Date.now()+600000};
  else if(path==='/api/embassy-pairing')data=[];
  else if(path==='/api/embassy-pairing/'+handle){
   if(options.method==='DELETE'){
    if(state.deleteFailure)return {ok:false,status:502,json:async()=>({error:{code:'EMBASSY_UNREACHABLE'}})};
    data={state:'cancelled'};
   }else data={state:state.pair,requestQr,code:'3BCD-5FGH',expiresAt:Date.now()+600000,...(state.pair==='connected'?{connectionId}:{})};
  }else throw Error('Unexpected fixture route '+path);
  return {ok:true,status:200,json:async()=>({success:true,data})};
 };
 h.window.eval(src);await h.flush(20);const view=h.window.reverieChat.embassy,pair=view.pairing;
 pair.showQR=async(value:string,label:string)=>{drawn.push(value);const c=h.document.createElement('canvas');c.setAttribute('aria-label',label);pair.body.append(c);};
 return {...h,view,pair,calls,drawn,rows,state,button:(name:string)=>[...h.document.querySelectorAll('button')].find((b:any)=>b.textContent===name) as HTMLButtonElement};
}

for(const state of ['pending','expired'])it('cancel renders the actual backend '+state+' state instead of inventing cancelled',async()=>{
 const h=await setup();await h.pair.open();h.pair.record={handle,state:'pending',origin,room:{id:roomId,name:'Shared'}};await h.pair.showRecord();
 vi.spyOn(h.pair,'api').mockResolvedValue({ok:true,data:{handle,state}});
 await h.pair.cancel();expect(h.pair.record.state).toBe(state);
});
it('a malformed successful DELETE is not confirmation of cancellation',async()=>{
 const h=await setup();await h.pair.open();h.pair.record={handle,state:'pending'};await h.pair.showRecord();
 vi.spyOn(h.pair,'api').mockResolvedValue({ok:true,data:{}});
 await h.pair.cancel();expect(h.pair.record.state).not.toBe('cancelled');
});
