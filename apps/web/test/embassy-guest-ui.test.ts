import {afterEach, expect, it, vi} from 'vitest';
import {createHarness,room,member} from './helpers/chat-app-harness.mjs';
const opened:any[]=[];
afterEach(()=>{for(const h of opened.splice(0))h.dom.window.close();vi.restoreAllMocks();});
const connection=(id:string, extra={})=>({id,origin:`https://${id}.example.test`,roomId:`remote-${id}`,roomName:'Shared room',hostCompany:'Remote',guest:{company:'Visitor',identity:'Guest'},expiresAt:Date.now()+3600000,enabled:true,status:'live',postCount:0,...extra});
const post=(n:number,text='External text')=>({ackId:`post-${n}`,sequence:n,at:1,text,author:{company:'Remote',identity:'Guest',kind:'guest'},trust:'guest'});
async function setup(){
 const h=await createHarness({sessions:[{id:'local',name:'Local',mode:'claude'}],rooms:[room('r1','General',[member('local','Local')])]});opened.push(h);await h.flush(25);
 h.window.TextEncoder=TextEncoder;
 const cs=[connection('one'),connection('two')]; const histories:Record<string,any[]>={one:[],two:[]}; const calls:any[]=[];
 const original=h.app._chatApi.bind(h.app);
 h.app._chatApi=async(path:string,options:any={})=>{
  if(!path.startsWith('/api/embassy-guest'))return original(path,options);
  calls.push({path,...options});const method=options.method||'GET';
  if(path==='/api/embassy-guest')return {ok:true,data:{connections:cs.map(c=>({...c,postCount:histories[c.id].length}))}};
  if(path.endsWith('/preview'))return {ok:true,data:{origin:'https://relay.example.test'}};
  if(path.endsWith('/join'))return {ok:true,data:cs[0]};
  const id=path.split('/')[3];
  if(method==='PUT'){Object.assign(cs.find(c=>c.id===id)!,{enabled:options.body.enabled,status:options.body.enabled?'live':'disabled'});return {ok:true,data:cs.find(c=>c.id===id)}};
  if(method==='DELETE'){Object.assign(cs.find(c=>c.id===id)!,{enabled:false,status:'left'});return {ok:true,data:cs.find(c=>c.id===id)}};
  if(method==='POST')return {ok:true,data:{post:post(1,options.body.text)}};
  const after=Number(new URL(path,'https://local.test').searchParams.get('after')||0);const posts=(histories[id]||[]).filter(p=>p.sequence>after).slice(0,200);
  return {ok:true,data:{posts,next:posts.at(-1)?.sequence||after}};
 };
 const ui=h.shell.embassy;expect(ui).toBeTruthy();await ui.refresh();return {...h,ui,cs,histories,calls};
}
it('shows distinct duplicate-name bindings with a keyboard-operable collapse and add control',async()=>{
 const h=await setup();expect(h.document.querySelectorAll('.eg-channel')).toHaveLength(2);
 const toggle=h.document.querySelector('.eg-category-toggle') as HTMLButtonElement;expect(toggle.getAttribute('aria-expanded')).toBe('true');toggle.click();
 expect(h.document.querySelector('.eg-channel-list')!.hasAttribute('hidden')).toBe(true);expect(h.document.activeElement).toBe(h.document.querySelector('.eg-category-toggle'));
 expect(h.calls.filter(c=>c.method==='PUT')).toHaveLength(0);expect(h.document.querySelector('[aria-label="Add embassy channel"]')).not.toBeNull();
});
it('renders hostile imported text without markup, local posts or wake calls',async()=>{
 const h=await setup();h.histories.one.push(post(1,'<img src=x onerror=alert(1)> @everyone /run'));await h.ui.refresh();h.ui.open('one');await h.flush(20);
 expect(h.document.querySelector('.eg-text')!.textContent).toContain('<img');expect(h.document.querySelector('.eg-feed img')).toBeNull();expect(h.server.posts).toHaveLength(0);
 expect(h.document.querySelector('.eg-origin')!.textContent).toContain('no signed identity pin');
});
it('tracks unread for the selected connection only, leaving collapsed rooms unread',async()=>{
 const h=await setup();h.histories.one.push(post(1));h.histories.two.push(post(1),post(2));await h.ui.refresh();expect(h.ui.unread(h.ui.connections[1])).toBe(2);
 h.ui.open('one');await h.flush(20);expect(h.ui.unread(h.ui.connections[0])).toBe(0);expect(h.ui.unread(h.ui.connections[1])).toBe(2);
 h.ui.close();await h.ui.refresh();expect(h.ui.unread(h.ui.connections[1])).toBe(2);
});
it('loads all pages and dedupes replay by remote ack identity',async()=>{
 const h=await setup();h.histories.one.push(...Array.from({length:205},(_,i)=>post(i+1)));await h.ui.refresh();h.ui.open('one');await h.flush(40);
 expect(h.document.querySelectorAll('.eg-post')).toHaveLength(205);await h.ui.loadPosts();expect(h.document.querySelectorAll('.eg-post')).toHaveLength(205);expect(h.ui.unread(h.ui.connections[0])).toBe(0);
});
it('retains separate drafts when switching and closes the external panel for a local room',async()=>{
 const h=await setup();h.ui.open('one');h.ui.input.value='First draft';h.ui.open('two');h.ui.input.value='Second draft';h.ui.open('one');expect(h.ui.input.value).toBe('First draft');await h.shell.selectRoom('r1');expect(h.document.querySelector('.eg-view')).toBeNull();
});
it('an old room response cannot render after a room switch',async()=>{
 const h=await setup();const api=h.app._chatApi;let release:any;h.app._chatApi=(p:string,o:any)=>p.includes('/one/posts')?new Promise(r=>release=r):api(p,o);
 h.ui.open('one');h.ui.open('two');await h.flush(10);release({ok:true,data:{posts:[post(1,'STALE')],next:1}});await h.flush(10);expect(h.ui.selected).toBe('two');expect(h.ui.feed.textContent).not.toContain('STALE');
});
it('uncertain publication retries exactly the saved text and request id even after reopen',async()=>{
 const h=await setup();h.ui.open('one');const api=h.app._chatApi;const sent:any[]=[];h.app._chatApi=async(p:string,o:any)=>{if(o?.method==='POST'&&p.endsWith('/posts')){sent.push({...o.body});return {ok:false,error:'Not confirmed'}}return api(p,o)};
 h.ui.input.value='Do not duplicate';await h.ui.publish();h.ui.open('two');h.ui.open('one');expect(h.ui.input.readOnly).toBe(true);await h.ui.publish();expect(sent).toHaveLength(2);expect(sent[1]).toEqual(sent[0]);expect(h.server.posts).toHaveLength(0);
});
it('Disable and Leave retain visible history while refusing local sends',async()=>{
 const h=await setup();h.histories.one.push(post(1));h.ui.open('one');await h.flush(10);await h.ui.setEnabled('one',false);expect(h.ui.send.disabled).toBe(true);expect(h.document.querySelectorAll('.eg-post')).toHaveLength(1);h.ui.input.value='held';await h.ui.publish();expect(h.calls.filter(c=>c.method==='POST')).toHaveLength(0);
 h.window.confirm=()=>true;await h.ui.leave('one');expect(h.ui.status.textContent).toContain('Disconnected');expect(h.document.querySelectorAll('.eg-post')).toHaveLength(1);
});
it('requires a parsed host confirmation, clears the pasted key and never stores it',async()=>{
 const h=await setup();h.ui.joinDialog();h.document.querySelector('.eg-key')!.value='SECRET_KEY';[...h.document.querySelectorAll('.eg-dialog button')].find((b:any)=>b.textContent==='Check host')!.click();await h.flush(15);
 expect(h.calls.filter(c=>c.path.endsWith('/join'))).toHaveLength(0);expect(h.document.querySelector('.eg-key')!.value).toBe('');expect(h.document.querySelector('.eg-join-status')!.textContent).toContain('https://relay.example.test');
 [...h.document.querySelectorAll('.eg-dialog button')].find((b:any)=>b.textContent==='Connect')!.click();await h.flush(20);expect(h.calls.find(c=>c.path.endsWith('/join')).body).toEqual({key:'SECRET_KEY',confirmedOrigin:'https://relay.example.test'});expect(JSON.stringify({...h.window.localStorage,...h.window.sessionStorage})).not.toContain('SECRET_KEY');
});
it('clears external content and controls when the owner API becomes unauthorized',async()=>{
 const h=await setup();h.ui.open('one');h.app._chatApi=async()=>({ok:false,error:'HTTP 403'});await h.ui.refresh();expect(h.document.querySelector('.eg-view')).toBeNull();expect(h.document.querySelector('.eg-category')).toBeNull();expect(h.ui.posts.size).toBe(0);
});

