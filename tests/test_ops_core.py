"""Real SQLite and private Unix sockets; only engine and canonical AUTH are owned fixtures."""
import contextlib,hashlib,json,os,socket,stat,struct,tempfile,threading,time,unittest,uuid
from pathlib import Path
from reverie.ops_common import *
from reverie.ops_core import Core,Ledger,evidence
from reverie.ops_transport import Client,Server,envelope,receive,send,verified
from reverie.ops_auth import UnavailableAuth
SID='11111111-1111-4111-8111-111111111111';EID='22222222-2222-4222-8222-222222222222';POL='sha256:'+'a'*64
class Authority:
 def __init__(self):self.revoked=False;self.policy=POL;self.queries=[]
 def check(self,actor,action,resource,grant,artifact):
  self.queries.append((actor,action,resource,grant,artifact))
  if self.revoked:return {'availability':'denied','reason':'revoked-grant','policyGeneration':self.policy}
  return {'availability':'allowed','reason':'none','policyGeneration':self.policy}
class Adapter:
 adapter_id='owned-fixture';version='v1';installed=True
 def __init__(self):self.number=1;self.calls=0;self.mode='ok';self.barrier=None
 def snapshot(self):return {'website':{'number':self.number},'workers':{'fixed':'preserved'}}
 def generation(self,snapshot):return digest(snapshot['website'])
 def binding_digest(self):return digest({'adapter':'owned-fixture'})
 def supports(self,action):return action in ACTIONS
 def artifact(self,action,ref):return ref=={'artifactId':'reviewed','digest':'sha256:'+'b'*64,'reviewId':'review-1'}
 def execute(self,action,artifact,before,begin):
  if self.mode=='revoke-before-effect':self.authority.revoked=True
  begin();self.calls+=1
  if self.barrier:self.barrier.wait(3)
  self.number+=1
  if self.mode=='crash':raise SystemExit('simulated process death after effect')
  if self.mode=='failure-after-effect':raise RuntimeError('owned failure')
  return 'verified','none',[evidence(k,'pass',{'check':k}) for k in ('artifact-matches','website-process-changed','application-ready','laptops-preserved','providers-preserved')],self.generation(self.snapshot())
