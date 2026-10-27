"""Real installer/broker adapters over owned kernel files and engine metadata."""
import json
import os
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

from reverie import worker_resource_reservations as R
from reverie.worker import Broker
from reverie.worker_capacity_policy import legacy_headroom_fits
from reverie.worker_service import WorkerService
from tests import test_worker_resource_reservations as fixture


class CapacityAdapters(unittest.TestCase):
    def setUp(self):
        self.f = fixture.Reservations(); self.f.setUp(); self.addCleanup(self.f.doCleanups)
        f = self.f
        Path(f.config['scratchRoot']).chmod(0o700)
        directory = f.root / 'policy'; directory.mkdir(mode=0o700)
        self.path = directory / 'broker.json'
        self.service = WorkerService(self.path, home=f.root / 'owner', run=self.run_metadata)
        self.calls = []
        env = patch.dict(os.environ, {'DOCKER_HOST': '', 'DOCKER_CONTEXT': ''})
        env.start(); self.addCleanup(env.stop)
        self.write()

    def write(self):
        self.path.write_text(json.dumps(self.f.config)); self.path.chmod(0o600)

    def run_metadata(self, args):
        self.calls.append(args)
        if args[:3] == ['docker', 'context', 'inspect']:
            return subprocess.CompletedProcess(args, 0, json.dumps('unix:///owned-fixture.sock'), '')
        if args[:2] == ['docker', 'info']:
            value = dict(OSType='linux', KernelVersion=os.uname().release, CgroupVersion='2',
                         MemoryLimit=True, SwapLimit=True, PidsLimit=True, MemTotal=16*1024**3)
            return subprocess.CompletedProcess(args, 0, json.dumps(value), '')
        if args[0] == 'docker':return self.f.native.run_engine(args[1:])
        raise AssertionError('Only fixed read-only engine metadata is a test port')

    def preflight(self, *, installing=True):
        return self.service.positive_preflight(check_manager=False, installing=installing)

    def test_explicit_native_policy_can_accept_where_legacy_margin_refuses(self):
        f = self.f; f.config['poolMemoryMiB'] = 14336; self.write()
        self.assertFalse(legacy_headroom_fits(14336*R.MIB, 16*1024**3))
        before = (f.control / 'operations/operations.json').read_bytes()
        self.assertEqual(self.preflight()['poolMemoryMiB'], 14336)
        self.assertEqual((f.control / 'operations/operations.json').read_bytes(), before)
        self.assertTrue(all(a[0] == 'docker' and a[1] in ('context','info','ps','inspect') for a in self.calls))

    def test_first_install_probe_never_fabricates_ready_or_writes_marker(self):
        f = self.f; R.marker(f.config).unlink()
        before = (f.control / 'operations/operations.json').read_bytes()
        with patch.object(R.ReservationGate, '__init__', side_effect=AssertionError('no fabricated READY gate')):
            self.preflight()
        self.assertFalse(R.marker(f.config).exists()); self.assertFalse(R.pending(f.config).exists())
        self.assertEqual((f.control / 'operations/operations.json').read_bytes(), before)

    def test_explicit_missing_website_root_or_finite_ancestor_never_uses_legacy(self):
        f = self.f
        for mutation in ('website', 'root', 'ancestor'):
            with self.subTest(mutation=mutation):
                if mutation == 'website':
                    old = f.native.rows.pop()
                    try:
                        with self.assertRaisesRegex(ValueError, 'WEBSITE_BINDING'):self.preflight()
                    finally:f.native.rows.append(old)
                elif mutation == 'root':
                    path = f.cgroup / 'memory.current'; path.write_text('1\n')
                    try:
                        with self.assertRaisesRegex(ValueError, 'HOST_HIERARCHY'):self.preflight()
                    finally:path.unlink()
                else:
                    path = f.cgroup / 'fixture-124/memory.max'; old = path.read_text(); path.write_text('max\n')
                    try:
                        with self.assertRaises(ValueError):self.preflight()
                    finally:path.write_text(old)

    def test_start_keeps_unknown_source_fence_but_install_acceptance_refuses(self):
        f = self.f; view = f.claim(); ledger = f.control / 'operations/operations.json'; before = ledger.read_bytes()
        f.employee.update(desiredRunning=False, onVacation=True); f.company()
        f.native.rows[0]['State'].update(Running=False, Pid=0)
        self.preflight(installing=False)
        with self.assertRaises(ValueError):self.preflight(installing=True)
        self.assertEqual(ledger.read_bytes(), before)
        self.assertIn(view['operation']['reserved_sid'], f.gate.cold_inspect()['fencedSids'])

    def test_removed_option_does_not_revert_existing_marker_to_legacy(self):
        self.f.config.pop('resourceReservations'); self.write()
        with self.assertRaisesRegex(ValueError, 'POLICY_REMOVED'):self.preflight()

    def test_preprovision_inventory_drift_refuses_without_marker(self):
        f = self.f; R.marker(f.config).unlink(); capacity = R.NativeObserver.capacity; changed = []
        def change(native, rows, selected):
            result = capacity(native, rows, selected)
            if not changed:
                changed.append(True)
                row = f.native.row('3'*64, 'new-fixture-peer', 125, 512, {'reverie.worker':'other'})
                f.kernel(row); f.native.rows.append(row)
            return result
        with patch.object(R.NativeObserver, 'capacity', new=change), self.assertRaisesRegex(ValueError, 'inventory changed'):
            self.preflight()
        self.assertFalse(R.marker(f.config).exists())

    def second_capacity_drift(self, mutation):
        f = self.f; R.marker(f.config).unlink(); capacity = R.NativeObserver.capacity; calls = []
        ledger = f.control / 'operations/operations.json'; before = ledger.read_bytes()
        def change(native, rows, selected):
            result = capacity(native, rows, selected); calls.append(result[0])
            if len(calls) == 2:
                if mutation == 'peer':
                    row = f.native.row('3'*64, 'late-overpool-peer', 125, 8192, {'reverie.worker':'other'})
                    f.kernel(row); f.native.rows.append(row)
                else:
                    f.native.rows[1]['HostConfig'].update(Memory=64*1024**3, MemorySwap=64*1024**3)
            return result
        with patch.object(R.NativeObserver, 'capacity', new=change), self.assertRaisesRegex(ValueError, 'inventory changed'):
            self.preflight()
        self.assertEqual(len(calls), 2)  # No recursive capacity/kernel loop after the final engine bracket.
        self.assertFalse(R.marker(f.config).exists()); self.assertFalse(R.pending(f.config).exists())
        self.assertEqual(ledger.read_bytes(), before)

    def test_peer_published_inside_second_capacity_cannot_receive_install_acceptance(self):
        self.second_capacity_drift('peer')

    def test_website_drift_inside_second_capacity_cannot_receive_install_acceptance(self):
        self.second_capacity_drift('website')

    def broker(self):
        f = self.f; broker = Broker.__new__(Broker)
        broker.config = f.config; broker.laptops = {}; broker.resource_reservations = f.gate
        def metadata(args, optional=False):
            if args[0] == 'inspect' and '--format' not in args:
                rows = [r for r in f.native.rows if r['Name'] == '/'+args[1]]
                return subprocess.CompletedProcess(args, 0 if rows else 1, json.dumps(rows), '')
            return f.native.run_engine(args, optional=optional)
        broker.run_engine = metadata
        return broker

    def test_runtime_creation_uses_same_policy_once_and_keeps_worker_count_limit(self):
        f = self.f; f.config['poolMemoryMiB'] = 14336
        broker = self.broker(); resources = dict(f.config, memoryMiB=4096)
        with patch.object(f.gate, 'check_creation', wraps=f.gate.check_creation) as check:
            with f.gate.admission():broker.check_creation_budget(fixture.TARGET, resources, proc_root=f.proc)
        self.assertEqual(check.call_count, 1)
        broker.config['maxWorkers'] = 1
        with patch.object(f.gate, 'check_creation', side_effect=AssertionError('capacity must refuse first')):
            with self.assertRaisesRegex(RuntimeError, 'capacity is full'):
                broker.check_creation_budget(fixture.TARGET, resources, proc_root=f.proc)

    def test_runtime_explicit_refusal_cannot_fall_back_to_legacy(self):
        f = self.f; broker = self.broker(); resources = dict(f.config, memoryMiB=4096)
        (f.proc / 'meminfo').write_text('MemTotal: 16777216 kB\nMemAvailable: 1 kB\n')
        with f.gate.admission(), self.assertRaisesRegex(ValueError, 'HOST_BUDGET'):
            broker.check_creation_budget(fixture.TARGET, resources, proc_root=f.proc)
