"""Real private R files/locks, fixed metadata ports; never an engine/service."""
import copy
import json
import os
from pathlib import Path
import re
import subprocess
import unittest
from unittest.mock import patch

from reverie import worker_resource_reservations as R
from reverie import worker_service as S
from reverie import worker_image_switch as I
from reverie.worker import Broker
from tests import test_worker_resource_reservations as F

NEW = 'sha256:' + 'b' * 64


class _Fixture(unittest.TestCase):
    def setUp(self):
        # Set the class-level backstop before ANY fake broker/gate construction.
        forbid = patch.object(Broker, 'run_engine', side_effect=AssertionError('REAL_ENGINE_FORBIDDEN'))
        forbid.start(); self.addCleanup(forbid.stop)
        f = F.Reservations(); f.setUp(); self.addCleanup(f.doCleanups)
        self.f, self.root = f, f.root
        self.path = self.root / 'broker.json'
        self.path.write_text(json.dumps(f.config)); self.path.chmod(0o600)
        f.native.config_file = self.path
        self.calls = []
        self.service = S.WorkerService(self.path, home=self.root / 'owner', run=self.metadata_run)

    def metadata_run(self, args, *, deadline=None):
        self.calls.append(args)
        if args[:3] == ['docker', 'context', 'inspect']:
            out = json.dumps('unix:///synthetic/docker.sock')
        elif args == ['docker', 'info', '--format', '{{json .}}']:
            out = json.dumps({'OSType': 'linux', 'KernelVersion': os.uname().release,
                'CgroupVersion': '2', 'MemoryLimit': True, 'SwapLimit': True,
                'PidsLimit': True, 'MemTotal': 16 << 30})
        elif args[:3] == ['systemctl', '--user', 'is-active']:
            out = ''
        elif args[0] == 'docker' and args[1] in ('ps', 'inspect'):
            return self.f.native.run_engine(args[1:], deadline=deadline)
        else:
            raise AssertionError('No service/engine effect port: ' + str(args[:3]))
        return subprocess.CompletedProcess(args, 0, out, '')

    def fence(self):
        p = R.pending(self.f.config)
        p.write_text(json.dumps({'schema': I.PURPOSE, 'state': 'UNKNOWN'})); p.chmod(0o600)
        return p

    def switch_fixture_config(self):
        value = copy.deepcopy(self.f.config); value['image'] = NEW
        temporary = self.path.with_suffix('.next')
        temporary.write_text(json.dumps(value)); temporary.chmod(0o600)
        os.replace(temporary, self.path)


