"""Real private files/flocks; only owned synthetic engine/kernel metadata ports."""
import copy
import hashlib
import json
import multiprocessing
import os
from pathlib import Path
import socket
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

from reverie import laptop_resource_operations as J
from reverie import worker_resource_reservations as R
from reverie.employee_resource_profiles import ProfileStore
from reverie.worker import Broker, send_frame, receive_frame, create_args
from reverie.worker_resources import effective_config, policy_digest, validate_resource_reload
from tests import test_worker as fixture
SID = fixture.SID

EID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
TARGET = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
COMPANY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
POOL = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
KEY = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
APPROVED_TARGET = '99999999-9999-4999-8999-999999999999'
MIB = R.MIB


class NativeFixture:
    def __init__(self, config):
        self.config = config
        self.calls = []
        self.rows = [self.row('1' * 64, config['deployment'] + '-agent-' + SID, 123, 2048, {
            'reverie.worker': config['deployment'], 'reverie.session': SID,
            'reverie.employee': EID, 'reverie.worker-policy': policy_digest(config, SID)}),
            self.row('2' * 64, config['serverContainer'], 124, 1024, {})]

    def row(self, identity, name, pid, memory, labels):
        return {'Id': identity, 'Name': '/' + name, 'Image': self.config['image'], 'Config': {'Labels': labels},
                'State': {'Running': True, 'Pid': pid}, 'Mounts': [],
                'HostConfig': {'Memory': memory * MIB, 'MemorySwap': memory * MIB, 'PidsLimit': 128, 'NanoCpus': 0}}

    def run_engine(self, args, optional=False, *, deadline=None):
        self.calls.append(args)
        if args == ['ps', '-aq', '--no-trunc']:
            data = '\n'.join(r['Id'] for r in self.rows)
        elif args[0] == 'ps' and '--filter' in args:
            data = '\n'.join(self.config['deployment'] + '-agent-' + r['Config']['Labels']['reverie.session']
                             for r in self.rows if 'reverie.worker' in r['Config']['Labels'] and r['State']['Running'])
        elif args[0] == 'inspect':
            selected = [r for r in self.rows if r['Id'] in args[1:]]
            data = '\n'.join(json.dumps(r) for r in selected) if '--format' in args else json.dumps(selected)
        else:
            raise AssertionError('Native mutation is not a fixture port')
        return subprocess.CompletedProcess(args, 0, data, '')


