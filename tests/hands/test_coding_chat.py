import copy
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import agent_loop as loop
import coding_chat
from reverie.hands.coding_tasks import control_request, permitted_sender
from reverie.hands.launcher import runtime_settings
from config_location import configuration_path
from test_coding_support import FakeChat, cfg_for


OWNER = {'kind': 'user', 'name': 'Owner', 'mark': 'owner_typed', 'authenticatedOwner': True}
DELEGATE = {'kind': 'agent', 'sessionId': 'session-operator', 'name': 'Operator'}
MEMORY_SESSION = '10000000-0000-0000-0000-000000000001'
MEMORY_ROOM = '20000000-0000-0000-0000-000000000002'


class AuthorizationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.settings = {'root': str(self.root / 'tasks'), 'tool_schema_file': str(self.root / 'schemas.json'),
                         'runner_argv': ['/unused-runner'], 'profiles': {'drill': {}},
                         'tasks': {'fixture': {'rooms': ['room'], 'delegate_sessions': ['session-operator']}}}
        self.cfg = cfg_for(self.directory.name, coding=self.settings)
        self.chat = FakeChat()
        self.chat.member = [{'id': 'room'}]
        self.message = self.chat.add('room', OWNER, '/code fixture Inspect it.')

    def authorize(self, **kwargs):
        return coding_chat.authorize_task(loop, self.cfg, self.chat, 'room', self.message,
                                           self.settings, 'fixture', time.monotonic() + 30, **kwargs)

    def test_owner_authorization_requires_membership_and_valid_metadata(self):
        self.assertIsNone(self.authorize())
        self.chat.member = []
        self.assertEqual(self.authorize(), 'not_member')

    def test_coding_metadata_failure_is_closed_not_ordinary_chat_fallback(self):
        with patch.object(self.chat, 'member_alert', side_effect=TimeoutError('synthetic failure')):
            self.assertEqual(self.authorize(), 'authorization_unavailable')

    def test_nan_lease_cannot_trigger_fallback(self):
        self.chat.member_alert = lambda *args: {'lease': {'mode': 'silent', 'until': float('nan')}}
        self.assertEqual(self.authorize(), 'authorization_unavailable')

    def test_delegate_cannot_bypass_silent(self):
        self.message['from'] = DELEGATE
        self.message['text'] += ' @Worker'
        self.chat.member_alert = lambda *args: {'lease': {'mode': 'silent', 'until': 9999999999999},
                                                'name': 'Worker', 'unique': True}
        self.assertEqual(self.authorize(), 'silent')

    def test_owner_cancellation_but_not_unknown_peer_cancellation(self):
        cancel = self.chat.add('room', {'kind': 'agent', 'sessionId': 'other'}, '/code-cancel fixture')
        self.assertIsNone(self.authorize())
        cancel['from'] = OWNER
        self.assertEqual(self.authorize(), 'cancelled')
        self.assertIsNone(self.authorize(check_cancel=False))

    def test_muted_cancel_is_history_and_does_not_cancel_current_work(self):
        cancel = self.chat.add('room', OWNER, '/code-cancel fixture')
        cancel['phoneWake'] = False
        self.assertIsNone(self.authorize())

    def test_current_config_change_revokes_authority(self):
        path = self.root / 'instance.json'
        path.write_text(json.dumps({'coding': self.settings}))
        self.cfg['_config_path'] = str(path)
        self.assertIsNone(self.authorize())
        changed = json.loads(path.read_text())
        changed['coding']['tasks']['fixture']['delegate_sessions'] = []
        path.write_text(json.dumps(changed))
        self.assertEqual(self.authorize(), 'revoked')

    def test_fresh_owner_revocation_cannot_use_the_cached_grant(self):
        self.message = copy.deepcopy(self.message)
        self.chat.rooms['room'][0]['from'] = dict(OWNER, authenticatedOwner=False)
        self.assertTrue(self.message['from']['authenticatedOwner'])
        self.assertEqual(self.authorize(), 'revoked')

    def test_owner_revocation_during_slow_metadata_is_rechecked_last(self):
        self.message = copy.deepcopy(self.message)
        original = self.chat.member_rooms
        def revoke():
            self.chat.rooms['room'][0]['from'] = dict(OWNER, authenticatedOwner=False)
            return original()
        with patch.object(self.chat, 'member_rooms', side_effect=revoke):
            self.assertEqual(self.authorize(), 'revoked')

    def test_current_settings_are_rechecked_after_slow_metadata(self):
        path = self.root / 'instance.json'
        path.write_text(json.dumps({'coding': self.settings}))
        self.cfg['_config_path'] = str(path)
        original = self.chat.member_rooms
        def change():
            changed = copy.deepcopy(self.settings)
            changed['tasks']['fixture']['enabled'] = False
            path.write_text(json.dumps({'coding': changed}))
            return original()
        with patch.object(self.chat, 'member_rooms', side_effect=change):
            self.assertEqual(self.authorize(), 'revoked')

    def test_exact_source_is_the_last_remote_authorization_read(self):
        calls = []
        for name in ('member_rooms', 'member_alert', 'read', 'exact_message'):
            original = getattr(self.chat, name)
            def observed(*args, _name=name, _original=original):
                calls.append(_name)
                return _original(*args)
            setattr(self.chat, name, observed)
        self.assertIsNone(self.authorize())
        self.assertEqual(calls, ['member_rooms', 'member_alert', 'read', 'exact_message'])

    def test_exact_source_edits_or_wrong_identity_revoke_before_tools(self):
        original = copy.deepcopy(self.message)
        self.message = copy.deepcopy(original)
        for field, value in [('text', 'changed request'), ('id', 'wrong-id'), ('roomId', 'wrong-room'),
                             ('from', dict(OWNER, humanId='different-owner'))]:
            fresh = dict(original, phoneWake=True, **{field: value})
            with patch.object(self.chat, 'exact_message', return_value=fresh):
                self.assertEqual(self.authorize(), 'revoked', field)

    def test_exact_source_missing_or_unavailable_has_no_cached_fallback(self):
        with patch.object(self.chat, 'exact_message', side_effect=TimeoutError('synthetic outage')):
            self.assertEqual(self.authorize(), 'authorization_unavailable')
        self.chat.rooms['room'].clear()
        self.assertEqual(self.authorize(), 'authorization_unavailable')

    def test_fresh_phone_policy_and_delegate_scope_are_both_required(self):
        self.chat.rooms['room'][0]['phoneWake'] = False
        self.assertEqual(self.authorize(), 'silent')
        self.chat.rooms['room'][0]['phoneWake'] = 'true'
        self.assertEqual(self.authorize(), 'authorization_unavailable')

    def test_unconnected_web_search_cannot_silently_bypass_proxy_requirement(self):
        with self.assertRaises(ValueError):
            coding_chat.validate_settings(dict(self.settings, web_search=True))

    def test_metadata_deadline_is_restored_for_regular_chat(self):
        self.chat.timeout = 60
        original = self.chat.member_rooms
        def checked():
            self.assertEqual(self.chat.timeout, 0.75)
            return original()
        self.chat.member_rooms = checked
        self.assertIsNone(self.authorize())
        self.assertEqual(self.chat.timeout, 60)


