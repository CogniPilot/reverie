import io
import json
import os
from pathlib import Path
import tempfile
import unittest
import urllib.error
from unittest.mock import Mock, patch

import agent_loop as loop
from coding_tokens import TokenMeter
from reverie.hands import launcher
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

    def test_startup_retries_transient_office_errors_and_preserves_state_and_settings(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory);sid = 'fixture-session'
            base = root/'hands'/sid;base.mkdir(parents=True)
            state=base/'state.json';state.write_text('{"saved_cursor":"keep"}')
            settings=base/'runtime-settings.json';settings.write_text(json.dumps({'reply_max_tokens':16384,'model_timeout_s':900}));settings.chmod(0o600)
            env={'REVERIE_SESSION_ID':sid,'REVERIE_HANDS_MODEL':'selected-model','REVERIE_HANDS_BASE_URL':'http://127.0.0.1:8092/v1','REVERIE_DATA_DIR':str(root)}
            employee={'name':'Selected employee','personality':'Owner-selected personality'}
            with patch.object(launcher,'company_profile',side_effect=[urllib.error.URLError('temporary'),employee]),patch.object(launcher.time,'sleep'):
                path=launcher.prepare(env)
            cfg=json.loads(path.read_text())
            self.assertEqual(cfg['self_name'],employee['name'])
            self.assertEqual(cfg['reply_max_tokens'],16384)
            self.assertTrue(Path(cfg['memory_instance']).is_file())
            self.assertIsNone(cfg['coding'])
            self.assertEqual(cfg['attachments_root'], '/reverie_workspace/attachments')
            self.assertEqual(cfg['image_tokens_per_image'], 2048)
            self.assertNotIn('attachments_source', cfg)
            self.assertEqual(Path(cfg['model_events_file']).parent, base)
            self.assertEqual(state.read_text(),'{"saved_cursor":"keep"}')
            with patch.object(launcher,'company_profile',return_value=employee):launcher.prepare(env)
            self.assertEqual(json.loads(path.read_text())['reply_max_tokens'],16384)
            denied=urllib.error.HTTPError('http://local',403,'Denied',None,None)
            with patch.object(launcher,'company_profile',side_effect=denied) as profile:
                with self.assertRaises(urllib.error.HTTPError):launcher.prepare(env)
                self.assertEqual(profile.call_count,1)

    def test_runtime_settings_cannot_replace_identity_or_accept_invalid_limits(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'settings.json'
            for value in ({'self_session_id':'other'},{'reply_max_tokens':True},{'model_timeout_s':901}):
                path.write_text(json.dumps(value));path.chmod(0o600)
                with self.assertRaises(ValueError):launcher.runtime_settings(path)
            path.write_text('{}');path.chmod(0o644)
            with self.assertRaises(ValueError):launcher.runtime_settings(path)

    def test_owner_vision_settings_validate_without_overriding_generation_defaults(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'settings.json'
            path.write_text('{"vision":true,"image_tokens_per_image":2048}'); path.chmod(0o600)
            settings = launcher.runtime_settings(path)
            self.assertTrue(settings['vision'])
            self.assertNotIn('temperature', settings)
            self.assertNotIn('reply_max_tokens', settings)
            for value in ({'vision': 1}, {'image_tokens_per_image': True}, {'image_tokens_per_image': 0}):
                path.write_text(json.dumps(value))
                with self.assertRaises(ValueError): launcher.runtime_settings(path)

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