class Reservations(unittest.TestCase):
    def setUp(self):
        f = fixture.WorkerTests(); f.setUp(); self.addCleanup(f.doCleanups)
        self.root, self.config = f.root, f.config
        self.config.update(budgetMode='admission', memoryMiB=2048, poolMemoryMiB=8192)
        Path(self.config['stateRoot']).mkdir(mode=0o700)
        self.control = self.root / 'ram-private'; self.control.mkdir(mode=0o700)
        self.scope = {'company_id': COMPANY,
                      'owner_scope_digest': J.fingerprint({'company_id': COMPANY, 'owner': 'fixture-owner'})}
        self.config['resourceReservations'] = {
            'directory': str(self.control), 'companyId': COMPANY, 'poolId': POOL,
            'ownerScopeDigest': self.scope['owner_scope_digest'], 'hostReserveMiB': 1024}
        self.employee = {'id': EID, 'owner': 'fixture-owner', 'sessionId': SID,
                         'sessionGeneration': 1, 'desiredRunning': True, 'onVacation': False}
        self.company()
        self.native = NativeFixture(self.config)
        self.proc, self.cgroup = self.root / 'proc', self.root / 'cgroup'
        self.proc.mkdir(); self.cgroup.mkdir()
        (self.proc / 'meminfo').write_text('MemTotal: 16777216 kB\nMemAvailable: 12582912 kB\n')
        (self.proc / 'self').mkdir()
        (self.proc / 'self/cgroup').write_text('0::/observer\n')
        (self.proc / 'self/mountinfo').write_text(f'999999 1 0:1 / {self.cgroup} rw - cgroup2 cgroup rw\n')
        (self.cgroup / 'cgroup.controllers').write_text('memory pids\n')
        (self.cgroup / 'observer').mkdir()
        for name in ['memory.current', 'pids.current']:
            (self.cgroup / 'observer' / name).write_text('1\n')
        for name in ['memory.max', 'pids.max']:
            (self.cgroup / name).write_text('max\n')
        for row in self.native.rows:
            self.kernel(row)
        self.addCleanup(patch.stopall)
        patch.object(R, 'PROC', self.proc).start(); patch.object(R, 'CGROUP', self.cgroup).start()
        native_mounts = R.read_mount_table
        patch.object(R, 'read_mount_table', side_effect=lambda: native_mounts() + [
            {'point': self.cgroup, 'root': Path('/'), 'device': (0, 1), 'id': 999999}]).start()
        # Controlled procfs namespace port: no mounts/container are created. The
        # production reader still uses actual no-follow O_PATH/fstat descriptors.
        namespace = {}; identity = R._identity
        for destination, source in [('/home/agent', Path(self.config['stateRoot']) / 'employees' / EID / 'home'),
                                    ('/nix', Path(self.config['stateRoot']) / 'employees' / EID / 'nix'),
                                    ('/scratch', Path(self.config['scratchRoot']) / 'employees' / EID)]:
            source.mkdir(mode=0o700, parents=True, exist_ok=True)
            namespace[self.proc / '123/root' / destination.lstrip('/')] = source
            self.native.rows[0]['Mounts'].append({'Type': 'bind', 'Source': str(source), 'Destination': destination, 'RW': True})
        patch.object(R, '_identity', side_effect=lambda path: identity(namespace.get(Path(path), Path(path)))).start()
        R.provision(self.native)
        self.resources = {k: self.config[k] for k in R.RESOURCE_FIELDS}
        self.resources['memoryMiB'] = 4096
        self.profiles = ProfileStore(self.control / 'profiles'); self.addCleanup(self.profiles.close)
        self.profiles.put(EID, self.resources, {'employee_id': EID, 'current_sid': SID,
            'target_sid': APPROVED_TARGET, 'current_generation': 1, 'target_generation': 2},
            expected_revision=0, expected_profile_version=0, expected_binding=None)
        self.gate = R.ReservationGate(self.native)

    def company(self):
        Path(self.config['companyFile']).write_text(json.dumps({'employees': [self.employee]}))

    def kernel(self, row):
        pid = row['State']['Pid']; p = self.proc / str(pid); p.mkdir()
        fields = ['S'] + ['0'] * 19; fields[19] = '77'
        (p / 'stat').write_text(f'{pid} (fixture) ' + ' '.join(fields))
        (p / 'cgroup').write_text(f'0::/fixture-{pid}\n')
        leaf = self.cgroup / f'fixture-{pid}'; leaf.mkdir()
        for name, value in [('memory.max', row['HostConfig']['Memory']), ('memory.swap.max', 0), ('pids.max', 128)]:
            (leaf / name).write_text(str(value) + '\n')

    def observed(self):
        with self.gate.admission():
            return self.gate.observe(self.scope, POOL, EID)

    def request(self):
        observation = self.observed()
        return {'employee_id': EID, 'pool_id': POOL,
                'source_binding_digest': observation['source_binding_digest'], 'profile_version': '1',
                'requested_memory_bytes': str(4096 * MIB), 'preview_digest': 'f' * 64,
                'observation_digest': J.fingerprint(observation)}

    def claim(self):
        return self.gate.reserve(KEY, self.request())

    def test_fixed_native_observation_matches_existing_closed_journal_schema(self):
        value = self.observed(); J.observation(value)
        self.assertEqual(value['committed_bytes'], str(2048 * MIB))
        self.assertEqual(value['current_memory_bytes'], str(2048 * MIB))
        self.assertEqual(value['current_sid'], SID)
        self.assertNotIn(str(self.root), json.dumps(value))
        self.assertTrue(all(a[0] in ('ps', 'inspect') for a in self.native.calls))

    def test_claim_is_itself_the_durable_launch_fence_and_cold_never_revives_handle(self):
        view = self.claim(); target = view['operation']['reserved_sid']
        self.assertFalse(view['verified']); self.assertEqual(view['operation']['delta_bytes'], str(2048 * MIB))
        with self.assertRaisesRegex(ValueError, 'RECONCILIATION'):
            with self.gate.admission(target): pass
        with self.gate.admission(SID): pass  # Unchanged old source is not fenced.
        again = self.gate.reserve(KEY, self.request())
        self.assertEqual(again['operation']['id'], view['operation']['id'])
        self.assertEqual(again['operation']['state'], 'RECOVERY_REQUIRED')
        self.assertEqual(R.ReservationGate(self.native).cold_inspect()['fencedSids'], [target])

    def test_retained_delta_is_charged_to_normal_creation(self):
        self.claim()
        resources = dict(self.config, memoryMiB=5120)
        with self.gate.admission(), self.assertRaisesRegex(ValueError, 'CAPACITY_EXHAUSTED'):
            self.gate.check_creation(TARGET, resources)
        with self.gate.admission():
            self.gate.check_creation(TARGET, dict(self.config, memoryMiB=1024))

    def test_root_and_lock_replacements_and_deleted_lock_refuse_without_recreation(self):
        lock = self.control / 'profiles/profiles.lock'; lock.unlink()
        with self.assertRaises(FileNotFoundError):
            with self.gate.admission(): pass
        self.assertFalse(lock.exists())

    def test_policy_removed_and_corrupt_journal_keep_barrier(self):
        self.claim(); saved = self.config.pop('resourceReservations')
        self.assertTrue(R.configured(self.config))
        with self.assertRaisesRegex(ValueError, 'POLICY_REMOVED'):R.ReservationGate(self.native)
        self.config['resourceReservations'] = saved
        (self.control / 'operations/operations.json').write_text('not json')
        with self.gate.admission(), self.assertRaises(J.OperationRefusal):self.gate.check_launch(TARGET)

    def test_complete_inventory_missing_duplicate_and_changed_sources_refuse(self):
        original = self.native.run_engine
        def missing(args, optional=False, *, deadline=None):
            result = original(args, optional)
            if args[0] == 'inspect':result.stdout = '[]'
            return result
        with patch.object(self.native, 'run_engine', side_effect=missing), self.assertRaisesRegex(ValueError, 'INVENTORY'):
            with self.gate.admission(): pass

    def test_readonly_native_mount_and_broad_configured_mount_exposures_refuse(self):
        self.native.rows[1]['Mounts'] = [{'Type': 'bind', 'Source': str(self.control), 'RW': False}]
        with self.assertRaisesRegex(ValueError, 'CONTROL_EXPOSED'):
            with self.gate.admission(): pass
        self.native.rows[1]['Mounts'] = []
        self.config['mounts'][0]['source'] = str(self.root)
        with self.assertRaisesRegex(ValueError, 'DOMAIN_CHANGED'):
            with self.gate.admission(): pass
        with self.assertRaisesRegex(ValueError, 'CONTROL_EXPOSED'):
            self.gate.native.custody(self.control, R.marker(self.config))

    def test_nested_kernel_alias_below_a_different_source_refuses(self):
        source = Path(self.config['mounts'][0]['source'])
        table = [{'point': source / 'nested', 'device': (1, 1), 'root': self.control}]
        def coordinates(path, _table): return (1, 1), path
        with patch.object(R, 'read_mount_table', return_value=table), patch.object(R, '_coordinates', side_effect=coordinates), self.assertRaisesRegex(ValueError, 'NESTED_CONTROL_ALIAS'):
            with self.gate.admission(): pass

    def test_lower_ancestor_or_pid_drift_is_not_effective_capacity(self):
        (self.cgroup / 'memory.max').write_text(str(1024 * MIB))
        with self.assertRaisesRegex(ValueError, 'EFFECTIVE_LIMIT_CONFLICT'):self.observed()

    def test_owner_generation_intent_profile_and_snapshot_drift_refuse(self):
        req = self.request(); self.employee['sessionGeneration'] = 2; self.company()
        with self.assertRaisesRegex(ValueError, 'PROFILE_BINDING'):self.gate.reserve(KEY, req)
        self.employee['sessionGeneration'] = 1; self.employee['onVacation'] = True; self.company()
        with self.assertRaises(ValueError):self.gate.reserve(KEY, req)

    def test_actual_claim_rename_ack_loss_retains_durable_barrier(self):
        req = self.request(); rename = J.os.rename
        def lost(*args, **kwargs):
            rename(*args, **kwargs); raise OSError('owned ACK loss')
        with patch.object(J.os, 'rename', side_effect=lost), self.assertRaises(J.OperationCommitUncertain):
            self.gate.reserve(KEY, req)
        target = next(iter(json.loads((self.control / 'operations/operations.json').read_text())['operations'].values()))['reserved_sid']
        with self.assertRaisesRegex(ValueError, 'RECONCILIATION'):
            with R.ReservationGate(self.native).admission(target): pass

    def test_crossprocess_flock_serializes_claim_and_normal_admission(self):
        context = multiprocessing.get_context('fork'); output = context.Queue()
        def contender():
            try:
                with R.ReservationGate(self.native).admission(TARGET):pass
                output.put('unsafe entry')
            except BlockingIOError: output.put('locked')
        with self.gate.admission():
            child = context.Process(target=contender); child.start(); child.join(5)
            self.assertFalse(child.is_alive()); self.assertEqual(child.exitcode, 0)
            self.assertEqual(output.get(timeout=2), 'locked')
        output.close(); output.join_thread()

    def test_pure_old_compatibility_freezes_policy_without_profile_rebinding(self):
        before = copy.deepcopy(self.config); projected = copy.deepcopy(before)
        projected['employeeResources'] = {EID: self.resources}
        projected['sessionResources'] = {TARGET: self.resources}
        raw_profile = (self.control / 'profiles/profiles.json').read_bytes()
        self.assertNotEqual(policy_digest(before, SID), policy_digest(projected, SID))
        candidate = R.compatibility_candidate(before, projected, SID, TARGET)
        self.assertEqual(effective_config(candidate, SID)['memoryMiB'], 2048)
        self.assertEqual(effective_config(candidate, TARGET)['memoryMiB'], 4096)
        self.assertEqual(policy_digest(before, SID), policy_digest(candidate, SID))
        self.assertEqual((self.control / 'profiles/profiles.json').read_bytes(), raw_profile)
        changed = copy.deepcopy(projected); changed['poolMemoryMiB'] += 1
        with self.assertRaisesRegex(ValueError, 'GLOBAL_POLICY_CHANGED'):
            R.compatibility_candidate(before, changed, SID, TARGET)

    def test_broker_J_refuses_reserved_target_before_any_native_mutation(self):
        target = self.claim()['operation']['reserved_sid']
        broker = Broker(self.config); broker.run_engine = self.native.run_engine
        client, server = socket.socketpair(); broker.connections.acquire()
        thread = threading.Thread(target=broker.handle, args=(server,)); thread.start()
        try:
            send_frame(client, b'J', json.dumps({'sessionId': target, 'cwd': '/workspace/project',
                'command': 'unused', 'env': {}, 'rows': 20, 'cols': 80}).encode())
            kind, body = receive_frame(client)
            self.assertEqual(kind, b'E'); self.assertIn(b'RECONCILIATION', body)
        finally:
            client.close(); thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertTrue(all(a[0] in ('ps', 'inspect') for a in self.native.calls))

    def test_reload_cannot_change_capacity_epoch_beneath_retained_claim(self):
        self.claim()
        with self.gate.admission(), self.assertRaisesRegex(ValueError, 'RECONCILIATION'):
            self.gate.check_reload(dict(self.config, poolMemoryMiB=8193))

    def test_install_partial_fence_survives_even_if_option_removed(self):
        other = self.root / 'other-control'; other.mkdir(mode=0o700)
        config = dict(self.config, stateRoot=str(self.root / 'other-state'),
                      resourceReservations=dict(self.config['resourceReservations'], directory=str(other)))
        Path(config['stateRoot']).mkdir(mode=0o700); probe = NativeFixture(config)
        with patch.object(J.OperationStore, 'initialize', side_effect=OSError('owned init fault')), self.assertRaises(OSError):
            R.provision(probe)
        self.assertTrue(R.pending(config).is_file())
        config.pop('resourceReservations')
        self.assertTrue(R.configured(config))
        with self.assertRaisesRegex(ValueError, 'POLICY_REMOVED'):R.ReservationGate(probe)

    def test_host_control_option_preserves_exact_legacy_args_and_flat_peer_labels(self):
        legacy = {k: v for k, v in self.config.items() if k != 'resourceReservations'}
        self.assertEqual(create_args(self.config, SID, self.root / 'home'),
                         create_args(legacy, SID, self.root / 'home'))
        self.assertEqual(policy_digest(self.config, SID), policy_digest(legacy, SID))
        bundle = self.root / 'bundle'; (bundle / 'cleanup').mkdir(parents=True)
        source = Path(__file__).resolve().parents[1] / 'python/reverie'
        for name in ('peer_port', 'acceptance_io', 'peer_artifact', 'host_install'):
            shutil.copyfile(source / 'cleanup' / (name + '.py'), bundle / 'cleanup' / (name + '.py'))
        for name in ('worker_resources', 'worker_storage'):
            shutil.copyfile(source / (name + '.py'), bundle / (name + '.py'))
        code = """import importlib.util,json,sys
from pathlib import Path
s=importlib.util.spec_from_file_location('fixed_peer',Path(sys.argv[1])/'cleanup/peer_port.py')
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
print(json.dumps(m.expected_labels(json.load(sys.stdin),sys.argv[2])))
"""
        result = subprocess.run([sys.executable, '-I', '-B', '-c', code, str(bundle), SID],
                                input=json.dumps(self.config), capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        labels = json.loads(result.stdout)
        self.assertEqual(labels['workerPolicyHash'], policy_digest(legacy, SID))
        self.assertEqual(labels['workerConfigHash'], hashlib.sha256(
            json.dumps(effective_config(legacy, SID), sort_keys=True).encode()).hexdigest())
        with self.assertRaisesRegex(ValueError, 'cannot change'):
            validate_resource_reload(self.config, legacy)

    def test_replaced_admission_lock_or_control_root_refuses(self):
        lock = self.control / 'admission.lock'; held = os.open(lock, os.O_RDONLY)
        try:
            lock.unlink(); lock.write_text('{}'); lock.chmod(0o600)
            with self.assertRaisesRegex(ValueError, 'LOCK_REBOUND'):
                with self.gate.admission(): pass
        finally: os.close(held)

    def test_missing_root_controller_files_are_unlimited_not_missing_intermediate_facts(self):
        (self.cgroup / 'memory.max').unlink(); (self.cgroup / 'pids.max').unlink()
        self.assertEqual(self.observed()['current_memory_bytes'], str(2048 * MIB))
        (self.cgroup / 'fixture-123/memory.max').unlink()
        with self.assertRaises(FileNotFoundError):self.observed()

    def test_namespaced_subroot_and_missing_mandatory_counters_refuse(self):
        # A real nonroot cgroup has memory.current, even if a mounted view lacks
        # its max file. Do not turn that missing fact into an unlimited root.
        (self.cgroup / 'memory.max').unlink()
        (self.cgroup / 'memory.current').write_text('1\n')
        with self.assertRaisesRegex(ValueError, 'HOST_HIERARCHY_REQUIRED'):self.observed()
        (self.cgroup / 'memory.current').unlink()
        (self.cgroup / 'observer/pids.current').unlink()
        with self.assertRaises(FileNotFoundError):self.observed()

    def test_relevant_storage_kernel_mismatch_is_not_just_a_path_match(self):
        original = R._identity
        def changed(path):
            value = original(path)
            if Path(path) == self.proc / '123/root/nix': value[1] += 1
            return value
        with patch.object(R, '_identity', side_effect=changed), self.assertRaisesRegex(ValueError, 'STORAGE_IDENTITY'):
            self.observed()

    def test_replaced_control_directory_refuses_its_old_named_binding(self):
        self.control.rename(self.root / 'preserved-control')
        self.control.mkdir(mode=0o700)
        (self.control / 'admission.lock').write_text('{}'); (self.control / 'admission.lock').chmod(0o600)
        with self.assertRaisesRegex(ValueError, 'DIRECTORY_REBOUND'):
            with self.gate.admission(): pass

    def test_install_final_fsync_uncertainty_keeps_pending_after_ready_rename(self):
        other = self.root / 'final-control'; other.mkdir(mode=0o700)
        config = dict(self.config, stateRoot=str(self.root / 'final-state'),
                      resourceReservations=dict(self.config['resourceReservations'], directory=str(other)))
        Path(config['stateRoot']).mkdir(mode=0o700); probe = NativeFixture(config)
        fsync = R.os.fsync
        def fail(fd):
            fsync(fd)
            if R.marker(config).exists() and json.loads(R.marker(config).read_text()).get('state') == 'READY':
                raise OSError('owned final fsync uncertainty')
        with patch.object(R.os, 'fsync', side_effect=fail), self.assertRaises(OSError):R.provision(probe)
        self.assertTrue(R.pending(config).exists())
        with self.assertRaisesRegex(ValueError, 'INSTALL_REQUIRES_RECONCILIATION'):R.ReservationGate(probe)

    def test_company_binding_change_during_native_work_is_not_a_fresh_observation(self):
        capacity = self.gate.native.capacity
        def change(*args):
            value = capacity(*args)
            self.employee['sessionGeneration'] += 1; self.company()
            return value
        with patch.object(self.gate.native, 'capacity', side_effect=change), self.assertRaisesRegex(ValueError, 'EMPLOYEE_CHANGED_DURING_OBSERVATION'):
            self.observed()

    def test_profile_change_during_native_work_is_not_a_fresh_observation(self):
        capacity = self.gate.native.capacity
        def change(*args):
            value = capacity(*args)
            p = self.profiles.snapshot()['profiles'][EID]
            self.profiles.put(EID, dict(self.resources, memoryMiB=5120), p['binding'],
                expected_revision=1, expected_profile_version=1, expected_binding=p['binding'])
            return value
        with patch.object(self.gate.native, 'capacity', side_effect=change), self.assertRaisesRegex(ValueError, 'PROFILE_CHANGED_DURING_OBSERVATION'):
            self.observed()

    def test_source_off_cold_state_keeps_target_and_delta_without_stranding_other_existing_ports(self):
        target = self.claim()['operation']['reserved_sid']
        self.employee['desiredRunning'] = False; self.employee['onVacation'] = True; self.company()
        self.native.rows[0]['State'].update(Running=False, Pid=0)
        view = self.gate.cold_inspect()
        self.assertEqual(view['observations'][0]['nativeObservation'], 'unavailable')
        self.assertEqual(view['fencedSids'], [target]); self.assertFalse(view['retryAllowed'])
        self.assertEqual(self.gate.inspect(KEY)['operation']['delta_bytes'], str(2048 * MIB))
        with self.gate.admission(TARGET): pass  # Existing unrelated transport is not a new allocation.
        with self.assertRaisesRegex(ValueError, 'RECONCILIATION'):
            with self.gate.admission(target): pass
        with self.gate.admission(), self.assertRaises(ValueError):
            self.gate.check_creation(TARGET, dict(self.config, memoryMiB=512))
        broker = Broker(self.config); broker.run_engine = self.native.run_engine
        phone, terminal = object(), object(); broker.offices[TARGET] = phone; broker.active[TARGET] = terminal
        with patch.object(broker, '_recover_laptops', return_value='existing transport recovery') as recover:
            self.assertEqual(broker.recover(), 'existing transport recovery'); recover.assert_called_once_with()
        self.assertIs(broker.offices[TARGET], phone); self.assertIs(broker.active[TARGET], terminal)

    def test_cold_recovery_never_adopts_a_running_reserved_target(self):
        target = self.claim()['operation']['reserved_sid']
        row = self.native.row('3' * 64, self.config['deployment'] + '-agent-' + target, 125, 512,
            {'reverie.worker': self.config['deployment'], 'reverie.session': target})
        self.kernel(row); self.native.rows.append(row)
        broker = Broker(self.config); broker.run_engine = self.native.run_engine
        with patch.object(broker, 'claim_storage') as storage, self.assertRaisesRegex(ValueError, 'RECONCILIATION'):
            broker.recover()
        storage.assert_not_called()

    def test_postlaunch_release_failure_is_explicitly_unconfirmed_without_retry_or_stop(self):
        broker = Broker(self.config); broker.run_engine = self.native.run_engine
        calls = list(self.native.calls); exits = []
        def fail(*_):
            exits.append(True); raise OSError('owned close failure')
        guard = type('FailedFinalizer', (), {'__exit__': fail})()
        with self.assertRaisesRegex(RuntimeError, 'unconfirmed'):
            broker._release_resource_admission(guard)
        self.assertIn('RESOURCE_ADMISSION_RELEASE_UNCONFIRMED', broker.cleanup_uncertain)
        self.assertEqual(self.native.calls, calls); self.assertEqual(exits, [True])

    def test_pid_start_tick_change_during_cgroup_reads_refuses(self):
        original = R._read
        def change(path, maximum=65536):
            value = original(path, maximum)
            if Path(path) == self.cgroup / 'fixture-123/memory.swap.max':
                p = self.proc / '123/stat'; fields = p.read_text().split(); fields[-1] = '78'; p.write_text(' '.join(fields))
            return value
        with patch.object(R, '_read', side_effect=change), self.assertRaisesRegex(ValueError, 'NATIVE_PID_CHANGED'):
            self.observed()

    def test_duplicate_native_ids_or_stopped_nonzero_pid_are_not_free_capacity(self):
        row = copy.deepcopy(self.native.rows[0]); self.native.rows.append(row)
        with self.assertRaisesRegex(ValueError, 'COMPLETE_INVENTORY'):
            with self.gate.admission(): pass
        self.native.rows.pop(); self.native.rows[0]['State']['Running'] = False
        with self.assertRaisesRegex(ValueError, 'NATIVE_STATE'):self.observed()

    def test_disabled_feature_keeps_partial_transport_constructor_without_native_reads(self):
        with patch.object(Broker, 'run_engine', side_effect=AssertionError('no optional native read')):
            broker = Broker({'maxWorkers': 1})
            self.assertIsNone(broker.resource_reservations)
            with broker.resource_admission(): pass


if __name__ == '__main__': unittest.main()
