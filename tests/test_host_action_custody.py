import os
from pathlib import Path
import tempfile
import unittest

from reverie.host_action_custody import load_key


class CustodyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.private = self.root / 'private'
        self.private.mkdir(mode=0o700)
        self.public = self.root / 'shared'
        self.public.mkdir()
        self.key = self.private / 'key'
        self.key.write_bytes(b'k' * 32)
        self.key.chmod(0o600)

    def load(self, **kwargs):
        return load_key(self.key, exposed_roots=[self.public], **kwargs)

    def test_private_key(self):
        self.assertEqual(self.load(), b'k' * 32)

    def test_missing_inventory(self):
        for roots in ([], None):
            with self.assertRaises(ValueError):
                load_key(self.key, exposed_roots=roots)

    def test_exposed_ancestor_and_exact_key(self):
        for root in (self.root, self.private, self.key):
            with self.assertRaises(ValueError):
                load_key(self.key, exposed_roots=[root])

    def test_mount_alias(self):
        alias = self.public / 'alias'
        alias.symlink_to(self.private, target_is_directory=True)
        with self.assertRaises(ValueError):
            load_key(self.key, exposed_roots=[alias])

    def test_key_symlink(self):
        original = self.private / 'original'
        self.key.rename(original)
        self.key.symlink_to(original)
        with self.assertRaises(OSError):
            self.load()

    def test_parent_symlink(self):
        alias = self.root / 'alias'
        alias.symlink_to(self.private, target_is_directory=True)
        with self.assertRaises(OSError):
            load_key(alias / 'key', exposed_roots=[self.public])

    def test_hardlink(self):
        os.link(self.key, self.private / 'other')
        with self.assertRaises(ValueError):
            self.load()

    def test_public_modes(self):
        for node in (self.private, self.key):
            original = node.stat().st_mode & 0o777
            node.chmod(0o755 if node.is_dir() else 0o644)
            with self.assertRaises(ValueError):
                self.load()
            node.chmod(original)

    def test_wrong_size_and_nonregular(self):
        for size in (0, 31, 33):
            self.key.write_bytes(b'x' * size)
            with self.assertRaises(ValueError):
                self.load()
        self.key.unlink()
        os.mkfifo(self.key, 0o600)
        with self.assertRaises(ValueError):
            self.load()

    def test_traversal(self):
        with self.assertRaises(ValueError):
            load_key(self.private / '..' / 'private' / 'key', exposed_roots=[self.public])

    def test_untrusted_ancestor(self):
        self.root.chmod(0o777)
        with self.assertRaises(ValueError):
            self.load()
        self.root.chmod(0o700)
