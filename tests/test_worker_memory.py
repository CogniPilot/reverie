"""Real owned cgroup-file fixtures; no host, engine or agent execution."""
import copy
import json
from pathlib import Path
import shutil
import subprocess
import sys
import unittest
from unittest.mock import patch

from reverie import worker_memory as M
from reverie import worker_resource_reservations as R
from reverie.worker import create_args, validate_config
from reverie.worker_resources import effective_config, policy_digest
from tests import test_worker_resource_reservations as F


class LaptopMemoryTests(unittest.TestCase):
    def setUp(self):
        self.f = F.Reservations()
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        self.config = self.f.config
        self.config.update(laptopSwapPoolMiB=4096, employeeMemoryPolicies={
            F.EID: {'memoryHighMiB': 1024, 'swapMiB': 2048}})
        self.row = self.f.native.rows[0]
        self.row['Config']['Labels']['reverie.worker-policy'] = policy_digest(self.config, F.SID)
        self.row['HostConfig']['MemorySwap'] += 2048 * M.MIB
        self.leaf = self.f.cgroup / 'fixture-123'
        (self.leaf / 'memory.high').write_text('max\n')
        (self.leaf / 'memory.swap.max').write_text(str(2048 * M.MIB) + '\n')
        (self.f.proc / 'meminfo').write_text('MemTotal: 16777216 kB\nMemAvailable: 12582912 kB\nSwapTotal: 8388608 kB\n')
        self.f.native.inspect_container = lambda name: copy.deepcopy(self.row)

    def test_create_uses_exact_ram_plus_swap_and_only_selected_employee(self):
        args = create_args(self.config, F.SID, self.f.root / 'home')[2]
        self.assertEqual(args[args.index('--memory') + 1], '2048m')
        self.assertEqual(args[args.index('--memory-swap') + 1], '4096m')
        self.assertNotIn('--memory-high', args)
        untouched = copy.deepcopy(self.config)
        untouched.pop('employeeMemoryPolicies')
        untouched.pop('laptopSwapPoolMiB')
        self.assertEqual(create_args(self.config, F.TARGET, self.f.root / 'other'),
                         create_args(untouched, F.TARGET, self.f.root / 'other'))
        self.assertEqual(policy_digest(self.config, F.TARGET), policy_digest(untouched, F.TARGET))

    def test_flat_acceptance_projection_matches_the_packaged_broker_policy(self):
        bundle = self.f.root / 'flat-memory'
        bundle.mkdir()
        source = Path(__file__).resolve().parents[1] / 'python/reverie'
        for name in ['worker_resources', 'worker_storage', 'worker_memory']:
            shutil.copyfile(source / (name + '.py'), bundle / (name + '.py'))
        code = """import importlib.util,json,sys
from pathlib import Path
s=importlib.util.spec_from_file_location('fixed_resources',Path(sys.argv[1])/'worker_resources.py')
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
print(json.dumps(m.effective_config(json.load(sys.stdin),sys.argv[2])))
"""
        result = subprocess.run([sys.executable, '-I', '-B', '-c', code, str(bundle), F.SID],
                                input=json.dumps(self.config), capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), effective_config(self.config, F.SID))

    def test_policy_refuses_bad_types_fields_bounds_and_unlimited_ram(self):
        validate_config(self.config)
        for change in [{'memoryHighMiB': True}, {'swapMiB': -1}, {'swapMiB': 4097},
                       {'command': 'not-allowed'}, {'memoryHighMiB': 511}]:
            bad = copy.deepcopy(self.config)
            bad['employeeMemoryPolicies'][F.EID].update(change)
            with self.subTest(change=change), self.assertRaises(ValueError):
                validate_config(bad)
        for memory in [0, 512, 1024]:
            bad = copy.deepcopy(self.config)
            bad.update(budgetMode='pool', memoryMiB=memory)
            with self.subTest(memory=memory), self.assertRaises(ValueError):
                create_args(bad, F.SID, self.f.root / 'home')

    def test_soft_threshold_written_and_all_limits_independently_read_back(self):
        with self.assertRaisesRegex(ValueError, 'SOFT_LIMIT'):
            self.f.gate.native.limits(self.row)
        M.configure_started(self.f.native, self.row['Name'][1:], F.SID, self.row['Id'])
        self.assertEqual((self.leaf / 'memory.high').read_text().strip(), str(1024 * M.MIB))
        memory, observed = self.f.gate.native.limits(self.row)
        self.assertEqual(memory, 2048 * M.MIB)
        self.assertEqual(observed['swapBytes'], 2048 * M.MIB)
        self.assertEqual(observed['memoryHighBytes'], 1024 * M.MIB)

    def test_foreign_identity_or_pid_change_never_writes_soft_limit(self):
        with self.assertRaisesRegex(RuntimeError, 'identity changed'):
            M.configure_started(self.f.native, self.row['Name'][1:], F.SID, '9' * 64)
        self.assertEqual((self.leaf / 'memory.high').read_text(), 'max\n')
        for field, value in [('reverie.session', F.TARGET), ('reverie.worker-policy', '0' * 64)]:
            saved = self.row['Config']['Labels'][field]
            self.row['Config']['Labels'][field] = value
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                M.configure_started(self.f.native, self.row['Name'][1:], F.SID, self.row['Id'])
            self.assertEqual((self.leaf / 'memory.high').read_text(), 'max\n')
            self.row['Config']['Labels'][field] = saved
        original = self.f.native.inspect_container
        calls = 0
        def changed(name):
            nonlocal calls
            calls += 1
            row = original(name)
            if calls > 1:
                row['State']['Pid'] += 1
            return row
        self.f.native.inspect_container = changed
        with self.assertRaisesRegex(RuntimeError, 'identity changed'):
            M.configure_started(self.f.native, self.row['Name'][1:], F.SID, self.row['Id'])
        self.assertEqual((self.leaf / 'memory.high').read_text(), 'max\n')

    def test_missing_or_symlinked_controller_is_not_created_or_followed(self):
        high = self.leaf / 'memory.high'
        high.unlink()
        with self.assertRaises(FileNotFoundError):
            M.configure_started(self.f.native, self.row['Name'][1:], F.SID, self.row['Id'])
        self.assertFalse(high.exists())
        other = self.f.root / 'private-control'
        other.write_text('max\n')
        high.symlink_to(other)
        with self.assertRaises(OSError):
            M.configure_started(self.f.native, self.row['Name'][1:], F.SID, self.row['Id'])
        self.assertEqual(other.read_text(), 'max\n')

    def test_swap_or_ancestor_mismatch_refuses_readback(self):
        M.configure_started(self.f.native, self.row['Name'][1:], F.SID, self.row['Id'])
        (self.leaf / 'memory.swap.max').write_text('0\n')
        with self.assertRaisesRegex(ValueError, 'LIMIT_CONFLICT'):
            self.f.gate.native.limits(self.row)
        (self.leaf / 'memory.swap.max').write_text(str(2048 * M.MIB) + '\n')
        self.row['HostConfig']['MemorySwap'] = -1
        with self.assertRaisesRegex(ValueError, 'FINITE_LIMITS'):
            self.f.gate.native.limits(self.row)

    def test_aggregate_swap_budget_uses_actual_commitments_and_actual_host_capacity(self):
        M.check_swap_budget(self.config, self.f.native.rows, proc=self.f.proc)
        resources = effective_config(self.config, F.SID)
        M.check_swap_budget(self.config, self.f.native.rows, resources, self.f.proc)
        over = dict(self.config, laptopSwapPoolMiB=4095)
        with self.assertRaisesRegex(RuntimeError, 'admission is full'):
            M.check_swap_budget(over, self.f.native.rows, resources, self.f.proc)
        (self.f.proc / 'meminfo').write_text('SwapTotal: 1024 kB\n')
        with self.assertRaisesRegex(RuntimeError, 'actual host swap'):
            M.check_swap_budget(self.config, self.f.native.rows, proc=self.f.proc)

    def test_unknown_or_unbounded_peer_swap_is_refused(self):
        for value in [-1, 0, None, True]:
            rows = copy.deepcopy(self.f.native.rows)
            rows[0]['HostConfig']['MemorySwap'] = value
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                M.check_swap_budget(self.config, rows, proc=self.f.proc)

    def test_reattach_verifies_instead_of_mutating_and_legacy_has_no_new_effect(self):
        with self.assertRaisesRegex(ValueError, 'SOFT_LIMIT'):
            M.verify_running(self.f.native, F.SID, self.row)
        self.assertEqual((self.leaf / 'memory.high').read_text(), 'max\n')
        M.configure_started(self.f.native, self.row['Name'][1:], F.SID, self.row['Id'])
        M.verify_running(self.f.native, F.SID, self.row)
        self.row['Config']['Labels']['reverie.worker'] = 'foreign'
        with self.assertRaisesRegex(RuntimeError, 'identity changed'):
            M.verify_running(self.f.native, F.SID, self.row)
        self.config.pop('employeeMemoryPolicies')
        with patch.object(self.f.native, 'inspect_container', side_effect=AssertionError('no new IO')):
            M.configure_started(self.f.native, 'unused', F.SID)
            M.verify_running(self.f.native, F.SID, {})


