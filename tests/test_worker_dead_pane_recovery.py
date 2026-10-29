"""Canonical J with real private storage; closed native ports, no engine effects."""
import json,os,socket,subprocess,unittest,pty,shutil,signal,threading,time,sys
from pathlib import Path
from unittest.mock import patch
from tests import test_worker as F
SID=F.SID
from reverie.worker import Broker,create_args,send_frame,receive_frame
from reverie.worker_resources import policy_digest
from reverie.worker_storage import storage_paths,prepare_storage,storage_guard
from reverie.worker_resource_reservations import _pid

EID='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
class DeadPaneRecovery(unittest.TestCase):
 def setUp(self):
  F.WorkerTests.setUp(self);self.config.update(uid=os.getuid(),gid=os.getgid(),budgetMode='admission',memoryMiB=2048)
  self.company={'employees':[{'id':EID,'sessionId':SID,'sessionGeneration':1,'desiredRunning':True,'onVacation':False}]}
  self.save();self.paths=storage_paths(self.config,SID);prepare_storage(self.config,self.paths)
  runtime=Path(self.config['stateRoot'])/SID;runtime.mkdir(mode=0o700)
  (runtime/'runtime.json').write_text(json.dumps({'exit':'owned.exit'}))
  self.broker=Broker(self.config);self.calls=[];self.panes=['1','1']
  self.item={'Id':'a'*64,'Name':'/'+self.config['deployment']+'-agent-'+SID,'Image':self.config['image'],
   'State':{'Running':True,'Pid':os.getpid()},'Config':{'Labels':{'reverie.worker':self.config['deployment'],
    'reverie.session':SID,'reverie.employee':EID,'reverie.worker-policy':policy_digest(self.config,SID)}}}
  def engine(args,optional=False):
   self.calls.append(args)
   if args[0]=='inspect':return subprocess.CompletedProcess(args,0,json.dumps([self.item]),'')
   if args[0]=='exec':
    value=self.panes.pop(0)if len(self.panes)>1 else self.panes[0]
    if callable(value):value=value()
    return subprocess.CompletedProcess(args,0,value,'')
   raise AssertionError('Native effect forbidden: '+args[0])
  self.broker.run_engine=engine
  self.broker.office=lambda sid:None;self.broker.check_pool=lambda **kwargs:None
  self.broker.check_creation_budget=lambda *args:None;self.broker.check_storage_writers=lambda *args:None
  self.stop=self.enterContext(patch.object(self.broker,'stop',side_effect=RuntimeError('controlled exact stop boundary')))
  self.enterContext(patch('reverie.worker.pty.openpty',side_effect=RuntimeError('controlled viewer boundary')))
  self.addCleanup(lambda:[self.broker.release_storage(s)for s in list(self.broker.storage_leases)])
 def save(self):
  path=Path(self.config['companyFile']);path.write_text(json.dumps(self.company));path.chmod(0o600)
 def run_request(self,attach=False):
  client,server=socket.socketpair();client.settimeout(2)
  try:
   self.broker.connections.acquire();send_frame(client,b'J',json.dumps({'sessionId':SID,'cwd':'/workspace',
    'command':'owned saved launch','env':{},'cols':80,'rows':24,**({'attachOnly':True}if attach else{})}).encode())
   self.broker.handle(server);return receive_frame(client)
  finally:client.close();server.close()
 def test_missing_exit_file_and_confirmed_dead_inner_pane_reaches_exact_stop_only(self):
  kind,body=self.run_request();self.assertEqual(kind,b'E');self.assertIn(b'exact stop boundary',body)
  self.stop.assert_called_once_with(self.item['Name'][1:],retain_storage=True,expected_id='a'*64,
    expected_process={'pid':os.getpid(),'start':_pid(os.getpid())})
  self.assertEqual(len([c for c in self.calls if c[0]=='exec']),2)
 def test_live_inner_provider_is_reattached_without_stop_create_or_start(self):
  self.panes=['0'];kind,body=self.run_request();self.assertEqual(kind,b'E');self.assertIn(b'viewer boundary',body)
  self.stop.assert_not_called();self.assertFalse(any(c[0]in('stop','kill','rm','create','start')for c in self.calls))
 def test_unknown_or_revived_inner_pane_is_never_replaced(self):
  for responses in ([''],['unrecognized'],['1','0']):
   self.panes=responses;kind,body=self.run_request();self.assertEqual(kind,b'E');self.assertIn(b'pane',body)
   self.stop.assert_not_called()
 def test_attach_only_never_replaces_a_dead_provider(self):
  kind,body=self.run_request(attach=True);self.assertEqual(kind,b'E');self.assertIn(b'never starts a replacement',body);self.stop.assert_not_called()
 def test_owner_off_during_native_observation_refuses_before_stop(self):
  def off():self.company['employees'][0]['desiredRunning']=False;self.save();return '1'
  self.panes=[off];kind,body=self.run_request();self.assertEqual(kind,b'E');self.stop.assert_not_called()
 def test_a_foreign_live_storage_lease_is_not_broken(self):
  held=storage_guard(self.config,SID);held.__enter__();self.addCleanup(lambda:held.__exit__(None,None,None))
  original=self.broker.claim_storage
  def blocked(sid):
   try:return original(sid)
   except BlockingIOError:
    self.company['employees'][0]['desiredRunning']=False;self.save();raise
  with patch.object(self.broker,'claim_storage',side_effect=blocked):kind,body=self.run_request()
  self.assertEqual(kind,b'E');self.stop.assert_not_called();self.assertNotIn(SID,self.broker.storage_leases)


