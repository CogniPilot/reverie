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

class UnavailableBody(unittest.TestCase):
 """Real local HTTP framing; unavailable ops never forwards or parses commands."""
 def setUp(self):
  import threading
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name).resolve()
  self.reading=threading.Event();self.second_read=threading.Event();self.reads=[];self.received=[]
  self.office=OfficeAPI(self.root/'phone',SID,lambda:(_ for _ in ()).throw(AssertionError('website touched')),self.root)
  self.addCleanup(self.office.close);handler=self.office.server.RequestHandlerClass;test=self
  class Observed(handler):
   def setup(self):
    super().setup();original=self.rfile;connection=self.connection
    class Reader:
     def __getattr__(self,name):return getattr(original,name)
     def read1(self,size):
      test.reads.append((size,connection.gettimeout()));test.reading.set()
      if len(test.reads)>1:test.second_read.set()
      value=original.read1(size);test.received.append(len(value));return value
    self.rfile=Reader()
  self.office.server.RequestHandlerClass=Observed
 def connect(self,length=4,*,method='POST',path='/api/ops',extra=b''):
  client=socket.socket(socket.AF_UNIX);client.settimeout(30);self.addCleanup(client.close)
  client.connect(str(self.root/'phone/office.sock'))
  request=f'{method} {path} HTTP/1.1\r\nHost: localhost\r\nContent-Length: {length}\r\n'.encode()+extra+b'\r\n'
  client.sendall(request);return client
 def response(self,client):
  response=http.client.HTTPResponse(client);response.begin();status=response.status;response.read();response.close();return status
 def test_split_body_finishes_before_confirmed_unavailable_response(self):
  import select
  client=self.connect();self.assertTrue(self.reading.wait(3),'bounded body read was never reached')
  self.assertEqual(select.select([client],[],[],0)[0],[])
  client.sendall(b'a');self.assertTrue(self.second_read.wait(3))
  self.assertEqual(select.select([client],[],[],0)[0],[])
  client.sendall(b'bcd');self.assertEqual(self.response(client),503);self.assertEqual(sum(self.received),4)
  self.assertTrue(all(size<=4096 for size,_ in self.reads))
 def test_exact_sixteen_KiB_invalid_json_is_discarded_without_command_parser(self):
  from unittest.mock import patch
  client=self.connect(16*1024)
  with patch('reverie.ops_common.strict_json',side_effect=AssertionError('unavailable ops parser called')):
   client.sendall(b'x'*(16*1024));self.assertEqual(self.response(client),503)
  self.assertEqual(sum(self.received),16*1024);self.assertTrue(all(size<=4096 for size,_ in self.reads))
 def test_invalid_framing_or_route_refuses_without_reading_or_forwarding(self):
  for options,expected in [({'length':16*1024+1},400),({'method':'GET'},400),({'path':'/api/ops?unexpected=1'},400),({'extra':b'Content-Length: 4\r\n'},400),({'extra':b'Transfer-Encoding: chunked\r\n'},413)]:
   with self.subTest(options=options):
    client=self.connect(**options);self.assertEqual(self.response(client),expected);self.assertEqual(self.reads,[])
 def test_incomplete_eof_is_bad_framing_not_a_confirmed_unavailable_request(self):
  client=self.connect();client.sendall(b'a');client.shutdown(socket.SHUT_WR)
  self.assertEqual(self.response(client),400);self.assertEqual(sum(self.received),1)
 def test_real_slow_body_keeps_one_absolute_fifteen_second_deadline(self):
  import time
  client=self.connect();self.assertTrue(self.reading.wait(3),'bounded body read was never reached')
  started=time.monotonic();time.sleep(5);client.sendall(b'a');self.assertTrue(self.second_read.wait(3))
  # A new per-read15s would incorrectly grant another full window here.
  self.assertLess(self.reads[1][1],12);self.assertEqual(client.recv(1),b'')
  self.assertGreater(time.monotonic()-started,13);self.assertEqual(sum(self.received),1)