class StartupFences(_Fixture):
    def test_actual_registration_refuses_old_installed_generation_before_unit_consumers(self):
        operation = self.root / 'generation-check'; operation.mkdir(mode=0o700)
        old = self.root / 'old-immutable-unit'; old.write_text('old selected metadata fixture')
        new = self.root / 'new-immutable-unit'; new.write_text('new package metadata fixture')
        for p in (self.service.unit, self.service.gcroot):
            p.parent.mkdir(mode=0o700, parents=True, exist_ok=True); p.symlink_to(old)
        before = self.path.read_bytes()
        caller = I.WorkerImageSwitch(self.service, operation)
        with patch.object(self.service, 'target_unit', return_value=new), \
             patch('reverie.worker_service_upgrade.unit_record', side_effect=AssertionError('NO_OLD_UNIT_ACCEPTANCE')):
            with self.assertRaisesRegex(ValueError, 'WORKER_IMAGE_MATCHING_GENERATION_REQUIRED'):
                caller._registration()
        self.assertEqual(self.service.unit.resolve(), old)
        self.assertEqual(self.path.read_bytes(), before); self.assertEqual(self.calls, [])

    def test_maintenance_diagnostics_admit_only_fixed_codes_never_private_error_text(self):
        self.assertEqual(S._diagnostic(ValueError('WORKER_IMAGE_CONFIGURATION_STALE'))['reason'],
                         'WORKER_IMAGE_CONFIGURATION_STALE')
        private = 'WORKER_IMAGE_CONFIGURATION_STALE: synthetic private value'
        result = S._diagnostic(ValueError(private))
        self.assertNotIn(private, json.dumps(result))
        self.assertEqual(result['reason'], 'Unlisted exception details withheld.')

    def test_private_owner_json_is_not_immutable_factory_qualification(self):
        import hashlib
        operation = self.root / 'unqualified'; operation.mkdir(mode=0o700)
        profile = self.root / 'claimed-profile.json'
        raw = b'{"owner":true,"purpose":"worker-image-provenance-v1"}'
        profile.write_bytes(raw); profile.chmod(0o600)
        caller = I.WorkerImageSwitch(self.service, operation)
        with self.assertRaisesRegex(ValueError, 'immutable Nix'):
            caller._profile({'profile': {'path': str(profile), 'sha256': hashlib.sha256(raw).hexdigest()},
                             'oldImage': self.f.config['image'], 'newImage': NEW}, self.f.config)
        self.assertEqual(self.calls, [])

    def test_service_start_refuses_durable_fence_before_manager_start(self):
        self.fence()
        with self.assertRaisesRegex(ValueError, 'RECONCILIATION'):
            self.service.action('start')
        self.assertFalse(any(args[:3] == ['systemctl', '--user', 'start'] for args in self.calls))

    def test_actual_unit_precheck_backend_dispatch_refuses_fence(self):
        root = Path(__file__).parents[1]
        flake = (root / 'flake.nix').read_text()
        self.assertRegex(flake, r'nativeWorkerPackages = import ./nix/native-worker-packages\.nix \{\s*'
                               r'inherit pkgs; src = source; inherit \(packages\) console;\s*\};')
        self.assertIn('in packages // nativeWorkerPackages // {', flake)
        factory = (root / 'nix/native-worker-packages.nix').read_text()
        self.assertIn('worker_service.py', factory)
        self.assertRegex(factory, r'worker_service[^\n]*"\$@" check-backend')
        self.assertIn('ExecStartPre=${workerServiceCheck}', factory)
        self.fence()
        original = S.WorkerService.__init__
        fixture = self
        def constructor(service, config, **_kwargs):
            original(service, config, home=fixture.service.home, run=fixture.metadata_run)
        with patch.object(S.WorkerService, '__init__', constructor):
            self.assertEqual(S.main(['--config', str(self.path), 'check-backend']), 1)
        self.assertFalse(any(args[:3] == ['systemctl', '--user', 'start'] for args in self.calls))

    def test_broker_captured_before_fence_refuses_recover_while_fenced(self):
        broker = Broker(copy.deepcopy(self.f.config), config_file=self.path)
        broker.run_engine = self.f.native.run_engine
        fence = self.fence()
        with patch.object(broker, '_recover_laptops', side_effect=AssertionError('NO_RECOVERY_EFFECT')):
            with self.assertRaisesRegex(ValueError, 'RECONCILIATION'):
                broker.recover()
        self.assertTrue(fence.exists())

    def test_old_config_broker_resumed_after_fence_removal_cannot_recover(self):
        broker = Broker(copy.deepcopy(self.f.config), config_file=self.path)
        broker.run_engine = self.f.native.run_engine
        fence = self.fence(); self.switch_fixture_config(); fence.unlink()
        with patch.object(broker, '_recover_laptops', side_effect=AssertionError('NO_RECOVERY_EFFECT')):
            with self.assertRaisesRegex(ValueError, 'WORKER_IMAGE_CONFIGURATION_STALE'):
                broker.recover()
        self.assertFalse(Path(self.f.config['socket']).exists())

    def test_stale_service_config_loaded_before_fence_is_refused_after_removal(self):
        stale = copy.deepcopy(self.f.config)
        fence = self.fence(); self.switch_fixture_config(); fence.unlink()
        with patch.object(S, 'load_config', return_value=stale):
            with self.assertRaisesRegex(ValueError, 'WORKER_IMAGE_CONFIGURATION_STALE'):
                self.service.action('start')
        self.assertFalse(any(args[:3] == ['systemctl', '--user', 'start'] for args in self.calls))

    def test_actual_broker_serve_stale_config_refuses_before_supervisor_or_listener(self):
        broker = Broker(copy.deepcopy(self.f.config), config_file=self.path)
        broker.run_engine = self.f.native.run_engine
        fence = self.fence(); self.switch_fixture_config(); fence.unlink()
        with patch.object(broker, 'check_pool', return_value=None), \
             patch('threading.Thread.start', side_effect=AssertionError('NO_SUPERVISOR_EFFECT')):
            with self.assertRaisesRegex(ValueError, 'WORKER_IMAGE_CONFIGURATION_STALE'):
                broker.serve()
        self.assertFalse(Path(self.f.config['socket']).exists())

    def test_changed_config_during_last_native_producer_refuses_stat_bracket(self):
        gate = R.ReservationGate(self.f.native)
        custody = gate.native.custody
        def changed(*args, **kwargs):
            rows = custody(*args, **kwargs); self.switch_fixture_config(); return rows
        with patch.object(gate.native, 'custody', side_effect=changed):
            with self.assertRaisesRegex(ValueError, 'WORKER_IMAGE_CONFIGURATION_CHANGED'):
                with gate.admission():
                    self.fail('Changed configuration must refuse before entering')

    def test_fifo_replacement_is_nonblocking_and_never_consumed_as_configuration(self):
        original = os.open
        def replace(path, flags, *args, **kwargs):
            if Path(path) == self.path:
                self.assertTrue(flags & os.O_NONBLOCK)
                self.path.unlink(); os.mkfifo(self.path, 0o600)
            return original(path, flags, *args, **kwargs)
        with patch.object(I.os, 'open', side_effect=replace):
            with self.assertRaisesRegex(ValueError, 'WORKER_IMAGE_CONFIGURATION_CUSTODY'):
                I.capture_current_image(self.f.native)


