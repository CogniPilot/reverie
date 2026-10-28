"""Real canonical R files/CAS and H custody; native ports are controlled only."""
import copy
import hashlib
import json
from pathlib import Path
import unittest
from unittest.mock import patch

from reverie import owner_terminal_resource_binding as B
from reverie import owner_terminal_native as H
from reverie import worker_resource_reservations as R
from reverie import worker_resource_preparation as P
from reverie import worker as W
from tests import test_worker_resource_preparation as F
from tests import test_worker_resource_reservations as RF
from tests import test_owner_terminal_native as HF
from tests.test_resource_actor_install import model_nix_fixture_ancestry


class CanonicalResourceBinding(unittest.TestCase):
    def setUp(self):
        # Installed engine access is forbidden BEFORE every fixture/constructor.
        self.block = patch.object(W.Broker, 'run_engine', side_effect=AssertionError('REAL_ENGINE_FORBIDDEN'))
        self.block.start(); self.addCleanup(self.block.stop)
        self.case = F.Preparation(); self.case.setUp(); self.addCleanup(self.case.doCleanups)
        self.f = self.case.f
        self.path = self.case.config_fixture()
        def gate(config, path, _engine):
            self.assertEqual(path, str(self.path))
            broker = copy.copy(self.f.native); broker.config = copy.deepcopy(config)
            return R.ReservationGate(broker)
        self.port = patch.object(B, '_gate', side_effect=gate)
        self.port.start(); self.addCleanup(self.port.stop)
        self.baseline = copy.deepcopy(self.f.config)
        self.binding = B.capture(self.baseline, str(self.path), None)
        # These store/purpose-boundary controls model a qualified host's fixed
        # namespace roots. Nix maps / and /tmp to uid65534; keep every actual
        # private path/mode/inode observation. End this patch before the nested
        # fixture cleanups (which call patch.stopall) to preserve patch lifetime.
        model_nix_fixture_ancestry(self)

    def current(self):
        return json.loads(self.path.read_text())

    def check(self, current=None):
        current = self.current() if current is None else current
        with B.observation(self.binding, current, str(self.path), None):
            pass

    def commit(self):
        key = self.case.claim(); self.case.owner.begin_prepare(key); self.case.publish()
        self.case.owner.confirm_publication(key)
        receipt = self.case.owner._commit_configuration(key)
        return key, receipt

    def installation(self):
        h = H.Installation.__new__(H.Installation)
        h.root_identities = {}; h.path = self.path.parent/'owned-h-policy.json'
        value = {'version': 2, 'workerConfig': str(self.path),
                 'workerConfigSHA256': hashlib.sha256(B.J.encode(self.baseline)).hexdigest(),
                 'resourceBinding': self.binding}
        h.path.write_bytes(B.J.encode(value)); h.path.chmod(0o600)
        h.expected = hashlib.sha256(h.path.read_bytes()).hexdigest()
        h.value, h.identity = H.private_document(h.path, h.expected)
        h.config, h.config_identity = H.private_document(self.path)
        h.engine = None
        h._guard_native = lambda _config: None  # Native producer fixture, no engine.
        return h

    def test_actual_canonical_ram_cas_preserves_h_without_rebinding_any_authority(self):
        h = self.installation(); h.guard(); before = H.private_bytes(self.path)
        marker = R.marker(self.baseline).read_bytes()
        _key, receipt = self.commit(); after = H.private_bytes(self.path)
        self.assertEqual(receipt['state'], 'PREPARED_CONFIG_ONLY_SOURCE_UNCHANGED')
        self.assertNotEqual(before, after)
        h.guard(); self.check()
        self.assertEqual(h.config, self.current())
        self.assertEqual(R.marker(self.baseline).read_bytes(), marker)
        self.assertEqual(self.binding['configuration'], self.baseline)
        self.assertEqual(next(iter(self.case.raw()['operations'].values()))['state'], 'PREPARED')
        self.assertEqual(W.policy_digest(self.baseline, RF.SID), W.policy_digest(h.config, RF.SID))

    def test_projection_alone_does_not_accept_unrecorded_resource_or_peer_changes(self):
        for field, value in [('memoryMiB', 3072), ('poolMemoryMiB', 9216),
                             ('sessionResources', {RF.SID: self.f.resources})]:
            current = copy.deepcopy(self.baseline); current[field] = value
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, 'NOT_CANONICAL'):
                self.check(current)
        self.commit(); current = self.current()
        current['sessionResources']['77777777-7777-4777-8777-777777777777'] = self.f.resources
        with self.assertRaisesRegex(ValueError, 'NOT_CANONICAL'): self.check(current)

    def test_image_browser_gpu_capability_scope_and_owner_domain_remain_strict(self):
        self.commit()
        for field, value in [('image', 'sha256:'+'0'*64), ('browserJobPolicy', '/owned/new-policy'),
                             ('employeeGpuGrants', {}), ('resourceActorConfig', '/owned/other'),
                             ('uid', self.baseline['uid']+1), ('mounts', [])]:
            current = self.current(); current[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError): self.check(current)
        current = self.current(); current['resourceReservations']['ownerScopeDigest'] = '0'*64
        with self.assertRaises(ValueError): self.check(current)

    def test_unknown_cas_missing_ack_or_wrong_profile_never_becomes_available(self):
        key = self.case.claim(); self.case.owner.begin_prepare(key); self.case.publish()
        self.case.owner.confirm_publication(key)
        with patch.object(self.f.native, '_reload_resources', side_effect=RuntimeError('owned uncertainty')):
            with self.assertRaises(B.J.OperationCommitUncertain): self.case.owner._commit_configuration(key)
        with self.assertRaisesRegex(ValueError, 'UNCONFIRMED'): self.check()
        self.assertEqual(next(iter(self.case.raw()['operations'].values()))['state'], 'PREPARING')

    def test_corrupt_current_canonical_profiles_cannot_hide_behind_historical_draft(self):
        self.commit()
        path = self.f.control/'profiles/profiles.json'
        path.write_bytes(b'{"schema":"foreign"}')
        with self.assertRaises(ValueError): self.check()
        self.assertEqual(path.read_bytes(), b'{"schema":"foreign"}')

    def test_other_owner_scope_canonical_operation_cannot_qualify_current_h_domain(self):
        self.commit()
        path = self.f.control/'operations/operations.json'
        value = json.loads(path.read_text())
        next(iter(value['operations'].values()))['scope']['owner_scope_digest'] = '0'*64
        path.write_bytes(B.J.encode(value))
        with self.assertRaisesRegex(ValueError, 'SCOPE_CHANGED'): self.check()

    def test_marker_lock_root_or_pending_drift_refuses_without_repair(self):
        self.commit(); original = self.binding['reservationBinding']
        self.binding['reservationBinding'] = {**original, 'configurationDigest': '0'*64}
        with self.assertRaisesRegex(ValueError, 'CONTROL_CHANGED'): self.check()
        self.binding['reservationBinding'] = original
        pending = R.pending(self.current()); pending.write_bytes(b'{}'); pending.chmod(0o600)
        with self.assertRaisesRegex(ValueError, 'RECONCILIATION'): self.check()
        self.assertTrue(pending.exists())

    def test_last_admission_native_work_cannot_hide_journal_or_config_replacement(self):
        self.commit(); native = R.NativeObserver.custody; touched = []
        def late(observer, root, binding, **kwargs):
            rows = native(observer, root, binding, **kwargs)
            # An extra context-only call tags the terminal admission guard.
            if touched == ['armed']:
                touched.append('changed')
                path = self.f.control/'operations/operations.json'
                value = json.loads(path.read_text()); value['revision'] += 1
                path.write_bytes(B.J.encode(value))
            return rows
        validate = B._validate; validations = []
        def checked(*args):
            result = validate(*args); validations.append(True)
            if len(validations) == 2: touched.append('armed')
            return result
        with patch.object(R.NativeObserver, 'custody', late), patch.object(B, '_validate', checked):
            with self.assertRaisesRegex(ValueError, 'METADATA_CHANGED'):
                with B.observation(self.binding, self.current(), str(self.path), None):
                    pass  # mutation occurs ONLY after the last validation, in exit native I/O
        self.assertIn('changed', touched)

    def test_h_final_actual_policy_read_after_native_producer_refuses_drift(self):
        h = self.installation(); self.commit(); current = self.path.read_bytes()
        def changed(_config):
            value = json.loads(current); value['memoryMiB'] += 512
            self.path.write_bytes(B.J.encode(value))
        h._guard_native = changed
        with self.assertRaisesRegex(ValueError, 'WORKER_POLICY_CHANGED'): h.guard()
        self.assertNotEqual(self.path.read_bytes(), current)

    def test_service_grants_only_existing_pinned_lock_leaves_not_journal_directory(self):
        paths = B.locking_paths(self.baseline)
        self.assertEqual(paths, [self.f.control/'admission.lock', self.f.control/'operations/operations.lock'])
        from reverie.owner_terminal_install import unit_text
        from types import SimpleNamespace
        policy = SimpleNamespace(value={'version':2}, config=self.baseline, roots={'control':self.path.parent}, path=self.path)
        raw = unit_text(policy, Path('/nix/store/fixed-host/bin/host'))
        writable = next(line for line in raw.splitlines() if line.startswith('ReadWritePaths='))
        self.assertIn('"'+str(paths[0])+'"', writable)
        self.assertIn('"'+str(paths[1])+'"', writable)
        self.assertNotIn('"'+str(self.f.control/'operations')+'"', writable)
        paths[1].rename(paths[1].with_name('preserved.lock'));paths[1].write_bytes(b'');paths[1].chmod(0o600)
        with self.assertRaisesRegex(ValueError, 'LOCK_CHANGED'):B.locking_paths(self.baseline)

    def test_no_r_capture_preserves_legacy_strict_policy(self):
        legacy = dict(self.baseline); legacy.pop('resourceReservations')
        # No optional R installation/marker at all is the legacy contract.
        legacy['stateRoot'] = str(self.f.root/'legacy-state')
        self.assertIsNone(B.capture(legacy, str(self.path), None))
        h = self.installation(); h.value = {**h.value, 'version': 1,
            'workerConfigSHA256': hashlib.sha256(self.path.read_bytes()).hexdigest()}
        h.path.write_bytes(B.J.encode(h.value)); h.expected = hashlib.sha256(h.path.read_bytes()).hexdigest()
        h.value, h.identity = H.private_document(h.path, h.expected)
        h.guard(); self.commit()
        with self.assertRaisesRegex(ValueError, 'INSTALLATION_BYTES_CHANGED'): h.guard()


