"""Concrete fixed adapter with an injected engine; never invokes a real engine."""
import contextlib,copy,hashlib,os,tempfile,unittest,uuid
from pathlib import Path
from reverie.ops_common import *
from reverie.ops_adapter import DockerWebsite
from reverie.ops_classifier import WorkerClassifier,method_source
class Engine:
 def __init__(self):self.calls=[];self.webpid=100;self.started='first';self.code=0;self.drop=False;self.names=[];self.diag_match=True
 @contextlib.contextmanager
 def budget(self,n):yield
 def run(self,args,**kw):
  self.calls.append(list(args))
  if args[:2] in (['ps','-a'],['ps','--all']):return 0,b'',b''
  if args[0]=='version':return 0,b'29.0.0\n',b''
  if args[0]=='restart':self.webpid=101;self.started='second';return self.code,b'',b''
  if args[0]=='ps':return 0,(('c'*64)+'\n').encode(),b''
  if args[0]=='top':return 0,b'PID STARTED COMMAND\n200 Mon Jan 1 00:00:00 2026 codex\n',b''
  if args[0]=='inspect':
   identity=args[-1]
   if identity.startswith('reverie-ops-absent-'):return 1,b'',(('Error: No such object: ' if self.diag_match else 'Some unknown daemon failure: ')+identity).encode()
   if identity=='d'*64:return 0,canonical([{'Id':identity,'Image':'sha256:'+'e'*64,'State':{'Running':True,'Pid':self.webpid,'StartedAt':self.started},'Config':{'Labels':{}}}]),b''
   return 0,canonical([{'Id':'c'*64,'Image':'sha256:'+'f'*64,'State':{'Running':True,'Pid':201,'StartedAt':'worker-first'},'Config':{'Labels':{'reverie.worker':'owned','reverie.session':'11111111-1111-4111-8111-111111111111'}}}]),b''
  raise AssertionError(args)
class Adapter(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name).resolve();self.company=self.root/'company.json';self.company.write_bytes(canonical({'employees':[{'id':'22222222-2222-4222-8222-222222222222','sessionId':'11111111-1111-4111-8111-111111111111','runtimeRecipe':{'provider':'owned-fixture'}}]}));self.company.chmod(0o600)
  self.engine=Engine();self.art={'artifactId':'website-current','digest':'sha256:'+'e'*64,'reviewId':'reviewed'};self.cfg={'containerId':'d'*64,'image':'sha256:'+'e'*64,'deployment':'owned','employees':['22222222-2222-4222-8222-222222222222'],'readiness':{'host':'127.0.0.1','port':3000,'path':'/api/status'},'catalogue':{ACTIONS[3]:self.art},'schemaEpoch':'goal-r3'};self.adapter=DockerWebsite(self.cfg,self.engine,self.company,os.getuid(),ready=lambda:True);self.adapter.process=lambda pid:{'pid':pid,'startTicks':pid*10};self.begun=[]
 def fixture_classifier(self):
  from pathlib import Path
  import json
  import ast
  from reverie import ops_worker_classifier
  source=Path(ops_worker_classifier.__file__);text=source.read_text();node=next(n for n in ast.parse(text).body if isinstance(n,ast.FunctionDef) and n.name=='inspect_container');method=ast.get_source_segment(text,node);pin={'methodSha256':hashlib.sha256(method.encode()).hexdigest()}
  classifier=WorkerClassifier(pin,'/unused','/unused');classifier.binding=lambda:({'pid':999,'sourceSha256':hashlib.sha256(text.encode()).hexdigest(),'methodSha256':pin['methodSha256']},method);return classifier
 def test_restart_exact_id_new_process_ready_and_preserved(self):
  before=self.adapter.snapshot();state,reason,ev,after=self.adapter.execute(ACTIONS[3],self.art,before,lambda:self.begun.append(True));self.assertEqual(state,'verified');self.assertEqual(self.begun,[True]);self.assertIn(['restart','--time','20','d'*64],self.engine.calls);self.assertNotEqual(after,self.adapter.generation(before));self.assertEqual({e['check'] for e in ev},{'artifact-matches','website-process-changed','application-ready','laptops-preserved','providers-preserved'})
 def test_nonzero_after_mutation_is_unconfirmed_never_failed(self):
  before=self.adapter.snapshot();self.engine.code=1;r=self.adapter.execute(ACTIONS[3],self.art,before,lambda:self.begun.append(True));self.assertEqual(r[0],'unconfirmed');self.assertIsNone(r[3]);self.assertEqual(self.engine.webpid,101)
 def test_provider_or_process_loss_cannot_verify(self):
  before=self.adapter.snapshot();self.adapter.preservation=lambda a,b:(True,False);r=self.adapter.execute(ACTIONS[3],self.art,before,lambda:None);self.assertEqual(r[0],'unconfirmed')
 def test_changed_artifact_and_epoch_are_binding_fences(self):
  before=self.adapter.snapshot();cfg=copy.deepcopy(self.cfg);cfg['schemaEpoch']='pre-goal';other=DockerWebsite(cfg,self.engine,self.company,os.getuid());self.assertNotEqual(other.binding_digest(),self.adapter.binding_digest())
  with self.assertRaises(Refusal):self.adapter.execute(ACTIONS[3],dict(self.art,digest='sha256:'+'a'*64),before,lambda:self.begun.append(True))
  self.assertEqual(self.begun,[])
 def test_g1_uses_generated_absent_name_only_read_only_argv(self):
  ref={'artifactId':'container-absence-diagnostic','digest':self.adapter.suite_digest(),'reviewId':'g1-review'};self.cfg['catalogue'][ACTIONS[2]]=ref;self.adapter.classifier=self.fixture_classifier();before=self.adapter.snapshot();self.engine.calls=[];r=self.adapter.execute(ACTIONS[2],ref,before,lambda:None);self.assertEqual(r[0],'verified');self.assertTrue(all(args[0] in ('inspect','ps','version','top') for args in self.engine.calls));self.assertTrue(any(e['check']=='container-absence-diagnostic' and e['diagnostic']['matched'] for e in r[2]))
 def test_g1_unrecognized_diagnostic_is_known_safe_failed(self):
  ref={'artifactId':'container-absence-diagnostic','digest':self.adapter.suite_digest(),'reviewId':'g1-review'};self.cfg['catalogue'][ACTIONS[2]]=ref;self.adapter.classifier=self.fixture_classifier();before=self.adapter.snapshot();self.engine.diag_match=False;r=self.adapter.execute(ACTIONS[2],ref,before,lambda:None);self.assertEqual(r[0],'failed');self.assertEqual(r[1],'selftest-failed');self.assertTrue(any(e['check']=='resource-state-known' for e in r[2]))
 def test_unknown_catalogue_or_no_review_no_support(self):
  self.assertFalse(self.adapter.supports(ACTIONS[2]));self.assertFalse(self.adapter.artifact(ACTIONS[3],dict(self.art,reviewId='unknown')))
 def test_caller_url_or_arbitrary_extra_resource_config_refuses(self):
  with self.assertRaises(Refusal):DockerWebsite(dict(self.cfg,argv=['unsafe']),self.engine,self.company,os.getuid())
  cfg=copy.deepcopy(self.cfg);cfg['readiness']['host']='outside.example'
  with self.assertRaises(Refusal):DockerWebsite(cfg,self.engine,self.company,os.getuid())
if __name__=='__main__':unittest.main()
