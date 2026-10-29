"""Real private stores/locks and unit CAS; manager/kernel/engine ports controlled.

No actual systemd service, engine command, laptop, GPU or provider is touched.
"""
import copy
import json
import os
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

from reverie import worker_service_transport_upgrade as T
from reverie import worker_resource_reservations as R
from reverie import worker_service_upgrade as U
from tests import test_worker_service_upgrade as fixture
from tests.test_worker_resource_reservations import NativeFixture, SID


class TransportUpgradeTests(unittest.TestCase):
    def setUp(self):
        f = fixture.GPUServiceUpgradeTests(); f.setUp(); self.addCleanup(f.doCleanups)
        self.f = f
        self.config, self.service, self.operation = f.config, f.service, f.operation
        self.config['resourceReservations'] = f.selected['resourceReservations']
        self.service.config_path.write_bytes(U.encoded(self.config))
        fixture.FakeNative.rows = NativeFixture(self.config).rows
        self.gate = R.provision(self.service.resource_probe(self.config))
        self.upgrade = T.TransportUpgrade(self.service, self.operation)
        self.engine = {'endpoint': 'unix:///synthetic/engine.sock', 'engineId': 'synthetic-engine', 'socketStamp': [1, 2]}
        self.selection_path = f.selection_path
        self.selection_path.write_text(json.dumps({'providerPIDs': []})); self.selection_path.chmod(0o600)
        self.enterContext(patch.object(self.upgrade, 'engine', return_value=self.engine))
        self.enterContext(patch.object(self.upgrade, 'broker', side_effect=lambda unit: f.manager_state(active=True)))
        self.enterContext(patch.object(self.upgrade.tools, 'manager_state', side_effect=f.manager_state))
        self.enterContext(patch.object(self.upgrade.tools, 'ready_socket', return_value=None))
        # This composition already models manager/kernel ports; startup-specific
        # real manager/socket/exec ordering is exercised separately below.
        def startup_manager(unit):
            process = f.manager_state(active=True)['process']
            return {'identity': {**process, 'uid': os.getuid()}}
        self.enterContext(patch.object(self.upgrade, '_startup_manager', side_effect=startup_manager))
        native_startup = T._startup_identity
        self.enterContext(patch.object(T, '_startup_identity', side_effect=lambda pid:
            {**f.process(pid), 'uid': os.getuid()} if pid == 500 else native_startup(pid)))
        def broker_leaf(current):
            T.need(f.process(current['process']['pid']) == current['process'], 'New broker process/program changed')
        self.enterContext(patch.object(self.upgrade, 'broker_leaf', side_effect=broker_leaf))
        self.enterContext(patch.object(self.upgrade, 'probe', side_effect=lambda config, engine: self.service.resource_probe(config)))
        # Only synthetic guest /proc paths are modeled; actual private host roots
        # retain their real dev/inode and every replacement control below.
        destinations = {'/home/agent': f.storage.home, '/nix': f.storage.nix, '/scratch': f.storage.scratch}
        def storage_leaf(path):
            prefix = '/proc/123/root'
            return R._identity(destinations[str(path)[len(prefix):]] if str(path).startswith(prefix) else path)
        self.enterContext(patch.object(self.upgrade, 'storage_leaf', side_effect=storage_leaf))
        self.original = {path: (path.read_bytes(), U.stamp(path)) for path in (
            self.service.config_path, self.service.environment, R.marker(self.config),
            Path(self.config['resourceReservations']['directory']) / 'operations/operations.json')}

    def prepare(self): return self.upgrade.prepare(self.selection_path)['planSHA256']

    def unchanged(self):
        for path, (raw, stamp) in self.original.items():
            self.assertEqual((path.read_bytes(), U.stamp(path)), (raw, stamp))

    def test_real_domain_preserved_and_new_broker_recovers_without_laptop_commands(self):
        result = self.upgrade.apply(self.prepare())
        self.assertEqual(result['state'], 'TRANSPORT_REPLACED')
        self.assertTrue(result['configUnchanged']); self.assertFalse(result['workerEffects'])
        self.assertEqual(self.service.unit.resolve(), self.service.target_unit())
        self.assertTrue((self.operation / 'old-generation').is_symlink())
        self.assertTrue((self.operation / 'new-generation').is_symlink())
        self.assertTrue((self.operation / 'DONE.json').exists()); self.unchanged()
        self.assertFalse(any(c[0] == 'docker' for c in self.f.commands))
        with self.assertRaisesRegex(ValueError, 'already consumed'):
            self.upgrade.apply(U.digest((self.operation / 'PLAN.json').read_bytes()))

    def test_preparation_has_no_manager_effect_and_live_provider_is_bound(self):
        self.selection_path.write_text(json.dumps({'providerPIDs': [os.getpid()]}))
        result = self.upgrade.prepare(self.selection_path)
        self.assertFalse(result['effects']); self.unchanged()
        plan = json.loads((self.operation / 'PLAN.json').read_bytes())
        self.assertEqual(plan['native']['providers'][0]['pid'], os.getpid())
        self.assertEqual(plan['native']['runningSessions'], [SID])
        self.assertFalse(any('stop' in c or 'start' in c for c in self.f.commands))

    def test_foreign_or_unknown_host_job_refuses_before_stop(self):
        root = Path(self.config['resourceReservations']['directory'])
        pending = root / 'operations/host-job.finish.pending.json'
        pending.write_text('{}'); pending.chmod(0o600)
        with self.assertRaisesRegex(ValueError, 'HOST_JOB_FINISH'):
            self.prepare()
        self.assertFalse((self.operation / 'ATTEMPT.json').exists())
        self.assertFalse(any('stop' in c for c in self.f.commands)); self.unchanged()

    def test_retained_operation_refuses_without_credits_or_rewrite(self):
        with patch.object(R.ReservationGate, '_document', return_value={'operations': {'retained': {}}}):
            with self.assertRaisesRegex(ValueError, 'Retained resource operation'):
                self.prepare()
        self.unchanged(); self.assertFalse(any('stop' in c for c in self.f.commands))

    def test_config_cas_drift_refuses_before_attempt(self):
        sha = self.prepare(); self.service.config_path.write_bytes(self.service.config_path.read_bytes() + b' ')
        with self.assertRaisesRegex(ValueError, 'Prepared broker generation'):
            self.upgrade.apply(sha)
        self.assertFalse((self.operation / 'ATTEMPT.json').exists())
        self.assertFalse(any('stop' in c for c in self.f.commands))

    def test_changed_native_peer_refuses_before_attempt(self):
        sha = self.prepare(); fixture.FakeNative.rows = copy.deepcopy(fixture.FakeNative.rows)
        fixture.FakeNative.rows[0]['Id'] = '9' * 64
        with self.assertRaisesRegex(ValueError, 'continuity changed'):
            self.upgrade.apply(sha)
        self.assertFalse((self.operation / 'ATTEMPT.json').exists()); self.unchanged()

    def test_late_config_change_after_stop_intent_preserves_edit_and_never_stops(self):
        sha = self.prepare(); original = T.exclusive
        def late(path, raw):
            original(path, raw)
            if path.name == 'BROKER-STOP-INTENT.json':
                self.service.config_path.write_bytes(self.service.config_path.read_bytes() + b' ')
        with patch.object(T, 'exclusive', side_effect=late), self.assertRaisesRegex(ValueError, 'Canonical config'):
            self.upgrade.apply(sha)
        self.assertTrue(self.service.config_path.read_bytes().endswith(b' '))
        self.assertTrue((self.operation / 'ATTEMPT.json').exists())
        self.assertFalse(any('stop' in c for c in self.f.commands))

    def test_owner_intent_drift_during_stop_keeps_old_generation_no_start(self):
        sha = self.prepare()
        def phase(args):
            if type(args) is list and args[:3] == ['systemctl', '--user', 'stop']:
                self.f.employee['desiredRunning'] = False; self.f.company()
        self.f.phase = phase
        with self.assertRaisesRegex(ValueError, 'Canonical config or stores'):
            self.upgrade.apply(sha)
        self.assertEqual(self.service.unit.resolve(), self.f.old)
        self.assertFalse(self.f.active); self.assertFalse((self.operation / 'DONE.json').exists())

    def test_uncertain_stop_retains_attempt_both_roots_and_never_retries(self):
        sha = self.prepare(); self.f.failure = 'stop'
        with self.assertRaises(subprocess.TimeoutExpired): self.upgrade.apply(sha)
        self.assertTrue((self.operation / 'ATTEMPT.json').exists())
        self.assertTrue((self.operation / 'old-generation').is_symlink())
        self.assertFalse((self.operation / 'DONE.json').exists()); self.unchanged()
        with self.assertRaisesRegex(ValueError, 'already consumed'): self.upgrade.apply(sha)

    def test_start_failure_preserves_new_generation_and_stores_without_rollback(self):
        sha = self.prepare(); self.f.failure = 'start'
        with self.assertRaises(subprocess.TimeoutExpired): self.upgrade.apply(sha)
        self.assertEqual(self.service.unit.resolve(), self.service.target_unit())
        self.assertFalse((self.operation / 'DONE.json').exists()); self.unchanged()
        self.assertEqual(sum('stop' in c for c in self.f.commands), 1)

    def test_phone_peer_failure_never_publishes_done(self):
        sha = self.prepare()
        self.upgrade.tools.ready_socket.side_effect = ValueError('wrong native phone peer')
        with self.assertRaisesRegex(ValueError, 'phone peer'): self.upgrade.apply(sha)
        self.assertFalse((self.operation / 'DONE.json').exists()); self.unchanged()
        self.assertTrue((self.operation / 'ATTEMPT.json').exists())

    def test_final_admission_failure_cannot_publish_success(self):
        from contextlib import contextmanager
        original = R.ReservationGate.admission
        @contextmanager
        def late(gate, *args, **kwargs):
            with original(gate, *args, **kwargs): yield
            if self.f.broker_generation > 1: raise OSError('owned finalizer failure')
        sha = self.prepare()
        with patch.object(R.ReservationGate, 'admission', late), self.assertRaises(OSError):
            self.upgrade.apply(sha)
        self.assertFalse((self.operation / 'DONE.json').exists()); self.unchanged()

    def test_final_durable_result_write_drift_is_detected(self):
        sha = self.prepare(); original = T.exclusive
        def late(path, raw):
            original(path, raw)
            if path.name == 'DONE.next.json':
                self.f.employee['onVacation'] = True; self.f.company()
        with patch.object(T, 'exclusive', side_effect=late), self.assertRaisesRegex(ValueError, 'Canonical config'):
            self.upgrade.apply(sha)
        self.assertFalse((self.operation / 'DONE.json').exists())

    def test_installed_protected_consumers_require_their_own_coordinated_path(self):
        self.config['resourceActorConfig'] = '/synthetic/private/actor.json'
        with self.assertRaisesRegex(ValueError, 'protected consumers'):
            self.upgrade._gate(self.config, self.engine)
        del self.config['resourceActorConfig']
        unit = self.service.home / '.config/systemd/user/reverie-owner-terminal.service'
        unit.symlink_to('/missing/owned/unit')
        with self.assertRaisesRegex(ValueError, 'protected consumers'):
            self.upgrade._gate(self.config, self.engine)

    def test_selection_has_no_command_or_identity_authority_and_refuses_bool_pid(self):
        for value in ({'providerPIDs': [True]}, {'providerPIDs': [2, 2]}, {'providerPIDs': [], 'command': 'unsafe'}):
            self.selection_path.write_text(json.dumps(value))
            with self.assertRaises(ValueError): self.prepare()
        self.assertFalse(any('stop' in c for c in self.f.commands))

    def test_real_wrapper_recognition_rejects_nonbroker_program_before_pid_reads(self):
        unit = self.upgrade.tools.generation()['unit']
        with self.assertRaisesRegex(ValueError, 'Recognized immutable broker source'):
            T.TransportUpgrade.broker(self.upgrade, unit)

    def test_provider_loss_inside_last_capacity_call_is_not_success(self):
        self.selection_path.write_text(json.dumps({'providerPIDs': [os.getpid()]}))
        sha = self.prepare(); original = self.upgrade.idle; process = self.f.process
        def late(gate):
            original(gate)
            if self.f.broker_generation > 1:
                U.P._process.side_effect = lambda pid: {'pid': pid, 'startTick': 999} if pid == os.getpid() else process(pid)
        with patch.object(self.upgrade, 'idle', side_effect=late), self.assertRaisesRegex(ValueError, 'Native provider process changed'):
            self.upgrade.apply(sha)
        self.assertFalse((self.operation / 'DONE.json').exists())

    def test_storage_replacement_inside_last_capacity_call_is_not_success(self):
        sha = self.prepare(); original = self.upgrade.idle
        def late(gate):
            original(gate)
            if self.f.broker_generation > 1:
                self.f.storage.scratch.rename(self.f.storage.scratch.with_name('retained-old-scratch'))
                self.f.storage.scratch.mkdir(mode=0o700)
        with patch.object(self.upgrade, 'idle', side_effect=late), self.assertRaisesRegex(ValueError, 'Canonical storage root changed'):
            self.upgrade.apply(sha)
        self.assertFalse((self.operation / 'DONE.json').exists())

    def test_real_owned_socket_pins_engine_endpoint_and_daemon_without_engine_calls(self):
        import socket
        path = self.f.root / 'engine.sock'
        with socket.socket(socket.AF_UNIX) as owned:
            owned.bind(str(path)); path.chmod(0o600)
            info = {'ID': 'synthetic-daemon', 'OSType': 'linux', 'KernelVersion': os.uname().release,
                    'CgroupVersion': '2', 'MemoryLimit': True, 'SwapLimit': True, 'PidsLimit': True}
            def query(args):
                self.assertEqual(args, ['docker', '--host', 'unix://' + str(path), 'info', '--format', '{{json .}}'])
                return subprocess.CompletedProcess(args, 0, json.dumps(info), '')
            with patch.dict(os.environ, {'DOCKER_HOST': 'unix://' + str(path), 'DOCKER_CONTEXT': ''}), \
                    patch.object(self.upgrade.tools, 'run', side_effect=query):
                first = T.TransportUpgrade.engine(self.upgrade)
                info['ID'] = 'different-daemon'
                self.assertNotEqual(first, T.TransportUpgrade.engine(self.upgrade))
                info['MemoryLimit'] = False
                with self.assertRaisesRegex(ValueError, 'Bound native cgroup'):
                    T.TransportUpgrade.engine(self.upgrade)

    def test_engine_probe_forbids_mutating_commands_and_uses_only_pinned_endpoint(self):
        probe = T.TransportUpgrade.probe(self.upgrade, self.config, self.engine)
        for args in (['create', 'unrelated'], ['stop', 'unrelated'], ['exec', 'unrelated']):
            with self.assertRaisesRegex(ValueError, 'metadata-only'): probe.run_engine(args)
        with patch.object(self.service, 'run', return_value=subprocess.CompletedProcess([], 0, '[]', '')) as run:
            probe.run_engine(['inspect', 'owned'])
            self.assertEqual(run.call_args.args[0], ['docker', '--host', self.engine['endpoint'], 'inspect', 'owned'])
            self.assertLessEqual(run.call_args.kwargs['deadline'], self.upgrade.deadline)

    def test_last_admission_exit_cannot_replace_new_generation_before_done(self):
        from contextlib import contextmanager
        original = R.ReservationGate.admission
        @contextmanager
        def late(gate, *args, **kwargs):
            with original(gate, *args, **kwargs): yield
            if self.f.broker_generation > 1:
                self.service.unit.unlink(); self.service.unit.symlink_to(self.f.old)
        sha = self.prepare()
        with patch.object(R.ReservationGate, 'admission', late), self.assertRaisesRegex(ValueError, 'Generation link changed'):
            self.upgrade.apply(sha)
        self.assertFalse((self.operation / 'DONE.json').exists())

    def test_cli_dispatch_is_fixed_and_excludes_gpu_upgrade(self):
        from reverie import worker_service as S
        with patch.object(T, 'TransportUpgrade') as migration, patch.object(S, 'WorkerService'):
            migration.return_value.prepare.return_value = {'effects': False}
            migration.return_value.apply.return_value = {'state': 'controlled'}
            with patch('builtins.print'):
                self.assertEqual(S.main(['--config', str(self.service.config_path), 'prepare-transport-upgrade',
                                         '--operation', str(self.operation), '--selection', str(self.selection_path)]), 0)
                self.assertEqual(S.main(['--config', str(self.service.config_path), 'apply-transport-upgrade',
                                         '--operation', str(self.operation), '--plan-sha256', 'a' * 64]), 0)
            migration.return_value.prepare.assert_called_once_with(self.selection_path)
            migration.return_value.apply.assert_called_once_with('a' * 64)

    def test_broker_loss_during_final_admission_exit_never_publishes_done(self):
        from contextlib import contextmanager
        original = R.ReservationGate.admission
        @contextmanager
        def late(gate, *args, **kwargs):
            with original(gate, *args, **kwargs): yield
            if self.f.broker_generation > 1: self.f.active = False
        sha = self.prepare()
        with patch.object(R.ReservationGate, 'admission', late), self.assertRaises(FileNotFoundError):
            self.upgrade.apply(sha)
        self.assertFalse((self.operation / 'DONE.json').exists())

    def test_provider_loss_inside_final_protected_reader_never_publishes_done(self):
        # Exact independent R1 mutation schedule; only the refusal oracle changes.
        self.selection_path.write_text(json.dumps({'providerPIDs': [os.getpid()]}))
        sha = self.prepare(); original = self.upgrade.protected; process = self.f.process; changed = []
        def late(gate):
            result = original(gate)
            if self.f.broker_generation > 1 and (self.operation / 'DONE.next.json').exists() and not changed:
                U.P._process.side_effect = lambda pid: {'pid': pid, 'startTick': 999} if pid == os.getpid() else process(pid)
                changed.append(True)
            return result
        with patch.object(self.upgrade, 'protected', side_effect=late), self.assertRaisesRegex(ValueError, 'Native provider process changed'):
            self.upgrade.apply(sha)
        self.assertEqual(changed, [True]); self.assertFalse((self.operation / 'DONE.json').exists())
        self.assertTrue((self.operation / 'ATTEMPT.json').exists())

    def test_physical_root_is_rechecked_after_last_broker_process_reader(self):
        sha = self.prepare(); original = self.upgrade.broker_leaf; changed = []
        def late(current):
            original(current)
            if (self.operation / 'DONE.next.json').exists() and not changed:
                self.f.storage.scratch.rename(self.f.storage.scratch.with_name('retained-final-old-scratch'))
                self.f.storage.scratch.mkdir(mode=0o700); changed.append(True)
        with patch.object(self.upgrade, 'broker_leaf', side_effect=late), self.assertRaisesRegex(ValueError, 'Canonical storage root changed'):
            self.upgrade.apply(sha)
        self.assertEqual(changed, [True]); self.assertFalse((self.operation / 'DONE.json').exists())
        self.assertTrue((self.operation / 'ATTEMPT.json').exists())