class Ops(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name).resolve();self.company=self.root/'company.json';self.write_company();self.ledger=Ledger(self.root/'state');self.authority=Authority();self.adapter=Adapter();self.adapter.authority=self.authority;self.core=Core(self.ledger,self.company,'company-1',{'website':self.adapter},self.authority)
 def write_company(self,session=SID,extra=None):
  rows=[{'id':EID,'sessionId':session,'desiredRunning':True,'owner':'owner-1'}]
  if extra:rows.append(extra)
  self.company.write_bytes(canonical({'employees':rows,'retired':[]}));self.company.chmod(0o600)
 def cmd(self,key='key-1'):
  actor=self.core.actor(SID);_,view=self.core.view(actor,'website');return {'kind':'reverie.ops.command','version':1,'requestId':'request-1','resourceId':'website','action':ACTIONS[3],'idempotencyKey':key,'grantRef':{'grantId':'grant-1','policyGeneration':POL},'artifact':{'artifactId':'reviewed','digest':'sha256:'+'b'*64,'reviewId':'review-1'},'expectedResourceGeneration':view['resourceGeneration'],'expectedCapabilityGeneration':view['capabilityGeneration']}
 def latest(self,op):
  with self.ledger.db() as db:return self.ledger.latest(db,op)
 def admit(self,cmd=None):
  r=self.core.dispatch(SID,cmd or self.cmd(),start=False);self.assertEqual(r['decision'],'accepted',r);return r['operationId']
 def test_admission_is_durable_before_any_effect_and_receipts_append(self):
  op=self.admit();self.assertEqual(self.adapter.calls,0);self.assertEqual(self.latest(op)['state'],'accepted');self.core.run(SID,op);self.assertEqual(self.latest(op)['state'],'verified')
  with self.ledger.db() as db:
   rows=db.execute('SELECT sequence,body FROM receipts WHERE operation=? ORDER BY sequence',(op,)).fetchall();self.assertEqual([r['sequence'] for r in rows],[1,2,3]);self.assertEqual([strict_json(r['body'])['state'] for r in rows],['accepted','executing','verified'])
 def test_idempotency_same_command_returns_same_receipt_after_effect(self):
  cmd=self.cmd();op=self.admit(cmd);self.core.run(SID,op);again=self.core.dispatch(SID,cmd,start=False);self.assertEqual(again['operationId'],op);self.assertEqual(self.adapter.calls,1)
 def test_delivery_id_changes_do_not_change_semantic_digest_or_repeat_effect(self):
  cmd=self.cmd();op=self.admit(cmd);cmd['requestId']='redelivered';again=self.core.dispatch(SID,cmd,start=False);self.assertEqual(again['operationId'],op);self.assertEqual(self.adapter.calls,0)
 def test_inspect_lost_reply_by_stable_scoped_idempotency_key(self):
  op=self.admit();r=self.core.dispatch(SID,{'kind':'reverie.ops.command','version':1,'requestId':'lookup-1','action':ACTIONS[1],'resourceId':'website','lookupIdempotencyKey':'key-1'});self.assertEqual(r['operationId'],op)
  with self.assertRaises(Refusal):self.core.dispatch(SID,{'kind':'reverie.ops.command','version':1,'requestId':'lookup-2','action':ACTIONS[1],'resourceId':'website','lookupIdempotencyKey':'absent'})
 def test_changed_digest_same_key_refuses_without_new_effect(self):
  cmd=self.cmd();self.admit(cmd);cmd['expectedResourceGeneration']='sha256:'+'d'*64;r=self.core.dispatch(SID,cmd,start=False);self.assertEqual(r['reason'],'idempotency-conflict');self.assertEqual(self.adapter.calls,0)
 def test_resource_fence_blocks_other_key_and_stale_generation_after_restart(self):
  cmd=self.cmd();op=self.admit(cmd);other=dict(cmd,idempotencyKey='key-2');self.assertEqual(self.core.dispatch(SID,other,start=False)['reason'],'resource-busy');self.core.run(SID,op);self.assertEqual(self.core.dispatch(SID,other,start=False)['reason'],'stale-resource')
 def test_atomic_concurrent_admission_only_one_key(self):
  commands=[self.cmd('key-'+str(i)) for i in range(8)];gate=threading.Barrier(8);results=[]
  def work(c):gate.wait();results.append(self.core.dispatch(SID,c,start=False))
  threads=[threading.Thread(target=work,args=(c,)) for c in commands]
  for t in threads:t.start()
  for t in threads:t.join(5)
  self.assertEqual(sum(r['decision']=='accepted' for r in results),1);self.assertEqual(self.adapter.calls,0)
 def test_two_execution_claims_never_repeat_effect(self):
  op=self.admit();threads=[threading.Thread(target=self.core.run,args=(SID,op)) for _ in range(2)]
  for t in threads:t.start()
  for t in threads:t.join(5)
  self.assertEqual(self.adapter.calls,1);self.assertEqual(self.latest(op)['state'],'verified')
 def test_overlap_claim_does_not_cancel_another_executing_owner(self):
  self.adapter.barrier=threading.Event();op=self.admit();thread=threading.Thread(target=self.core.run,args=(SID,op));thread.start()
  deadline=time.monotonic()+3
  while self.adapter.calls!=1 and time.monotonic()<deadline:time.sleep(.01)
  self.assertEqual(self.adapter.calls,1);self.core.run(SID,op);self.assertEqual(self.latest(op)['state'],'executing')
  with self.ledger.db() as db:self.assertEqual(db.execute('SELECT operation FROM fences').fetchone()[0],op)
  self.adapter.barrier.set();thread.join(5);self.assertEqual(self.latest(op)['state'],'verified');self.assertEqual(self.adapter.calls,1)
 def test_revocation_at_last_effect_boundary_is_failed_no_effect(self):
  self.adapter.mode='revoke-before-effect';op=self.admit();self.core.run(SID,op);r=self.latest(op);self.assertEqual(r['state'],'failed');self.assertIn(r['reason'],('revoked-grant','stale-capability'));self.assertEqual(self.adapter.calls,0)
 def test_failure_after_begin_retains_unconfirmed_fence(self):
  self.adapter.mode='failure-after-effect';op=self.admit();self.core.run(SID,op);self.assertEqual(self.latest(op)['state'],'unconfirmed');self.assertEqual(self.core.dispatch(SID,self.cmd('key-2'),start=False)['reason'],'resource-busy')
 def test_reconciliation_records_proof_but_only_explicit_authorized_successor_replaces_fence(self):
  self.adapter.mode='failure-after-effect';op=self.admit();self.core.run(SID,op)
  self.adapter.reconcile=lambda before,current:[evidence('resource-state-known','pass',current),evidence('laptops-preserved','pass',current),evidence('providers-preserved','pass',current)]
  self.core.inspect(self.core.actor(SID),'website',op)
  self.assertEqual(self.latest(op)['state'],'unconfirmed')
  with self.ledger.db() as db:self.assertEqual(db.execute('SELECT operation FROM fences').fetchone()[0],op)
  successor=self.core.dispatch(SID,self.cmd('explicit-successor'),start=False);self.assertEqual(successor['decision'],'accepted');self.assertEqual(self.adapter.calls,1)
  with self.ledger.db() as db:self.assertEqual(db.execute('SELECT operation FROM fences').fetchone()[0],successor['operationId'])
 def test_changed_resource_after_reconciliation_keeps_fence(self):
  self.adapter.mode='failure-after-effect';op=self.admit();self.core.run(SID,op);self.adapter.reconcile=lambda before,current:[evidence('resource-state-known','pass',current)];self.core.inspect(self.core.actor(SID),'website',op);self.adapter.number+=1
  self.assertEqual(self.core.dispatch(SID,self.cmd('new-generation'),start=False)['reason'],'resource-busy')
 def test_crash_recovery_never_reexecutes(self):
  self.adapter.mode='crash';cmd=self.cmd();op=self.admit(cmd)
  with self.assertRaises(SystemExit):self.core.run(SID,op)
  self.assertEqual(self.latest(op)['state'],'executing');core=Core(Ledger(self.root/'state'),self.company,'company-1',{'website':self.adapter},self.authority);core.recover();self.assertEqual(self.latest(op)['state'],'unconfirmed');self.assertEqual(self.adapter.calls,1);self.assertEqual(core.dispatch(SID,cmd,start=False)['operationId'],op)
 def test_accepted_crash_cancels_known_pre_effect_without_retry(self):
  op=self.admit();self.core.recover();r=self.latest(op);self.assertEqual(r['state'],'failed');self.assertEqual(self.adapter.calls,0);self.assertTrue(any(e['check']=='no-effect-started' for e in r['evidence']))
 def test_old_session_or_forged_actor_is_not_authority(self):
  cmd=self.cmd();cmd['actor']={'employeeId':EID}
  with self.assertRaises(Refusal):self.core.dispatch(SID,cmd,start=False)
  cmd=self.cmd();self.write_company(session=str(uuid.uuid4()))
  with self.assertRaises(Refusal):self.core.dispatch(SID,cmd,start=False)
 def test_ambiguous_registry_rejected(self):
  self.write_company(extra={'id':str(uuid.uuid4()),'sessionId':SID})
  with self.assertRaises(Refusal):self.core.actor(SID)
 def test_stale_policy_capability_and_unreviewed_artifact(self):
  for field,value,reason in [('expectedCapabilityGeneration','sha256:'+'c'*64,'stale-capability'),('artifact',{'artifactId':'wrong','digest':'sha256:'+'b'*64,'reviewId':'review-1'},'unreviewed-artifact')]:
   cmd=self.cmd();cmd[field]=value;self.assertEqual(self.core.dispatch(SID,cmd,start=False)['reason'],reason)
 def test_inspect_scoped_to_current_employee_and_resource(self):
  op=self.admit();r=self.core.dispatch(SID,{'kind':'reverie.ops.command','version':1,'requestId':'inspect-1','resourceId':'website','action':ACTIONS[1],'operationId':op});self.assertEqual(r['operationId'],op)
  second=str(uuid.uuid4());self.write_company(extra={'id':str(uuid.uuid4()),'sessionId':second,'desiredRunning':True})
  with self.assertRaises(Refusal):self.core.dispatch(second,{'kind':'reverie.ops.command','version':1,'requestId':'inspect-2','resourceId':'website','action':ACTIONS[1],'operationId':op})
 def test_missing_auth_is_unavailable_never_legacy_sid_upgrade(self):
  self.core.auth=UnavailableAuth();cmd=self.cmd();r=self.core.dispatch(SID,cmd,start=False);self.assertEqual(r['reason'],'adapter-unavailable');self.assertEqual(self.adapter.calls,0)
 def test_operation_limit_refuses_instead_of_evicting_tombstones(self):
  self.ledger.max=1;cmd=self.cmd();op=self.admit(cmd);self.core.run(SID,op);r=self.core.dispatch(SID,self.cmd('key-2'),start=False);self.assertEqual(r['reason'],'audit-unavailable');self.assertEqual(self.core.dispatch(SID,cmd,start=False)['operationId'],op)
 def test_private_uds_auth_stable_identity_and_command_response(self):
  directory=self.root/'socket';directory.mkdir(mode=0o700);key=os.urandom(32);server=Server(directory/'ops.sock',key,self.ledger,self.core).start();self.addCleanup(server.close);client=Client(directory/'ops.sock',key)
  status={'kind':'reverie.ops.command','version':1,'requestId':'status-1','resourceId':'website','action':ACTIONS[0]};r=client.call(SID,status);self.assertTrue(r['success']);self.assertEqual(r['data']['actor']['employeeId'],EID)
  r=client.call(str(uuid.uuid4()),status);self.assertFalse(r['success']);self.assertEqual(r['reason'],'stable-identity-unavailable')
  with self.assertRaises(Refusal):Client(directory/'ops.sock',key,uid=os.getuid()+1).call(SID,status)
 def test_uds_durable_nonce_replay_rejected(self):
  directory=self.root/'socket';directory.mkdir(mode=0o700);key=os.urandom(32);server=Server(directory/'ops.sock',key,self.ledger,self.core).start();self.addCleanup(server.close)
  body={'version':1,'nonce':str(uuid.uuid4()),'issuedAt':int(time.time()),'session':SID,'command':{'kind':'reverie.ops.command','version':1,'requestId':'status-1','resourceId':'website','action':ACTIONS[0]}}
  replies=[]
  for _ in range(2):
   with socket.socket(socket.AF_UNIX) as conn:
    conn.connect(str(directory/'ops.sock'));end=time.monotonic()+5;send(conn,envelope(key,body),end,16384);replies.append(verified(key,receive(conn,end,65536))['response'])
  self.assertTrue(replies[0]['success']);self.assertFalse(replies[1]['success'])
 def test_ledger_symlink_and_nonprivate_directory_refused(self):
  (self.root/'linked').symlink_to(self.root/'state',target_is_directory=True)
  with self.assertRaises((Refusal,OSError)):Ledger(self.root/'linked')
  (self.root/'public').mkdir(mode=0o755)
  (self.root/'public').chmod(0o755)  # Keep the exposure fixture public under any inherited umask.
  with self.assertRaises(Refusal):Ledger(self.root/'public')
if __name__=='__main__':unittest.main()
