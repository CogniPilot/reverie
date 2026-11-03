"""Protected read-side controls using owned metadata fixtures, never an engine."""
import copy
import io
import json
import os
from pathlib import Path
import socket
import tempfile
import threading
import types
import unittest
import uuid
from contextlib import redirect_stdout
from unittest.mock import patch

from reverie import worker
from reverie import command_failure_reports as reports
from reverie.worker_command_telemetry import CommandTelemetry


def identity(n):
    return str(uuid.UUID(int=n))


class FailureReports(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=os.environ.get('T9_FIXTURE_TMP'))
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        for name in ('state', 'scratch', 'api', 'company', 'shared'):
            (self.root / name).mkdir(mode=0o700)
        self.employees = [identity(1), identity(2)]
        self.sessions = [identity(10), identity(11)]
        self.company = {'employees': [dict(id=eid, sessionId=sid, owner='fixture', desiredRunning=True)
                                      for eid, sid in zip(self.employees, self.sessions)], 'retired': []}
        self.config = {'uid': os.getuid(), 'stateRoot': str(self.root / 'state'),
                       'scratchRoot': str(self.root / 'scratch'), 'apiSocketRoot': str(self.root / 'api'),
                       'companyRoot': str(self.root / 'company'),
                       'companyFile': str(self.root / 'company/company.json'),
                       'deployment': 'fixture', 'mounts': [{'source': str(self.root / 'shared')}],
                       'commandTelemetry': {'enabled': True, 'keys': ['shell', 'python', 'git', 'zip']}}
        self.write_company()
        self.collector = CommandTelemetry(self.config, lambda _: types.SimpleNamespace(stdout=''))

    def write_company(self):
        path = Path(self.config['companyFile'])
        path.write_text(json.dumps(self.company))
        path.chmod(0o600)

    def record(self, index=0, tool='zip', code=127):
        raw = json.dumps({'v': 1, 'execution_id': str(uuid.uuid4()), 'tool': tool, 'exit_code': code}).encode()
        self.assertTrue(self.collector.observe(self.sessions[index], raw))

    def snapshot(self, collector=None, employees=None):
        return reports.build_report(collector or self.collector,
                                    self.employees if employees is None else employees)

    def test_default_off_returns_disabled_without_inventory_or_store_access(self):
        config = dict(self.config)
        config.pop('commandTelemetry')
        collector = CommandTelemetry(config, lambda _: self.fail('inventory while off'))
        with patch.object(collector, 'report_employee', side_effect=AssertionError('read while off')):
            value = self.snapshot(collector)
        self.assertFalse(value['enabled'])
        self.assertTrue(all(row['status'] == 'disabled' for row in value['employees']))
        self.assertEqual(value['top_repeats'], [])
        self.assertEqual(value['harness_support']['claude'], 'unavailable')
        self.assertEqual(value['harness_support']['codex'], 'unavailable')

    def test_no_data_is_explicit_and_does_not_initialize_employee_storage(self):
        value = self.snapshot()
        self.assertEqual([row['status'] for row in value['employees']], ['no_data', 'no_data'])
        self.assertEqual(list(self.collector.root.iterdir()), [])

    def test_per_employee_counts_and_top_repeats_are_grouped(self):
        self.record(); self.record(); self.record(index=1)
        self.record(index=1, tool='python', code=1)
        value = self.snapshot()
        self.assertEqual(value['provenance'], 'SELF_REPORTED_RESULT')
        self.assertEqual([row['employee_id'] for row in value['employees']], self.employees)
        self.assertEqual(value['top_repeats'][0], {'tool': 'zip', 'category': 'COMMAND_NOT_FOUND',
                                                  'exit': 127, 'count': 3, 'employee_count': 2})
        self.assertEqual(value['employees'][0]['counts'][0]['count'], 2)
        self.assertEqual(reports.decode_report(json.dumps(value).encode(), self.employees), value)

    def test_unknown_employee_and_corrupt_store_are_unavailable_never_zero_success(self):
        self.assertEqual(self.snapshot(employees=[identity(99)])['employees'][0]['status'], 'unavailable')
        self.record()
        path = self.collector.root / self.employees[0] / 'hands/command-failures.sqlite'
        path.write_bytes(b'not a database, synthetic private data')
        self.assertEqual(self.snapshot()['employees'][0]['status'], 'unavailable')

    def test_missing_db_inside_existing_store_does_not_get_recreated(self):
        self.record()
        path = self.collector.root / self.employees[0] / 'hands/command-failures.sqlite'
        path.unlink()
        self.assertEqual(self.snapshot()['employees'][0]['status'], 'unavailable')
        self.assertFalse(path.exists())

    def test_unsafe_db_file_types_and_links_refuse_without_touching_target(self):
        self.record()
        path = self.collector.root / self.employees[0] / 'hands/command-failures.sqlite'
        original = path.read_bytes()
        path.unlink()
        victim = self.root / 'victim'
        victim.write_bytes(b'SYNTHETIC_SENTINEL'); victim.chmod(0o600)
        path.symlink_to(victim)
        self.assertEqual(self.snapshot()['employees'][0]['status'], 'unavailable')
        self.assertEqual(victim.read_bytes(), b'SYNTHETIC_SENTINEL')
        path.unlink(); os.mkfifo(path, 0o600)
        self.assertEqual(self.snapshot()['employees'][0]['status'], 'unavailable')
        path.unlink(); path.write_bytes(original); path.chmod(0o644)
        self.assertEqual(self.snapshot()['employees'][0]['status'], 'unavailable')

    def test_owner_rebinding_after_report_read_discards_result(self):
        self.record()
        original = self.collector._log
        def reader(employee):
            log = original(employee)
            report = log.report
            def changed():
                value = report()
                self.company['employees'][0]['owner'] = 'different-fixture'
                self.write_company()
                return value
            log.report = changed
            return log
        with patch.object(self.collector, '_log', reader):
            value = self.snapshot(employees=[self.employees[0]])
        self.assertEqual(value['employees'][0]['status'], 'unavailable')
        self.assertEqual(value['top_repeats'], [])

    def test_retired_and_stopped_employees_remain_readable_but_not_producers(self):
        self.record()
        row = self.company['employees'].pop(0)
        row['desiredRunning'] = False
        self.company['retired'].append(row)
        self.write_company()
        value = self.snapshot(employees=[self.employees[0]])
        self.assertEqual(value['employees'][0]['status'], 'ready')
        self.assertEqual(value['employees'][0]['counts'][0]['count'], 1)
        raw = json.dumps({'v': 1, 'execution_id': str(uuid.uuid4()), 'tool': 'zip', 'exit_code': 127}).encode()
        self.assertFalse(self.collector.observe(self.sessions[0], raw))

    def test_malformed_or_secret_report_fields_never_reach_projection(self):
        self.record()
        raw = self.collector.report_employee(self.employees[0])['report']
        cases = []
        for changes in ({'employee_id': identity(99)}, {'harness': 'claude'},
                        {'provenance': 'SYNTHETIC_SECRET'}, {'argv': 'SYNTHETIC_SECRET'}):
            cases.append(dict(raw, **changes))
        for field, value in [('tool', 'SYNTHETIC_SECRET'), ('category', 'SYNTHETIC_SECRET'),
                             ('exit', True), ('count', True), ('count', 2049), ('stderr', 'SYNTHETIC_SECRET')]:
            bad = copy.deepcopy(raw); bad['counts'][0][field] = value; cases.append(bad)
        for bad in cases:
            with self.subTest(bad=next(iter(bad))):
                with patch.object(self.collector, 'report_employee', return_value={'status': 'ready', 'report': bad}):
                    value = self.snapshot(employees=[self.employees[0]])
                self.assertEqual(value['employees'][0]['status'], 'unavailable')
                self.assertNotIn('SYNTHETIC_SECRET', json.dumps(value))

    def test_exception_text_and_unavailable_payload_cannot_leak(self):
        with patch.object(self.collector, 'report_employee', side_effect=RuntimeError('SYNTHETIC_SECRET')):
            value = self.snapshot()
        self.assertNotIn('SYNTHETIC_SECRET', json.dumps(value))
        with patch.object(self.collector, 'report_employee', return_value={'status': 'unavailable', 'report': 'SYNTHETIC_SECRET'}):
            value = self.snapshot()
        self.assertNotIn('SYNTHETIC_SECRET', json.dumps(value))

    def test_request_schema_refuses_identity_overrides_and_numeric_abuse(self):
        valid = {'v': 1, 'action': 'command-failures', 'employee_ids': self.employees}
        self.assertEqual(reports.report_request(json.dumps(valid).encode()), tuple(self.employees))
        for change in ({'harness': 'claude'}, {'path': '/synthetic'}, {'v': True}, {'action': 'enable'},
                       {'employee_ids': [self.employees[0]] * 2}, {'employee_ids': ['bad']}):
            with self.assertRaisesRegex(ValueError, 'TELEMETRY_REPORT_REFUSED'):
                reports.report_request(json.dumps(dict(valid, **change)).encode())
        for raw in (b'{"v":1,"v":1}', b'{"v":' + b'9' * 3000 + b'}', b'x' * 4097,
                    b'{"v":NaN}', b'[' * 1100 + b']' * 1100):
            with self.assertRaisesRegex(ValueError, 'TELEMETRY_REPORT_REFUSED'):
                reports.report_request(raw)

    def test_bounded_top_groups_and_byte_cap(self):
        self.record()
        raw = self.collector.report_employee(self.employees[0])['report']
        raw['counts'] = [{'tool': 'python', 'category': 'NONZERO', 'exit': code, 'count': 1}
                         for code in range(1, 51)]
        with patch.object(self.collector, 'report_employee', return_value={'status': 'ready', 'report': raw}):
            value = self.snapshot(employees=[self.employees[0]])
        self.assertEqual(len(value['employees'][0]['counts']), 20)
        self.assertTrue(value['employees'][0]['truncated'])
        self.assertEqual(len(value['top_repeats']), 20)
        self.assertTrue(value['truncated'])
        self.assertLess(len(json.dumps(value).encode()), reports.MAX_RESPONSE_BYTES)
        self.assertEqual(reports.decode_report(json.dumps(value).encode(), [self.employees[0]]), value)

    def test_wire_response_extra_fields_or_wrong_binding_refuse_before_printing(self):
        value = self.snapshot()
        cases = [dict(value, stderr='SYNTHETIC_SECRET'), dict(value, enabled=1)]
        wrong = copy.deepcopy(value); wrong['employees'][0]['employee_id'] = identity(99); cases.append(wrong)
        wrong = copy.deepcopy(value); wrong['employees'][0]['status'] = 'SYNTHETIC_SECRET'; cases.append(wrong)
        wrong = copy.deepcopy(value); wrong['employees'][0]['evicted'] = True; cases.append(wrong)
        for bad in cases:
            with self.assertRaisesRegex(ValueError, 'TELEMETRY_REPORT_REFUSED'):
                reports.decode_report(json.dumps(bad).encode(), self.employees)
        for raw in (b'{"v":-' + b'9' * 5000 + b'}', b'{"v":1,"v":1}'):
            with self.assertRaisesRegex(ValueError, 'TELEMETRY_REPORT_REFUSED'):
                reports.decode_report(raw, self.employees)

    def test_broker_private_read_frame_has_no_launch_or_writer_action(self):
        self.record()
        broker = worker.Broker.__new__(worker.Broker)
        broker.config = {'uid': os.getuid()}
        broker.stopping = threading.Event()
        broker.handlers = {}
        broker.connections = threading.BoundedSemaphore(1)
        broker.connections.acquire()
        broker.command_telemetry = self.collector
        broker.run_engine = lambda *_: self.fail('engine during report')
        server, client = socket.socketpair()
        try:
            thread = threading.Thread(target=broker.handle, args=(server,))
            thread.start()
            worker.send_frame(client, b'T', json.dumps({'v': 1, 'action': 'command-failures',
                                                       'employee_ids': self.employees}).encode())
            kind, payload = worker.receive_frame(client)
            thread.join(timeout=3)
            self.assertFalse(thread.is_alive())
            self.assertEqual(kind, b'J')
            value = reports.decode_report(payload, self.employees)
            self.assertEqual(value['employees'][0]['counts'][0]['count'], 1)
            self.assertEqual(broker.handlers, {})
            self.assertTrue(broker.connections.acquire(blocking=False))
        finally:
            client.close(); server.close()

    def test_private_reader_checks_actual_peer_uid_before_collector_access(self):
        broker = worker.Broker.__new__(worker.Broker)
        broker.config = {'uid': os.getuid() + 1}
        broker.stopping = threading.Event(); broker.handlers = {}
        broker.connections = threading.BoundedSemaphore(1); broker.connections.acquire()
        broker.command_telemetry = types.SimpleNamespace(report_employee=lambda _: self.fail('unauthorized read'))
        server, client = socket.socketpair()
        try:
            thread = threading.Thread(target=broker.handle, args=(server,)); thread.start()
            kind, payload = worker.receive_frame(client)
            thread.join(timeout=3)
            self.assertFalse(thread.is_alive())
            self.assertEqual(kind, b'E')
            self.assertNotIn(b'SYNTHETIC_SECRET', payload)
        finally:
            client.close(); server.close()

    def test_private_client_uses_only_fixed_read_frame_and_validates_before_stdout(self):
        path = self.root / 'report.sock'
        listener = socket.socket(socket.AF_UNIX)
        self.addCleanup(listener.close)
        listener.bind(str(path)); path.chmod(0o600); listener.listen(1)
        recorded = []
        value = self.snapshot()
        def server():
            connection, _ = listener.accept()
            with connection:
                kind, raw = worker.receive_frame(connection)
                recorded.append((kind, reports.report_request(raw)))
                worker.send_frame(connection, b'J', json.dumps(value).encode())
        thread = threading.Thread(target=server); thread.start()
        args = types.SimpleNamespace(goal_custody=False, command_failure_report=True,
                                     employee_id=self.employees, control=None, caller_session=None,
                                     attach_only=False, session_id=None, cwd=None, command=None)
        output = io.StringIO()
        with patch.dict(os.environ, {'REVERIE_WORKER_SOCKET': str(path)}), redirect_stdout(output):
            self.assertEqual(worker.client(args), 0)
        thread.join(timeout=3)
        self.assertFalse(thread.is_alive())
        self.assertEqual(recorded, [(b'T', tuple(self.employees))])
        self.assertEqual(json.loads(output.getvalue()), value)

    def test_private_client_mixed_launch_or_control_flags_never_connect(self):
        path = self.root / 'report.sock'
        listener = socket.socket(socket.AF_UNIX); self.addCleanup(listener.close)
        listener.bind(str(path)); path.chmod(0o600); listener.listen(1)
        base = dict(goal_custody=False, command_failure_report=True, employee_id=self.employees,
                    control=None, caller_session=None, attach_only=False, session_id=None, cwd=None, command=None)
        with patch.dict(os.environ, {'REVERIE_WORKER_SOCKET': str(path)}):
            with patch.object(worker.socket, 'socket', side_effect=AssertionError('unexpected connection')):
                for changes in ({'control': 'status'}, {'goal_custody': True}, {'session_id': self.sessions[0]},
                                {'command': 'synthetic'}, {'cwd': '/synthetic'}, {'attach_only': True},
                                {'resource_ref': self.sessions[0]}, {'resource_ref': ''},
                                {'resource_ref': 'not-a-reference'},
                                {'command_failure_report': False}):
                    with self.subTest(changes=changes), self.assertRaisesRegex(ValueError, 'TELEMETRY_REPORT_REFUSED'):
                        worker.client(types.SimpleNamespace(**dict(base, **changes)))

    def test_busy_report_gate_refuses_instead_of_queuing_another_broker_reader(self):
        broker = worker.Broker.__new__(worker.Broker)
        broker.config = {'uid': os.getuid()}; broker.stopping = threading.Event(); broker.handlers = {}
        broker.connections = threading.BoundedSemaphore(1); broker.connections.acquire()
        broker.command_telemetry = self.collector
        self.collector.report_lock.acquire()
        server, client = socket.socketpair()
        try:
            thread = threading.Thread(target=broker.handle, args=(server,)); thread.start()
            worker.send_frame(client, b'T', json.dumps({'v': 1, 'action': 'command-failures',
                                                       'employee_ids': self.employees}).encode())
            kind, payload = worker.receive_frame(client)
            thread.join(timeout=3)
            self.assertFalse(thread.is_alive()); self.assertEqual(kind, b'E')
            self.assertEqual(payload, b'TELEMETRY_REPORT_REFUSED')
            self.assertTrue(broker.connections.acquire(blocking=False))
        finally:
            self.collector.report_lock.release(); client.close(); server.close()

    def test_reader_storage_work_never_takes_the_producer_mutex(self):
        self.record()
        class UnexpectedMutex:
            def __enter__(inner):
                raise AssertionError('reader took producer mutex')
            def __exit__(inner, *_):
                return False
        self.collector.lock = UnexpectedMutex()
        value = self.snapshot(employees=[self.employees[0]])
        self.assertEqual(value['employees'][0]['status'], 'ready')


if __name__ == '__main__':
    unittest.main()
