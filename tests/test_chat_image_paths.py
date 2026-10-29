import copy
import os
from pathlib import Path
import stat
import tempfile
import time
import unittest
from unittest.mock import patch

from reverie.chat_image_paths import ImagePaths, ImagePathRefused, request, image_extension, directory


class ChatImagePathsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='chat-image-path-test-')
        self.root = Path(self.temporary.name)
        self.root.chmod(0o700)
        self.scope = {'version': 1, 'sessionId': '11111111-1111-4111-8111-111111111111',
                      'roomId': '22222222-2222-4222-8222-222222222222',
                      'messageId': '33333333-3333-4333-8333-333333333333',
                      'generation': 'a' * 64,
                      'fileIds': ['44444444-4444-4444-8444-444444444444']}
        self.bytes = b'\x89PNG\r\n\x1a\n' + b'image fixture'
        self.fetches = []
        self.allowed = True
        self.now = 100.0
        self.cache = None

    def tearDown(self):
        if self.cache is not None and self.cache.fd >= 0:
            try:
                self.cache.close()
            except ImagePathRefused:
                # A deliberate substituted file is quarantined, never removed
                # by the cache owner. The synthetic test root settles it here.
                self.cache.stopped.set()
                self.cache.thread.join(timeout=2)
                os.close(self.cache.fd)
        self.temporary.cleanup()

    def fetch(self, scope, file_id, max_bytes):
        self.fetches.append((copy.deepcopy(scope), file_id, max_bytes))
        if not self.allowed:
            raise ImagePathRefused('access_denied')
        return self.bytes

    def start(self, fetch=None):
        self.cache = ImagePaths(self.root, self.root, fetch or self.fetch,
                                lambda scope: self.allowed and scope['generation'] == 'a' * 64,
                                clock=lambda: self.now)

    def test_expiry_thread_allocation_failure_closes_the_cache_descriptor(self):
        from unittest.mock import Mock
        for stage in ('constructor', 'start'):
            descriptors = []
            close_hook = Mock()
            def opened(path):
                fd = directory(path)
                descriptors.append(fd)
                return fd
            with self.subTest(stage=stage), patch('reverie.chat_image_paths.directory', side_effect=opened), \
                    patch('reverie.chat_image_paths.threading.Thread') as thread:
                if stage == 'constructor':
                    thread.side_effect = RuntimeError('controlled allocation failure')
                else:
                    thread.return_value.start.side_effect = RuntimeError('controlled start failure')
                    thread.return_value.is_alive.return_value = False
                with self.assertRaises(RuntimeError):
                    ImagePaths(self.root, self.root, self.fetch, lambda scope: True, close_hook=close_hook)
                self.assertEqual(len(descriptors), 1)
                with self.assertRaises(OSError):
                    os.fstat(descriptors[0])
                close_hook.assert_called_once()

    def test_request_rejects_transport_paths_and_credentials(self):
        for key in ('url', 'output', 'path', 'token', 'command'):
            with self.subTest(key=key), self.assertRaises(ImagePathRefused):
                request({**self.scope, key: '/not-an-image'})

    def test_request_binds_all_identities_and_generation(self):
        for key in ('sessionId', 'roomId', 'messageId', 'generation'):
            with self.subTest(key=key), self.assertRaises(ImagePathRefused):
                request({**self.scope, key: '../other'})
        with self.assertRaises(ImagePathRefused):
            request({**self.scope, 'version': True})

    def test_duplicate_missing_and_too_many_file_ids_refuse(self):
        for ids in ([], self.scope['fileIds'] * 2, ['bad'],
                    [f'{n:08x}-0000-4000-8000-000000000000' for n in range(5)]):
            with self.subTest(ids=ids), self.assertRaises(ImagePathRefused):
                request({**self.scope, 'fileIds': ids})

    def test_raster_types_are_detected_from_bytes(self):
        for data, expected in ((self.bytes, 'png'), (b'\xff\xd8\xffrest', 'jpg'),
                               (b'GIF89arest', 'gif'), (b'RIFF0000WEBPrest', 'webp')):
            self.assertEqual(image_extension(data), expected)
        for data in (b'<svg></svg>', b'not an image', b'', bytearray(self.bytes),
                     self.bytes + b'x' * (8 * 1024 * 1024)):
            with self.assertRaises(ImagePathRefused):
                image_extension(data)

    def test_ready_is_real_private_file_with_exact_bytes(self):
        self.start()
        result = self.cache.materialize(self.scope)
        self.assertEqual(result['status'], 'ready')
        self.assertEqual(result['generation'], self.scope['generation'])
        file = result['files'][0]
        path = Path(file['path'])
        self.assertEqual(path.read_bytes(), self.bytes)
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual(path.suffix, '.png')
        self.assertEqual(file['fileId'], self.scope['fileIds'][0])
        self.assertEqual(len(self.fetches), 1)

    def test_repeated_request_reauthorizes_and_does_not_reuse_a_path(self):
        self.start()
        first = self.cache.materialize(self.scope)
        second = self.cache.materialize(self.scope)
        self.assertEqual(len(self.fetches), 2)
        self.assertNotEqual(first['files'][0]['path'], second['files'][0]['path'])

    def test_nonmember_refuses_before_bytes_or_ready(self):
        self.start()
        self.allowed = False
        with self.assertRaises(ImagePathRefused):
            self.cache.materialize(self.scope)
        self.assertEqual(self.fetches, [])
        self.assertEqual(list(self.root.iterdir()), [])

    def test_revoke_during_fetch_never_publishes_a_path(self):
        def fetch(*args):
            self.allowed = False
            return self.bytes
        self.start(fetch)
        with self.assertRaises(ImagePathRefused):
            self.cache.materialize(self.scope)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_old_generation_refuses(self):
        self.start()
        with self.assertRaises(ImagePathRefused):
            self.cache.materialize({**self.scope, 'generation': 'b' * 64})
        self.assertEqual(self.fetches, [])

    def test_second_file_failure_rolls_back_only_own_first_file(self):
        count = 0
        def fetch(*args):
            nonlocal count
            count += 1
            if count == 2:
                raise ImagePathRefused('deleted')
            return self.bytes
        self.start(fetch)
        scope = {**self.scope, 'fileIds': self.scope['fileIds'] + ['55555555-5555-4555-8555-555555555555']}
        with self.assertRaises(ImagePathRefused):
            self.cache.materialize(scope)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_active_reaper_expires_bytes_without_another_request(self):
        self.start()
        path = Path(self.cache.materialize(self.scope)['files'][0]['path'])
        self.now += 1801
        deadline = time.monotonic() + 2
        while path.exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertFalse(path.exists())

    def test_stopped_expiry_owner_cannot_return_ready(self):
        self.start()
        self.cache.stopped.set()
        self.cache.thread.join(timeout=2)
        with self.assertRaises(ImagePathRefused):
            self.cache.materialize(self.scope)

    def test_retire_preserves_copies_and_settles_the_expiry_owner(self):
        self.start()
        result = self.cache.materialize(self.scope)
        path = Path(result['files'][0]['path'])
        self.cache.retire()
        self.assertFalse(self.cache.thread.is_alive())
        self.assertEqual(path.read_bytes(), self.bytes)
        self.assertEqual(self.cache.fd, -1)
        with self.assertRaises(ImagePathRefused):
            self.cache.materialize(self.scope)

    def test_close_removes_own_files_and_settles_reaper(self):
        self.start()
        path = Path(self.cache.materialize(self.scope)['files'][0]['path'])
        self.cache.close()
        self.assertFalse(path.exists())
        self.assertFalse(self.cache.thread.is_alive())
        self.cache = None

    def test_unknown_previous_cache_files_are_not_adopted_or_removed(self):
        existing = self.root / 'keep.txt'
        existing.write_text('unique')
        with self.assertRaises(ImagePathRefused):
            self.start()
        self.assertEqual(existing.read_text(), 'unique')

    def test_symlinked_ancestor_is_refused(self):
        real = self.root / 'real'
        real.mkdir(mode=0o700)
        alias = self.root / 'alias'
        alias.symlink_to(real, target_is_directory=True)
        with self.assertRaises(OSError):
            directory(alias)

    def test_nonprivate_cache_is_refused_without_chmod(self):
        self.root.chmod(0o755)
        with self.assertRaises(ImagePathRefused):
            self.start()
        self.assertEqual(stat.S_IMODE(self.root.stat().st_mode), 0o755)

    def test_unsupported_bytes_leave_no_partial_file(self):
        self.start()
        self.bytes = b'<svg/>'
        with self.assertRaises(ImagePathRefused):
            self.cache.materialize(self.scope)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_concurrent_request_is_refused_without_second_fetch(self):
        self.start()
        self.cache.admission.acquire()
        try:
            with self.assertRaisesRegex(ImagePathRefused, 'busy'):
                self.cache.materialize(self.scope)
        finally:
            self.cache.admission.release()
        self.assertEqual(self.fetches, [])

    def test_cache_byte_limit_does_not_evict_an_existing_path(self):
        self.start()
        first = Path(self.cache.materialize(self.scope)['files'][0]['path'])
        with patch('reverie.chat_image_paths.MAX_CACHE_BYTES', len(self.bytes)):
            with self.assertRaisesRegex(ImagePathRefused, 'cache_limit'):
                self.cache.materialize(self.scope)
        self.assertEqual(first.read_bytes(), self.bytes)
        self.assertEqual(list(self.root.iterdir()), [first])

    def test_file_count_limit_does_not_publish_an_extra_file(self):
        self.start()
        self.cache.materialize(self.scope)
        with patch('reverie.chat_image_paths.MAX_CACHE_FILES', 1):
            with self.assertRaisesRegex(ImagePathRefused, 'cache_limit'):
                self.cache.materialize(self.scope)
        self.assertEqual(len(list(self.root.iterdir())), 1)

    def test_total_request_limit_rolls_back_partial_request(self):
        self.start()
        scope = {**self.scope, 'fileIds': self.scope['fileIds'] + ['55555555-5555-4555-8555-555555555555']}
        with patch('reverie.chat_image_paths.MAX_REQUEST_BYTES', len(self.bytes)):
            with self.assertRaisesRegex(ImagePathRefused, 'request_limit'):
                self.cache.materialize(scope)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_in_place_modified_file_cannot_be_advertised_as_confirmed(self):
        self.start()
        checks = 0
        def current(scope):
            nonlocal checks
            checks += 1
            if checks == 4:
                next(self.root.iterdir()).write_bytes(b'changed')
            return True
        self.cache.current = current
        with self.assertRaisesRegex(ImagePathRefused, 'write_unconfirmed'):
            self.cache.materialize(self.scope)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_replaced_file_is_not_deleted_and_closes_exposure(self):
        self.start()
        path = Path(self.cache.materialize(self.scope)['files'][0]['path'])
        path.unlink()
        path.symlink_to('/does-not-exist')
        self.now += 1801
        with self.assertRaises(ImagePathRefused):
            self.cache.expire()
        self.assertTrue(path.is_symlink())
        with self.assertRaises(ImagePathRefused):
            self.cache.materialize(self.scope)


if __name__ == '__main__':
    unittest.main()