class TransactionFiles(_Fixture):
    def setUp(self):
        super().setUp()
        from reverie.worker_image import SHOW_ARGS, INSPECT_FORMAT
        from tests.test_resource_actor_install import model_nix_fixture_ancestry
        self.show, self.inspect_format = SHOW_ARGS, INSPECT_FORMAT
        self.context = patch.dict(os.environ, {'DOCKER_HOST': '', 'DOCKER_CONTEXT': ''})
        self.context.start(); self.addCleanup(self.context.stop)
        self.f.native.rows[0]['State'] = {'Running': False, 'Pid': 0}
        self.operation = self.root / 'image-switch'; self.operation.mkdir(mode=0o700)
        self.deployment = self.root / 'deployment.json'
        self.deployment.write_text(json.dumps({'version': 1, 'containerName': self.f.config['serverContainer'],
                                             'companyRoot': self.f.config['companyRoot']}))
        self.deployment.chmod(0o600)
        lockdir = self.root / 'runtime/update-state'; lockdir.mkdir(mode=0o700, parents=True)
        self.lock = lockdir / 'update.lock'; self.lock.touch(mode=0o600)
        self.selection = self.root / 'image-selection.json'
        self.selection.write_text(json.dumps({'oldImage': self.f.config['image'], 'newImage': NEW,
            'deploymentPath': str(self.deployment), 'profile': {'path': '/nix/store/fixture/profile.json', 'sha256': '1' * 64}}))
        self.selection.chmod(0o600)
        self.before = self.path.read_bytes()
        self.manager_queued = False
        self.marker = R.marker(self.f.config).read_bytes()
        self.service.run = self.image_metadata
        self.transition = I.WorkerImageSwitch(self.service, self.operation)
        # These two *fixed producer ports* isolate transaction/finalizer tests.
        # They are not a production qualification callback or native acceptance.
        registration = patch.object(I.WorkerImageSwitch, '_registration', return_value={'ownedRegistrationPort': True})
        profile = patch.object(I.WorkerImageSwitch, '_profile', return_value={'controlledImageMetadataPort': True})
        registration.start(); profile.start(); self.addCleanup(registration.stop); self.addCleanup(profile.stop)
        if os.environ.get('NIX_BUILD_TOP') and Path('/').stat().st_uid == 65534:
            model_nix_fixture_ancestry(self)

    def image_metadata(self, args, *, deadline=None):
        self.calls.append(args)
        if args == self.show:
            state = {'Id': S.UNIT, 'LoadState': 'loaded', 'ActiveState': 'activating' if self.manager_queued else 'inactive',
                     'SubState': 'start-pre' if self.manager_queued else 'dead',
                     'MainPID': '0', 'ControlPID': '0', 'Job': '321' if self.manager_queued else ''}
            out = ''.join(k + '=' + v + '\n' for k, v in state.items())
        elif args[:3] == ['docker', 'context', 'inspect']:
            out = json.dumps('unix:///synthetic/docker.sock')
        elif args[:3] == ['docker', '--host', 'unix:///synthetic/docker.sock']:
            tail = args[3:]
            if tail == ['info', '--format', '{{json .}}']:
                out = json.dumps({'ID': 'owned-engine', 'OSType': 'linux',
                                  'KernelVersion': os.uname().release, 'Name': 'fixture'})
            elif tail[:4] == ['image', 'inspect', '--format', '{{json .Id}}']:
                self.assertIn(tail[-1], (self.f.config['image'], NEW)); out = json.dumps(tail[-1])
            elif tail == ['ps', '--all', '--no-trunc', '--format', '{{.ID}}']:
                out = '\n'.join(row['Id'] for row in self.f.native.rows)
            elif tail[:3] == ['inspect', '--format', self.inspect_format]:
                selected = set(tail[3:])
                out = '\n'.join(json.dumps({'id': row['Id'], 'name': row['Name'],
                    'labels': row['Config']['Labels'], 'running': row['State']['Running'],
                    'paused': False, 'restarting': False, 'pid': row['State']['Pid'],
                    'status': 'running' if row['State']['Running'] else 'exited', 'mounts': row['Mounts']})
                    for row in self.f.native.rows if row['Id'] in selected)
            else: raise AssertionError('NO_ENGINE_EFFECT_PORT: ' + str(tail[:2]))
        elif args[0] == 'docker' and args[1] in ('ps', 'inspect'):
            return self.f.native.run_engine(args[1:], deadline=deadline)
        else: raise AssertionError('NO_ENGINE_OR_SERVICE_EFFECT_PORT: ' + str(args[:3]))
        return subprocess.CompletedProcess(args, 0, out, '')

    def prepare(self):
        return self.transition.prepare(self.selection)['planSHA256']

    def assert_retained(self):
        self.assertTrue(R.pending(self.f.config).exists())
        self.assertEqual(R.marker(self.f.config).read_bytes(), self.marker)

    def test_preview_no_hold_apply_changes_only_image_no_lifecycle(self):
        expected = self.prepare()
        self.assertFalse(R.pending(self.f.config).exists())
        result = self.transition.apply(expected)
        self.assertEqual(result['state'], 'IMAGE_PIN_COMMITTED')
        self.assertFalse(result['started']); self.assertFalse(result['fleetRecreated'])
        self.assertFalse(R.pending(self.f.config).exists())
        self.assertEqual(self.path.read_bytes(), self.before.replace(self.f.config['image'].encode(), NEW.encode(), 1))
        self.assertEqual(R.marker(self.f.config).read_bytes(), self.marker)
        self.assertFalse(any(any(word in args for word in ('start', 'stop', 'pull', 'load', 'create', 'restart'))
                             for args in self.calls))
        with self.assertRaisesRegex(ValueError, 'ATTEMPT_USED'):
            self.transition.apply(expected)

    def test_commit_ack_loss_keeps_unknown_and_cold_start_refuses(self):
        expected = self.prepare(); original = I.exclusive
        def fail_result(path, raw):
            if Path(path).name == 'RESULT.json': raise OSError('owned receipt fault')
            return original(path, raw)
        with patch.object(I, 'exclusive', side_effect=fail_result):
            with self.assertRaisesRegex(RuntimeError, 'RECONCILIATION_REQUIRED'):
                self.transition.apply(expected)
        self.assert_retained(); self.assertEqual(json.loads(self.path.read_bytes())['image'], NEW)
        with self.assertRaisesRegex(ValueError, 'RECONCILIATION'):
            R.ReservationGate(self.f.native)

    def test_final_result_callback_inserting_foreign_fence_is_preserved(self):
        expected = self.prepare(); original = I.exclusive
        def change(path, raw):
            result = original(path, raw)
            if Path(path).name == 'RESULT.json':
                R.pending(self.f.config).write_text('{"foreign":true}\n')
            return result
        with patch.object(I, 'exclusive', side_effect=change):
            with self.assertRaisesRegex(RuntimeError, 'RECONCILIATION_REQUIRED'):
                self.transition.apply(expected)
        self.assertEqual(json.loads(R.pending(self.f.config).read_bytes()), {'foreign': True})

    def test_changed_preview_config_refuses_without_fence_or_publication(self):
        expected = self.prepare(); self.switch_fixture_config()
        with self.assertRaises(ValueError): self.transition.apply(expected)
        self.assertFalse(R.pending(self.f.config).exists())
        self.assertFalse((self.operation / 'ATTEMPT.json').exists())

    def test_already_queued_start_after_precheck_fences_before_image_cas(self):
        expected = self.prepare(); original = I._publish_fence
        def queued(gate, value):
            result = original(gate, value)
            self.manager_queued = True
            return result
        with patch.object(I, '_publish_fence', side_effect=queued):
            with self.assertRaisesRegex(RuntimeError, 'RECONCILIATION_REQUIRED'):
                self.transition.apply(expected)
        self.assert_retained(); self.assertEqual(self.path.read_bytes(), self.before)

    def test_replacement_after_fence_writer_returns_is_not_adopted_by_transition(self):
        expected = self.prepare(); original = I._publish_fence
        def change(gate, value):
            result = original(gate, value)
            path = R.pending(self.f.config)
            path.unlink(); path.write_text('{"foreign":true}\n'); path.chmod(0o600)
            return result
        with patch.object(I, '_publish_fence', side_effect=change):
            with self.assertRaisesRegex(RuntimeError, 'RECONCILIATION_REQUIRED'):
                self.transition.apply(expected)
        self.assertEqual(self.path.read_bytes(), self.before)
        self.assertEqual(json.loads(R.pending(self.f.config).read_bytes()), {'foreign': True})

    def test_unknown_host_job_blocks_preview_without_clearing_it(self):
        from reverie.worker_host_job import NAME
        path = self.f.control / 'operations' / NAME
        raw = b'{"state":"UNKNOWN"}'
        path.write_bytes(raw); path.chmod(0o600)
        with self.assertRaisesRegex(ValueError, 'HOST_JOB_OUTCOME'):
            self.prepare()
        self.assertEqual(path.read_bytes(), raw)
        self.assertEqual(self.path.read_bytes(), self.before)
        self.assertFalse(R.pending(self.f.config).exists())

    def test_retained_actual_journal_claim_blocks_preview_without_credit(self):
        row = self.f.native.rows[0]; row['State'] = {'Running': True, 'Pid': 123}
        self.f.claim()
        row['State'] = {'Running': False, 'Pid': 0}
        path = self.f.control / 'operations/operations.json'; before = path.read_bytes()
        with self.assertRaisesRegex(ValueError, 'WORKER_IMAGE_RETAINED_WORK'):
            self.prepare()
        self.assertEqual(path.read_bytes(), before)
        self.assertFalse(R.pending(self.f.config).exists())

    def test_existing_other_maintenance_ofd_blocks_preview(self):
        import fcntl
        descriptor = os.open(self.lock, os.O_RDWR)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError): self.prepare()
        finally: os.close(descriptor)
        self.assertEqual(self.path.read_bytes(), self.before)
        self.assertFalse(R.pending(self.f.config).exists())

    def test_lock_replacement_between_named_capture_and_open_never_changes_lock_domain(self):
        import fcntl
        held = os.open(self.lock, os.O_RDWR); original = os.open; changed = []
        old = self.lock.with_name('held-original-lock')
        def replace(path, flags, *args, **kwargs):
            if Path(path) == self.lock and not changed:
                changed.append(True); self.lock.rename(old)
                created = original(self.lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                os.close(created)
            return original(path, flags, *args, **kwargs)
        try:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with patch.object(I.os, 'open', side_effect=replace):
                with self.assertRaisesRegex(ValueError, 'MAINTENANCE_LOCK_CHANGED'):
                    self.prepare()
            other = original(old, os.O_RDWR)
            try:
                with self.assertRaises(BlockingIOError): fcntl.flock(other, fcntl.LOCK_EX | fcntl.LOCK_NB)
            finally: os.close(other)
        finally: os.close(held)
        self.assertEqual(changed, [True]); self.assertEqual(self.calls, [])
        self.assertEqual(self.path.read_bytes(), self.before)
        self.assertFalse(R.pending(self.f.config).exists())

    def test_actual_cross_process_flock_and_forked_transition_cannot_bypass(self):
        import fcntl
        expected = self.prepare(); original = self.transition._verify; observed = []
        def verify(gate, *args, **kwargs):
            result = original(gate, *args, **kwargs)
            if kwargs.get('held', True) and not observed:
                read, write = os.pipe(); pid = os.fork()
                if pid == 0:
                    try:
                        os.close(read)
                        own = I.owns_pending(gate)
                        fd = os.open(gate.root / 'admission.lock', os.O_RDWR)
                        try:
                            try: fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB); blocked = False
                            except BlockingIOError: blocked = True
                        finally: os.close(fd)
                        os.write(write, json.dumps({'owns': own, 'blocked': blocked}).encode())
                    finally: os._exit(0)
                os.close(write)
                try: data = os.read(read, 1024)
                finally: os.close(read); _, status = os.waitpid(pid, 0)
                self.assertEqual(status, 0); observed.append(json.loads(data))
            return result
        with patch.object(self.transition, '_verify', side_effect=verify):
            self.transition.apply(expected)
        self.assertEqual(observed, [{'owns': False, 'blocked': True}])


