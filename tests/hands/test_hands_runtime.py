import io
import json
import os
import tempfile
import unittest
from unittest.mock import Mock, patch

import agent_loop as loop
from coding_tokens import TokenMeter
from test_coding_support import cfg_for


class HandsRuntimeTests(unittest.TestCase):
    def test_room_outage_logs_once_then_periodically_and_recovers_without_stale_reads(self):
        room = '12345678-1234-1234-1234-123456789abc'
        state = {'_auto_rooms': [room], '_auto_dms': [room], room: {'seen': ['previous']}}
        before = json.loads(json.dumps(state))
        cfg = {'rooms': 'auto', 'max_rooms': 10, 'state_file': '/unused', '_auto_dms': {room}}
        chat = Mock()
        chat.member_rooms.side_effect = [RuntimeError('secret bearer credential')] * 4 + [
            [{'id': room, 'kind': 'dm'}], RuntimeError('new secret')]
        with patch.object(loop.time, 'monotonic', side_effect=[10, 12, 69, 70, 72, 74]), \
                patch.object(loop, 'log') as log, patch.object(loop, 'save_json') as save:
            for expected_calls in (1, 1, 1, 2):
                self.assertEqual(loop.room_list(cfg, chat, state), [])
                self.assertEqual(log.call_count, expected_calls)
                self.assertEqual(cfg['_auto_dms'], set())
                self.assertEqual(state, before)
                save.assert_not_called()
            self.assertEqual(loop.room_list(cfg, chat, state), [room])
            self.assertEqual(cfg['_auto_dms'], {room})
            self.assertNotIn('_room_list_outage', cfg)
            self.assertEqual(log.call_args.args, ('room list recovered', 'failures=4', 'elapsed_s=62'))
            save.assert_called_once()
            self.assertEqual(loop.room_list(cfg, chat, state), [])
            self.assertEqual(log.call_count, 4)  # a later outage gets its own first warning
        logged = str(log.call_args_list)
        self.assertNotIn('secret', logged)
        self.assertIn('RuntimeError', logged)
        self.assertIn('failures=4', logged)

    def test_model_defaults_are_inherited_unless_owner_overrides_temperature(self):
        cfg = cfg_for('/unused')
        client = Mock(return_value={'content': 'ok'})
        with patch.object(loop, 'ModelClient', return_value=client):
            loop.chat_model(cfg, [])
            self.assertNotIn('temperature', client.call_args.args[0])
            loop.chat_model(dict(cfg, temperature=0.4), [])
            self.assertEqual(client.call_args.args[0]['temperature'], 0.4)

    def test_unfinished_thinking_and_tool_markup_never_become_chat_replies(self):
        with tempfile.TemporaryDirectory() as directory:
            cfg = cfg_for(directory)
            message = {'id': 'message', 'text': 'hello', 'at': 1000, 'from': {'kind': 'user', 'name': 'Owner'}}
            for text in ('<think>unfinished private notes', 'notes</think>answer', '<tool_call>command'):
                result, _, _ = loop.answer(cfg, 'room', [], message, lambda *args: {'content': text}, None)
                self.assertEqual(result, loop.CHAT_FAIL_LINE)
                self.assertNotIn(text, result)
            self.assertEqual(loop.usable({'content': '<think>private notes</think>final'}), 'final')
            result, _, _ = loop.answer(cfg, 'room', [], message,
                lambda *args: {'content': 'partial', '_finish_reason': 'length'}, None)
            self.assertEqual(result, loop.CHAT_LIMIT_LINE)

    def test_token_counting_uses_the_selected_endpoint_credential_without_redirects(self):
        meter=TokenMeter('http://127.0.0.1:8092',context_ceiling=32768,key_env='TEST_MODEL_KEY')
        seen=[]
        class Opener:
            def open(self,request,timeout):
                seen.append(request)
                return io.BytesIO(b'{"tokens":[]}')
        meter.opener=Opener()
        with patch.dict(os.environ,{'TEST_MODEL_KEY':'synthetic-token'},clear=True):meter.request('/tokenize',{'content':'hello'})
        self.assertEqual(seen[0].headers['Authorization'],'Bearer synthetic-token')
        self.assertNotIn('synthetic-token',seen[0].full_url)
        with patch.dict(os.environ,{},clear=True):
            with self.assertRaises(ValueError):meter.request('/props')
