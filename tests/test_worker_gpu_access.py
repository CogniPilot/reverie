"""Owned files/actual R flock, fixed synthetic native ports; no engine effects."""
import copy
import json
import importlib.util
import os
from pathlib import Path
import subprocess
import socket
import threading
import fcntl
import multiprocessing
import unittest
from unittest.mock import patch

from reverie import worker_gpu_access as G
from reverie import worker_resource_reservations as R
from reverie.worker import Broker
from tests import test_worker_resource_reservations as fixture

DEVICE = 'GPU-11111111-2222-3333-4444-555555555555'
OTHER = 'ffffffff-ffff-4fff-8fff-ffffffffffff'


class GPUAccess(unittest.TestCase):
    company = fixture.Reservations.company
    kernel = fixture.Reservations.kernel

    def setUp(self):
        # Even a missed instance injection cannot fall through to a real engine.
        self.forbid = patch.object(Broker, 'run_engine', side_effect=AssertionError('REAL_ENGINE_FORBIDDEN'))
        self.forbid.start(); self.addCleanup(self.forbid.stop)
        fixture.Reservations.setUp(self)
        self.broker = self.native
        self.broker.resource_reservations = self.gate
        self.path = self.root / 'broker.json'
        self.path.write_text(json.dumps(self.config)); self.path.chmod(0o600)
        self.broker.config_file = self.path
        self.catalogue_original = G._catalogue
        self.catalogue = patch.object(G, '_catalogue', return_value=[{'deviceUuid': DEVICE, 'model': 'Fixture physical GPU'}])
        self.catalogue.start(); self.addCleanup(self.catalogue.stop)
        patch.object(G, '_installed_consumers', return_value=False).start()
        self.engine = self.broker.run_engine
        def engine(args, optional=False, *, deadline=None):
            if args[:1] == ['info']:
                return subprocess.CompletedProcess(args, 0, json.dumps({'CDISpecDirs': ['/fixture/cdi'], 'OSType': 'linux', 'KernelVersion': os.uname().release}), '')
            return self.engine(args, optional, deadline=deadline)
        self.broker.run_engine = engine
        from reverie import worker_gpu_preflight as preflight
        self.physical_original = preflight.physical_device
        patch('reverie.worker_gpu_preflight.physical_device', return_value={
            'uuid': DEVICE, 'model': 'Fixture physical GPU', 'deviceMinor': '0', 'pci': '0000:01:00.0'}).start()
        self.cdi = self.root / 'cdi.json'; self.cdi.write_text('{}')
        patch('reverie.worker_gpu_preflight.cdi_device', return_value={'deviceNodePaths': ['/dev/nvidia0'], 'path': str(self.cdi)}).start()

    def command(self, device=DEVICE):
        status = G.status(self.broker, fixture.EID)
        return {'action': 'gpu-access-request', 'employeeId': fixture.EID,
                'expected': {**status['current'], 'revision': status['revision']},
                'enabled': device is not None, **({'deviceUuid': device} if device else {})}

    def stop_fixture(self):
        self.native.rows[0]['State'] = {'Running': False, 'Pid': 0}

    def test_running_queue_preserves_config_binding_and_labels(self):
        before = self.path.read_bytes(); binding = R.marker(self.config).read_bytes()
        rows = copy.deepcopy(self.native.rows)
        result = G.request(self.broker, self.command())
        self.assertEqual(result['state'], 'pending')
        self.assertTrue(result['requested']['enabled'])
        self.assertFalse(result['applied']['enabled'])
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(R.marker(self.config).read_bytes(), binding)
        self.assertEqual(rows, self.native.rows)
        self.assertFalse(os.path.lexists(R.pending(self.config)))

    def test_stopped_transition_preserves_stores_peers_and_reconstructs_real_gate(self):
        self.stop_fixture(); before = copy.deepcopy(self.config)
        stores = {p:p.read_bytes() for p in self.control.glob('*/*.json')}
        result = G.request(self.broker, self.command())
        self.assertEqual(result['state'], 'applied')
        self.assertTrue(result['applied']['enabled'])
        self.assertFalse(result['active']['enabled'])
        self.assertEqual(self.broker.config['employeeGpuGrants'], {fixture.EID: 'nvidia.com/gpu=' + DEVICE})
        self.assertEqual({k:v for k,v in before.items() if k!='employeeGpuGrants'},
                         {k:v for k,v in self.broker.config.items() if k!='employeeGpuGrants'})
        self.assertEqual({p:p.read_bytes() for p in stores}, stores)
        self.assertFalse(os.path.lexists(R.pending(self.broker.config)))
        rebuilt = R.ReservationGate(self.broker)
        with rebuilt.admission():
            rebuilt.check_launch(fixture.SID)
        self.assertEqual(rebuilt.binding['configurationDigest'], R.domain_digest(self.broker.config))

    def test_queue_applies_at_cold_boundary_without_any_engine_mutation(self):
        G.request(self.broker, self.command()); self.stop_fixture()
        G.cold_boundary(self.broker, fixture.SID)
        self.assertTrue(G.status(self.broker, fixture.EID)['applied']['enabled'])
        self.assertTrue(all(c[0] in ('ps', 'inspect') for c in self.native.calls))

    def test_stale_request_conflict_and_unknown_flags_preserve_queue(self):
        command = self.command(); G.request(self.broker, command)
        before = (self.control / 'operations' / G.NAME).read_bytes()
        for mutation in ({'expected': command['expected']}, {'deviceUuid': 'all'}, {'caller': fixture.SID},
                         {'enabled': 1}, {'deviceUuid': 'GPU-../../dev'}):
            wrong = {**self.command(), **mutation}
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                G.request(self.broker, wrong)
            self.assertEqual((self.control / 'operations' / G.NAME).read_bytes(), before)

    def test_owner_sid_move_does_not_rebind_old_request(self):
        G.request(self.broker, self.command()); self.stop_fixture()
        before = self.path.read_bytes()
        self.employee['sessionGeneration'] = 2; self.company()
        G.cold_boundary(self.broker, fixture.SID)
        self.assertEqual(self.path.read_bytes(), before)
        self.assertFalse(G.status(self.broker, fixture.EID)['applied']['enabled'])

    def test_legacy_grant_visible_and_conflicting_off_refuses(self):
        self.broker.config['gpuGrants'] = {fixture.SID: 'nvidia.com/gpu=' + DEVICE}
        self.path.write_text(json.dumps(self.broker.config))
        self.gate.binding['configurationDigest'] = R.domain_digest(self.broker.config)
        R.marker(self.broker.config).write_text(json.dumps(self.gate.binding))
        result = G.status(self.broker, fixture.EID)
        self.assertIsNone(result['requested'])
        self.assertEqual(result['applied']['source'], 'legacy-session')
        self.assertTrue(result['applied']['enabled'])
        with self.assertRaisesRegex(ValueError, 'GPU_LEGACY_SESSION_OVERRIDE'):
            G.request(self.broker, self.command(None))
        self.assertFalse(os.path.lexists(self.control / 'operations' / G.NAME))

    def test_unknown_hardware_is_not_fake_applied(self):
        with patch.object(G, '_catalogue', side_effect=ValueError('unavailable')):
            self.assertFalse(G.status(self.broker, fixture.EID)['choices']['known'])
            with self.assertRaises(ValueError):
                G.request(self.broker, self.command())

    def test_installed_raw_config_consumers_remain_queued(self):
        self.stop_fixture(); before = self.path.read_bytes()
        with patch.object(G, '_installed_consumers', return_value=True):
            result = G.request(self.broker, self.command())
        self.assertEqual(result['state'], 'pending')
        self.assertEqual(self.path.read_bytes(), before)

    def test_partial_publication_retains_pending_and_cold_fence_no_replay(self):
        self.stop_fixture(); original = G._replace
        def fail_binding(path, value, expected):
            if Path(path) == R.marker(self.config):
                raise OSError('owned fsync/replace fault')
            return original(path, value, expected)
        with patch.object(G, '_replace', side_effect=fail_binding), self.assertRaisesRegex(RuntimeError, 'RECONCILIATION'):
            G.request(self.broker, self.command())
        self.assertTrue(os.path.lexists(R.pending(self.config)))
        with self.assertRaisesRegex(ValueError, 'RECONCILIATION'):
            R.ReservationGate(self.broker)
        with self.assertRaises(ValueError):
            G.status(self.broker, fixture.EID)

    def test_last_admission_native_change_retains_fence(self):
        self.stop_fixture(); original = self.gate.native.custody
        def drift(*args, **kwargs):
            rows = original(*args, **kwargs)
            if getattr(self.gate._local, 'gpu_transition', None) is not None:
                rows = copy.deepcopy(rows); rows[1]['State']['Pid'] += 1
            return rows
        with patch.object(self.gate.native, 'custody', side_effect=drift), self.assertRaisesRegex(RuntimeError, 'RECONCILIATION'):
            G.request(self.broker, self.command())
        self.assertTrue(os.path.lexists(R.pending(self.config)))

    def test_request_store_symlink_is_not_an_empty_queue(self):
        (self.control / 'operations' / G.NAME).symlink_to(self.root / 'absent')
        with self.assertRaises((ValueError, OSError)):
            G.status(self.broker, fixture.EID)

    def test_active_resource_claim_refuses_apply_without_credit(self):
        self.stop_fixture()
        with patch.object(self.gate, '_document', return_value={'operations': {'occupied': {}}}):
            with self.assertRaisesRegex(ValueError, 'GPU_RESOURCE_OPERATION'):
                G.request(self.broker, self.command())
        self.assertTrue(G._requests(self.gate)[0]['requests'])
        self.assertFalse(os.path.lexists(R.pending(self.config)))

    def test_actual_C_frame_only_owner_peer_and_closed_request(self):
        from reverie.worker import send_frame, receive_frame
        self.broker.handlers = {}; self.broker.stopping = threading.Event()
        self.broker.cleanup_uncertain = set()
        def exchange(command):
            self.broker.connections = threading.BoundedSemaphore(1); self.broker.connections.acquire()
            host, client = socket.socketpair(); client.settimeout(10)
            thread = threading.Thread(target=Broker.handle, args=(self.broker, host))
            send_frame(client, b'C', command)
            thread.start()
            try:
                return receive_frame(client)
            finally:
                client.close(); thread.join(10)
                self.assertFalse(thread.is_alive())
        kind, data = exchange(json.dumps({'action': 'gpu-access-status', 'employeeId': fixture.EID}).encode())
        self.assertEqual(kind, b'J'); self.assertEqual(json.loads(data)['employeeId'], fixture.EID)
        kind, data = exchange(json.dumps({**self.command(), 'owner': True}).encode())
        self.assertEqual(kind, b'E')
        kind, data = exchange(b'{"action":"gpu-access-status","employeeId":"' + fixture.EID.encode() + b'","employeeId":"' + OTHER.encode() + b'"}')
        self.assertEqual(kind, b'E'); self.assertIn(b'DUPLICATE', data)
        actual = self.broker.config['uid']; self.broker.config['uid'] = actual + 1
        try:
            kind, data = exchange(json.dumps({'action': 'gpu-access-status', 'employeeId': fixture.EID}).encode())
            self.assertEqual(kind, b'E'); self.assertIn(b'identity', data)
        finally:
            self.broker.config['uid'] = actual

    def test_real_crossprocess_admission_lock_blocks_queue_publication(self):
        parent, child = multiprocessing.get_context('fork').Pipe()
        def hold():
            fd = os.open(self.control / 'admission.lock', os.O_RDWR)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX); child.send('held'); child.recv()
            finally:
                os.close(fd); child.close()
        command = self.command()
        process = multiprocessing.get_context('fork').Process(target=hold)
        process.start()
        try:
            self.assertEqual(parent.recv(), 'held')
            with self.assertRaises(BlockingIOError):
                G.request(self.broker, command)
            self.assertFalse(os.path.lexists(self.control / 'operations' / G.NAME))
        finally:
            parent.send('release'); process.join(5); parent.close(); child.close()
            self.assertEqual(process.exitcode, 0)

    def test_store_change_in_admission_finalizer_keeps_pending(self):
        self.stop_fixture(); original = self.gate.admission
        from contextlib import contextmanager
        @contextmanager
        def changed(*args, **kwargs):
            with original(*args, **kwargs):
                yield
            if os.path.lexists(R.pending(self.config)):
                path = self.control / 'operations/operations.json'
                path.write_bytes(path.read_bytes() + b' ')
        with patch.object(self.gate, 'admission', changed), self.assertRaisesRegex(RuntimeError, 'RECONCILIATION'):
            G.request(self.broker, self.command())
        self.assertTrue(os.path.lexists(R.pending(self.config)))

    def test_cdi_other_physical_device_never_applies(self):
        self.stop_fixture(); before = self.path.read_bytes()
        with patch('reverie.worker_gpu_preflight.cdi_device', return_value={'deviceNodePaths': ['/dev/nvidia0', '/dev/nvidia1']}):
            with self.assertRaisesRegex(ValueError, 'PHYSICAL_DEVICE_MISMATCH'):
                G.request(self.broker, self.command())
        self.assertEqual(self.path.read_bytes(), before)
        self.assertFalse(os.path.lexists(R.pending(self.config)))

    def test_real_bounded_kernel_catalogue(self):
        from reverie import worker_gpu_preflight as P
        gpu = self.root / 'gpu'; (gpu / '0000:01:00.0').mkdir(parents=True)
        (gpu / '0000:01:00.0/information').write_text('GPU UUID: '+DEVICE+'\nModel: Fixture GPU\nBus Location: 0000:01:00.0\nDevice Minor: 0\n')
        with patch.object(P, 'GPU_ROOT', gpu), patch.object(G, '_catalogue', self.catalogue_original):
            # This test's physical_device patch is removed locally to exercise
            # both actual fixed parsers, never host GPU metadata.
            with patch.object(P, 'physical_device', self.physical_original):
                self.assertEqual(G._catalogue(), [{'deviceUuid': DEVICE, 'model': 'Fixture GPU'}])
    @unittest.skipUnless(importlib.util.find_spec('yaml'), 'YAML is verified by the pinned broker package')
    def test_packaged_optional_yaml_decoder(self):
        from reverie import worker_gpu_preflight as P
        decoded = P.decode_cdi(b'kind: nvidia.com/gpu\ndevices:\n  - name: '+DEVICE.encode()+b'\n')
        self.assertEqual(decoded['devices'][0]['name'], DEVICE)
        for raw in (b'kind: a\nkind: b\n', b'x: &a [1]\ny: *a\n'):
            with self.assertRaises(ValueError):
                P.decode_cdi(raw)

    def test_off_transition_keeps_unselected_legacy_and_employee_grants(self):
        self.stop_fixture()
        self.broker.config['employeeGpuGrants'] = {fixture.EID: 'nvidia.com/gpu='+DEVICE, OTHER: 'nvidia.com/gpu='+DEVICE}
        self.broker.config['gpuGrants'] = {OTHER: 'nvidia.com/gpu='+DEVICE}
        self.path.write_text(json.dumps(self.broker.config))
        self.gate.binding['configurationDigest'] = R.domain_digest(self.broker.config)
        R.marker(self.config).write_text(json.dumps(self.gate.binding))
        result = G.request(self.broker, self.command(None))
        self.assertEqual(result['state'], 'applied')
        self.assertFalse(result['applied']['enabled'])
        self.assertEqual(self.broker.config['employeeGpuGrants'], {OTHER: 'nvidia.com/gpu='+DEVICE})
        self.assertEqual(self.broker.config['gpuGrants'], {OTHER: 'nvidia.com/gpu='+DEVICE})

    def test_legacy_cold_path_without_queue_has_no_new_observation(self):
        with patch.object(self.gate, 'admission', side_effect=AssertionError('not needed')):
            G.cold_boundary(self.broker, fixture.SID)

    def test_pending_after_lost_admission_finalizer_never_claims_clean_completion(self):
        self.stop_fixture(); original = self.gate.admission
        from contextlib import contextmanager
        @contextmanager
        def fail_finalizer(*args, **kwargs):
            with original(*args, **kwargs):
                yield
            if os.path.lexists(R.pending(self.config)):
                raise OSError('owned lock/FD finalizer acknowledgement lost')
        with patch.object(self.gate, 'admission', fail_finalizer), self.assertRaisesRegex(RuntimeError, 'RECONCILIATION'):
            G.request(self.broker, self.command())
        self.assertTrue(os.path.lexists(R.pending(self.config)))
        with self.assertRaises(ValueError):
            R.ReservationGate(self.broker)

    def test_owner_off_intent_does_not_apply_queue_via_refused_cold_launch(self):
        G.request(self.broker, self.command()); self.stop_fixture()
        before = self.path.read_bytes()
        self.employee['desiredRunning'] = False; self.company()
        G.cold_boundary(self.broker, fixture.SID)
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(G.status(self.broker, fixture.EID)['state'], 'pending')

    def test_foreign_pending_replacement_in_last_parent_observation_is_retained(self):
        self.stop_fixture();command=self.command();original=G._parents_current;original_lstat=Path.lstat;changed=[]
        pending=R.pending(self.config);foreign=b'{"foreign":"not-this-transition"}'
        def parents(expected):
            last=list(expected)[-1]
            def lstat(path,*args,**kwargs):
                result=original_lstat(path,*args,**kwargs)
                if path==last and not changed:
                    self.assertTrue(pending.exists());temporary=pending.with_name('owned-foreign-pending')
                    temporary.write_bytes(foreign);temporary.chmod(0o600);os.replace(temporary,pending);changed.append(True)
                return result
            with patch.object(Path,'lstat',lstat):return original(expected)
        with patch.object(G,'_parents_current',side_effect=parents),self.assertRaisesRegex(RuntimeError,'RECONCILIATION'):
            G.request(self.broker,command)
        self.assertEqual(changed,[True]);self.assertEqual(pending.read_bytes(),foreign)
        with self.assertRaises(ValueError):R.ReservationGate(self.broker)

    def test_pending_identity_is_last_after_other_terminal_leaf_reads(self):
        self.stop_fixture();original=G._parents_current;stamp=G._stamp;after_parents=[];changed=[]
        pending=R.pending(self.config);foreign=b'{"foreign":"later-leaf-replacement"}'
        def parents(expected):
            result=original(expected);after_parents.append(True);return result
        def leaf(path):
            result=stamp(path)
            if after_parents and Path(path)==self.control/'profiles/profiles.json' and not changed:
                temporary=pending.with_name('owned-foreign-pending')
                temporary.write_bytes(foreign);temporary.chmod(0o600);os.replace(temporary,pending);changed.append(True)
            return result
        with patch.object(G,'_parents_current',side_effect=parents),patch.object(G,'_stamp',side_effect=leaf),\
             self.assertRaisesRegex(RuntimeError,'RECONCILIATION'):
            G.request(self.broker,self.command())
        self.assertEqual(changed,[True]);self.assertEqual(pending.read_bytes(),foreign)
        with self.assertRaises(ValueError):R.ReservationGate(self.broker)