it('an initially unauthorized console shows bootstrap/login guidance without external controls or data',async()=>{
 const h=await createHarness({sessions:[],rooms:[room('r1','General',[])],loadShell:false});opened.push(h);
 const original=h.app._chatApi.bind(h.app);h.app._chatApi=(path:string,o:any)=>path==='/api/embassy-guest'?Promise.resolve({ok:false,error:'Embassy rooms require a signed-in owner'}):original(path,o);
 await h.startShell();await h.flush(25);
 const note=h.document.querySelector('.eg-access-note');expect(note?.textContent).toContain('run reverie owner bootstrap');expect(note?.querySelector('a')?.getAttribute('href')).toBe('/owner/login');
 expect(h.document.querySelector('.eg-category')).toBeNull();expect(h.document.querySelector('.eg-view')).toBeNull();expect(h.document.querySelector('[aria-label="Add embassy channel"]')).toBeNull();
});

it.each(['disable','enable','leave'])('a held pre-mutation list cannot undo authoritative %s state',async(action)=>{
 const h=await setup();if(action==='enable'){await h.ui.setEnabled('one',false);}h.ui.open('one');await h.flush(10);
 const oldRows=h.ui.connections.map((c:any)=>({...c}));const api=h.app._chatApi;const lists:any[]=[];
 h.app._chatApi=(p:string,o:any)=>p==='/api/embassy-guest'?new Promise(resolve=>lists.push(resolve)):api(p,o);
 const reading=h.ui.refresh();expect(lists).toHaveLength(1);
 if(action==='leave'){h.window.confirm=()=>true;await h.ui.leave('one');}else await h.ui.setEnabled('one',action==='enable');
 const expected=action==='enable'?'live':action==='leave'?'left':'disabled';
 expect(h.ui.connection().status).toBe(expected);expect(h.ui.send.disabled).toBe(action!=='enable');
 if(action==='disable')expect(h.ui.status.textContent).toContain('Disabled here');
 lists[0]({ok:true,data:{connections:oldRows}});await reading;await h.flush(10);
 expect(h.ui.connection().status).toBe(expected);expect(h.ui.send.disabled).toBe(action!=='enable');
 h.app._chatApi=api;for(const resolve of lists.slice(1))resolve(await api('/api/embassy-guest'));await h.flush(10);
});
it('a list started during a mutation is fenced when it completes after the mutation acknowledgement',async()=>{
 const h=await setup();h.ui.open('one');await h.flush(10);const api=h.app._chatApi;let finish:any,release:any;
 const old=h.ui.connections.map((c:any)=>({...c}));let listCount=0;const follow:any[]=[];
 h.app._chatApi=(p:string,o:any)=>o?.method==='PUT'?new Promise(resolve=>finish=async()=>resolve(await api(p,o))):p==='/api/embassy-guest'?++listCount===1?new Promise(resolve=>release=resolve):new Promise(resolve=>follow.push(resolve)):api(p,o);
 const write=h.ui.setEnabled('one',false);const reading=h.ui.refresh();await finish();await write;
 release({ok:true,data:{connections:old}});await reading;await h.flush(15);
 expect(h.ui.connection().enabled).toBe(false);expect(h.ui.send.disabled).toBe(true);expect(h.ui.status.textContent).toContain('Disabled here');
 h.app._chatApi=api;for(const resolve of follow)resolve(await api('/api/embassy-guest'));await h.flush(10);
});