class WrapperGrammar(unittest.TestCase):
    def test_exact_legacy_and_isolated_forms_reject_ambiguous_flags_or_source(self):
        source='/nix/store/'+'a'*32+'-reverie-source/python/reverie/worker.py'
        python='/nix/store/'+'b'*32+'-python3-env/bin/python3'
        legacy=f'exec python3 {source} broker "$@"\n'
        isolated=f'exec {python} -I -B {source} broker "$@"\n'
        self.assertEqual(T._wrapper_program(legacy.encode())['kind'],'legacy')
        self.assertEqual(T._wrapper_program(isolated.encode())['interpreter'],python)
        for body in [legacy+isolated,legacy+legacy,isolated.replace('-I -B','-B -I'),
                     isolated.replace('-I -B','-IB'),isolated.replace('-I -B','-I'),
                     isolated.replace(' -I',' -E -I'),isolated.replace('worker.py','other.py'),
                     isolated.replace('broker "$@"','client "$@"'),isolated.replace('exec ','exec env '),
                     isolated.replace('\n','\r\n'),isolated+'exec /unrelated\n']:
            with self.subTest(body=body),self.assertRaises(ValueError):T._wrapper_program(body.encode())


LEGACY_WRAPPER=os.environ.get('NIX_REVERIE_TEST_TRANSPORT_LEGACY_WRAPPER')
ISOLATED_WRAPPER=os.environ.get('NIX_REVERIE_TEST_TRANSPORT_ISOLATED_WRAPPER')


