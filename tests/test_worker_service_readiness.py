"""Readiness shares the operation budget; only owned fake connect ports advance time."""
import os
from pathlib import Path
import socket
import struct
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from reverie import worker_service_upgrade as U


class ListenerReadinessDeadlineTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(); self.addCleanup(directory.cleanup)
        self.path = Path(directory.name).resolve() / 'ready.sock'
        server = socket.socket(socket.AF_UNIX); self.addCleanup(server.close)
        server.bind(str(self.path)); self.path.chmod(0o600)
        self.now = 1000.; self.ready_at = 1040.; self.connect_elapsed = 0.
        self.peer = (os.getpid(), os.getuid(), os.getgid()); self.on_connect = lambda: None
        self.calls = []; self.timeouts = []; self.waits = []
        self.upgrade = SimpleNamespace(deadline=1180.)
        case = self
        class Client:
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def settimeout(self, seconds): case.timeouts.append(seconds)
            def connect(self, path):
                case.assertEqual(path, str(case.path)); case.calls.append(case.now)
                if case.now < case.ready_at: raise ConnectionRefusedError()
                case.now += case.connect_elapsed; case.on_connect()
            def getsockopt(self, *args):
                case.assertEqual(args, (socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                return struct.pack('3i', *case.peer)
        def sleep(seconds):
            self.assertGreaterEqual(seconds, 0); self.assertLessEqual(seconds, .1)
            self.waits.append(seconds); self.now += seconds
        self.enterContext(patch.object(U.time, 'monotonic', side_effect=lambda: self.now))
        self.enterContext(patch.object(U.time, 'sleep', side_effect=sleep))
        self.enterContext(patch.object(U.socket, 'socket', side_effect=lambda *args: Client()))

    def ready(self):
        U.GPUUpgrade.ready_socket(self.upgrade, self.path, os.getpid())

    def test_recovery_taking_forty_seconds_uses_remaining_operation_budget(self):
        self.ready()
        self.assertGreaterEqual(self.now, 1040.); self.assertLess(self.now, 1040.11)
        self.assertEqual(self.upgrade.deadline, 1180.)
        self.assertTrue(all(0 < timeout <= 1 for timeout in self.timeouts))

    def test_missing_listener_expires_at_original_deadline(self):
        self.upgrade.deadline = 1002.5; self.ready_at = float('inf')
        with self.assertRaisesRegex(ValueError, 'readiness deadline'): self.ready()
        self.assertAlmostEqual(self.now, 1002.5); self.assertEqual(self.upgrade.deadline, 1002.5)

    def test_successive_listeners_never_reset_the_shared_budget(self):
        self.upgrade.deadline = 1060.; self.ready_at = 1030.
        self.ready(); self.ready_at = 1070.
        with self.assertRaisesRegex(ValueError, 'readiness deadline'): self.ready()
        self.assertAlmostEqual(self.now, 1060.); self.assertEqual(self.upgrade.deadline, 1060.)

    def test_connect_returning_after_deadline_does_not_qualify(self):
        self.upgrade.deadline = 1001.; self.ready_at = 1000.; self.connect_elapsed = 2.
        with self.assertRaisesRegex(ValueError, 'readiness deadline'): self.ready()
        self.assertEqual(self.now, 1002.)

    def test_wrong_pid_uid_and_rebound_socket_still_refuse_without_retry(self):
        self.ready_at = 1000.
        for change in ('pid', 'uid', 'stamp'):
            with self.subTest(change=change):
                self.peer = (os.getpid() + (change == 'pid'), os.getuid() + (change == 'uid'), os.getgid())
                self.on_connect = (lambda: self.path.chmod(0o640)) if change == 'stamp' else lambda: None
                before = len(self.calls)
                try:
                    with self.assertRaisesRegex(ValueError, 'not the selected'): self.ready()
                    self.assertEqual(len(self.calls), before + 1); self.assertEqual(self.waits, [])
                finally: self.path.chmod(0o600)

    def test_nonprivate_socket_never_connects(self):
        self.path.chmod(0o640)
        with self.assertRaisesRegex(ValueError, 'Private broker/office socket'): self.ready()
        self.assertEqual(self.calls, [])

    def test_already_expired_budget_performs_no_connection(self):
        self.upgrade.deadline = self.now
        with self.assertRaisesRegex(ValueError, 'readiness deadline'): self.ready()
        self.assertEqual(self.calls, []); self.assertEqual(self.waits, [])
