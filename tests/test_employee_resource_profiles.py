import copy,os,tempfile,threading,unittest
from pathlib import Path
from reverie import employee_resource_profiles as m
E='11111111-1111-4111-8111-111111111111';F='22222222-2222-4222-8222-222222222222';A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';C='cccccccc-cccc-4ccc-8ccc-cccccccccccc'
R={'budgetMode':'admission','memoryMiB':38147,'pidsLimit':512,'cpus':0,'poolMemoryMiB':49152,'poolTasksMax':8192}
def bind(e=E,current=A,target=B):return {'employee_id':e,'current_sid':current,'target_sid':target,'current_generation':1,'target_generation':2}
class Controls(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name);self.store=m.ProfileStore(self.root);self.addCleanup(self.store.close)
 def save(self,**kw):return self.store.put(E,R,bind(),expected_revision=0,expected_profile_version=0,expected_binding=None,**kw)
 def test_persist_reload_and_new_sid_exact_policy(self):
  self.save();self.store.close();self.store=m.ProfileStore(self.root);self.addCleanup(self.store.close)
  config=dict(R,sessionResources={C:dict(R,memoryMiB=4096)})
  before=copy.deepcopy(config);r=self.store.stage_config(config,E,bind(),expected_revision=1,expected_profile_version=1,sid_owners={A:E,B:E})
  self.assertEqual(config,before);self.assertEqual(r['config']['sessionResources'][B],R);self.assertEqual(r['config']['sessionResources'][C],before['sessionResources'][C]);self.assertEqual(r['effective_policy_sha256'],m.policy_digest(r['config'],B));self.assertEqual(self.store.snapshot()['profiles'][E]['resources'],R)
 def test_central_pool_stages_global_copies_without_rewriting_canonical_profile(self):
  self.save();raw=(self.root/'profiles.json').read_bytes()
  config=dict(R,poolMemoryMiB=51200,poolTasksMax=4096,resourceReservations={'configured':True})
  result=self.store.stage_config(config,E,bind(),expected_revision=1,expected_profile_version=1,sid_owners={A:E,B:E})
  expected=dict(R,poolMemoryMiB=51200,poolTasksMax=4096)
  self.assertEqual(result['config']['employeeResources'][E],expected)
  self.assertEqual(result['config']['sessionResources'][B],expected)
  self.assertEqual((self.root/'profiles.json').read_bytes(),raw)
  self.assertEqual(self.store.snapshot()['profiles'][E]['resources'],R)
 def test_missing_profile_no_default(self):
  with self.assertRaisesRegex(m.Refusal,'NO_DEFAULT'):self.store.stage_config(R,E,bind(),expected_revision=0,expected_profile_version=0,sid_owners={A:E,B:E})
 def test_stale_cas_version_and_identity_refuse_no_write(self):
  self.save();raw=(self.root/'profiles.json').read_bytes()
  for revision,version,previous in [(0,1,bind()),(1,0,bind()),(1,1,None)]:
   with self.subTest(revision=revision,version=version),self.assertRaises(m.Refusal):self.store.put(E,R,bind(),expected_revision=revision,expected_profile_version=version,expected_binding=previous)
   self.assertEqual((self.root/'profiles.json').read_bytes(),raw)
 def test_unrelated_employee_profile_preserved(self):
  self.save();before=self.store.snapshot()['profiles'][E]
  self.store.put(F,dict(R,memoryMiB=8192),bind(F,C,C),expected_revision=1,expected_profile_version=0,expected_binding=None)
  self.assertEqual(self.store.snapshot()['profiles'][E],before)
 def test_same_sid_supported_and_foreign_sid_refuses(self):
  b=bind(target=A);self.store.put(E,R,b,expected_revision=0,expected_profile_version=0,expected_binding=None)
  with self.assertRaises(m.Refusal):self.store.stage_config(R,E,b,expected_revision=1,expected_profile_version=1,sid_owners={A:F})
  self.assertEqual(self.store.stage_config(R,E,b,expected_revision=1,expected_profile_version=1,sid_owners={A:E})['target_sid'],A)
 def test_stage_drift_refuses(self):
  self.save()
  for binding in [bind(target=C),dict(bind(),current_generation=2),dict(bind(),employee_id=F)]:
   with self.assertRaises(m.Refusal):self.store.stage_config(R,E,binding,expected_revision=1,expected_profile_version=1,sid_owners={A:E,B:E,C:E})
 def test_strict_schema_types_and_nonfinite_refuse(self):
  for resources in [dict(R,memoryMiB=True),dict(R,cpus=True),dict(R,cpus=float('nan')),dict(R,command='bad'),dict(R,memoryMiB=-1)]:
   with self.subTest(resources=resources),self.assertRaises((ValueError,TypeError)):self.store.put(E,resources,bind(),expected_revision=0,expected_profile_version=0,expected_binding=None)
  with self.assertRaises(m.Refusal):self.store.put(E,R,bind(),expected_revision=True,expected_profile_version=0,expected_binding=None)
 def test_duplicate_and_oversized_store_refuses(self):
  p=self.root/'profiles.json';p.write_bytes(b'{"revision":0,"revision":1}');p.chmod(0o600)
  with self.assertRaises(m.Refusal):self.store.snapshot()
  p.write_bytes(b'x'*(m.MAX_BYTES+1))
  with self.assertRaises(m.Refusal):self.store.snapshot()
 def test_symlink_fifo_and_bad_mode_refuse(self):
  p=self.root/'profiles.json';p.symlink_to('/dev/null')
  with self.assertRaises(OSError):self.store.snapshot()
  p.unlink();os.mkfifo(p,0o600)
  with self.assertRaises(m.Refusal):self.store.snapshot()
  p.unlink();self.save();p.chmod(0o644)
  with self.assertRaises(m.Refusal):self.store.snapshot()
 def test_concurrent_same_revision_at_most_one_commit(self):
  gate=threading.Barrier(2);out=[];errors=[]
  def go():
   s=m.ProfileStore(self.root)
   try:
    gate.wait(timeout=2);out.append(s.put(E,R,bind(),expected_revision=0,expected_profile_version=0,expected_binding=None))
   except (m.Refusal,BlockingIOError) as e:errors.append(type(e).__name__)
   finally:s.close()
  ts=[threading.Thread(target=go) for _ in range(2)]
  for t in ts:t.start()
  for t in ts:t.join(4)
  self.assertFalse(any(t.is_alive() for t in ts));self.assertEqual(len(out),1);self.assertEqual(len(errors),1);self.assertEqual(self.store.snapshot()['revision'],1)
 def test_rebound_directory_refuses(self):
  moved=self.root.with_name(self.root.name+'-moved');self.root.rename(moved)
  self.root.mkdir(mode=0o700)
  try:
   with self.assertRaises(m.Refusal):self.store.snapshot()
  finally:
   self.root.rmdir();moved.rename(self.root)
 def test_returned_values_are_copies(self):
  value=self.save();value['profiles'][E]['resources']['memoryMiB']=1
  self.assertEqual(self.store.snapshot()['profiles'][E]['resources'],R)
