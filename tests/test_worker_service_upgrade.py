"""Owned real stores and generation CAS; engine/manager/GPU ports are controlled.

No container, real user service, provider, native GPU or owner account is touched.
"""
import copy
import json
import os
from pathlib import Path
import subprocess
import threading
import socket
import unittest
from unittest.mock import patch

from reverie import worker_service_upgrade as U
from reverie import worker_resource_reservations as R
from reverie.worker_service import UNIT, environment_selection
from reverie.worker_storage import prepare_storage, storage_paths, storage_start_allowed
from reverie.worker import Broker
from tests import test_worker_service as service_fixture
from tests.test_worker_resource_reservations import NativeFixture, EID, SID, COMPANY, POOL

DEVICE = 'nvidia.com/gpu=GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
PEER = '22222222-2222-4222-8222-222222222222'
TEMPLATE = '''[Unit]
Description=Reverie laptop broker and office watchdog
[Service]
EnvironmentFile=%h/.config/reverie/worker-broker.env
ExecStartPre={check} --config ${{REVERIE_WORKER_CONFIG}}
ExecStart={broker} --config ${{REVERIE_WORKER_CONFIG}}
Restart=on-failure
RestartSec=3
TimeoutStopSec=35
KillMode=mixed
UMask=0077
NoNewPrivileges=true
MemoryMax=512M
TasksMax=512
[Install]
WantedBy=default.target
'''


class FakeNative:
    """Only kernel/engine observations; real provision/journal/flocks still run."""
    rows = []

    def __init__(self, broker):
        self.broker = broker
        self._local = threading.local()

    def _deadline(self, supplied=None):
        return getattr(self._local, 'deadline', None) or U.time.monotonic() + 30

    def inventory(self, deadline=None):
        return copy.deepcopy(self.rows)

    def custody(self, root, binding, *, deadline=None):
        return self.inventory()

    def capacity(self, rows, selected):
        return (1024 * R.MIB, 8192 * R.MIB, {'containerId': '2' * 64}, [])

    def storage(self, row, paths):
        return U.GPUUpgrade.storage_identities(paths)

    def limits(self, row):
        return 1024 * R.MIB, {'containerId': row['Id'], 'pid': row['State']['Pid']}


