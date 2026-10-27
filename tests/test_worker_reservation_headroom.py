"""INSTALL qualification is fixed observation, not a hypothetical launch."""
import copy
import json
from pathlib import Path
import unittest
from unittest.mock import patch

from reverie import worker_resource_reservations as R
from tests import test_worker_resource_reservations as fixture


class Headroom(unittest.TestCase):
    def setUp(self):
        self.f = fixture.Reservations(); self.f.setUp(); self.addCleanup(self.f.doCleanups)

    def test_install_port_requires_held_admission_and_has_no_claim_or_effect(self):
        f = self.f; path = f.control / 'operations/operations.json'; before = path.read_bytes()
        with self.assertRaisesRegex(ValueError, 'ADMISSION_LOCK_REQUIRED'):f.gate.check_headroom()
        with patch.object(R.journal.OperationStore, 'claim', side_effect=AssertionError('no install claim')):
            with f.gate.admission():value = f.gate.check_headroom()
        self.assertEqual(value, {'budgetBytes': 8192 * R.MIB, 'committedBytes': 2048 * R.MIB, 'retainedBytes': 0})
        self.assertEqual(path.read_bytes(), before)

    def test_install_charges_qualified_retained_delta_without_target_candidate(self):
        f = self.f; f.claim(); path = f.control / 'operations/operations.json'; before = path.read_bytes()
        with f.gate.admission():value = f.gate.check_headroom()
        self.assertEqual(value['retainedBytes'], 2048 * R.MIB)
        self.assertEqual(value['committedBytes'], 2048 * R.MIB)
        self.assertEqual(path.read_bytes(), before)

    def test_owner_stop_keeps_recovery_available_but_install_cannot_credit_source(self):
        f = self.f; view = f.claim(); path = f.control / 'operations/operations.json'; before = path.read_bytes()
        f.employee.update(desiredRunning=False, onVacation=True); f.company()
        f.native.rows[0]['State'].update(Running=False, Pid=0)
        recovery = f.gate.cold_inspect()
        self.assertTrue(recovery['recoveryRequired']); self.assertFalse(recovery['retryAllowed'])
        self.assertEqual(recovery['fencedSids'], [view['operation']['reserved_sid']])
        with self.assertRaises(ValueError):
            with f.gate.admission():f.gate.check_headroom()
        self.assertEqual(path.read_bytes(), before)

    def test_corrupt_retained_journal_is_never_empty_headroom(self):
        f = self.f; path = f.control / 'operations/operations.json'; path.write_text('{}')
        with self.assertRaises(ValueError):
            with f.gate.admission():f.gate.check_headroom()
        self.assertEqual(path.read_text(), '{}')

    def test_native_observer_delegates_only_qualified_actual_host_and_pool_facts(self):
        f = self.f
        with patch.object(R, 'explicit_host_headroom_fits', wraps=R.explicit_host_headroom_fits) as host, \
             patch.object(R, 'pool_headroom_fits', wraps=R.pool_headroom_fits) as pool:
            with f.gate.admission():f.gate.check_headroom()
        self.assertEqual(host.call_args.kwargs, {'pool_bytes': 8192 * R.MIB, 'site_bytes': 1024 * R.MIB,
            'reserve_bytes': 1024 * R.MIB, 'total_bytes': 16384 * R.MIB, 'available_bytes': 12288 * R.MIB})
        self.assertEqual(pool.call_args.kwargs, {'budget_bytes': 8192 * R.MIB, 'committed_bytes': 2048 * R.MIB,
            'retained_bytes': 0, 'candidate_bytes': 0})

    def test_insufficient_available_memory_never_falls_back_to_legacy(self):
        f = self.f; (f.proc / 'meminfo').write_text('MemTotal: 16777216 kB\nMemAvailable: 1 kB\n')
        with self.assertRaisesRegex(ValueError, 'HOST_BUDGET'):
            with f.gate.admission():f.gate.check_headroom()

    def test_last_inventory_drift_refuses_without_mutating_retained_journal(self):
        import inspect
        f = self.f; inventory = f.gate.native.inventory; path = f.control / 'operations/operations.json'
        before = path.read_bytes(); changed = []
        def late_inventory(*args, **kwargs):
            if inspect.currentframe().f_back.f_code.co_name == 'check_headroom' and not changed:
                row = f.native.row('3' * 64, 'late-peer', 125, 512, {'reverie.worker': 'other'})
                f.kernel(row); f.native.rows.append(row); changed.append(True)
            return inventory(*args, **kwargs)
        with patch.object(f.gate.native, 'inventory', new=late_inventory), \
             self.assertRaisesRegex(ValueError, 'NATIVE_INVENTORY_CHANGED'):
            with f.gate.admission():f.gate.check_headroom()
        self.assertTrue(changed); self.assertEqual(path.read_bytes(), before)