class LoadedManagerRegistration(_Fixture):
    @staticmethod
    def command(path, *, argv=None, ignore='no'):
        return ('{ path=' + path + ' ; argv[]=' + (argv or path + ' --config ${REVERIE_WORKER_CONFIG}') +
                ' ; ignore_errors=' + ignore + ' ; start_time=[Wed 2026-01-01 00:00:00 UTC]' +
                ' ; stop_time=[n/a] ; pid=123 ; code=exited ; status=0/0 }')

    def setUp(self):
        super().setUp()
        self.operation = self.root / 'loaded-unit-check'; self.operation.mkdir(mode=0o700)
        self.unitroot = self.root / 'selected-package'
        self.target = self.unitroot / 'share/systemd/user' / S.UNIT
        self.target.parent.mkdir(parents=True, mode=0o700); self.target.write_text('fixed immutable-unit metadata port')
        for path, to in ((self.service.unit, self.target), (self.service.gcroot, self.unitroot)):
            path.parent.mkdir(mode=0o700, parents=True, exist_ok=True); path.symlink_to(to)
        self.service.environment.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.service.environment.write_text(S.environment_selection(self.path)); self.service.environment.chmod(0o600)
        self.programs = {'ExecStartPre': '/nix/store/' + '1' * 32 + '-check/bin/reverie-worker-service-check',
                         'ExecStart': '/nix/store/' + '2' * 32 + '-broker/bin/reverie-worker-broker'}
        self.selected = {'root': str(self.unitroot), 'path': str(self.target),
                         'entries': {name: {'path': value} for name, value in self.programs.items()}}
        self.properties = {'Id': S.UNIT, 'LoadState': 'loaded', 'ActiveState': 'inactive', 'SubState': 'dead',
                           'MainPID': '0', 'ControlPID': '0', 'Job': '', 'FragmentPath': str(self.service.unit),
                           'DropInPaths': '', 'NeedDaemonReload': 'no',
                           **{name: self.command(program) for name, program in self.programs.items()}}
        self.mutate = None
        self.service.run = self.manager_metadata
        target = patch.object(self.service, 'target_unit', return_value=self.target)
        unit = patch('reverie.worker_service_upgrade.unit_record', return_value=self.selected)
        target.start(); unit.start(); self.addCleanup(target.stop); self.addCleanup(unit.stop)
        self.caller = I.WorkerImageSwitch(self.service, self.operation)

    def manager_metadata(self, args, *, deadline=None):
        self.assertEqual(args, ['systemctl', '--user', 'show', S.UNIT, '--all', '--no-pager',
                                '--property=' + ','.join(I.MANAGER_FIELDS)])
        self.calls.append(args)
        raw = ''.join(name + '=' + value + '\n' for name, value in self.properties.items())
        if self.mutate: self.mutate()
        return subprocess.CompletedProcess(args, 0, raw, '')

    def test_actual_registration_binds_loaded_programs_and_closed_argv(self):
        result = self.caller._registration()
        self.assertEqual(set(result['manager']['programs']), {'ExecStartPre', 'ExecStart'})
        for name, value in self.programs.items():
            self.assertEqual(result['manager']['programs'][name]['argv'],
                             [value, '--config', '${REVERIE_WORKER_CONFIG}'])
        self.assertEqual(len(self.calls), 1)

    def test_cache_reload_dropins_native_activity_and_foreign_fragment_refuse(self):
        baseline = dict(self.properties); before = self.path.read_bytes()
        for key, value in [('NeedDaemonReload', 'yes'), ('DropInPaths', '/owned/foreign.conf'),
                           ('FragmentPath', '/foreign/old.service'), ('ActiveState', 'activating'),
                           ('LoadState', 'not-found'), ('MainPID', '123'), ('ControlPID', '124'), ('Job', '19')]:
            with self.subTest(key=key):
                self.properties = {**baseline, key: value}
                with self.assertRaisesRegex(ValueError, 'LOADED_MANAGER_MISMATCH'):
                    self.caller._registration()
        self.assertEqual(self.path.read_bytes(), before)
        self.assertFalse(R.pending(self.f.config).exists())

    def test_stale_cached_broker_or_precheck_refuse_even_reload_says_no(self):
        before = self.path.read_bytes()
        for name in ('ExecStartPre', 'ExecStart'):
            with self.subTest(name=name):
                saved = self.properties[name]
                self.properties[name] = self.command('/nix/store/' + '3' * 32 + '-old/bin/' + Path(self.programs[name]).name)
                self.assertEqual(self.properties['NeedDaemonReload'], 'no')
                with self.assertRaisesRegex(ValueError, 'LOADED_PROGRAM_MISMATCH'):
                    self.caller._registration()
                self.properties[name] = saved
        self.assertEqual(self.path.read_bytes(), before)

    def test_changed_argv_order_extra_flags_ignore_failure_and_multiple_commands_refuse(self):
        path = self.programs['ExecStart']; original = self.properties['ExecStart']
        cases = [self.command(path, argv=path + ' ${REVERIE_WORKER_CONFIG} --config'),
                 self.command(path, argv=path + ' --config ${REVERIE_WORKER_CONFIG} --extra'),
                 self.command(path, ignore='yes'), original + ' ' + original,
                 original.replace(' ; code=exited', ' ; argv[]=' + path + ' ; code=exited')]
        for value in cases:
            with self.subTest(value=value):
                self.properties['ExecStart'] = value
                with self.assertRaisesRegex(ValueError, 'LOADED_PROGRAM_'):
                    self.caller._registration()

    def test_current_path_hidden_as_substring_of_foreign_command_is_not_accepted(self):
        path = self.programs['ExecStart']
        self.properties['ExecStart'] = self.command(path + '-foreign', argv=path + ' --config ${REVERIE_WORKER_CONFIG}')
        with self.assertRaisesRegex(ValueError, 'LOADED_PROGRAM_MISMATCH'):
            self.caller._registration()

    def test_registration_rechecks_links_after_loaded_manager_producer(self):
        before = self.path.read_bytes()
        other = self.root / 'foreign-unit'; other.write_text('owned unselected fixture')
        def change():
            self.service.unit.unlink(); self.service.unit.symlink_to(other)
        self.mutate = change
        with self.assertRaisesRegex(ValueError, 'REGISTERED_CONFIG_CHANGED'):
            self.caller._registration()
        self.assertEqual(self.service.unit.resolve(), other)
        self.assertEqual(self.path.read_bytes(), before)


    def test_bounded_manager_decoder_rejects_duplicate_missing_oversize_and_failed_reads(self):
        baseline = ''.join(k + '=' + v + '\n' for k, v in self.properties.items())
        cases = [(0, baseline + 'Id=' + S.UNIT + '\n'),
                 (0, baseline.replace('NeedDaemonReload=no\n', '')),
                 (0, 'x' * 65537), (1, baseline), (0, baseline.encode())]
        before = self.path.read_bytes()
        for code, raw in cases:
            with self.subTest(code=code, kind=type(raw).__name__, bytes=len(raw)):
                response = subprocess.CompletedProcess([], code, raw, '')
                with patch.object(self.service, 'run', return_value=response):
                    with self.assertRaisesRegex(ValueError, 'LOADED_MANAGER_ENCODING'):
                        self.caller._registration()
        self.assertEqual(self.path.read_bytes(), before)


