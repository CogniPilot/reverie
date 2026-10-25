"""Synthetic allocation failure controls; no real engine or external HTTP calls."""
import tests  # noqa: F401
from pathlib import Path
import socketserver
import socket
import subprocess
import tempfile
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from reverie.worker import Broker, OfficeAPI, OFFLINE_GRACE_SECONDS

SID = '11111111-2222-3333-4444-555555555555'
SID2 = '22222222-2222-3333-4444-555555555555'
SID3 = '33333333-2222-3333-4444-555555555555'


class BrokerAllocationFailureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='broker-allocation-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = dict(maxWorkers=4, maintenanceSessions=[SID], serverContainer='synthetic-console',
                           deployment='test', budgetMode='admission', memoryMiB=512, poolMemoryMiB=4096,
                           apiSocketRoot=str(self.root/'office'), companyRoot=str(self.root/'company'),
                           stateRoot=str(self.root/'state'), socket=str(self.root/'control/broker.sock'))
        (self.root/'state').mkdir()
        self.broker = Broker(self.config)
        self.broker.run_engine = Mock(side_effect=AssertionError('UNEXPECTED_ENGINE_CALL'))

    def inventory(self, *sessions):
        self.broker.run_engine = Mock(return_value=subprocess.CompletedProcess(
            ['fixture'], 0, '\n'.join('test-agent-'+sid for sid in sessions), ''))

    def assert_no_engine_mutation(self):
        self.assertEqual(len(self.broker.run_engine.call_args_list), 1)
        self.assertEqual(self.broker.run_engine.call_args.args[0][0], 'ps')

    def test_office_constructor_thread_allocation_failure_closes_owned_socket_without_shutdown(self):
        before = threading.active_count()
        for stage in ('constructor', 'start'):
            directory = self.root/stage
            kwargs = {'side_effect': RuntimeError('synthetic thread allocation')} if stage == 'constructor' else {
                'return_value': Mock(start=Mock(side_effect=RuntimeError('synthetic thread allocation')))}
            with self.subTest(stage=stage), patch('reverie.worker.threading.Thread', **kwargs), \
                    patch.object(socketserver.BaseServer, 'shutdown', side_effect=AssertionError('SHUTDOWN_BEFORE_START')):
                with self.assertRaisesRegex(RuntimeError, 'synthetic thread allocation'):
                    OfficeAPI(directory, SID, lambda: 'unused', self.root/'company')
            self.assertFalse((directory/'office.sock').exists())
        self.assertEqual(threading.active_count(), before)
        self.broker.run_engine.assert_not_called()

    def test_office_failed_start_preserves_replacement_path(self):
        directory = self.root/'replace'
        path = directory/'office.sock'
        def fail():
            path.unlink()
            path.write_text('synthetic replacement')
            raise RuntimeError('synthetic start failure')
        with patch('reverie.worker.threading.Thread', return_value=Mock(start=Mock(side_effect=fail))):
            with self.assertRaises(RuntimeError):
                OfficeAPI(directory, SID, 'unused', self.root/'company')
        self.assertEqual(path.read_text(), 'synthetic replacement')

    def test_maintenance_thread_constructor_and_start_failures_release_lock_and_timestamp(self):
        for stage in ('constructor', 'start'):
            kwargs = {'side_effect': RuntimeError('synthetic allocation')} if stage == 'constructor' else {
                'return_value': Mock(start=Mock(side_effect=RuntimeError('synthetic allocation')))}
            with self.subTest(stage=stage), patch('reverie.worker.threading.Thread', **kwargs):
                with self.assertRaisesRegex(RuntimeError, 'synthetic allocation'):
                    self.broker.control('restart-website', SID)
            self.assertTrue(self.broker.maintenance_lock.acquire(blocking=False))
            self.broker.maintenance_lock.release()
            self.assertEqual(self.broker.last_maintenance, 0)
        self.broker.run_engine.assert_not_called()

    def test_recover_population_limit_refuses_before_office_creation(self):
        self.broker.config['maxWorkers'] = 1
        self.inventory(SID, SID2)
        with patch('reverie.worker.OfficeAPI') as office:
            with self.assertRaisesRegex(RuntimeError, 'exceed'):
                self.broker.recover()
        office.assert_not_called()
        self.assertEqual(self.broker.offices, {})
        self.assertEqual(self.broker.laptops, {})
        self.assert_no_engine_mutation()

    def test_recover_memory_limit_refuses_before_office_creation(self):
        self.broker.config['poolMemoryMiB'] = 512
        self.inventory(SID, SID2)
        with patch('reverie.worker.OfficeAPI') as office:
            with self.assertRaisesRegex(RuntimeError, 'exceed'):
                self.broker.recover()
        office.assert_not_called()
        self.assertEqual(self.broker.laptops, {})
        self.assert_no_engine_mutation()

    def test_recover_partial_failure_closes_only_new_resources_and_keeps_state(self):
        self.broker.claim_storage = Mock(return_value=(SimpleNamespace(kind='maintenance'), False))  # Goal composition on 3be: storage is not under test here; 3be's recover() claims a lease per laptop
        previous = Mock()
        created = Mock()
        self.broker.laptops[SID] = 'test-agent-'+SID
        self.broker.offices[SID] = previous
        self.inventory(SID, SID2, SID3)
        with patch('reverie.worker.OfficeAPI', side_effect=[created, RuntimeError('synthetic allocation')]):
            with self.assertRaisesRegex(RuntimeError, 'synthetic allocation'):
                self.broker.recover()
        created.close.assert_called_once_with()
        previous.close.assert_not_called()
        self.assertEqual(self.broker.offices, {SID: previous})
        self.assertEqual(self.broker.laptops, {SID: 'test-agent-'+SID})
        self.assert_no_engine_mutation()

    def test_recover_success_commits_once_and_reuses_existing_office(self):
        self.broker.claim_storage = Mock(return_value=(SimpleNamespace(kind='maintenance'), False))  # Goal composition on 3be: storage is not under test here; 3be's recover() claims a lease per laptop
        existing = Mock()
        created = Mock()
        self.broker.laptops[SID] = 'test-agent-'+SID
        self.broker.offices[SID] = existing
        self.inventory(SID, SID2)
        with patch('reverie.worker.OfficeAPI', return_value=created) as constructor:
            self.broker.recover()
        self.assertEqual(constructor.call_count, 1)
        self.assertEqual(self.broker.offices, {SID: existing, SID2: created})
        self.assertEqual(set(self.broker.laptops), {SID, SID2})
        self.assert_no_engine_mutation()

    def test_connection_thread_allocation_failure_closes_socket_and_returns_token(self):
        for stage in ('constructor', 'start'):
            broker = Broker(self.config)
            broker.check_pool = Mock()
            broker.recover = Mock()
            broker.run_engine = Mock(side_effect=AssertionError('UNEXPECTED_ENGINE_CALL'))
            listener = Mock()
            listener.__enter__ = Mock(return_value=listener)
            listener.__exit__ = Mock(return_value=False)
            original_socket = socket.socket
            bound = []
            def bind(path):
                local = original_socket(socket.AF_UNIX)
                local.bind(path)
                bound.append(local)
            listener.bind.side_effect = bind
            connection = Mock()
            listener.accept.return_value = (connection, None)
            supervisor = Mock(is_alive=Mock(return_value=False))
            def allocate(*, target, args=(), daemon=False):
                if target == broker.supervise:
                    return supervisor
                self.assertEqual(target, broker.handle)
                def fail():
                    broker.stopping.set()
                    raise RuntimeError('synthetic handler allocation')
                if stage == 'constructor':
                    fail()
                return Mock(start=Mock(side_effect=fail))
            with self.subTest(stage=stage), patch('reverie.worker.socket.socket', return_value=listener), \
                    patch('reverie.worker.threading.Thread', side_effect=allocate):
                try:
                    broker.serve()
                finally:
                    for local in bound:
                        local.close()
            connection.close.assert_called_once_with()
            tokens = self.config['maxWorkers']+4
            for _ in range(tokens):
                self.assertTrue(broker.connections.acquire(blocking=False))
            self.assertFalse(broker.connections.acquire(blocking=False))
            for _ in range(tokens):
                broker.connections.release()
            broker.run_engine.assert_not_called()

    def test_supervisor_start_failure_closes_recovered_offices_without_engine_mutation(self):
        broker = self.broker
        broker.check_pool = Mock()
        office = Mock()
        broker.recover = Mock(side_effect=lambda: broker.offices.update({SID: office}))
        with patch('reverie.worker.threading.Thread', return_value=Mock(start=Mock(side_effect=RuntimeError('synthetic supervisor allocation')))):
            with self.assertRaisesRegex(RuntimeError, 'synthetic supervisor allocation'):
                broker.serve()
        office.close.assert_called_once_with(deadline=broker.stopping.deadline)
        self.assertEqual(broker.offices, {})
        broker.run_engine.assert_not_called()

    def test_listener_allocation_failure_joins_supervisor_and_closes_offices(self):
        broker = self.broker
        broker.check_pool = Mock()
        office = Mock()
        broker.recover = Mock(side_effect=lambda: broker.offices.update({SID: office}))
        supervisor = Mock(is_alive=Mock(return_value=False))
        with patch('reverie.worker.threading.Thread', return_value=supervisor), \
                patch('reverie.worker.socket.socket', side_effect=OSError('synthetic socket allocation')):
            with self.assertRaisesRegex(OSError, 'synthetic socket allocation'):
                broker.serve()
        supervisor.join.assert_called_once_with(5)
        office.close.assert_called_once_with(deadline=broker.stopping.deadline)
        self.assertEqual(broker.offices, {})
        self.assertTrue(broker.stopping.is_set())
        broker.run_engine.assert_not_called()

    def test_deliberate_stop_remains_serial_and_unconditional(self):
        calls = []
        self.broker.stop = lambda name: calls.append(name)
        results = iter([subprocess.CompletedProcess([],0,'test-agent-'+SID+'\ntest-agent-'+SID2,''), subprocess.CompletedProcess([],0,'','')])
        self.broker.run_engine = Mock(side_effect=lambda *a, **k: next(results))
        self.broker.stop_laptops()
        self.assertEqual(calls, ['test-agent-'+SID, 'test-agent-'+SID2])
        self.assertFalse(self.broker.draining.is_set())
        self.assertEqual(self.broker.generation, 1)

    def test_offline_ten_minute_stop_remains_active(self):
        (self.root/'state/office-offline-since').write_text('1')
        self.broker.stopping = Mock(wait=Mock(side_effect=[False, True]))
        self.broker.address = Mock(side_effect=RuntimeError('synthetic office unavailable'))
        self.broker.stop_laptops = Mock()
        with patch('reverie.worker.time.time', return_value=1000):
            self.broker.supervise()
        self.broker.stop_laptops.assert_called_once_with()
        self.assertEqual(OFFLINE_GRACE_SECONDS, 600)
        self.broker.run_engine.assert_not_called()


if __name__ == '__main__':
    unittest.main()
