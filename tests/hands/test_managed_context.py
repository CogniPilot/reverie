import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock

import agent_loop as loop
import managed_context as context
from coding_arbiter import ModelArbiter
from coding_manager import TaskManager
from coding_tasks import Limits
from test_coding_arbiter import FakeProcess
from test_coding_support import cfg_for


def issued(text='Company core and current profile.', generation=1):
    return {'employeeId': 'employee-fixture', 'sessionId': 'session-worker', 'sessionGeneration': generation,
            'generatedAt': 1, 'digest': 'sha256:' + hashlib.sha256(text.encode()).hexdigest(),
            'context': text, 'sections': [{'id': 'core-beliefs', 'status': 'configured', 'text': text}],
            'startup': {'status': 'unavailable'}}


class ManagedContextTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(); self.addCleanup(self.directory.cleanup)
        self.cfg = cfg_for(self.directory.name, managed_context=True)
        self.cfg['_turn_summary'] = lambda: ''
        self.cfg['_managed_context_fetch'] = Mock(return_value=issued())
        self.cfg['_managed_context_report'] = Mock()
        self.messages = [{'role': 'system', 'content': 'Required instructions'}, {'role': 'user', 'content': 'Private history sentinel'}]
        FakeProcess.instances = []

    def test_fresh_exact_context_per_request_and_metadata_only_private_manifest(self):
        original = copy.deepcopy(self.messages)
        self.cfg['_managed_context_fetch'].side_effect = [issued('First core'), issued('Second core', 2)]
        first = loop.turn_context(self.cfg, self.messages)
        context.report(self.cfg)
        second = loop.turn_context(self.cfg, self.messages)
        context.report(self.cfg)
        self.assertIn('First core', first[1]['content']); self.assertIn('Second core', second[1]['content'])
        self.assertNotIn('First core', str(second)); self.assertEqual(self.messages, original)
        self.assertEqual([x.args[1] for x in self.cfg['_managed_context_report'].call_args_list], ['startup', 'model-request'])
        path = Path(self.directory.name) / 'managed-context.json'
        record = json.loads(path.read_text())
        self.assertEqual(record['status'], 'included'); self.assertEqual(record['sessionGeneration'], 2)
        self.assertIn('not-model-consumption', record['assurance'])
        self.assertNotIn('Second core', path.read_text()); self.assertNotIn('Private history sentinel', path.read_text())
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_failure_replaces_context_with_unknown_and_never_reports_empty_success(self):
        self.cfg['_managed_context_fetch'].side_effect = RuntimeError('PRIVATE_KEY_SHOULD_NOT_LOG')
        request = loop.turn_context(self.cfg, self.messages)
        context.report(self.cfg)
        self.assertIn(context.UNKNOWN, request[1]['content'])
        self.assertNotIn('PRIVATE_KEY', str(request)); self.cfg['_managed_context_report'].assert_not_called()
        self.assertEqual(json.loads((Path(self.directory.name) / 'managed-context.json').read_text())['status'], 'unavailable')

    def test_binding_mismatch_is_unknown_not_another_employee_context(self):
        value = issued(); value['sessionId'] = 'another'
        self.cfg['_managed_context_fetch'].return_value = value
        request = loop.turn_context(self.cfg, self.messages)
        self.assertIn(context.UNKNOWN, request[1]['content']); self.assertNotIn(value['context'], str(request))

    def test_optional_runtime_epoch_is_preserved_without_claiming_provider_attestation(self):
        value = issued(); value['runtimeBinding'] = 'sha256:' + 'a' * 64
        self.cfg['_managed_context_fetch'].return_value = value
        loop.turn_context(self.cfg, self.messages)
        record = json.loads((Path(self.directory.name) / 'managed-context.json').read_text())
        self.assertEqual(record['runtimeBinding'], value['runtimeBinding'])
        value['runtimeBinding'] = 'unknown'
        self.assertIn(context.UNKNOWN, loop.turn_context(self.cfg, self.messages)[1]['content'])

    def test_a_later_success_cannot_be_mislabeled_as_the_missing_startup_input(self):
        self.cfg['_managed_context_fetch'].side_effect = [ValueError('unavailable'), issued()]
        loop.turn_context(self.cfg, self.messages); context.report(self.cfg)
        loop.turn_context(self.cfg, self.messages); context.report(self.cfg)
        self.assertEqual(self.cfg['_managed_context_report'].call_args.args[1], 'model-request')

    def test_budget_partial_is_explicit_and_cannot_report_whole_issued_digest(self):
        self.cfg['prompt_cap_chars'] = 400
        self.cfg['_managed_context_fetch'].return_value = issued('Core ' * 1000)
        request = loop.turn_context(self.cfg, self.messages)
        self.assertLessEqual(loop.request_chars(request), 400)
        self.assertIn('truncated', request[1]['content'])
        context.report(self.cfg); self.cfg['_managed_context_report'].assert_not_called()
        self.assertEqual(json.loads((Path(self.directory.name) / 'managed-context.json').read_text())['status'], 'partial')

    def test_no_room_for_unknown_refuses_instead_of_dropping_required_input(self):
        self.cfg['prompt_cap_chars'] = loop.request_chars(self.messages)
        with self.assertRaises(ValueError): loop.turn_context(self.cfg, self.messages)

    def test_generic_unmanaged_config_has_no_implicit_network_or_snapshot(self):
        self.cfg['managed_context'] = False
        self.assertEqual(loop.turn_context(self.cfg, self.messages), self.messages)
        self.cfg['_managed_context_fetch'].assert_not_called()
        self.assertFalse((Path(self.directory.name) / 'managed-context.json').exists())

    def test_coding_preemption_refreshes_each_actual_worker_start_without_accumulation(self):
        versions = iter(['first', 'second'])
        def prepare(payload): return dict(payload, messages=payload['messages'] + [{'role': 'system', 'content': next(versions)}])
        arbiter = ModelArbiter('http://unused.invalid', prepare_request=prepare, process_factory=FakeProcess, clock=lambda: 0)
        self.addCleanup(arbiter.cancel)
        payload = {'messages': copy.deepcopy(self.messages)}
        arbiter.submit(payload, 20); arbiter.pause_for_chat(); arbiter.resume()
        self.assertEqual(FakeProcess.instances[0].body['payload']['messages'][-1]['content'], 'first')
        self.assertEqual(FakeProcess.instances[1].body['payload']['messages'][-1]['content'], 'second')
        self.assertEqual(payload['messages'], self.messages)

    def test_coding_authorization_is_after_slow_context_and_receipt_io(self):
        events = []
        self.cfg['_managed_context_fetch'] = lambda: events.append('fetch') or issued()
        self.cfg['_managed_context_report'] = lambda *args: events.append('receipt')
        manager = TaskManager(loop, self.cfg, Mock())
        manager.active = {'limits': Limits(prompt_chars=30000)}
        manager.authorization = lambda: events.append('authorize') or 'owner-revoked'
        arbiter = ModelArbiter('http://unused.invalid', prepare_request=manager.prepare_model_request,
                               process_factory=FakeProcess, clock=lambda: 0)
        self.addCleanup(arbiter.cancel)
        arbiter.submit({'messages': self.messages, 'tools': []}, 20)
        self.assertEqual(events, ['fetch', 'receipt', 'authorize'])
        self.assertEqual(FakeProcess.instances, [])
        arbiter.resume()  # A failed preparation is terminal for this request, never an implicit retry.
        self.assertEqual(events, ['fetch', 'receipt', 'authorize'])
        self.assertEqual(arbiter.poll(), {'ok': False, 'error': 'model_context_unavailable'})

    def test_context_preparation_cannot_extend_parent_deadline(self):
        now = [0]
        def prepare(payload): now[0] = 30; return payload
        arbiter = ModelArbiter('http://unused.invalid', prepare_request=prepare, process_factory=FakeProcess, clock=lambda: now[0])
        self.addCleanup(arbiter.cancel)
        arbiter.submit({'messages': []}, 10)
        self.assertFalse(FakeProcess.instances)
        self.assertEqual(arbiter.poll(), {'ok': False, 'error': 'model_deadline'})
