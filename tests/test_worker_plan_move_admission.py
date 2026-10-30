"""Normal J storage waits: real common admission/flocks/leases, closed engine port."""
import copy
import json
import os
from pathlib import Path
import socket
import subprocess
import threading
import time
import types
import unittest
from unittest.mock import patch

from tests import test_worker_dead_pane_recovery as fixture
from reverie import worker as W, worker_resource_reservations as R, worker_resource_native as N

NEW = '99999999-8888-4777-8666-555555555555'


class PlanMoveAdmission(unittest.TestCase):
    save = fixture.DeadPaneRecovery.save

    def setUp(self):
        fixture.DeadPaneRecovery.setUp(self)
        self.broker.claim_storage(fixture.SID)
        self.old_name = self.item['Name'][1:]
        self.broker.laptops[fixture.SID] = self.old_name
        self.company['employees'][0].update(sessionId=NEW, sessionGeneration=2,
            runtimeRecipe={'mode':'claude','subscriptionProfile':{'id':'owned-account'}})
        self.save()
        journal=Path(self.config['companyFile']).with_name('plan-moves.json')
        journal.write_text(json.dumps([{'employeeId':fixture.EID,'oldSession':fixture.SID,
            'newSession':NEW,'phase':'starting','sourceStopRequested':True,'sourceCleanupVerified':True}]))
        journal.chmod(0o600)
        self.gate=R.ReservationGate.__new__(R.ReservationGate)
        self.gate.root=self.root/'real-r-lock';self.gate.root.mkdir(mode=0o700)
        (self.gate.root/'admission.lock').touch(mode=0o600)
        self.gate._mutex=threading.RLock();self.gate._local=threading.local()
        self.gate.native=types.SimpleNamespace(_local=threading.local())
        self.gate._guard=lambda:None;self.gate.check_launch=lambda sid:None
        self.gate.check_stop=lambda *args:None
        self.broker.resource_reservations=self.gate
        self.old_running=True;self.engine_stops=[];self.budget_calls=[]
        self.claim_blocked=threading.Event();original=self.broker.claim_storage
        def claim(sid):
            try:return original(sid)
            except BlockingIOError:self.claim_blocked.set();raise
        self.broker.claim_storage=claim
        def engine(args,optional=False,**kwargs):
            if args[0]=='stop':
                self.engine_stops.append(args);self.old_running=False
                return subprocess.CompletedProcess(args,0,'','')
            if args[0]=='inspect':
                if args[1]==self.old_name or args[1]==self.item['Id']:
                    item=copy.deepcopy(self.item)
                    item['State']={'Running':self.old_running,'Pid':os.getpid() if self.old_running else 0}
                    return subprocess.CompletedProcess(args,0,json.dumps([item]),'')
                return subprocess.CompletedProcess(args,1,'','')
            if args[:2]==['network','inspect']:
                return subprocess.CompletedProcess(args,1,'','')
            raise AssertionError('Unexpected engine effect: '+repr(args))
        self.broker.run_engine=engine
        def budget(*args):
            self.assertFalse(self.old_running)
            self.assertNotIn(fixture.SID,self.broker.storage_leases)
            self.assertIn(NEW,self.broker.storage_leases)
            self.budget_calls.append(True)
            raise RuntimeError('controlled successor creation admission')
        self.broker.check_creation_budget=budget

    def send_request(self,protected=None):
        client,server=socket.socketpair();client.settimeout(15)
        try:
            self.broker.connections.acquire()
            W.send_frame(client,b'J',json.dumps({'sessionId':NEW,'cwd':'/workspace',
                'command':'owned selected saved launch','env':{},'cols':80,'rows':24}).encode())
            self.broker.handle(server,_resource_launch=protected)
            return W.receive_frame(client)
        finally:client.close();server.close()

    def concurrent(self,action):
        errors=[]
        def run():
            try:
                self.assertTrue(self.claim_blocked.wait(2));action()
            except BaseException as error:errors.append(error)
        thread=threading.Thread(target=run);thread.start()
        self.addCleanup(lambda:thread.join(3))
        return thread,errors

    def test_real_concurrent_exact_old_stop_releases_lease_before_new_creation_admission(self):
        before=(self.paths.home.stat().st_ino,self.paths.nix.stat().st_ino)
        def stop():
            W.Broker.stop(self.broker,self.old_name,expected_id=self.item['Id'],
                expected_process={'pid':os.getpid(),'start':R._pid(os.getpid())})
        thread,errors=self.concurrent(stop);started=time.monotonic();kind,body=self.send_request()
        thread.join(3);self.assertFalse(thread.is_alive());self.assertEqual(errors,[])
        self.assertEqual(kind,b'E');self.assertIn(b'controlled successor creation admission',body)
        self.assertLess(time.monotonic()-started,5);self.assertEqual(len(self.engine_stops),1)
        self.assertEqual(self.budget_calls,[True]);self.assertEqual(before,(self.paths.home.stat().st_ino,self.paths.nix.stat().st_ino))

    def test_actual_supervisor_consumes_stop_journal_while_new_J_waits(self):
        # Exercise the existing detached source producer, not a new stop RPC.
        self.broker.stop=types.MethodType(W.Broker.stop,self.broker)
        self.broker.address=lambda:'127.0.0.1'
        original_wait=self.broker.stopping.wait;ticks=[]
        def wait(seconds):
            if seconds==2:
                ticks.append(True)
                return len(ticks)>1
            return original_wait(seconds)
        with patch.object(self.broker.stopping,'wait',side_effect=wait), \
             patch.object(W.http.client,'HTTPConnection') as connection:
            connection.return_value.getresponse.return_value.status=200
            thread,errors=self.concurrent(self.broker.supervise)
            kind,body=self.send_request();thread.join(3)
        self.assertFalse(thread.is_alive());self.assertEqual(errors,[])
        self.assertEqual(kind,b'E');self.assertIn(b'controlled successor creation admission',body)
        self.assertEqual(len(self.engine_stops),1);self.assertEqual(self.budget_calls,[True])
        self.assertNotIn(fixture.SID,self.broker.laptops)

    def test_uncertain_admission_release_is_not_reentered_or_retried(self):
        reads=[]
        def guard():
            reads.append(True)
            if len(reads)>1:raise RuntimeError('controlled admission finalizer uncertainty')
        self.gate._guard=guard
        kind,body=self.send_request()
        self.assertEqual(kind,b'E');self.assertIn(b'Resource admission release unconfirmed',body)
        self.assertEqual(len(reads),2)
        self.assertIn('RESOURCE_ADMISSION_RELEASE_UNCONFIRMED',self.broker.cleanup_uncertain)
        self.assertIn(fixture.SID,self.broker.storage_leases);self.assertEqual(self.budget_calls,[])

    def deadline_clock(self):
        now=[1000.]
        self.enterContext(patch.object(W.time,'monotonic',side_effect=lambda:now[0]))
        self.gate.native._deadline=types.MethodType(R.NativeObserver._deadline,self.gate.native)
        self.gate._guard=lambda:self.gate.native._deadline()
        return now

    def test_storage_wait_deadline_does_not_expire_later_live_provider_reattachment(self):
        now=self.deadline_clock()
        target=self.config['deployment']+'-agent-'+NEW
        runtime=Path(self.config['stateRoot'])/NEW;runtime.mkdir(mode=0o700)
        (runtime/'runtime.json').write_text(json.dumps({'exit':'owned.exit'}))
        live=copy.deepcopy(self.item)
        live['Name']='/'+target
        live['Config']['Labels'].update({'reverie.session':NEW,
            'reverie.worker-policy':W.policy_digest(self.config,NEW)})
        original_engine=self.broker.run_engine
        def engine(args,optional=False,**kwargs):
            if args[0]=='inspect' and args[1]==target:
                # Slow ordinary startup/reconnect work after successful entry.
                now[0]+=11
                return subprocess.CompletedProcess(args,0,json.dumps([live]),'')
            if args[0]=='exec':
                return subprocess.CompletedProcess(args,0,'0','')
            return original_engine(args,optional,**kwargs)
        self.broker.run_engine=engine
        def settle(seconds):
            now[0]+=seconds
            self.old_running=False
            self.broker.release_storage(fixture.SID)
        self.enterContext(patch.object(self.broker.stopping,'wait',side_effect=settle))
        kind,body=self.send_request()
        self.assertEqual(kind,b'E');self.assertIn(b'controlled viewer boundary',body)
        self.assertEqual(self.budget_calls,[]);self.assertEqual(self.engine_stops,[])
        self.assertNotIn('RESOURCE_ADMISSION_RELEASE_UNCONFIRMED',self.broker.cleanup_uncertain)
        self.assertIn(NEW,self.broker.storage_leases)

    def test_entry_deadline_remains_bounded_during_initial_observation(self):
        now=self.deadline_clock();checks=[]
        def guard():
            checks.append(True);now[0]+=11;self.gate.native._deadline()
        self.gate._guard=guard
        with self.assertRaisesRegex(ValueError,'RESERVATION_OBSERVATION_DEADLINE'):
            with self.gate.admission(entry_deadline=now[0]+10):
                self.fail('An expired entry must not yield')
        self.assertEqual(checks,[True])
        self.assertEqual(getattr(self.gate._local,'depth',0),0)
        self.assertIsNone(self.gate.native._local.deadline)

    def test_storage_wait_deadline_does_not_expire_after_new_provider_start(self):
        now=self.deadline_clock();effects=[];running=[False]
        target=self.config['deployment']+'-agent-'+NEW
        original_engine=self.broker.run_engine
        def engine(args,optional=False,**kwargs):
            if args[0]=='inspect' and args[1]==target:
                item=copy.deepcopy(self.item);item['State']['Running']=running[0]
                return subprocess.CompletedProcess(args,0 if running[0] else 1,json.dumps([item]),'')
            if args[0]=='create':
                effects.append('create')
                return subprocess.CompletedProcess(args,0,'b'*64,'')
            if args[0]=='start':
                effects.append('start');running[0]=True;now[0]+=11
                return subprocess.CompletedProcess(args,0,'','')
            if args[0]=='exec' or args[:2]==['network','create']:
                return subprocess.CompletedProcess(args,0,'','')
            return original_engine(args,optional,**kwargs)
        self.broker.run_engine=engine
        def settle(seconds):
            now[0]+=seconds;self.old_running=False;self.broker.release_storage(fixture.SID)
        def budget(*args):
            self.assertFalse(self.old_running);self.assertIn(NEW,self.broker.storage_leases)
            self.budget_calls.append(True)
        self.broker.check_creation_budget=budget
        self.enterContext(patch.object(self.broker.stopping,'wait',side_effect=settle))
        self.enterContext(patch.object(W,'prepare_store',return_value=None))
        kind,body=self.send_request()
        self.assertEqual(kind,b'E');self.assertIn(b'controlled viewer boundary',body)
        self.assertEqual(effects,['create','start']);self.assertTrue(running[0])
        self.assertNotIn('RESOURCE_ADMISSION_RELEASE_UNCONFIRMED',self.broker.cleanup_uncertain)
        self.assertIn(NEW,self.broker.storage_leases)

    def test_operation_deadline_still_expires_after_successful_timed_entry(self):
        now=self.deadline_clock()
        with self.assertRaisesRegex(ValueError,'RESERVATION_OBSERVATION_DEADLINE'):
            with self.gate.admission(deadline=now[0]+20,entry_deadline=now[0]+10):
                now[0]+=21

    def test_entry_deadline_does_not_replace_shorter_operation_deadline(self):
        now=self.deadline_clock()
        with self.assertRaisesRegex(ValueError,'RESERVATION_OBSERVATION_DEADLINE'):
            with self.gate.admission(deadline=now[0]+5,entry_deadline=now[0]+10):
                now[0]+=6

    def test_entry_deadline_cannot_hide_invalid_operation_deadline(self):
        now=self.deadline_clock()
        for invalid in (now[0]-1,now[0]+3601,float('inf'),True):
            with self.subTest(deadline=invalid),self.assertRaisesRegex(ValueError,'RESERVATION_ADMISSION_DEADLINE'):
                with self.gate.admission(deadline=invalid,entry_deadline=now[0]+10):
                    self.fail('Both deadlines must remain valid')

    def test_entry_deadline_expiry_never_suppresses_a_real_finalizer_failure(self):
        now=self.deadline_clock();guard=self.gate.admission(entry_deadline=now[0]+10)
        guard.__enter__();now[0]+=11
        with patch.object(self.gate,'_guard',side_effect=RuntimeError('controlled changed custody')) as finalizer:
            with self.assertRaisesRegex(RuntimeError,'Resource admission release unconfirmed'):
                self.broker._release_resource_admission(guard)
        finalizer.assert_called_once()
        self.assertIn('RESOURCE_ADMISSION_RELEASE_UNCONFIRMED',self.broker.cleanup_uncertain)

    def change_while_waiting(self,change):
        def mutate():
            with self.broker.resource_admission():change()
        thread,errors=self.concurrent(mutate);kind,body=self.send_request();thread.join(3)
        self.assertFalse(thread.is_alive());self.assertEqual(errors,[]);self.assertEqual(kind,b'E')
        self.assertIn(b'changed while waiting',body);self.assertEqual(self.engine_stops,[])
        self.assertEqual(self.budget_calls,[]);self.assertIn(fixture.SID,self.broker.storage_leases)

    def change_employee(self,key,value):
        self.company['employees'][0][key]=value;self.save()

    def test_owner_off_during_wait_refuses_without_stop_or_new_program(self):
        self.change_while_waiting(lambda:self.change_employee('desiredRunning',False))

    def test_vacation_during_wait_refuses(self):
        self.change_while_waiting(lambda:self.change_employee('onVacation',True))

    def test_generation_drift_during_wait_refuses(self):
        self.change_while_waiting(lambda:self.change_employee('sessionGeneration',3))

    def test_current_binding_drift_during_wait_refuses(self):
        self.change_while_waiting(lambda:self.change_employee('sessionId','bbbbbbbb-2222-4333-8444-555555555555'))

    def test_account_recipe_drift_during_wait_refuses(self):
        self.change_while_waiting(lambda:self.change_employee('runtimeRecipe',{'mode':'claude','subscriptionProfile':{'id':'other'}}))

    def test_broker_drain_during_wait_refuses(self):
        self.change_while_waiting(self.broker.draining.set)

    def test_broker_generation_during_wait_refuses(self):
        self.change_while_waiting(lambda:setattr(self.broker,'generation',self.broker.generation+1))

    def test_broker_memory_policy_drift_during_wait_refuses(self):
        self.change_while_waiting(lambda:self.broker.config.update(memoryMiB=4096))

    def test_config_file_drift_during_wait_refuses(self):
        path=self.root/'host-config.json';path.write_text(json.dumps(self.config));path.chmod(0o600)
        self.broker.config_file=path
        def change():
            value=copy.deepcopy(self.config);value['image']='sha256:'+'b'*64
            path.write_text(json.dumps(value))
        self.change_while_waiting(change)

    def fast_wait(self):
        actual=time.monotonic;elapsed=[0.0]
        self.enterContext(patch.object(W.time,'monotonic',side_effect=lambda:actual()+elapsed[0]))
        self.enterContext(patch.object(self.broker.stopping,'wait',side_effect=lambda seconds:elapsed.__setitem__(0,elapsed[0]+seconds)))

    def test_unknown_old_stop_times_out_without_releasing_lease_or_admitting_capacity(self):
        self.fast_wait();kind,body=self.send_request()
        self.assertEqual(kind,b'E');self.assertIn(b'Previous employee laptop has not released its data',body)
        self.assertIn(fixture.SID,self.broker.storage_leases);self.assertEqual(self.engine_stops,[])
        self.assertEqual(self.budget_calls,[])

    def test_protected_start_admission_is_entered_once_and_never_replayed(self):
        self.fast_wait();permit=object();enters=[]
        with patch.object(N,'request_for_launch',return_value=permit), \
             patch.object(N,'begin_permit',side_effect=lambda *args:enters.append(True)), \
             patch.object(N,'finish_start_boundary'),patch.object(N,'record_canonical_closed'):
            kind,body=self.send_request(protected=object())
        self.assertEqual(kind,b'E');self.assertIn(b'Previous employee laptop has not released its data',body)
        self.assertEqual(enters,[True]);self.assertIn(fixture.SID,self.broker.storage_leases)
        self.assertEqual(self.budget_calls,[])

if __name__=='__main__':unittest.main()
