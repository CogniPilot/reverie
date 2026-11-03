"""Owned files and fault ports; no Docker, systemd, live helper or instance IO."""
import copy,json,os,tempfile,time,unittest
from pathlib import Path
from unittest.mock import patch
from reverie import worker_transport_maintenance as M

class FakePorts:
 def __init__(self,p):
  self.p=p;self.calls=[];self.paused=False;self.failure=None;self.phase=None
  self.site={'Id':p['website']['id'],'Image':'sha256:'+'b'*64,'Config':{'User':'synthetic'},'HostConfig':{'Memory':1024},'Mounts':[],'State':{'Paused':False}}
  self.baseline={'generation':p['generation'],'engine':{'engineId':'synthetic'},'protected':{'company':{'sha256':'allfields'}},'native':{'providers':p['providers']},'broker':{'process':{'pid':12,'startTick':1}}}
 def step(self,name):
  self.calls.append(name)
  if self.phase:self.phase(name)
  if self.failure==name:raise RuntimeError('controlled '+name)
 def snapshot(self):self.step('snapshot');return copy.deepcopy(self.baseline)
 def inspect(self):self.step('inspect');v=copy.deepcopy(self.site);v['State']['Paused']=self.paused;return v
 def arm(self):self.step('arm')
 def pause(self):self.step('pause');self.paused=True
 def unpause(self):self.step('unpause');self.paused=False
 def cancel(self):self.step('cancel')
 def abandon(self):self.step('abandon')
 def helper_settled(self):self.step('helper_settled');return True
 def helper(self,action,sha=None):
  self.step(action)
  if action=='prepare':
   self.plan={'kind':M.T.KIND,'expiresAt':time.time()+300,'selection':{'providerPIDs':[31]},**copy.deepcopy(self.baseline)}
   return {'planSHA256':M.digest(M.encoded(self.plan)),'effects':False,'configUnchanged':True}
  return {'state':'TRANSPORT_REPLACED','configUnchanged':True,'workerEffects':False,'noWakeCommand':True}
 def prepared(self):self.step('prepared');return copy.deepcopy(self.plan)

