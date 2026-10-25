"""Bounded fake-root installation; no real service, engine or privileged action."""
import copy
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from reverie.cleanup import host_install as H

EID = '11111111-1111-4111-8111-111111111111'
SID = '22222222-2222-4222-8222-222222222222'


class TrustTests(unittest.TestCase):
    def test_fixed_tool_capture_limits_combined_output_and_execution_time(self):
        with self.assertRaisesRegex(ValueError, 'combined output'):
            H.command([sys.executable, '-I', '-c', 'import sys; sys.stdout.write("x"*160); sys.stdout.flush(); sys.stderr.write("y"*160)'], limit=256)
        with self.assertRaisesRegex(ValueError, 'execution time'):
            H.command([sys.executable, '-I', '-c', 'import time; time.sleep(3)'], timeout=0.05)
        result = H.command([sys.executable, '-I', '-c', 'print("bounded metadata")'])
        self.assertEqual(result.returncode, 0); self.assertEqual(result.stdout, 'bounded metadata\n')

    def test_full_parent_chain_rejects_writable_or_symlinked_components(self):
        for bad in ('writable', 'symlink', 'owner'):
            with self.subTest(bad=bad):
                def metadata(path):
                    mode, uid = stat.S_IFDIR | 0o755, 0
                    if path == Path('/protected'):
                        if bad == 'writable': mode |= 0o020
                        if bad == 'symlink': mode = stat.S_IFLNK | 0o777
                        if bad == 'owner': uid = 1234
                    return SimpleNamespace(st_mode=mode, st_uid=uid)
                with patch.object(Path, 'lstat', autospec=True, side_effect=metadata):
                    with self.assertRaises(ValueError): H.protected_chain('/protected/state', missing=True)

    def test_nix_store_tool_symlinks_are_resolved_but_not_allowed_to_escape(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            base = root / 'store/abc-tools'; (base / 'bin').mkdir(parents=True)
            binary = base / 'bin/tool'; binary.write_text('fixture'); binary.chmod(0o555)
            link = base / 'bin/alias'; link.symlink_to('tool')
            original = Path.lstat
            def metadata(path):
                st = original(path)
                values = list(st); values[4] = 0
                return os.stat_result(values)
            with patch.object(H, 'STORE', root / 'store'), patch.object(H, 'protected_chain', side_effect=lambda p: Path(p)), patch.object(Path, 'lstat', autospec=True, side_effect=metadata):
                self.assertEqual(H.immutable(link), binary)
                link.unlink(); link.symlink_to('/bin/sh')
                with self.assertRaises(ValueError): H.immutable(link)


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.state = self.root / 'protected-state'
        self.units = self.root / 'units'; self.units.mkdir()
        self.package = self.root / 'store/package'
        self.closure = self.root / 'store/installer'
        (self.package / 'libexec/reverie').mkdir(parents=True)
        (self.package / 'bin').mkdir()
        (self.package / 'bin/reverie-prune').write_text('immutable wrapper fixture')
        (self.closure / 'bin').mkdir(parents=True)
        (self.closure / 'bin/reverie-prune-host').write_text('immutable installer fixture')
        source = Path(H.__file__).parent
        for name in H.SOURCE_HASHES:
            (self.package / 'libexec/reverie' / name).write_bytes((source / name).read_bytes())
        self.b = self.root / 'B'; (self.b / 'laptops/employees' / EID / 'tmp').mkdir(parents=True)
        self.employees = self.root / 'employees'
        self.home = self.employees / EID / 'home'; self.home.mkdir(parents=True)
        self.leases = self.home / '.local/state/reverie/leases'; self.leases.mkdir(parents=True, mode=0o700)
        self.settings = {'version': 1, 'deployment': 'fixture', 'b_mount': str(self.b), 'laptops_root': 'laptops/employees',
                         'laptop_home_root': str(self.employees), 'employee_ids': [EID],
                         'laptop_uid': os.getuid() or 1000, 'laptop_gid': os.getgid() or 1000}
        self.input = self.root / 'deployment-input.json'; self.write_input()
        self.row = {'id': 'a' * 64, 'name': '/fixture-agent-' + SID,
                    'labels': {'reverie.worker': 'fixture', 'reverie.session': SID},
                    'user': f"{self.settings['laptop_uid']}:{self.settings['laptop_gid']}", 'running': True, 'pid': 77777,
                    'mounts': [{'Type': 'bind', 'RW': True, 'Destination': '/home/agent', 'Source': str(self.home)},
                               {'Type': 'bind', 'RW': True, 'Destination': '/tmp', 'Source': str(self.b / 'laptops/employees' / EID / 'tmp')}]}
        self.calls = []
        self.docker_config = self.root / 'empty-docker-config'; self.docker_config.mkdir()
        self.installer = H.Installer(self.state, self.package, self.root / 'store/python/bin/python3',
                                     self.root / 'store/docker/bin/docker', self.root / 'store/systemd/bin/systemctl',
                                     self.root / 'store/nix/bin/nix-store', self.closure, run=self.fake_run)
        def trusted(path, **_):
            path = Path(path)
            if not path.is_relative_to(self.root): raise AssertionError('Fixture attempted a host path')
            for item in [*reversed(path.parents), path]:
                if item.is_relative_to(self.root) and item.is_symlink(): raise ValueError('Symlink in fixture protected chain')
            return path
        for target in (patch.object(H, 'immutable', side_effect=lambda p, **_: Path(p)),
                       patch.object(H, 'protected_chain', side_effect=trusted),
                       patch.object(H.os.path, 'ismount', return_value=True),
                       patch.object(H.os, 'access', return_value=True), patch.object(H, 'UNITS', self.units)):
            target.start(); self.addCleanup(target.stop)

    def write_input(self):
        self.input.write_text(json.dumps(self.settings)); self.input.chmod(0o600)

    def fake_run(self, args):
        self.calls.append(args)
        code, output = 0, ''
        if args[0].endswith('systemd-detect-virt'): code = 1
        elif 'show' in args:
            output = 'LoadState=not-found\nActiveState=inactive\nSubState=dead\nFragmentPath=\n'
            if args[-1] == H.SERVICE: output += 'MainPID=0\nControlPID=0\n'
        elif 'ps' in args: output = self.row['id'] + '\n'
        elif 'inspect' in args: output = json.dumps(self.row) + '\n'
        elif '--add-root' in args:
            Path(args[args.index('--add-root') + 1]).symlink_to(self.closure)
        return subprocess.CompletedProcess(args, code, output, '')

    def test_preparation_is_read_only_and_renders_fixed_dry_run_units(self):
        plan, checksum = self.installer.prepare(self.input)
        self.assertFalse(self.state.exists()); self.assertEqual(self.calls, [])
        self.assertEqual(len(checksum), 64); self.assertFalse(plan['starts_units'])
        self.assertFalse(plan['units_survive_reboot']); self.assertEqual(plan['unit_directory'], str(self.units))
        config = self.installer.config_text(plan['settings'])
        self.assertIn('live_enabled = false', config)
        self.assertIn('--inventory', config)
        service, timer = self.installer.units(plan['settings'])
        self.assertIn('--dry-run', service); self.assertNotIn('--live', service)
        self.assertIn('TimeoutStartSec=600', service); self.assertIn('PrivateTmp=false', service)
        self.assertIn('Persistent=false', timer)

    def test_apply_requires_real_explicit_host_root_before_any_mutation(self):
        with patch.object(H.os, 'geteuid', return_value=1234):
            with self.assertRaisesRegex(ValueError, 'root'): self.installer.apply(self.input, 'x')
        self.assertFalse(self.state.exists()); self.assertEqual(self.calls, [])

    def test_refuses_live_settings_arbitrary_inventory_and_unknown_keys(self):
        for extra in ({'live_enabled': True}, {'live_enabled': 'false'}, {'laptops_cmd': ['/bin/sh', '-c', 'bad']},
                      {'lease_lib': '/agent/chosen.py'}, {'version': True}):
            with self.subTest(extra=extra):
                original = copy.deepcopy(self.settings); self.settings.update(extra); self.write_input()
                with self.assertRaises(ValueError): self.installer.prepare(self.input)
                self.settings = original
        self.assertFalse(self.state.exists()); self.assertEqual(self.calls, [])

    def test_owner_review_digest_binds_the_exact_configuration(self):
        _, checksum = self.installer.prepare(self.input)
        self.settings['cadence'] = 'daily'; self.write_input()
        with patch.object(H.os, 'geteuid', return_value=0):
            with self.assertRaisesRegex(ValueError, 'digest changed'): self.installer.apply(self.input, checksum)
        self.assertFalse(self.state.exists())

    def test_container_root_is_not_host_administrator_activation(self):
        _, checksum = self.installer.prepare(self.input)
        self.installer.run = lambda args: subprocess.CompletedProcess(args, 0, '', '')
        with patch.object(H.os, 'geteuid', return_value=0):
            with self.assertRaisesRegex(ValueError, 'container root'): self.installer.apply(self.input, checksum)
        self.assertFalse(self.state.exists())

    def test_active_cleanup_is_refused_without_stopping_it(self):
        _, checksum = self.installer.prepare(self.input)
        original = self.installer.run
        self.installer.run = lambda args: subprocess.CompletedProcess(args, 0, 'LoadState=loaded\nActiveState=active\nSubState=running\nFragmentPath=\nMainPID=123\nControlPID=0\n', '') if 'show' in args else original(args)
        with patch.object(H.os, 'geteuid', return_value=0):
            with self.assertRaisesRegex(ValueError, 'inactive/dead'): self.installer.apply(self.input, checksum)
        self.assertFalse(self.state.exists()); self.assertFalse(any('stop' in a for a in self.calls))

    def test_activating_oneshot_and_ambiguous_states_refuse_before_writes(self):
        _, checksum = self.installer.prepare(self.input)
        original = self.installer.run
        for state, substate, pid in [('activating', 'start', 123), ('deactivating', 'stop', 123),
                                     ('reloading', 'reload', 123), ('inactive', 'dead', 123), ('unknown', 'dead', 0)]:
            with self.subTest(state=state, pid=pid):
                output = f'LoadState=loaded\nActiveState={state}\nSubState={substate}\nFragmentPath=\nMainPID={pid}\nControlPID=0\n'
                self.installer.run = lambda args: subprocess.CompletedProcess(args, 0, output, '') if 'show' in args else original(args)
                with patch.object(H.os, 'geteuid', return_value=0):
                    with self.assertRaisesRegex(ValueError, 'inactive/dead'): self.installer.apply(self.input, checksum)
                self.assertFalse(self.state.exists()); self.assertEqual(list(self.units.iterdir()), [])

    def test_inactive_units_from_another_installation_cannot_be_shadowed(self):
        _, checksum = self.installer.prepare(self.input)
        original = self.installer.run
        output = 'LoadState=loaded\nActiveState=inactive\nSubState=dead\nFragmentPath=/other/unit.service\nMainPID=0\nControlPID=0\n'
        self.installer.run = lambda args: subprocess.CompletedProcess(args, 0, output, '') if 'show' in args else original(args)
        with patch.object(H.os, 'geteuid', return_value=0):
            with self.assertRaisesRegex(ValueError, 'shadow'): self.installer.apply(self.input, checksum)
        self.assertFalse(self.state.exists()); self.assertEqual(list(self.units.iterdir()), [])

    def test_apply_copies_verified_sources_and_installs_without_starting_or_enabling(self):
        _, checksum = self.installer.prepare(self.input)
        with patch.object(H.os, 'geteuid', return_value=0): result = self.installer.apply(self.input, checksum)
        self.assertEqual(result['status'], 'INSTALLED_INACTIVE'); self.assertFalse(result['timer_enabled'])
        self.assertEqual(self.installer.check()['employee_ids'], [EID])
        self.assertEqual(H.digest((self.state / 'lib/lease.py').read_bytes()), H.SOURCE_HASHES['lease.py'])
        self.assertTrue((self.units / H.SERVICE).is_file()); self.assertTrue((self.units / H.TIMER).is_file())
        self.assertFalse(any('start' in a or 'enable' in a or '--now' in a for a in self.calls))
        self.assertTrue(any('daemon-reload' in a for a in self.calls))

    def test_timer_enablement_is_explicit_and_never_starts_it(self):
        _, checksum = self.installer.prepare(self.input)
        with patch.object(H.os, 'geteuid', return_value=0): self.installer.apply(self.input, checksum, enable_timer=True)
        self.assertTrue(any(a[-3:] == ['enable', '--runtime', H.TIMER] for a in self.calls))
        self.assertFalse(any('start' in a or '--now' in a for a in self.calls))

    def test_changed_installed_code_or_live_config_is_refused(self):
        _, checksum = self.installer.prepare(self.input)
        with patch.object(H.os, 'geteuid', return_value=0): self.installer.apply(self.input, checksum)
        target = self.state / 'prune.toml'; target.chmod(0o600)
        target.write_text(target.read_text().replace('live_enabled = false', 'live_enabled = true'))
        with self.assertRaisesRegex(ValueError, 'changed'): self.installer.check()

    def test_inventory_validates_employee_mounts_and_host_pid_and_reads_no_environment(self):
        settings = H.policy(self.settings, self.state)
        self.assertEqual(H.inventory(settings, self.installer.paths['docker'], config_dir=self.docker_config, run=self.fake_run), [{'id': EID, 'init_pid': 77777}])
        self.assertNotIn('.Config.Env', str(self.calls)); self.assertNotIn('.Config.Cmd', str(self.calls))
        self.row['mounts'][1]['Source'] = str(self.home)
        with self.assertRaises(ValueError): H.inventory(settings, self.installer.paths['docker'], config_dir=self.docker_config, run=self.fake_run)
        self.row['mounts'][1]['Source'] = str(self.b / 'laptops/employees' / EID / 'tmp'); self.row['pid'] = 0
        with self.assertRaises(ValueError): H.inventory(settings, self.installer.paths['docker'], config_dir=self.docker_config, run=self.fake_run)

    def test_inventory_failure_is_not_an_empty_fleet(self):
        with self.assertRaises(ValueError):
            H.inventory(H.policy(self.settings, self.state), self.installer.paths['docker'], config_dir=self.docker_config,
                        run=lambda a: subprocess.CompletedProcess(a, 1, '', 'synthetic private diagnostic'))


if __name__ == '__main__': unittest.main()
