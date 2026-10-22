import {readFileSync} from 'node:fs';
import {afterEach,expect,it,vi} from 'vitest';
import {createHarness,room,member} from './helpers/chat-app-harness.mjs';
const src=readFileSync(new URL('../src/web/public/chat-app.js',import.meta.url),'utf8');
const origin='https://relay.example.test:8443',roomId='00000012-0017-4000-8000-000000000020',requestId='00000041-0051-4000-8000-000000000078',handle='a'.repeat(32),connectionId='0000003a-0048-4000-8000-000000000069';
const qr=`embassy-v2|${origin}|${roomId}|${'A'.repeat(43)}`,requestQr=`embassy-pair-v1|${origin}|${requestId}|3BCD-5FGH`;
const opened:any[]=[];
afterEach(()=>{for(const h of opened.splice(0))h.dom.window.close();vi.restoreAllMocks();});
async function setup(emptyLocal=false){
 const h=await createHarness({loadShell:false,sessions:[{id:'local',name:'Local',mode:'claude'}],rooms:emptyLocal?[]:[room('r1','General',[member('local','Local')])]});opened.push(h);h.window.TextEncoder=TextEncoder;
 const calls:any[]=[],drawn:any[]=[],rows:any[]=[],state:any={host:'ready',pair:'pending',deny:false,createFailure:false,deleteFailure:false,guestResponse:null,lookupResponse:null,delayed:null,hostPosts:[]};
 const original=h.app._api;
 h.app._api=async(path:string,options:any={})=>{
  if(!/^\/api\/embassy-(guest|host|pairing)/.test(path))return original.call(h.app,path,options);
  calls.push({path,...options});let data:any;
  if(state.deny)return {ok:false,status:403,json:async()=>({success:false,error:{code:'OWNER_ONLY',message:'owner only'}})};
  if(path==='/api/embassy-guest')data={connections:rows};
  else if(path.startsWith('/api/embassy-guest/'))data={posts:[],next:0};
  else if(path.startsWith('/api/embassy-host/posts')){
   if(options.method==='POST'){const post={ackId:'00000036-0041-4000-8000-00000000005d',sequence:state.hostPosts.length+1,at:Date.now(),text:options.body.text,author:{company:'Host company',identity:'Owner'}};state.hostPosts.push(post);data={post};}
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
    data={handle,state:'cancelled'};
   }else data={handle,state:state.pair,requestQr,code:'3BCD-5FGH',expiresAt:Date.now()+600000,...(state.pair==='connected'?{connectionId}:{})};
  }else throw Error('Unexpected fixture route '+path);
  return {ok:true,status:200,json:async()=>({success:true,data})};
 };
 h.window.eval(src);await h.flush(20);const view=h.window.reverieChat.embassy,pair=view.pairing;
 pair.showQR=async(value:string,label:string)=>{drawn.push(value);const c=h.document.createElement('canvas');c.setAttribute('aria-label',label);pair.body.append(c);};
 return {...h,view,pair,calls,drawn,rows,state,button:(name:string)=>[...h.document.querySelectorAll('button')].find((b:any)=>b.textContent===name) as HTMLButtonElement};
}
it('the single sidebar plus opens the owner Invite/Join flow and existing-key fallback stays secondary',async()=>{
 const h=await setup();h.document.querySelector('[aria-label="Add embassy channel"]').click();await h.flush(20);
 expect(h.document.querySelectorAll('.eg-category')).toHaveLength(1);expect(h.document.querySelector('[data-key="page:embassies"]')).toBeNull();
 expect(h.button('Invite a company')).toBeTruthy();expect(h.button('Join a company')).toBeTruthy();expect(h.document.querySelector('.eg-pair-fallback')?.tagName).toBe('DETAILS');
 expect(h.calls.filter(c=>c.method==='POST')).toHaveLength(0);
});
it('unconfigured hosting and company labels cannot enable hosted authority',async()=>{
 const h=await setup();h.state.host='unconfigured';h.window.ReverieI18n={displayName:'Owner company'};await h.pair.open();
 expect(h.button('Invite a company').disabled).toBe(true);expect(h.button('Join a company').disabled).toBe(false);
 await h.pair.createInvite();expect(h.calls.filter(c=>c.path.endsWith('/invites')&&c.method==='POST')).toHaveLength(0);
});
it('owner Invite creates QR1 locally without exposing its token as text or storing it',async()=>{
 const h=await setup();await h.pair.open();await h.pair.createInvite();expect(h.drawn).toEqual([qr]);expect(h.document.body.textContent).not.toContain('A'.repeat(43));
 expect(JSON.stringify({...h.window.localStorage,...h.window.sessionStorage})).not.toContain('A'.repeat(43));
 const call=h.calls.find(c=>c.path==='/api/embassy-host/invites'&&c.method==='POST');expect(call.body).toEqual({clientRequestId:expect.any(String)});
});
it('an uncertain host invitation retries the same operation while a fresh owner intent gets a new id',async()=>{
 const h=await setup();await h.pair.open();h.state.createFailure=true;await h.pair.createInvite();h.state.createFailure=false;await h.pair.createInvite();
 let calls=h.calls.filter(c=>c.path==='/api/embassy-host/invites'&&c.method==='POST');expect(calls[0].body).toEqual(calls[1].body);
 h.pair.home();await h.pair.createInvite();calls=h.calls.filter(c=>c.path==='/api/embassy-host/invites'&&c.method==='POST');expect(calls[2].body.clientRequestId).not.toBe(calls[0].body.clientRequestId);
});
it('the first scan creates pending only, shows public confirmation and never opens chat or posts',async()=>{
 const h=await setup();await h.pair.open();h.pair.scan('invite');const open=vi.spyOn(h.view,'open');await h.pair.join(qr,h.document.querySelector('.eg-pair-status'));
 expect(h.document.querySelector('.eg-pair-status').textContent).toBe('Waiting for host approval');expect(h.drawn).toEqual([requestQr]);expect(open).not.toHaveBeenCalled();
 expect(h.view.selected).toBeNull();expect(h.calls.filter(c=>/\/posts/.test(c.path))).toHaveLength(0);expect(h.server.posts).toHaveLength(0);
 expect(h.pair.pollTimer).toBeTruthy();expect(JSON.stringify({...h.window.localStorage,...h.window.sessionStorage})).not.toContain(qr);
});
it('only an authorized connected result with a real connection-store entry opens the existing room',async()=>{
 const h=await setup();await h.pair.open();h.pair.scan('invite');await h.pair.join(qr,h.document.querySelector('.eg-pair-status'));
 const open=vi.spyOn(h.view,'open');h.state.pair='approved';await h.pair.poll();expect(open).not.toHaveBeenCalled();
 h.state.pair='connected';await h.pair.poll();expect(open).not.toHaveBeenCalled();
 h.rows.push({id:connectionId,origin,roomId,roomName:'Shared room',hostCompany:'Host company',enabled:true,status:'live',expiresAt:Date.now()+600000});
 await h.pair.poll();expect(open).toHaveBeenCalledWith(connectionId);expect(h.view.selected).toBe(connectionId);
});
it('invalid QR1 and a confirmation for another host never reach the network',async()=>{
 const h=await setup();await h.pair.open();h.pair.scan('invite');await h.pair.join(qr.replace('embassy-v2','embassy-v1'),h.document.querySelector('.eg-pair-status'));
 expect(h.calls.filter(c=>c.path==='/api/embassy-pairing'&&c.method==='POST')).toHaveLength(0);
 h.pair.scan('request');await h.pair.lookup(requestQr.replace(origin,'https://other.example.test'),h.document.querySelector('.eg-pair-status'));
 expect(h.calls.filter(c=>c.path.endsWith('/lookup'))).toHaveLength(0);
});
it('host lookup shows server-returned labels and the exact request is approved only by an explicit owner action',async()=>{
 const h=await setup();await h.pair.open();h.pair.scan('request');await h.pair.lookup(requestQr,h.document.querySelector('.eg-pair-status'));
 expect(h.document.querySelector('.eg-pair-guest').textContent).toBe('Student from Other company');expect(h.calls.filter(c=>c.path.endsWith('/approve'))).toHaveLength(0);
 await h.pair.decide('approve');expect(h.calls.find(c=>c.path.endsWith('/approve')).body).toEqual({requestId,code:'3BCD-5FGH'});
});
it('code fallback uses the same scoped lookup and mismatched request responses cannot be approved',async()=>{
 const h=await setup();await h.pair.open();h.pair.scan('request');await h.pair.lookup('3bcd5fgh',h.document.querySelector('.eg-pair-status'));expect(h.calls.find(c=>c.path.endsWith('/lookup')).body).toEqual({code:'3BCD-5FGH'});
 h.pair.scan('request');h.state.lookupResponse={requestId:roomId,state:'pending',guest:{company:'Other',identity:'Wrong'},expiresAt:Date.now()+600000};await h.pair.lookup(requestQr,h.document.querySelector('.eg-pair-status'));
 expect(h.button('Approve connection')).toBeUndefined();expect(h.pair.review).toBeNull();
});
it('owner denial fences a late invitation response and clears transient private UI',async()=>{
 const h=await setup();await h.pair.open();let release:any;h.state.delayed=()=>new Promise(r=>release=r);const create=h.pair.createInvite();await h.flush(2);
 h.state.deny=true;await h.pair.api('/api/embassy-host');release({ok:true,status:200,json:async()=>({success:true,data:{inviteId:'i',qr,expiresAt:Date.now()+600000}})});await create;
 expect(h.drawn).toEqual([]);expect(h.document.body.textContent).not.toContain('A'.repeat(43));expect(h.pair.owner).toBe(false);expect(h.pair.invite).toBeNull();
});
it('Cancel is not optimistic and expired/declined/revoked states cannot open a room',async()=>{
 const h=await setup();await h.pair.open();h.pair.scan('invite');await h.pair.join(qr,h.document.querySelector('.eg-pair-status'));
 h.state.deleteFailure=true;await h.pair.cancel();expect(h.pair.record.state).toBe('pending');h.state.deleteFailure=false;await h.pair.cancel();expect(h.pair.record.state).toBe('cancelled');
 const open=vi.spyOn(h.view,'open');for(const state of ['expired','rejected','revoked','pending','approved'])await h.pair.openConnected({state,connectionId});expect(open).not.toHaveBeenCalled();
});
it('a late camera grant after closing is stopped and does not trigger a request',async()=>{
 const h=await setup();await h.pair.open();h.pair.scan('invite');let grant:any;const stop=vi.fn();Object.defineProperty(h.window.navigator,'mediaDevices',{value:{getUserMedia:()=>new Promise(r=>grant=r)},configurable:true});
 const capture=h.pair.camera(h.document.querySelector('.eg-pair-status'),vi.fn());h.pair.close();grant({getTracks:()=>[{stop}]});await capture;expect(stop).toHaveBeenCalledOnce();expect(h.pair.stream).toBeNull();
});
it('pending status polling pauses while the document is hidden',async()=>{
 const h=await setup();await h.pair.open();h.pair.record={handle,state:'pending'};Object.defineProperty(h.document,'hidden',{value:true,configurable:true});const n=h.calls.length;await h.pair.poll();expect(h.calls).toHaveLength(n);
});

