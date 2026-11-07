import tempfile
import unittest
from pathlib import Path
from reverie.host_actions import ActionQueue, Principal, validate_operation

SID = '11111111-1111-4111-8111-111111111111'

class HostActionsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.now = 1000
        self.target = {'containerId':'a'*64,'policyDigest':'b'*64}
        self.calls = []
        self.q = ActionQueue(str(Path(self.temp.name)/'actions.db'),lambda _:self.target.copy(),lambda op,target,permit:(permit.begin(),self.calls.append((op,target))),lambda:self.now)
        self.agent = Principal('session-a')
        self.owner = Principal('owner',True)

    def pending(self):
        return self.q.request(self.agent,{'action':'stop-laptop','sessionId':SID})

    def approved(self):
        r=self.pending()
        self.q.decide(self.owner,r['id'],r['digest'],True)
        return r

    def test_allowlist_rejects_commands_paths_and_limits(self):
        for value in [{'action':'shell'},{'action':'stop-laptop','sessionId':SID,'command':'id'},{'action':'apply-runtime-pool','memoryMiB':0},{'action':'verify-runtime-pool','path':'/tmp/x'},{'action':'stop-laptop','sessionId':'--all'}]:
            with self.subTest(value=value),self.assertRaises(ValueError): validate_operation(value)

    def test_no_side_effect_without_owner_approval(self):
        r=self.pending()
        with self.assertRaises(ValueError):self.q.run(r['id'])
        with self.assertRaises(PermissionError):self.q.decide(self.agent,r['id'],r['digest'],True)
        self.assertEqual(self.calls,[])

    def test_receipts_are_requester_scoped(self):
        r=self.pending()
        with self.assertRaises(PermissionError):self.q.get(Principal('session-b'),r['id'])
        self.assertEqual(self.q.get(self.owner,r['id'])['state'],'pending')

    def test_digest_and_expiry_bind_approval(self):
        r=self.pending()
        with self.assertRaises(ValueError):self.q.decide(self.owner,r['id'],'0'*64,True)
        self.now+=301
        with self.assertRaises(ValueError):self.q.decide(self.owner,r['id'],r['digest'],True)

    def test_approved_execution_is_at_most_once(self):
        r=self.approved()
        self.assertEqual(self.q.run(r['id']),'succeeded')
        with self.assertRaises(ValueError):self.q.run(r['id'])
        self.assertEqual(len(self.calls),1)

    def test_target_recreation_invalidates_approval(self):
        r=self.approved();self.target['containerId']='c'*64
        self.assertEqual(self.q.run(r['id']),'failed')
        self.assertEqual(self.calls,[])

    def test_uncertain_execution_never_automatically_retries(self):
        r=self.approved()
        def uncertain(*_):raise TimeoutError('private detail')
        self.q.execute=uncertain
        self.assertEqual(self.q.run(r['id']),'unconfirmed')
        self.assertNotIn('private detail',str(self.q.get(self.owner,r['id'])))
        with self.assertRaises(ValueError):self.q.run(r['id'])

    def test_denial_cannot_be_reapproved(self):
        r=self.pending();self.q.decide(self.owner,r['id'],r['digest'],False)
        with self.assertRaises(ValueError):self.q.decide(self.owner,r['id'],r['digest'],True)

    def test_approval_cannot_be_used_after_expiry(self):
        r=self.approved();self.now+=301
        with self.assertRaises(ValueError):self.q.run(r['id'])

    def test_crash_recovery_marks_claim_unconfirmed(self):
        r=self.approved()
        with self.q.connect() as db:db.execute("UPDATE actions SET state='executing' WHERE id=?",(r['id'],))
        self.assertEqual(self.q.recover(),1)
        self.assertEqual(self.q.get(self.agent,r['id'])['state'],'unconfirmed')
        with self.assertRaises(ValueError):self.q.run(r['id'])

    def test_pending_request_cap(self):
        for _ in range(16):self.pending()
        with self.assertRaises(ValueError):self.pending()
        self.now+=301
        self.pending()


class PrivateStorageTests(unittest.TestCase):
    def test_public_directory_and_symlink_database_refused(self):
        import os
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            (root/'elsewhere').write_text('')
            (root/'db').symlink_to(root/'elsewhere')
            with self.assertRaises(ValueError):ActionQueue(str(root/'db'),lambda _:None,lambda *_:None)
            (root/'db').unlink();os.chmod(root,0o755)
            with self.assertRaises(ValueError):ActionQueue(str(root/'db'),lambda _:None,lambda *_:None)

    def test_principal_fields_are_not_coerced(self):
        for value in [('owner','false'),('',True),('x'*129,False)]:
            with self.assertRaises(ValueError):Principal(*value)

if __name__ == '__main__':unittest.main()

class ExecutionDeadlineTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.path=str(Path(self.temp.name)/'queue.db')
        self.now=1000
        self.owner=Principal('owner',True);self.agent=Principal('session-a')

    def approve(self,queue,operation):
        row=queue.request(self.agent,operation);queue.decide(self.owner,row['id'],row['digest'],True)
        self.now=row['expires']-1
        return row

    def test_expiry_during_first_resolve_has_no_effect(self):
        effects=[]
        queue=ActionQueue(self.path,lambda _:{'target':'same'},lambda *_:effects.append(self.now),lambda:self.now)
        row=self.approve(queue,{'action':'stop-laptop','sessionId':SID})
        def slow(_):self.now+=2;return {'target':'same'}
        queue.resolve=slow
        self.assertEqual(queue.run(row['id']),'failed')
        self.assertEqual(effects,[])
        with self.assertRaises(ValueError):queue.run(row['id'])

    def test_expiry_after_partial_effect_is_unconfirmed_and_not_retried(self):
        effects=[]
        def execute(op,preview,permit):
            permit.begin();effects.append(self.now);self.now+=2;permit.begin()
        queue=ActionQueue(self.path,lambda _:{'target':'same'},execute,lambda:self.now)
        row=self.approve(queue,{'action':'stop-laptop','sessionId':SID})
        self.assertEqual(queue.run(row['id']),'unconfirmed')
        self.assertEqual(len(effects),1)
        with self.assertRaises(ValueError):queue.run(row['id'])

    def test_two_queue_connections_cannot_both_execute(self):
        import threading
        effects=[];barrier=threading.Barrier(2);outcomes=[]
        a=ActionQueue(self.path,lambda _:{'same':True},lambda *_:effects.append('effect'))
        b=ActionQueue(self.path,lambda _:{'same':True},lambda *_:effects.append('effect'))
        row=a.request(self.agent,{'action':'stop-laptop','sessionId':SID});a.decide(self.owner,row['id'],row['digest'],True)
        def run(queue):
            barrier.wait()
            try:outcomes.append(queue.run(row['id']))
            except ValueError:outcomes.append('refused')
        threads=[threading.Thread(target=run,args=(q,)) for q in (a,b)]
        for thread in threads:thread.start()
        for thread in threads:thread.join(3);self.assertFalse(thread.is_alive())
        self.assertEqual(effects,['effect']);self.assertEqual(sorted(outcomes),['refused','succeeded'])
