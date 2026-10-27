import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
import agent_loop as loop
import admin_task
import coding_chat
from coding_tasks import Limits, reserve_chars, parse_call
from test_coding_support import cfg_for

OWNER = {'kind': 'user', 'name': 'Owner', 'authenticatedOwner': True}
DELEGATE = {'kind': 'agent', 'sessionId': 'delegate'}

class NaturalAdminTaskTests(unittest.TestCase):
    def test_small_context_profile_keeps_the_worst_case_reserve_and_argument_cap_consistent(self):
        limits = Limits(prompt_chars=30000, frame_chars=4000, argument_chars=3000, output_chars=3000)
        self.assertLess(reserve_chars(limits), 26000)
        call = {'id': 'call_1', 'type': 'function', 'function': {'name': 'write_file', 'arguments': json.dumps({'path':'file.py','content':'x'*4000})}}
        with self.assertRaises(ValueError):parse_call(call, {'write_file'}, limits)
        self.assertEqual(Limits().argument_chars, 24000)

    def config(self):
        return {'admin_task': 'workspace', 'coding': {'tasks': {'workspace': {'enabled': True, 'rooms': ['office'], 'delegate_sessions': ['delegate']}}}}

    def test_only_actual_owner_or_explicit_delegate_and_room_get_a_task_tool(self):
        cfg = self.config();manager = Mock()
        for sender in (OWNER, DELEGATE):
            callback = admin_task.callback(cfg, manager, {}, 'office', [], {'id': 'source', 'text': 'file the cards', 'from': sender})
            self.assertTrue(callable(callback))
        for sender in ({'kind': 'user', 'name': 'Owner'}, {'kind': 'agent', 'sessionId': 'stranger'}, {'kind': 'human'}):
            self.assertIsNone(admin_task.callback(cfg, manager, {}, 'office', [], {'from': sender}))
        self.assertIsNone(admin_task.callback(cfg, manager, {}, 'other-room', [], {'from': OWNER}))
        cfg['coding']['tasks']['workspace']['enabled'] = False
        self.assertIsNone(admin_task.callback(cfg, manager, {}, 'office', [], {'from': OWNER}))
        manager.control.assert_not_called()

    def test_structured_tool_starts_existing_manager_with_original_identity_and_source_id(self):
        manager = Mock();manager.control.return_value = 'Task workspace queued'
        cfg = self.config();state = {};history = []
        message = {'id': 'original-message', 'from': OWNER, 'text': 'Create the four Board decision requests.'}
        callback = admin_task.callback(cfg, manager, state, 'office', history, message)
        call = {'type': 'function', 'id': 'call_1', 'function': {'name': admin_task.TOOL_NAME, 'arguments': json.dumps({'brief': 'Read the Board, add missing IDs, verify.'})}}
        self.assertEqual(admin_task.invoke({'tool_calls': [call]}, callback), 'Task workspace queued')
        sent = manager.control.call_args.args[3]
        self.assertEqual(sent['id'], message['id']);self.assertEqual(sent['from'], OWNER)
        self.assertTrue(sent['text'].startswith('/code workspace '))
        self.assertIn(message['text'], sent['text']);self.assertNotIn('/code ', message['text'])
        self.assertEqual(manager.control.call_args.kwargs['canonical_source'], message)

    def test_plain_text_and_malformed_or_parallel_calls_never_execute(self):
        start = Mock()
        self.assertIsNone(admin_task.invoke({'content': 'I will run the commands now.'}, start))
        self.assertIsNone(admin_task.invoke({'content': '<tool_call>run_workspace_task</tool_call>'}, start))
        call = {'type': 'function', 'id': 'one', 'function': {'name': admin_task.TOOL_NAME, 'arguments': '{bad'}}
        self.assertIn('invalid structured', admin_task.invoke({'tool_calls': [call]}, start))
        call['function']['arguments'] = json.dumps({'brief': 'work'})
        self.assertIn('one workspace task', admin_task.invoke({'tool_calls': [call, call]}, start))
        self.assertIn('no authorized', admin_task.invoke({'tool_calls': [call]}, None))
        start.assert_not_called()

    def test_normal_chat_offers_real_task_tool_and_returns_observed_queue_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            cfg = cfg_for(directory);cfg['_admin_start_task'] = Mock(return_value='Task workspace queued; not complete')
            def model(config, messages, tools):
                self.assertEqual(tools[0]['function']['name'], admin_task.TOOL_NAME)
                self.assertIn('plain chat answer does not run commands', messages[0]['content'])
                return {'tool_calls': [{'type': 'function', 'id': 'call_1', 'function': {'name': admin_task.TOOL_NAME, 'arguments': json.dumps({'brief': 'Edit and run the test.'})}}]}
            reply, size, _ = loop.answer(cfg, 'office', [], {'id': 'm', 'text': 'Edit and test this file.', 'from': OWNER}, model, None)
            self.assertIn('not complete', reply);self.assertLessEqual(size, cfg['prompt_cap_chars'])
            cfg['_admin_start_task'].assert_called_once_with('Edit and run the test.')

    def test_office_access_preserves_only_own_loopback_context_when_explicitly_enabled(self):
        cfg = self.config();cfg['self_session_id'] = '11111111-2222-4333-8444-555555555555'
        with patch.dict(os.environ, {'REVERIE_API_URL': 'http://127.0.0.1:8093', 'REVERIE_PASSWORD': 'NO_PASSWORD_COPY', 'REVERIE_HANDS_API_KEY': 'NO_MODEL_KEY_COPY'}):
            self.assertEqual(coding_chat.office_environment(cfg, 'workspace'), {})
            cfg['coding']['tasks']['workspace']['office_access'] = True
            context = coding_chat.office_environment(cfg, 'workspace')
            self.assertEqual(context['REVERIE_SESSION_ID'], cfg['self_session_id'])
            self.assertEqual(context['REVERIE_MUX'], '1')
            self.assertNotIn('REVERIE_PASSWORD', context);self.assertNotIn('REVERIE_HANDS_API_KEY', context)
            with patch.dict(os.environ, {'REVERIE_API_URL': 'http://outside.example'}):
                with self.assertRaises(ValueError):coding_chat.office_environment(cfg, 'workspace')
