"""Owned store/flock/cgroup fixtures, not native engine or owner acceptance."""
import copy
from dataclasses import replace
import json
from pathlib import Path
import subprocess
import socket
import threading
import types
import unittest
from unittest.mock import patch

from reverie import worker_resource_native as N
from reverie import worker_resource_reservations as R
from reverie import laptop_resource_operations as J
from reverie.worker import Broker,send_frame,receive_frame
from reverie.worker_cleanup import StopBudget
from reverie.worker_storage import storage_guard,storage_paths
from reverie.worker_resources import effective_config,policy_digest
from tests import test_worker_resource_preparation as P
from tests import test_worker_resource_reservations as F


class NativeStart(unittest.TestCase):
    def setUp(self):
        # This suite models engine/kernel facts. Keep its mount-table port
        # fixed too; unrelated host mount churn is not a fixture mutation.
        table=copy.deepcopy(R.read_mount_table())
        self.enterContext(patch.object(R,'read_mount_table',return_value=table))
        self.case=P.Preparation();self.case.setUp();self.addCleanup(self.case.doCleanups)
        self.f=self.case.f;f=self.f
        f.native.storage_lease_lock=threading.RLock();f.native.storage_leases={}
        f.native.stopping=StopBudget();f.native.cleanup_uncertain=set()
        f.native.release_storage=types.MethodType(Broker.release_storage,f.native)
        f.native.stop=types.MethodType(Broker.stop,f.native)
        guard=storage_guard(f.config,F.SID);paths=guard.__enter__();f.native.storage_leases[F.SID]=(guard,paths)
        def release():
            for sid in list(f.native.storage_leases):f.native.release_storage(sid)
        self.addCleanup(release)
        self.policy,self.key=self.case.prepared_fixture()
        self.case.owner._commit_configuration(self.key);self.owner=self.case.owner
        self.effects=[];self.stop_mode='released';engine=f.native.run_engine
        def controlled(args,optional=False,*,deadline=None):
            if args[0] in ('stop','kill'):
                self.effects.append(args)
                op=next(iter(self.case.raw()['operations'].values()))
                self.assertEqual(op['state'],'STARTING')
                self.assertTrue((f.control/'operations'/('source-stop-attempt-'+op['id']+'.json')).exists())
                self.assertEqual(args[-1],f.native.rows[0]['Id'])
                f.native.rows[0]['State']={'Running':False,'Pid':0}
                if self.stop_mode!='pid-alive':(f.proc/'123/stat').unlink(missing_ok=True)
                (f.cgroup/'fixture-123/cgroup.events').write_text(
                    'populated '+('1' if self.stop_mode=='populated' else '0')+'\nfrozen 0\n')
                return subprocess.CompletedProcess(args,0,'','')
            return engine(args,optional)
        f.native.run_engine=controlled

    def begin(self):return self.owner._begin_start(self.key)

    def stopped(self):
        permit=self.begin();result=self.owner._stop_source_once(self.key,permit)
        self.assertEqual(result['state'],'SOURCE_RELEASED_TARGET_NOT_CREATED');return permit

    def test_starting_is_durable_before_exact_cid_stop_and_never_acks_started(self):
        permit=self.begin();self.assertEqual(self.effects,[])
        op=next(iter(self.case.raw()['operations'].values()));self.assertEqual((op['state'],op['version']),('STARTING',4))
        with self.assertRaisesRegex(ValueError,'RECONCILIATION'):
            with self.f.gate.admission(F.APPROVED_TARGET):pass
        result=self.owner._stop_source_once(self.key,permit)
        self.assertFalse(result['verified']);self.assertTrue(result['capacityRetained'])
        self.assertEqual(len(self.effects),1);self.assertNotIn(F.SID,self.f.native.storage_leases)
        self.assertEqual(next(iter(self.case.raw()['operations'].values()))['state'],'STARTING')
        self.assertFalse(any(args[0]=='network' for args in self.f.native.calls))
        with self.assertRaisesRegex(ValueError,'ALREADY_ATTEMPTED'):self.owner._stop_source_once(self.key,permit)

    def test_known_old_process_survivor_preserves_the_real_employee_lease(self):
        self.stop_mode='pid-alive';permit=self.begin()
        with self.assertRaises(J.OperationCommitUncertain):self.owner._stop_source_once(self.key,permit)
        self.assertIn(F.SID,self.f.native.storage_leases)
        with self.assertRaises(BlockingIOError):
            with storage_guard(self.f.native.config,F.APPROVED_TARGET):pass
        self.assertEqual(next(iter(self.case.raw()['operations'].values()))['state'],'STARTING')

    def test_populated_old_cgroup_is_not_assumed_released(self):
        self.stop_mode='populated';permit=self.begin()
        with self.assertRaises(J.OperationCommitUncertain):self.owner._stop_source_once(self.key,permit)
        self.assertIn(F.SID,self.f.native.storage_leases)

    def test_name_recycled_to_different_cid_is_not_stopped(self):
        name=self.f.native.rows[0]['Name'].removeprefix('/');original=self.f.native.rows[0]['Id']
        self.f.native.rows[0]['Id']='8'*64
        with self.assertRaisesRegex(ValueError,'identity changed'):
            Broker._stop_observed(self.f.native,name,expected_id=original,retain_storage=True)
        self.assertEqual(self.effects,[])

    def test_same_cid_new_process_incarnation_is_not_stopped(self):
        row=self.f.native.rows[0];name=row['Name'].removeprefix('/')
        (self.f.proc/'123/stat').write_text((self.f.proc/'123/stat').read_text().replace('77','78'))
        with self.assertRaisesRegex(ValueError,'incarnation changed'):
            Broker._stop_observed(self.f.native,name,expected_id=row['Id'],expected_process={'pid':123,'start':'77'},retain_storage=True)
        self.assertEqual(self.effects,[])

    def fallback_stop(self,mutation=None):
        engine=self.f.native.run_engine
        def controlled(args,optional=False,*,deadline=None):
            if args[0]=='stop':
                self.effects.append(args)
                if mutation is not None:mutation(self.f.native.rows[0])
                return subprocess.CompletedProcess(args,0,'','')
            return engine(args,optional)
        self.f.native.run_engine=controlled

    def test_post_stop_new_pid_is_not_killed_and_keeps_claim_and_storage_lease(self):
        permit=self.begin()
        def replace_process(row):
            row['State']={'Running':True,'Pid':125};self.f.kernel(row)
            (self.f.proc/'123/stat').unlink()
        self.fallback_stop(replace_process)
        with self.assertRaises(J.OperationCommitUncertain):self.owner._stop_source_once(self.key,permit)
        self.assertEqual([args[0] for args in self.effects],['stop'])
        self.assertIsNotNone(R._pid(125));self.assertIn(F.SID,self.f.native.storage_leases)
        self.assertEqual(next(iter(self.case.raw()['operations'].values()))['state'],'STARTING')

    def test_post_stop_same_pid_changed_start_is_not_killed(self):
        permit=self.begin()
        def replace_start(row):
            path=self.f.proc/'123/stat';path.write_text(path.read_text().replace('77','78'))
        self.fallback_stop(replace_start)
        with self.assertRaises(J.OperationCommitUncertain):self.owner._stop_source_once(self.key,permit)
        self.assertEqual([args[0] for args in self.effects],['stop'])
        self.assertIn(F.SID,self.f.native.storage_leases)

    def test_post_stop_changed_metadata_is_not_killed(self):
        permit=self.begin()
        self.fallback_stop(lambda row:row['Config']['Labels'].update({'reverie.worker-policy':'changed'}))
        with self.assertRaises(J.OperationCommitUncertain):self.owner._stop_source_once(self.key,permit)
        self.assertEqual([args[0] for args in self.effects],['stop'])
        self.assertIn(F.SID,self.f.native.storage_leases)

    def test_original_process_still_running_can_use_exact_cid_fallback_kill(self):
        permit=self.begin();self.fallback_stop()
        result=self.owner._stop_source_once(self.key,permit)
        self.assertEqual(result['state'],'SOURCE_RELEASED_TARGET_NOT_CREATED')
        self.assertEqual([args[0] for args in self.effects],['stop','kill'])
        self.assertEqual({args[-1] for args in self.effects},{self.f.native.rows[0]['Id']})

    def test_already_stopped_protected_source_receives_no_signal(self):
        self.stopped();self.effects.clear();row=self.f.native.rows[0]
        Broker._stop_observed(self.f.native,row['Name'].removeprefix('/'),expected_id=row['Id'],retain_storage=True)
        self.assertEqual(self.effects,[])

    def test_permit_is_exact_current_handle_one_admission_and_needs_employee_lease_for_create(self):
        permit=self.stopped();forged=replace(permit)
        with self.assertRaisesRegex(ValueError,'PERMIT_CHANGED'):
            with self.f.gate.admission(F.APPROVED_TARGET,protected_start=forged):pass
        with self.f.gate.admission(F.APPROVED_TARGET,protected_start=permit):
            with self.assertRaisesRegex(ValueError,'STORAGE_LEASE_REQUIRED'):
                self.f.gate.check_creation(F.APPROVED_TARGET,effective_config(self.f.native.config,F.APPROVED_TARGET))
            guard=storage_guard(self.f.native.config,F.APPROVED_TARGET);paths=guard.__enter__()
            self.f.native.storage_leases[F.APPROVED_TARGET]=(guard,paths)
            self.f.gate.check_creation(F.APPROVED_TARGET,effective_config(self.f.native.config,F.APPROVED_TARGET))
        with self.assertRaisesRegex(ValueError,'ALREADY_ATTEMPTED'):
            with self.f.gate.admission(F.APPROVED_TARGET,protected_start=permit):pass
        with self.assertRaisesRegex(ValueError,'RECONCILIATION'):
            with self.f.gate.admission(F.APPROVED_TARGET):pass

    def test_cold_owner_or_json_references_never_reconstitute_a_permit(self):
        permit=self.stopped();cold=P.P.ResourcePreparationOwner(self.f.native);self.addCleanup(cold.close)
        with self.assertRaises(ValueError):
            with self.f.gate.admission(F.APPROVED_TARGET,protected_start=replace(permit,owner=cold)):pass
        with self.assertRaises(ValueError):
            with self.f.gate.admission(F.APPROVED_TARGET,protected_start={'operationId':permit.operation_id}):pass
        self.assertEqual(next(iter(self.case.raw()['operations'].values()))['delta_bytes'],str(2048*J.MIB))

    def model_created(self,permit,memory=4096):
        f=self.f;paths=storage_paths(f.native.config,F.APPROVED_TARGET)
        tmp=paths.scratch/'tmp';tmp.mkdir(mode=0o700,exist_ok=True)
        row=f.native.row('3'*64,f.native.config['deployment']+'-agent-'+F.APPROVED_TARGET,125,memory,
            {'reverie.worker':f.native.config['deployment'],'reverie.session':F.APPROVED_TARGET,
             'reverie.employee':F.EID,'reverie.worker-policy':policy_digest(f.native.config,F.APPROVED_TARGET)})
        for destination,source in [('/home/agent',paths.home),('/nix',paths.nix),('/scratch',paths.scratch),('/tmp',tmp)]:
            row['Mounts'].append({'Type':'bind','Source':str(source),'Destination':destination,'RW':True})
        f.kernel(row);f.native.rows.append(row);self.owner._current(self.key)['created_id']=row['Id']
        identity=R._identity
        mapped={f.proc/'125/root'/destination.lstrip('/'):source for destination,source in
                [('/home/agent',paths.home),('/nix',paths.nix),('/scratch',paths.scratch),('/tmp',tmp)]}
        self.enterContext(patch.object(R,'_identity',new=lambda path:identity(mapped.get(Path(path),Path(path)))))
        return row

    def test_created_resource_facts_are_real_but_not_cli_ready_verified_or_credit(self):
        permit=self.stopped();self.model_created(permit)
        with self.f.gate.admission():receipt=N.observe_created(self.f.gate,permit)
        self.assertEqual(receipt['state'],'RUNNING_CONTAINER_RESOURCE_FACTS_ONLY')
        self.assertEqual(receipt['container']['memory'],4096*J.MIB)
        self.assertFalse(receipt['cliReadyVerified']);self.assertFalse(receipt['verified'])
        self.assertTrue(receipt['capacityRetained'])
        self.assertEqual(next(iter(self.case.raw()['operations'].values()))['state'],'STARTING')

    def test_wrong_actual_new_limit_is_not_hidden_by_policy_label(self):
        permit=self.stopped();self.model_created(permit,memory=2048)
        with self.f.gate.admission(),self.assertRaisesRegex(ValueError,'TARGET_POLICY_CHANGED'):
            N.observe_created(self.f.gate,permit)

    def test_new_home_inode_cannot_replace_the_original_employee_home(self):
        permit=self.stopped();row=self.model_created(permit)
        paths=storage_paths(self.f.native.config,F.APPROVED_TARGET)
        paths.home.rename(paths.home.with_name('old-home'));paths.home.mkdir(mode=0o700)
        with self.f.gate.admission(),self.assertRaisesRegex(ValueError,'STORAGE_CHANGED'):
            N.observe_created(self.f.gate,permit)

    def test_real_worker_frame_cannot_supply_or_inherit_the_private_permit(self):
        permit=self.begin();f=self.f
        f.native.handlers={};f.native.connections=threading.BoundedSemaphore(1)
        f.native.resource_admission=types.MethodType(Broker.resource_admission,f.native)
        request={'sessionId':F.APPROVED_TARGET,'cwd':next(m['destination'] for m in f.native.config['mounts'] if not m['readOnly']),
                 'command':'printf never-executed','env':{},'cols':80,'rows':24}
        for extra,expected in [({},'RECONCILIATION'),({'protected_start':{'operationId':permit.operation_id}},'Invalid worker request')]:
            client,server=socket.socketpair();client.settimeout(2)
            try:
                f.native.connections.acquire()
                send_frame(client,b'J',json.dumps(dict(request,**extra)).encode())
                Broker.handle(f.native,server)
                kind,body=receive_frame(client)
                self.assertEqual(kind,b'E');self.assertIn(expected,body.decode())
            finally:client.close();server.close()
        self.assertEqual(self.effects,[])

    def test_missing_original_preparation_receipt_is_not_a_launch_permission(self):
        claim=self.owner._current(self.key);opid=claim['lease'].view['operation']['id']
        (self.f.control/'operations'/('prepared-'+opid+'.json')).unlink()
        with self.assertRaises(J.OperationCommitUncertain):self.begin()
        self.assertEqual(self.effects,[])
        self.assertEqual(next(iter(self.case.raw()['operations'].values()))['state'],'PREPARED')

    def test_wrong_actual_target_image_is_not_hidden_by_policy_label(self):
        permit=self.stopped();row=self.model_created(permit);row['Image']='sha256:'+'9'*64
        with self.f.gate.admission(),self.assertRaisesRegex(ValueError,'TARGET_POLICY_CHANGED'):
            N.observe_created(self.f.gate,permit)

    def test_in_memory_policy_drift_is_not_qualified_by_unchanged_policy_file(self):
        permit=self.stopped();self.f.native.config=dict(self.f.native.config,image='sha256:'+'9'*64)
        with self.f.gate.admission(),self.assertRaisesRegex(ValueError,'CONFIG_CHANGED'):
            N.qualify_start(self.f.gate,permit)