class HarnessConfigurationTests(unittest.TestCase):
    def test_scoped_task_keeps_launcher_data_root_and_rejects_competing_config(self):
        import coding_chat
        with tempfile.TemporaryDirectory() as directory:
            env={'REVERIE_SESSION_ID':MEMORY_SESSION,'REVERIE_DATA_DIR':str(Path(directory)/'selected'),
                 'REVERIE_AGENT_HOME':str(Path(directory)/'home'),'HOME':directory,
                 'REVERIE_API_URL':'http://127.0.0.1:12345'}
            selected=configuration_path(env)
            cfg={'self_session_id':MEMORY_SESSION,'_config_path':str(selected),'coding':{'tasks':{'fixture':{'office_access':True}}}}
            with patch.dict(os.environ,env,clear=True):
                scoped=coding_chat.office_environment(cfg,'fixture')
                self.assertEqual(scoped['REVERIE_DATA_DIR'],env['REVERIE_DATA_DIR'])
                self.assertEqual(scoped['REVERIE_AGENT_HOME'],env['REVERIE_AGENT_HOME'])
                cfg['_config_path']=str(Path(directory)/'.reverie/hands'/MEMORY_SESSION/'agent.json')
                with self.assertRaises(ValueError): coding_chat.office_environment(cfg,'fixture')

    def test_config_alias_and_other_session_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            env={'REVERIE_DATA_DIR':directory,'REVERIE_SESSION_ID':MEMORY_SESSION}
            with self.assertRaises(ValueError): configuration_path(env, MEMORY_ROOM)
            alias=Path(directory)/'alias'; alias.symlink_to(directory, target_is_directory=True)
            with self.assertRaises(ValueError): configuration_path({**env,'REVERIE_DATA_DIR':str(alias)})

    def test_external_marker_does_not_grant_authority(self):
        message = {'text': '[external agent] /code example Fix it. @Jester',
                   'from': {'kind': 'agent', 'sessionId': 'external'}}
        self.assertEqual(control_request(message)['task_id'], 'example')
        settings = {'tasks': {'example': {'rooms': ['room'], 'delegate_sessions': []}}}
        self.assertFalse(permitted_sender(settings, 'room', 'example', message))
        settings['tasks']['example']['delegate_sessions'] = ['external']
        self.assertTrue(permitted_sender(settings, 'room', 'example', message))

    def test_private_prompt_budget_is_bounded(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'settings.json'
            path.write_text('{"prompt_cap_chars":120000}'); path.chmod(0o600)
            self.assertEqual(runtime_settings(path)['prompt_cap_chars'], 120000)
            path.write_text('{"prompt_cap_chars":120001}')
            with self.assertRaises(ValueError): runtime_settings(path)


if __name__ == '__main__':
    unittest.main()
