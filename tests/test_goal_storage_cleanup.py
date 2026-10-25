"""Goal composition on 3be: storage lease cleanup is bounded and independent. Synthetic fixtures only."""
import tests  # noqa: F401
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock, patch

from reverie.worker import Broker
from reverie.worker_cleanup import CLEANUP_CODES, CleanupUnconfirmed

SID = '11111111-2222-3333-4444-555555555555'
SID2 = '22222222-2222-3333-4444-555555555555'
SID3 = '33333333-2222-3333-4444-555555555555'


class GoalStorageCleanupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='goal-storage-cleanup-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root/'state').mkdir()
        self.broker = Broker(dict(maxWorkers=4, maintenanceSessions=[], serverContainer='synthetic-console',
                                  deployment='test', budgetMode='admission', memoryMiB=512, poolMemoryMiB=4096,
                                  apiSocketRoot=str(self.root/'office'), companyRoot=str(self.root/'company'),
                                  stateRoot=str(self.root/'state'), socket=str(self.root/'control/broker.sock')))
        self.broker.run_engine = Mock(return_value=subprocess.CompletedProcess(
            ['fixture'], 0, '\n'.join('test-agent-'+sid for sid in (SID, SID2, SID3)), ''))

    def lease(self):
        return (MagicMock(), None)

    def test_storage_codes_survive_cleanup_reporting(self):
        for code in ('STORAGE_RELEASE_UNCONFIRMED', 'STORAGE_LOCK_UNAVAILABLE'):
            self.assertIn(code, CLEANUP_CODES)
            self.assertEqual(CleanupUnconfirmed({code}).codes, (code,))

    def test_release_without_stop_releases_exact_lease(self):
        held, other = self.lease(), self.lease()
        self.broker.storage_leases.update({SID: held, SID2: other})
        self.assertTrue(self.broker.release_storage(SID))
        held[0].__exit__.assert_called_once_with(None, None, None)
        other[0].__exit__.assert_not_called()
        self.assertEqual(set(self.broker.storage_leases), {SID2})
        self.assertTrue(self.broker.release_storage(SID))  # Nothing held is not uncertainty.
        self.assertEqual(self.broker.cleanup_uncertain, set())

    def test_stopping_release_is_bounded_and_retains_lease_when_lock_unavailable(self):
        held = self.lease()
        self.broker.storage_leases[SID] = held
        taken, done = threading.Event(), threading.Event()
        def owner():
            with self.broker.storage_lease_lock:
                taken.set(); done.wait(10)
        thread = threading.Thread(target=owner); thread.start()
        self.addCleanup(thread.join); self.addCleanup(done.set)
        self.assertTrue(taken.wait(10))
        self.broker.stopping.set()
        with patch.object(type(self.broker.stopping), 'deadline', new=time.monotonic()+0.05, create=True):
            started = time.monotonic()
            self.assertFalse(self.broker.release_storage(SID))
            self.assertLess(time.monotonic()-started, 5)
        held[0].__exit__.assert_not_called()
        self.assertIs(self.broker.storage_leases[SID], held)
        self.assertEqual(self.broker.cleanup_uncertain, {'STORAGE_LOCK_UNAVAILABLE'})

    def test_recover_rollback_attempts_every_close_and_release(self):
        first, second = Mock(), Mock()
        first.close.side_effect = RuntimeError('synthetic close failure')
        leases = {SID: self.lease(), SID2: self.lease(), SID3: self.lease()}
        leases[SID][0].__exit__.side_effect = OSError('synthetic release failure')
        def claim(sid):
            self.broker.storage_leases[sid] = leases[sid]
            return SimpleNamespace(kind='maintenance'), True
        self.broker.claim_storage = Mock(side_effect=claim)
        with patch('reverie.worker.OfficeAPI', side_effect=[first, second, RuntimeError('synthetic allocation')]):
            with self.assertRaisesRegex(RuntimeError, 'synthetic allocation'):
                self.broker.recover()
        first.close.assert_called_once_with()
        second.close.assert_called_once_with()
        leases[SID][0].__exit__.assert_called_once_with(None, None, None)
        leases[SID2][0].__exit__.assert_called_once_with(None, None, None)
        leases[SID3][0].__exit__.assert_called_once_with(None, None, None)
        self.assertEqual(self.broker.storage_leases, {})
        self.assertEqual(self.broker.cleanup_uncertain, {'OFFICE_CLOSE_FAILED', 'STORAGE_RELEASE_UNCONFIRMED'})
        self.assertEqual(self.broker.offices, {})
        self.assertEqual(self.broker.laptops, {})


if __name__ == '__main__':
    unittest.main()