class LoadedCacheTransactions(unittest.TestCase):
    def setUp(self):
        actual = I.WorkerImageSwitch._registration
        f = TransactionFiles('test_preview_no_hold_apply_changes_only_image_no_lifecycle')
        f.setUp(); self.addCleanup(f.doCleanups); self.tx = f
        root = f.root / 'current-loaded-package'; target = root / 'share/systemd/user' / S.UNIT
        target.parent.mkdir(mode=0o700, parents=True); target.write_text('owned fixed package metadata port')
        for path, to in ((f.service.unit, target), (f.service.gcroot, root)):
            path.parent.mkdir(mode=0o700, parents=True, exist_ok=True); path.symlink_to(to)
        f.service.environment.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        f.service.environment.write_text(S.environment_selection(f.path)); f.service.environment.chmod(0o600)
        programs = {'ExecStartPre': '/nix/store/' + '4' * 32 + '-check/bin/reverie-worker-service-check',
                    'ExecStart': '/nix/store/' + '5' * 32 + '-broker/bin/reverie-worker-broker'}
        selected = {'root': str(root), 'path': str(target),
                    'entries': {name: {'path': value} for name, value in programs.items()}}
        self.properties = {'Id': S.UNIT, 'LoadState': 'loaded', 'ActiveState': 'inactive', 'SubState': 'dead',
                           'MainPID': '0', 'ControlPID': '0', 'Job': '', 'FragmentPath': str(f.service.unit),
                           'DropInPaths': '', 'NeedDaemonReload': 'no',
                           **{name: LoadedManagerRegistration.command(path) for name, path in programs.items()}}
        for control in [patch.object(I.WorkerImageSwitch, '_registration', actual),
                        patch.object(f.service, 'target_unit', return_value=target),
                        patch('reverie.worker_service_upgrade.unit_record', return_value=selected)]:
            control.start(); self.addCleanup(control.stop)
        original = f.service.run; self.drift_after_cas = False; self.manager_reads = 0
        def metadata(args, *, deadline=None):
            if args == ['systemctl', '--user', 'show', S.UNIT, '--all', '--no-pager',
                        '--property=' + ','.join(I.MANAGER_FIELDS)]:
                self.manager_reads += 1
                if self.drift_after_cas and json.loads(f.path.read_bytes())['image'] == NEW:
                    self.properties['ExecStart'] = LoadedManagerRegistration.command(
                        '/nix/store/' + '6' * 32 + '-old/bin/reverie-worker-broker')
                return subprocess.CompletedProcess(args, 0,
                    ''.join(k + '=' + v + '\n' for k, v in self.properties.items()), '')
            return original(args, deadline=deadline)
        f.service.run = metadata

    def test_actual_registration_is_part_of_complete_controlled_image_transaction(self):
        expected = self.tx.prepare()
        result = self.tx.transition.apply(expected)
        self.assertEqual(result['state'], 'IMAGE_PIN_COMMITTED')
        self.assertGreaterEqual(self.manager_reads, 4)
        self.assertFalse(R.pending(self.tx.f.config).exists())

    def test_loaded_program_drift_after_cas_retains_fence_and_refuses_cold_start(self):
        expected = self.tx.prepare(); self.drift_after_cas = True
        with self.assertRaisesRegex(RuntimeError, 'RECONCILIATION_REQUIRED'):
            self.tx.transition.apply(expected)
        self.assertEqual(json.loads(self.tx.path.read_bytes())['image'], NEW)
        self.assertTrue(R.pending(self.tx.f.config).exists())
        self.assertFalse((self.tx.operation / 'RESULT.json').exists())
        with self.assertRaisesRegex(ValueError, 'RECONCILIATION'):
            R.ReservationGate(self.tx.f.native)