it('a held list cannot hide a newly acknowledged join or prevent its conversation from opening',async()=>{
 const h=await setup();const api=h.app._chatApi;const old=h.ui.connections.map((c:any)=>({...c}));const lists:any[]=[];h.histories.three=[];
 h.app._chatApi=async(p:string,o:any)=>{
  if(p==='/api/embassy-guest')return new Promise(resolve=>lists.push(resolve));
  if(p.endsWith('/join')){const joined=connection('three');h.cs.push(joined);return {ok:true,data:joined};}
  return api(p,o);
 };
 const reading=h.ui.refresh();h.ui.joinDialog();h.document.querySelector('.eg-key')!.value='INVITE';
 [...h.document.querySelectorAll('.eg-dialog button')].find((b:any)=>b.textContent==='Check host')!.click();await h.flush(10);
 [...h.document.querySelectorAll('.eg-dialog button')].find((b:any)=>b.textContent==='Connect')!.click();await h.flush(15);
 expect(h.ui.selected).toBe('three');expect(h.document.querySelector('[data-connection="three"]')).not.toBeNull();
 lists[0]({ok:true,data:{connections:old}});await reading;await h.flush(10);expect(h.ui.selected).toBe('three');expect(h.document.querySelector('[data-connection="three"]')).not.toBeNull();
 h.app._chatApi=api;for(const resolve of lists.slice(1))resolve(await api('/api/embassy-guest'));await h.flush(10);
});
