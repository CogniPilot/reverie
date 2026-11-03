"""Synthetic image cleanup only: no engine, laptop, network or host operation."""
import os
from pathlib import Path
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from reverie.chat_image_paths import ImagePaths, ImagePathRefused
from reverie.worker import Broker
from reverie.worker_chat_images import WorkerChatImages
from reverie.worker_cleanup import CleanupUnconfirmed
from tests import test_broker_shutdown as shutdown_fixture


class ImageCleanupDeadlineTests(unittest.TestCase):
    def bounded_held_lock(self, lock, close):
        # Release the holder even on the original hanging implementation, so
        # RED is an assertion failure, never an abandoned cleanup thread.
        lock.acquire()
        entered = threading.Event()
        results = []
        def run():
            entered.set()
            try:
                results.append(close())
            except ImagePathRefused as error:
                results.append(error)
        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        try:
            self.assertTrue(entered.wait(1))
            thread.join(3)
            self.assertFalse(thread.is_alive(), 'cleanup waited beyond its default two-second budget')
        finally:
            lock.release()
            thread.join(3)
        return results

    def cache(self):
        temporary = tempfile.TemporaryDirectory(prefix='image-close-')
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        root.chmod(0o700)
        scope = {'version': 1, 'sessionId': '11111111-1111-4111-8111-111111111111',
                 'roomId': '22222222-2222-4222-8222-222222222222',
                 'messageId': '33333333-3333-4333-8333-333333333333',
                 'generation': 'a' * 64,
                 'fileIds': ['44444444-4444-4444-8444-444444444444']}
        checkpoint, hook = Mock(), Mock()
        service = ImagePaths(root, root, lambda *args: b'\x89PNG\r\n\x1a\nfixture',
                             lambda value: True, clock=lambda: 100.,
                             checkpoint=checkpoint, close_hook=hook)
        def finish():
            service.stopped.set()
            service.thread.join(2)
            if service.fd >= 0:
                service.close()
        self.addCleanup(finish)
        name = Path(service.materialize(scope)['files'][0]['path'])
        checkpoint.reset_mock()
        return service, name, checkpoint, hook

    def test_controller_default_close_refuses_a_held_construction_lock(self):
        controller = WorkerChatImages(SimpleNamespace())
        service = Mock()
        controller.caches['owned'] = ('generation', service, 'root')
        self.assertEqual(self.bounded_held_lock(controller.lock, controller.close), [False])
        service.close.assert_not_called()
        self.assertIn('owned', controller.caches)

    def test_cache_default_close_preserves_custody_when_its_entry_lock_is_held(self):
        service, name, checkpoint, hook = self.cache()
        service.stopped.set()
        service.thread.join(2)
        result = self.bounded_held_lock(service.lock, service.close)
        self.assertIsInstance(result[0], ImagePathRefused)
        self.assertEqual(str(result[0]), 'cleanup_unsettled')
        self.assertTrue(name.exists())
        self.assertGreaterEqual(service.fd, 0)
        checkpoint.assert_not_called()
        hook.assert_not_called()

    def test_cache_reaper_uses_only_the_remaining_shutdown_budget(self):
        service, name, checkpoint, hook = self.cache()
        service.stopped.set()
        service.thread.join(2)
        original = service.thread
        reaper = Mock(is_alive=Mock(return_value=True))
        service.thread = reaper
        try:
            with patch('reverie.chat_image_paths.time.monotonic', return_value=10.):
                with self.assertRaisesRegex(ImagePathRefused, 'expiry_unsettled'):
                    service.close(deadline=10.25)
            reaper.join.assert_called_once_with(timeout=.25)
            self.assertTrue(name.exists())
            self.assertGreaterEqual(service.fd, 0)
            checkpoint.assert_not_called()
            hook.assert_not_called()
        finally:
            service.thread = original

    def test_expired_budget_preserves_files_descriptor_and_custody(self):
        service, name, checkpoint, hook = self.cache()
        service.stopped.set()
        service.thread.join(2)
        with self.assertRaisesRegex(ImagePathRefused, 'cleanup_unsettled'):
            service.close(deadline=time.monotonic() - 1)
        self.assertTrue(name.exists())
        self.assertIn(name.name, service.entries)
        os.fstat(service.fd)
        checkpoint.assert_not_called()
        hook.assert_not_called()

    def test_completed_cleanup_uses_shutdown_time_instead_of_cache_expiration_clock(self):
        service, name, checkpoint, hook = self.cache()
        service.close(deadline=time.monotonic() + 1)
        self.assertFalse(name.exists())
        self.assertEqual(service.fd, -1)
        self.assertFalse(service.thread.is_alive())
        checkpoint.assert_called_once()
        hook.assert_called_once()

    def test_controller_shares_one_deadline_and_retains_unsettled_cache_owners(self):
        controller = WorkerChatImages(SimpleNamespace())
        now = [10.]
        failed = Mock(close=Mock(side_effect=ImagePathRefused('busy')))
        def consume(*, deadline):
            self.assertEqual(deadline, 11.)
            now[0] = 11.
        settled = Mock(close=Mock(side_effect=consume))
        untouched = Mock()
        controller.caches = {'failed': ('g', failed, 'r'), 'settled': ('g', settled, 'r'),
                             'untouched': ('g', untouched, 'r')}
        with patch('reverie.worker_chat_images.time.monotonic', side_effect=lambda: now[0]):
            self.assertFalse(controller.close(deadline=11.))
        failed.close.assert_called_once_with(deadline=11.)
        settled.close.assert_called_once_with(deadline=11.)
        untouched.close.assert_not_called()
        self.assertEqual(set(controller.caches), {'failed', 'untouched'})
        self.assertTrue(controller.lock.acquire(blocking=False))
        controller.lock.release()

    def test_broker_passes_its_first_stop_deadline_and_reports_unsettled_images(self):
        with tempfile.TemporaryDirectory(prefix='image-broker-') as directory, shutdown_fixture.Clock() as clock:
            broker = Broker({'maxWorkers': 16, 'socket': directory + '/broker.sock'})
            deadlines = []
            def close(*, deadline=None):
                deadlines.append(deadline)
                return False
            broker.chat_images = SimpleNamespace(close=close)
            broker.stopping.set()
            first_deadline = broker.stopping.deadline
            clock.sleep(33.)
            with self.assertRaises(CleanupUnconfirmed):
                shutdown_fixture.ShutdownTests.serve_fixture(self, broker)
            self.assertEqual(deadlines, [first_deadline])
            self.assertIn('CHAT_IMAGE_CLEANUP_UNCONFIRMED', broker.cleanup_uncertain)
            self.assertEqual(clock.now, 33.)


if __name__ == '__main__':
    unittest.main()