class CurrentEidBinding(unittest.TestCase):
    def setUp(self):
        self.case = HF.CurrentTargetTests(); self.case.setUp(); self.addCleanup(self.case.doCleanups)
        self.h = self.case.installation
        self.h.value.update(version=2, entitlements={HF.EID: {'binding':'current', 'ownerDigest':H.digest({'owner':self.case.employee.get('owner')})}})
        self.h.guard = lambda: None  # Domain/canonical store qualification above.

    def test_new_canonical_sid_uses_same_eid_roots_and_old_capability_refuses(self):
        old = self.h.target_binding(HF.EID)
        sid = '77777777-7777-4777-8777-777777777777'
        self.case.employee.update(sessionId=sid, sessionGeneration=3); self.case.company()
        with self.assertRaisesRegex(ValueError, 'H_CURRENT_BINDING_CHANGED'):
            self.h.assert_human_binding(old['binding'])
        self.case.item['Name'] = '/'+self.case.config['deployment']+'-agent-'+sid
        labels = self.case.item['Config']['Labels']
        labels['reverie.session'] = sid
        labels['reverie.worker-policy'] = W.policy_digest(self.case.config, sid)
        new = self.h.target_binding(HF.EID)
        self.assertEqual(new['target']['sessionId'], sid)
        self.assertEqual(new['target']['sessionGeneration'], 3)
        self.assertEqual(new['binding']['roots'], old['binding']['roots'])
        self.h.assert_human_binding(new['binding'])

    def test_legacy_sid_entitlement_and_off_vacation_still_refuse(self):
        self.h.value['version'] = 1
        self.h.value['entitlements'] = {HF.EID: {'sessionId': HF.SID, 'generation': 2}}
        self.case.employee['sessionGeneration'] += 1; self.case.company()
        with self.assertRaisesRegex(ValueError, 'CURRENT_INTENT_REQUIRED'): self.h.observe(HF.EID)
        self.h.value.update(version=2, entitlements={HF.EID: {'binding':'current', 'ownerDigest':H.digest({'owner':self.case.employee.get('owner')})}})
        self.case.employee['onVacation'] = True; self.case.company()
        with self.assertRaisesRegex(ValueError, 'CURRENT_INTENT_REQUIRED'): self.h.observe(HF.EID)

    def test_current_employee_owner_change_never_inherits_selected_eid_entitlement(self):
        old = self.h.target_binding(HF.EID)
        self.case.employee['owner'] = 'different-fixture-owner'; self.case.company()
        with self.assertRaisesRegex(ValueError, 'OWNER_CHANGED'): self.h.observe(HF.EID)
        with self.assertRaisesRegex(ValueError, 'H_CURRENT_BINDING_CHANGED'):
            self.h.assert_human_binding(old['binding'])


