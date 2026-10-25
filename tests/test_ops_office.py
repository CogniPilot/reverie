import http.client,json,os,socket,tempfile,unittest
from pathlib import Path
from reverie.worker import OfficeAPI,Broker
from reverie.ops_common import ACTIONS
SID='11111111-1111-4111-8111-111111111111'
class UnixHTTP(http.client.HTTPConnection):
 def __init__(self,path):super().__init__('localhost',timeout=3);self.path=path
 def connect(self):self.sock=socket.socket(socket.AF_UNIX);self.sock.connect(str(self.path))
class Office(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name).resolve();self.calls=[]
 def request(self,office,body,headers=None,path='/api/ops'):
  client=UnixHTTP(self.root/'phone/office.sock');client.request('POST',path,json.dumps(body),headers or {});response=client.getresponse();result=(response.status,response.read());client.close();return result
 def test_fixed_phone_sid_not_headers_and_no_website_dependency(self):
  def callback(session,command):self.calls.append((session,command));return {'success':True,'data':{'fixedPhone':True}}
  office=OfficeAPI(self.root/'phone',SID,lambda:(_ for _ in ()).throw(AssertionError('website touched')),self.root,ops=callback);self.addCleanup(office.close)
  command={'kind':'reverie.ops.command','version':1,'requestId':'status-1','action':ACTIONS[0],'resourceId':'website'}
  status,body=self.request(office,command,{'X-Reverie-Parent-Session':'forged','Authorization':'forged','Cookie':'forged'});self.assertEqual(status,200);self.assertEqual(self.calls,[(SID,command)]);self.assertTrue(json.loads(body)['success'])
 def test_missing_binding_unavailable_and_extra_identity_refuses(self):
  office=OfficeAPI(self.root/'phone',SID,'127.0.0.1',self.root);self.addCleanup(office.close)
  command={'kind':'reverie.ops.command','version':1,'requestId':'status-1','action':ACTIONS[0],'resourceId':'website'};self.assertEqual(self.request(office,command)[0],503)
 def test_caller_identity_field_never_reaches_host(self):
  office=OfficeAPI(self.root/'phone',SID,'127.0.0.1',self.root,ops=lambda *args:self.calls.append(args));self.addCleanup(office.close)
  command={'kind':'reverie.ops.command','version':1,'requestId':'status-1','action':ACTIONS[0],'resourceId':'website','actor':{'owner':True}};status,body=self.request(office,command);self.assertEqual(status,200);self.assertFalse(json.loads(body)['success']);self.assertEqual(self.calls,[])
 def test_legacy_restart_cannot_bypass_enabled_ops_fence(self):
  broker=Broker({'maxWorkers':1,'opsConfig':'/unavailable','maintenanceSessions':[SID]})
  for caller in (None,SID):
   with self.assertRaises(ValueError):broker.control('restart-website',caller)
if __name__=='__main__':unittest.main()

class BrokerConfiguration(unittest.TestCase):
 def test_real_load_config_accepts_only_typed_private_ops_binding(self):
  from reverie.worker import load_config
  from reverie.ops_common import canonical
  with tempfile.TemporaryDirectory() as temp:
   root=Path(temp).resolve();(root/'work').mkdir();company=root/'company.json';company.write_text('{"employees":[]}');company.chmod(0o600)
   config=dict(version=1,deployment='test',image='sha256:'+'a'*64,serverContainer='test-console',socket='/run/reverie-ops-fixture.sock',stateRoot=str(root/'workers'),companyFile=str(company),companyRoot=str(root/'company'),scratchRoot=str(root/'scratch'),apiSocketRoot=str(root/'office'),budgetMode='pool',uid=os.getuid() or 1000,gid=os.getgid() or 1000,memoryMiB=0,poolMemoryMiB=4096,poolTasksMax=1024,cgroupParent='reverie-workers.slice',pidsLimit=128,cpus=0,maxWorkers=4,maintenanceSessions=[],mounts=[dict(source=str(root/'work'),destination='/workspace',readOnly=False)])
   broker=root/'broker.json';ops=root/'ops.json';value={'version':1,'companyId':'test','companyFile':str(company),'brokerConfig':str(broker),'stateDirectory':str(root/'private/state'),'socketDirectory':str(root/'private/socket'),'requestKey':str(root/'private/request.key'),'engineBinary':'/immutable/engine','engineSocket':'/private/engine.sock','engineConfigDirectory':str(root/'private/engine'),'resources':{'website':{}},'authorization':None,'packageManifest':'/immutable/manifest.json'};ops.write_bytes(canonical(value));ops.chmod(0o600)
   def load(extra):broker.write_bytes(canonical({**config,**extra}));broker.chmod(0o600);return load_config(broker)
   self.assertEqual(load({'opsConfig':str(ops)})['opsConfig'],str(ops));self.assertNotIn('opsConfig',load({}))
   for bad in (None,123,[],{},False,'relative','/private/invalid\npath'):
    with self.subTest(value=bad),self.assertRaises(ValueError):load({'opsConfig':bad})
   with self.assertRaises(ValueError):load({'opsConfig':str(ops),'unknownOpsAuthority':True})
