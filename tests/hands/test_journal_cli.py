"""One journal command line over the real worker and an owned SQLite store."""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_journal_structured as base
from test_journal_structured import ROOM, journal

SAVE = 'save --text "Rory named me Lantern Keeper." --tag relationship --source {id} "Lantern Keeper"'


class CliTests(unittest.TestCase):
    # Borrow the owned SQLite/worker fixture without inheriting the structured test cases.
    setUp, op = base.StructuredTests.setUp, base.StructuredTests.op

    def message(self, n, text, at=None):
        m = dict(id=f'40000000-0000-0000-0000-{n:012d}', roomId=ROOM, at=at or n * 1000, text=text,
                 **{'from': {'kind': 'user', 'name': 'Fixture owner'}})
        self.messages[m['id']] = m
        return m

    def turn(self, n, text='Please remember this.', history=()):
        self.ops = []
        def operation(op, **p):
            self.ops.append(op)
            return self.op(op, **p)
        return journal.Turn(self.cfg, ROOM, list(history), self.message(n, text), operation)

    def run_cli(self, turn, command):
        return turn.invoke({'function': {'name': 'journal', 'arguments': json.dumps({'command': command})}})

    def saved(self, n=1, extra=''):
        src = self.message(100 + n, 'Rory: All hail the Lantern Keeper.', at=n * 1000 - 1)
        result = self.run_cli(self.turn(n, history=[src]), SAVE.format(id=src['id']) + extra)
        self.assertEqual(result['status'], 'committed', result)
        return result['entry_id']

    def test_one_tool_with_named_commands(self):
        turn = self.turn(1)
        self.assertEqual([t['function']['name'] for t in turn.tools], ['journal'])
        self.assertIn('Commands: save, recall, source, receipt, map, help.', turn.tools[0]['function']['description'])
        self.assertIn('journal_commit', turn.offered)
        quiet = self.turn(2, 'Read-only lookup: what did I save?')
        description = quiet.tools[0]['function']['description']
        self.assertIn('Commands: recall, source, receipt, map, help.', description)
        self.assertIn('save is unavailable this turn', description)
        self.assertNotIn('journal_commit', quiet.offered)

    def test_help_is_free_once_and_documents_every_command(self):
        turn = self.turn(1)
        overview = self.run_cli(turn, 'help')
        self.assertEqual(overview['status'], 'ok')
        for command in ('save', 'recall', 'source', 'receipt', 'map', 'help'):
            self.assertIn(command, overview['help'])
        self.assertEqual(turn.calls, 0)
        detail = self.run_cli(turn, 'help save')['help']
        for text in ('Identity', 'keystone', 'reconstructed', 'own first-person record', 'Example', '--supersedes'):
            self.assertIn(text, detail)
        self.assertEqual(turn.calls, 1)
        self.assertIn('A missing receipt is not proof the write never happened', self.run_cli(turn, 'help receipt')['help'])
        for topic in ('', 'save', 'recall', 'source', 'receipt', 'map'):
            self.assertLessEqual(len(journal.encoded({'status': 'ok', 'help': journal.help_text(topic, False)})), journal.RESULT_CHARS)
        self.assertIn('read-only', self.run_cli(self.turn(2, 'Read-only lookup'), 'help save')['help'])

    def test_save_then_recall_returns_guaranteed_fields(self):
        entry = self.saved(1, ' --topic Identity --topic "Games and play" --importance keystone --provenance reconstructed')
        found = self.run_cli(self.turn(2, 'What was my title?'), 'recall Lantern Keeper')['entries']
        self.assertEqual([e['entry_id'] for e in found], [entry])
        self.assertEqual(found[0]['provenance'], 'reconstructed')
        self.assertEqual(found[0]['supersedes'], [])
        self.assertEqual(found[0]['related'], [])
        self.assertEqual(len(found[0]['source_ids']), 1)

    def test_correction_supersedes_is_guaranteed_in_recall_and_capsule(self):
        old = self.saved(1)
        src = self.message(150, 'Robin: it was the lantern King memory, but the scene says Lantern Keeper.', at=4999)
        fix = self.run_cli(self.turn(5, history=[src]),
            f'save --text "Correction: Lantern Keeper is the title; lantern King is Robin\'s nickname." '
            f'--tag correction --source {src["id"]} "Lantern Keeper" --supersedes {old} --provenance relayed')
        self.assertEqual(fix['status'], 'committed', fix)
        found = self.run_cli(self.turn(6, 'Lantern?'), 'recall Lantern Keeper')['entries']
        self.assertEqual([(e['entry_id'], e['supersedes']) for e in found], [(fix['entry_id'], [old])])
        capsule = self.op('journal_status', query='Lantern Keeper')['recall']
        self.assertEqual(capsule['entries'][0]['supersedes'], [old])
        self.assertIn('"supersedes":[%d]' % old, journal.capsule_context(capsule, ROOM).replace(' ', ''))

    def test_related_links_keep_both_current_and_reach_recall_capsule_and_map(self):
        question = self.saved(1, ' --tag open-question')
        src = self.message(150, 'Rory: the third crumb is the tin tithe.', at=4999)
        answer = self.run_cli(self.turn(5, history=[src]),
            f'save --text "Answer: the third crumb was the tin tithe, ruled ceremonial." --tag lesson '
            f'--source {src["id"]} "tin tithe" --related {question}')
        self.assertEqual(answer['status'], 'committed', answer)
        found = {e['entry_id']: e for e in self.run_cli(self.turn(6, 'crumb?'), 'recall tin tithe')['entries']}
        self.assertEqual(found[answer['entry_id']]['related'], [question])
        view = {e['id']: e for e in self.op('journal_view')['entries']}
        self.assertEqual((view[question]['currentness'], view[answer['entry_id']]['currentness']), ('current', 'current'))
        self.assertEqual(view[answer['entry_id']]['related'], [question])
        capsule = self.op('journal_status', query='tin tithe')['recall']
        self.assertTrue(journal.capsule_context(capsule, ROOM))
        self.assertEqual(capsule['entries'][0]['related'], [question])
        mapped = self.run_cli(self.turn(7, 'map'), 'map')
        self.assertIn({'id': answer['entry_id'], 'related': [question]},
                      [{k: e[k] for k in ('id', 'related')} for e in mapped['entries']])

    def test_tags_and_topics_have_separate_documented_jobs(self):
        detail = journal.help_text('save', False)
        self.assertIn('What kind of note this is', detail)
        self.assertIn('What it is about', detail)
        self.assertTrue(set(t.lower() for t in journal.TOPICS).isdisjoint({'preferences', 'promises', 'lessons'}))

    def test_empty_or_incomplete_save_refused_before_worker(self):
        # Asked in review: "does the new build refuse a save missing required fields before anything runs?"
        src = self.message(101, 'Rory: All hail the Lantern Keeper.', at=999)
        turn = self.turn(1, history=[src])
        for command in ('save', 'save --tag lesson', 'save --text "no source" --tag lesson',
                        f'save --text "no tag" --source {src["id"]} "Lantern Keeper"'):
            self.assertEqual(self.run_cli(turn, command)['status'], 'refused', command)
            turn.calls = 0
        for raw in ('{}', None):
            call = {'function': {'name': 'journal_commit', **({} if raw is None else {'arguments': raw})}}
            self.assertEqual(turn.invoke(call)['status'], 'refused')
        self.assertNotIn('journal_commit', self.ops)

    def test_recall_without_search_words_never_returns_entries(self):
        self.saved(1)
        turn = self.turn(2, 'What do you remember?')
        bare = self.run_cli(turn, 'recall')
        self.assertEqual(bare['status'], 'refused')
        self.assertIn('recall needs search words', bare['reason'])
        self.assertNotIn('journal_recall', self.ops)
        for raw in ('{}', None, '{"query":""}', '{"query":"   "}'):
            turn.calls = 0
            call = {'function': {'name': 'journal_recall', **({} if raw is None else {'arguments': raw})}}
            result = turn.invoke(call)
            self.assertEqual(result['status'], 'refused', raw)
            self.assertNotIn('entries', result)

    def test_replayed_call_shows_the_bounded_command(self):
        call = {'function': {'name': 'journal', 'arguments': json.dumps({'command': 'save --text "crown" --tag lesson'})}}
        self.assertEqual(json.loads(journal.replay_arguments(call)), {'command': 'save --text "crown" --tag lesson'})
        long = {'function': {'name': 'journal', 'arguments': json.dumps({'command': 'recall ' + '雪' * 600})}}
        replay = journal.replay_arguments(long)
        self.assertLessEqual(len(replay.encode()), journal.REPLAY_BYTES + 64)
        self.assertTrue(json.loads(replay)['command'].endswith('[truncated]'))
        for bad in ({'function': {'name': 'journal', 'arguments': '<markup>'}},
                    {'function': {'name': 'journal_commit', 'arguments': '{"text":"x"}'}}, {}):
            self.assertEqual(journal.replay_arguments(bad), '{}')

    def test_unprompted_save_needs_a_stored_reason(self):
        self.saved(1)  # first entry: the bootstrap turn needs no reason
        src = self.message(102, 'Rory: lunch is at noon.', at=1999)
        quiet = self.turn(2, 'Rory says lunch is at noon.', history=[src])
        self.assertIn('journal_commit', quiet.offered)
        self.assertIn('save needs --reason this turn', quiet.tools[0]['function']['description'])
        plain = f'save --text "Lunch at noon." --tag lesson --source {src["id"]} "lunch"'
        self.assertEqual(self.run_cli(quiet, plain), {'status': 'refused', 'reason': 'save_needs_reason_this_turn; add --reason WHY'})
        self.assertNotIn('journal_commit', self.ops)
        saved = self.run_cli(quiet, plain + ' --reason "postmortem: entry 9 receipt confirmed"')
        self.assertEqual(saved['status'], 'committed', saved)
        found = self.run_cli(self.turn(3, 'lunch?'), 'recall lunch noon')['entries']
        self.assertEqual(found[0]['annotations']['reason'], 'postmortem: entry 9 receipt confirmed')
        self.assertIn('--reason', journal.help_text('save', False))
        for text in ('Please remember this: lunch is at noon.', 'Note that the kite was green.',
                     "Don't forget the tin tithe.", 'Add this to your journal.'):
            self.assertFalse(self.turn(4, text).needs_reason, text)
        for text in ('Do you remember the crown?', 'Can you save the file?'):
            self.assertTrue(self.turn(5, text).needs_reason, text)
        self.assertNotIn('journal_commit', self.turn(6, 'Read-only: remember this?').offered)
        too_long = self.run_cli(self.turn(7, 'ok', history=[src]), plain + ' --reason "' + 'x' * 201 + '"')
        self.assertEqual(too_long['status'], 'refused')

    def test_read_only_save_refused_before_worker(self):
        src = self.message(101, 'Rory: All hail the Lantern Keeper.', at=999)
        turn = self.turn(1, 'Read-only: do not write a journal entry', history=[src])
        result = self.run_cli(turn, SAVE.format(id=src['id']))
        self.assertEqual(result, {'status': 'refused', 'reason': 'read_only_request'})
        self.assertNotIn('journal_commit', self.ops)

    def test_malformed_commands_spend_budget_and_point_to_help(self):
        turn = self.turn(1)
        for command in ('save --text "unbalanced', 'dance', 'save --text x --bogus y'):
            result = self.run_cli(turn, command)
            self.assertEqual(result['status'], 'refused', command)
            self.assertIn('run: help', result['reason'])
        self.assertEqual(turn.calls, journal.MAX_CALLS)
        self.assertFalse(turn.handles({'function': {'name': 'journal', 'arguments': '{"command":"help"}'}}))
        self.assertEqual(self.run_cli(turn, 'recall x'), {'status': 'refused', 'reason': 'turn_budget'})

    def test_bad_supersedes_and_topics_are_refused_without_writing(self):
        src = self.message(101, 'Rory: All hail the Lantern Keeper.', at=999)
        turn = self.turn(1, history=[src])
        for extra in (' --supersedes one', ' --topic Kites', ' --importance 5', ' --topic Preferences', ' --related 99'):
            self.assertEqual(self.run_cli(turn, SAVE.format(id=src['id']) + extra)['status'], 'refused', extra)
        self.assertNotIn('journal_commit', self.ops)


if __name__ == '__main__':
    unittest.main(verbosity=2)