class CompletedResourceHistory(unittest.TestCase):
    def test_real_canonical_launch_settlement_and_cold_h_history_do_not_replay_or_credit(self):
        from tests import test_worker_resource_finalization as final
        from reverie import worker_resource_finalization as S
        with patch.object(W.Broker, 'run_engine', side_effect=AssertionError('REAL_ENGINE_FORBIDDEN')):
            case = final.ResourceFinalization()
            try:
                case.setUp()
                gate = case.owner.gate; path = Path(case.owner.broker.config_file)
                baseline = R._file(gate.root/'operations'/('config-before-'+case.opid+'.json'), gate.broker.config['uid'])
                binding = {'schema':B.SCHEMA, 'configuration':baseline,
                           'reservationBinding':copy.deepcopy(gate.binding)}
                def held(config, _path, _engine):
                    broker = copy.copy(case.owner.broker); broker.config = config
                    return R.ReservationGate(broker)
                S.complete(case.owner, case.key, case.proof)
                original = (gate.root/'operations/operations.json').read_bytes()
                with patch.object(B, '_gate', side_effect=held):
                    with B.observation(binding, json.loads(path.read_text()), str(path), None): pass
                self.assertEqual((gate.root/'operations/operations.json').read_bytes(), original)
                self.assertTrue(case.lease.closed)
                self.assertEqual(case.raw()['state'], 'COMPLETED')
                self.assertFalse(case.pending.exists())
            finally:
                # Nested canonical fixtures capture this outer patch. Unwind
                # their patches BEFORE restoring the outer class method.
                case.doCleanups()


