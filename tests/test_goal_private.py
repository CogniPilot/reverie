import json
import os
from pathlib import Path
import tempfile
import unittest

from reverie.goal_private import absolute, assert_unexposed, private_entry, private_json, PrivateBatch


class GoalPrivateTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='goal-private-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.private = self.root / 'private'
        self.private.mkdir(mode=0o700)
        self.public = self.root / 'public'
        self.public.mkdir()
        self.file = self.private / 'config.json'
        self.file.write_text(json.dumps({'version': 1}))
        self.file.chmod(0o600)

    def test_regular_private_json_and_optional_entry_without_initialization(self):
        record, digest, identity = private_json(str(self.file))
        self.assertEqual(record, {'version': 1})
        self.assertEqual(len(digest), 64)
        self.assertEqual(len(identity), 5)
        missing = self.private / 'missing'
        self.assertEqual(private_entry(str(missing), absent=True), (None, None))
        self.assertFalse(missing.exists())

    def test_modes_hardlinks_nonregular_and_symlinks_refuse(self):
        self.file.chmod(0o644)
        with self.assertRaises(ValueError):
            private_json(str(self.file))
        self.file.chmod(0o600)
        os.link(self.file, self.private / 'alias')
        with self.assertRaises(ValueError):
            private_json(str(self.file))
        (self.private / 'alias').unlink()
        (self.private / 'link').symlink_to(self.file)
        with self.assertRaises(OSError):
            private_json(str(self.private / 'link'))
        fifo = self.private / 'fifo'
        os.mkfifo(fifo, 0o600)
        with self.assertRaises(ValueError):
            private_entry(str(fifo), limit=10)

    def test_absolute_normalized_paths_and_bounded_reads(self):
        for value in ['relative', '/', str(self.private) + '/../private/config.json', str(self.private) + '//config.json', str(self.file) + '\n']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                absolute(value)
        with self.assertRaises(ValueError):
            private_json(str(self.file), limit=1)

    def test_modes_do_not_replace_current_complete_mount_inventory(self):
        with self.assertRaises(ValueError):
            assert_unexposed([str(self.private)], [])
        assert_unexposed([str(self.private)], [str(self.public)])
        for root in [self.root, self.private, self.file]:
            with self.subTest(root=root), self.assertRaises(ValueError):
                assert_unexposed([str(self.private)], [str(root)])
        alias = self.public / 'alias'
        alias.symlink_to(self.private, target_is_directory=True)
        with self.assertRaises(ValueError):
            assert_unexposed([str(self.private)], [str(alias)])

    def test_batch_is_one_projection_only_and_rechecks_held_ancestry_modes_and_absence(self):
        for drift in ['mode', 'rename', 'appeared']:
            with self.subTest(drift=drift), self.assertRaises((ValueError, OSError)):
                with PrivateBatch() as batch:
                    private_entry(str(self.file), _batch=batch)
                    missing = self.private / 'missing'
                    private_entry(str(missing), absent=True, _batch=batch)
                    if drift == 'mode': self.private.chmod(0o755)
                    elif drift == 'rename':
                        saved = self.root / 'saved'
                        self.private.rename(saved); self.private.symlink_to(saved, target_is_directory=True)
                    else: missing.symlink_to(self.private / 'does-not-exist')
            if self.private.is_symlink():
                self.private.unlink(); (self.root / 'saved').rename(self.private)
            self.private.chmod(0o700)
            (self.private / 'missing').unlink(missing_ok=True)
        # Nothing is reused as authority by a later call.
        with PrivateBatch() as fresh:
            private_entry(str(self.file), _batch=fresh)


if __name__ == '__main__':
    unittest.main()
