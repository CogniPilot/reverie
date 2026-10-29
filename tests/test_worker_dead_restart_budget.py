"""Real R admission/EID storage, owned kernel/engine ports; no live lifecycle."""
import copy
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import socket
import subprocess
import threading
import time
import unittest
from unittest.mock import patch

from reverie import worker as W, worker_resource_reservations as R
from reverie.worker_resources import policy_digest
from tests import test_worker_resource_reservations as F


class DeadRestartBudget(unittest.TestCase):
    def setUp(self):
        patch.object(W.Broker,'run_engine',side_effect=AssertionError('REAL_ENGINE_FORBIDDEN')).start()
        self.addCleanup(patch.stopall)
        self.f=F.Reservations();self.f.setUp();self.addCleanup(self.f.doCleanups)
        self.config=self.f.config;self.config['poolMemoryMiB']=2048
        # The R-only fixture creates namespace anchor parents with mkdir's
        # default mode. Canonical J requires its real owned storage parents0700.
        for name in ('stateRoot','scratchRoot'):
            for path in [Path(self.config[name]),*Path(self.config[name]).rglob('*')]:
                if path.is_dir() and not path.is_symlink():path.chmod(0o700)
        self.item=self.f.native.rows[0]
        self.item['Config']['Labels']['reverie.worker-policy']=policy_digest(self.config,F.SID)
        initial=dict(self.config);initial.pop('resourceReservations');initial['stateRoot']=str(self.f.root/'initial-unbound')
        self.broker=W.Broker(initial);self.broker.config=self.config;self.broker.resource_reservations=self.f.gate
        self.f.gate.broker=self.broker;self.f.gate.native.broker=self.broker
        self.calls=[];self.panes=['1','1'];self.after_stop=lambda:None;self.confirm_stop=True
        original=self.f.native.run_engine
        def engine(args,optional=False,*,deadline=None):
            self.calls.append(args)
            if args[0]=='exec':
                pane=self.panes.pop(0) if len(self.panes)>1 else self.panes[0]
                if callable(pane):pane=pane()
                return subprocess.CompletedProcess(args,0,pane,'')
            if args[0]in('stop','kill'):
                if self.confirm_stop:self.item['State'].update(Running=False,Pid=0)
                self.after_stop()
                return subprocess.CompletedProcess(args,0,'','')
            if args[0]=='ps' and '--quiet'in args:
                rows=[r['Id'] for r in self.f.native.rows if '--all'in args or r['State']['Running']]
                return subprocess.CompletedProcess(args,0,'\n'.join(rows),'')
            if args[:2]==['network','inspect']:
                return subprocess.CompletedProcess(args,1,'','absent owned fixture network')
            if args[0]=='inspect':
                requested=args[1:];known={r['Name'][1:]:r['Id'] for r in self.f.native.rows}
                args=[args[0]]+[known.get(x,x)for x in requested]
                records=[r for r in self.f.native.rows if r['Id']in args[1:]]
                if not records:return subprocess.CompletedProcess(args,1,'','absent owned fixture')
            return original(args,optional,deadline=deadline)
        self.broker.run_engine=engine
        self.runtime=Path(self.config['stateRoot'])/F.SID;self.runtime.mkdir(mode=0o700)
        (self.runtime/'runtime.json').write_text(json.dumps({'exit':'owned.exit'}))
        self.home=Path(self.config['stateRoot'])/'employees'/F.EID/'home'
        self.receipt=self.home/'.reverie-launch/owned.exit'
        self.broker.office=lambda sid:None
        patch.object(W.pty,'openpty',side_effect=RuntimeError('CONTROLLED_VIEWER_BOUNDARY')).start()
        self.budget_calls=[];original_budget=self.broker.check_creation_budget
        def budget(sid,resources):
            self.budget_calls.append(self.item['State']['Running'])
            return original_budget(sid,resources,proc_root=self.f.proc)
        self.broker.check_creation_budget=budget
        def prepared(*args):
            self.assertFalse(self.item['State']['Running']);self.assertEqual(self.item['State']['Pid'],0)
            self.assertIn(F.SID,self.broker.storage_leases);self.assertEqual(getattr(self.f.gate._local,'depth',0),1)
            fd=os.open(self.f.gate.root/'admission.lock',os.O_RDWR)
            try:
                with self.assertRaises(BlockingIOError):fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            finally:os.close(fd)
            raise RuntimeError('CONTROLLED_AFTER_SETTLEMENT_ADMISSION')
        patch.object(W,'prepare_store',side_effect=prepared).start()
        self.addCleanup(lambda:[self.broker.release_storage(s)for s in list(self.broker.storage_leases)])

    def request(self,attach=False):
        client,server=socket.socketpair();client.settimeout(5)
        self.broker.connections.acquire()
        W.send_frame(client,b'J',json.dumps({'sessionId':F.SID,'cwd':'/workspace','command':'owned saved recipe',
                     'env':{},'cols':80,'rows':24,**({'attachOnly':True}if attach else{})}).encode())
        try:self.broker.handle(server);return W.receive_frame(client)
        finally:client.close();server.close()

    def stopped(self):return [c for c in self.calls if c[0]in('stop','kill')]

    def test_full_pool_dead_inner_reaches_admission_only_after_exact_old_stop(self):
        roots=[self.home.stat().st_ino,(self.home.parent/'nix').stat().st_ino]
        kind,body=self.request();self.assertEqual(kind,b'E');self.assertIn(b'CONTROLLED_AFTER_SETTLEMENT_ADMISSION',body)
        self.assertEqual(self.budget_calls,[False]);self.assertEqual(self.stopped(),[['stop','--time','2',self.item['Id']]])
        self.assertEqual(roots,[self.home.stat().st_ino,(self.home.parent/'nix').stat().st_ino])
        self.assertFalse(any(c[0]in('create','start','rm')for c in self.calls))

    def test_full_pool_completion_receipt_replacement_also_stops_exact_source_first(self):
        self.receipt.parent.mkdir(mode=0o700,exist_ok=True);self.receipt.write_text('0')
        kind,body=self.request();self.assertEqual(kind,b'E');self.assertIn(b'CONTROLLED_AFTER_SETTLEMENT_ADMISSION',body)
        self.assertEqual(self.budget_calls,[False]);self.assertEqual(self.stopped()[0],['stop','--time','2',self.item['Id']])

    def test_live_inner_at_full_pool_reattaches_without_budget_or_stop(self):
        self.panes=['0'];kind,body=self.request()
        self.assertEqual(kind,b'E');self.assertIn(b'CONTROLLED_VIEWER_BOUNDARY',body)
        self.assertEqual(self.stopped(),[]);self.assertEqual(self.budget_calls,[])

    def test_attach_only_cannot_stop_or_create_dead_inner(self):
        kind,body=self.request(attach=True);self.assertEqual(kind,b'E');self.assertIn(b'never starts a replacement',body)
        self.assertEqual(self.stopped(),[]);self.assertEqual(self.budget_calls,[])

    def test_unknown_or_revived_pane_never_gets_replacement_credit(self):
        for values in (['unknown'],['1','0']):
            self.panes=list(values);kind,body=self.request();self.assertEqual(kind,b'E');self.assertIn(b'pane',body)
            self.assertEqual(self.stopped(),[])

    def test_owner_OFF_after_exact_stop_refuses_before_replacement_budget(self):
        def change():self.f.employee['desiredRunning']=False;self.f.company()
        self.after_stop=change;kind,body=self.request();self.assertEqual(kind,b'E')
        self.assertEqual(len(self.stopped()),1);self.assertEqual(self.budget_calls,[])
        self.assertFalse(any(c[0]in('create','start','rm')for c in self.calls))

    def test_binding_generation_after_stop_refuses_before_new_budget(self):
        def change():self.f.employee['sessionGeneration']=2;self.f.company()
        self.after_stop=change;kind,body=self.request();self.assertEqual(kind,b'E')
        self.assertEqual(len(self.stopped()),1);self.assertEqual(self.budget_calls,[])

    def test_policy_or_drain_change_after_stop_refuses_before_new_budget(self):
        self.after_stop=self.broker.draining.set
        kind,body=self.request();self.assertEqual(kind,b'E');self.assertEqual(len(self.stopped()),1);self.assertEqual(self.budget_calls,[])

    def test_vacation_after_stop_refuses_before_new_budget(self):
        def change():self.f.employee['onVacation']=True;self.f.company()
        self.after_stop=change;kind,body=self.request();self.assertEqual(kind,b'E');self.assertEqual(self.budget_calls,[])

    def test_effective_policy_after_stop_refuses_before_new_budget(self):
        self.after_stop=lambda:self.broker.config.update(memoryMiB=4096)
        kind,body=self.request();self.assertEqual(kind,b'E');self.assertEqual(self.budget_calls,[])

    def test_account_recipe_after_stop_refuses_before_new_budget(self):
        def change():self.f.employee['runtimeRecipe']={'mode':'claude','subscriptionProfile':{'id':'changed-fixture'}};self.f.company()
        self.after_stop=change;kind,body=self.request();self.assertEqual(kind,b'E');self.assertEqual(self.budget_calls,[])

    def test_competing_admission_cannot_enter_between_stop_and_replacement_budget(self):
        attempted=threading.Event();entered=threading.Event();errors=[];threads=[]
        original=self.f.gate._admission_mutex;owner=threading.get_ident()
        @contextmanager
        def observed(deadline):
            if threading.get_ident()!=owner:attempted.set()
            with original(deadline):yield
        def compete():
            try:
                with self.f.gate.admission(deadline=time.monotonic()+3):entered.set()
            except BaseException as error:errors.append(error)
        def stopped():
            thread=threading.Thread(target=compete);threads.append(thread);thread.start()
            self.assertTrue(attempted.wait(1));self.assertFalse(entered.wait(.03))
        self.after_stop=stopped
        with patch.object(self.f.gate,'_admission_mutex',observed):
            kind,body=self.request()
            for thread in threads:thread.join(3);self.assertFalse(thread.is_alive())
        self.assertEqual(kind,b'E');self.assertIn(b'CONTROLLED_AFTER_SETTLEMENT_ADMISSION',body)
        self.assertEqual(self.budget_calls,[False]);self.assertTrue(entered.is_set());self.assertEqual(errors,[])

    def test_unconfirmed_old_settlement_never_reaches_creation_budget_and_retains_lease(self):
        self.confirm_stop=False;kind,body=self.request();self.assertEqual(kind,b'E')
        self.assertTrue(self.item['State']['Running']);self.assertEqual(self.budget_calls,[])
        self.assertIn(F.SID,self.broker.storage_leases)

    def test_current_CID_replacement_between_pane_probe_and_stop_is_not_touched(self):
        def change():self.item['Id']='b'*64;return '1'
        self.panes=['1',change];kind,body=self.request();self.assertEqual(kind,b'E')
        self.assertIn(b'identity changed',body);self.assertEqual(self.stopped(),[]);self.assertEqual(self.budget_calls,[])

    def test_current_init_birth_change_before_stop_is_not_touched(self):
        def change():
            path=self.f.proc/'123/stat';raw=path.read_text();path.write_text(raw.rsplit('77',1)[0]+'88')
            return '1'
        self.panes=['1',change];kind,body=self.request();self.assertEqual(kind,b'E')
        self.assertIn(b'incarnation changed',body);self.assertEqual(self.stopped(),[]);self.assertEqual(self.budget_calls,[])

    def test_unchanged_gate_never_credits_running_sameSID_or_unrelated_new_seat(self):
        resources=W.effective_config(self.config,F.SID)
        for sid in (F.SID,'ffffffff-ffff-4fff-8fff-ffffffffffff'):
            with self.subTest(sid=sid),self.f.gate.admission(sid):
                with self.assertRaisesRegex(ValueError,'CAPACITY_EXHAUSTED'):
                    W.Broker.check_creation_budget(self.broker,sid,resources,proc_root=self.f.proc)
        self.assertEqual(self.stopped(),[])
