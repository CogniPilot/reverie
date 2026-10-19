/** Scripted API fixture for the UI contract, not actual relay/pairing implementation evidence. */
import {startEmbassyPreview} from './embassy-preview.mjs';
export const origin='https://relay.example.test:8443',roomId='420a20cc-1288-4faa-8f45-b6f908cf4a20',requestId='d7f74718-8792-476d-a609-331da7c5611d',handle='a'.repeat(32),connectionId='bd2161d7-0c0e-41f8-83d2-c6c720c22ac2';
export const qr=`embassy-v2|${origin}|${roomId}|${'A'.repeat(43)}`,requestQr=`embassy-pair-v1|${origin}|${requestId}|3BCD-5FGH`;
const extraScript=`
window.__pair={calls:[],state:'pending',cancelState:'cancelled',hold:false,deny:false};
const pairOld=window.__server.handle;
window.__server.handle=async(path,opts={})=>{
 const e=window.__pair;if(path==='/api/embassy-guest'&&e.state==='connected'&&!window.__eg.connections.some(c=>c.id===${JSON.stringify(connectionId)})){
  window.__eg.connections.push({id:${JSON.stringify(connectionId)},origin:${JSON.stringify(origin)},roomId:${JSON.stringify(roomId)},roomName:'Paired room',hostCompany:'Host company',guest:{company:'Student company',identity:'Student'},enabled:true,status:'live',postCount:0,expiresAt:Date.now()+3600000});window.__eg.histories[${JSON.stringify(connectionId)}]=[];
 }
 if(!path.startsWith('/api/embassy-host')&&!path.startsWith('/api/embassy-pairing'))return pairOld(path,opts);
 e.calls.push({path,method:opts.method||'GET',body:opts.body});
 if(e.deny)return {ok:false,status:403,json:async()=>({error:{code:'OWNER_ONLY'}})};
 let data;
 if(path==='/api/embassy-host')data={status:'ready',origin:${JSON.stringify(origin)},room:{id:${JSON.stringify(roomId)},name:'Lab commons'}};
 else if(path==='/api/embassy-host/invites'&&opts.method==='POST'){
  if(e.hold)await new Promise(r=>e.release=r);
  data={inviteId:'invite1',qr:${JSON.stringify(qr)},expiresAt:Date.now()+600000};
 }else if(path==='/api/embassy-host/invites')data=[];
 else if(path==='/api/embassy-host/lookup')data={requestId:${JSON.stringify(requestId)},state:'pending',guest:{company:'Student company',identity:'Student'},expiresAt:Date.now()+600000};
 else if(path==='/api/embassy-host/approve')data={state:'approved'};
 else if(path==='/api/embassy-host/reject')data={state:'rejected'};
 else if(path==='/api/embassy-pairing'&&opts.method==='POST')data={handle:${JSON.stringify(handle)},origin:${JSON.stringify(origin)},state:'pending',requestQr:${JSON.stringify(requestQr)},code:'3BCD-5FGH',room:{id:${JSON.stringify(roomId)},name:'Lab commons'},hostCompany:'Host company',expiresAt:Date.now()+600000};
 else if(path==='/api/embassy-pairing')data=[];
 else if(path==='/api/embassy-pairing/'+${JSON.stringify(handle)})data={handle:${JSON.stringify(handle)},state:opts.method==='DELETE'?e.cancelState:e.state,requestQr:${JSON.stringify(requestQr)},code:'3BCD-5FGH',expiresAt:Date.now()+600000,...(e.state==='connected'?{connectionId:${JSON.stringify(connectionId)}}:{})};
 else return {ok:false,status:404,json:async()=>({error:{code:'PAIR_NOT_FOUND'}})};
 return {ok:true,status:200,json:async()=>({success:true,data})};
};`;
export const startPairingPreview=()=>startEmbassyPreview({extraScript});
