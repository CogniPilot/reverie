import hashlib
import os
import json
import subprocess
import sys
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

from reverie.chat_image_custody import ImageCacheCustody, NAME
from reverie.chat_image_paths import ImagePathRefused


class ChatImageCustodyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='chat-image-custody-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state, self.cache = self.root / 'state', self.root / 'cache'
        self.state.mkdir(mode=0o700)
        self.cache.mkdir(mode=0o700)
        self.owners = []
        self.addCleanup(lambda: [owner.close() for owner in self.owners])

    def owner(self):
        value = ImageCacheCustody(self.state, self.cache)
        self.owners.append(value)
        return value

    def file(self):
        path = self.cache / '11111111-1111-4111-8111-111111111111.png'
        path.write_bytes(b'fixture image')
        path.chmod(0o600)
        info = path.stat()
        return path, SimpleNamespace(name=path.name, inode=(info.st_dev, info.st_ino),
            size=info.st_size, digest=hashlib.sha256(path.read_bytes()).hexdigest())

    def test_restart_removes_only_byte_and_inode_proven_owned_copies(self):
        owner = self.owner()
        owner.recover()
        path, entry = self.file()
        owner.checkpoint([entry])
        owner.close()  # Simulate losing the running service, without its normal image cleanup.
        successor = self.owner()
        successor.recover()
        self.assertFalse(path.exists())
        self.assertEqual(list(self.cache.iterdir()), [])

    def test_abrupt_producer_exit_recovers_only_committed_copy_without_adoption(self):
        scope = {'version': 1, 'sessionId': '11111111-1111-4111-8111-111111111111',
                 'roomId': '22222222-2222-4222-8222-222222222222',
                 'messageId': '33333333-3333-4333-8333-333333333333',
                 'generation': 'a' * 64, 'fileIds': ['44444444-4444-4444-8444-444444444444']}
        script = """
import json, os, sys
from reverie.chat_image_custody import ImageCacheCustody
from reverie.chat_image_paths import ImagePaths
custody = ImageCacheCustody(sys.argv[1], sys.argv[2])
custody.recover()
cache = ImagePaths(sys.argv[2], sys.argv[2], lambda *args: bytes.fromhex('89504e470d0a1a0a') + b'fixture',
                   lambda scope: True, checkpoint=custody.checkpoint, close_hook=custody.close)
cache.materialize(json.loads(sys.argv[3]))
os._exit(0)
"""
        child = subprocess.run([sys.executable, '-c', script, str(self.state), str(self.cache), json.dumps(scope)],
                               capture_output=True, timeout=5)
        self.assertEqual(child.returncode, 0, child.stderr.decode())
        self.assertEqual(len(list(self.cache.iterdir())), 1)
        self.owner().recover()
        self.assertEqual(list(self.cache.iterdir()), [])

    def test_held_owner_excludes_a_second_manager(self):
        self.owner()
        with self.assertRaisesRegex(ImagePathRefused, 'custody_busy'):
            self.owner()

    def test_unknown_file_without_record_is_preserved_and_refuses(self):
        path, _ = self.file()
        with self.assertRaises(ImagePathRefused): self.owner().recover()
        self.assertTrue(path.exists())

    def test_unrecorded_file_alongside_known_data_prevents_all_cleanup(self):
        owner = self.owner()
        path, entry = self.file()
        owner.checkpoint([entry])
        unknown = self.cache / 'important-unsaved.txt'
        unknown.write_text('keep')
        with self.assertRaises(ImagePathRefused): owner.recover()
        self.assertEqual(unknown.read_text(), 'keep')
        self.assertTrue(path.exists())

    def test_modified_recorded_bytes_are_preserved_and_refuse(self):
        owner = self.owner()
        path, entry = self.file()
        owner.checkpoint([entry])
        path.write_bytes(b'changed image')
        with self.assertRaises(ImagePathRefused): owner.recover()
        self.assertTrue(path.exists())

    def test_hardlink_or_symlink_substitution_never_deletes_the_target(self):
        for link in ('hard', 'symbolic'):
            owner = self.owner()
            path, entry = self.file()
            owner.checkpoint([entry])
            target = self.root / ('saved-' + link)
            if link == 'hard': os.link(path, target)
            else:
                path.rename(target)
                path.symlink_to(target)
            with self.assertRaises((ImagePathRefused, OSError)): owner.recover()
            self.assertTrue(target.exists())
            path.unlink()
            target.unlink()
            owner.close()

    def test_replaced_cache_directory_and_corrupt_ledger_refuse(self):
        owner = self.owner()
        owner.recover()
        owner.checkpoint([])
        (self.state / NAME).write_text('{"version":1,"version":2}')
        with self.assertRaises(ImagePathRefused): owner.recover()
        self.cache.rename(self.root / 'original')
        self.cache.mkdir(mode=0o700)
        with self.assertRaises(ImagePathRefused): owner.checkpoint([])

    def test_recreated_empty_scratch_preserves_old_record_and_retained_files(self):
        owner = self.owner()
        path, entry = self.file()
        owner.checkpoint([entry])
        old_record = (self.state / NAME).read_bytes()
        owner.close()
        retained = self.root / 'retained-cache'
        self.cache.rename(retained)
        self.cache.mkdir(mode=0o700)
        self.owner().recover()
        self.assertEqual((retained / path.name).read_bytes(), b'fixture image')
        records = list(self.state.glob('.chat-image-custody-retained-*.json'))
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0].read_bytes(), old_record)
        self.assertEqual(list(self.cache.iterdir()), [])

    def test_changed_nonempty_cache_refuses_without_losing_the_old_record(self):
        owner = self.owner()
        _, entry = self.file()
        owner.checkpoint([entry])
        original = (self.state / NAME).read_bytes()
        owner.close()
        self.cache.rename(self.root / 'old-cache')
        self.cache.mkdir(mode=0o700)
        unknown = self.cache / 'saved.txt'
        unknown.write_text('unsaved work')
        with self.assertRaises(ImagePathRefused): self.owner().recover()
        self.assertEqual((self.state / NAME).read_bytes(), original)
        self.assertEqual(unknown.read_text(), 'unsaved work')
        self.assertEqual(list(self.state.glob('.chat-image-custody-retained-*.json')), [])

    def test_missing_previously_removed_file_settles_without_adopting_a_cache_hit(self):
        owner = self.owner()
        path, entry = self.file()
        owner.checkpoint([entry])
        path.unlink()
        owner.close()
        self.owner().recover()
        self.assertEqual(list(self.cache.iterdir()), [])


if __name__ == '__main__': unittest.main()
