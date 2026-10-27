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
from reverie.cleanup import collector, collector_user as U, collector_history as H

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

    def test_identity_survives_index_reorder_and_missing_values_stay_gaps(self):
        self.write('samples-2026-10-25.jsonl', [self.row(T, 40, index=7), self.row(T+300, 60, index=0), self.row(T+900, 80, identity=None)])
        result = H.query(self.config, T, T+1200, 'five-minute', GPU, now=T+1200)
        self.assertEqual([p['gpu_pct']['avg'] if p['gpu_pct'] else None for p in result['points']], [40, 60, None, None])
        self.assertEqual([p['status'] for p in result['points']], ['observed', 'observed', 'missing', 'partial'])
        self.assertEqual(result['deviceUUIDs'], [GPU]); self.assertIsNone(result['employeeAttribution'])
        self.assertFalse(result['effectAuthority']); self.assertNotIn(str(self.home), json.dumps(result))

    def test_additive_rollup_preserves_device_identity_and_legacy_older_device_gap(self):
        rollup = collector.rollup([self.row(T, 20), self.row(T+300, 60, index=9)], T, 3600, 'hour')
        self.assertEqual(rollup['gpu_pct']['avg'], 40)
        self.assertEqual(rollup['gpu_devices'][0]['util_pct']['avg'], 40)
        self.write('rollup-hour-2026-10.jsonl', [rollup, {k: v for k, v in {**rollup, 'start': T+3600, 'end': T+7200}.items() if not k.startswith('gpu_') or k == 'gpu_pct'}])
        result = H.query(self.config, T, T+7200, 'hour', GPU, now=T+86400)
        self.assertEqual(result['points'][0]['gpu_pct']['avg'], 40)
        self.assertIsNone(result['points'][1]['gpu_pct'])
        self.assertEqual(result['freshness'], 'missing')

    def test_restart_read_does_not_repair_or_write_and_truncated_record_is_explicit(self):
        file = self.write('samples-2026-10-25.jsonl', [self.row(T)])
        with file.open('a') as f: f.write('{"t":')
        before = {p.name: p.read_bytes() for p in self.state.iterdir()}
        for _ in range(2):
            result = H.query(self.config, T, T+300, 'five-minute', now=T+300)
            self.assertEqual(result['malformedLines'], 1); self.assertEqual(result['freshness'], 'fresh')
        self.assertEqual(before, {p.name: p.read_bytes() for p in self.state.iterdir()})
        self.assertEqual(H.query(self.config, T, T+300, now=T+3600)['freshness'], 'stale')

    def test_read_bounds_and_custody_refuse_links_writable_config_and_invalid_query(self):
        outside = self.home/'outside'; outside.write_text('not history')
        (self.state/'samples-2026-10-25.jsonl').symlink_to(outside)
        with self.assertRaises(ValueError): H.query(self.config, T, T+300, now=T+300)
        (self.state/'samples-2026-10-25.jsonl').unlink()
        for start, end, gpu in [(True, T+300, None), (T, T+401*86400, None), (T, T+300, '../../secret')]:
            with self.assertRaises(ValueError): H.query(self.config, start, end, gpu=gpu, now=T+500*86400)
        self.config.chmod(0o644)
        with self.assertRaises(ValueError): H.query(self.config, T, T+300, now=T+300)

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

    def test_recorded_device_disappearance_in_rollup_remains_partial(self):
        rows = [self.row(T+n*300, identity=GPU if n == 0 else None) for n in range(12)]
        rollup = collector.rollup(rows, T, 3600, 'hour')
        self.write('rollup-hour-2026-10.jsonl', [rollup])
        point = H.query(self.config, T, T+3600, 'hour', GPU, now=T+7200)['points'][0]
        self.assertEqual(point['gpu_pct']['n'], 1)
        self.assertEqual(point['deviceIdentityMissing'], 11)
        self.assertEqual(point['status'], 'partial')

    def test_standalone_path_free_cli_reads_only_the_owned_fixture(self):
        self.write('samples-2026-10-25.jsonl', [self.row(T)])
        result = subprocess.run([sys.executable, '-I', '-B', H.__file__, '--config', str(self.config),
                                 '--start', str(T), '--end', str(T+300), '--resolution', 'five-minute', '--gpu', GPU],
                                env={'HOME': str(self.home), 'LANG': 'C.UTF-8', 'PATH': '/unavailable'},
                                capture_output=True, text=True, timeout=8)
        self.assertEqual(result.returncode, 0, result.stderr)
        value = json.loads(result.stdout)
        self.assertEqual(value['points'][0]['gpu_pct']['avg'], 40)
        self.assertNotIn(str(self.home), result.stdout)

    def test_unrelated_oversized_retained_files_are_not_opened_for_recent_query(self):
        old = self.state/'samples-2026-10-24.jsonl'
        with old.open('wb') as stream: stream.truncate(33 << 20)
        old.chmod(0o600)
        self.write('samples-2026-10-25.jsonl', [self.row(T)])
        real = H.user.private_bytes
        def selected_only(path, *args):
            if path == old: raise AssertionError('Unrelated retained file was opened')
            return real(path, *args)
        with patch.object(H.user, 'private_bytes', side_effect=selected_only):
            value = H.query(self.config, T, T+300, 'five-minute', GPU, now=T+300)
        self.assertEqual(value['points'][0]['gpu_pct']['avg'], 40)
        self.assertEqual(value['lastSampleAt'], T)
        self.assertEqual(value['freshness'], 'fresh')

    def test_historical_device_inventory_and_bounded_latest_freshness_have_separate_scope(self):
        recent_gpu = 'GPU-fedcba98-7654-3210-fedc-ba9876543210'
        self.write('samples-2026-10-24.jsonl', [self.row(T-86400)])
        recent = self.state/'samples-2026-10-25.jsonl'
        with recent.open('wb') as stream:
            stream.truncate(9 << 20); stream.seek(0, 2)
            stream.write(b'\n'+json.dumps(self.row(T, identity=recent_gpu)).encode()+b'\n')
        recent.chmod(0o600)
        real = H.user.private_bytes
        def no_full_freshness(path, *args):
            if path == recent: raise AssertionError('Latest file was read in full for freshness')
            return real(path, *args)
        with patch.object(H.user, 'private_bytes', side_effect=no_full_freshness):
            value = H.query(self.config, T-86400, T-86400+300, 'five-minute', GPU, now=T+300)
        self.assertEqual(value['deviceUUIDs'], [GPU]); self.assertEqual(value['deviceUUIDsScope'], 'queried-records')
        self.assertEqual(value['lastSampleAt'], T); self.assertEqual(value['freshness'], 'fresh')
        self.assertFalse(value['freshnessReadComplete'])

    def test_complete_rollup_and_partial_raw_buckets_are_never_silently_mixed(self):
        first = collector.rollup([self.row(T+n*300, 40) for n in range(12)], T, 3600, 'hour')
        beyond = {**first, 'start': T+3600, 'end': T+7200}
        self.write('rollup-hour-2026-10.jsonl', [first, beyond])
        self.write('samples-2026-10-25.jsonl', [self.row(T+60, 99), self.row(T+3600, 10), self.row(T+4200, 30)])
        value = H.query(self.config, T, T+4500, 'hour', GPU, now=T+4500)
        self.assertEqual([(p['gpu_pct']['avg'], p['samples']) for p in value['points']], [(40, 12), (20, 2)])
        self.assertEqual(value['points'][1]['status'], 'partial')

    def test_legacy_rollup_uses_recorded_raw_uuid_when_available_else_preserves_gap(self):
        legacy = collector.rollup([self.row(T+n*300) for n in range(12)], T, 3600, 'hour')
        del legacy['gpu_devices']
        self.write('rollup-hour-2026-10.jsonl', [legacy])
        raw = self.write('samples-2026-10-25.jsonl', [self.row(T, 5), self.row(T+300, 15)])
        value = H.query(self.config, T, T+3600, 'hour', GPU, now=T+3600)
        self.assertEqual(value['points'][0]['gpu_pct']['avg'], 10)
        self.assertEqual(value['points'][0]['gpu_pct']['n'], 2)
        raw.unlink()
        self.assertIsNone(H.query(self.config, T, T+3600, 'hour', GPU, now=T+3600)['points'][0]['gpu_pct'])


if __name__ == '__main__': unittest.main()
