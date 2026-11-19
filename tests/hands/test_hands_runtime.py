import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import agent_loop as loop
from test_coding_support import cfg_for


class HandsRuntimeTests(unittest.TestCase):
    def test_room_outage_logs_once_then_periodically_and_recovers_without_stale_reads(self):
        room = '12345678-1234-1234-1234-123456789abc'
        state = {'_auto_rooms': [room], '_auto_dms': [room],
                 room: {'since': 1, 'last_id': 'previous', 'seen': ['previous']}}
        before = json.loads(json.dumps(state))
        chat = Mock()
        chat.member_rooms.side_effect = [RuntimeError('secret bearer credential')] * 4 + [
            [{'id': room, 'kind': 'dm', 'lastMessage': {'id': 'previous'}}], RuntimeError('new secret')]
        with tempfile.TemporaryDirectory() as root, \
                patch.object(loop, 'room_list_clock', side_effect=[10, 12, 69, 70, 72, 74]), \
                patch.object(loop, 'log') as log:
            cfg = cfg_for(root, rooms='auto', max_rooms=10, _auto_dms={room})
            path = Path(cfg['state_file'])
            for expected_calls in (1, 1, 1, 2):
                self.assertEqual(loop.tick(cfg, chat, state), 0)
                self.assertEqual(log.call_count, expected_calls)
                self.assertEqual(cfg['_auto_dms'], set())
                self.assertEqual(state, before)
                self.assertFalse(path.exists())
            self.assertEqual(loop.tick(cfg, chat, state), 0)
            self.assertEqual(cfg['_auto_dms'], {room})
            self.assertNotIn('_room_list_outage', cfg)
            self.assertEqual(log.call_args.args, ('room list recovered', 'failures=4', 'elapsed_s=62'))
            self.assertEqual(json.loads(path.read_text()), state)
            self.assertEqual(loop.tick(cfg, chat, state), 0)
            self.assertEqual(log.call_count, 4)  # a later outage gets its own first warning
        logged = str(log.call_args_list)
        self.assertNotIn('secret', logged)
        self.assertIn('RuntimeError', logged)
        self.assertIn('failures=4', logged)

    def test_model_defaults_are_inherited_unless_owner_overrides_temperature(self):
        cfg = cfg_for('/unused')
        client = Mock(return_value={'content': 'ok'})
        with patch.object(loop.coding_chat, 'model_completion', client):
            loop.chat_model(cfg, [])
            self.assertNotIn('temperature', client.call_args.args[0]['payload'])
            loop.chat_model(dict(cfg, temperature=0.4), [])
            self.assertEqual(client.call_args.args[0]['payload']['temperature'], 0.4)

    def test_unfinished_thinking_and_tool_markup_never_become_chat_replies(self):
        with tempfile.TemporaryDirectory() as directory:
            cfg = cfg_for(directory)
            message = {'id': 'message', 'text': 'hello', 'at': 1000, 'from': {'kind': 'user', 'name': 'Owner'}}
            for text in ('<think>unfinished private notes', 'notes</think>answer', '<tool_call>command'):
                result, _, _ = loop.answer(cfg, 'room', [], message, lambda *args: {'content': text}, None)
                self.assertEqual(result, "I couldn't finish a usable answer. Please ask me to try again.")
                self.assertNotIn(text, result)
            self.assertEqual(loop.turn_request('visible', output={'content': '<think>private notes</think>final'})['reply'], 'final')
            result, _, _ = loop.answer(cfg, 'room', [], message,
                lambda *args: {'content': 'partial', '_finish_reason': 'length'}, None)
            self.assertEqual(result, "I reached my response limit before finishing. Please ask me to continue.")
