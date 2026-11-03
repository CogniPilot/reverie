"""Fake-root declared setup; no real systemd, engine or host mutation."""
import copy
import contextlib
import io
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

from reverie.cleanup import declarative as D
from tests import test_prune_host_install as fixtures


class DeclaredTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.InstallTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        for target in (patch.object(D, 'H', fixtures.H), patch.object(D.os, 'geteuid', return_value=0)):
            target.start()
            self.addCleanup(target.stop)
        self.installer = self.fixture.installer
        self.original_run = self.installer.run
        self.installer.run = self.run_tool

    def run_tool(self, args):
        if 'show' in args:
            self.fixture.calls.append(args)
            output = 'LoadState=loaded\nFragmentPath=/etc/systemd/system/' + args[-1] + '\n'
            return subprocess.CompletedProcess(args, 0, output, '')
        return self.original_run(args)

    def initialize(self):
        return D.initialize(self.installer, self.fixture.input)

    def select_r12(self):
        candidate = Path(D.__file__).parent / 'candidate/reverie_prune.py'
        (self.fixture.package / 'libexec/reverie/reverie_prune.py').write_bytes(candidate.read_bytes())
        (self.fixture.closure / 'bin/reverie-prune-declared').write_text('immutable r12 declaration fixture')
        self.installer = D.DeclaredInstaller(self.fixture.state, **self.fixture.installer.paths, run=self.run_tool)
        # The subclass inherits H.check from its immutable sibling module. Bind
        # that module's custody check to the same fake-root boundary as fixtures.
        target = patch.dict(D.DeclaredInstaller.check.__globals__, {'protected_chain': fixtures.H.protected_chain})
        target.start()
        self.addCleanup(target.stop)
        # r12 admits only operator-approved roots, also in dry-run: the declared input names the disposable mount's identity.
        self.fixture.settings['root_identities'] = {self.fixture.settings['b_mount']: {'source': '/dev/fixture', 'fstype': 'ext4', 'mount_root': '/'}}
        self.fixture.write_input()

    def test_r12_initializer_accepts_exact_candidate_and_keeps_bootstrap_r8_pins(self):
        r8_pins = copy.deepcopy(fixtures.H.SOURCE_HASHES)
        self.select_r12()
        self.initialize()
        manifest = json.loads((self.fixture.state / 'install.json').read_text())
        self.assertEqual(manifest['files']['lib/reverie_prune.py'],
                         '55f26deec48c2c5d25b7d2509aa2ec28a22b1ebb0a6747c8be021a79129d4bed')
        self.assertEqual(fixtures.H.SOURCE_HASHES, r8_pins)
        self.assertEqual(fixtures.H.SOURCE_HASHES['reverie_prune.py'],
                         '333d8e56f4a7de0347736455df10d06551daac9eef3a491389334a02393df075')
        with self.assertRaisesRegex(ValueError, 'source hash differs'):
            self.fixture.installer.pins()

    def test_r12_initializer_refuses_r8_or_tampered_candidate_before_state_creation(self):
        self.select_r12()
        source = self.fixture.package / 'libexec/reverie/reverie_prune.py'
        for data in ((Path(fixtures.H.__file__).parent / 'reverie_prune.py').read_bytes(), b'tampered candidate'):
            with self.subTest(data_hash=fixtures.H.digest(data)):
                source.write_bytes(data)
                with self.assertRaisesRegex(ValueError, 'r12.*source hash differs'):
                    self.initialize()
                self.assertFalse(self.fixture.state.exists())

    def test_r12_inventory_uses_its_same_immutable_launcher_and_verified_state(self):
        self.select_r12()
        self.initialize()
        settings = self.installer.check()
        generated = fixtures.H.tomllib.loads((self.fixture.state / 'prune.toml').read_text())
        self.assertEqual(generated['laptops_cmd'], [str(self.fixture.closure / 'bin/reverie-prune-declared'),
                                                  '--state-dir', str(self.fixture.state), '--inventory'])
        args = [piece for key, value in self.installer.paths.items() for piece in ('--' + key.replace('_', '-'), str(value))]
        args += ['--state-dir', str(self.fixture.state), '--inventory']
        with contextlib.redirect_stdout(io.StringIO()) as output:
            code = D.main(args, installer_type=lambda *unused: self.installer)
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(output.getvalue()), [{'id': settings['employee_ids'][0], 'init_pid': 77777}])
        target = self.fixture.state / 'lib/reverie_prune.py'
        target.chmod(0o644)
        target.write_text('changed')
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(D.main(args, installer_type=lambda *unused: self.installer), 2)

    def receipt(self, status='PASS', prune=D.DeclaredInstaller.source_hashes['reverie_prune.py'],
                lease=D.DeclaredInstaller.source_hashes['lease.py']):
        path = self.fixture.root / 'dry-state/selftest-receipt.json'
        path.parent.mkdir(exist_ok=True)
        data = json.dumps({'status': status, 'files': {'prune': ['/x/reverie_prune.py', prune], 'lease': ['/x/lease.py', lease],
                                                        'runner': ['/x/r', '0' * 64], 'kit': ['/x/k', '0' * 64]}}).encode()
        path.write_bytes(data)
        return str(path), fixtures.H.digest(data)

    def live(self, receipt=None, **acceptance):
        path, digest = receipt or self.receipt()
        self.fixture.settings['live_enabled'] = True
        self.fixture.settings['live_acceptance'] = {'dry_run_report_sha256': 'ab' * 32, 'signoff': 'reviewer: record-1',
                                                    'selftest_receipt': path, 'selftest_receipt_sha256': digest, **acceptance}
        self.fixture.write_input()

    def raw(self):
        return json.loads(self.fixture.input.read_text())

    def test_r12_root_identities_are_required_and_written(self):
        self.select_r12()
        self.initialize()
        text = (self.fixture.state / 'prune.toml').read_text()
        self.assertTrue(text.startswith('live_enabled = false\n'))
        self.assertEqual(fixtures.H.tomllib.loads(text)['root_identities'],
                         {self.fixture.settings['b_mount']: {'fstype': 'ext4', 'mount_root': '/', 'source': '/dev/fixture'}})
        b = self.fixture.settings['b_mount']
        for change in ({}, {b: {'source': '/dev/x', 'fstype': 'ext4', 'mount_root': '/sub'}},
                       {b: {'source': '/dev/x', 'fstype': 'ext4'}}, {b: {'source': '/dev/x\n', 'fstype': 'ext4', 'mount_root': '/'}}):
            with self.subTest(change=change):
                self.fixture.settings['root_identities'] = change
                self.fixture.write_input()
                with self.assertRaisesRegex(ValueError, 'root identity|full filesystem root'):
                    self.installer.policy(self.raw())

    def test_r12_loads_the_declared_config_in_both_modes(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('r12', Path(D.__file__).parent / 'candidate/reverie_prune.py')
        r12 = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(r12)
        self.select_r12()
        for live in (False, True):
            with self.subTest(live=live):
                if live:
                    self.live()
                path = self.fixture.root / f'prune-{live}.toml'
                path.write_text(self.installer.config_text(self.installer.policy(self.raw())))
                cfg = r12.load_config(str(path), None)
                self.assertIs(cfg['live_enabled'], live)
                self.assertEqual(set(cfg['root_identities']), {self.fixture.settings['b_mount']})

    def test_r12_live_needs_acceptance_record_and_fresh_state(self):
        self.select_r12()
        self.initialize()  # dry-run state exists
        self.live()
        with self.assertRaisesRegex(ValueError, 'fresh state'):
            self.initialize()  # never upgraded in place to live
        self.installer = D.DeclaredInstaller(self.fixture.root / 'protected-live-state', **self.fixture.installer.paths, run=self.run_tool)
        result = self.initialize()
        self.assertEqual(result['status'], 'CHECKED_DECLARED_LIVE_ENABLED')
        self.assertTrue(result['live_prune_qualified'])
        state = self.installer.state
        self.assertTrue((state / 'prune.toml').read_text().startswith('live_enabled = true\n'))
        self.assertEqual(json.loads((state / 'install.json').read_text())['mode'], 'live-enabled')
        self.assertEqual(json.loads((state / 'deployment.json').read_text())['live_acceptance']['signoff'], 'reviewer: record-1')
        self.assertIs(self.installer.check()['live_enabled'], True)
        self.assertEqual(self.initialize()['status'], 'CHECKED_DECLARED_LIVE_ENABLED')  # exact state re-verified
        self.assertIn(D.RECEIPT_COPY, json.loads((state / 'install.json').read_text())['files'])
        for name, change in ((D.RECEIPT_COPY, lambda t: t.replace('PASS', 'FAIL')),
                             ('prune.toml', lambda t: t.replace('live_enabled = true', 'live_enabled = false'))):
            with self.subTest(tampered=name):
                target = state / name
                original = target.read_text()
                target.chmod(0o644)
                target.write_text(change(original))
                with self.assertRaisesRegex(ValueError, 'changed'):
                    self.installer.check()
                target.write_text(original)
        self.installer.check()

    def test_r12_live_requires_a_pass_receipt_for_this_exact_package(self):
        self.select_r12()
        for make, why in ((lambda: self.receipt(status='FAIL'), 'PASS receipt'), (lambda: self.receipt(prune='e' * 64), 'PASS receipt'),
                          (lambda: self.receipt(lease='e' * 64), 'PASS receipt'), (lambda: (self.receipt()[0], 'f' * 64), 'differs')):
            with self.subTest(why=why):
                self.live(receipt=make())
                self.installer = D.DeclaredInstaller(self.fixture.root / 'protected-live-state', **self.fixture.installer.paths, run=self.run_tool)
                with self.assertRaisesRegex(ValueError, why):
                    self.initialize()
                self.assertFalse(self.installer.state.exists())
        inside = self.fixture.root / 'protected-live-state/selftest-receipt.json'
        self.live(receipt=(str(inside), 'a' * 64))
        self.installer = D.DeclaredInstaller(self.fixture.root / 'protected-live-state', **self.fixture.installer.paths, run=self.run_tool)
        with self.assertRaisesRegex(ValueError, 'outside the fresh live state'):
            self.installer.policy(self.raw())

    def test_r12_live_refusals(self):
        self.select_r12()
        for acceptance in ({'dry_run_report_sha256': 'AB' * 32}, {'dry_run_report_sha256': 'ab'}, {'signoff': ''},
                           {'signoff': 'x\ny'}, {'extra': 'field'}, {'selftest_receipt_sha256': 'x'}, {'selftest_receipt': ''}):
            with self.subTest(acceptance=acceptance):
                self.live(**acceptance)
                with self.assertRaisesRegex(ValueError, 'Live enablement requires'):
                    self.installer.policy(self.raw())
        self.live()
        self.fixture.settings['live_enabled'] = 'yes'
        self.fixture.write_input()
        with self.assertRaisesRegex(ValueError, 'boolean'):
            self.installer.policy(self.raw())
        self.fixture.settings['live_enabled'] = False
        self.fixture.write_input()
        with self.assertRaisesRegex(ValueError, 'only meaningful'):
            self.installer.policy(self.raw())

    def test_r8_declared_path_still_refuses_live_and_unknown_keys(self):
        self.live()
        with self.assertRaisesRegex(ValueError, 'Unknown deployment key|live_enabled=false'):
            self.initialize()

    def test_initializes_custody_without_unit_writes_enablement_or_gc(self):
        result = self.initialize()
        self.assertEqual(result['status'], 'CHECKED_DECLARED_DRY_RUN_ONLY')
        self.assertFalse(result['live_prune_qualified'])
        self.assertFalse(result['units_modified'])
        self.assertEqual(list(self.fixture.units.iterdir()), [])
        state = self.fixture.state
        manifest = json.loads((state / 'install.json').read_text())
        self.assertEqual(manifest['manager'], D.MANAGER)
        self.assertEqual(fixtures.H.digest((state / 'lib/lease.py').read_bytes()), fixtures.H.SOURCE_HASHES['lease.py'])
        self.assertEqual((state / 'lib/lease.py').stat().st_mode & 0o777, 0o444)
        self.assertIn('live_enabled = false', (state / 'prune.toml').read_text())
        self.assertIn('--inventory', (state / 'prune.toml').read_text())
        for args in self.fixture.calls:
            self.assertFalse(set(args) & {'start', 'stop', 'enable', 'daemon-reload', '--add-root', '--gc', '--now'})

    def test_exact_state_is_verified_without_rewriting(self):
        self.initialize()
        before = {p: (p.read_bytes(), p.stat().st_mtime_ns) for p in self.fixture.state.rglob('*') if p.is_file()}
        self.initialize()
        after = {p: (p.read_bytes(), p.stat().st_mtime_ns) for p in before}
        self.assertEqual(before, after)

    def test_changed_config_or_package_is_not_automatically_upgraded(self):
        self.initialize()
        before = (self.fixture.state / 'install.json').read_bytes()
        self.fixture.settings['cadence'] = 'daily'
        self.fixture.write_input()
        with self.assertRaisesRegex(ValueError, 'fresh state'):
            self.initialize()
        self.assertEqual(before, (self.fixture.state / 'install.json').read_bytes())
        self.fixture.settings['cadence'] = 'hourly'
        self.fixture.write_input()
        self.installer.paths['closure'] = self.fixture.root / 'store/new-installer'
        with self.assertRaisesRegex(ValueError, 'fresh state'):
            self.initialize()

    def test_foreign_partial_or_bootstrap_state_is_never_adopted(self):
        for kind in ('partial', 'bootstrap'):
            with self.subTest(kind=kind):
                state = self.fixture.root / kind
                state.mkdir()
                self.installer.state = state
                if kind == 'partial':
                    (state / 'unfinished').write_text('preserve')
                else:
                    (state / 'install.json').write_text(json.dumps({'mode': 'dry-run-only'}))
                with self.assertRaisesRegex(ValueError, 'fresh state'):
                    self.initialize()

    def test_runtime_units_and_dropins_refuse_before_state_creation(self):
        for name in (fixtures.H.SERVICE, fixtures.H.TIMER, fixtures.H.SERVICE + '.d', fixtures.H.TIMER + '.d'):
            with self.subTest(name=name):
                path = self.fixture.units / name
                path.write_text('bootstrap or override')
                with self.assertRaisesRegex(ValueError, 'Runtime cleanup'):
                    self.initialize()
                self.assertFalse(self.fixture.state.exists())
                path.unlink()

    def test_missing_ambiguous_and_unreadable_unit_protocol_is_not_accepted(self):
        for code, output in ((1, ''), (0, ''), (0, 'LoadState=not-found\nFragmentPath=\n'),
                             (0, 'LoadState=loaded\nLoadState=loaded\nFragmentPath=/etc/systemd/system/reverie-prune.service\n'),
                             (0, 'LoadState=loaded\nFragmentPath=/run/systemd/transient/reverie-prune.service\n')):
            with self.subTest(code=code, output=output):
                self.installer.run = lambda args: subprocess.CompletedProcess(args, code, output, '') if 'show' in args else self.run_tool(args)
                with self.assertRaisesRegex(ValueError, 'unit binding'):
                    self.initialize()
                self.assertFalse(self.fixture.state.exists())

    def test_host_root_and_container_boundary_are_required(self):
        with patch.object(D.os, 'geteuid', return_value=1000):
            with self.assertRaisesRegex(ValueError, 'root'):
                self.initialize()
        self.installer.run = lambda args: subprocess.CompletedProcess(args, 0, '', '')
        with self.assertRaisesRegex(ValueError, 'container root'):
            self.initialize()
        self.assertFalse(self.fixture.state.exists())

    def test_missing_host_mount_or_untrusted_state_ancestor_refuses_before_writes(self):
        with patch.object(fixtures.H.os.path, 'ismount', return_value=False):
            with self.assertRaisesRegex(ValueError, 'existing disposable filesystem mount'):
                self.initialize()
        with patch.object(fixtures.H, 'protected_chain', side_effect=ValueError('untrusted ancestor')):
            with self.assertRaisesRegex(ValueError, 'untrusted ancestor'):
                self.initialize()
        self.assertFalse(self.fixture.state.exists())
        self.assertFalse(any('ps' in args or 'inspect' in args for args in self.fixture.calls))

    def test_unreadable_input_or_missing_lease_fails_before_custody_setup(self):
        with patch.object(fixtures.H, 'read_file', side_effect=PermissionError('unreadable reviewed input')):
            with self.assertRaises(PermissionError):
                self.initialize()
        self.fixture.leases.rmdir()
        with self.assertRaises(FileNotFoundError):
            self.initialize()
        self.assertFalse(self.fixture.state.exists())

    def test_inventory_error_and_bad_binding_are_not_an_empty_fleet(self):
        for kind in ('error', 'malformed', 'wrong-binding'):
            with self.subTest(kind=kind):
                self.installer.state = self.fixture.root / ('state-' + kind)
                row = copy.deepcopy(self.fixture.row)
                if kind == 'wrong-binding':
                    self.fixture.row['mounts'][1]['Source'] = str(self.fixture.home)
                def response(args):
                    if kind == 'error' and 'ps' in args:
                        return subprocess.CompletedProcess(args, 1, '', 'unreadable engine')
                    if kind == 'malformed' and 'inspect' in args:
                        return subprocess.CompletedProcess(args, 0, '{bad json', '')
                    return self.run_tool(args)
                self.installer.run = response
                with self.assertRaises((ValueError, json.JSONDecodeError)):
                    self.initialize()
                self.assertFalse((self.installer.state / 'install.json').exists())
                self.assertFalse((self.installer.state / 'lib/lease.py').exists())
                self.fixture.row = row

    def test_corrupted_protected_copy_and_live_settings_are_refused(self):
        self.initialize()
        path = self.fixture.state / 'lib/lease.py'
        path.chmod(0o644)
        path.write_text('changed')
        with self.assertRaisesRegex(ValueError, 'changed'):
            self.initialize()
        self.fixture.settings['live_enabled'] = True
        self.fixture.write_input()
        with self.assertRaisesRegex(ValueError, 'live_enabled=false'):
            self.initialize()

    def test_launcher_bindings_cannot_be_overridden(self):
        args = []
        for name, value in self.installer.paths.items():
            args += ['--' + name.replace('_', '-'), str(value)]
        args += ['--state-dir', str(self.installer.state), '--config', str(self.fixture.input)]
        for duplicate in ('package', 'closure', 'config', 'state-dir'):
            with self.subTest(duplicate=duplicate), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                D.main(args + ['--' + duplicate, '/untrusted'])


if __name__ == '__main__':
    unittest.main()
