import copy
import hashlib
import json
from pathlib import Path
import shutil
import tempfile
import time
import unittest
from unittest.mock import Mock

import agent_loop as loop
from coding_chat import report_managed_context
from coding_manager import TaskManager
from coding_chat import Limits
from coding_process import ModelArbiter
from test_coding_support import ModelEndpoint, cfg_for, wait_model_reply


UNKNOWN = 'Managed context unavailable; current core/profile/startup context is unknown.'


def issued(text='Company core and current profile.', generation=1):
    return {'employeeId': 'employee-fixture', 'sessionId': 'session-worker', 'sessionGeneration': generation,
            'generatedAt': 1, 'digest': 'sha256:' + hashlib.sha256(text.encode()).hexdigest(),
            'context': text, 'sections': [{'id': 'core-beliefs', 'status': 'configured', 'text': text}],
            'startup': {'status': 'unavailable'}}


class ManagedContextTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(); self.addCleanup(self.directory.cleanup)
        self.cfg = cfg_for(self.directory.name, managed_context=True)
        self.root = Path(self.directory.name)
        fixture = Path(__file__).parent / 'fixtures' / 'managed_context_cli.mjs'
        node = shutil.which('node')
        self.assertIsNotNone(node)
        self.cfg['cli'] = [node, str(fixture.resolve()), str(self.root), 'agent', 'chat']
        self.cfg['_turn_summary'] = lambda: ''
        self.set_response(issued())
        self.messages = [{'role': 'system', 'content': 'Required instructions'}, {'role': 'user', 'content': 'Private history sentinel'}]

    def set_response(self, response, *, refuse_receipt=False, hold_fetch_ms=0):
        (self.root / 'context-response.json').write_text(json.dumps({
            'response': response, 'refuseReceipt': refuse_receipt, 'holdFetchMs': hold_fetch_ms,
        }))

    def events(self):
        path = self.root / 'context-events.jsonl'
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def receipts(self):
        return [event[1:] for event in self.events() if event[0] == 'receipt']

    def test_fresh_exact_context_per_request_and_metadata_only_private_manifest(self):
        original = copy.deepcopy(self.messages)
        first_issued = issued('First core')
        second_issued = issued('Second core', 2)
        self.set_response(first_issued)
        first, first_size = loop.turn_context(self.cfg, self.messages)
        report_managed_context(self.cfg)
        self.set_response({'success': True, 'data': second_issued})
        second, second_size = loop.turn_context(self.cfg, self.messages)
        report_managed_context(self.cfg)
        self.assertIn('First core', first[1]['content']); self.assertIn('Second core', second[1]['content'])
        self.assertNotIn('First core', str(second)); self.assertEqual(self.messages, original)
        self.assertEqual(first_size, loop.request_chars(first))
        self.assertEqual(second_size, loop.request_chars(second))
        self.assertEqual(self.receipts(), [[first_issued['digest'], 'startup'],
                                           [second_issued['digest'], 'model-request']])
        path = Path(self.directory.name) / 'managed-context.json'
        record = json.loads(path.read_text())
        self.assertEqual(record['status'], 'included'); self.assertEqual(record['sessionGeneration'], 2)
        self.assertIn('not-model-consumption', record['assurance'])
        self.assertNotIn('Second core', path.read_text()); self.assertNotIn('Private history sentinel', path.read_text())
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_failure_replaces_context_with_unknown_and_never_reports_empty_success(self):
        self.set_response(None)
        request, _ = loop.turn_context(self.cfg, self.messages)
        report_managed_context(self.cfg)
        self.assertIn(UNKNOWN, request[1]['content'])
        self.assertEqual(self.receipts(), [])
        self.assertEqual(json.loads((Path(self.directory.name) / 'managed-context.json').read_text())['status'], 'unavailable')

    def test_binding_mismatch_is_unknown_not_another_employee_context(self):
        value = issued(); value['sessionId'] = 'another'
        self.set_response(value)
        request, _ = loop.turn_context(self.cfg, self.messages)
        self.assertIn(UNKNOWN, request[1]['content']); self.assertNotIn(value['context'], str(request))

    def test_optional_runtime_epoch_is_preserved_without_claiming_provider_attestation(self):
        value = issued(); value['runtimeBinding'] = 'sha256:' + 'a' * 64
        self.set_response(value)
        loop.turn_context(self.cfg, self.messages)
        record = json.loads((Path(self.directory.name) / 'managed-context.json').read_text())
        self.assertEqual(record['runtimeBinding'], value['runtimeBinding'])
        value['runtimeBinding'] = 'unknown'
        self.set_response(value)
        request, _ = loop.turn_context(self.cfg, self.messages)
        self.assertIn(UNKNOWN, request[1]['content'])

    def test_a_later_success_cannot_be_mislabeled_as_the_missing_startup_input(self):
        self.set_response(None)
        loop.turn_context(self.cfg, self.messages); report_managed_context(self.cfg)
        latest = issued()
        self.set_response(latest)
        loop.turn_context(self.cfg, self.messages); report_managed_context(self.cfg)
        self.assertEqual(self.receipts(), [[latest['digest'], 'model-request']])

    def test_budget_partial_is_explicit_and_cannot_report_whole_issued_digest(self):
        self.cfg['prompt_cap_chars'] = 400
        self.set_response(issued('Core ' * 1000))
        request, size = loop.turn_context(self.cfg, self.messages)
        self.assertLessEqual(size, 400)
        self.assertIn('truncated', request[1]['content'])
        report_managed_context(self.cfg)
        self.assertEqual(self.receipts(), [])
        self.assertEqual(json.loads((Path(self.directory.name) / 'managed-context.json').read_text())['status'], 'partial')

    def test_no_room_for_unknown_refuses_instead_of_dropping_required_input(self):
        self.cfg['prompt_cap_chars'] = loop.request_chars(self.messages)
        with self.assertRaises(ValueError): loop.turn_context(self.cfg, self.messages)
        self.assertEqual(self.events(), [])

    def test_generic_unmanaged_config_has_no_implicit_network_or_snapshot(self):
        self.cfg['managed_context'] = False
        request, _ = loop.turn_context(self.cfg, self.messages)
        self.assertEqual(request, self.messages)
        self.assertEqual(self.events(), [])
        self.assertFalse((Path(self.directory.name) / 'managed-context.json').exists())

    def test_refused_receipt_keeps_the_supervisor_unreported(self):
        exact = issued()
        self.set_response(exact, refuse_receipt=True)
        loop.turn_context(self.cfg, self.messages)
        report_managed_context(self.cfg)
        report_managed_context(self.cfg)
        self.assertFalse(self.cfg.get('_managed_context_reported'))
        self.assertEqual(self.receipts(), [[exact['digest'], 'startup']])

    def test_slow_scoped_cli_is_bounded_and_records_unknown(self):
        self.set_response(issued(), hold_fetch_ms=10_000)
        start = time.monotonic()
        request, _ = loop.turn_context(self.cfg, self.messages)
        self.assertLess(time.monotonic() - start, 3)
        self.assertIn(UNKNOWN, request[1]['content'])
        self.assertEqual(self.events(), [['fetch']])
        record = json.loads((self.root / 'managed-context.json').read_text())
        self.assertEqual(record['status'], 'unavailable')

    def test_coding_preemption_refreshes_each_actual_worker_start_without_accumulation(self):
        versions = iter(['first', 'second'])
        def prepare(payload): return dict(payload, messages=payload['messages'] + [{'role': 'system', 'content': next(versions)}])
        endpoint = ModelEndpoint(self, hold_first=True)
        arbiter = ModelArbiter(endpoint.url, prepare_request=prepare)
        self.addCleanup(arbiter.cancel)
        payload = {'model': 'fixture', 'messages': copy.deepcopy(self.messages)}
        arbiter.submit(payload, 20)
        self.assertEqual(endpoint.receive()[1]['messages'][-1]['content'], 'first')
        arbiter.pause_for_chat()
        endpoint.wait_disconnected()
        arbiter.resume()
        self.assertEqual(endpoint.receive()[1]['messages'][-1]['content'], 'second')
        self.assertEqual(payload['messages'], self.messages)

    def test_coding_authorization_is_after_slow_context_and_receipt_io(self):
        observed = []
        manager = TaskManager(loop, self.cfg, Mock())
        manager.active = {'limits': Limits(prompt_chars=30000)}
        manager.authorization = lambda: observed.extend(event[0] for event in self.events()) or 'owner-revoked'
        endpoint = ModelEndpoint(self)
        arbiter = ModelArbiter(endpoint.url, prepare_request=manager.prepare_model_request)
        self.addCleanup(arbiter.cancel)
        arbiter.submit({'messages': self.messages, 'tools': []}, 20)
        self.assertEqual(observed, ['fetch', 'receipt'])
        arbiter.resume()  # A failed preparation is terminal for this request, never an implicit retry.
        self.assertEqual([event[0] for event in self.events()], ['fetch', 'receipt'])
        self.assertEqual(observed, ['fetch', 'receipt'])
        self.assertEqual(arbiter.poll(), {'ok': False, 'error': 'model_context_unavailable'})
        arbiter.cancel()
        self.assertEqual(arbiter.requests_started, 0)
        self.assertFalse(endpoint.has_event())

    def test_context_preparation_cannot_extend_parent_deadline(self):
        def prepare(payload):
            prepared.append(True)
            time.sleep(.45)
            return payload
        prepared = []
        endpoint = ModelEndpoint(self)
        arbiter = ModelArbiter(endpoint.url, prepare_request=prepare)
        self.addCleanup(arbiter.cancel)
        arbiter.submit({'model': 'fixture', 'messages': []}, .25)
        self.assertEqual(wait_model_reply(arbiter), {'ok': False, 'error': 'model_deadline'})
        self.assertEqual(prepared, [True])
        arbiter.cancel()
        self.assertEqual(arbiter.requests_started, 0)
        self.assertFalse(endpoint.has_event())