class FixtureIsolation(unittest.TestCase):
    def test_nested_h_ram_and_gpu_fixtures_restore_transport_before_real_boundary_controls(self):
        import io
        from tests.test_worker_gpu_access import GPUAccess
        from tests.test_worker_host_job import EngineDeadline
        from tests.test_worker_supervision import WorkerSupervisionTests
        original = W.Broker.run_engine
        cases = [CompletedResourceHistory(
            'test_real_canonical_launch_settlement_and_cold_h_history_do_not_replay_or_credit'),
            GPUAccess('test_legacy_grant_visible_and_conflicting_off_refuses'),
            EngineDeadline('test_actual_client_timeout_is_clamped_without_invoking_any_engine'),
            WorkerSupervisionTests('test_confirmed_gone_container_releases_real_lease_and_phone')]
        # The first two retain REAL_ENGINE_FORBIDDEN during every constructor;
        # the latter two exercise the actual method with run_client controlled.
        for case in cases:
            with self.subTest(case=case.id()):
                output = io.StringIO()
                result = unittest.TextTestRunner(stream=output).run(unittest.TestSuite([case]))
                self.assertTrue(result.wasSuccessful(), output.getvalue())
                self.assertIs(W.Broker.run_engine, original)


class PurposeRootSeparation(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.case = CanonicalResourceBinding(); self.case.setUp(); self.addCleanup(self.case.doCleanups)
        self.f = self.case.f; self.config = self.case.baseline
        self.temp = tempfile.TemporaryDirectory(dir=self.f.root.parent); self.addCleanup(self.temp.cleanup)
        self.hroot = Path(self.temp.name).resolve()
        self.roots = {name: self.hroot/name for name in ('controlBase','ledgerBase','bootstrapRoot')}
        for path in self.roots.values(): path.mkdir(mode=0o700)

    def initial(self, roots=None):
        import os
        from reverie import owner_terminal_lifecycle as L
        roots = self.roots if roots is None else roots
        for key in ('stateRoot','companyRoot','scratchRoot','apiSocketRoot'):
            Path(self.config[key]).mkdir(mode=0o700, parents=True, exist_ok=True)
        lock=self.hroot/'update.lock'; lock.write_bytes(b'');lock.chmod(0o600)
        deploy=self.hroot/'deployment.json';deploy.write_bytes(b'{}');deploy.chmod(0o600)
        value={'version':1,'purpose':L.PURPOSE,'workerConfig':str(self.case.path),
            'engine':{'socket':'/controlled/no-native','identity':[1,2,3,4],'id':'controlled'},
            'deploymentPath':str(deploy),'lockPath':str(lock),
            **{key:str(path)for key,path in roots.items()},'entitlements':[RF.EID],
            'externalOrigin':'http://fixture.invalid','ingressPeers':[]}
        initial=roots['controlBase']/'initial.json';initial.write_bytes(L._encoded(value));initial.chmod(0o600)
        runtime=L.RuntimeManifest.__new__(L.RuntimeManifest)
        runtime.program={};runtime.systemctl=Path('/controlled/no-systemctl')
        runtime.engine_program=Path('/controlled/no-engine');runtime.host_program={'argvPrefix':['/controlled/host']}
        class Engine:
            def __init__(self,*_):pass
            def guard(self):pass
            def get(self,path):
                if path!='/containers/json?all=1':raise AssertionError('UNEXPECTED_NATIVE_ROUTE')
                return []
        unit=self.hroot/'.config/systemd/user'/L.UNIT
        unit.parent.mkdir(mode=0o700,parents=True,exist_ok=True);unit.write_bytes(b'owned fixed unit');unit.chmod(0o600)
        with patch.object(L,'Engine',Engine),patch.object(L.Path,'home',return_value=self.hroot):
            return L.InitialInstallation(initial,runtime)

    def test_actual_initial_constructor_rejects_every_h_purpose_root_equal_to_r(self):
        for name in self.roots:
            roots={**self.roots,name:self.f.control}
            with self.subTest(name=name),self.assertRaisesRegex(ValueError,'PURPOSE_ROOT_OVERLAP'):
                self.initial(roots)

    def test_actual_initial_constructor_rejects_ancestor_and_descendant_in_both_directions(self):
        child=self.f.control/'owned-h-child';child.mkdir(mode=0o700)
        for selected in (self.f.root,child):
            with self.subTest(selected=selected),self.assertRaisesRegex(ValueError,'PURPOSE_ROOT_OVERLAP'):
                self.initial({**self.roots,'controlBase':selected})

    def test_disjoint_actual_initial_guard_and_unit_preserve_only_two_lock_leaf_exceptions(self):
        owned=self.initial()
        self.enterContext(patch.object(Path,'home',return_value=self.hroot))
        self.assertEqual(owned.guard(),self.config)
        text=owned.unit_text().decode()
        writable=next(line for line in text.splitlines()if line.startswith('ReadWritePaths='))
        self.assertNotIn('"'+str(self.f.control)+'"',writable)
        self.assertIn('"'+str(self.f.control/'admission.lock')+'"',writable)
        self.assertIn('"'+str(self.f.control/'operations/operations.lock')+'"',writable)
        owned.roots['controlBase']=self.f.control
        with self.assertRaisesRegex(ValueError,'ROOT_CHANGED'):owned.guard()
        with self.assertRaisesRegex(ValueError,'PURPOSE_ROOT_OVERLAP'):owned.unit_text()

    def test_installation_native_guard_and_direct_unit_generator_refuse_broad_r_directory(self):
        from types import SimpleNamespace
        from reverie.owner_terminal_install import unit_text
        h=H.Installation.__new__(H.Installation)
        h.roots={'controlRoot':self.f.control,'ledgerRoot':self.roots['ledgerBase'],
                 'bootstrapRoot':self.roots['bootstrapRoot']}
        # The purpose boundary must reject before any engine producer is used.
        h.engine=SimpleNamespace(guard=lambda:self.fail('No native producer before overlap refusal'))
        with self.assertRaisesRegex(ValueError,'PURPOSE_ROOT_OVERLAP'):h._guard_native(self.config)
        policy=SimpleNamespace(value={'version':2},config=self.config,roots=h.roots,path=self.case.path)
        with self.assertRaisesRegex(ValueError,'PURPOSE_ROOT_OVERLAP'):
            unit_text(policy,Path('/nix/store/fixed-host/bin/host'))
        policy.roots={key:path for key,path in zip(h.roots,self.roots.values())}
        writable=next(line for line in unit_text(policy,Path('/nix/store/fixed-host/bin/host')).splitlines()
                      if line.startswith('ReadWritePaths='))
        self.assertNotIn('"'+str(self.f.control)+'"',writable)

    def test_direct_and_nested_mount_backing_aliases_refuse_both_directions(self):
        from reverie import worker_cold_tmp as C
        table=B.R.read_mount_table();root=self.f.control;other=self.roots['controlBase']
        rd,rr=C._mount_location(root,table);hd,hr=C._mount_location(other,table)
        self.assertEqual(rd,hd)
        location=C._mount_location
        def alias(path,rows):
            return (rd,rr)if path==other else location(path,rows)
        with patch.object(C,'_mount_location',side_effect=alias),self.assertRaisesRegex(RuntimeError,'aliases protected'):
            B.require_disjoint_roots(self.config,self.roots.values())
        for point,backing in [(other/'nested-owned-alias',rr),(root/'nested-owned-alias',hr)]:
            modeled=[*table,{'point':point,'root':backing,'device':rd,'id':987654321}]
            with self.subTest(point=point),patch.object(B.R,'read_mount_table',return_value=modeled),\
                 self.assertRaisesRegex(RuntimeError,'nested protected mount alias'):
                B.require_disjoint_roots(self.config,self.roots.values())

    def test_unknown_mount_backing_refuses_without_changing_r_control_or_lock_files(self):
        from reverie import worker_cold_tmp as C
        before={path:path.read_bytes()for path in [R.marker(self.config),self.f.control/'admission.lock',
            self.f.control/'operations/operations.lock',self.f.control/'operations/operations.json']}
        with patch.object(C,'_mount_location',side_effect=RuntimeError('unknown backing')),\
             self.assertRaisesRegex(RuntimeError,'unknown backing'):
            B.require_disjoint_roots(self.config,self.roots.values())
        self.assertEqual({path:path.read_bytes()for path in before},before)

    def test_modeled_namespace_roots_do_not_hide_writable_private_parent(self):
        import stat
        original = stat.S_IMODE(self.hroot.stat().st_mode)
        try:
            self.hroot.chmod(0o770)
            with self.assertRaisesRegex(ValueError, 'RESERVATION_CONTROL_ANCESTOR'):
                B.require_disjoint_roots(self.config, self.roots.values())
        finally:
            self.hroot.chmod(original)
