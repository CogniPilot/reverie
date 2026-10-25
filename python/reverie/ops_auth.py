"""Ada canonical ServiceDecisions consumer. No grant issuer, alternate signing format or SID upgrade."""
import base64,hashlib,hmac,http.client,re,time,uuid
from .ops_common import *
from .worker_storage import read_metadata

class UnavailableAuth:
 def check(self,*args):return {'availability':'unavailable','reason':'adapter-unavailable','policyGeneration':ZERO}

class AdaServiceDecisions:
 """Exact E-AUTH r2b POST /api/service-decisions and service-assertion-v1.

The owner-selected binding references canonical grants; it creates none. Keys,
configured purpose/action registry and current company bindings are read afresh.
Missing install, unsupported scope, malformed/unavailable verifier always refuses.
"""
 def __init__(self,config,company_file,company_id,uid,custody=lambda:None):
  require(isinstance(config,dict) and set(config) in ({'host','port','config','principal','ownerId','grants'},{'host','port','config','principal','ownerId','grants','goalPrivateConfig'}));require(config['host'] in ('127.0.0.1','::1') and type(config['port']) is int and 1<=config['port']<=65535,'custody-invalid')
  require(isinstance(config['principal'],str) and re.fullmatch('[A-Za-z0-9_.:-]{1,56}',config['principal']),'custody-invalid');require(isinstance(config['ownerId'],str) and (config['ownerId']=='' or re.fullmatch('[A-Za-z0-9_.:-]{1,100}',config['ownerId'])),'custody-invalid');require(isinstance(config['grants'],dict) and set(config['grants'])<=set(ACTIONS),'custody-invalid')
  self.config=config;self.company=company_file;self.company_id=company_id;self.uid=uid;self.custody=custody
 def check(self,actor,action,resource,grant,artifact):
  connection=None
  try:
   self.custody();cfg=self.config;loaded=strict_json(private_read(cfg['config'],65536,self.uid));require(loaded.get('version')==1,'adapter-unavailable')
   purposes=[(purpose,value) for purpose,value in loaded['purposes'].items() if value.get('action')==action];require(len(purposes)==1,'adapter-unavailable');purpose,policy=purposes[0]
   # OPS requires BOTH a current employee and named resource; resource-only service grants cannot impersonate callers.
   require(policy.get('scope')=='employees+resources','adapter-unavailable')
   principals=[p for p in loaded['principals'] if p.get('principal')==cfg['principal']];require(len(principals)==1,'adapter-unavailable');principal=principals[0]
   selected=cfg['grants'].get(action);require(isinstance(selected,str) and ID.fullmatch(selected),'adapter-unavailable')
   if grant:require(grant['grantId']==selected,'unauthorized')
   state=read_metadata(self.company,self.uid);rows=[e for e in state['employees'] if e.get('id')==actor['employeeId']];require(len(rows)==1,'stable-identity-unavailable');row=rows[0]
   from .ops_core import current_actor
   require(current_actor(self.company,self.company_id,row['sessionId'],self.uid)==actor,'stable-identity-unavailable');require(type(row.get('sessionGeneration')) is int and row['sessionGeneration']>0,'stable-identity-unavailable')
   expected={'employeeId':row['id'],'sessionId':row['sessionId'],'sessionGeneration':row['sessionGeneration']}
   key=private_read(principal['key'],32,self.uid);require(len(key)==32,'custody-invalid');issued=int(time.time()*1000)
   fields=[1,'service-assertion',purpose,cfg['principal'],principal['epoch'],cfg['ownerId'],selected,issued,issued+5000,uuid.uuid4().hex]
   payload=base64.urlsafe_b64encode(json.dumps(fields,separators=(',',':'),ensure_ascii=False).encode()).rstrip(b'=').decode();assertion=payload+'.'+hmac.new(key,('reverie-service-assertion-v1\n'+payload).encode(),hashlib.sha256).hexdigest()
   body=canonical({'action':action,'employeeId':row['id'],'resourceId':resource});connection=http.client.HTTPConnection(cfg['host'],cfg['port'],timeout=3)
   connection.request('POST','/api/service-decisions',body,{'Content-Type':'application/json','x-reverie-service-assertion':assertion});response=connection.getresponse();raw=response.read(16385);require(response.status==200 and len(raw)<=16384,'adapter-unavailable');decision=strict_json(raw)
   shape(decision,('decision','reason','grantRef','epoch','actor'));require(decision['decision'] in ('allowed','denied') and decision['reason'] in ('none','unauthorized'),'adapter-unavailable');require((decision['decision']=='allowed')==(decision['reason']=='none'),'adapter-unavailable')
   require(decision['actor']==expected,'stable-identity-unavailable');shape(decision['grantRef'],('grantId','policyGeneration'));require(decision['grantRef']['grantId']==selected,'unauthorized');sha(decision['grantRef']['policyGeneration']);require(decision['epoch']==principal['epoch'],'stale-policy')
   if grant:require(decision['grantRef']==grant,'stale-policy')
   # Re-read canonical current binding after verifier IO; a plan move must not slip between decision and effect.
   require(current_actor(self.company,self.company_id,row['sessionId'],self.uid)==actor,'stable-identity-unavailable')
   return {'availability':'allowed' if decision['decision']=='allowed' else 'denied','reason':decision['reason'],'policyGeneration':decision['grantRef']['policyGeneration'],'grantRef':decision['grantRef'],'epoch':decision['epoch'],'actor':decision['actor']}
  except Refusal as e:
   # Invalid/missing/authentication/expired assertions return bare403: unavailable, never guess an allow/deny.
   if e.reason in ('unauthorized','stale-policy','stable-identity-unavailable'):return {'availability':'denied','reason':e.reason,'policyGeneration':ZERO}
   return {'availability':'unavailable','reason':e.reason if e.reason in REASONS else 'adapter-unavailable','policyGeneration':ZERO}
  except Exception:return {'availability':'unavailable','reason':'adapter-unavailable','policyGeneration':ZERO}
  finally:
   if connection:connection.close()