it('explicit hosted-room authority opens the shared feed and posts through host routes only',async()=>{
 const h=await setup();expect(h.view.hostedConnection().roomId).toBe(roomId);expect(h.view.hostedConnection().origin).toBe(origin);
 h.view.open('__host__');await h.flush(10);expect(h.view.status.textContent).toBe('Hosted here');expect(h.button('Disconnect')).toBeUndefined();
 h.view.input.value='Hello from host';await h.view.publish();expect(h.state.hostPosts).toHaveLength(1);expect(h.calls.filter(c=>c.path==='/api/embassy-host/posts'&&c.method==='POST')).toHaveLength(1);expect(h.server.posts).toHaveLength(0);expect(h.calls.filter(c=>c.path.startsWith('/api/embassy-guest/__host__'))).toHaveLength(0);
});
it('a guest connection cannot forge the reserved hosted-room identity',async()=>{
 const h=await setup();h.state.host='unconfigured';h.rows.push({id:'__host__',origin,roomId,roomName:'Forged host',enabled:true,status:'live'});await h.view.refresh();
 expect(h.view.hostedConnection()).toBeNull();expect(h.view.connections.some(c=>c.id==='__host__')).toBe(false);h.view.open('__host__');expect(h.view.selected).toBeNull();
});

it('host rebinding clears cached authority and namespaces browser history',async()=>{
 const h=await setup(),v=h.view;const old=v.key('__host__','sent-receipts');
 v.open('__host__');await h.flush(10);
 v.posts.set('__host__',new Map());v.pending.set('__host__',{text:'old',requestId:'old'});v.drafts.set('__host__','old');v.ownVerified.set('__host__',new Set());v.sentReceipts.set('__host__',[]);
 h.pair.host={status:'ready',origin,room:{id:'different-room',name:'Different'}};v.syncHostScope();
 expect(v.key('__host__','sent-receipts')).not.toBe(old);expect(v.selected).toBeNull();
 for(const cache of [v.posts,v.pending,v.drafts,v.ownVerified,v.sentReceipts])expect(cache.has('__host__')).toBe(false);
 const rebound=v.key('__host__','read');h.pair.deny();expect(v.hostedConnection()).toBeNull();expect(v.key('__host__','read')).not.toBe(rebound);
});
it('a late hosted feed response cannot populate a newly bound room',async()=>{
 const h=await setup();let finish:any;const api=h.view.api.bind(h.view);
 h.view.api=(path:string,opts:any)=>path.startsWith('/__host__/posts')?new Promise(r=>finish=r):api(path,opts);
 h.view.open('__host__');await h.flush(5);
 h.pair.host={status:'ready',origin,room:{id:'new-room',name:'New'}};h.view.syncHostScope();
 finish({ok:true,data:{posts:[{ackId:'old',sequence:1,text:'Old private room'}]}});await h.flush(5);
 expect(h.view.posts.has('__host__')).toBe(false);expect(h.document.body.textContent).not.toContain('Old private room');
});
it('reconnect requires an explicit confirmed owner action and polling never invokes it',async()=>{
 const h=await setup();await h.pair.open();const record={handle,state:'connected',connectionId,origin,room:{id:roomId,name:'Shared room'}};
 const api=vi.spyOn(h.pair,'api').mockResolvedValue({ok:true,data:record});
 vi.spyOn(h.window,'confirm').mockReturnValue(false);await h.pair.reconnect(record);expect(api).not.toHaveBeenCalled();
 h.window.confirm.mockReturnValue(true);await h.pair.reconnect(record);
 expect(api).toHaveBeenCalledWith('/api/embassy-pairing/'+handle+'/reconnect',{method:'POST'});
 api.mockClear();h.pair.record=record;await h.pair.poll();expect(api.mock.calls.every(([path])=>!path.endsWith('/reconnect'))).toBe(true);
});
it('top-level integration error codes select the precise recovery message',async()=>{
 const h=await setup();expect(h.pair.error({errorCode:'GUEST_LABEL',error:'label conflict',status:409})).toContain('Choose another name');
});
it('a late hosted publication cannot clear the new room retry identity',async()=>{
 const h=await setup();h.view.open('__host__');await h.flush(5);let finish:any;const original=h.pair.api.bind(h.pair);
 vi.spyOn(h.pair,'api').mockImplementation((path:any,opts:any)=>path==='/api/embassy-host/posts'&&opts?.method==='POST'?new Promise(r=>finish=r):original(path,opts));
 h.view.input.value='Old room message';const sending=h.view.publish();await h.flush(5);
 h.pair.host={status:'ready',origin,room:{id:'another-room',name:'Another'}};h.view.syncHostScope();
 const pending={text:'New room message',requestId:'new-request'};h.view.pending.set('__host__',pending);
 finish({ok:true,data:{post:{ackId:'old',sequence:1,text:'Old room message'}}});await sending;
 expect(h.view.pending.get('__host__')).toEqual(pending);expect(h.view.sentReceipts.has('__host__')).toBe(false);
});
it('label conflict cancels the original handle before accepting a fresh request identity',async()=>{
 const h=await setup();await h.pair.open();h.pair.guestOperation='old-operation';h.pair.record={handle,state:'failed',error:'GUEST_LABEL'};await h.pair.showRecord();
 expect(h.button('Cancel and start over')).toBeTruthy();h.state.deleteFailure=true;await h.pair.restartAfterLabelConflict();
 expect(h.pair.guestOperation).toBe('old-operation');expect(h.pair.record.handle).toBe(handle);
 h.state.deleteFailure=false;await h.pair.restartAfterLabelConflict();expect(h.pair.guestOperation).toBeNull();expect(h.pair.record).toBeNull();
 expect(h.calls.filter(c=>c.path==='/api/embassy-pairing'&&c.method==='POST')).toHaveLength(0);
 const inputs=h.document.querySelectorAll('.eg-pair-labels input');inputs[0].value='New company';inputs[1].value='New person';
 const invitation=h.document.querySelector('.eg-pair-code');invitation.value=qr;h.button('Request to join').click();await h.flush(10);
 const call=h.calls.find(c=>c.path==='/api/embassy-pairing'&&c.method==='POST');expect(call.body).toMatchObject({company:'New company',identity:'New person',qr});expect(call.body.clientRequestId).not.toBe('old-operation');
});
it('an opaque host binding change fences the same canonical room',async()=>{
 const h=await setup();const old=h.view.key('__host__','read');h.pair.host.bindingId='replacement-binding';h.view.syncHostScope();
 expect(h.view.key('__host__','read')).not.toBe(old);
});
it('unknown outcomes and nonretired handles never authorize label restart',async()=>{
 const h=await setup();await h.pair.open();const api=vi.spyOn(h.pair,'api');
 for(const record of [{handle,state:'creating'},{handle,state:'failed',error:'EMBASSY_UNREACHABLE'},{handle,state:'connected',error:'GUEST_LABEL'}]){
  h.pair.record=record;await h.pair.restartAfterLabelConflict();
 }
 expect(api).not.toHaveBeenCalled();
 h.pair.record={handle,state:'failed',error:'GUEST_LABEL'};h.pair.guestOperation='original';
 api.mockResolvedValue({ok:true,data:{handle,state:'connected'}});await h.pair.restartAfterLabelConflict();
 expect(h.pair.guestOperation).toBe('original');expect(h.pair.record.handle).toBe(handle);expect(h.document.querySelector('.eg-pair-labels')).toBeNull();
});
it('label restart retires polling before awaiting cancellation',async()=>{
 const h=await setup();await h.pair.open();h.pair.record={handle,state:'failed',error:'GUEST_LABEL'};
 const oldEpoch=h.pair.epoch;h.pair.schedulePoll();let finish:any;
 vi.spyOn(h.pair,'api').mockImplementation(()=>new Promise(r=>finish=r));
 const restarting=h.pair.restartAfterLabelConflict();expect(h.pair.pollTimer).toBeNull();expect(h.pair.epoch).toBeGreaterThan(oldEpoch);
 h.pair.close();finish({ok:true,data:{state:'cancelled'}});await restarting;
 expect(h.document.querySelector('.eg-pair-labels')).toBeNull();expect(h.view.dialog).toBeNull();
});
it('r4 create views preserve immediate failures and unconfirmed creation for recovery',async()=>{
 const h=await setup();await h.pair.open();
 for(const state of ['creating','failed']){
  h.pair.scan('invite');h.state.guestResponse={handle,origin,state,room:{id:roomId,name:''},...(state==='failed'?{error:'GUEST_LABEL'}:{error:'EMBASSY_UNREACHABLE'})};
  await h.pair.join(qr,h.document.querySelector('.eg-pair-status'));
  expect(h.pair.record.state).toBe(state);expect(h.pair.record.handle).toBe(handle);
  if(state==='failed')expect(h.button('Cancel and start over')).toBeTruthy();
  else expect(h.button('Cancel request')).toBeTruthy();
 }
});
it('wrong-handle cancellation and explicit outstanding debt preserve the original operation',async()=>{
 const h=await setup();await h.pair.open();h.pair.record={handle,state:'pending',origin};h.pair.guestOperation='original';await h.pair.showRecord();
 const api=vi.spyOn(h.pair,'api');
 for(const data of [{handle:'wrong-handle',state:'cancelled'},{handle,state:'cancelled',cancelPending:true}]){
  api.mockResolvedValue({ok:true,data});await h.pair.cancel();
  expect(h.pair.record.state).toBe('pending');expect(h.pair.record.handle).toBe(handle);expect(h.pair.guestOperation).toBe('original');expect(h.button('Check status')).toBeTruthy();expect(h.button('Cancel and start over')).toBeUndefined();
 }
});
it('the hosted room offers invitation controls without any actionable liaison opt-in',async()=>{
 const h=await setup();h.view.open('__host__');await h.flush(5);h.view.updateControls();
 const actions=[...h.view.controls.querySelectorAll('button,a,input,select,[role="switch"],[role="checkbox"]')];
 expect(actions.map((el:any)=>el.textContent)).toEqual(['Invite a company','Manage invitations']);
 expect(h.calls.some(c=>/liaison/.test(c.path))).toBe(false);
});
it('r5 cancelling survives restore and enables Start over only after confirmed cancellation',async()=>{
 const h=await setup();await h.pair.open();h.pair.record={handle,state:'pending',origin,room:{id:roomId,name:'Shared'},requestQr,code:'3BCD-5FGH'};await h.pair.showRecord();
 const api=vi.spyOn(h.pair,'api').mockResolvedValue({ok:true,data:{handle,state:'cancelling',origin,room:{id:roomId,name:'Shared'}}});
 await h.pair.cancel();expect(h.pair.record.state).toBe('cancelling');expect(h.pair.record.requestQr).toBeUndefined();
 expect(h.document.querySelector('.eg-pair-status').textContent).toContain('waiting for the host embassy');expect(h.button('Start over')).toBeUndefined();expect(h.pair.pollTimer).not.toBeNull();
 h.pair.home();expect(h.button('Join a company').disabled).toBe(true);await h.pair.resume({handle,state:'cancelling',origin});expect(h.pair.record.state).toBe('cancelling');
 api.mockResolvedValue({ok:true,data:{handle,state:'cancelled',origin,room:{id:roomId,name:'Shared'}}});await h.pair.poll();
 expect(h.button('Start over')).toBeTruthy();expect(h.pair.pollTimer).toBeNull();expect(api.mock.calls.every(([,opts])=>!opts||opts.method==='DELETE')).toBe(true);
 h.pair.guestOperation='previous';h.button('Start over').click();expect(h.pair.guestOperation).toBeNull();expect(h.document.querySelector('.eg-pair-labels')).toBeTruthy();
});
it('cancelling hides stale public confirmation and never opens a guest connection',async()=>{
 const h=await setup();await h.pair.open();h.pair.record={handle,state:'cancelling',origin,requestQr,code:'3BCD-5FGH',connectionId};const open=vi.spyOn(h.view,'open');await h.pair.showRecord();
 expect(h.document.querySelector('.eg-pair-confirm-code')).toBeNull();expect(h.button('Open shared room')).toBeUndefined();expect(h.button('Cancel and start over')).toBeUndefined();expect(open).not.toHaveBeenCalled();
});
it('the real composer send hook routes hosted messages only to the embassy',async()=>{
 const h=await setup();h.view.open('__host__');await h.flush(5);h.view.input.value='Hosted route control';
 await h.app._sendChatMessage();
 expect(h.calls.filter(c=>c.path==='/api/embassy-host/posts'&&c.method==='POST')).toHaveLength(1);
 expect(h.state.hostPosts.at(-1).text).toBe('Hosted route control');expect(h.server.posts).toHaveLength(0);
});
it('composer resync and send keep the embassy placeholder, then restore the local room context',async()=>{
 const h=await setup();const shell=h.view.shell;const local=shell.room.name;h.view.open('__host__');await h.flush(5);
 shell.syncComposer();expect(h.view.input.placeholder).toBe('Message #Shared room');
 h.view.input.value='Context control';await h.app._sendChatMessage();expect(h.view.input.placeholder).toBe('Message #Shared room');
 h.view.close();expect(h.app._chatEls.input.placeholder).toBe('Message #'+local);
});
it('local-room typing never appears in an embassy, including new turn events, and resumes on return',async()=>{
 const h=await setup();const shell=h.view.shell;shell.noteTurn({roomId:shell.roomId,sessionId:'local'});
 expect(shell.els.typing.hidden).toBe(false);h.view.open('__host__');await h.flush(5);
 expect(shell.els.typing.hidden).toBe(true);expect(shell.els.typing.textContent).toBe('');
 shell.noteTurn({roomId:shell.roomId,sessionId:'local'});expect(shell.els.typing.hidden).toBe(true);
 h.view.close();expect(shell.els.typing.hidden).toBe(false);expect(shell.els.typing.textContent).toContain('Local');
});
it('typing in every local view requires current membership in the displayed room',async()=>{
 const h=await setup();const shell=h.view.shell;h.app._chatRooms.push(room('other','Other',[member('local','Local')]));
 shell.noteTurn({roomId:'other',sessionId:'local'});expect(shell.els.typing.hidden).toBe(true);
 h.app.sessions.set('outsider',{id:'outsider',status:'idle',mode:'claude',name:'Outsider'});
 shell.noteTurn({roomId:shell.roomId,sessionId:'outsider'});expect(shell.els.typing.hidden).toBe(true);
 shell.noteTurn({roomId:shell.roomId,sessionId:'local'});expect(shell.els.typing.textContent).toContain('Local');
 shell.room.members=[];shell.renderTyping();expect(shell.els.typing.hidden).toBe(true);expect(shell.els.typing.textContent).toBe('');
});

it.each(['host','guest'])('opens a visible %s embassy feed/composer with zero ordinary local rooms and restores empty state',async(kind)=>{
 const h=await setup(true),els=h.app._chatEls;
 expect(h.app._chatRoomId).toBeFalsy();
 if(kind==='guest')h.rows.push({id:connectionId,origin,roomId,roomName:'Shared room',enabled:true,status:'live'});
 await h.view.refresh();
 // The actual create-room path is the state inherited by a new console.
 h.app._showChatCreate();
 expect(els.composer.hidden).toBe(true);expect(els.feed.hidden).toBe(true);
 h.view.open(kind==='host'?'__host__':connectionId);await h.flush(10);
 expect(els.composer.hidden).toBe(false);expect(els.feed.hidden).toBe(false);expect(els.empty.hidden).toBe(true);
 expect(els.send.disabled).toBe(false);
 expect(h.calls.filter(c=>c.method==='POST')).toHaveLength(0);
 h.view.close();
 expect(els.composer.hidden).toBe(true);expect(els.feed.hidden).toBe(true);expect(els.empty.hidden).toBe(false);
});