class Maintenance(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name).resolve();self.root.chmod(0o700)
  run=self.root/'controller';run.mkdir(mode=0o700);operation=self.root/'operation';operation.mkdir(mode=0o700)
  self.p={'expiresAtEpoch':time.time()+300,'directory':str(run),'operation':str(operation),'website':{'id':'a'*64},'generation':{'configSHA256':'c'*64},'config':{'sha256':'c'*64},'providers':[{'pid':31,'startTick':2}]}
  self.io=FakePorts(self.p);self.controller=M.Controller(self.p,self.io)
 def test_success_pauses_only_once_and_unpauses_before_cancel(self):
  result=self.controller.execute();self.assertEqual(result['state'],'TRANSPORT_REPLACED')
  self.assertFalse(self.io.paused);self.assertEqual(self.io.calls.count('pause'),1)
  self.assertLess(self.io.calls.index('arm'),self.io.calls.index('pause'))
  self.assertLess(self.io.calls.index('unpause'),self.io.calls.index('cancel'))
  self.assertTrue((Path(self.p['directory'])/'DONE.json').exists())
  review=json.loads((Path(self.p['directory'])/'REVIEW-SUMMARY.json').read_bytes());self.assertTrue(review['wholeCompanyIncluded'])
 def test_failure_at_each_effect_stage_always_unpauses_and_never_done(self):
  for stage in ('arm','pause','prepare','prepared','apply'):
   with self.subTest(stage=stage):
    self.setUp();self.io.failure=stage
    with self.assertRaises(RuntimeError):self.controller.execute()
    self.assertIn('unpause',self.io.calls);self.assertFalse(self.io.paused)
    self.assertTrue((Path(self.p['directory'])/'ATTEMPT.json').exists());self.assertFalse((Path(self.p['directory'])/'DONE.json').exists())
 def test_signal_exception_unpauses_without_replay(self):
  def phase(name):
   if name=='apply':raise KeyboardInterrupt
  self.io.phase=phase
  with self.assertRaises(KeyboardInterrupt):self.controller.execute()
  self.assertFalse(self.io.paused);self.assertEqual(self.io.calls.count('apply'),1)
  with self.assertRaisesRegex(ValueError,'CONTROLLER_ALREADY_CONSUMED'):self.controller.execute()
 def test_custody_unknown_refuses_before_watchdog_or_pause(self):
  self.io.failure='snapshot'
  with self.assertRaises(RuntimeError):self.controller.execute()
  self.assertNotIn('arm',self.io.calls);self.assertNotIn('pause',self.io.calls)
  self.assertFalse((Path(self.p['directory'])/'ATTEMPT.json').exists())
 def test_whole_company_churn_is_not_excluded(self):
  def phase(name):
   if name=='pause':self.io.baseline['protected']['company']['sha256']='different-counter'
  self.io.phase=phase
  with self.assertRaisesRegex(ValueError,'FULL_BASELINE_CHANGED_AFTER_PAUSE'):self.controller.execute()
  self.assertNotIn('prepare',self.io.calls);self.assertFalse(self.io.paused)
 def test_native_provider_drift_after_prepare_refuses_apply(self):
  def phase(name):
   if name=='prepared':self.io.baseline['native']['providers'][0]['startTick']=999
  self.io.phase=phase
  with self.assertRaisesRegex(ValueError,'FULL_BASELINE_CHANGED_AFTER_PREPARE'):self.controller.execute()
  self.assertNotIn('apply',self.io.calls);self.assertFalse(self.io.paused)
 def test_prepared_unlisted_plan_is_not_auto_applied(self):
  def phase(name):
   if name=='prepared':self.io.plan['extra']='unknown'
  self.io.phase=phase
  with self.assertRaisesRegex(ValueError,'PREPARED_PLAN_SCHEMA'):self.controller.execute()
  self.assertNotIn('apply',self.io.calls);self.assertFalse(self.io.paused)
 def test_changed_generation_cannot_be_whitelisted(self):
  def phase(name):
   if name=='prepared':self.io.plan['generation']['unexpected']='other'
  self.io.phase=phase
  with self.assertRaises(ValueError):self.controller.execute()
  self.assertNotIn('apply',self.io.calls)
 def test_unpause_unknown_leaves_fallback_live_and_never_done(self):
  self.io.failure='unpause'
  with self.assertRaises(RuntimeError):self.controller.execute()
  self.assertIn('abandon',self.io.calls);self.assertNotIn('cancel',self.io.calls)
  self.assertFalse((Path(self.p['directory'])/'DONE.json').exists())
 def test_same_cid_config_change_is_not_a_success(self):
  def phase(name):
   if name=='apply':self.io.site['Config']['User']='changed'
  self.io.phase=phase
  with self.assertRaisesRegex(ValueError,'WEBSITE_CONFIG_CHANGED'):self.controller.execute()
  self.assertFalse(self.io.paused);self.assertIn('abandon',self.io.calls)
 def test_old_timer_receipt_or_helper_state_is_not_reused(self):
  (Path(self.p['directory'])/'WATCHDOG.json').write_text('{}')
  with self.assertRaisesRegex(ValueError,'FRESH_CONTROLLER'):self.controller.execute()
  self.assertNotIn('pause',self.io.calls)
 def test_fixed_budgets_remain_below_existing_offline_grace(self):
  self.assertEqual((M.WORK_SECONDS,M.RECOVERY_SECONDS,M.RECOVERY_CLIENT_SECONDS),(240,270,15))
  self.assertLess(M.RECOVERY_SECONDS+M.RECOVERY_CLIENT_SECONDS,600)

 def test_unsettled_helper_does_not_use_ordinary_unpause_or_cancel(self):
  self.io.helper_settled=lambda:False
  with self.assertRaisesRegex(ValueError,'HELPER_GROUP_UNSETTLED'):self.controller.execute()
  self.assertNotIn('unpause',self.io.calls);self.assertNotIn('cancel',self.io.calls)
  self.assertIn('abandon',self.io.calls);self.assertFalse((Path(self.p['directory'])/'DONE.json').exists())

 def test_expiry_during_initial_snapshot_has_no_attempt_arm_or_pause(self):
  self.io.phase=lambda name:self.p.update(expiresAtEpoch=0) if name=='snapshot'else None
  with self.assertRaisesRegex(ValueError,'POLICY_EXPIRED'):self.controller.execute()
  self.assertNotIn('arm',self.io.calls);self.assertFalse((Path(self.p['directory'])/'ATTEMPT.json').exists())
 def test_expiry_after_arm_prevents_pause_and_all_upgrade_commands(self):
  self.io.phase=lambda name:self.p.update(expiresAtEpoch=0)if name=='arm'else None
  with self.assertRaisesRegex(ValueError,'POLICY_EXPIRED'):self.controller.execute()
  self.assertNotIn('pause',self.io.calls);self.assertNotIn('prepare',self.io.calls);self.assertIn('unpause',self.io.calls)
 def test_expiry_during_review_fsync_prevents_apply_but_allows_recovery(self):
  original=M.exclusive
  def late(path,value):
   original(path,value)
   if path.name=='REVIEW-SUMMARY.json':self.p['expiresAtEpoch']=0
  with patch.object(M,'exclusive',side_effect=late),self.assertRaisesRegex(ValueError,'POLICY_EXPIRED'):self.controller.execute()
  self.assertNotIn('apply',self.io.calls);self.assertIn('unpause',self.io.calls);self.assertIn('cancel',self.io.calls)
 def test_expiry_during_helper_or_cancel_never_publishes_done(self):
  self.io.phase=lambda name:self.p.update(expiresAtEpoch=0)if name=='apply'else None
  with self.assertRaisesRegex(ValueError,'POLICY_EXPIRED'):self.controller.execute()
  self.assertIn('unpause',self.io.calls);self.assertFalse((Path(self.p['directory'])/'DONE.json').exists())


 def test_operation_finalizer_failure_leaves_no_done(self):
  from contextlib import contextmanager
  original=M.directory_lock
  @contextmanager
  def late(path):
   with original(path):yield
   raise OSError('CONTROLLED_FINALIZER_FAILURE')
  with patch.object(M,'directory_lock',late),self.assertRaises(OSError):self.controller.execute()
  self.assertFalse((Path(self.p['directory'])/'DONE.json').exists())
  self.assertFalse(self.io.paused);self.assertIn('cancel',self.io.calls)
 def test_expiry_after_completion_candidate_fsync_leaves_no_done(self):
  original=M.exclusive
  def late(path,value):
   original(path,value)
   if path.name=='DONE.next.json':self.p['expiresAtEpoch']=0
  with patch.object(M,'exclusive',late),self.assertRaisesRegex(ValueError,'POLICY_EXPIRED'):self.controller.execute()
  self.assertFalse((Path(self.p['directory'])/'DONE.json').exists())

