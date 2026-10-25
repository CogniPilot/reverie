"""Real owned fixtures with only root identity simulated; no host service effects."""
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

from reverie.cleanup import collector_state as C


class CollectorStateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.state = self.root / 'collector'
        self.real_lstat = Path.lstat
        self.real_fstat = os.fstat
        def root_owner(info):
            fields = list(info)
            fields[4] = 0
            return os.stat_result(fields)
        for p in (patch.object(C.os, 'geteuid', return_value=0),
                  patch.object(Path, 'lstat', autospec=True, side_effect=lambda p: root_owner(self.real_lstat(p))),
                  patch.object(C.os, 'fstat', side_effect=lambda fd: root_owner(self.real_fstat(fd)))):
            p.start()
            self.addCleanup(p.stop)

    def test_repeatable_private_state_preserves_existing_observations(self):
        C.prepare(str(self.state))
        output = self.state / 'samples-fixture.jsonl'
        output.write_text('preserve\n')
        before = (self.state / '.reverie-collector-state.json').stat().st_mtime_ns
        C.prepare(str(self.state))
        self.assertEqual(output.read_text(), 'preserve\n')
        self.assertEqual(before, (self.state / '.reverie-collector-state.json').stat().st_mtime_ns)
        self.assertEqual(stat.S_IMODE(self.state.stat().st_mode), 0o700)

    def test_foreign_data_is_never_adopted_or_chowned(self):
        self.state.mkdir(mode=0o700)
        victim = self.state / 'other-application'
        victim.write_text('preserve')
        with self.assertRaisesRegex(ValueError, 'adopt'):
            C.prepare(str(self.state))
        self.assertEqual(victim.read_text(), 'preserve')
        self.assertFalse((self.state / '.reverie-collector-state.json').exists())

    def test_symlink_and_writable_parent_are_refused_without_entering(self):
        outside = self.root / 'victim'
        outside.mkdir()
        self.state.symlink_to(outside, target_is_directory=True)
        with self.assertRaises(ValueError):
            C.prepare(str(self.state))
        self.assertEqual(list(outside.iterdir()), [])
        self.state.unlink()
        self.root.chmod(0o777)
        with self.assertRaises(ValueError):
            C.prepare(str(self.state))
        self.assertFalse(self.state.exists())

    def test_fifo_marker_refuses_immediately_and_never_replaces_it(self):
        self.state.mkdir(mode=0o700)
        marker = self.state / '.reverie-collector-state.json'
        os.mkfifo(marker, 0o600)
        with self.assertRaises(ValueError):
            C.prepare(str(self.state))
        self.assertTrue(stat.S_ISFIFO(marker.lstat().st_mode))

    def test_nonroot_and_generic_state_paths_are_refused(self):
        with patch.object(C.os, 'geteuid', return_value=1000):
            with self.assertRaises(ValueError):
                C.prepare(str(self.state))
        self.assertFalse(self.state.exists())
        for p in ('/', '/var/lib', '/etc', 'relative', '/var/a/../b'):
            with self.subTest(path=p), self.assertRaises(ValueError):
                C.prepare(p)