class PackagedTransportProgram(unittest.TestCase):
    """Actual packaged derivation templates with inert immutable source only.

    The source-literal-only fixture prints READY then parks on its owned stdin.
    No busywait, ptrace, loader injection, Broker, engine or service is used.
    """
    def setUp(self):
        import tempfile
        import time
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve();self.config=self.root/'invalid-config.json'
        self.config.write_bytes(b'{}');self.config.chmod(0o600)
        from reverie import worker_gpu_preflight as P
        self.native_process=P._process
        self.children=[];self.addCleanup(self.settle)
        self.probe=T.TransportUpgrade.__new__(T.TransportUpgrade);self.probe.deadline=time.monotonic()+60
        from types import SimpleNamespace
        self.probe.service=SimpleNamespace(config_path=self.config)

    def settle(self):
        for child in self.children:
            try:
                if child.poll() is None:
                    child.stdin.write(b'x');child.stdin.flush();child.stdin.close()
                    try:child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        child.kill();child.wait(timeout=5)
            finally:
                for stream in (child.stdin,child.stdout,child.stderr):
                    if stream is not None and not stream.closed:stream.close()
        self.children=[]

    def child(self, wrapper, *, argv=None):
        import selectors
        wrapper=Path(wrapper);program=T._wrapper_program(wrapper.read_bytes())
        args=argv or [str(wrapper),'--config',str(self.config)]
        child=subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
            env={'LANG':'C.UTF-8','PATH':'/nonexistent'})
        self.children.append(child)
        with selectors.DefaultSelector()as selected:
            selected.register(child.stdout,selectors.EVENT_READ)
            self.assertTrue(selected.select(5),'Immutable inert-source READY unavailable')
            self.assertEqual(os.read(child.stdout.fileno(),64),b'TRANSPORT_ABI_READY\n')
        self.assertIsNone(child.poll())
        return child

    def unit(self, wrapper):
        return {'entries':{'ExecStart':{'path':str(wrapper),'sha256':T.digest(Path(wrapper).read_bytes())}}}

    def bind(self, child):
        from types import SimpleNamespace
        self.probe.tools=SimpleNamespace(manager_state=lambda **_: {'properties':{'MainPID':str(child.pid)},
            'process':self.native_process(child.pid)})

    @unittest.skipUnless(LEGACY_WRAPPER and ISOLATED_WRAPPER,'Pinned packaged broker wrappers required')
    def test_actual_packaged_wrappers_qualify_and_new_interpreter_matches_kernel_elf(self):
        for wrapper,kind in [(LEGACY_WRAPPER,'legacy'),(ISOLATED_WRAPPER,'isolated')]:
            with self.subTest(kind=kind):
                child=self.child(wrapper);self.bind(child)
                result=self.probe.broker(self.unit(wrapper))
                self.assertEqual(result['program']['wrapperKind'],kind)
                self.assertEqual(result['program']['exe'],str(Path('/proc/self/exe').resolve(strict=True)))
                self.assertEqual(self.probe.broker(self.unit(wrapper)),result)
                self.settle()

    @unittest.skipUnless(ISOLATED_WRAPPER,'Pinned isolated packaged broker required')
    def test_actual_wrong_flags_interpreter_source_config_digest_and_birth_refuse(self):
        from types import SimpleNamespace
        program=T._wrapper_program(Path(ISOLATED_WRAPPER).read_bytes())
        declared=program['interpreter'];source=program['source']
        bare=str(Path('/proc/self/exe').resolve(strict=True))
        cases=[([declared,'-B','-I',source,'broker','--config',str(self.config)],'argv'),
               ([bare,'-I','-B',source,'broker','--config',str(self.config)],'argv'),
               ([declared,'-I','-B',source,'broker','--config',str(self.root/'other-config')],'argv')]
        if LEGACY_WRAPPER:
            other=T._wrapper_program(Path(LEGACY_WRAPPER).read_bytes())['source']
            cases.append(([declared,'-I','-B',other,'broker','--config',str(self.config)],'argv'))
        for args,reason in cases:
            with self.subTest(args=args):
                # Observe the selected source of this owned direct invocation.
                # The production qualifier still consumes the real fixed wrapper.
                if args[3]!=source:
                    child=self.child(LEGACY_WRAPPER,argv=args)
                else:child=self.child(ISOLATED_WRAPPER,argv=args)
                self.bind(child)
                with self.assertRaisesRegex(ValueError,reason):self.probe.broker(self.unit(ISOLATED_WRAPPER))
                self.settle()
        child=self.child(ISOLATED_WRAPPER);self.bind(child)
        unit=self.unit(ISOLATED_WRAPPER);unit['entries']['ExecStart']['sha256']='0'*64
        with self.assertRaisesRegex(ValueError,'wrapper changed'):self.probe.broker(unit)
        expected=self.native_process(child.pid);expected['startTick']+=1
        self.probe.tools=SimpleNamespace(manager_state=lambda **_:{'process':expected})
        with self.assertRaisesRegex(ValueError,'process changed'):self.probe.broker(self.unit(ISOLATED_WRAPPER))

    @unittest.skipUnless(LEGACY_WRAPPER and ISOLATED_WRAPPER,'Pinned packaged broker wrappers required')
    def test_actual_apply_reaches_new_isolated_program_readback_before_done(self):
        import time,types
        from reverie import worker_gpu_preflight as P
        case=TransportUpgradeTests();case.setUp();self.addCleanup(case.doCleanups)
        upgrade=case.upgrade;f=case.f;generation=upgrade.tools.generation
        old=self.child(LEGACY_WRAPPER,argv=[LEGACY_WRAPPER,'--config',str(case.service.config_path)])
        selected=[old]
        self.enterContext(patch.object(P,'_process',side_effect=lambda pid:
            f.process(pid)if pid in(123,124,500)else self.native_process(pid)))
        def manager_state(*,active):
            f.manager_state(active=active)
            if not active:return {'properties':{'MainPID':'0'}}
            return {'properties':{'MainPID':str(selected[0].pid)},'process':self.native_process(selected[0].pid)}
        upgrade.tools.manager_state=manager_state
        upgrade._startup_manager=lambda unit: {'identity': {
            'pid': selected[0].pid, 'startTick': self.native_process(selected[0].pid)['startTick'],
            'uid': os.getuid()}}
        def records():
            value=generation()
            for key,wrapper in [('unit',LEGACY_WRAPPER if f.broker_generation==1 else ISOLATED_WRAPPER),
                                ('newUnit',ISOLATED_WRAPPER)]:
                value[key]['entries']['ExecStart']=self.unit(wrapper)['entries']['ExecStart']
            return value
        upgrade.tools.generation=records
        upgrade.broker=types.MethodType(T.TransportUpgrade.broker,upgrade)
        upgrade.broker_leaf=types.MethodType(T.TransportUpgrade.broker_leaf,upgrade)
        command=f.command
        def phase(args,*,deadline=None):
            result=command(args,deadline=deadline)
            if args[:3]==['systemctl','--user','stop']:
                self.settle()
            elif args[:3]==['systemctl','--user','start']:
                selected[0]=self.child(ISOLATED_WRAPPER,argv=[ISOLATED_WRAPPER,'--config',str(case.service.config_path)])
            return result
        case.service.run=phase
        result=upgrade.apply(case.prepare())
        self.assertEqual(result['state'],'TRANSPORT_REPLACED')
        self.assertEqual(result['broker']['program']['wrapperKind'],'isolated')
        self.assertTrue((case.operation/'DONE.json').exists())
        case.unchanged()
        self.assertFalse(any(c[0]=='docker'for c in f.commands))


