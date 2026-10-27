"""Canonical assertion/HTTP contract; synthetic canonical authority only, never owner grants."""
import base64,hashlib,hmac,http.server,json,os,tempfile,threading,time,unittest,uuid
from pathlib import Path
from reverie.ops_auth import ServiceDecisionsAuth
from reverie.ops_core import current_actor,Core,Ledger
from reverie.ops_common import *
SID='11111111-1111-4111-8111-111111111111';EID='22222222-2222-4222-8222-222222222222'
class Auth(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name).resolve();self.key=os.urandom(32);self.keyfile=self.root/'ops.key';self.keyfile.write_bytes(self.key);self.keyfile.chmod(0o600);self.nonces=set();self.seen=[];self.mode='allow';self.owner='owner-1';outer=self
  self.company=self.root/'company.json';self.company.write_bytes(canonical({'employees':[{'id':EID,'sessionId':SID,'sessionGeneration':1,'desiredRunning':True,'owner':'owner-1'}],'retired':[]}));self.company.chmod(0o600)
  self.purposes={action:'OPS_'+str(i) for i,action in enumerate(ACTIONS)};self.grants={action:'grant-'+str(i) for i,action in enumerate(ACTIONS)};self.generations={action:digest({'grant':g}) for action,g in self.grants.items()}
  loaded={'version':1,'principals':[{'principal':'ops','epoch':'epoch-1','key':str(self.keyfile)}],'purposes':{p:{'scope':'employees+resources','action':a} for a,p in self.purposes.items()},'nonce':{'file':str(self.root/'canonical-nonces.json')}};self.config=self.root/'service-auth.json';self.config.write_bytes(canonical(loaded));self.config.chmod(0o600)
  class Handler(http.server.BaseHTTPRequestHandler):
   def log_message(self,*args):pass
   def do_POST(self):
    try:
     assert self.path=='/api/service-decisions';assert not self.headers.get('Authorization');header=self.headers['x-reverie-service-assertion'];payload,signature=header.split('.');assert hmac.compare_digest(signature,hmac.new(outer.key,('reverie-service-assertion-v1\n'+payload).encode(),hashlib.sha256).hexdigest());fields=json.loads(base64.urlsafe_b64decode(payload+'='*((-len(payload))%4)));assert len(fields)==10 and fields[:2]==[1,'service-assertion'];assert fields[3:6]==['ops','epoch-1',outer.owner];assert fields[7]<=time.time()*1000<=fields[8] and fields[8]-fields[7]<=10000;assert len(fields[9])==32 and fields[9] not in outer.nonces;outer.nonces.add(fields[9]);body=json.loads(self.rfile.read(int(self.headers['Content-Length'])));assert set(body)=={'action','employeeId','resourceId'};assert body['employeeId']==EID;assert fields[2]==outer.purposes[body['action']] and fields[6]==outer.grants[body['action']];outer.seen.append((fields,body))
     if outer.mode=='unavailable':self.send_response(403);self.end_headers();return
     value={'decision':'denied' if outer.mode=='denied' else 'allowed','reason':'unauthorized' if outer.mode=='denied' else 'none','grantRef':{'grantId':fields[6],'policyGeneration':outer.generations[body['action']]},'epoch':'epoch-1','actor':{'employeeId':EID,'sessionId':SID,'sessionGeneration':1}}
     if outer.mode=='wrong-session':value['actor']['sessionId']=str(uuid.uuid4())
     if outer.mode=='wrong-generation':value['actor']['sessionGeneration']=2
     if outer.mode=='wrong-epoch':value['epoch']='epoch-2'
     if outer.mode=='extra':value['private']='not allowed'
     raw=canonical(value);self.send_response(200);self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
    except Exception:self.send_response(403);self.end_headers()
  self.server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler);self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start();self.addCleanup(self.close)
  cfg={'host':'127.0.0.1','port':self.server.server_port,'config':str(self.config),'principal':'ops','ownerId':'owner-1','grants':self.grants};self.client=ServiceDecisionsAuth(cfg,self.company,'owned',os.getuid());self.actor=current_actor(self.company,'owned',SID,os.getuid())
 def close(self):self.server.shutdown();self.server.server_close();self.thread.join(5)
 def call(self,grant=None):return self.client.check(self.actor,ACTIONS[3],'website',grant,None)
 def test_exact_assertion_and_strict_body_from_transport_identity(self):
  r=self.call();self.assertEqual(r['availability'],'allowed');fields,body=self.seen[0];self.assertEqual(body,{'action':ACTIONS[3],'employeeId':EID,'resourceId':'website'});self.assertEqual(fields[2],self.purposes[ACTIONS[3]]);self.assertEqual(r['actor']['sessionId'],SID)
 def test_current_session_generation_epoch_and_unknown_fields_refuse(self):
  for mode in ('wrong-session','wrong-generation','wrong-epoch','extra'):
   with self.subTest(mode=mode):self.mode=mode;self.assertNotEqual(self.call()['availability'],'allowed')
 def test_denied_and_unavailable_are_distinct(self):
  self.mode='denied';self.assertEqual(self.call()['availability'],'denied');self.mode='unavailable';self.assertEqual(self.call()['availability'],'unavailable')
 def test_new_assertion_nonce_every_call_and_exact_grant_generation(self):
  grant={'grantId':self.grants[ACTIONS[3]],'policyGeneration':self.generations[ACTIONS[3]]};self.assertEqual(self.call(grant)['availability'],'allowed');self.assertEqual(self.call(grant)['availability'],'allowed');self.assertNotEqual(self.seen[0][0][9],self.seen[1][0][9]);self.assertNotEqual(self.call(dict(grant,policyGeneration='sha256:'+'f'*64))['availability'],'allowed')
 def test_removed_key_does_not_fall_back_to_cached_or_legacy_permission(self):
  self.assertEqual(self.call()['availability'],'allowed');self.keyfile.unlink();self.assertEqual(self.call()['availability'],'unavailable')
 def test_single_owner_empty_owner_id_uses_exact_r2d_wire(self):
  self.owner='';state=json.loads(self.company.read_bytes());state['employees'][0].pop('owner');self.company.write_bytes(canonical(state));actor=current_actor(self.company,'owned',SID,os.getuid());cfg=dict(self.client.config,ownerId='');client=ServiceDecisionsAuth(cfg,self.company,'owned',os.getuid());self.assertEqual(client.check(actor,ACTIONS[3],'website',None,None)['availability'],'allowed');self.assertEqual(self.seen[0][0][5],'')
 def test_resource_only_scope_cannot_stand_in_for_employee_authority(self):
  value=json.loads(self.config.read_bytes());value['purposes'][self.purposes[ACTIONS[3]]]['scope']='resources';self.config.write_bytes(canonical(value));self.assertEqual(self.call()['availability'],'unavailable')
if __name__=='__main__':unittest.main()
