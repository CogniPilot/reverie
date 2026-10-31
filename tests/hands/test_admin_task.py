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
        return {'admin_task': 'workspace', 'self_name': 'Helper', 'self_session_id': 'helper-session',
                'coding': {'tasks': {'workspace': {'enabled': True, 'rooms': ['office', 'break-room'], 'delegate_sessions': ['delegate']}}}}

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
        message = {'id': 'original-message', 'from': OWNER, 'text': '@Helper Create the four Board decision requests.'}
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

    def test_cancel_tool_stops_only_this_harness_task_with_the_requesters_identity(self):
        manager = Mock();manager.control.return_value = 'Task workspace cancelled.'
        message = {'id': 'stop-message', 'from': OWNER, 'text': 'stop that'}
        callback = admin_task.callback(self.config(), manager, {}, 'office', [], message)
        call = {'type': 'function', 'id': 'call_1', 'function': {'name': admin_task.CANCEL_TOOL_NAME, 'arguments': '{}'}}
        self.assertEqual(admin_task.invoke({'tool_calls': [call]}, callback), 'Task workspace cancelled.')
        room, sent = manager.control.call_args.args[1], manager.control.call_args.args[3]
        self.assertEqual((room, sent['id'], sent['from'], sent['text']), ('office', 'stop-message', OWNER, '/code-cancel workspace'))
        self.assertNotIn('canonical_source', manager.control.call_args.kwargs)

    def test_cancel_tool_refuses_arguments_parallel_calls_and_unbound_senders(self):
        start = Mock()
        cancel = {'type': 'function', 'id': 'one', 'function': {'name': admin_task.CANCEL_TOOL_NAME, 'arguments': json.dumps({'brief': 'x'})}}
        self.assertIn('invalid structured', admin_task.invoke({'tool_calls': [cancel]}, start))
        cancel['function']['arguments'] = '{}'
        run = {'type': 'function', 'id': 'two', 'function': {'name': admin_task.TOOL_NAME, 'arguments': json.dumps({'brief': 'x'})}}
        self.assertIn('one workspace task', admin_task.invoke({'tool_calls': [cancel, run]}, start))
        self.assertIn('no authorized', admin_task.invoke({'tool_calls': [cancel]}, None))
        start.assert_not_called();start.cancel.assert_not_called()
        self.assertIn('cancel_workspace_task', admin_task.RULE)

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

    def test_a_bound_senders_conversation_never_starts_work_but_can_still_stop_it(self):
        # The incident: a bound delegate narrated a game turn as a reply to another player. The harness's model answered
        # it with run_workspace_task and a workspace task started; the later stop was refused.
        cfg = self.config();manager = Mock();manager.control.return_value = 'Task workspace cancelled.'
        history = [{'id': 'player-turn', 'from': {'kind': 'agent', 'sessionId': 'player', 'name': 'Player'}, 'text': 'Latch takes the rope.'},
                   {'id': 'helper-said', 'from': {'kind': 'agent', 'sessionId': 'helper-session', 'name': 'Helper'}, 'text': 'Holding.'}]
        turn = {'id': 'game-turn', 'from': DELEGATE, 'replyTo': 'player-turn',
                'text': 'Latch, there is a waist-high stone mooring post beside the stair; a rope would reach the lower landing.'}
        callback = admin_task.callback(cfg, manager, {}, 'break-room', history, turn)
        self.assertEqual([tool['function']['name'] for tool in callback.tools], [admin_task.CANCEL_TOOL_NAME])
        run = {'type': 'function', 'id': 'call_1', 'function': {'name': admin_task.TOOL_NAME, 'arguments': json.dumps({'brief': 'tie the rope'})}}
        self.assertIn('did not address me', admin_task.invoke({'tool_calls': [run]}, callback))
        manager.control.assert_not_called()
        stop = {'type': 'function', 'id': 'call_2', 'function': {'name': admin_task.CANCEL_TOOL_NAME, 'arguments': '{}'}}
        self.assertEqual(admin_task.invoke({'tool_calls': [stop]}, callback), 'Task workspace cancelled.')
        for everyone in ('@everyone run the tests', '@here everyone close your laptops', 'helper run the tests', 'email@Helper.dev'):
            self.assertEqual(admin_task.callback(cfg, Mock(), {}, 'office', history, {'id': 'x', 'from': DELEGATE, 'text': everyone}).tools,
                             [admin_task.CANCEL_TOOL], everyone)

    def test_the_owners_own_message_may_start_work_without_a_mention(self):
        # The owner's decision: the owner's plain message in a bound shared room is addressed, as wakes() treats it.
        cfg = self.config()
        for text in ('Helper, please run the tests', 'run the tests', '@everyone run the tests'):
            callback = admin_task.callback(cfg, Mock(), {}, 'office', [], {'id': 'o', 'from': OWNER, 'text': text})
            self.assertEqual(callback.tools, admin_task.TOOLS, text)
        # A user message that is not the authenticated owner's is not bound at all, so it never reaches the start tool.
        self.assertIsNone(admin_task.callback(cfg, Mock(), {}, 'office', [], {'id': 'u', 'from': {'kind': 'user', 'name': 'Owner'}, 'text': 'run the tests'}))

    def test_a_message_that_addresses_the_harness_may_start_work(self):
        cfg = dict(self.config(), dm_rooms=['dm-room'])
        history = [{'id': 'helper-said', 'from': {'kind': 'agent', 'sessionId': 'helper-session', 'name': 'Helper'}, 'text': 'Done?'}]
        for room, message in (('office', {'text': '@helper please run the tests'}), ('office', {'text': 'yes, go ahead', 'replyTo': 'helper-said'}),
                              ('office', {'text': 'run them', 'to': ['helper-session']}), ('dm-room', {'text': 'run the tests'})):
            cfg['coding']['tasks']['workspace']['rooms'] = ['office', 'dm-room']
            callback = admin_task.callback(cfg, Mock(), {}, room, history, {'id': 'm', 'from': OWNER, **message})
            self.assertEqual(callback.tools, admin_task.TOOLS, message)

    def test_answer_offers_only_the_cancel_tool_for_conversation(self):
        with tempfile.TemporaryDirectory() as directory:
            cfg = cfg_for(directory)
            start = Mock(return_value='unused');start.tools = [admin_task.CANCEL_TOOL];cfg['_admin_start_task'] = start
            seen = [];prompts = []
            def model(config, messages, tools):
                seen.append([tool['function']['name'] for tool in tools or []])
                prompts.append(messages[0]['content'])
                return {'content': 'Nice roll!'}
            reply, _, _ = loop.answer(cfg, 'office', [], {'id': 'm', 'text': 'Latch ties the rope.', 'from': OWNER}, model, None)
            self.assertEqual(reply, 'Nice roll!')
            self.assertTrue(seen and all(admin_task.TOOL_NAME not in names for names in seen))
            self.assertTrue(any(admin_task.CANCEL_TOOL_NAME in names for names in seen))
            # The prompt never tells the model to use a tool it was not given.
            self.assertTrue(prompts and all(admin_task.TOOL_NAME not in prompt for prompt in prompts))
            self.assertTrue(all(admin_task.CANCEL_RULE in prompt for prompt in prompts))
            start.assert_not_called()
            # A message that addresses the harness still gets the start tool and the rule that names it.
            start.tools = admin_task.TOOLS;seen.clear();prompts.clear()
            loop.answer(cfg, 'office', [], {'id': 'm2', 'text': '@Helper run the tests.', 'from': OWNER}, model, None)
            self.assertTrue(seen and all(admin_task.TOOL_NAME in names for names in seen))
            self.assertTrue(prompts and all(admin_task.RULE in prompt for prompt in prompts))
        # The prompt reserve is sized for RULE, so the cancel-only rule must not be longer.
        self.assertLessEqual(len(admin_task.CANCEL_RULE), len(admin_task.RULE))
        self.assertNotIn(admin_task.TOOL_NAME, admin_task.CANCEL_RULE)

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