class OwnedOS(unittest.TestCase):
 """Actual owned processes/FDs; website/Docker facts are synthetic files."""
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name).resolve();self.root.chmod(0o700)
 def test_natural_helper_child_is_reaped_without_forced_cleanup(self):
  import sys
  h=M.OwnedHelper([sys.executable,'-I','-B','-c','print("{\\"ok\\":true}")'],time.monotonic()+3,self.root)
  self.assertEqual(h.run(),{'ok':True});self.assertTrue(h.settled);self.assertFalse(h.forced)
  self.assertFalse(Path('/proc',str(h.child.pid)).exists())
 def test_timeout_reaps_owned_helper_and_heartbeat_child_before_return(self):
  import sys
  script='''import subprocess,sys,signal,time,json,os
from pathlib import Path
root=Path(sys.argv[1])
child=subprocess.Popen([sys.executable,'-I','-B','-c','import time,sys;from pathlib import Path;p=Path(sys.argv[1]);\\nwhile True:p.write_text(str(time.monotonic()));time.sleep(.01)',str(root/'heartbeat')])
(root/'pids.json').write_text(json.dumps({'child':child.pid,'parent':os.getpid()}))
def done(*_):
 child.terminate();child.wait(timeout=1);raise SystemExit(0)
signal.signal(signal.SIGTERM,done)
while True:time.sleep(.01)
'''
  h=M.OwnedHelper([sys.executable,'-I','-B','-c',script,str(self.root)],time.monotonic()+.35,self.root)
  with self.assertRaisesRegex(ValueError,'HELPER_DEADLINE'):h.run()
  self.assertTrue(h.settled);self.assertTrue(h.forced)
  pids=json.loads((self.root/'pids.json').read_bytes())
  self.assertTrue(all(not Path('/proc',str(pid)).exists()for pid in pids.values()))
  before=(self.root/'heartbeat').read_bytes();time.sleep(.05);self.assertEqual((self.root/'heartbeat').read_bytes(),before)
 def test_sigkill_escalation_reaps_only_actual_owned_helper(self):
  import sys
  h=M.OwnedHelper([sys.executable,'-I','-B','-c','import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(10)'],time.monotonic()+.15,self.root)
  with self.assertRaisesRegex(ValueError,'HELPER_DEADLINE'):h.run()
  self.assertTrue(h.settled);self.assertEqual(h.child.returncode,-9)
 def start_watchdog(self,seconds=10):
  import socket,subprocess,sys
  state={'Id':'a'*64,'Image':'sha256:'+'b'*64,'pid':123,'startTick':456,'Paused':False,'calls':[]}
  self.state=self.root/'state.json';self.state.write_text(json.dumps(state))
  driver=self.root/'watchdog-driver.py'
  driver.write_text('''import sys,json
from pathlib import Path
sys.path[:0]=[sys.argv[1]]
from reverie import worker_transport_maintenance as M
M.RECOVERY_SECONDS=float(sys.argv[4])
state=Path(sys.argv[2]);expected={'Id':'a'*64,'Image':'sha256:'+'b'*64,'pid':123,'startTick':456}
class Guest:
 def __init__(self,*_):pass
 def inspect(self):
  v=json.loads(state.read_bytes());M.need(all(v[k]==x for k,x in expected.items()),'FIXTURE_INCARCATION_CHANGED');return {'State':{'Paused':v['Paused']}}
 def unpause(self):
  self.inspect();v=json.loads(state.read_bytes());v['calls'].append('unpause');v['Paused']=False;state.write_text(json.dumps(v))
M.Ports=Guest
M.watchdog({'directory':str(state.parent),'website':{'id':'a'*64}},int(sys.argv[3]))
''')
  left,right=socket.socketpair();left.settimeout(3)
  source=Path(M.__file__).resolve().parents[1]
  child=subprocess.Popen([sys.executable,'-I','-B',str(driver),str(source),str(self.state),str(right.fileno()),str(seconds)],pass_fds=(right.fileno(),),start_new_session=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,env={'HOME':str(self.root),'PATH':str(Path(sys.executable).parent)})
  right.close();self.assertEqual(left.recv(32),b'ARMED\n')
  self.addCleanup(left.close)
  def reap():
   if child.poll()is None:child.kill()
   child.wait(timeout=3)
  self.addCleanup(reap)
  return child,left
 def paused(self):
  value=json.loads(self.state.read_bytes());value['Paused']=True;self.state.write_text(json.dumps(value))
 def test_actual_controller_process_death_closes_fd_and_unpauses_only(self):
  import subprocess,sys
  watchdog,control=self.start_watchdog();self.paused()
  parent=subprocess.Popen([sys.executable,'-I','-B','-c','import time;time.sleep(10)'],pass_fds=(control.fileno(),),stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  control.close();parent.kill();self.assertEqual(parent.wait(timeout=3),-9)
  self.assertEqual(watchdog.wait(timeout=5),0)
  state=json.loads(self.state.read_bytes());self.assertFalse(state['Paused']);self.assertEqual(state['calls'],['unpause'])
  receipt=json.loads((self.root/'WATCHDOG.json').read_bytes());self.assertEqual(receipt['state'],'RECOVERED_UNPAUSED')
  self.assertFalse((self.root/'DONE.json').exists())
 def test_actual_finite_timer_unpauses_with_control_channel_still_alive(self):
  child,control=self.start_watchdog(.1);self.paused();self.assertEqual(child.wait(timeout=5),0)
  state=json.loads(self.state.read_bytes());self.assertFalse(state['Paused']);self.assertEqual(state['calls'],['unpause'])
 def test_changed_incarnation_is_never_unpaused_by_fallback(self):
  child,control=self.start_watchdog();self.paused();v=json.loads(self.state.read_bytes());v['startTick']=999;self.state.write_text(json.dumps(v));control.close()
  self.assertNotEqual(child.wait(timeout=5),0)
  self.assertEqual(json.loads(self.state.read_bytes())['calls'],[])
  self.assertEqual(json.loads((self.root/'WATCHDOG.json').read_bytes())['state'],'RECOVERY_UNCONFIRMED')

class CustodyCaller(unittest.TestCase):
 def test_all_control_source_policy_and_evidence_roots_checked_before_any_effect(self):
  from types import SimpleNamespace
  from contextlib import nullcontext
  from unittest.mock import Mock
  import reverie.worker as W
  with tempfile.TemporaryDirectory()as directory:
   root=Path(directory).resolve();root.chmod(0o700)
   company=root/'company.json';company.write_text(json.dumps({'employees':[]}));company.chmod(0o600)
   p={'directory':str(root/'evidence'),'operation':str(root/'operation'),'providers':[],
      'generation':{},'engine':{'endpoint':'unix:///fixture','engineId':'fixture'},
      'companyProjectionSHA256':M.digest(M.encoded([]))}
   controls={root/'evidence',root/'policy',Path(M.__file__).resolve().parent,root/'operation'}
   for failing in controls:
    with self.subTest(failing=failing):
     seen=[]
     def custody(path,marker,**kwargs):
      seen.append(path)
      if path==failing:raise ValueError('controlled native exposure')
     gate=SimpleNamespace(admission=lambda **kwargs:nullcontext(),native=SimpleNamespace(custody=custody))
     t=SimpleNamespace(tools=SimpleNamespace(generation=lambda:{}),engine=lambda:{'endpoint':'unix:///fixture','engineId':'fixture'},
       _gate=lambda *args:gate,idle=lambda gate:None,protected=lambda gate:{},broker=lambda unit:{},native=lambda *args:{'providers':[]})
     ports=M.Ports.__new__(M.Ports);ports.p=p;ports.policy_path=root/'policy/policy.json';ports.deadline=time.monotonic()+1
     ports.service=SimpleNamespace(config_path=root/'config.json');ports.t=t
     with patch.object(M.T,'load_config',return_value={'companyFile':str(company),'uid':os.getuid()}),self.assertRaisesRegex(ValueError,'controlled native exposure'):
      M.Ports.snapshot(ports)
     self.assertIn(failing,seen)


class SourceAndDiagnostic(unittest.TestCase):
 def test_complete_mount_permutations_match_without_dropping_flags_or_duplicates(self):
  a={'Type':'bind','Source':'/synthetic/a','Destination':'/a','RW':False,'extra':{'preserved':True}}
  b={'Type':'bind','Source':'/synthetic/b','Destination':'/b','RW':True}
  first={'Id':'a'*64,'Image':'sha256:'+'b'*64,'Config':{},'HostConfig':{'Mounts':[a,b,a]},'Mounts':[a,b,a]}
  second=copy.deepcopy(first);second['Mounts'].reverse();second['HostConfig']['Mounts'].reverse()
  self.assertEqual(M.website_fingerprint(first),M.website_fingerprint(second))
  for change in ('flag','multiplicity'):
   value=copy.deepcopy(second)
   if change=='flag':value['Mounts'][0]['RW']=not value['Mounts'][0]['RW']
   else:value['Mounts'].pop()
   self.assertNotEqual(M.website_fingerprint(first),M.website_fingerprint(value))

 def test_private_source_copy_rejects_symlink_hardlink_and_nondirectory_referent(self):
  with tempfile.TemporaryDirectory()as directory:
   root=Path(directory).resolve();p=root/'module.py';p.write_text('owned fixture');p.chmod(0o400)
   self.assertEqual(M.source_pin(p),M.digest(b'owned fixture'))
   alias=root/'alias.py';alias.symlink_to(p)
   with self.assertRaisesRegex(ValueError,'SOURCE_ALIAS'):M.source_pin(alias)
   hard=root/'hard.py';os.link(p,hard)
   with self.assertRaisesRegex(ValueError,'SOURCE_CUSTODY'):M.source_pin(hard)
   p.unlink();hard.unlink();p.mkdir()
   with self.assertRaisesRegex(ValueError,'SOURCE_CUSTODY'):M.source_pin(p)
 def test_helper_diagnostics_preserve_only_allowlisted_reason_and_no_body(self):
  safe={'category':'GUARD_CHECK_FAILED','reason':'Unlisted exception details withheld.'}
  self.assertEqual(M.helper_diagnostic(b'generic failure\n'+json.dumps(safe).encode()),safe)
  self.assertIsNone(M.helper_diagnostic(json.dumps({'category':'GUARD_CHECK_FAILED','reason':'secret/private/provider/body'}).encode()))
  self.assertIsNone(M.helper_diagnostic(json.dumps({**safe,'body':'private'}).encode()))

 def test_actual_service_stage_diagnostic_survives_the_controller_boundary(self):
  from reverie.worker_service import _diagnostic
  for stage in ('POSTSTART_BROKER','POSTSTART_LISTENERS','POSTSTART_ADMISSION',
                'POSTSTART_CONTINUITY','POSTSTART_BROKER_READBACK',
                'POSTSTART_RESULT_WRITE','POSTSTART_TERMINAL'):
   with self.subTest(stage=stage):
    error=PermissionError(13,'private exception content')
    error._reverie_transport_stage=stage
    produced=_diagnostic(error)
    self.assertEqual(M.helper_diagnostic(json.dumps(produced).encode()),produced)
    self.assertNotIn('private',json.dumps(produced))
    self.assertIsNone(M.helper_diagnostic(json.dumps({**produced,'stage':'/private/path'}).encode()))
    self.assertIsNone(M.helper_diagnostic(json.dumps({**produced,'body':'private'}).encode()))
 def test_actual_manager_diagnostic_survives_only_with_exact_safe_metadata(self):
  from reverie.worker_service import ManagerOperationError, _diagnostic
  for manager in ('MANAGER_STOP','MANAGER_DISABLE','MANAGER_RELOAD'):
   for stage in (None,'POSTSTART_BROKER'):
    error=ManagerOperationError(manager,5)
    if stage:error._reverie_transport_stage=stage
    produced=_diagnostic(error)
    self.assertEqual(M.helper_diagnostic(json.dumps(produced).encode()),produced)
    for key,bad in [('category','GUARD_CHECK_FAILED'),('reason','private content'),
                    ('managerStage','/private/path'),('managerStage',[]),('returncode',True),
                    ('returncode',0),('returncode',256),('returncode',-129),
                    ('returncode','5'),('stage','/private/path'),('body','private')]:
     with self.subTest(manager=manager,stage=stage,key=key,bad=bad):
      self.assertIsNone(M.helper_diagnostic(json.dumps({**produced,key:bad}).encode()))
    for key in ('category','reason','managerStage','returncode'):
     self.assertIsNone(M.helper_diagnostic(json.dumps({k:v for k,v in produced.items() if k!=key}).encode()))
 def test_partial_helper_spawn_is_unknown_not_settled(self):
  h=M.OwnedHelper(['controlled'],time.monotonic()+1,Path('/'))
  with patch.object(M.subprocess,'Popen',side_effect=OSError('controlled spawn boundary')):
   with self.assertRaisesRegex(ValueError,'HELPER_GROUP_UNSETTLED'):h.run()
  self.assertFalse(h.settled);self.assertIsNone(h.metadata['exitCode'])


class CompletePackage(unittest.TestCase):
 def test_recursive_package_pin_inventory_is_closed_and_never_follows_aliases(self):
  with tempfile.TemporaryDirectory()as directory:
   root=Path(directory).resolve();root.chmod(0o700);sub=root/'cleanup';sub.mkdir(mode=0o700)
   for p in (root/'__init__.py',sub/'__init__.py',sub/'lease.py'):p.write_text('owned synthetic source');p.chmod(0o400)
   pins={str(p.relative_to(root)):M.source_pin(p)for p in root.rglob('*.py')}
   M.verify_sources(root,pins)
   omitted=dict(pins);omitted.pop('cleanup/lease.py')
   with self.assertRaisesRegex(ValueError,'UNDECLARED_LOCAL_SOURCE'):M.verify_sources(root,omitted)
   alias=root/'nested_alias';alias.symlink_to(sub,target_is_directory=True)
   with self.assertRaisesRegex(ValueError,'UNPINNED_SOURCE_ENTRY'):M.verify_sources(root,pins)
 def test_clean_isolated_entry_help_and_invalid_flag_reach_the_parser(self):
  import subprocess,sys,shutil
  with tempfile.TemporaryDirectory()as directory:
   root=Path(directory).resolve();root.chmod(0o700);bundle=root/'private/reverie';bundle.mkdir(parents=True,mode=0o700);bundle.parent.chmod(0o700)
   original=Path(M.__file__).resolve().parent
   for path in original.rglob('*.py'):
    self.assertFalse(path.is_symlink());target=bundle/path.relative_to(original);target.parent.mkdir(parents=True,exist_ok=True,mode=0o700);shutil.copy2(path,target);target.chmod(0o400)
   for path in bundle.rglob('*'):
    if path.is_dir():path.chmod(0o700)
   entry=bundle/'worker_transport_maintenance.py';env={'HOME':str(root),'PATH':str(Path(sys.executable).parent)}
   help_run=subprocess.run([sys.executable,'-I','-B',str(entry),'--help'],cwd=root,env=env,capture_output=True,text=True,timeout=15)
   self.assertEqual(help_run.returncode,0,help_run.stderr);self.assertIn('--watchdog-fd',help_run.stdout)
   invalid=subprocess.run([sys.executable,'-I','-B',str(entry),'--policy',str(root/'not-read.json'),'--policy-sha256','0'*64,'--invalid-fixture-flag'],cwd=root,env=env,capture_output=True,text=True,timeout=15)
   self.assertEqual(invalid.returncode,2,invalid.stderr);self.assertIn('unrecognized arguments',invalid.stderr)
   self.assertNotIn('ModuleNotFoundError',help_run.stderr+invalid.stderr)