class GPUServiceUpgradeTests(unittest.TestCase):
    def setUp(self):
        # Generation checks every unit-directory ancestor. Nix may place its
        # default TMPDIR under a writable, non-sticky build ancestor; use the
        # standard sticky temporary root without relaxing production checks.
        with patch.object(service_fixture.fixture.tempfile, 'tempdir', '/tmp'):
            f = service_fixture.WorkerServiceTests(); f.setUp()
        self.addCleanup(f.doCleanups)
        self.root, self.config, self.service = f.root, f.config, f.service
        self.config.update(poolMemoryMiB=8192)
        self.service.gcroot.parent.mkdir(mode=0o700, parents=True)
        self.service.unit.parent.mkdir(mode=0o755, parents=True)
        self.service.environment.parent.mkdir(mode=0o700, parents=True)
        self.old = f.store / 'old-unit/share/systemd/user' / UNIT
        for index, path in enumerate((self.old, f.target)):
            package = f.store / ('old-code' if index == 0 else 'new-code') / 'bin'
            package.mkdir(mode=0o755, parents=True)
            check, broker = package / 'reverie-worker-service-check', package / 'reverie-worker-broker'
            for entry in (check, broker):
                entry.write_text('#!/bin/sh\nexit 0\n'); entry.chmod(0o555)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(TEMPLATE.format(check=check, broker=broker)); path.chmod(0o444)
        self.service.unit.symlink_to(self.old)
        self.service.gcroot.symlink_to(f.store / 'old-unit')
        self.service.environment.write_text(environment_selection(self.service.config_path)); self.service.environment.chmod(0o600)
        self.employee = {'id': EID, 'owner': 'synthetic-owner', 'sessionId': SID,
                         'sessionGeneration': 1, 'desiredRunning': True, 'onVacation': False,
                         'runtimeRecipe': {'harness': 'synthetic', 'runtimeThreads': {}}}
        self.peer = {'id': PEER, 'owner': 'synthetic-owner', 'sessionId': PEER,
                     'sessionGeneration': 1, 'desiredRunning': True, 'onVacation': False}
        self.company()
        self.storage = storage_paths(self.config, SID)
        prepare_storage(self.config, self.storage)
        self.storage.scratch.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.service.config_path.write_text(json.dumps(self.config)); self.service.config_path.chmod(0o600)
        self.control = self.root / 'control'; self.control.mkdir(mode=0o700)
        self.operation = self.root / 'operation'; self.operation.mkdir(mode=0o700)
        self.selected = {'employeeId': EID, 'device': DEVICE, 'cdiSHA256': 'a' * 64,
                         'resourceReservations': {'directory': str(self.control), 'companyId': COMPANY,
                         'poolId': POOL, 'ownerScopeDigest': 'b' * 64, 'hostReserveMiB': 1024}, 'providerPIDs': [501]}
        self.selection_path = self.root / 'selection.json'
        self.selection_path.write_text(json.dumps(self.selected)); self.selection_path.chmod(0o600)
        self.upgrade = U.GPUUpgrade(self.service, self.operation)
        self.active = True; self.broker_generation = 1; self.failure = None; self.commands = []; self.phase = None
        self.source = NativeFixture(self.config)
        self.source.rows = [self.source.rows[1]]
        self.source.rows.append({'Id': '3' * 64, 'Name': '/selected-stopped', 'State': {'Running': False, 'Pid': 0},
                                'Config': {'Labels': {'reverie.worker': self.config['deployment'], 'reverie.session': SID}},
                                'Mounts': [], 'HostConfig': {}, 'Image': self.config['image']})
        FakeNative.rows = self.source.rows
        self.patches = [patch.object(self.service, 'run', side_effect=self.command),
                        patch.object(self.upgrade, 'native', side_effect=self.native),
                        patch.object(self.upgrade, 'manager_state', side_effect=self.manager_state),
                        patch.object(self.upgrade, 'ready_socket', return_value=None),
                        patch.object(U.P, '_process', side_effect=self.process),
                        patch.object(R, 'NativeObserver', FakeNative)]
        for p in self.patches: p.start(); self.addCleanup(p.stop)
        self.baseline_config = self.service.config_path.read_bytes()
        if os.environ.get('NIX_BUILD_TOP'):
            # These real-store/fault controls model host metadata, not native
            # root custody. Nix user namespaces can map / and /tmp to uid 65534.
            # Only those fixed roots are modeled; all private ancestor modes,
            # inodes, symlinks and replacement observations remain actual.
            original_lstat, original_fstat = Path.lstat, os.fstat
            mapped_root = original_lstat(Path('/')).st_uid
            fixed_roots = {
                (info.st_dev, info.st_ino, info.st_uid)
                for info in (original_lstat(Path('/')), original_lstat(Path('/tmp')))
                if info.st_uid == mapped_root
            }
            def host_root(info):
                if (info.st_dev, info.st_ino, info.st_uid) not in fixed_roots:
                    return info
                values = list(info); values[4] = 0
                extra = {key: getattr(info, key) for key in
                         ('st_atime_ns', 'st_mtime_ns', 'st_ctime_ns',
                          'st_blksize', 'st_blocks', 'st_rdev')}
                return os.stat_result(values, extra)
            def lstat(path, *args, **kwargs):
                info = original_lstat(path, *args, **kwargs)
                return host_root(info) if path in (Path('/'), Path('/tmp')) else info
            def fstat(fd):
                # Match the captured physical root/tmp inodes, not a guessed
                # /proc/fd pathname. Every private directory remains actual.
                return host_root(original_fstat(fd))
            self.enterContext(patch.object(Path, 'lstat', lstat))
            self.enterContext(patch.object(os, 'fstat', fstat))

    def company(self):
        Path(self.config['companyFile']).write_text(json.dumps({'employees': [self.employee, self.peer]}))

    def process(self, pid):
        if pid == 500:
            if not self.active: raise FileNotFoundError()
            return {'pid': 500, 'startTick': self.broker_generation}
        return {'pid': pid, 'startTick': 2, 'rootIdentity': [1, 2], 'namespaces': {'mnt': 1}}

    def manager_state(self, *, active):
        if active:
            self.assertTrue(self.active)
            return {'process': self.process(500), 'properties': {'MainPID': '500'}}
        self.assertFalse(self.active)
        return {'properties': {'MainPID': '0'}}

    def native(self, before, after, selection):
        if self.phase: self.phase('native')
        return {'gpu': {'currentLaptop': {'id': '3' * 64, 'devices': []}},
                'peers': [{'containerId': '2' * 64, 'pid': 124, 'process': self.process(124)}],
                'providers': [], 'inventory': copy.deepcopy(self.source.rows), 'capacity': [1, 2, {}],
                'selectedStorage': self.upgrade.storage_identities(self.storage)}

    def command(self, args, *, deadline=None):
        self.commands.append(args)
        if self.phase: self.phase(args)
        if self.failure and self.failure in args:
            raise subprocess.TimeoutExpired(args, 1)
        if args[0] == 'nix-store':
            Path(args[args.index('--add-root') + 1]).symlink_to(args[-1])
        elif args[:3] == ['systemctl', '--user', 'stop']:
            self.active = False
        elif args[:3] == ['systemctl', '--user', 'start']:
            self.active = True; self.broker_generation += 1
        return subprocess.CompletedProcess(args, 0, 'active\n' if 'is-active' in args else '', '')

    def prepare(self):
        return self.upgrade.prepare(self.selection_path)['planSHA256']

    def assert_not_attempted(self):
        self.assertFalse((self.operation / 'ATTEMPT.json').exists())
        self.assertEqual(self.service.config_path.read_bytes(), self.baseline_config)
        self.assertTrue(self.active)
        self.assertFalse(any('stop' in cmd for cmd in self.commands))

    def test_preparation_is_only_private_files_and_exact_peer_preservation(self):
        sha = self.prepare()
        self.assertEqual(len(sha), 64)
        self.assert_not_attempted()
        before = json.loads(self.baseline_config); after = json.loads((self.operation / 'candidate.json').read_bytes())
        self.assertEqual(set(after) - set(before), {'employeeGpuGrants', 'resourceReservations'})
        self.assertEqual(U.policy_digest(before, PEER), U.policy_digest(after, PEER))
        self.assertEqual(after['image'], before['image'])
        self.assertEqual((self.operation / 'config-before.raw.json').read_bytes(), self.baseline_config)
        self.assertFalse(any(self.control.iterdir()))

    def test_success_uses_real_canonical_first_provision_and_retains_consumed_attempt(self):
        result = self.upgrade.apply(self.prepare())
        self.assertTrue(result['noWakeCommand'])
        self.assertFalse(result['GPUComputeOrRenderingVerified'])
        self.assertTrue((self.operation / 'ATTEMPT.json').exists())
        self.assertTrue((self.operation / 'DONE.json').exists())
        self.assertEqual(self.service.unit.resolve(), self.service.target_unit())
        self.assertTrue(R.marker(json.loads(self.service.config_path.read_bytes())).exists())
        self.assertEqual(json.loads((self.control / 'operations/operations.json').read_bytes())['operations'], {})
        self.assertTrue(self.active)
        self.assertFalse(any('stop-laptops' in cmd or 'create' in cmd for cmd in self.commands))
        with self.assertRaisesRegex(ValueError, 'already consumed'): self.upgrade.apply(self.prepare_sha())

    def prepare_sha(self):
        return U.digest((self.operation / 'PLAN.json').read_bytes())

    def test_config_or_unit_cas_drift_refuses_before_service_stop(self):
        sha = self.prepare()
        self.service.config_path.write_bytes(self.baseline_config + b' ')
        with self.assertRaisesRegex(ValueError, 'generation changed'): self.upgrade.apply(sha)
        self.assertFalse((self.operation / 'ATTEMPT.json').exists())
        self.assertFalse(any('stop' in cmd for cmd in self.commands))

    def test_removed_or_preexisting_canonical_fence_is_never_reset(self):
        R.pending(self.config).write_text('{}'); R.pending(self.config).chmod(0o600)
        with self.assertRaises(ValueError): self.prepare()
        self.assert_not_attempted()
        self.assertTrue(R.pending(self.config).exists())

    def test_foreign_unit_template_never_reaches_manager(self):
        self.old.chmod(0o644); self.old.write_text(self.old.read_text() + 'ExecStartPost=/unsafe\n')
        with self.assertRaisesRegex(ValueError, 'template'): self.prepare()
        self.assert_not_attempted()

    def test_unsafe_private_unit_ancestor_still_refuses_before_attempt(self):
        self.service.unit.parent.chmod(0o777)
        try:
            with self.assertRaisesRegex(ValueError, 'Unsafe unit directory ancestor'):
                self.prepare()
            self.assert_not_attempted()
        finally:
            self.service.unit.parent.chmod(0o755)

    def test_fixture_fd_metadata_models_only_fixed_root_inodes(self):
        for path in (Path('/'), Path('/tmp'), self.operation):
            with self.subTest(path=path):
                fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    actual, by_name, by_fd = path.stat(), path.lstat(), os.fstat(fd)
                    self.assertEqual((by_fd.st_dev, by_fd.st_ino, by_fd.st_mode),
                                     (actual.st_dev, actual.st_ino, actual.st_mode))
                    self.assertEqual(by_name.st_uid, by_fd.st_uid)
                    self.assertEqual((by_fd.st_mtime_ns, by_fd.st_ctime_ns),
                                     (actual.st_mtime_ns, actual.st_ctime_ns))
                    if path == self.operation:
                        self.assertEqual(by_fd, actual)
                    elif (os.environ.get('NIX_BUILD_TOP') and
                          actual.st_uid == Path('/').stat().st_uid):
                        self.assertEqual(by_fd.st_uid, 0)
                    else:
                        # A private user-owned TMP is not one of the captured
                        # mapped root-UID inodes and must remain unmodified.
                        self.assertEqual(by_fd.st_uid, actual.st_uid)
                finally:
                    os.close(fd)

    def test_owner_vacation_refuses_before_attempt_even_when_stopped_off(self):
        self.employee['desiredRunning'] = False; self.employee['onVacation'] = True; self.company()
        with self.assertRaisesRegex(ValueError, 'vacation intent'): self.prepare()
        self.assert_not_attempted()

    def test_timeout_after_stop_retains_all_backups_and_never_rolls_back_or_replays(self):
        sha = self.prepare(); self.failure = 'stop'
        with self.assertRaises(subprocess.TimeoutExpired): self.upgrade.apply(sha)
        self.assertTrue((self.operation / 'ATTEMPT.json').exists())
        self.assertFalse((self.operation / 'DONE.json').exists())
        self.assertEqual(self.service.config_path.read_bytes(), self.baseline_config)
        self.assertTrue((self.operation / 'old-generation').is_symlink())
        with self.assertRaisesRegex(ValueError, 'already consumed'): self.upgrade.apply(sha)

    def test_post_config_provision_failure_keeps_new_config_unknown_and_does_not_start(self):
        sha = self.prepare()
        with patch.object(R, 'provision', side_effect=OSError('owned injected failure')):
            with self.assertRaises(OSError): self.upgrade.apply(sha)
        self.assertNotEqual(self.service.config_path.read_bytes(), self.baseline_config)
        self.assertFalse(self.active)
        self.assertFalse((self.operation / 'DONE.json').exists())
        self.assertTrue((self.operation / 'CONFIG-COMMIT-INTENT.json').exists())
        self.assertFalse(any('start' in cmd for cmd in self.commands))

    def test_owner_intent_drift_during_broker_stop_prevents_config_commit(self):
        sha = self.prepare()
        def mutate(stage):
            if type(stage) is list and 'stop' in stage:
                self.employee['onVacation'] = True; self.company()
        self.phase = mutate
        with self.assertRaisesRegex(ValueError, 'intent changed before CAS'): self.upgrade.apply(sha)
        self.assertEqual(self.service.config_path.read_bytes(), self.baseline_config)
        self.assertTrue((self.operation / 'ATTEMPT.json').exists())
        self.assertFalse(self.active)

    def test_real_native_composition_brackets_capacity_and_provider_namespace(self):
        selected = copy.deepcopy(self.selected); selected['providerPIDs'] = [os.getpid()]
        after, _ = self.upgrade.candidate(self.config, selected)
        report = {'employee': U.P.binding(self.config, EID), 'ownerIntentAllowsStart': True,
                  'currentLaptop': {'running': False}}
        with patch.object(U.P, 'check', return_value=report):
            facts = U.GPUUpgrade.native(self.upgrade, self.config, after, selected)
            self.assertEqual(facts['providers'][0]['pid'], os.getpid())
            capacity = FakeNative.capacity
            def late_peer(native, rows, option):
                result = capacity(native, rows, option)
                FakeNative.rows = copy.deepcopy(FakeNative.rows)
                FakeNative.rows.append(copy.deepcopy(FakeNative.rows[0]))
                return result
            with patch.object(FakeNative, 'capacity', late_peer), self.assertRaisesRegex(ValueError, 'inventory changed'):
                U.GPUUpgrade.native(self.upgrade, self.config, after, selected)

    def test_selected_provider_must_already_have_exited_and_capacity_is_not_a_permit(self):
        after, _ = self.upgrade.candidate(self.config, self.selected)
        report = {'ownerIntentAllowsStart': True, 'currentLaptop': {'running': True}}
        with patch.object(U.P, 'check', return_value=report), self.assertRaisesRegex(ValueError, 'already have handed off'):
            U.GPUUpgrade.native(self.upgrade, self.config, after, self.selected)
        self.assert_not_attempted()

    def test_char_device_readback_uses_real_owned_process_namespace_without_compute(self):
        observed = self.upgrade.device_nodes(os.getpid(), ['/dev/null'])
        self.assertEqual(observed['/dev/null'], [os.major(Path('/dev/null').stat().st_rdev), os.minor(Path('/dev/null').stat().st_rdev)])
        with self.assertRaises(ValueError): self.upgrade.device_nodes(os.getpid(), ['/dev/../etc/passwd'])

    def activate_on_normal_start(self, wrong_device=False):
        original = self.command
        def command(args, *, deadline=None):
            result = original(args, deadline=deadline)
            if args[:3] == ['systemctl', '--user', 'start']:
                row = copy.deepcopy(self.source.rows[-1]); row['Id'] = '4' * 64
                row['State'] = {'Running': True, 'Pid': os.getpid()}
                self.source.rows[-1] = row
                self.employee['runtimeRecipe']['runtimeThreads'] = {'fixture': 'new-normal-thread'}; self.company()
            return result
        self.service.run.side_effect = command
        def check(config, employee, device, **kwargs):
            return {'currentLaptop': {'id': '4' * 64, 'running': True, 'oomKilled': False,
                    'image': config['image'], 'process': {'pid': os.getpid()},
                    'cdiDevices': ['wrong-device'] if wrong_device else [device], 'deviceRequests': None, 'devices': []},
                    'physicalGPU': {'uuid': 'synthetic-physical'}, 'cdi': {'deviceNodePaths': ['/dev/null']}}
        return patch.object(U.P, 'check', side_effect=check)

    def test_observed_normal_owner_activation_preserves_identity_and_allows_thread_only_update(self):
        sha = self.prepare()
        with self.activate_on_normal_start(): result = self.upgrade.apply(sha)
        self.assertTrue(result['nativeSelectedCDIBindingVerified'])
        self.assertTrue(result['noWakeCommand'])
        self.assertFalse(result['GPUComputeOrRenderingVerified'])
        self.assertEqual(result['selectedNormalActivation']['laptop']['id'], '4' * 64)
        self.assertEqual(self.employee['sessionId'], SID)

    def test_wrong_device_after_normal_reconnect_remains_unknown_without_rollback(self):
        sha = self.prepare()
        with self.activate_on_normal_start(wrong_device=True), self.assertRaisesRegex(ValueError, 'device authority differs'):
            self.upgrade.apply(sha)
        self.assertTrue((self.operation / 'ATTEMPT.json').exists())
        self.assertFalse((self.operation / 'DONE.json').exists())
        self.assertTrue(self.active)
        self.assertNotEqual(self.service.config_path.read_bytes(), self.baseline_config)

    def test_durable_commit_intent_callback_cannot_overwrite_a_new_owner_config(self):
        sha = self.prepare(); original = U.exclusive
        def late(path, raw):
            original(path, raw)
            if path.name == 'CONFIG-COMMIT-INTENT.json':
                cfg = json.loads(self.service.config_path.read_bytes()); cfg['maxWorkers'] += 1
                self.service.config_path.write_bytes(U.encoded(cfg))
        with patch.object(U, 'exclusive', side_effect=late), self.assertRaisesRegex(ValueError, 'after commit intent'):
            self.upgrade.apply(sha)
        self.assertEqual(json.loads(self.service.config_path.read_bytes())['maxWorkers'], self.config['maxWorkers'] + 1)
        self.assertFalse(any('start' in cmd for cmd in self.commands))
        self.assertTrue((self.operation / 'ATTEMPT.json').exists())
        self.assertFalse((self.operation / 'DONE.json').exists())

    def test_final_admission_failure_never_publishes_success_or_rolls_back_new_state(self):
        from contextlib import contextmanager
        original = R.ReservationGate.admission
        @contextmanager
        def failed_exit(gate, *args, **kwargs):
            with original(gate, *args, **kwargs): yield
            raise OSError('owned finalizer failure')
        sha = self.prepare()
        with patch.object(R.ReservationGate, 'admission', failed_exit), self.assertRaises(OSError):
            self.upgrade.apply(sha)
        self.assertTrue(self.active)
        self.assertNotEqual(self.service.config_path.read_bytes(), self.baseline_config)
        self.assertTrue((self.operation / 'ATTEMPT.json').exists())
        self.assertFalse((self.operation / 'DONE.json').exists())

    def test_real_owned_listener_requires_actual_peer_pid_not_same_uid_or_socket_name(self):
        path = self.root / 'ready.sock'
        with socket.socket(socket.AF_UNIX) as server:
            server.bind(str(path)); path.chmod(0o600); server.listen(2)
            def accept():
                for _ in range(2):
                    client, _ = server.accept(); client.close()
            thread = threading.Thread(target=accept); thread.start()
            try:
                U.GPUUpgrade.ready_socket(self.upgrade, path, os.getpid())
                with self.assertRaisesRegex(ValueError, 'not the selected'):
                    U.GPUUpgrade.ready_socket(self.upgrade, path, os.getpid() + 1)
            finally:
                thread.join(2)
                self.assertFalse(thread.is_alive())

    def test_stopped_off_employee_can_upgrade_without_changing_intent_or_granting_start(self):
        self.employee['desiredRunning'] = False; self.company()
        before = Path(self.config['companyFile']).read_bytes()
        result = self.upgrade.apply(self.prepare())
        self.assertIsNone(result['selectedNormalActivation'])
        self.assertTrue(result['noWakeCommand'])
        self.assertEqual(Path(self.config['companyFile']).read_bytes(), before)
        after = json.loads(self.service.config_path.read_bytes())
        self.assertEqual(after['employeeGpuGrants'], {EID: DEVICE})
        self.assertFalse(storage_start_allowed(after, storage_paths(after, SID)))
        broker = Broker.__new__(Broker); broker.config = after
        self.assertFalse(broker.allowed(SID))
        self.assertFalse(any('create' in cmd or 'stop-laptops' in cmd or 'wake' in cmd for cmd in self.commands))

    def test_off_employee_unexpected_native_start_is_never_claimed_as_activation(self):
        self.employee['desiredRunning'] = False; self.company(); sha = self.prepare()
        with self.activate_on_normal_start(), self.assertRaisesRegex(ValueError, 'OFF or vacation'):
            self.upgrade.apply(sha)
        self.assertFalse((self.operation / 'DONE.json').exists())
        self.assertTrue((self.operation / 'ATTEMPT.json').exists())
        self.assertFalse(self.employee['desiredRunning'])

    def test_private_input_cpu_and_command_fields_are_not_an_execution_api(self):
        for values in ([True], [1, 1], [{}]):
            with self.subTest(values=values):
                selection = copy.deepcopy(self.selected); selection['providerPIDs'] = values
                self.selection_path.write_text(json.dumps(selection))
                with self.assertRaises(ValueError): self.upgrade.selection(self.selection_path)
        self.selection_path.write_text(json.dumps({**self.selected, 'command': 'forbidden'}))
        with self.assertRaisesRegex(ValueError, 'Closed'): self.upgrade.selection(self.selection_path)


if __name__ == '__main__': unittest.main()
