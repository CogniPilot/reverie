"""Synthetic engine failures must not strand a previous employee laptop."""
import tests  # noqa: F401
import json
from pathlib import Path
import subprocess
import time
import unittest
from unittest.mock import Mock, patch

from reverie.worker import OFFLINE_GRACE_SECONDS
from tests import test_worker_storage as fixtures


class WorkerSupervisionTests(unittest.TestCase):
    write = fixtures.EmployeeStorageTests.write
    move = fixtures.EmployeeStorageTests.move

    def setUp(self):
        fixtures.EmployeeStorageTests.setUp(self)
        self.employee.update(desiredRunning=True, onVacation=False)
        self.write(self.file, self.company)
        self.broker = fixtures.BrokerEmployeeLeaseTests.broker(self)

    def result(self, item):
        return subprocess.CompletedProcess([], 0, json.dumps(item), '')

    def console(self):
        return [{'State': {'Running': True},
                 'NetworkSettings': {'Networks': {'bridge': {'IPAddress': '172.17.0.2'}}}}]

    def ticks(self, count):
        self.broker.stopping = Mock(deadline=None)
        self.broker.stopping.wait.side_effect = [False] * count + [True]

    def test_malformed_console_inspect_is_unavailable_and_can_retry(self):
        malformed = [None, {}, [], [None], [{}], [{'State': {'Running': True}}],
                     [{'State': {'Running': 'true'}}],
                     [{'State': {'Running': True}, 'NetworkSettings': None}],
                     [{'State': {'Running': True}, 'NetworkSettings': {'Networks': []}}]]
        for payload in malformed:
            with self.subTest(payload=payload):
                self.broker.address_cache = None
                self.broker.run_engine = Mock(return_value=self.result(payload))
                with self.assertRaises(RuntimeError):
                    self.broker.address()
                self.assertIsNone(self.broker.address_cache)
        self.broker.run_engine = Mock(return_value=self.result(self.console()))
        self.assertEqual(self.broker.address(), '172.17.0.2')

    def test_unusable_address_never_enters_cache(self):
        for running, address in [(False, '172.17.0.2'), (True, ''), (True, None),
                                 (True, 'not-an-ip'), (True, {'unexpected': 'object'})]:
            with self.subTest(running=running, address=address):
                payload = self.console()
                payload[0]['State']['Running'] = running
                payload[0]['NetworkSettings']['Networks']['bridge']['IPAddress'] = address
                self.broker.run_engine = Mock(return_value=self.result(payload))
                with self.assertRaises(RuntimeError):
                    self.broker.address()
                self.assertIsNone(self.broker.address_cache)

    def test_watchdog_retries_bad_inspect_and_clears_outage_only_after_http_health(self):
        self.broker.run_engine = Mock(side_effect=[self.result([{'State': {'Running': True}}]),
                                                   self.result(self.console())])
        offline = self.state / 'office-offline-since'
        seen = []
        def tick(_seconds):
            seen.append(offline.exists())
            return len(seen) > 2
        self.broker.stopping = Mock(deadline=None)
        self.broker.stopping.wait.side_effect = tick
        with patch('reverie.worker.http.client.HTTPConnection') as connection:
            connection.return_value.getresponse.return_value.status = 200
            self.broker.supervise()
        self.assertEqual(seen, [False, True, False])
        self.assertEqual(self.broker.run_engine.call_count, 2)
        self.assertEqual(connection.call_count, 1)

    def test_bad_inspect_does_not_clear_expired_outage(self):
        offline = self.state / 'office-offline-since'
        offline.write_text(str(time.time() - OFFLINE_GRACE_SECONDS - 1))
        self.broker.run_engine = Mock(return_value=self.result([]))
        self.broker.stop_laptops = Mock()
        self.ticks(1)
        self.broker.supervise()
        self.broker.stop_laptops.assert_called_once_with()
        self.assertTrue(offline.exists())

    def test_console_restart_shorter_than_grace_keeps_detached_running_laptop(self):
        # A website restart detaches every terminal viewer and the office API is briefly down. The laptop and the
        # agent in its own tmux keep running: only the full grace period, or a real stop reason, ends them.
        old = fixtures.OLD
        name = 'test-agent-' + old
        self.broker.laptops[old] = name
        self.broker.stop = Mock()
        self.broker.stop_laptops = Mock()
        self.broker.release_storage = Mock()
        def engine(args, optional=False):
            if args == ['inspect', 'test-console']:
                return self.result(self.console())
            self.assertEqual(args, ['inspect', name])
            return self.result([{'State': {'Running': True}}])
        self.broker.run_engine = Mock(side_effect=engine)
        offline = self.state / 'office-offline-since'
        down, up = OSError('console restarting'), Mock(status=200)
        health = [down, down, down, up, down]
        marks = []
        def tick(_seconds):
            marks.append(float(offline.read_text()) if offline.exists() else None)
            return len(marks) > len(health)
        self.broker.stopping = Mock(deadline=None)
        self.broker.stopping.wait.side_effect = tick
        started = time.time()
        with patch('reverie.worker.http.client.HTTPConnection') as connection:
            connection.return_value.getresponse.side_effect = health
            self.broker.supervise()
        self.broker.stop.assert_not_called()
        self.broker.stop_laptops.assert_not_called()
        self.broker.release_storage.assert_not_called()
        self.assertEqual(self.broker.laptops, {old: name})
        first, during, recovered, again = marks[1], marks[1:4], marks[4], marks[5]
        self.assertGreaterEqual(first, started)
        self.assertEqual(during, [first, first, first])  # one outage, one start time
        self.assertIsNone(recovered)  # recovery clears the timer
        self.assertGreaterEqual(again, first)  # a later outage gets a fresh grace period

    def test_unknown_detached_state_keeps_real_storage_lease_until_confirmed_stopped(self):
        old, new = fixtures.OLD, fixtures.NEW
        self.broker.claim_storage(old)
        self.broker.laptops[old] = 'test-agent-' + old
        office = self.broker.offices[old] = Mock()
        states = iter([self.result([None]), RuntimeError('Transient engine failure'),
                       self.result([{'State': {'Running': True}}]),
                       self.result([{'State': {'Running': False}}])])
        def engine(args, optional=False):
            if args == ['inspect', 'test-console']:
                return self.result(self.console())
            self.assertEqual(args, ['inspect', 'test-agent-' + old])
            state = next(states)
            if isinstance(state, Exception):
                raise state
            return state
        self.broker.run_engine = Mock(side_effect=engine)
        seen = []
        def tick(_seconds):
            seen.append(old in self.broker.storage_leases)
            return len(seen) > 4
        self.broker.stopping = Mock(deadline=None)
        self.broker.stopping.wait.side_effect = tick
        with patch('reverie.worker.http.client.HTTPConnection') as connection:
            connection.return_value.getresponse.return_value.status = 200
            self.broker.supervise()
        self.assertEqual(seen, [True, True, True, True, False])
        self.assertNotIn(old, self.broker.laptops)
        office.close.assert_called_once_with()

    def test_confirmed_gone_container_releases_real_lease_and_phone(self):
        old = fixtures.OLD
        name = 'test-agent-' + old
        self.broker.claim_storage(old)
        self.broker.laptops[old] = name
        office = self.broker.offices[old] = Mock()
        # Exercise the real run_engine boundary: missing inspect exits nonzero.
        del self.broker.run_engine
        def engine(command, **kwargs):
            self.assertEqual(command[0], 'docker')
            args = command[1:]
            if args == ['inspect', 'test-console']:
                return self.result(self.console())
            if args == ['inspect', name]:
                return subprocess.CompletedProcess(command, 1, '[]\n', 'Error: No such object: ' + name + '\n')
            self.assertEqual(args, ['ps', '--all', '--format', '{{.Names}}'])
            return subprocess.CompletedProcess(command, 0, 'test-console\n', '')
        self.ticks(1)
        # GOAL's bounded engine transport now uses run_client; keep exercising
        # the real run_engine classifier without contacting a real daemon.
        with patch('reverie.worker.run_client', side_effect=engine), \
                patch('reverie.worker.http.client.HTTPConnection') as connection:
            connection.return_value.getresponse.return_value.status = 200
            self.broker.supervise()
        self.assertNotIn(old, self.broker.storage_leases)
        self.assertNotIn(old, self.broker.laptops)
        office.close.assert_called_once_with()
        # The FD lease actually closed; another session may acquire the data.
        self.move()
        with fixtures.storage_guard(self.config, fixtures.NEW):
            pass

    def test_missing_diagnostic_requires_matching_name_and_valid_absence_inventory(self):
        name = 'test-agent-' + fixtures.OLD
        missing = subprocess.CompletedProcess([], 1, '[]', 'Error: No such object: ' + name)
        malformed = [
            (subprocess.CompletedProcess([], 1, '', 'Cannot connect to the Docker daemon'), None),
            (subprocess.CompletedProcess([], 1, '[]', 'Error: No such object: another-container'), None),
            (subprocess.CompletedProcess([], 1, '[]', missing.stderr + '\nconnection reset'), None),
            (subprocess.CompletedProcess([], 1, '[{}]', missing.stderr), None),
            (subprocess.CompletedProcess([], -9, '[]', missing.stderr), None),
            (self.result([]), None),
            (missing, subprocess.CompletedProcess([], 1, '', 'Daemon unavailable')),
            (missing, subprocess.CompletedProcess([], 0, '[not names]\n', '')),
            (missing, subprocess.CompletedProcess([], 0, name + '\n', '')),
            (missing, subprocess.CompletedProcess([], 0, 'duplicate\nduplicate\n', '')),
        ]
        self.broker.claim_storage(fixtures.OLD)
        for reply, inventory in malformed:
            with self.subTest(reply=reply, inventory=inventory):
                self.broker.run_engine = Mock(side_effect=[reply] + ([inventory] if inventory else []))
                with self.assertRaises(RuntimeError):
                    self.broker.inspect_container(name)
                self.assertIn(fixtures.OLD, self.broker.storage_leases)
        for diagnostic in ('Error: no such object: "' + name + '"',
                           'Error: inspecting object: no such object: "' + name + '"'):
            self.broker.run_engine = Mock(side_effect=[
                subprocess.CompletedProcess([], 125, '[]\n', diagnostic),
                subprocess.CompletedProcess([], 0, '', ''),
            ])
            self.assertFalse(self.broker.inspect_container(name)['State']['Running'])
            self.assertEqual(self.broker.run_engine.call_args_list[0].kwargs, {'optional': True})

    def test_binding_move_sweeps_old_laptop_despite_health_and_bookkeeping_errors(self):
        old, new = fixtures.OLD, fixtures.NEW
        self.broker.claim_storage(old)
        self.broker.laptops[old] = 'test-agent-' + old
        office = self.broker.offices[old] = Mock()
        self.move('stopping')
        with self.assertRaises(BlockingIOError):
            self.broker.claim_storage(new)
        running = True
        def engine(args, optional=False):
            nonlocal running
            if args == ['inspect', 'test-console']:
                return self.result([{'State': {'Running': True}}])
            if args == ['stop', '--time', '2', 'test-agent-' + old]:
                running = False
                return subprocess.CompletedProcess(args, 0, '', '')
            if args == ['inspect', 'test-agent-' + old]:
                return self.result([{'State': {'Running': running}}])
            if args == ['network', 'inspect', 'test-agent-' + old + '-lan']:
                return subprocess.CompletedProcess(args, 1, '', '')
            if args == ['ps', '--quiet', '--no-trunc']:
                self.assertFalse(running, 'successor must not start while old writer is running')
                return subprocess.CompletedProcess(args, 0, '', '')
            self.fail('Unexpected engine operation: ' + repr(args))
        self.broker.run_engine = Mock(side_effect=engine)
        self.ticks(1)
        with patch.object(Path, 'write_text', side_effect=OSError('Transient receipt write failure')):
            self.broker.supervise()
        self.assertFalse(running)
        self.assertNotIn(old, self.broker.laptops)
        self.assertNotIn(old, self.broker.storage_leases)
        office.close.assert_called_once_with()
        paths, created = self.broker.claim_storage(new)
        self.assertTrue(created)
        self.assertEqual(paths.identity, fixtures.EMPLOYEE)


if __name__ == '__main__':
    unittest.main()
