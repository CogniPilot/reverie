"""Owned synthetic files and fixed-port mocks only; never samples host resources."""
import tests  # isolates inherited runtime configuration
import json
import os
from pathlib import Path
import tempfile
import time
import subprocess
import sys
import unittest
from unittest.mock import patch
from reverie.cleanup import collector, collector_user as U

GPU = 'GPU-01234567-89ab-cdef-0123-456789abcdef'
T = 1792940400


class UserHistoryTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='observations-')
        self.addCleanup(temp.cleanup); self.home = Path(temp.name).resolve()
        p = patch.dict(os.environ, {'HOME': str(self.home)}); p.start(); self.addCleanup(p.stop)
        self.config = self.home/'reverie/observations/config.json'
        self.assertEqual(U.main(['--config', str(self.config), 'init']), 0)
        self.cfg = U.configuration(self.config); self.state = U.state_directory(self.cfg)

    def row(self, t, utilization=40, identity=GPU, index=0):
        return {'v': 2, 't': t, 'interval_s': 300, 'cpu_pct': 20, 'mem_pct': 30, 'gpu_pct': utilization,
                'gpu': {'status': 'ok', 'devices': [{'uuid': identity, 'identity_status': 'available' if identity else 'unavailable',
                                                   'index': index, 'util_pct': utilization}]}}

    def write(self, name, rows):
        p = self.state/name; p.write_text(''.join(json.dumps(r)+'\n' for r in rows)); p.chmod(0o600)
        return p

    def unit_metadata(self, suffix):
        target = self.home/'.config/systemd/user'/('reverie-observations.'+suffix)
        return {'LoadState': 'loaded' if target.exists() else 'not-found',
                'FragmentPath': str(target) if target.exists() else '', 'DropInPaths': ''}

    def test_distinct_marker_no_root_adoption_and_idempotent_init_preserves_history(self):
        sample = self.write('samples-2026-10-25.jsonl', [self.row(T)])
        before = sample.read_bytes()
        self.assertEqual(U.main(['--config', str(self.config), 'init']), 0)
        self.assertEqual(sample.read_bytes(), before)
        (self.state/'.reverie-user-observations.json').unlink()
        (self.state/'.reverie-collector-state.json').write_text('root-marker')
        with self.assertRaises(ValueError): U.state_directory(self.cfg, create=True)
        self.assertEqual(sample.read_bytes(), before)

    def test_additive_rollup_preserves_device_identity(self):
        rollup = collector.rollup([self.row(T, 20), self.row(T+300, 60, index=9)], T, 3600, 'hour')
        self.assertEqual(rollup['gpu_pct']['avg'], 40)
        self.assertEqual(rollup['gpu_devices'][0]['util_pct']['avg'], 40)

    def test_fixed_units_are_disabled_until_explicit_control_and_restart_keeps_state(self):
        tools = {'python': '/nix/store/synthetic-python/bin/python3', 'systemctl': '/nix/store/synthetic-systemd/bin/systemctl'}
        with patch.object(U, 'runtime', return_value=tools), patch.object(U, 'unit_metadata', side_effect=self.unit_metadata), patch.object(U.subprocess, 'run') as run:
            self.assertEqual(U.main(['--config', str(self.config), 'install']), 0)
            self.assertEqual(run.call_args.args[0], [tools['systemctl'], '--user', 'daemon-reload'])
            unit = (self.home/'.config/systemd/user/reverie-observations.service').read_text()
            for expected in ['TimeoutStartSec=90', 'MemoryMax=256M', 'MemorySwapMax=0', 'TasksMax=32', 'NoNewPrivileges=yes']:
                self.assertIn(expected, unit)
            self.assertNotIn('sudo', unit); self.assertNotIn('ExecStartPost', unit)
            self.assertEqual(U.main(['--config', str(self.config), 'enable']), 0)
            self.assertEqual(run.call_args.args[0][-3:], ['enable', '--now', 'reverie-observations.timer'])
            self.assertEqual(U.main(['--config', str(self.config), 'stop']), 0)
            self.assertEqual(run.call_args.args[0][-3:], ['stop', 'reverie-observations.timer', 'reverie-observations.service'])

    def test_foreign_replaced_or_missing_units_cannot_be_started_or_enabled(self):
        tools = {'python': '/nix/store/synthetic-python/bin/python3', 'systemctl': '/nix/store/synthetic-systemd/bin/systemctl'}
        with patch.object(U, 'runtime', return_value=tools), patch.object(U, 'unit_metadata', side_effect=self.unit_metadata), patch.object(U.subprocess, 'run') as run:
            self.assertEqual(U.main(['--config', str(self.config), 'start']), 2)
            run.assert_not_called()
            self.assertEqual(U.main(['--config', str(self.config), 'install']), 0)
            self.assertEqual(U.main(['--config', str(self.config), 'start']), 0)
            unit = self.home/'.config/systemd/user/reverie-observations.service'
            unit.write_text('[Service]\nExecStart=/unrelated/program\n')
            run.reset_mock()
            for action in ['start', 'enable', 'stop', 'disable']:
                self.assertEqual(U.main(['--config', str(self.config), action]), 2)
            run.assert_not_called()

    def test_loaded_foreign_fragments_and_dropins_never_receive_mutations(self):
        tools = {'python': '/nix/store/synthetic-python/bin/python3', 'systemctl': '/nix/store/synthetic-systemd/bin/systemctl'}
        with patch.object(U, 'runtime', return_value=tools), patch.object(U, 'unit_metadata', return_value={
             'LoadState': 'loaded', 'FragmentPath': '/foreign/unit.service', 'DropInPaths': ''}), patch.object(U.subprocess, 'run') as run:
            self.assertEqual(U.main(['--config', str(self.config), 'install']), 2)
            run.assert_not_called()
            self.assertFalse((self.config.parent/'.observations-units.json').exists())
        with patch.object(U, 'runtime', return_value=tools), patch.object(U, 'unit_metadata', side_effect=self.unit_metadata), patch.object(U.subprocess, 'run') as run:
            self.assertEqual(U.main(['--config', str(self.config), 'install']), 0)
            run.reset_mock()
            def overridden(suffix): return {**self.unit_metadata(suffix), 'DropInPaths': '/foreign/override.conf'}
            with patch.object(U, 'unit_metadata', side_effect=overridden):
                for action in ['start', 'enable', 'stop', 'disable', 'install']:
                    self.assertEqual(U.main(['--config', str(self.config), action]), 2)
            run.assert_not_called()

    def test_registered_own_stop_and_disable_survive_corrupt_config_and_state(self):
        tools = {'python': '/nix/store/synthetic-python/bin/python3', 'systemctl': '/nix/store/synthetic-systemd/bin/systemctl'}
        with patch.object(U, 'runtime', return_value=tools), patch.object(U, 'unit_metadata', side_effect=self.unit_metadata), patch.object(U.subprocess, 'run') as run:
            self.assertEqual(U.main(['--config', str(self.config), 'install']), 0)
            self.config.write_text('broken config')
            (self.state/'.reverie-user-observations.json').unlink()
            run.reset_mock()
            with patch.object(U, 'configuration', side_effect=AssertionError('must not read damaged config')):
                self.assertEqual(U.main(['--config', str(self.config), 'stop']), 0)
                self.assertEqual(U.main(['--config', str(self.config), 'disable']), 0)
            self.assertEqual(run.call_count, 2)

    def test_fixed_manager_metadata_parser_distinguishes_absent_from_unknown(self):
        class Result:
            returncode = 4
            stdout = 'LoadState=not-found\nFragmentPath=\nDropInPaths=\n'
        with patch.object(U, 'runtime', return_value={'systemctl': '/fixed/systemctl'}), patch.object(U.subprocess, 'run', return_value=Result()) as run:
            self.assertEqual(U.unit_metadata('service')['LoadState'], 'not-found')
            self.assertEqual(run.call_args.args[0][0:4], ['/fixed/systemctl', '--user', 'show', 'reverie-observations.service'])
            Result.stdout += 'LoadState=loaded\n'
            with self.assertRaises(ValueError): U.unit_metadata('service')

    def test_start_waiting_parent_lock_does_not_block_the_actual_sample_entry(self):
        with U.operation(self.config), patch.object(U, 'sample', return_value=0) as sample:
            self.assertEqual(U.main(['--config', str(self.config), 'sample']), 0)
            sample.assert_called_once()

    def test_user_mode_reuses_real_collector_with_no_prune_source_and_private_persistence(self):
        with patch.object(U, 'verify_service'), patch.object(U, 'sibling', return_value=collector), patch.object(collector, 'cpu_times', return_value=((100, 50), 2)), \
             patch.object(collector.time, 'sleep'), patch.object(collector, 'loadavg', return_value={}), \
             patch.object(collector, 'memory', return_value=(25, {'total': 8, 'available': 6})), \
             patch.object(collector, 'gpus', return_value=(None, {'status': 'unavailable', 'devices': []})):
            self.assertEqual(U.sample(self.config, self.cfg), 0)
        for p in self.state.iterdir(): self.assertEqual(p.stat().st_mode & 0o077, 0)
        self.assertFalse((self.state/'producer-receipts.jsonl').exists())

    def test_missing_actual_service_binding_refuses_before_any_sampler(self):
        with patch.object(U, 'verify_service', side_effect=ValueError('unavailable')), patch.object(U, 'sibling') as load:
            with self.assertRaises(ValueError): U.sample(self.config, self.cfg)
            load.assert_not_called()

    def test_fixed_actual_unit_and_kernel_limit_observer_positive_and_drift(self):
        group = '/user.slice/synthetic-observations.service'
        values = {'/proc/self/cgroup': '0::'+group+'\n', **{str(Path('/sys/fs/cgroup')/group.lstrip('/')/n): v for n, v in {
            'memory.max': str(256 << 20), 'memory.swap.max': '0', 'pids.max': '32', 'cpu.max': '50000 100000'}.items()}}
        class Result: stdout = 'MainPID='+str(os.getpid())+'\nControlGroup='+group+'\nTimeoutStartUSec=1min 30s\nTimeoutStopUSec=5s\n'
        with patch.object(U, 'runtime', return_value={'systemctl': '/fixed/systemctl'}), patch.object(U.subprocess, 'run', return_value=Result()), \
             patch.object(Path, 'read_text', autospec=True, side_effect=lambda p: values[str(p)]):
            U.verify_service()
            values[str(Path('/sys/fs/cgroup')/group.lstrip('/')/'memory.max')] = 'max'
            with self.assertRaises(ValueError): U.verify_service()
            values[str(Path('/sys/fs/cgroup')/group.lstrip('/')/'memory.max')] = str(256 << 20)
            values['/proc/self/cgroup'] = '0::/other\n'
            with self.assertRaises(ValueError): U.verify_service()

    def test_retention_is_existing_collector_policy_not_reader_side_deletion(self):
        old = self.write('samples-2020-01-01.jsonl', [self.row(1577836800)])
        new = self.write('samples-2026-10-25.jsonl', [self.row(T)])
        self.assertEqual(collector.retention(str(self.state), {**collector.DEFAULTS, 'retention_days': 30}, T), [old.name])
        self.assertFalse(old.exists()); self.assertTrue(new.exists())


if __name__ == '__main__': unittest.main()