class AttachedInnerDeath(unittest.TestCase):
 save=DeadPaneRecovery.save
 def setUp(self):
  actual_openpty=pty.openpty;DeadPaneRecovery.setUp(self)
  self.enterContext(patch('reverie.worker.pty.openpty',side_effect=actual_openpty))
  self.tmux=shutil.which('tmux');self.assertIsNotNone(self.tmux,'Declared flake tmux is required')
  self.tmux_socket=self.root/'inner.sock'
  self.addCleanup(lambda:subprocess.run([self.tmux,'-S',str(self.tmux_socket),'kill-server'],capture_output=True))
  subprocess.run([self.tmux,'-S',str(self.tmux_socket),'-f','/dev/null','new-session','-d','-s','office','exec sleep 120'],check=True,capture_output=True)
  subprocess.run([self.tmux,'-S',str(self.tmux_socket),'set-option','-t','office','remain-on-exit','on'],check=True,capture_output=True)
  self.inner_pid=int(self.query('#{pane_pid}'));self.inner_start=_pid(self.inner_pid)
  self.engine=self.root/'only-owned-viewer'
  self.engine.write_text('#!'+sys.executable+'\nimport os,sys\na=sys.argv[1:];i=a.index("/bin/tmux");tail=a[i+1:];assert tail[:3]==["-u","-L","reverie-laptop"];os.environ.update(TERM="xterm-256color",COLORTERM="truecolor",LANG="C.UTF-8",LC_ALL="C.UTF-8");os.execv('+repr(self.tmux)+',["tmux","-u","-S",'+repr(str(self.tmux_socket))+']+tail[3:])\n')
  self.engine.chmod(0o700);self.broker.engine=str(self.engine);self.unknown=False;self.periodic=threading.Event()
  def engine(args,optional=False,*,deadline=None):
   self.calls.append(args)
   if args[0]=='inspect':return subprocess.CompletedProcess(args,0,json.dumps([self.item]),'')
   if args[0]=='exec':
    if deadline is not None:self.periodic.set();self.assertLessEqual(deadline-time.monotonic(),2)
    return subprocess.CompletedProcess(args,0,''if self.unknown else self.query('#{pane_dead}'),'')
   raise AssertionError('Container effects forbidden: '+args[0])
  self.broker.run_engine=engine;self.client=None;self.thread=None
  self.addCleanup(self.close_viewer)
 def query(self,value):
  return subprocess.check_output([self.tmux,'-S',str(self.tmux_socket),'display-message','-p','-t','office',value],text=True,timeout=2).strip()
 def close_viewer(self):
  if self.client is not None:self.client.close();self.client=None
  if self.thread is not None:self.thread.join(3);self.assertFalse(self.thread.is_alive())
 def attach(self):
  server,self.client=socket.socketpair();self.client.settimeout(5);self.broker.connections.acquire()
  self.thread=threading.Thread(target=self.broker.handle,args=(server,));self.thread.start()
  send_frame(self.client,b'J',json.dumps({'sessionId':SID,'cwd':'/workspace','command':'must-never-run','env':{},'cols':80,'rows':24,'attachOnly':True}).encode())
  first=receive_frame(self.client);self.assertEqual(first[0],b'O')
  self.assertIn(SID,self.broker.storage_leases);self.assertEqual(self.query('#{pane_dead}'),'0')
  self.assertTrue(any(child is not None and child.poll()is None for child,_ in self.broker.viewers.values()),repr(first[1]))
 def assert_retained(self):
  self.stop.assert_not_called();self.assertTrue(self.company['employees'][0]['desiredRunning'])
  self.assertIn(SID,self.broker.storage_leases)
  self.assertFalse(any(c[0]in('stop','kill','rm','create','start')for c in self.calls))
  with self.assertRaises(BlockingIOError):storage_guard(self.config,SID).__enter__()
 def test_real_attached_viewer_and_dead_inner_without_exit_receipt_reports_nonzero(self):
  self.attach();end=time.monotonic()+1
  expected=Path(shutil.which('sleep')).resolve(strict=True)
  while time.monotonic()<end and not (Path('/proc')/str(self.inner_pid)/'exe').samefile(expected):time.sleep(.005)
  self.assertTrue((Path('/proc')/str(self.inner_pid)/'exe').samefile(expected))
  pidfd=os.pidfd_open(self.inner_pid);self.addCleanup(os.close,pidfd)
  self.assertEqual(_pid(self.inner_pid),self.inner_start);signal.pidfd_send_signal(pidfd,signal.SIGTERM)
  end=time.monotonic()+5;error=None
  while time.monotonic()<end:
   self.client.settimeout(max(.001,end-time.monotonic()));kind,body=receive_frame(self.client)
   if kind==b'E':error=body;break
  self.assertIsNotNone(error);self.assertIn(b'pane exited without a completion receipt',error)
  self.thread.join(3);self.assertFalse(self.thread.is_alive());self.assertEqual(self.query('#{pane_dead}'),'1')
  self.assertFalse((self.paths.home/'.reverie-launch/owned.exit').exists());self.assert_retained()
 def test_unknown_periodic_probe_preserves_the_healthy_viewer_and_data_lease(self):
  self.attach();self.periodic.clear();self.unknown=True
  self.assertTrue(self.periodic.wait(4));self.assertTrue(self.thread.is_alive())
  self.assertEqual(_pid(self.inner_pid),self.inner_start);self.assertEqual(self.query('#{pane_dead}'),'0')
  self.assert_retained();self.close_viewer()

 def test_completion_receipt_published_during_native_probe_uses_original_exit_path(self):
  self.attach();original=self.broker.run_engine;written=[]
  receipt=self.paths.home/'.reverie-launch/owned.exit'
  def read(args,optional=False,*,deadline=None):
   result=original(args,optional,deadline=deadline)
   if deadline is not None and result.returncode==0 and result.stdout.strip()=='1':
    receipt.parent.mkdir(mode=0o700,exist_ok=True);receipt.write_text('0');written.append(True)
   return result
  self.broker.run_engine=read;end=time.monotonic()+1;expected=Path(shutil.which('sleep')).resolve(strict=True)
  while time.monotonic()<end and not(Path('/proc')/str(self.inner_pid)/'exe').samefile(expected):time.sleep(.005)
  self.assertTrue((Path('/proc')/str(self.inner_pid)/'exe').samefile(expected))
  pidfd=os.pidfd_open(self.inner_pid);self.addCleanup(os.close,pidfd)
  self.assertEqual(_pid(self.inner_pid),self.inner_start);signal.pidfd_send_signal(pidfd,signal.SIGTERM)
  end=time.monotonic()+5;outcome=None
  while time.monotonic()<end:
   self.client.settimeout(max(.001,end-time.monotonic()));kind,body=receive_frame(self.client)
   if kind in(b'E',b'X'):outcome=(kind,body);break
  self.assertTrue(written);self.assertEqual(receipt.read_text(),'0');self.assertEqual(outcome,(b'X',b'0'))
