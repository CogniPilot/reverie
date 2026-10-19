/** Scratch-only UI preview: every connection and post is simulated in-browser. */
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {readFileSync as readSync} from 'node:fs';
import {resolve,extname} from 'node:path';
import {createServer,member,room,message} from './chat-app-harness.mjs';
const publicDir=resolve(import.meta.dirname,'../../src/web/public');
const harness=readSync(resolve(import.meta.dirname,'chat-app-harness.mjs'),'utf8');
const stub=harness.match(/window\.eval\(`([\s\S]*?)`\);/)[1];
const bootstrap=`
${member.toString()} ${room.toString()} ${message.toString()} ${createServer.toString()}
window.__hashBeforeApp=location.hash;
const user={kind:'user',name:'Owner'};
window.CodemanUrlSession={sessionIdFromFragment:()=>null};
window.__server=createServer([room('local','General',[member('local-agent','Local colleague')])]);
window.__eg={calls:[],denied:false,connections:[{id:'demo',origin:'https://relay.example.test:8443',roomId:'shared',roomName:'Lab commons',hostCompany:'Neighbour company',guest:{company:'Your company',identity:'Owner'},expiresAt:Date.now()+3600000,enabled:true,status:'live',postCount:2}],histories:{demo:[{ackId:'p1',sequence:1,at:Date.now()-60000,text:'Welcome to the shared room 👋',author:{company:'Neighbour company',identity:'Liaison'},trust:'guest'},{ackId:'p2',sequence:2,at:Date.now()-30000,text:'This preview simulates the connection and posts. Real keys stay private.',author:{company:'Neighbour company',identity:'Visitor'},trust:'guest'}]}};
const oldHandle=window.__server.handle;
window.__server.handle=async(path,opts={})=>{
 if(!path.startsWith('/api/embassy-guest'))return oldHandle(path,opts);
 const e=window.__eg;e.calls.push({path,...opts});let data;const method=opts.method||'GET';
 if(e.denied)return {ok:false,status:403,json:async()=>({success:false,error:'Embassy rooms require a signed-in owner'})};
 if(path==='/api/embassy-guest')data={connections:e.connections};
 else if(path.endsWith('/preview'))data={origin:'https://relay.example.test:8443'};
 else if(path.endsWith('/join'))data=e.connections[0];
 else {const id=path.split('/')[3];const c=e.connections.find(c=>c.id===id);
  if(method==='PUT'){c.enabled=opts.body.enabled;c.status=c.enabled?'live':'disabled';data=c;}
  else if(method==='DELETE'){c.enabled=false;c.status='left';data=c;}
  else if(method==='POST'){const n=e.histories[id].length+1;const p={ackId:'p'+n,sequence:n,at:Date.now(),text:opts.body.text,author:{company:'Your company',identity:'Owner'},trust:'guest'};e.histories[id].push(p);c.postCount=n;data={post:p};}
  else {const after=Number(new URL(path,location.origin).searchParams.get('after')||0);const posts=e.histories[id].filter(p=>p.sequence>after);data={posts,next:posts.at(-1)?.sequence||after};}
 }
 return {ok:true,status:200,json:async()=>({success:true,data})};
};
window.fetch=()=>Promise.resolve({ok:true});
${stub}
`;
export async function startEmbassyPreview({extraScript=""}={}){
 const requests=[];
 const html='<!doctype html><html data-skin="daylight-blue"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Embassies UI prototype</title><script src="/embassy-invite-bootstrap.js"></script><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/chat-app.css"></head><body><div role="note" style="position:fixed;z-index:2000;right:8px;bottom:90px;padding:6px 10px;background:#10283f;color:white;border-radius:6px;font:12px sans-serif">Prototype · simulated connections/posts</div><script>'+bootstrap+extraScript+'</script><script src="/chatroom-ui.js"></script><script src="/chat-media.js"></script><script>window.__atAppConstruction=location.hash;window.app=new CodemanApp();</script></body></html>';
 const server=http.createServer(async(req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;requests.push({path,referer:req.headers.referer||''});
  if(path==='/'){res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store','Referrer-Policy':'no-referrer'});res.end(html);return;}
  if(!/^\/(?:[a-z0-9-]+\.(?:js|css)|vendor\/embassy-qr-(?:code|scan)\.min\.js)$/.test(path)){res.writeHead(404);res.end();return;}
  try{const data=await readFile(resolve(publicDir,'.'+path));res.writeHead(200,{'Content-Type':extname(path)==='.css'?'text/css':'application/javascript','Cache-Control':'no-store'});res.end(data);}
  catch{res.writeHead(404);res.end();}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 return {server,url:'http://127.0.0.1:'+server.address().port,requests,close:()=>new Promise(r=>{server.closeAllConnections();server.close(r);})};
}
