"""Portable (non-Nix) dry-run installer in a fake root; no real service, engine or privileged action."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from reverie.cleanup import portable_install as P

H = P.H  # the installer's own loaded copy; patch this one, not reverie.cleanup.host_install
EID = '11111111-1111-4111-8111-111111111111'
SID = '22222222-2222-4222-8222-222222222222'
SOURCE = Path(P.__file__).parent


class PortableTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.state = self.root / 'var/lib/reverie-prune'
        self.units = self.root / 'etc/systemd/system'
        self.vendor = self.root / 'usr/local/lib/systemd/system'
        self.runtime = self.root / 'run/systemd/system'; self.runtime.mkdir(parents=True)
        self.prefix = self.root / 'usr/local/lib/reverie-prune'
        self.release = self.prefix / P.RELEASE; self.release.mkdir(parents=True)
        for name, path in (('reverie_prune.py', SOURCE / 'candidate/reverie_prune.py'), ('lease.py', SOURCE / 'lease.py'),
                           ('host_install.py', SOURCE / 'host_install.py'), ('portable_install.py', SOURCE / 'portable_install.py')):
            (self.release / name).write_bytes(path.read_bytes())
        self.bin = self.root / 'usr/bin'; self.bin.mkdir(parents=True)
        for tool in ('python3', 'docker', 'systemctl', 'systemd-detect-virt'):
            (self.bin / tool).write_text('#!fixture ' + tool + '\n'); (self.bin / tool).chmod(0o755)
        self.b = self.root / 'B'; (self.b / 'laptops/employees' / EID / 'tmp').mkdir(parents=True)
        self.employees = self.root / 'employees'
        self.home = self.employees / EID / 'home'; self.home.mkdir(parents=True)
        self.leases = self.home / '.local/state/reverie/leases'; self.leases.mkdir(parents=True, mode=0o700)
        self.settings = {'version': 1, 'deployment': 'fixture', 'b_mount': str(self.b), 'laptops_root': 'laptops/employees',
                         'laptop_home_root': str(self.employees), 'employee_ids': [EID],
                         'laptop_uid': os.getuid() or 1000, 'laptop_gid': os.getgid() or 1000,
                         'root_identities': {str(self.b): {'source': '/dev/fixture1', 'fstype': 'ext4', 'mount_root': '/'}}}
        self.input = self.root / 'prune.json'; self.write_input()
        self.row = {'id': 'a' * 64, 'name': '/fixture-agent-' + SID,
                    'labels': {'reverie.worker': 'fixture', 'reverie.session': SID},
                    'user': f"{self.settings['laptop_uid']}:{self.settings['laptop_gid']}", 'running': True, 'pid': 77777,
                    'mounts': [{'Type': 'bind', 'RW': True, 'Destination': '/home/agent', 'Source': str(self.home)},
                               {'Type': 'bind', 'RW': True, 'Destination': '/tmp', 'Source': str(self.b / 'laptops/employees' / EID / 'tmp')}]}
        self.calls, self.container_rc, self.unit_state = [], 1, 'not-found'
        self.manager_paths = [str(self.units), str(self.runtime), str(self.vendor)]
        self.fragment_override = None
        self.dropins = ''

        def trusted(path, **_):
            path = Path(path)
            if not path.is_relative_to(self.root): raise AssertionError('Fixture attempted a host path')
            for item in [*reversed(path.parents), path]:
                if item.is_relative_to(self.root) and item.is_symlink(): raise ValueError('Symlink in fixture protected chain')
                if item.is_relative_to(self.root) and item.exists() and item.lstat().st_mode & 0o022:
                    raise ValueError('Writable fixture protected chain')
            return path
        def trusted_alias(path):
            # This owned fake root models root UID for the pre-existing suite.
            # Real alias-owner refusal is independently checked in ProgramTrustTests.
            trusted(path.parent)
            if not path.is_symlink(): trusted(path)
            return path
        for target in (patch.object(H, 'protected_chain', side_effect=trusted),
                       patch.object(P, 'given_program_path', side_effect=trusted_alias),
                       patch.object(H.os.path, 'ismount', return_value=True),
                       patch.object(H.os, 'access', return_value=True),
                       patch.object(P, 'UNITS', self.units), patch.object(P, 'UNIT_DIRS', (self.units, self.vendor)),
                       patch.object(P, 'RUNTIME_UNITS', self.runtime)):
            target.start(); self.addCleanup(target.stop)
        self.installer = self.make()

    def write_input(self):
        if self.input.exists(): self.input.chmod(0o600)
        self.input.write_text(json.dumps(self.settings)); self.input.chmod(0o600)

    def make(self):
        return P.PortableInstaller(self.state, self.prefix, self.bin / 'python3', self.bin / 'docker', self.bin / 'systemctl',
                                   run=self.fake_run)

    def fake_run(self, args):
        self.calls.append(args)
        code, output = 0, ''
        if args[0].endswith('systemd-detect-virt'): code = self.container_rc
        elif args[-2:] == ['--property=UnitPath', '--value']:
            output = ' '.join(self.manager_paths) + '\n'
        elif 'show' in args:
            name = args[-1]
            fragment = self.fragment_override if self.fragment_override is not None else str(self.installer.unit_dir / name)
            values = dict(LoadState=self.unit_state, ActiveState='inactive', SubState='dead',
                          FragmentPath=fragment if self.unit_state == 'loaded' else '',
                          DropInPaths=self.dropins, MainPID='0', ControlPID='0')
            output = ''.join(key + '=' + values[key] + '\n' for key in
                             [arg.split('=', 1)[1] for arg in args if arg.startswith('--property=')])
        elif 'daemon-reload' in args:
            self.unit_state = 'loaded'
        elif 'ps' in args: output = self.row['id'] + '\n'
        elif 'inspect' in args: output = json.dumps(self.row) + '\n'
        return subprocess.CompletedProcess(args, code, output, '')

    def install(self, **kwargs):
        _, checksum = self.installer.prepare(self.input)
        with patch.object(P.os, 'geteuid', return_value=0):
            return self.installer.apply(self.input, checksum, **kwargs)

    def test_prepare_is_read_only_and_renders_persistent_dry_run_units_without_nix(self):
        plan, checksum = self.installer.prepare(self.input)
        self.assertFalse(self.state.exists()); self.assertFalse(self.units.exists())
        self.assertEqual(self.calls, [[str(self.bin / 'systemctl'), 'show', '--property=UnitPath', '--value']])
        self.assertEqual(len(checksum), 64)
        self.assertTrue(plan['units_survive_reboot']); self.assertFalse(plan['starts_units']); self.assertFalse(plan['live_prune_qualified'])
        self.assertEqual(plan['unit_directory'], str(self.units))
        self.assertEqual(set(plan['bindings']), set(P.BINDINGS))
        service, timer = self.installer.units(plan['settings'])
        self.assertTrue(service.startswith(P.MARKER)); self.assertTrue(timer.startswith(P.MARKER))
        self.assertNotIn('/nix/store', service + timer + self.installer.config_text(plan['settings']))
        self.assertIn(f'"{self.release / "reverie_prune.py"}"', service)
        self.assertIn('"--dry-run"', service); self.assertNotIn('--live', service)
        self.assertIn('portable_install.py" "--state-dir"', service); self.assertIn('"--check"', service)
        self.assertIn('RequiresMountsFor=', service); self.assertIn('ProtectSystem=strict', service)
        config = self.installer.config_text(plan['settings'])
        self.assertIn('live_enabled = false', config); self.assertIn('"--inventory"', config)

    def test_apply_installs_inactive_persistent_units_then_check_verifies_everything(self):
        result = self.install()
        self.assertEqual(result['status'], 'INSTALLED_INACTIVE'); self.assertFalse(result['units_started'])
        self.assertFalse(result['timer_enabled']); self.assertTrue(result['units_survive_reboot'])
        self.assertTrue((self.units / H.SERVICE).read_text().startswith(P.MARKER))
        self.assertEqual((self.state / 'lib/lease.py').read_bytes(), (SOURCE / 'lease.py').read_bytes())
        verbs = [c[1] for c in self.calls if c[0].endswith('systemctl')]
        self.assertIn('daemon-reload', verbs); self.assertNotIn('start', verbs); self.assertNotIn('enable', verbs)
        checked = P.PortableInstaller.from_state(self.state, run=self.fake_run)
        self.assertEqual(checked.check()['employee_ids'], [EID])

    def test_enable_timer_refuses_before_effects_until_real_acceptance_workflow_exists(self):
        with self.assertRaisesRegex(ValueError, 'acceptance required'):
            self.install(enable_timer=True)
        self.assertFalse(self.state.exists()); self.assertFalse(self.units.exists())
        self.assertTrue(all(c[1] == 'show' for c in self.calls))

    def test_check_refuses_every_post_install_change(self):
        def tamper_unit(): (self.units / H.SERVICE).write_text(P.MARKER + 'ExecStart=/bin/sh\n')
        def tamper_config(): (self.state / 'prune.toml').write_text((self.state / 'prune.toml').read_text().replace('live_enabled = false', 'live_enabled = true'))
        def tamper_release():
            path = self.release / 'reverie_prune.py'; path.chmod(0o644); path.write_bytes(path.read_bytes() + b'\n')
        def tamper_lease(): path = self.state / 'lib/lease.py'; path.chmod(0o644); path.write_bytes(path.read_bytes() + b'#')
        for name, tamper, message in (('unit', tamper_unit, 'changed'),
                                      ('config', tamper_config, 'changed|dry-run'), ('release', tamper_release, 'hash'),
                                      ('lease', tamper_lease, 'changed')):
            with self.subTest(name=name):
                self.setUp(); self.install(); tamper()
                with self.assertRaisesRegex(ValueError, message):
                    P.PortableInstaller.from_state(self.state, run=self.fake_run).check()

    def test_pins_refuse_a_changed_release_file_and_a_symlinked_one(self):
        path = self.release / 'lease.py'; path.write_bytes(path.read_bytes() + b'\n')
        with self.assertRaisesRegex(ValueError, 'hash'): self.installer.prepare(self.input)
        self.setUp()
        target = self.release / 'host_install.py'; data = target.read_bytes(); target.unlink()
        (self.root / 'elsewhere.py').write_bytes(data); target.symlink_to(self.root / 'elsewhere.py')
        with self.assertRaisesRegex(ValueError, 'Symlink'): self.installer.prepare(self.input)

    def test_bindings_must_be_executable_regular_files_and_are_recorded_resolved(self):
        (self.bin / 'docker').chmod(0o644)
        with self.assertRaisesRegex(ValueError, 'executable'): self.installer.prepare(self.input)
        self.setUp()
        (self.root / 'usr/libexec').mkdir(parents=True)
        real = self.root / 'usr/libexec/python3.13'; real.write_text('#!real\n'); real.chmod(0o755)
        (self.bin / 'python3').unlink(); (self.bin / 'python3').symlink_to(real)
        plan, _ = self.make().prepare(self.input)
        self.assertEqual(plan['bindings']['python']['resolved'], str(real))
        self.assertEqual(plan['bindings']['python']['path'], str(self.bin / 'python3'))

    def test_apply_refusals_happen_before_any_mutation(self):
        cases = {
            'plan': lambda: None, 'container': lambda: setattr(self, 'container_rc', 0),
            'foreign unit': lambda: (self.units.mkdir(parents=True, exist_ok=True), (self.units / H.SERVICE).write_text('[Unit]\n'),
                                     setattr(self, 'unit_state', 'loaded')),
            'runtime bootstrap unit': lambda: (self.runtime / H.SERVICE).write_text(H.MARKER),
            'lease owner': lambda: self.leases.chmod(0o755),
        }
        for name, arrange in cases.items():
            with self.subTest(name=name):
                self.setUp(); arrange()
                _, checksum = self.installer.prepare(self.input)
                with patch.object(P.os, 'geteuid', return_value=0), self.assertRaises(ValueError):
                    self.installer.apply(self.input, 'x' * 64 if name == 'plan' else checksum)
                self.assertFalse(self.state.exists())
        self.setUp()
        with patch.object(P.os, 'geteuid', return_value=1234), self.assertRaisesRegex(ValueError, 'root'):
            self.installer.apply(self.input, 'x')

    def release_source(self, *, tamper=None, extra=False, consistent=False):
        source = self.root / 'unpacked'; source.mkdir(exist_ok=True)
        sums = []
        for name in P.RELEASE_FILES:
            data = (self.release / name).read_bytes()
            if consistent and name == tamper: data += b'#'  # an attacker who also rewrites SHA256SUMS
            (source / name).write_bytes(data)
            sums.append(f'{H.digest(data)}  {name}')
        if consistent: tamper = None
        if extra: sums.append(f'{"0" * 64}  extra.py')
        if tamper: (source / tamper).write_bytes((source / tamper).read_bytes() + b'#')
        (source / 'SHA256SUMS').write_text('\n'.join(sums) + '\n')
        return source

    def test_release_install_copies_pinned_files_read_only_idempotently_and_never_overwrites(self):
        fresh = self.root / 'opt-prefix'
        with patch.object(P.os, 'geteuid', return_value=0):
            result = P.install_release(self.release_source(), fresh)
            target = fresh / P.RELEASE
            self.assertEqual(result['release'], str(target))
            for name in P.RELEASE_FILES:
                self.assertEqual((target / name).read_bytes(), (self.release / name).read_bytes())
                self.assertEqual((target / name).stat().st_mode & 0o777, 0o444)
            P.install_release(self.release_source(), fresh)  # identical bytes: no-op
            (target / 'lease.py').chmod(0o644); (target / 'lease.py').write_bytes(b'different')
            with self.assertRaisesRegex(ValueError, 'differs'): P.install_release(self.release_source(), fresh)

    def test_release_install_refuses_mismatched_or_unpinned_inputs(self):
        with patch.object(P.os, 'geteuid', return_value=0):
            for kwargs, message in (({'tamper': 'reverie_prune.py'}, 'pinned'), ({'extra': True}, 'exactly'),
                                    ({'tamper': 'lease.py', 'consistent': True}, 'pinned'),
                                    ({'tamper': 'portable_install.py'}, 'pinned|release being installed')):
                with self.subTest(kwargs=kwargs):
                    with self.assertRaisesRegex(ValueError, message):
                        P.install_release(self.release_source(**kwargs), self.root / ('p-' + str(len(kwargs))))

    def test_cli_guards_fixed_bindings(self):
        for argv, message in ((['--check', '--python', '/usr/bin/python3'], 'recorded at install'),
                              (['--state-dir', '/a', '--state-dir', '/b', '--check'], None),
                              (['--config', str(self.input)], 'explicit')):
            with self.subTest(argv=argv):
                if message is None:
                    with self.assertRaises(SystemExit): P.main(argv)
                else:
                    with patch('sys.stderr') as err:
                        self.assertEqual(P.main(argv), 2)
                    self.assertRegex(''.join(c.args[0] for c in err.write.call_args_list), message)


    def test_os_tool_upgrade_is_recorded_as_evidence_not_a_stop(self):
        self.install()
        (self.bin / 'python3').write_text('#!upgraded by the OS package manager\n'); (self.bin / 'python3').chmod(0o755)
        checked = P.PortableInstaller.from_state(self.state, run=self.fake_run)
        checked.check()
        self.assertEqual(checked.binding_changes, ['python'])
        (self.bin / 'docker').chmod(0o777)  # but a group/world-writable tool still refuses (custody is the chain)
        with patch.object(H, 'protected_chain', side_effect=lambda p, **_: (_ for _ in ()).throw(ValueError('writable'))
                          if Path(p) == self.bin / 'docker' else Path(p)):
            with self.assertRaises(ValueError): P.PortableInstaller.from_state(self.state, run=self.fake_run).check()

    def test_units_name_the_given_interpreter_not_its_resolved_target(self):
        (self.root / 'usr/libexec').mkdir(parents=True)
        real = self.root / 'usr/libexec/python3.11'; real.write_text('#!real\n'); real.chmod(0o755)
        (self.bin / 'python3').unlink(); (self.bin / 'python3').symlink_to(real)
        installer = self.make()
        plan, _ = installer.prepare(self.input)
        service, _ = installer.units(plan['settings'])
        self.assertIn(f'ExecStart="{self.bin / "python3"}"', service)
        self.assertNotIn('python3.11', service + installer.config_text(plan['settings']))
        self.assertEqual(plan['bindings']['python']['resolved'], str(real))  # custody still binds the real file

    def test_root_identities_mirror_the_declared_rules_and_reach_prune_toml(self):
        plan, _ = self.installer.prepare(self.input)
        parsed = H.tomllib.loads(self.installer.config_text(plan['settings']))
        self.assertEqual(parsed['root_identities'], {str(self.b): {'fstype': 'ext4', 'mount_root': '/', 'source': '/dev/fixture1'}})
        self.assertIs(parsed['live_enabled'], False)
        for change, message in ((lambda: {'root_identities': {}}, 'approved root identity'),
                                (lambda: {'root_identities': {str(self.b): {'source': 's', 'fstype': 'ext4', 'mount_root': '/sub'}}}, 'full filesystem root'),
                                (lambda: {'root_identities': {str(self.b): {'source': 's', 'fstype': 'ext4'}}}, 'exactly source'),
                                (lambda: {'live_enabled': True}, 'dry-run only'), (lambda: {'live_acceptance': {}}, 'dry-run only')):
            with self.subTest(message=message):
                self.settings = {**self.settings, **change()}; self.write_input()
                with self.assertRaisesRegex(ValueError, message): self.make().prepare(self.input)
                self.setUp()

    def test_loader_refuses_a_tampered_sibling_before_running_any_of_it(self):
        work = self.root / 'loader'; work.mkdir()
        (work / 'portable_install.py').write_bytes((SOURCE / 'portable_install.py').read_bytes())
        marker = self.root / 'marker'
        (work / 'host_install.py').write_bytes((SOURCE / 'host_install.py').read_bytes() + f"\nopen({str(marker)!r}, 'w').write('ran')\n".encode())
        result = subprocess.run([sys.executable, '-I', '-B', str(work / 'portable_install.py'), '--check'],
                                capture_output=True, text=True, timeout=30)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('pinned sha256', result.stderr)
        self.assertFalse(marker.exists())

    def test_loader_refuses_fifo_sibling_without_blocking(self):
        work = self.root / 'fifo-loader'; work.mkdir()
        (work / 'portable_install.py').write_bytes((SOURCE / 'portable_install.py').read_bytes())
        os.mkfifo(work / 'host_install.py')
        result = subprocess.run([sys.executable, '-I', '-B', str(work / 'portable_install.py'), '--check'],
                                capture_output=True, text=True, timeout=3)
        self.assertNotEqual(result.returncode, 0); self.assertIn('not a regular file', result.stderr)

    def test_running_as_root_requires_a_root_controlled_installer_path(self):
        with self.assertRaisesRegex(SystemExit, 'not root-controlled'):
            P._require_root_chain(self.release / 'portable_install.py')  # owned by the test user, not root

    def test_release_install_requires_a_root_controlled_source_directory(self):
        source = self.release_source()
        def chain(path, **_):
            if Path(path) == source: raise ValueError('not root-owned')
            return Path(path)
        with patch.object(P.os, 'geteuid', return_value=0), patch.object(H, 'protected_chain', side_effect=chain):
            with self.assertRaisesRegex(ValueError, 'root-owned'): P.install_release(source, self.root / 'p-src')

    def select_vendor(self):
        self.installer = P.PortableInstaller(self.state, self.prefix, self.bin / 'python3', self.bin / 'docker',
                                             self.bin / 'systemctl', unit_dir=self.vendor, run=self.fake_run)

    def test_explicit_vendor_directory_works_with_immutable_etc_symlink_and_never_changes_it(self):
        target = self.root / 'immutable-system-units'; target.mkdir()
        self.units.parent.mkdir(parents=True); self.units.symlink_to(target, target_is_directory=True)
        self.select_vendor()
        plan, _ = self.installer.prepare(self.input)
        self.assertEqual(plan['unit_directory'], str(self.vendor)); self.assertFalse(self.vendor.exists())
        result = self.install()
        self.assertFalse(result['units_started']); self.assertFalse(result['timer_enabled'])
        self.assertTrue(self.units.is_symlink()); self.assertEqual(list(target.iterdir()), [])
        self.assertTrue((self.vendor / H.SERVICE).is_file())
        restored = P.PortableInstaller.from_state(self.state, run=self.fake_run)
        self.assertEqual(restored.unit_dir, self.vendor); restored.check()

    def test_default_symlink_directory_refuses_without_vendor_fallback(self):
        self.units.parent.mkdir(parents=True); self.units.symlink_to(self.root / 'absent')
        with self.assertRaisesRegex(ValueError, 'Symlink'): self.installer.prepare(self.input)
        self.assertFalse(self.state.exists()); self.assertFalse(self.vendor.exists()); self.assertEqual(self.calls, [])

    def test_closed_unit_directory_choices_and_writable_data_parents_refuse(self):
        with self.assertRaisesRegex(ValueError, 'Choose exactly'):
            P.PortableInstaller(self.state, self.prefix, self.bin / 'python3', self.bin / 'docker',
                                self.bin / 'systemctl', unit_dir=self.root / 'arbitrary', run=self.fake_run)
        self.select_vendor(); self.vendor.parent.mkdir(parents=True); self.vendor.parent.chmod(0o777)
        with self.assertRaisesRegex(ValueError, 'Writable'): self.installer.prepare(self.input)
        self.assertFalse(self.state.exists()); self.assertFalse(self.vendor.exists())

    def test_manager_unit_path_requires_explicit_membership_and_bounded_unambiguous_paths(self):
        self.select_vendor()
        for value in (' '.join(p for p in self.manager_paths if p != str(self.vendor)),
                      str(self.vendor) + ' ' + str(self.vendor), 'relative/path',
                      'x' * 65537, '', ' '.join([str(self.vendor)] + [str(self.root / 'extra' / str(i)) for i in range(128)])):
            with self.subTest(value=value[:80]):
                self.installer.run = lambda args, value=value: subprocess.CompletedProcess(args, 0, value, '')
                with self.assertRaises(ValueError): self.installer.prepare(self.input)
                self.assertFalse(self.state.exists()); self.assertFalse(self.vendor.exists())

    def test_all_manager_paths_refuse_shadow_units_dropins_and_dangling_symlinks(self):
        self.vendor.mkdir(parents=True)
        for name, symlink in ((H.SERVICE, False), (H.TIMER + '.d', False), (H.SERVICE + '.d', True)):
            path = self.vendor / name
            if symlink: path.symlink_to(self.root / 'missing')
            else: path.write_text('foreign')
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'conflict'):
                self.install()
            self.assertFalse(self.state.exists()); path.unlink()

    def test_manager_fragment_and_dropin_metadata_refuse_before_effects(self):
        self.dropins = '/foreign/global.service.d/override.conf'
        with self.assertRaisesRegex(ValueError, 'drop-ins'): self.install()
        self.assertFalse(self.state.exists())
        self.dropins = ''; self.unit_state = 'loaded'; self.fragment_override = str(self.vendor / H.SERVICE)
        with self.assertRaisesRegex(ValueError, 'shadow'): self.install()
        self.assertFalse(self.state.exists())

    def test_post_reload_foreign_fragment_is_failure_not_installed_success(self):
        def run(args):
            result = self.fake_run(args)
            if 'daemon-reload' in args: self.fragment_override = str(self.vendor / H.SERVICE)
            return result
        self.installer.run = run
        with self.assertRaisesRegex(ValueError, 'shadow'): self.install()
        self.assertTrue((self.units / H.SERVICE).is_file())  # Preserve partial-effect evidence.
        self.assertFalse(any(c[1] in ('start', 'enable') for c in self.calls))

    def test_post_reload_program_change_is_failure_and_preserves_written_evidence(self):
        def run(args):
            result = self.fake_run(args)
            if 'daemon-reload' in args:
                file = self.release / 'portable_install.py'; file.write_bytes(file.read_bytes() + b'\n')
            return result
        self.installer.run = run
        with self.assertRaisesRegex(ValueError, 'portable installer changed'): self.install()
        self.assertTrue((self.state / 'install.json').exists())
        self.assertFalse(any(c[1] in ('start', 'enable') for c in self.calls))

    def test_selected_directory_manager_paths_and_code_are_unit_source_bound(self):
        plan, _ = self.installer.prepare(self.input)
        self.select_vendor(); vendor, _ = self.installer.prepare(self.input)
        self.assertNotEqual(plan['unit_source_sha256'], vendor['unit_source_sha256'])
        _, digest = self.installer.prepare(self.input)
        self.manager_paths.reverse()
        with patch.object(P.os, 'geteuid', return_value=0), self.assertRaisesRegex(ValueError, 'digest changed'):
            self.installer.apply(self.input, digest)
        self.assertFalse(self.state.exists())

    def test_check_refuses_changed_manager_search_path_or_live_dropin(self):
        self.install(); checked = P.PortableInstaller.from_state(self.state, run=self.fake_run)
        self.manager_paths.reverse()
        with self.assertRaisesRegex(ValueError, 'directory binding changed'): checked.check()
        self.manager_paths.reverse(); self.dropins = '/foreign/runtime/override.conf'
        with self.assertRaisesRegex(ValueError, 'drop-ins'): checked.check()

    def test_legacy_manifest_without_selected_directory_is_not_adopted(self):
        self.install(); file = self.state / 'install.json'; manifest = json.loads(file.read_text())
        manifest.pop('unit_directory'); file.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, 'migration required'):
            P.PortableInstaller.from_state(self.state, run=self.fake_run)

    def test_check_refuses_unit_source_digest_tampering(self):
        self.install(); file = self.state / 'install.json'; manifest = json.loads(file.read_text())
        manifest['unit_source_sha256'] = '0' * 64; file.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, 'directory binding changed'):
            P.PortableInstaller.from_state(self.state, run=self.fake_run).check()

    def test_duplicate_or_oversized_manager_unit_properties_refuse_before_effects(self):
        original = self.fake_run
        for suffix in ('FragmentPath=/foreign/extra\n', 'x' * 65537):
            def run(args, suffix=suffix):
                result = original(args)
                if args[-1] == H.SERVICE and '--property=LoadState' in args:
                    return subprocess.CompletedProcess(args, 0, result.stdout + suffix, '')
                return result
            self.installer.run = run
            with self.subTest(suffix=suffix[:30]), self.assertRaises(ValueError): self.install()
            self.assertFalse(self.state.exists())

    def test_check_and_inventory_cannot_override_stored_unit_directory(self):
        for mode in ('--check', '--inventory'):
            with patch('sys.stderr') as errors:
                self.assertEqual(P.main([mode, '--state-dir', str(self.state), '--unit-dir', str(self.vendor)]), 2)
            self.assertIn('only the bindings recorded at install', ''.join(call.args[0] for call in errors.write.call_args_list))


class ProgramTrustTests(unittest.TestCase):
    """Read-only actual program positive; all mutation negatives use an owned fake store."""
    def test_existing_nix_program_is_read_only_and_uses_existing_immutable_rule(self):
        interpreter = Path(sys.executable).resolve()
        if not interpreter.is_relative_to(H.STORE):
            self.skipTest('positive requires an actual immutable Nix interpreter')
        try:
            H.immutable(interpreter)
        except (ValueError, OSError):
            # A single-user laptop store is legitimately untrusted by host-root
            # code. Confirm refusal rather than turn that environment into PASS.
            with self.assertRaises((ValueError, OSError)):
                P.program_path(interpreter)
            self.skipTest('root-owned immutable Nix interpreter unavailable; product refusal confirmed')
        self.assertEqual(P.program_path(interpreter), interpreter)
        selected = P.binding(interpreter)
        self.assertEqual(selected['resolved'], str(interpreter)); self.assertEqual(len(selected['sha256']), 64)
        self.assertEqual(P.program_bytes(Path(sys.executable)), interpreter.read_bytes())

    def test_user_owned_given_alias_is_rejected_even_when_target_is_trusted_nix_python(self):
        with tempfile.TemporaryDirectory() as name:
            alias = Path(name).resolve() / 'python3'; alias.symlink_to(Path(sys.executable).resolve())
            with patch.object(H, 'protected_chain', return_value=alias.parent):
                with self.assertRaisesRegex(ValueError, 'Given program leaf'): P.binding(alias)

    def test_root_owned_distro_leaf_alias_keeps_given_path_and_requires_protected_parent(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name).resolve(); program = root / 'python-version'; program.write_bytes(b'owned fixture'); program.chmod(0o755)
            alias = root / 'python3'; alias.symlink_to(program); real_lstat = Path.lstat
            def lstat(path):
                original = real_lstat(path)
                if path == alias:
                    import types
                    return types.SimpleNamespace(st_mode=original.st_mode, st_uid=0)
                return original
            with patch.object(H, 'protected_chain', return_value=root) as custody, patch.object(Path, 'lstat', lstat):
                self.assertEqual(P.given_program_path(alias), alias)
                custody.assert_called_once_with(root)
            with patch.object(H, 'protected_chain', side_effect=ValueError('parent writable')):
                with self.assertRaisesRegex(ValueError, 'parent writable'): P.given_program_path(alias)

    def test_fake_multiuser_store_refuses_foreign_owner_nonsticky_write_and_writable_child(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name).resolve(); store = root / 'nix/store'; output = store / 'hash-program'
            output.mkdir(parents=True); program = output / 'program'; program.write_bytes(b'owned fixture'); program.chmod(0o555)
            store.chmod(0o1775); owners = {}; real_lstat = Path.lstat
            def lstat(path):
                original = real_lstat(path)
                if path.is_relative_to(root):
                    fields = list(original); fields[4] = owners.get(path, 0); fields[5] = 0
                    return os.stat_result(fields)
                return original
            def anchor(path, **kwargs):
                self.assertEqual(path, store.parent); return path
            with patch.object(H, 'STORE', store), patch.object(H, 'protected_chain', side_effect=anchor), patch.object(Path, 'lstat', lstat):
                self.assertEqual(P.program_path(program), program)
                for target, mode, uid in ((store, 0o775, 0), (store, 0o1775, 1000),
                                          (output, 0o777, 0), (program, 0o777, 0)):
                    before = real_lstat(target).st_mode; target.chmod(mode); owners[target] = uid
                    with self.subTest(target=target, mode=oct(mode), uid=uid), self.assertRaises(ValueError): P.program_path(program)
                    target.chmod(before & 0o7777); owners.clear()

    def test_fake_store_allows_root_leaf_alias_but_refuses_parent_symlink_and_escape(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name).resolve(); store = root / 'nix/store'; output = store / 'hash-program'
            output.mkdir(parents=True); program = output / 'program'; program.write_bytes(b'owned'); program.chmod(0o555)
            store.chmod(0o1775); real_lstat = Path.lstat
            def lstat(path):
                original = real_lstat(path)
                if path.is_relative_to(root):
                    fields = list(original); fields[4] = fields[5] = 0; return os.stat_result(fields)
                return original
            with patch.object(H, 'STORE', store), patch.object(H, 'protected_chain', return_value=store.parent), patch.object(Path, 'lstat', lstat):
                alias = output / 'alias'; alias.symlink_to(program)
                self.assertEqual(P.program_path(alias), program)
                parent_alias = store / 'hash-parent'; parent_alias.symlink_to(output, target_is_directory=True)
                with self.assertRaises(ValueError): P.program_path(parent_alias / 'program')
                outside = root / 'outside'; outside.write_bytes(b'outside'); alias.unlink(); alias.symlink_to(outside)
                with self.assertRaises(ValueError): P.program_path(alias)

if __name__ == '__main__':
    unittest.main()
