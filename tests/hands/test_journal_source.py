"""Real worker/Turn/SQLite on owned synthetic fixtures; no live agent data."""
import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / 'python/reverie/hands'), str(ROOT / 'python')]

def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    loaded = importlib.util.module_from_spec(spec)
    sys.modules[name] = loaded
    spec.loader.exec_module(loaded)
    return loaded

journal = importlib.import_module('agent_journal')
worker = module('tested_memory_worker', ROOT / 'python/reverie/hands/agent_memory_worker.py')
ROOM = '20000000-0000-0000-0000-000000000002'
MID = '30000000-0000-0000-0000-000000000003'
OLD = '40000000-0000-0000-0000-000000000004'
SID = '10000000-0000-0000-0000-000000000001'

class SourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='journal-source-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        instance = self.root / 'instance.json'
        instance.write_text(json.dumps(dict(id=SID, agent_name='Fixture', owner_name='Fixture owner',
                                           data_dir='memory', persona='Synthetic fixture')))
        self.cfg = dict(journal_enabled=True, memory_instance=str(instance), self_session_id=SID,
                        memory_timeout_s=3, cli=None)
        self.msg = dict(id=MID, roomId=ROOM, at=100, text='Remember an older preference.',
                        **{'from': {'kind': 'user', 'name': 'Fixture owner'}})
        self.old = dict(id=OLD, roomId=ROOM, at=1, text='I prefer a freeform journal, not mandatory questions.',
                        **{'from': {'kind': 'user', 'name': 'Fixture owner'}})
        self.chat = Mock()
        self.rooms = [dict(id=ROOM, visibility='private', members=[SID])]
        self.chat.member_rooms.return_value = self.rooms
        self.chat.exact_message.side_effect = lambda room, mid: copy.deepcopy({MID:self.msg, OLD:self.old}[mid])
        self.operations = []

    def perform(self, op, **payload):
        self.operations.append(op)
        return worker.perform(dict(config=self.cfg, room=ROOM, op=op, **payload), self.chat)

    def turn(self):
        return journal.Turn(self.cfg, ROOM, [self.msg], self.msg, self.perform, now_ms=200)

    def lookup(self, turn, mid=OLD, **extra):
        return turn.invoke({'function': {'name':'journal_source',
            'arguments':json.dumps(dict(message_id=mid, **extra))}})

    def commit(self, turn):
        return turn.invoke({'function': {'name':'journal_commit', 'arguments':json.dumps(
            dict(text='The owner prefers a freeform journal; this records their stated preference.',
                 tags=['preference'], sources=[dict(id=OLD, quote='freeform journal')]))}})

    def test_older_exact_source_commit_reopen_recall(self):
        turn = self.turn()
        self.assertNotIn(OLD, [e['id'] for e in turn.captured['events']])
        source = self.lookup(turn)
        self.assertEqual(source['text'], self.old['text'])
        self.assertEqual(source['revision'], journal.revision(self.old, ROOM))
        self.assertEqual(self.commit(turn)['status'], 'committed')
        recalled = self.perform('journal_recall', query='freeform')
        self.assertEqual(len(recalled['entries']), 1)
        self.assertEqual(recalled['entries'][0]['sources'][0]['id'], OLD)
        self.assertEqual(turn.captured['end']['id'], MID)
        self.assertIn('gaps are not claimed covered', turn.captured['coverage'])

    def test_read_only_can_expand_but_cannot_commit(self):
        self.msg['text'] = 'Read-only: check an older source.'
        turn = self.turn()
        self.assertEqual(self.lookup(turn)['status'], 'available')
        self.assertEqual(self.commit(turn)['reason'], 'read_only_request')
        self.assertNotIn('journal_commit', self.operations)
        self.assertIsNone(self.perform('journal_status')['checkpoint'])

    def test_dm_unknown_and_revoked_room_refuse_before_fetch(self):
        for rooms in ([], [dict(id=ROOM, kind='dm', visibility='private', members=[SID])],
                      [dict(id=ROOM, visibility='unknown', members=[SID])]):
            self.chat.member_rooms.return_value = self.rooms
            turn = self.turn()
            self.chat.exact_message.reset_mock()
            self.chat.member_rooms.return_value = rooms
            with self.assertRaises(PermissionError):
                self.lookup(turn)
            self.chat.exact_message.assert_not_called()

    def test_revocation_during_source_fetch_returns_no_text(self):
        turn = self.turn()
        def exact(room, mid):
            if mid == OLD:
                self.chat.member_rooms.return_value = []
            return copy.deepcopy({MID:self.msg, OLD:self.old}[mid])
        self.chat.exact_message.side_effect = exact
        with self.assertRaises(PermissionError):
            self.lookup(turn)
        self.assertNotIn(OLD, [e['id'] for e in turn.captured['events']])

    def test_wrong_room_future_source_and_changed_request_refuse(self):
        for mutation in ('room', 'future', 'request'):
            self.old['roomId'], self.old['at'] = ROOM, 1
            self.msg['text'] = 'Remember an older preference.'
            turn = self.turn()
            if mutation == 'room': self.old['roomId'] = SID
            if mutation == 'future': self.old['at'] = 101
            if mutation == 'request': self.msg['text'] = 'Edited request'
            self.assertEqual(self.lookup(turn)['status'], 'refused')

    def test_edit_after_lookup_refuses_commit_and_no_checkpoint(self):
        turn = self.turn()
        self.assertEqual(self.lookup(turn)['status'], 'available')
        self.old['text'] = 'Edited after lookup'
        self.assertEqual(self.commit(turn)['status'], 'refused')
        self.assertIsNone(self.perform('journal_status')['checkpoint'])

    def test_truncated_utf8_excerpt_keeps_full_revision(self):
        self.old['text'] = '界' * 1000
        turn = self.turn()
        result = self.lookup(turn)
        self.assertTrue(result['truncated'])
        self.assertLessEqual(len(result['text'].encode()), journal.TEXT_BYTES)
        self.assertLessEqual(len(journal.encoded(result)), journal.RESULT_CHARS)
        self.assertEqual(result['revision'], journal.revision(self.old, ROOM))
        self.assertIsNone(self.perform('journal_status')['checkpoint'])

    def test_model_cannot_select_room_or_path_and_turn_budget_stays_bounded(self):
        turn = self.turn()
        for extra in ({'room':SID}, {'path':'/private/another-agent'}):
            self.assertEqual(self.lookup(turn, **extra)['status'], 'refused')
        self.assertEqual(self.lookup(turn, mid='../private')['status'], 'refused')
        self.assertEqual(self.lookup(turn)['reason'], 'turn_budget')
        self.assertNotIn('journal_source', self.operations)

    def test_actual_answer_source_write_recall_within_existing_budget(self):
        import agent_loop as loop
        cfg = dict(loop.DEFAULTS, **self.cfg, self_name='Fixture', timezone='UTC')
        calls = []
        def model(cfg, messages, tools):
            calls.append(1)
            self.assertLessEqual(loop.request_chars(messages) + len(json.dumps(tools or [])), cfg['prompt_cap_chars'])
            if len(calls) == 1:
                self.assertEqual(['journal'], [t['function']['name'] for t in tools])
                self.assertIn('source', tools[0]['function']['description'])
                name, args = 'journal', dict(command=f'source {OLD}')
            elif len(calls) == 2:
                self.assertIn('freeform journal', messages[-1]['content'])
                # The model sees the command it actually sent, not an empty call.
                self.assertEqual(json.loads(messages[-2]['tool_calls'][0]['function']['arguments']), {'command': f'source {OLD}'})
                name, args = 'journal', dict(command=f'save --text "The owner stated a preference for a freeform journal." '
                                                     f'--tag preference --source {OLD} "freeform journal"')
            elif len(calls) == 3:
                self.assertIn('committed', messages[-1]['content'])
                self.assertIn('--tag preference', messages[-2]['tool_calls'][0]['function']['arguments'])
                name, args = 'journal', dict(command='recall freeform')
            else:
                self.assertIsNone(tools)
                self.assertTrue(any('source revisions checked' in m.get('content','') for m in messages))
                return {'content':'Saved and recalled the stated preference; its source is checked, interpretation is not verified.'}
            return {'tool_calls':[{'id':f'call{len(calls)}', 'function':dict(name=name,arguments=json.dumps(args))}]}
        with patch.object(loop, 'memory_op', side_effect=lambda cfg, room, op, **p:self.perform(op, **p)):
            reply, _, _ = loop.answer(cfg, ROOM, [self.msg], self.msg, model, None)
        self.assertIn('Saved and recalled', reply)
        self.assertEqual(len(calls), journal.MAX_CALLS + 1)
        self.assertEqual(self.operations, ['journal_status','journal_source','journal_commit','journal_recall'])

if __name__ == '__main__':
    unittest.main(verbosity=2)
