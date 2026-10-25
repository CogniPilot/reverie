import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import agent_loop as loop
import coding_chat
from test_coding_support import FakeChat, cfg_for


OWNER = {'kind': 'user', 'name': 'Owner', 'mark': 'owner_typed', 'authenticatedOwner': True}
DELEGATE = {'kind': 'agent', 'sessionId': 'session-operator', 'name': 'Operator'}


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


if __name__ == '__main__':
    unittest.main()
