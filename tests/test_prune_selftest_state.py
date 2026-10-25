"""Pure custody fixtures; never invoke namespaces, root tests or an engine."""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

from reverie.cleanup import selftest_state as S
from reverie.cleanup.selftest import selftest as K
from tests import test_prune_host_install as fixtures


class SelftestStateTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.InstallTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        for target in (patch.object(S, 'H', fixtures.H), patch.object(S.os, 'geteuid', return_value=0)):
            target.start(); self.addCleanup(target.stop)
        f = self.fixture
        self.package = f.package
        self.prune = self.package / 'libexec/reverie/reverie_prune.py'
        source = Path(S.__file__).parent
        self.prune.write_bytes((source / 'candidate/reverie_prune.py').read_bytes())
        kit = self.package / 'libexec/reverie/selftest'; kit.mkdir()
        for name in S.KIT:
            (kit / name).write_bytes((source / 'selftest' / name).read_bytes())
        self.state = f.root / 'selftest-state'
        self.base = f.b / '.selftest-fixture'
        self.raw = {'version': 1, 'b_mount': str(f.b), 'laptops_root': 'laptops/employees',
                    'laptop_uid': f.settings['laptop_uid'], 'laptop_gid': f.settings['laptop_gid'],
                    'uid': f.settings['laptop_uid'] + 1, 'gid': f.settings['laptop_gid'] + 1,
                    'base': str(self.base), 'state': str(self.state), 'live_state': str(f.root / 'live-state')}
        self.config = f.root / 'selftest-config.json'; self.write_config()

    def write_config(self):
        self.config.write_text(json.dumps(self.raw)); self.config.chmod(0o600)

    def prepare(self):
        return S.prepare(self.config, self.package, self.prune,
                         self.fixture.root / 'store/systemd/bin/systemd-detect-virt', run=self.fixture.fake_run)

    def test_pristine_custody_copies_only_reviewed_lease_and_never_runs_tests(self):
        with patch.object(S.os, 'chown', side_effect=AssertionError('must never adopt/chown state')):
            result = self.prepare()
        self.assertFalse(result['tests_started'])
        self.assertEqual(fixtures.H.digest((self.state / 'lib/lease.py').read_bytes()), S.LEASE_SHA)
        self.assertEqual((self.state / 'lib/lease.py').stat().st_mode & 0o777, 0o444)
        self.assertEqual(self.base.stat().st_mode & 0o777, 0o711)
        self.assertFalse((self.state / 'selftest-receipt.json').exists())
        self.assertEqual(len(self.fixture.calls), 1)
        self.assertIn('systemd-detect-virt', self.fixture.calls[0][0])
        before = {p: (p.read_bytes(), p.stat().st_mtime_ns) for p in self.state.rglob('*') if p.is_file()}
        self.prepare()
        self.assertEqual(before, {p: (p.read_bytes(), p.stat().st_mtime_ns) for p in before})

    def test_foreign_even_empty_paths_are_not_adopted_or_chowned(self):
        self.base.mkdir()
        with self.assertRaises((ValueError, FileNotFoundError)):
            self.prepare()
        self.assertFalse(self.state.exists())
        self.assertEqual(list(self.base.iterdir()), [])

    def test_bad_mount_overlap_real_uid_and_code_fail_before_mutation(self):
        original = copy.deepcopy(self.raw)
        for change in ({'uid': original['laptop_uid']}, {'gid': 0},
                       {'base': str(self.fixture.b / 'laptops')},
                       {'state': original['live_state']}, {'state': str(self.fixture.b / 'receipts')}):
            with self.subTest(change=change):
                self.raw = dict(original, **change); self.write_config()
                with self.assertRaises(ValueError): self.prepare()
                self.assertFalse(self.state.exists())
        self.raw = original; self.write_config()
        with patch.object(fixtures.H.os.path, 'ismount', return_value=False):
            with self.assertRaisesRegex(ValueError, 'actual disposable'): self.prepare()
        self.prune.write_text('altered')
        with self.assertRaisesRegex(ValueError, 'hash differs'): self.prepare()
        self.assertFalse(self.state.exists())

    def test_changed_binding_or_protected_copy_refuses_without_repair(self):
        self.prepare()
        self.raw['uid'] += 1; self.write_config()
        with self.assertRaisesRegex(ValueError, 'changed selftest state'): self.prepare()
        self.raw['uid'] -= 1; self.write_config()
        lease = self.state / 'lib/lease.py'; lease.chmod(0o644); lease.write_text('changed')
        with self.assertRaisesRegex(ValueError, 'lease copy changed'): self.prepare()
        self.assertEqual(lease.read_text(), 'changed')

    def test_r2_has_exact_results_and_rejects_links_oversize_and_wrong_owner(self):
        self.assertEqual(K.EXPECTED, {'checkout', 'control', 'cwd', 'exe', 'fsmonitor_not_run',
                         'host_result', 'leased', 'mmap', 'mount', 'no_proc_unreadable', 'openfile', 'reserved', 'victim_intact'})
        data = self.fixture.root / 'result.json'; data.write_bytes(b'{"ok":true}')
        uid = data.stat().st_uid
        self.assertEqual(K.read_owned(data, uid, 100), b'{"ok":true}')
        for owner, limit in ((uid + 1, 100), (uid, 2)):
            with self.assertRaises(ValueError): K.read_owned(data, owner, limit)
        link = self.fixture.root / 'result-link'; link.symlink_to(data)
        with self.assertRaises(OSError): K.read_owned(link, uid, 100)
        fifo = self.fixture.root / 'result-fifo'; os.mkfifo(fifo)
        code = ('import importlib.util,os; s=importlib.util.spec_from_file_location("kit", ' + repr(K.__file__) + '); '
                'k=importlib.util.module_from_spec(s); s.loader.exec_module(k);\n'
                'try: k.read_owned(' + repr(str(fifo)) + ',os.getuid(),100)\n'
                'except ValueError: raise SystemExit(0)\n'
                'raise SystemExit(1)\n')
        result = subprocess.run([sys.executable, '-I', '-B', '-c', code], capture_output=True, timeout=3)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__': unittest.main()