INTERPRETER_READY_WRAPPER = os.environ.get('NIX_REVERIE_TEST_INTERPRETER_READY_WRAPPER')


@unittest.skipUnless(INTERPRETER_READY_WRAPPER, 'Pinned inert Nix exec-window fixture required')
class InterpreterExecWindow(unittest.TestCase):
    """Actual dumpability/exec, procfs, birth, ELF, argv and child settlement.

    Only Popen scheduling/owned fixture argv is controlled. No fake permission
    exception/process metadata, service, engine or provider is involved.
    """
    def setUp(self):
        import time
        from reverie import worker_gpu_preflight as P
        self.native = P._process
        self.wrapper = Path(INTERPRETER_READY_WRAPPER).resolve(strict=True)
        # Actual Nix user namespaces expose root-owned store inputs as 65534.
        # Model ONLY the two fixed inert input files' host UID for this fixture;
        # keep the native guard and all procfs/permission/program facts real.
        self.bare_python = Path('/proc/self/exe').resolve(strict=True)
        self.mapped_inputs = bool(os.environ.get('NIX_BUILD_TOP') and
            Path('/').stat().st_uid == Path('/nix/store').stat().st_uid == 65534)
        if self.mapped_inputs:
            from types import SimpleNamespace
            original_stat = Path.stat
            selected = {self.wrapper, self.bare_python}
            def input_stat(path, *args, **kwargs):
                info = original_stat(path, *args, **kwargs)
                if path in selected and info.st_uid == 65534:
                    return SimpleNamespace(**{**{key: getattr(info, key) for key in dir(info)
                        if key.startswith('st_')}, 'st_uid': 0})
                return info
            self.enterContext(patch.object(Path, 'stat', input_stat))
        self.probe = T.IsolatedInterpreterObserver(time.monotonic() + 5)
        self.original_popen = subprocess.Popen
        self.children = []; self.before = []; self.after = []; self.mutation = None
        self.addCleanup(self.settle)

    def settle(self):
        for child in self.children:
            if child.poll() is None: child.kill()
            child.wait(timeout=3)
            for stream in (child.stdin, child.stdout, child.stderr):
                if stream is not None and not stream.closed: stream.close()
        self.assertTrue(all(child.returncode is not None for child in self.children))

    def controlled_popen(self, args, **kwargs):
        import signal, time
        selected = list(args)
        if self.mutation == 'argv': selected[1:1] = ['-X', 'utf8']
        if self.mutation == 'schema': selected[-1] = selected[-1].replace("'version':1", "'version':2")
        if self.mutation == 'post-ready-permission':
            selected[-1] = selected[-1].replace('print(json.dumps',
                "import ctypes;assert ctypes.CDLL(None).prctl(4,0,0,0,0)==0;print(json.dumps")
        if self.mutation == 'eof': selected[-1] = 'pass'
        if self.mutation == 'timeout': selected[-1] = 'import time;time.sleep(20)'
        child = self.original_popen(selected, **kwargs); self.children.append(child)
        end = time.monotonic() + 3
        while time.monotonic() < end:
            stopped = os.waitid(os.P_PID, child.pid, os.WSTOPPED | os.WNOHANG | os.WNOWAIT)
            if stopped is not None: break
            time.sleep(.001)
        else: self.fail('Owned immutable fixture did not stop')
        self.assertEqual((stopped.si_code, stopped.si_status), (os.CLD_STOPPED, signal.SIGSTOP))
        raw = (Path('/proc') / str(child.pid) / 'stat').read_bytes()
        birth = int(raw.rsplit(b')', 1)[1].split()[19])
        with self.assertRaises(PermissionError) as denied: self.native(child.pid)
        self.assertEqual(denied.exception.errno, 13)
        self.before.append((child.pid, birth))
        child.send_signal(signal.SIGCONT)
        return child

    def observe(self):
        from reverie import worker_gpu_preflight as P
        def actual(pid):
            value = self.native(pid); self.after.append(value); return value
        with patch.object(T.subprocess, 'Popen', side_effect=self.controlled_popen), \
             patch.object(P, '_process', side_effect=actual):
            return self.probe.observe(self.wrapper)

    def test_real_pre_ready_denial_then_same_birth_full_program_proof(self):
        value = self.observe()
        self.assertEqual(value['argv0'], str(self.wrapper))
        self.assertEqual(value['executable'], str(Path('/proc/self/exe').resolve(strict=True)))
        self.assertGreaterEqual(len(self.after), 2)
        self.assertTrue(all((p['pid'], p['startTick']) == self.before[0] for p in self.after))
        self.assertIsNone(self.probe._probe_child)
        self.assertTrue(all(c.returncode == 0 for c in self.children))

    def test_real_post_ready_permission_denial_is_not_a_fallback(self):
        self.mutation = 'post-ready-permission'
        with self.assertRaises(PermissionError): self.observe()
        self.assertEqual(len(self.children), 1)

    def test_extra_actual_interpreter_argument_refuses(self):
        self.mutation = 'argv'
        with self.assertRaisesRegex(ValueError, 'process changed'): self.observe()

    def test_wrong_fixed_ready_schema_refuses(self):
        self.mutation = 'schema'
        with self.assertRaisesRegex(ValueError, 'schema refused'): self.observe()

    def test_actual_early_exit_never_qualifies_or_restarts(self):
        self.mutation = 'eof'
        with self.assertRaisesRegex(ValueError, 'unavailable'): self.observe()
        self.assertEqual(len(self.children), 1)

    def test_actual_no_ready_deadline_retains_any_unsettled_owned_child(self):
        import time
        self.mutation = 'timeout'; self.probe.deadline = time.monotonic() + .7
        with self.assertRaises(ValueError): self.observe()
        self.assertEqual(len(self.children), 1)
        if self.children[0].poll() is None:
            self.assertIs(self.probe._probe_child, self.children[0])

    def test_fixture_uid_model_does_not_qualify_source_or_unlisted_store_inputs(self):
        # Real mode/inode/size/time and all procfs observations remain unchanged.
        for path in (self.wrapper, self.bare_python):
            actual = os.stat(path); observed = path.stat()
            for field in ('st_dev', 'st_ino', 'st_mode', 'st_gid', 'st_nlink',
                          'st_size', 'st_mtime_ns', 'st_ctime_ns'):
                self.assertEqual(getattr(observed, field), getattr(actual, field))
        with self.assertRaisesRegex(ValueError, 'Immutable broker program'):
            T._immutable(Path(__file__))
        # A third genuine read-only Nix input is NOT blanket UID-normalized.
        unlisted = Path(os.__file__).resolve(strict=True)
        self.assertNotIn(unlisted, (self.wrapper, self.bare_python))
        self.assertEqual(unlisted.stat().st_uid, os.stat(unlisted).st_uid)
        if self.mapped_inputs:
            self.assertEqual(unlisted.stat().st_uid, 65534)
            with self.assertRaisesRegex(ValueError, 'Immutable broker program'):
                T._immutable(unlisted)


