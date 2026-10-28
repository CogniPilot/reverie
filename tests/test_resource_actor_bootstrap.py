"""Existing real private R stores/flocks; controlled engine/kernel/manager ports only."""
import copy
import json
import os
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

from reverie import resource_actor_bootstrap as B
from reverie import worker_resource_reservations as R
from reverie import employee_resource_profiles as E
from reverie.worker_service import WorkerService
from reverie.worker_resources import policy_digest
from tests import test_worker_resource_reservations as F


class BootstrapTests(unittest.TestCase):
    company = F.Reservations.company
    kernel = F.Reservations.kernel

    def setUp(self):
        # Provision a genuinely empty owned fixture, never erase real history.
        with patch.object(E.ProfileStore, 'put', return_value=None):
            F.Reservations.setUp(self)
        self.path = self.root / 'broker.json'
        self.path.write_text(json.dumps(self.config, indent=2) + '\n'); self.path.chmod(0o600)
        self.native.config_file = self.path
        Path(self.config['companyFile']).chmod(0o600)
        self.service = WorkerService(self.path, home=self.root / 'owner', run=self.run_manager)
        self.active = False
        for path in (self.service.unit, self.service.environment, self.service.gcroot):
            path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            path.write_text('owned controlled registration port'); path.chmod(0o600)
        self.operation = self.root / 'enable'; self.operation.mkdir(mode=0o700)
        self.selection = self.root / 'selection.json'
        self.selection.write_text('{"providerPIDs": []}\n'); self.selection.chmod(0o600)
        self.addCleanup(patch.stopall)
        patch.object(WorkerService, 'positive_preflight', return_value=self.config).start()
        patch.object(WorkerService, 'resource_probe', return_value=self.native).start()
        # Registered immutable unit parser is tested by existing upgrade/refresh
        # suites. This port isolates the new transaction; no service is invoked.
        patch.object(B.Bootstrap, '_registration', return_value={'fixedRegisteredGeneration': 'owned-fixture'}).start()
        from reverie import worker_gpu_preflight as P
        actual_process = P._process
        self.member_namespace = {'mnt': 7001, 'pid': 7002, 'user': 7003}
        self.member_root = [7004, 7005]
        self.actual_process = actual_process
        def process(pid):
            if pid == 123:
                return {'pid':123,'startTick':77,'rootIdentity':self.member_root,
                        'namespaces':self.member_namespace}
            return actual_process(pid)
        patch.object(P, '_process', side_effect=process).start()
        self.bootstrap = B.Bootstrap(self.service, self.operation)
        self.before = self.path.read_bytes()
        self.marker = R.marker(self.config).read_bytes()

    def run_manager(self, args, *, deadline=None):
        self.assertEqual(args[:3], ['systemctl', '--user', 'show'])
        fields = {'ActiveState': 'active' if self.active else 'inactive',
                  'SubState': 'running' if self.active else 'dead', 'MainPID': '123' if self.active else '0',
                  'FragmentPath': str(self.service.unit), 'DropInPaths': '',
                  'NeedDaemonReload': 'no', 'ControlGroup': ''}
        return subprocess.CompletedProcess(args, 0, '\n'.join(f'{k}={v}' for k,v in fields.items()), '')

    def prepare(self):
        return self.bootstrap.prepare(self.selection)['planSHA256']

    def assert_untouched(self):
        self.assertEqual(self.path.read_bytes(), self.before)
        self.assertEqual(R.marker(self.config).read_bytes(), self.marker)

    def test_pristine_enable_preserves_original_bytes_ids_stores_and_policy(self):
        stores = {p: p.read_bytes() for p in self.control.glob('*/*') if p.is_file()}
        binding = copy.deepcopy(self.gate.binding)
        policy = policy_digest(self.config, F.SID)
        plan = self.prepare()
        self.assertEqual(self.bootstrap.apply(plan), {'enabled': True, 'installationRequired': True, 'started': False})
        after = json.loads(self.path.read_bytes())
        self.assertEqual(after.pop('resourceActorConfig'), str(self.control / 'resource-actor.json'))
        self.assertEqual(after, self.config)
        self.assertEqual((self.operation/'CONFIG.before').read_bytes(), self.before)
        self.assertEqual((self.operation/'MARKER.before').read_bytes(), self.marker)
        new = json.loads(R.marker(self.config).read_bytes())
        self.assertEqual({k:v for k,v in new.items() if k!='configurationDigest'},
                         {k:v for k,v in binding.items() if k!='configurationDigest'})
        self.assertEqual(stores, {p: p.read_bytes() for p in stores})
        self.assertEqual(policy_digest(self.native.config, F.SID), policy)
        self.assertFalse(R.pending(self.config).exists())
        gate = R.ReservationGate(self.native)
        with gate.admission(): gate.check_headroom()
        self.assertTrue((self.operation/'ATTEMPT.json').exists())
        with self.assertRaisesRegex(ValueError, 'ATTEMPT_USED'):
            self.bootstrap.apply(plan)

    def test_existing_empty_profile_file_is_distinct_and_preserved(self):
        p=self.control/'profiles/profiles.json'
        p.write_text(json.dumps({'schema':'reverie-employee-resource-profiles-v1','revision':0,'profiles':{}}));p.chmod(0o600)
        old=p.read_bytes();plan=self.prepare();self.bootstrap.apply(plan)
        self.assertEqual(p.read_bytes(),old)

    def test_actor_already_selected_wrong_path_and_extra_selection_refuse(self):
        for value in ('/wrong/actor.json', str(self.control/'resource-actor.json'), None):
            self.config['resourceActorConfig']=value
            with self.assertRaisesRegex(ValueError,'ALREADY_SELECTED'):self.prepare()
        self.config.pop('resourceActorConfig')
        self.selection.write_text('{"providerPIDs":[],"owner":true}')
        with self.assertRaisesRegex(ValueError,'SELECTION'):self.prepare()
        self.assert_untouched()

    def test_fixed_service_and_owner_authority(self):
        with self.assertRaisesRegex(ValueError,'FIXED_SERVICE'):B.Bootstrap(object(),self.operation)
        with patch.object(B.os,'geteuid',return_value=0),self.assertRaisesRegex(ValueError,'ordinary owner'):
            B.Bootstrap(self.service,self.operation)
        self.config['uid']+=1
        with self.assertRaisesRegex(ValueError,'OWNER'):self.prepare()
        self.assert_untouched()

    def test_running_manager_and_all_main_per_seat_sockets_refuse(self):
        self.active=True
        with self.assertRaisesRegex(ValueError,'inactive'):self.prepare()
        self.active=False
        for path in (Path(self.config['socket']),Path(self.config['apiSocketRoot'])/F.SID/'office.sock'):
            path.parent.mkdir(parents=True,mode=0o700,exist_ok=True);Path(self.config['apiSocketRoot']).chmod(0o700) if Path(self.config['apiSocketRoot']).exists() else None;path.touch()
            try:
                with self.assertRaisesRegex(ValueError,'SOCKET_PRESENT'):self.prepare()
            finally:path.unlink()
        self.assert_untouched()

    def test_registered_h_consumer_refuses(self):
        unit=self.service.home/'.config/systemd/user/reverie-owner-terminal.service'
        unit.parent.mkdir(parents=True,mode=0o700,exist_ok=True);unit.touch()
        with self.assertRaisesRegex(ValueError,'H_CONSUMER'):self.prepare()
        self.assert_untouched()

    def test_profiles_and_revisioned_empty_operations_are_history(self):
        p=self.control/'operations/operations.json';old=p.read_bytes()
        value=json.loads(old);value['revision']=1;p.write_text(json.dumps(value))
        with self.assertRaisesRegex(ValueError,'RETAINED_OPERATIONS'):self.prepare()
        p.write_bytes(old)
        self.profiles.put(F.EID,self.resources,{'employee_id':F.EID,'current_sid':F.SID,
            'target_sid':F.APPROVED_TARGET,'current_generation':1,'target_generation':2},
            expected_revision=0,expected_profile_version=0,expected_binding=None)
        with self.assertRaisesRegex(ValueError,'RETAINED_PROFILES'):self.prepare()
        self.assert_untouched()

    def test_any_retained_artifact_refuses(self):
        for name in ('operations/unknown.json','profiles/published.json','actor.old'):
            path=self.control/name;path.touch(mode=0o600)
            try:
                with self.assertRaisesRegex(ValueError,'HISTORY'):self.prepare()
            finally:path.unlink()
        self.assert_untouched()

    def test_foreign_pending_and_cold_constructor_refuse(self):
        R._write_exclusive(R.pending(self.config),{'foreign':True})
        with self.assertRaisesRegex(ValueError,'RECONCILIATION'):self.prepare()
        with self.assertRaisesRegex(ValueError,'RECONCILIATION'):R.ReservationGate(self.native)
        self.assert_untouched()

    def test_prepare_to_apply_company_or_config_race_refuses_before_attempt(self):
        plan=self.prepare();self.path.write_bytes(self.before+b' ')
        with self.assertRaisesRegex(ValueError,'PLAN_CHANGED'):self.bootstrap.apply(plan)
        self.assertFalse((self.operation/'ATTEMPT.json').exists())
        self.assertFalse(R.pending(self.config).exists())

    def test_expiry_and_plan_tampering_refuse(self):
        plan=self.prepare()
        with self.assertRaisesRegex(ValueError,'PLAN_DIGEST'):self.bootstrap.apply('0'*64)
        with patch.object(B.time,'time',return_value=10**12),self.assertRaisesRegex(ValueError,'EXPIRED'):
            self.bootstrap.apply(plan)
        self.assert_untouched()

    def test_crash_between_config_and_marker_retains_domain_fence_no_retry(self):
        plan=self.prepare();real=B.Bootstrap._replace
        def fail(owner,path,*args):
            if Path(path)==R.marker(self.config):raise OSError('fixture crash')
            return real(owner,path,*args)
        with patch.object(B.Bootstrap,'_replace',new=fail),self.assertRaisesRegex(RuntimeError,'RECONCILIATION'):
            self.bootstrap.apply(plan)
        self.assertIn('resourceActorConfig',json.loads(self.path.read_bytes()))
        self.assertEqual(R.marker(self.config).read_bytes(),self.marker)
        self.assertTrue(R.pending(self.config).exists());self.assertFalse((self.operation/'RESULT.json').exists())
        with self.assertRaisesRegex(ValueError,'RECONCILIATION'):R.ReservationGate(self.native)
        with self.assertRaisesRegex(ValueError,'ATTEMPT_USED'):self.bootstrap.apply(plan)

    def test_pending_never_authorizes_other_live_gate(self):
        plan=self.prepare();other=R.ReservationGate(self.native);real=B.exclusive
        def write(path,raw):
            result=real(path,raw)
            if Path(path)==R.pending(self.config):
                with self.assertRaises((ValueError, BlockingIOError)):
                    with other.admission():pass
            return result
        with patch.object(B,'exclusive',side_effect=write):self.bootstrap.apply(plan)

    def test_late_temp_fsync_config_race_preserves_foreign_and_fence(self):
        plan=self.prepare();real=B.exclusive
        foreign=self.before+b'\n'
        def write(path,raw):
            result=real(path,raw)
            if Path(path)==self.path.with_name(self.path.name+'.actor-enable-next'):
                self.path.write_bytes(foreign)
            return result
        with patch.object(B,'exclusive',side_effect=write),self.assertRaisesRegex(RuntimeError,'RECONCILIATION'):
            self.bootstrap.apply(plan)
        self.assertEqual(self.path.read_bytes(),foreign)
        self.assertEqual(R.marker(self.config).read_bytes(),self.marker)
        self.assertTrue(R.pending(self.config).exists())

    def test_admission_finalizer_failure_keeps_pending_no_result(self):
        plan=self.prepare();real=R.ReservationGate._guard;calls=0
        def guard(gate,*args):
            nonlocal calls
            value=real(gate,*args)
            if getattr(gate._local,'actor_bootstrap',None) and 'resourceActorConfig' in gate.broker.config:
                calls+=1
                if calls==3:raise OSError('fixture finalizer')
            return value
        with patch.object(R.ReservationGate,'_guard',new=guard),self.assertRaisesRegex(RuntimeError,'RECONCILIATION'):
            self.bootstrap.apply(plan)
        self.assertTrue(R.pending(self.config).exists());self.assertFalse((self.operation/'RESULT.json').exists())

    def test_terminal_result_fsync_race_keeps_unknown_not_success(self):
        plan=self.prepare();real=B.exclusive
        def write(path,raw):
            result=real(path,raw)
            if Path(path)==self.operation/'RESULT.json':
                self.path.write_bytes(self.path.read_bytes()+b' ')
            return result
        with patch.object(B,'exclusive',side_effect=write),self.assertRaisesRegex(RuntimeError,'RECONCILIATION'):
            self.bootstrap.apply(plan)
        self.assertTrue(R.pending(self.config).exists())
        self.assertTrue(json.loads((self.operation/'RESULT.json').read_bytes())['acceptanceRequiresPendingAbsent'])

    def test_foreign_pending_replacement_after_result_is_not_unlinked(self):
        plan=self.prepare();real=B.exclusive
        def write(path,raw):
            result=real(path,raw)
            if Path(path)==self.operation/'RESULT.json':
                pending=R.pending(self.config);pending.unlink();R._write_exclusive(pending,{'foreign':True})
            return result
        with patch.object(B,'exclusive',side_effect=write),self.assertRaisesRegex(RuntimeError,'RECONCILIATION'):
            self.bootstrap.apply(plan)
        self.assertEqual(json.loads(R.pending(self.config).read_bytes()),{'foreign':True})

    def test_last_init_producer_root_swap_is_detected_before_fence_release(self):
        plan=self.prepare();real=B.exclusive;pid=R._pid;armed=False;changed=False
        source=Path(self.config['stateRoot'])/'employees'/F.EID/'home'
        def write(path,raw):
            nonlocal armed
            result=real(path,raw)
            if Path(path)==self.operation/'RESULT.json':armed=True
            return result
        def process(number):
            nonlocal changed
            result=pid(number)
            if armed and not changed:
                changed=True;source.rename(source.with_name('preserved-home'));source.mkdir(mode=0o700)
            return result
        with patch.object(B,'exclusive',side_effect=write),patch.object(R,'_pid',side_effect=process),self.assertRaisesRegex(RuntimeError,'RECONCILIATION'):
            self.bootstrap.apply(plan)
        self.assertTrue(changed);self.assertTrue(R.pending(self.config).exists())

    def test_registered_file_changed_by_final_producer_is_detected(self):
        plan=self.prepare();real=B.exclusive
        def write(path,raw):
            result=real(path,raw)
            if Path(path)==self.operation/'RESULT.json':self.service.environment.write_text('foreign selection')
            return result
        with patch.object(B,'exclusive',side_effect=write),self.assertRaisesRegex(RuntimeError,'RECONCILIATION'):
            self.bootstrap.apply(plan)
        self.assertTrue(R.pending(self.config).exists())

    def test_owner_operation_finalizer_ends_before_fence_release(self):
        from contextlib import contextmanager
        from reverie import worker_service_upgrade as U
        plan=self.prepare();real=U.directory_lock
        @contextmanager
        def failing(path):
            with real(path):yield
            raise OSError('controlled operation descriptor finalizer')
        with patch.object(U,'directory_lock',new=failing),self.assertRaisesRegex(RuntimeError,'RECONCILIATION'):
            self.bootstrap.apply(plan)
        self.assertTrue(R.pending(self.config).exists());self.assertFalse((self.operation/'RESULT.json').exists())

    def test_supplied_actual_provider_exit_after_result_retains_fence(self):
        import sys
        child=subprocess.Popen([sys.executable,'-I','-B','-c','import time;time.sleep(30)'])
        try:
            self.selection.write_text(json.dumps({'providerPIDs':[child.pid]}))
            from reverie import worker_gpu_preflight as P
            process=P._process
            def member(pid):
                facts=process(pid)
                return {**facts,'rootIdentity':self.member_root,'namespaces':self.member_namespace} if pid==child.pid else facts
            membership=patch.object(P,'_process',side_effect=member);membership.start();self.addCleanup(membership.stop)
            plan=self.prepare();real=B.exclusive
            def write(path,raw):
                result=real(path,raw)
                if Path(path)==self.operation/'RESULT.json':child.terminate();child.wait(timeout=5)
                return result
            with patch.object(B,'exclusive',side_effect=write),self.assertRaisesRegex(RuntimeError,'RECONCILIATION'):
                self.bootstrap.apply(plan)
            self.assertTrue(R.pending(self.config).exists())
        finally:
            if child.poll() is None:child.terminate()
            child.wait(timeout=5)

    def test_no_reprovision_and_untyped_transition_cannot_own_pending(self):
        plan=self.prepare()
        with patch.object(R,'provision',side_effect=AssertionError('NO_PROVISION')):
            self.bootstrap.apply(plan)
        self.assertFalse(B.owns_pending(self.gate))
        self.gate._local.actor_bootstrap={'gate':self.gate,'pending':'JSON is not authority'}
        self.assertFalse(B.owns_pending(self.gate))

    def test_expiry_during_intent_fsync_retains_fence_without_config_publication(self):
        plan=self.prepare();real=B.exclusive;clock=B.time.time();expired=False
        def write(path,raw):
            nonlocal expired
            result=real(path,raw)
            if Path(path)==R.pending(self.config):expired=True
            return result
        with patch.object(B,'exclusive',side_effect=write),patch.object(B.time,'time',side_effect=lambda:clock+1000 if expired else clock),self.assertRaisesRegex(RuntimeError,'RECONCILIATION'):
            self.bootstrap.apply(plan)
        self.assert_untouched();self.assertTrue(R.pending(self.config).exists())
        self.assertFalse((self.operation/'RESULT.json').exists())

    def test_expiry_after_result_fsync_never_clears_fence(self):
        plan=self.prepare();real=B.exclusive;clock=B.time.time();expired=False
        def write(path,raw):
            nonlocal expired
            result=real(path,raw)
            if Path(path)==self.operation/'RESULT.json':expired=True
            return result
        with patch.object(B,'exclusive',side_effect=write),patch.object(B.time,'time',side_effect=lambda:clock+1000 if expired else clock),self.assertRaisesRegex(RuntimeError,'RECONCILIATION'):
            self.bootstrap.apply(plan)
        self.assertTrue(R.pending(self.config).exists())

    def test_foreign_actual_host_pid_refuses_before_plan_or_attempt(self):
        self.selection.write_text(json.dumps({'providerPIDs':[os.getpid()]}))
        with self.assertRaisesRegex(ValueError,'PROVIDER_OUTSIDE_CURRENT_LAPTOPS'):self.prepare()
        self.assertFalse((self.operation/'PLAN.json').exists())
        self.assertFalse((self.operation/'ATTEMPT.json').exists());self.assert_untouched()

    def test_valid_current_member_pid_is_retained_with_real_birth_executable(self):
        from reverie import worker_gpu_preflight as P
        pid=os.getpid();self.selection.write_text(json.dumps({'providerPIDs':[pid]}))
        process=P._process
        def member(number):
            facts=process(number)
            return {**facts,'rootIdentity':self.member_root,'namespaces':self.member_namespace} if number==pid else facts
        with patch.object(P,'_process',side_effect=member):
            plan=self.prepare();result=self.bootstrap.apply(plan)
        observed=json.loads((self.operation/'PLAN.json').read_bytes())['native']
        self.assertTrue(result['enabled']);self.assertEqual(observed['providers'][0]['pid'],pid)
        self.assertEqual(observed['providers'][0]['startTick'],self.actual_process(pid)['startTick'])
        self.assertEqual(observed['managed'][F.SID]['employeeId'],F.EID)
        self.assertEqual(observed['managed'][F.SID]['generation'],1)

    def test_stale_sid_employee_policy_and_website_membership_refuse(self):
        row=self.native.rows[0]
        for key,value in [('reverie.employee','f'*36),('reverie.session',F.TARGET),('reverie.worker-policy','wrong')]:
            old=row['Config']['Labels'][key];row['Config']['Labels'][key]=value
            try:
                with self.assertRaisesRegex(ValueError,'UNBOUND_WORKER'):self.prepare()
            finally:row['Config']['Labels'][key]=old
        # A supplied process from another namespace, including the website, is
        # never made a current managed laptop by being in the same inventory.
        self.selection.write_text(json.dumps({'providerPIDs':[os.getpid()]}))
        with self.assertRaisesRegex(ValueError,'PROVIDER_OUTSIDE_CURRENT_LAPTOPS'):self.prepare()

    def test_result_fsync_unknown_history_in_each_canonical_namespace_retains_fence(self):
        for name in ('operations/unknown-late.json','profiles/unknown-late.json','resource-actor.json'):
            with self.subTest(name=name):
                if name != 'operations/unknown-late.json':
                    self.doCleanups();self.setUp()
                plan=self.prepare();real=B.exclusive;unknown=self.control/name
                def write(path,raw):
                    result=real(path,raw)
                    if Path(path)==self.operation/'RESULT.json':real(unknown,b'{"unconfirmed":true}')
                    return result
                with patch.object(B,'exclusive',side_effect=write),self.assertRaisesRegex(RuntimeError,'RECONCILIATION'):
                    self.bootstrap.apply(plan)
                self.assertTrue(unknown.exists());self.assertTrue(R.pending(self.config).exists())
                self.assertTrue((self.operation/'ATTEMPT.json').exists())

    def test_final_history_fd_close_after_scan_cannot_hide_late_operation(self):
        plan=self.prepare();real=B.os.close;exclusive=B.exclusive;armed=False;changed=False
        unknown=self.control/'operations/unknown-after-scan.json'
        profile_identity=(self.control/'profiles').stat().st_ino
        def write(path,raw):
            nonlocal armed
            result=exclusive(path,raw)
            if Path(path)==self.operation/'RESULT.json':armed=True
            return result
        def close(fd):
            nonlocal changed
            info=os.fstat(fd)
            result=real(fd)
            if armed and not changed and info.st_ino==profile_identity:
                changed=True;exclusive(unknown,b'{"unconfirmed":true}')
            return result
        with patch.object(B,'exclusive',side_effect=write),patch.object(B.os,'close',side_effect=close),self.assertRaisesRegex(RuntimeError,'RECONCILIATION'):
            self.bootstrap.apply(plan)
        self.assertTrue(changed);self.assertTrue(unknown.exists());self.assertTrue(R.pending(self.config).exists())

    def test_removed_expected_lock_at_result_never_reinitialized(self):
        plan=self.prepare();real=B.exclusive;lock=self.control/'profiles/profiles.lock'
        def write(path,raw):
            result=real(path,raw)
            if Path(path)==self.operation/'RESULT.json':lock.unlink()
            return result
        with patch.object(B,'exclusive',side_effect=write),self.assertRaisesRegex(RuntimeError,'RECONCILIATION'):
            self.bootstrap.apply(plan)
        self.assertFalse(lock.exists());self.assertTrue(R.pending(self.config).exists())

    def test_final_history_fd_close_global_company_or_config_change_retains_fence(self):
        for name in ('company','config'):
            with self.subTest(name=name):
                if name=='config':self.doCleanups();self.setUp()
                plan=self.prepare();real=B.os.close;exclusive=B.exclusive;armed=False;changed=False
                profile_identity=(self.control/'profiles').stat().st_ino
                target=Path(self.config['companyFile']) if name=='company' else self.path
                foreign=target.read_bytes()+b'\n'
                def write(path,raw):
                    nonlocal armed
                    result=exclusive(path,raw)
                    if Path(path)==self.operation/'RESULT.json':armed=True
                    return result
                def close(fd):
                    nonlocal changed
                    info=os.fstat(fd);result=real(fd)
                    if armed and not changed and info.st_ino==profile_identity:
                        changed=True;target.write_bytes(foreign)
                    return result
                with patch.object(B,'exclusive',side_effect=write),patch.object(B.os,'close',side_effect=close),self.assertRaisesRegex(RuntimeError,'RECONCILIATION'):
                    self.bootstrap.apply(plan)
                self.assertTrue(changed);self.assertEqual(target.read_bytes(),foreign)
                self.assertTrue(R.pending(self.config).exists());self.assertTrue((self.operation/'ATTEMPT.json').exists())

    def test_final_history_fd_close_can_not_hide_supplied_provider_exit(self):
        import sys
        from reverie import worker_gpu_preflight as P
        child=subprocess.Popen([sys.executable,'-I','-B','-c','import time;time.sleep(30)'])
        try:
            self.selection.write_text(json.dumps({'providerPIDs':[child.pid]}));process=P._process
            def member(pid):
                facts=process(pid)
                return {**facts,'rootIdentity':self.member_root,'namespaces':self.member_namespace} if pid==child.pid else facts
            with patch.object(P,'_process',side_effect=member):
                plan=self.prepare();real=B.os.close;exclusive=B.exclusive;armed=False;changed=False
                profile_identity=(self.control/'profiles').stat().st_ino
                def write(path,raw):
                    nonlocal armed
                    result=exclusive(path,raw)
                    if Path(path)==self.operation/'RESULT.json':armed=True
                    return result
                def close(fd):
                    nonlocal changed
                    info=os.fstat(fd);result=real(fd)
                    if armed and not changed and info.st_ino==profile_identity:
                        changed=True;child.terminate();child.wait(timeout=5)
                    return result
                with patch.object(B,'exclusive',side_effect=write),patch.object(B.os,'close',side_effect=close),self.assertRaisesRegex(RuntimeError,'RECONCILIATION'):
                    self.bootstrap.apply(plan)
                self.assertTrue(changed);self.assertTrue(R.pending(self.config).exists())
        finally:
            if child.poll()is None:child.terminate()
            child.wait(timeout=5)
