import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

/** Own fixture only: complete installed policy port; no capability bypass. */
export function ownerPolicyDependencies(service,ctx,sessions) {
  return {service,ctx,isCapabilityRequest:()=>false,relations:{
    known:id=>sessions.has(id),related:(caller,target)=>caller===target,
    coordinated:()=>false,upward:()=>false,keeper:()=>false,admin:()=>false}};
}
export const ownerRequestOrigin=()=>({host:'localhost',origin:'http://localhost'});
export const verifiedFixtureOwner=(service,cookie)=>req=>
  service.session(req.cookies?.[cookie])?.restricted===false&&service.identity(req.cookies?.[cookie])?.role==='owner';
const digest=value=>createHash('sha256').update(value).digest('hex');
/** Never include credentials, headers, arbitrary error text or body values. */
export function safeHttpObservation(response) {
  const raw=String(response.body??'');let body;
  if(Buffer.byteLength(raw)<=32768)try{body=JSON.parse(raw);}catch{}
  const message=typeof body?.message==='string'?body.message:'';
  const error=typeof body?.error==='string'?body.error:'';
  return {status:response.statusCode,bodyBytes:Buffer.byteLength(raw),bodySHA256:digest(raw),
    json:body!==undefined,fields:['statusCode','code','error','message','success','data'].filter(key=>body&&Object.hasOwn(body,key)),
    code:typeof body?.code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(body.code)?body.code:null,
    errorClass:['Internal Server Error','Bad Request','Forbidden','Unauthorized'].includes(error)?error:'OTHER_OR_ABSENT',
    messageBytes:Buffer.byteLength(message),messageSHA256:digest(message),
    messageClass:message==='deps.isCapabilityRequest is not a function'?'OWNER_POLICY_CAPABILITY_PREDICATE_MISSING':'UNCLASSIFIED_OR_ABSENT'};
}

export function canaryEntry(base, bin) {
  const entry=structuredClone(base);
  Object.assign(entry,{id:'sb-canary',label:'Isolated stale-busy canary',shortBadge:'SB',stock:false,enabled:true,kind:'agent'});
  entry.discovery={binaries:['sb-canary'],searchDirs:[bin],install:{command:{}}};
  entry.launch={params:{},variants:[{id:'owned',args:[{lit:'sb-canary'}]}]};
  entry.capabilities={...entry.capabilities,external:true,hooks:'none',transcript:'none',
    requiresMux:true,startMode:'interactive',respawn:false,agentSkillInjection:false,
    statusLineTelemetry:false,model:{source:'none'},modelDetect:undefined,privilegedParams:[],
    privilegedEnvKeys:[],privilegedCommandGate:false,
    customModelInjection:{kind:'env',baseUrlVar:'SB_BASE_URL',apiKeyVar:'SB_PLACEHOLDER',modelVars:['SB_MODEL'],launchModel:'fixture-model'},
    workDetect:{promptGlyph:'SB_READY',workingLine:'SB_ACTIVE'}};
  delete entry.capabilities.mcpConfig;
  entry.env={exports:[],unset:[],tmuxSetenvKeys:['SB_BASE_URL','SB_PLACEHOLDER','SB_MODEL'],
    dockerExecEnvNames:[],allowedPrefixes:['SB_'],allowedKeys:[]};
  return entry;
}

export function processSame(before,after) { return before.pid===after.pid && before.startTick===after.startTick; }
export function assertStaleIdle(session, eligibility, programPhase, now=Date.now()) {
  assert.equal(programPhase,'idle');assert.equal(session.runningTaskCount,0);
  assert.equal(session.isWorking,true);assert.equal(session.isBusy(),true);
  assert(now-session.lastActivityAt>=120000);assert(now-session.lastSubmitAt>=120000);
  assert.deepEqual(eligibility,{blocked:true,recoverable:true});
}