def startup_manager_text(service, unit, pid, names):
    from reverie.worker_service import UNIT
    def loaded(path):
        return ('{ path='+path+' ; argv[]='+path+' --config ${REVERIE_WORKER_CONFIG}'
                ' ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0 }')
    values={'Id':UNIT,'LoadState':'loaded','ActiveState':'active','SubState':'running',
        'MainPID':str(pid),'ControlPID':'0','Job':'','FragmentPath':str(service.unit),
        'DropInPaths':'','NeedDaemonReload':'no','ControlGroup':'/owned-controlled-unit',
        **{key:loaded(unit['entries'][key]['path']) for key in('ExecStartPre','ExecStart')}}
    return values, '\n'.join(name+'='+values[name] for name in names)+'\n'


class StartupManagerMetadata(unittest.TestCase):
    """Real registered files/own minimal proc identity; manager records controlled."""
    def setUp(self):
        f=fixture.GPUServiceUpgradeTests();f.setUp();self.addCleanup(f.doCleanups)
        self.f=f;self.unit=U.unit_record(f.service,f.service.unit.resolve())
        self.upgrade=T.TransportUpgrade(f.service,f.operation);self.edits={}
        def read(args,*,deadline=None):
            names=args[-1].removeprefix('--property=').split(',')
            values,_=startup_manager_text(f.service,self.unit,os.getpid(),names);values.update(self.edits)
            return subprocess.CompletedProcess(args,0,'\n'.join(n+'='+values[n]for n in names)+'\n','')
        f.service.run=read
    def test_basic_observation_does_not_require_root_namespace_or_program_yet(self):
        from reverie import worker_gpu_preflight as P
        with patch.object(P,'_process',side_effect=AssertionError('too early full process read')):
            value=self.upgrade._startup_manager(self.unit)
        self.assertEqual(value['identity']['pid'],os.getpid())
        self.assertEqual(value['identity']['uid'],os.getuid())
    def test_loaded_unit_reload_dropins_and_invocation_drift_refuse(self):
        for edits in ({'NeedDaemonReload':'yes'},{'DropInPaths':'/foreign.conf'},
                      {'FragmentPath':'/foreign.service'},{'LoadState':'not-found'},
                      {'ExecStart':startup_manager_text(self.f.service,self.unit,os.getpid(),['ExecStart'])[0]['ExecStart'].replace(' --config',' --unreviewed --config')},
                      {'ExecStartPre':startup_manager_text(self.f.service,self.unit,os.getpid(),['ExecStartPre'])[0]['ExecStartPre'].replace('ignore_errors=no','ignore_errors=yes')}):
            with self.subTest(edits=edits),self.assertRaises(ValueError):
                self.edits=edits;self.upgrade._startup_manager(self.unit)
    def test_invalid_or_foreign_pid_refuses(self):
        for pid in ('0','1','-2','2147483648','not-a-pid'):
            with self.subTest(pid=pid),self.assertRaises(ValueError):
                self.edits={'MainPID':pid};self.upgrade._startup_manager(self.unit)
    def test_changed_pid_birth_between_socket_and_full_proof_refuses(self):
        original=T._startup_identity;calls=[]
        def changed(pid):
            value=original(pid);calls.append(pid)
            return {**value,'startTick':value['startTick']+1}if len(calls)==2 else value
        with patch.object(T,'_startup_identity',side_effect=changed), \
             patch.object(self.upgrade.tools,'ready_socket'), \
             patch.object(self.upgrade,'broker',side_effect=AssertionError('not reached')), \
             self.assertRaisesRegex(ValueError,'startup process changed'):
            self.upgrade.started_broker(self.unit,{'socket':'/unused'}, {'pid':1,'startTick':1})
    def test_same_previous_incarnation_refuses_before_socket(self):
        old=T._startup_identity(os.getpid())
        with patch.object(self.upgrade.tools,'ready_socket',side_effect=AssertionError('not reached')), \
             self.assertRaisesRegex(ValueError,'New broker process required'):
            self.upgrade.started_broker(self.unit,{'socket':'/unused'},old)


