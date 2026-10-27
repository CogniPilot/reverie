import {webcrypto} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {createHarness,room,member} from './helpers/chat-app-harness.mjs';
const src=readFileSync(resolve(import.meta.dirname,'../src/web/public/chat-app.js'),'utf8');
const mod={exports:{}};new Function('module',src)(mod);const pure:any=mod.exports;
const key='embassy-v1|https://relay.example.test:8443|'+'A'.repeat(43);
const link=pure.caEmbassyJoinLink(key);
const open:any[]=[];
afterEach(()=>{for(const h of open.splice(0))h.dom.window.close();vi.restoreAllMocks();});
async function setup(hash=''){
 const h=await createHarness({loadShell:false,hash,sessions:[{id:'local',name:'Local',mode:'claude'}],rooms:[room('r1','General',[member('local','Local')])]});open.push(h);
 h.window.TextEncoder=TextEncoder;
 Object.defineProperty(h.window.crypto,'subtle',{value:webcrypto.subtle,configurable:true});
 h.window.eval(readFileSync(resolve(import.meta.dirname,'../src/web/public/embassy-invite-bootstrap.js'),'utf8'));
 const original=h.app._api;const calls:any[]=[];const rows=[{id:'one',origin:'https://relay.example.test:8443',roomId:'shared',roomName:'Shared room',hostCompany:'Remote',guest:{company:'Visitor',identity:'Guest'},expiresAt:Date.now()+3600000,enabled:true,status:'live',postCount:1}];
 const posts=[{ackId:'p1',sequence:1,at:Date.now(),text:'Hello 👋 <img src=x onerror=alert(1)>',author:{company:'Remote',identity:'Guest'},trust:'guest'}];
 let denied=false;
 h.app._api=async(p:string,o:any={})=>{
  if(!p.startsWith('/api/embassy-guest'))return original.call(h.app,p,o);
  calls.push({path:p,...o});let data:any;
  if(denied)return {ok:false,status:403,json:async()=>({success:false,error:'Embassy rooms require a signed-in owner'})};
  if(p==='/api/embassy-guest')data={connections:rows};
  else if(p.endsWith('/preview'))data={origin:rows[0].origin};
  else if(p.endsWith('/join'))data=rows[0];
  else if(o.method==='POST'){posts.push({ackId:'p2',sequence:2,at:Date.now(),text:o.body.text,author:{company:'Visitor',identity:'Owner'},trust:'guest'});data={post:posts.at(-1)};}
  else data={posts:posts.filter(p=>p.sequence>Number(new URL(p,'https://local.test').searchParams.get('after')||0)),next:posts.length};
  return {ok:true,status:200,json:async()=>({success:true,data})};
 };
 await h.startShell();await h.flush(25);const ui=h.window.reverieChat.embassy;await ui.refresh();
 const button=(name:string)=>[...h.document.querySelectorAll('.eg-dialog button')].find((b:any)=>b.textContent===name) as HTMLButtonElement;
 return {...h,ui,calls,posts,button,deny:()=>denied=true};
}
it('round-trips the complete host/key only in the fragment',()=>{
 const url=new URL(link);expect(url.search).toBe('');expect(url.pathname).toBe('/');expect(url.hash).toContain('host=');expect(url.hash).toContain('key=');
 expect(pure.caEmbassyInvite(link)).toEqual({key,origin:'https://relay.example.test:8443'});
});
it.each([
 'javascript:alert(1)',link+'&host=https%3A%2F%2Fother.test',link.replace('host=https%3A%2F%2Frelay.example.test%3A8443','host=https%3A%2F%2Fother.test'),
 link.replace('/#','/?track=1#'),link.replace('https://relay.example.test:8443/','https://user:password@relay.example.test:8443/'),
 'embassy-v1|http://relay.test|'+'A'.repeat(43),'embassy-v1|https://127.0.0.1|'+'A'.repeat(43)
])('refuses malformed or mismatched envelopes without interpreting them: %s',(value)=>expect(()=>pure.caEmbassyInvite(value)).toThrow());
it('consumes a startup fragment without a preview, join, storage or URL secret',async()=>{
 const h=await setup(new URL(link).hash);expect(h.window.location.hash).toBe('');expect(h.document.querySelector('.eg-key').value).toBe(key);
 expect(h.calls.filter(c=>c.method==='POST')).toHaveLength(0);expect(JSON.stringify({...h.window.localStorage,...h.window.sessionStorage})).not.toContain(key);
 h.button('Cancel').click();expect(h.document.querySelector('.eg-dialog')).toBeNull();
});
it('Show QR stays local and clears key-bearing DOM on cancel',async()=>{
 const h=await setup();h.window.ReverieQRCode={toCanvas:vi.fn(async(c:any)=>{c.width=320;})};h.ui.joinDialog();h.document.querySelector('.eg-key').value=key;
 h.button('Show QR').click();await h.flush(5);expect(h.document.querySelector('.eg-share-link').value).toBe(link);expect(h.calls.filter(c=>c.method==='POST')).toHaveLength(0);
 const canvas=h.document.querySelector('canvas');h.button('Cancel').click();expect(canvas.width).toBe(0);expect(JSON.stringify({...h.window.localStorage,...h.window.sessionStorage})).not.toContain(key);
});
it('pasted links require Check host and explicit Connect and never navigate away',async()=>{
 const h=await setup();h.ui.joinDialog();h.button('Scan/paste link').click();h.document.querySelector('.eg-invite-link').value=link;h.button('Use link').click();
 expect(h.calls.filter(c=>c.method==='POST')).toHaveLength(0);expect(h.document.querySelector('.eg-invite-link').value).toBe('');
 h.button('Check host').click();await h.flush(5);expect(h.calls.filter(c=>c.path.endsWith('/join'))).toHaveLength(0);h.button('Connect').click();await h.flush(20);
 expect(h.calls.find(c=>c.path.endsWith('/join')).body).toEqual({key,confirmedOrigin:'https://relay.example.test:8443'});expect(h.window.location.origin).toBe('http://localhost');
});
it('a pending camera permission resolving after Cancel stops all tracks',async()=>{
 const h=await setup();let release:any;const stop=vi.fn();h.window.jsQR=()=>null;
 Object.defineProperty(h.window.navigator,'mediaDevices',{value:{getUserMedia:()=>new Promise(r=>release=r)},configurable:true});
 h.ui.joinDialog();h.button('Scan/paste link').click();h.button('Scan with camera').click();await h.flush(5);h.button('Cancel').click();release({getTracks:()=>[{stop}]});await h.flush(5);expect(stop).toHaveBeenCalledOnce();expect(h.calls.filter(c=>c.method==='POST')).toHaveLength(0);
});
it('a late preview after owner loss cannot restore a secret or confirmation',async()=>{
 const h=await setup();let release:any;const old=h.app._chatApi.bind(h.app);h.app._chatApi=(p:string,o:any)=>p.endsWith('/preview')?new Promise(r=>release=r):old(p,o);
 h.ui.joinDialog();h.document.querySelector('.eg-key').value=key;h.button('Check host').click();h.deny();await h.ui.refresh();release({ok:true,data:{origin:'https://relay.example.test:8443'}});await h.flush(5);
 expect(h.document.querySelector('.eg-dialog')).toBeNull();expect(h.document.body.textContent).not.toContain(key);expect(h.ui.allowed).toBe(false);
});
it('Embassies lives only in the sidebar and opens the same feed, composer and message renderer',async()=>{
 const h=await setup();const feed=h.app._chatEls.feed,form=h.app._chatEls.composer;
 expect([...h.document.querySelectorAll('.ca-pages .ca-name')].map(n=>n.textContent)).toEqual([]);h.shell=h.window.reverieChat;
 h.shell.openPage('embassies');expect(h.document.querySelector('.ca-page iframe')).toBeNull();h.document.querySelector('.eg-directory-room').click();await h.flush(15);
 expect(h.ui.feed).toBe(feed);expect(h.ui.form).toBe(form);expect(h.ui.feed.querySelector('.ca-msg .ca-msg-body')).not.toBeNull();expect(h.ui.feed.textContent).toContain('UNTRUSTED EXTERNAL');expect(h.ui.feed.querySelector('img')).toBeNull();
 expect(h.ui.feed.querySelector('.ca-msg-actions')).toBeNull();expect(h.window.location.hash).toBe('');
});
it('shared composer sends only through the guest API and blocks attachment uploads',async()=>{
 const h=await setup();h.ui.open('one');await h.flush(5);const localCalls=h.server.calls.length;h.app._chatEls.input.value='hello 😃';await h.app._sendChatMessage();
 expect(h.calls.filter(c=>c.method==='POST'&&c.path.endsWith('/posts'))).toHaveLength(1);expect(h.server.posts).toHaveLength(0);
 await h.app._attachChatFiles([new h.window.File(['secret'],'private.txt')]);expect(h.server.calls.slice(localCalls).filter(c=>c.path.includes('/files'))).toHaveLength(0);
});
it('local room events cannot contaminate the external feed and local drafts restore',async()=>{
 const h=await setup();h.app._chatEls.input.value='LOCAL_DRAFT';h.ui.open('one');await h.flush(5);
 h.window.reverieChat.handleMessage({roomId:'r1',message:{id:'local-new',at:Date.now(),from:{kind:'agent',sessionId:'local',name:'Local'},to:'all',text:'LOCAL_ONLY'}});
 expect(h.ui.feed.textContent).not.toContain('LOCAL_ONLY');h.ui.close();expect(h.app._chatEls.input.value).toBe('LOCAL_DRAFT');
 h.app._chatEls.input.value='local reply';await h.app._sendChatMessage();expect(h.server.posts.at(-1).text).toBe('local reply');
});
it('the production entrypoint loads the blocking fragment scrubber before every app script',()=>{
 const html=readFileSync(resolve(import.meta.dirname,'../src/web/public/index.html'),'utf8').replace(/<!--[\s\S]*?-->/g,'');
 const first=html.match(/<script\b[^>]*>/i)?.[0];expect(first).toContain('src="embassy-invite-bootstrap.js"');expect(first).not.toContain('defer');expect(first).not.toContain('async');
 expect(html).not.toMatch(/<script[^>]+src="chat-app\.js"/);
});
it('a confirmed local post is labelled as ours without granting local message actions',async()=>{
 const h=await setup();h.ui.open('one');await h.flush(5);h.ui.input.value='OUR_CONFIRMED_TEXT';await h.app._sendChatMessage();
 const row=h.ui.feed.querySelector('[data-post="p2"]');expect(row.classList.contains('is-mine')).toBe(true);expect(row.querySelector('.eg-own').textContent).toBe('Sent from this console');expect(row.textContent).not.toContain('UNTRUSTED EXTERNAL');expect(row.querySelector('.ca-msg-actions')).toBeNull();
 const receipts=h.window.localStorage.getItem(h.ui.key('one','sent-receipts'));expect(receipts).toContain('sha256');expect(receipts).not.toContain('OUR_CONFIRMED_TEXT');
 h.ui.sentReceipts.clear();h.ui.ownVerified.clear();await h.ui.loadPosts();expect(h.ui.ownVerified.get('one').has('p2')).toBe(true);
});
it('spoofed company labels or a modified acknowledged payload never become ours',async()=>{
 const h=await setup();h.ui.open('one');await h.flush(5);h.ui.input.value='LOCAL_EXACT';await h.app._sendChatMessage();
 h.posts[0].author={company:'Visitor',identity:'Guest'};h.posts[1].text='MODIFIED_BY_REMOTE';await h.ui.loadPosts();
 expect(h.ui.feed.querySelectorAll('.eg-own')).toHaveLength(0);expect(h.ui.feed.querySelectorAll('.eg-trust')).toHaveLength(2);
});