class CanonicalMemoryLaunchTests(unittest.TestCase):
    def setUp(self):
        from tests.test_worker_resource_canonical_launch import CanonicalResourceLaunch
        setup = F.Reservations.setUp
        make_row = F.NativeFixture.row
        kernel = F.Reservations.kernel
        def selected(f, **kwargs):
            setup(f, **kwargs)
            f.config.update(laptopSwapPoolMiB=4096, employeeMemoryPolicies={
                F.EID: {'memoryHighMiB': 1024, 'swapMiB': 2048}})
            row = f.native.rows[0]
            row['Config']['Labels']['reverie.worker-policy'] = policy_digest(f.config, F.SID)
            row['HostConfig']['MemorySwap'] += 2048 * M.MIB
            (f.cgroup / 'fixture-123/memory.high').write_text(str(1024 * M.MIB) + '\n')
            (f.cgroup / 'fixture-123/memory.swap.max').write_text(str(2048 * M.MIB) + '\n')
            with (f.proc / 'meminfo').open('a') as out:
                out.write('SwapTotal: 8388608 kB\n')
        def row(native, identity, name, pid, memory, labels):
            result = make_row(native, identity, name, pid, memory, labels)
            if native.config.get('employeeMemoryPolicies') and labels.get('reverie.employee') == F.EID:
                result['HostConfig']['MemorySwap'] += 2048 * M.MIB
            return result
        def controllers(f, record):
            kernel(f, record)
            leaf = f.cgroup / ('fixture-' + str(record['State']['Pid']))
            (leaf / 'memory.high').write_text('max\n')
            (leaf / 'memory.swap.max').write_text(str(
                record['HostConfig']['MemorySwap'] - record['HostConfig']['Memory']) + '\n')
        self.enterContext(patch.object(F.Reservations, 'setUp', selected))
        self.enterContext(patch.object(F.NativeFixture, 'row', row))
        self.enterContext(patch.object(F.Reservations, 'kernel', controllers))
        self.pipeline = CanonicalResourceLaunch()
        self.pipeline.setUp()
        self.addCleanup(self.pipeline.doCleanups)

    def test_real_canonical_launch_sets_high_before_any_agent_child(self):
        pipeline = self.pipeline
        kind, body = pipeline.run_request()
        self.assertEqual(kind, b'E')
        self.assertIn(b'controlled terminal viewer boundary', body)
        self.assertIn('cli-start', pipeline.events)
        leaf = pipeline.f.cgroup / 'fixture-125'
        self.assertEqual((leaf / 'memory.high').read_text().strip(), str(1024 * M.MIB))
        self.assertEqual((leaf / 'memory.swap.max').read_text().strip(), str(2048 * M.MIB))

    def test_controller_write_refusal_prevents_the_agent_child(self):
        import os
        write = os.write
        def refused(fd, raw):
            if Path('/proc/self/fd/' + str(fd)).resolve().name == 'memory.high':
                raise PermissionError('fixture controller is not delegated')
            return write(fd, raw)
        with patch.object(M.os, 'write', side_effect=refused):
            with self.assertRaisesRegex(RuntimeError, 'admission release unconfirmed'):
                self.pipeline.run_request()
        self.assertIn('start-sleeping-container', self.pipeline.events)
        self.assertNotIn('cli-start', self.pipeline.events)
        self.assertNotIn('cli-options', self.pipeline.events)
        self.assertIn('RESOURCE_ADMISSION_RELEASE_UNCONFIRMED', self.pipeline.broker.cleanup_uncertain)


if __name__ == '__main__':
    unittest.main()