@unittest.skipUnless(INTERPRETER_READY_WRAPPER,'Pinned inert Nix exec-window fixture required')
class ActualStartupReadiness(unittest.TestCase):
    """Real owned exec/permissions/UDS/ELF/argv; only systemd metadata is modeled."""
    def setUp(self):
        import tempfile,time
        from reverie.worker_service import WorkerService
        self.temp=tempfile.TemporaryDirectory(prefix='tstart-');self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve();self.config=self.root/'config.json';self.socket=self.root/'primary.sock'
        self.config.write_text(json.dumps({'socket':str(self.socket)}));self.config.chmod(0o600)
        self.fixture=Path(INTERPRETER_READY_WRAPPER).resolve(strict=True);self.package=self.fixture.parent.parent
        self.wrapper=self.package/'bin/reverie-worker-broker';self.source=self.package/'python/reverie/worker.py'
        self.unit_path=self.package/'share/systemd/user/reverie-worker-broker.service'
        self.bare=Path('/proc/self/exe').resolve(strict=True)
        selected={self.fixture,self.wrapper,self.source,self.unit_path,self.package/'bin/reverie-worker-service-check',self.bare}
        if os.environ.get('NIX_BUILD_TOP')and Path('/').stat().st_uid==Path('/nix/store').stat().st_uid==65534:
            from types import SimpleNamespace
            original=Path.stat
            def mapped(path,*args,**kwargs):
                value=original(path,*args,**kwargs)
                return SimpleNamespace(**{**{k:getattr(value,k)for k in dir(value)if k.startswith('st_')},'st_uid':0})if path in selected and value.st_uid==65534 else value
            self.enterContext(patch.object(Path,'stat',mapped))
        self.service=WorkerService(self.config,home=self.root,run=self.manager)
        self.service.unit.parent.mkdir(parents=True);self.service.gcroot.parent.mkdir(parents=True)
        self.service.unit.symlink_to(self.unit_path);self.service.gcroot.symlink_to(self.package)
        self.upgrade=T.TransportUpgrade(self.service,self.root);self.unit=U.unit_record(self.service,self.unit_path)
        self.original_popen=subprocess.Popen;self.children=[];self.main=None;self.pre_ready=[];self.addCleanup(self.settle)
    def settle(self):
        for child in self.children:
            if child.poll()is None:child.kill()
            child.wait(timeout=3)
            for stream in(child.stdin,child.stdout,child.stderr):
                if stream is not None and not stream.closed:stream.close()
    def stopped(self,child):
        import signal,time
        end=time.monotonic()+3
        while time.monotonic()<end:
            value=os.waitid(os.P_PID,child.pid,os.WSTOPPED|os.WNOHANG|os.WNOWAIT)
            if value is not None:break
            time.sleep(.001)
        else:self.fail('owned public fixture did not stop')
        self.assertEqual(value.si_status,signal.SIGSTOP)
    def manager(self,args,*,deadline=None):
        names=args[-1].removeprefix('--property=').split(',')
        _,raw=startup_manager_text(self.service,self.unit,self.main.pid,names)
        return subprocess.CompletedProcess(args,0,raw,'')
    def start(self):
        self.main=self.original_popen([str(self.wrapper),'--config',str(self.config)],stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,stderr=subprocess.PIPE,env={'LANG':'C.UTF-8','PATH':'/nonexistent'})
        self.children.append(self.main);self.stopped(self.main)
        with self.assertRaises(PermissionError)as denied:self.upgrade.broker(self.unit)
        self.assertEqual(denied.exception.errno,13);self.pre_ready.append(denied.exception.filename)
    def probe_popen(self,args,**kwargs):
        import signal
        child=self.original_popen(args,**kwargs);self.children.append(child);self.stopped(child)
        child.send_signal(signal.SIGCONT);return child
    def test_actual_exec_window_socket_then_full_program_same_birth(self):
        import signal
        self.start();birth=T._startup_identity(self.main.pid)['startTick'];original=self.upgrade.tools.ready_socket
        def ready(path,pid):
            self.assertEqual(pid,self.main.pid);self.main.send_signal(signal.SIGCONT);return original(path,pid)
        with patch.object(self.upgrade.tools,'ready_socket',side_effect=ready), \
             patch.object(T.subprocess,'Popen',side_effect=self.probe_popen):
            result=self.upgrade.started_broker(self.unit,{'socket':str(self.socket)},{'pid':1,'startTick':1})
        self.assertEqual(result['process']['pid'],self.main.pid);self.assertEqual(result['process']['startTick'],birth)
        self.assertEqual(result['program']['wrapperKind'],'isolated');self.assertEqual(result['program']['exe'],str(self.bare))
        self.main.stdin.write(b'x');self.main.stdin.flush();self.main.stdin.close();self.assertEqual(self.main.wait(timeout=3),0)
        self.assertTrue(all(child.poll()is not None for child in self.children))
    def test_wrong_existing_socket_peer_refuses_before_full_program(self):
        import socket
        self.start()
        with socket.socket(socket.AF_UNIX)as wrong:
            wrong.bind(str(self.socket));self.socket.chmod(0o600);wrong.listen(1)
            with patch.object(self.upgrade,'broker',side_effect=AssertionError('no full proof')), \
                 self.assertRaisesRegex(ValueError,'not the selected new broker'):
                self.upgrade.started_broker(self.unit,{'socket':str(self.socket)},{'pid':1,'startTick':1})
    def test_no_socket_deadline_never_qualifies_or_restarts(self):
        import time
        self.start();self.upgrade.deadline=self.upgrade.tools.deadline=time.monotonic()+1
        with patch.object(self.upgrade,'broker',side_effect=AssertionError('no full proof')),self.assertRaisesRegex(ValueError,'readiness deadline'):
            self.upgrade.started_broker(self.unit,{'socket':str(self.socket)},{'pid':1,'startTick':1})
        self.assertEqual(len(self.children),1)
