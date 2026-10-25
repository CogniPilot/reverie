import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock
import memory_access
from agent_memory import RoomMemory

SESSION = '10000000-0000-0000-0000-000000000001'
ROOM = '20000000-0000-0000-0000-000000000002'
SOURCE = '30000000-0000-0000-0000-000000000003'
REPLY = '40000000-0000-0000-0000-000000000004'


class MemoryAccessTests(unittest.TestCase):
    def fixture(self, root):
        instance = Path(root) / 'instance.json'
        instance.write_text(json.dumps({'id': SESSION, 'agent_name': 'Test', 'owner_name': 'Owner', 'data_dir': 'memory', 'persona': 'Synthetic test agent'}))
        cfg = {'memory_instance': str(instance), 'self_session_id': SESSION, 'cli': ['unused']}
        room = {'id': ROOM, 'name': 'project', 'visibility': 'private', 'members': [SESSION]}
        chat = Mock(); chat.member_rooms.return_value = [room]
        store = RoomMemory(instance, lambda room: 'shared')
        store.record_confirmed(ROOM, SOURCE, 10, 'compiler baseline verified', 'compiler baseline passed', REPLY)
        return cfg, room, chat

    def test_recall_uses_actual_channel_store_and_returns_source_provenance(self):
        with tempfile.TemporaryDirectory() as directory:
            cfg, _, chat = self.fixture(directory)
            result = memory_access.recall(cfg, 'project', 'compiler baseline', chat=chat)
            self.assertEqual(result['sourceMessageIds'], [SOURCE])
            self.assertIn('compiler baseline verified', result['text'])
            self.assertIn('Historical', result['notice'])
            self.assertGreater(chat.member_rooms.call_count, 1)

    def test_dm_missing_membership_ambiguous_names_and_revocation_do_not_return_memory(self):
        with tempfile.TemporaryDirectory() as directory:
            cfg, room, chat = self.fixture(directory)
            for rooms in ([], [{**room, 'kind': 'dm'}], [{**room, 'visibility': 'unknown'}], [room, {**room, 'id': SESSION}]):
                chat.member_rooms.return_value = rooms
                with self.assertRaises(ValueError):
                    memory_access.recall(cfg, 'project', 'compiler', chat=chat)
            chat.member_rooms.side_effect = [[room], []]
            with self.assertRaises(PermissionError):
                memory_access.recall(cfg, ROOM, 'compiler', chat=chat)

    def test_configuration_requires_own_private_session_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / '.reverie' / 'hands' / SESSION / 'agent.json'
            path.parent.mkdir(parents=True)
            path.write_text(json.dumps({'self_session_id': SESSION, 'memory_instance': '/explicit/instance.json'}))
            path.chmod(0o600)
            env = {'REVERIE_MUX': '1', 'REVERIE_SESSION_ID': SESSION, 'REVERIE_AGENT_HOME': directory, 'HOME': '/task/workspace'}
            self.assertEqual(memory_access.configuration(env)['self_session_id'], SESSION)
            for mode in (0o644, 0o666):
                path.chmod(mode)
                with self.assertRaises(ValueError): memory_access.configuration(env)
            path.chmod(0o600)
            path.write_text(json.dumps({'self_session_id': ROOM, 'memory_instance': '/explicit/instance.json'}))
            with self.assertRaises(ValueError): memory_access.configuration(env)
            with self.assertRaises(ValueError): memory_access.configuration({**env, 'REVERIE_MUX': '0'})

    def test_recall_is_bounded_and_has_no_write_operation(self):
        with tempfile.TemporaryDirectory() as directory:
            cfg, _, chat = self.fixture(directory)
            for query, cap in (('', 3000), ('x' * 4001, 3000), ('compiler', 13000)):
                with self.assertRaises(ValueError): memory_access.recall(cfg, ROOM, query, cap, chat)
            self.assertLessEqual(len(memory_access.recall(cfg, ROOM, 'compiler', 100, chat)['text']), 100)
