"""Real admission/store files and flock; fixed native producers use owned ports.

No engine, process, systemd unit or GPU action is made by these controls.
"""
from dataclasses import replace
import hashlib
import json
from pathlib import Path
import unittest
import threading
import time
import types
import subprocess
from unittest.mock import patch

from reverie.worker import Broker
from reverie import host_job_scope as H
from reverie import worker_host_job as W
from reverie import worker_resource_reservations as R
from reverie.worker_resources import effective_config
from tests import test_worker_resource_reservations as F
from tests import test_host_job_scope as S
from tests import test_browser_job_policy as P


class HostJobGate(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.object(Broker, 'run_engine', side_effect=AssertionError('REAL_ENGINE_FORBIDDEN')))
        self.f = F.Reservations(); self.f.setUp(); self.addCleanup(self.f.doCleanups)
        f = self.f
        value = P.policy(); value['controlRoot'] = str(f.control/'host-jobs')
        value['limits']['hostReserveMiB'] = f.gate.option['hostReserveMiB']
        (f.control/'host-jobs').mkdir(mode=0o700)
        self.path = f.root/'job-policy.json'; self.path.write_text(json.dumps(value)); self.path.chmod(0o600)
        f.config['browserJobPolicy'] = str(self.path)
        self.spec = H.FixedHostJobSpec('a'*32, 'fixed-public-browser',
            hashlib.sha256(self.path.read_bytes()).hexdigest(), 'reverie-gpu-job-'+'a'*32+'.scope',
            value['limits']['memoryBytes'], value['limits']['pids'], tuple(value['limits']['cpuSet']),
            value['limits']['runtimeSeconds'], value['limits']['stopSeconds'],
            value['tools']['systemctl']['path'], value['tools']['systemctl']['sha256'],
            value['tools']['node']['path'], value['tools']['node']['sha256'],
            value['runner']['path'], value['runner']['sha256'],
            str(f.control/'host-jobs/tasks'/('capture-'+'a'*32)/'f/work'))

    def actual_binding(self):
        # Reuse the accepted fixed observer with only its kernel/tool producers
        # controlled. The gate receives the real registry-minted object.
        self.enterContext(patch.object(S, 'SPEC', self.spec))
        self.enterContext(patch.object(S, 'ACTIVE', {**S.ACTIVE, 'Id': self.spec.unit,
            'MemoryMax': str(self.spec.memory_bytes), 'TasksMax': str(self.spec.pids)}))
        fixture = S.ScopeControls(); self.addCleanup(fixture.doCleanups)
        fixture.fixture(); observer, binding, client = fixture.bound()
        return observer, binding, client

    def test_intent_blocks_every_new_allocation_but_preserves_existing_transport(self):
        handle = self.f.gate.begin_host_job(self.spec)
        self.assertEqual(handle.spec, self.spec)
        intent = self.f.control/'operations'/W.NAME
        self.assertTrue(intent.is_file())
        with self.f.gate.admission(F.SID): pass
        with self.f.gate.admission():
            with self.assertRaisesRegex(ValueError, 'HOST_JOB_OUTCOME'):
                self.f.gate.check_creation(F.SID, effective_config(self.f.config, F.SID))
            with self.assertRaisesRegex(ValueError, 'HOST_JOB_OUTCOME'):
                self.f.gate.check_headroom()
        cold = R.ReservationGate(self.f.native)
        del self.f.config['browserJobPolicy']
        with cold.admission(F.SID): pass
        with cold.admission(), self.assertRaisesRegex(ValueError, 'HOST_JOB_OUTCOME'):
            cold.check_creation(F.SID, effective_config(self.f.config, F.SID))
        self.assertTrue(intent.is_file())

    def test_configured_full_pool_is_not_borrowed_from_idle_workers(self):
        self.f.config['poolMemoryMiB'] = 50*1024
        site = self.f.native.rows[1]; site['HostConfig'].update(Memory=8*1024**3, MemorySwap=8*1024**3)
        (self.f.cgroup/'fixture-124/memory.max').write_text(str(8*1024**3))
        (self.f.proc/'meminfo').write_text('MemTotal: 65744666 kB\nMemAvailable: 33554432 kB\n')
        with self.assertRaisesRegex(ValueError, 'HOST_JOB_CAPACITY_EXHAUSTED'):
            self.f.gate.begin_host_job(self.spec)
        self.assertFalse((self.f.control/'operations'/W.NAME).exists())

    def test_changed_policy_or_copied_handle_cannot_create_or_clear_a_fence(self):
        with self.assertRaisesRegex(ValueError, 'FIXED_POLICY_CHANGED'):
            self.f.gate.begin_host_job(replace(self.spec, memory_bytes=512*R.MIB))
        handle = self.f.gate.begin_host_job(self.spec)
        _, binding, _ = self.actual_binding()
        with self.assertRaisesRegex(ValueError, 'LIVE_HOST_JOB_HANDLE_REQUIRED'):
            self.f.gate.bind_host_job(replace(handle), binding)
        with self.assertRaisesRegex(ValueError, 'NATIVE_BINDING_REQUIRED'):
            self.f.gate.bind_host_job(handle, {'settled': True})

    def test_registered_fixed_native_settlement_releases_only_after_all_finalizers(self):
        handle = self.f.gate.begin_host_job(self.spec)
        _, binding, client = self.actual_binding(); self.f.gate.bind_host_job(handle, binding)
        client.returncode = 0
        with patch.object(H, '_query', return_value=(0, S.TERMINAL)), patch.object(H, '_empty', return_value=True), \
             patch.object(H, '_birth', return_value=None):
            result = self.f.gate.finish_host_job(handle, binding)
        self.assertEqual(result['state'], 'NATIVE_SETTLED')
        with self.f.gate.admission(): W.require_idle(self.f.gate)
        with self.assertRaisesRegex(ValueError, 'ALREADY_ATTEMPTED'):
            self.f.gate.begin_host_job(self.spec)

    def test_unreaped_or_lost_scope_retains_pending_and_no_automatic_retry(self):
        handle = self.f.gate.begin_host_job(self.spec)
        _, binding, _ = self.actual_binding(); self.f.gate.bind_host_job(handle, binding)
        with self.assertRaisesRegex(H.ScopeUnknown, 'NOT_REAPED'):
            self.f.gate.finish_host_job(handle, binding)
        with self.f.gate.admission(), self.assertRaisesRegex(ValueError, 'FINISH_REQUIRES'):
            W.require_idle(self.f.gate)

    def test_last_admission_guard_failure_keeps_release_pending_even_after_native_settlement(self):
        handle = self.f.gate.begin_host_job(self.spec)
        _, binding, client = self.actual_binding(); self.f.gate.bind_host_job(handle, binding)
        client.returncode = 0; guard = self.f.gate._guard
        def late(selected=None):
            path = self.f.control/'operations'/W.NAME
            if json.loads(path.read_text())['state'] == 'SETTLED_NATIVE':
                raise RuntimeError('controlled last custody failure')
            return guard(selected)
        with patch.object(H, '_query', return_value=(0, S.TERMINAL)), patch.object(H, '_empty', return_value=True), \
             patch.object(H, '_birth', return_value=None), patch.object(self.f.gate, '_guard', side_effect=late):
            with self.assertRaisesRegex(RuntimeError, 'last custody failure'):
                self.f.gate.finish_host_job(handle, binding)
        self.assertTrue((self.f.control/'operations'/W.FINISHING).is_file())
        with self.f.gate.admission(), self.assertRaisesRegex(ValueError, 'FINISH_REQUIRES'):
            W.require_idle(self.f.gate)

    def test_absolute_deadline_is_shared_by_all_producers_before_intent(self):
        now = [1000.0]
        original = self.f.gate.native.capacity
        def expire(rows, selected):
            value = original(rows, selected); now[0] += 11; return value
        with patch.object(time, 'monotonic', side_effect=lambda: now[0]), \
             patch.object(self.f.gate.native, 'capacity', side_effect=expire):
            with self.assertRaisesRegex(ValueError, 'DEADLINE'):
                self.f.gate.begin_host_job(self.spec, deadline=1010.0)
        self.assertFalse((self.f.control/'operations'/W.NAME).exists())

    def test_deadline_also_bounds_wait_for_the_actual_local_admission_mutex(self):
        entered = threading.Event(); release = threading.Event()
        def holder():
            with self.f.gate._mutex:
                entered.set(); release.wait(2)
        child = threading.Thread(target=holder); child.start()
        try:
            self.assertTrue(entered.wait(1))
            with self.assertRaisesRegex(ValueError, 'DEADLINE'):
                self.f.gate.begin_host_job(self.spec, deadline=time.monotonic()+0.05)
            self.assertFalse((self.f.control/'operations'/W.NAME).exists())
        finally:
            release.set(); child.join(2)
        self.assertFalse(child.is_alive())


class EngineDeadline(unittest.TestCase):
    def test_actual_client_timeout_is_clamped_without_invoking_any_engine(self):
        import reverie.worker as worker
        broker = types.SimpleNamespace(engine='REAL_ENGINE_FORBIDDEN', stopping=types.SimpleNamespace(is_set=lambda: False))
        result = subprocess.CompletedProcess([], 0, '', '')
        with patch.object(worker, 'run_client', return_value=result) as client, \
             patch.object(worker.time, 'monotonic', return_value=100):
            worker.Broker.run_engine(broker, ['ps', '-aq'], deadline=102.5)
            self.assertEqual(client.call_args.kwargs['timeout'], 2.5)
            for value in (True, float('nan'), float('inf'), 100):
                with self.assertRaises((ValueError, RuntimeError)):
                    worker.Broker.run_engine(broker, ['ps', '-aq'], deadline=value)
            self.assertEqual(client.call_count, 1)
