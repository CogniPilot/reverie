"""Composed real ledger/protocol + actual owned Python/Node/Handoff sockets.

Only website engine/session/native target observations are controlled fixture
ports. No actual website, engine, owner cookie, provider, shell or PTY is used.
"""
import copy
import dataclasses
import json
import os
from pathlib import Path
import select
import socket
import subprocess
import sys
import tempfile
import time
import threading
import unittest
from unittest.mock import patch
from fixture_support import accept_child, run_backend, stop_child
from reverie import human_shell_capabilities as capabilities
from reverie import human_terminal_protocol as protocol
from reverie.owner_terminal_channel import Handoff, WebsitePeer, Program, Refusal as PeerRefusal, read_proc
from reverie.owner_terminal_ledger_service import LedgerService, Refusal, Unconfirmed

ROOT=Path(__file__).parent
WEB_ROOT=ROOT.parents[2]
DIST=Path(os.environ.get('OWNER_TERMINAL_TEST_DIST',WEB_ROOT/'dist'))
CONNECTOR=Path(os.environ.get('OWNER_TERMINAL_TEST_CONNECTOR',WEB_ROOT/'scripts/connect-owner-terminal.mjs'))
PYTHON_SOURCE=Path(capabilities.__file__).parent
NODE=Path(os.environ['OWN_TEST_NODE']).resolve()
TARGET={'employeeId':'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','sessionId':'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
 'sessionGeneration':1,'containerId':'c'*64,'imageId':'sha256:'+'d'*64,'policyDigest':'e'*64,
 'running':True,'onVacation':False,'desiredRunning':True,'humanTerminalEntitled':True}
CONSUMER='f'*64

@dataclasses.dataclass(frozen=True)
class OwnWebsite(WebsitePeer):
 def assert_process(self,credentials,stage):
  pid,uid,gid=credentials
  if(uid,gid)!=(os.getuid(),os.getgid()):raise PeerRefusal('OWNED_PEER')
  p=read_proc(pid)
  if stage=='node'and not Path('/proc',str(pid),'exe').samefile(NODE):raise PeerRefusal('OWNED_NODE')
  return p

class NativeTarget:
 def __init__(self):self.value=copy.deepcopy(TARGET)
 def observe(self,employee):
  if employee!=TARGET['employeeId']:raise Refusal('OWNED_EMPLOYEE')
  return copy.deepcopy(self.value)
class ConsumerPeer:
 def assert_current_peer(self,digest):
  if digest!=CONSUMER:raise Refusal('OWNED_CONSUMER')

class BridgeTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(prefix='ob-',dir=os.environ['TMPDIR']);self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
  self.endpoint=str(self.root/'s');self.listener=socket.socket(socket.AF_UNIX);self.listener.bind(self.endpoint);self.listener.listen(2);self.listener.settimeout(3);self.addCleanup(self.listener.close)
  # R2 fixed endpoint substituted only in this owned fixture copy.
  source=CONNECTOR.read_text();self.assertEqual(source.count("'/run/reverie-owner-terminal/bootstrap.sock'"),1)
  (self.root/'fixture-connect.mjs').write_text(source.replace("'/run/reverie-owner-terminal/bootstrap.sock'",json.dumps(self.endpoint)))
  # Fixture module imports exact compiled bridge/authority plus the own endpoint.
  fixture=(ROOT/'fixture.mjs').read_text()
  fixture=fixture.replace("'./dist/owner-laptop-terminal-authority.js'",json.dumps(str(DIST/'owner-laptop-terminal-authority.js'))).replace("'./dist/owner-ledger-bridge.js'",json.dumps(str(DIST/'owner-ledger-bridge.js')))
  (self.root/'fixture.mjs').write_text(fixture);(self.root/'target.json').write_text(json.dumps(TARGET))
  bootstrap=(PYTHON_SOURCE/'owner_terminal_bootstrap.py').read_text().replace("'/run/reverie-owner-terminal/bootstrap.sock'",json.dumps(self.endpoint));(self.root/'owner_terminal_bootstrap.py').write_text(bootstrap)
  selection=os.environ.get('NIX_REVERIE_TEST_NODE_CUSTODY')
  if selection not in (None,'1'):raise ValueError('Unknown owned Node fixture mode')
  (self.root/'fixture_support.py').write_text((ROOT/'fixture_support.py').read_text())
  (self.root/'boot.py').write_text("import sys\nfrom owner_terminal_bootstrap import exec_backend\nfrom fixture_support import run_backend\nrun_backend(exec_backend,sys.argv[1],tuple(sys.argv[1:]),normalize_unmapped_node="+repr(selection=='1')+")\n")
  self.process=subprocess.Popen([sys.executable,str(self.root/'boot.py'),str(NODE),str(self.root/'fixture.mjs'),str(self.root/'target.json')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env={'PATH':'/not-used'});self.addCleanup(stop_child,self.process)
  pr=Program(str(NODE),(str(NODE),));site=OwnWebsite('/not-an-engine','a'*64,'sha256:'+'b'*64,'c'*64,os.getpid(),read_proc(os.getpid())['start'],os.getuid(),os.getgid(),pr,pr)
  self.channel=Handoff(site);self.addCleanup(self.channel.close);first=accept_child(self.listener,self.process,'bootstrap');self.channel.bootstrap(first);second=accept_child(self.listener,self.process,'node');self.channel.accept_node(second)
  self.assertEqual(self.read()['event'],'ready')
  self.directory=self.root/'ledger';self.directory.mkdir(mode=0o700)
  self.native=NativeTarget();self.service=LedgerService(self.channel,self.directory,native_target=self.native,consumer_verifier=ConsumerPeer());self.addCleanup(self.service.close)
 def read(self):
  self.assertTrue(select.select([self.process.stdout],[],[],3)[0],'owned Node response timeout')
  line=self.process.stdout.readline();self.assertTrue(line,'owned Node exited before static metadata response');return json.loads(line)
 def send(self,value):self.process.stdin.write(json.dumps(value)+'\n');self.process.stdin.flush()
 def control(self,value):self.send({'control':value});self.assertEqual(self.read(),{'event':'control','control':value})
 def issue(self):
  self.send({'action':'issue'});state=self.service.serve_once();return state,self.read()
 def document(self):return json.loads((self.directory/'capabilities.json').read_text())
 def test_real_issue_protocol_consume_recheck_and_public_proof_separation(self):
  state,result=self.issue();self.assertEqual(state,'ok');public=result['value'];self.assertEqual(set(public),{'shellId','authorizationRef','expiresAtEpochMs'})
  entry=self.document()['entries'][public['authorizationRef']];self.assertNotIn('proof',entry);self.assertEqual(entry['state'],'ISSUED')
  # Existing protocol and ledger shim, with no native exec/spawn operation.
  cap=self.service.for_consumer(public['authorizationRef'],CONSUMER)
  shell=protocol.Channel(cap.request,self.native.value,capability=cap)
  self.assertEqual(shell.receive(b'I',b'owned',self.native.value),('input',b'owned'))
  self.assertEqual(self.document()['entries'][public['authorizationRef']]['state'],'CONSUMED')
  self.assertNotIn(entry['proof_sha256'],json.dumps(result));self.assertNotIn('OWNED_FIXTURE_ONLY',json.dumps(result))
  with self.assertRaises(capabilities.Refusal):cap.consume(entry['request'])
 def test_live_owner_loss_before_issue_has_no_ledger_effect(self):
  self.control('owner-off');self.send({'action':'issue'});result=self.read();self.assertEqual(result['state'],'refused');self.assertFalse((self.directory/'capabilities.json').exists())
 def test_native_incarnation_drift_refuses_despite_backend_context(self):
  self.native.value['containerId']='1'*64
  state,result=self.issue();self.assertEqual(state,'refused');self.assertEqual(result['state'],'refused');self.assertFalse((self.directory/'capabilities.json').exists())
 def test_owner_loss_after_durable_commit_reports_unconfirmed_no_retry(self):
  original=self.service.ledger._commit
  def lose(value,guard):original(value,guard);self.control('owner-off')
  with patch.object(self.service.ledger,'_commit',side_effect=lose):state,result=self.issue()
  self.assertEqual(state,'unconfirmed');self.assertEqual(result['state'],'unconfirmed');self.assertEqual(len(self.document()['entries']),1)
  self.send({'action':'issue'});self.assertEqual(self.read()['state'],'unconfirmed')
 def test_actual_authority_restart_refuses_prepared_context(self):
  state,result=self.issue();self.assertEqual(state,'ok');reference=result['value']['authorizationRef']
  self.control('shutdown');self.send({'action':'status','reference':reference});self.assertEqual(self.read()['state'],'refused')
 def test_replayed_command_never_issues_second_ledger_record(self):
  self.issue();before=(self.directory/'capabilities.json').read_bytes();self.control('replay')
  with self.assertRaises(Refusal):self.service.serve_once()
  self.assertEqual((self.directory/'capabilities.json').read_bytes(),before)
 def test_lost_success_response_is_unconfirmed_and_never_retried(self):
  original=self.service.wire.send
  def lose(value):
   if value['kind']=='result':raise BrokenPipeError('owned lost result')
   return original(value)
  self.send({'action':'issue'})
  with patch.object(self.service.wire,'send',side_effect=lose),self.assertRaises(Unconfirmed):self.service.serve_once()
  self.assertEqual(self.read()['state'],'unconfirmed');self.assertEqual(len(self.document()['entries']),1)
 def test_private_target_port_absent_refuses_before_ledger_open(self):
  with self.assertRaisesRegex(Refusal,'NATIVE_TARGET_UNAVAILABLE'):LedgerService(self.channel,self.root/'absent')
 def test_wire_owner_bool_or_scope_digest_cannot_replace_authority_context(self):
  self.control('forged-owner')
  with self.assertRaises(Refusal):self.service.serve_once()
  self.assertFalse((self.directory/'capabilities.json').exists())
 def test_oversized_frame_refuses_before_body_or_ledger_read(self):
  self.control('oversize')
  with self.assertRaises(Refusal):self.service.serve_once()
  self.assertFalse((self.directory/'capabilities.json').exists())
 def test_truncated_header_actual_eof_closes_without_ledger_effect(self):
  self.control('truncated')
  with self.assertRaises(ValueError):self.service.serve_once()
  self.assertFalse((self.directory/'capabilities.json').exists())
 def test_consumed_protocol_recheck_refuses_after_live_owner_revocation(self):
  _,result=self.issue();ref=result['value']['authorizationRef'];request=self.document()['entries'][ref]['request']
  capability=self.service.for_consumer(ref,CONSUMER)
  shell=protocol.Channel(request,self.native.value,capability=capability)
  self.control('owner-off')
  with self.assertRaises(Refusal):shell.receive(b'I',b'owned',self.native.value)
  self.assertTrue(shell.closed)
  with self.assertRaises(Refusal):capability.recheck(request)
 def test_real_owner_metadata_and_revoke_use_existing_ledger_without_proof_output(self):
  _,result=self.issue();reference=result['value']['authorizationRef']
  for action,state in [('status','ISSUED'),('revoke',None),('status','REVOKED')]:
   self.send({'action':action,'reference':reference});self.assertEqual(self.service.serve_once(),'ok');answer=self.read()['value']
   if state is None:self.assertIsNone(answer)
   else:
    self.assertEqual(answer['state'],state);self.assertNotIn('proof',answer);self.assertNotIn('ownerScopeDigest',answer)
  self.assertEqual(self.document()['entries'][reference]['state'],'REVOKED')
 def test_changed_target_metadata_is_known_refusal_and_allows_fresh_owner_issue(self):
  _,result=self.issue();reference=result['value']['authorizationRef'];self.control('new-incarnation');self.native.value['containerId']='2'*64
  self.send({'action':'status','reference':reference});self.assertEqual(self.read()['state'],'refused')
  state,answer=self.issue();self.assertEqual(state,'ok');self.assertIn('authorizationRef',answer['value']);self.assertEqual(len(self.document()['entries']),2)
 def test_backend_cancel_after_commit_is_unknown_without_success_or_reissue(self):
  original=self.service.ledger._commit
  def cancel(value,guard):original(value,guard);self.control('close')
  self.send({'action':'issue'})
  with patch.object(self.service.ledger,'_commit',side_effect=cancel),self.assertRaises(Unconfirmed):self.service.serve_once()
  self.assertEqual(self.read()['state'],'unconfirmed');self.assertEqual(len(self.document()['entries']),1)

 def _consumer_refusal_preserves_active_owner(self, wrong_thread):
  _,first=self.issue();reference=first['value']['authorizationRef']
  consumer=self.service.for_consumer(reference,CONSUMER)
  original=self.native.observe;observed=[]
  read=self.service.wire.read;send=self.service.wire.send;commit=self.service.ledger._commit
  with patch.object(self.service.wire,'read',wraps=read) as reads,patch.object(self.service.wire,'send',wraps=send) as sends,patch.object(self.service.ledger,'_commit',wraps=commit) as commits:
   def observe(employee):
    if not observed:
     active=self.service.active;before=(self.directory/'capabilities.json').read_bytes();inode=(self.directory/'capabilities.json').stat().st_ino
     counts=(reads.call_count,sends.call_count,commits.call_count);errors=[]
     def attempt():
      try:consumer.consume(consumer.request)
      except BaseException as error:errors.append(error)
     if wrong_thread:
      child=threading.Thread(target=attempt);child.start();child.join(timeout=1);self.assertFalse(child.is_alive())
     else:attempt()
     observed.append({'sameActive':self.service.active is active,'sameIO':counts==(reads.call_count,sends.call_count,commits.call_count),'sameBytes':before==(self.directory/'capabilities.json').read_bytes(),'sameInode':inode==(self.directory/'capabilities.json').stat().st_ino,'refused':len(errors)==1 and isinstance(errors[0],Refusal)})
    return original(employee)
   with patch.object(self.native,'observe',side_effect=observe):
    # The service captures the fixed method at construction, so replace the trusted
    # bound fixture port explicitly; production ports remain request-independent.
    self.service.observe=observe
    operation_error=None
    try:state,result=self.issue()
    except BaseException as error:operation_error=error
    finally:self.service.observe=original
  self.assertEqual(observed,[{'sameActive':True,'sameIO':True,'sameBytes':True,'sameInode':True,'refused':True}])
  if operation_error is not None:raise operation_error
  self.assertEqual(state,'ok');self.assertIn('authorizationRef',result['value'])
  self.assertEqual(len(self.document()['entries']),2)
 def test_reentrant_consumer_refusal_preserves_live_owner_operation(self):
  self._consumer_refusal_preserves_active_owner(False)
 def test_wrong_thread_consumer_refusal_preserves_live_owner_operation(self):
  self._consumer_refusal_preserves_active_owner(True)

class FixtureInfrastructureTests(unittest.TestCase):
 def stat_port(self, *, writable=False, drift=False):
  native=Path.stat;calls=0
  def observe(path,*args,**kwargs):
   nonlocal calls
   info=native(NODE if path==NODE.parent/'unselected'else path,*args,**kwargs)
   fields=list(info)
   if path==Path('/')or path==NODE or path==NODE.parent/'unselected':fields[4]=65534
   if path==NODE:
    calls+=1
    if writable:fields[0]|=0o222
    if drift and calls>1:fields[1]+=1
   return os.stat_result(fields)
  return observe
 def test_explicit_fixture_only_normalizes_selected_unmapped_node_uid(self):
  with patch.object(Path,'stat',self.stat_port()):
   observed=run_backend(lambda *_:(NODE.stat().st_uid,(NODE.parent/'unselected').stat().st_uid),str(NODE),(str(NODE),),normalize_unmapped_node=True)
  self.assertEqual(observed,(0,65534))
 def test_default_unmapped_node_is_rejected_by_real_bootstrap_before_socket(self):
  from reverie.owner_terminal_bootstrap import exec_backend
  with patch.object(Path,'stat',self.stat_port()),patch('socket.socket')as opened:
   with self.assertRaisesRegex(ValueError,'Fixed immutable backend required'):
    run_backend(exec_backend,str(NODE),(str(NODE),))
   opened.assert_not_called()
 def test_fixture_preserves_writable_mode_refusal_in_real_bootstrap(self):
  from reverie.owner_terminal_bootstrap import exec_backend
  with patch.object(Path,'stat',self.stat_port(writable=True)),patch('socket.socket')as opened:
   with self.assertRaisesRegex(ValueError,'Fixed immutable backend required'):
    run_backend(exec_backend,str(NODE),(str(NODE),),normalize_unmapped_node=True)
   opened.assert_not_called()
 def test_fixture_node_inode_drift_refuses_without_entry_result(self):
  with patch.object(Path,'stat',self.stat_port(drift=True)):
   with self.assertRaisesRegex(ValueError,'fixture identity changed'):
    run_backend(lambda *_:NODE.stat(),str(NODE),(str(NODE),),normalize_unmapped_node=True)
 def test_bootstrap_failure_reports_child_stderr_without_waiting_on_accept(self):
  with tempfile.TemporaryDirectory(prefix='of-',dir=os.environ['TMPDIR'])as directory:
   listener=socket.socket(socket.AF_UNIX);self.addCleanup(listener.close)
   listener.bind(str(Path(directory)/'s'));listener.listen(1)
   child=subprocess.Popen([sys.executable,'-c',"import sys;sys.stderr.write('synthetic bootstrap refusal');sys.exit(7)"],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
   self.addCleanup(stop_child,child)
   with self.assertRaisesRegex(AssertionError,'exit 7.*synthetic bootstrap refusal'):
    accept_child(listener,child,'bootstrap')
   self.assertEqual(child.returncode,7)

if __name__=='__main__':unittest.main(verbosity=2)
