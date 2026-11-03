"""A save the worker refused before writing is reported as refused; only real timeouts and crashes stay unknown."""
import copy
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_journal_recovery as base
from agent_loop import Chat, ChatNotFound
from test_journal_recovery import journal, worker, ROOM, MID

FAKE = '"Keep the paper kite memory," the owner said. Don\'t lose it.'


class WorkerRefusalTests(unittest.TestCase):
    perform = base.RecoveryTests.perform

    def setUp(self):
        base.RecoveryTests.setUp(self)
        self.msg['text'] = FAKE
        self.failures = []

    def production(self, op, **p):
        """What agent_loop.memory_op gives the journal: a worker that ends in an error is None plus its class."""
        self.calls.append(op)
        try:
            return worker.perform(dict(config=self.cfg, room=ROOM, op=op, **p), self.chat)
        except Exception:
            self.failures.append('worker_error')
            return None

    def save(self, quote, operation=None):
        turn = journal.Turn(self.cfg, ROOM, [self.msg], self.msg, operation or self.production, now_ms=200,
                            failures=self.failures)
        draft = dict(text='The owner asked to keep the kite memory.', tags=['lesson'], sources=[dict(id=MID, quote=quote)])
        return turn, turn.invoke({'function': dict(name='journal_commit', arguments=json.dumps(draft))})

    def assert_refused(self, result, code):
        self.assertEqual(result['status'], 'refused')
        self.assertTrue(result['reason'].startswith(code + ';'), result['reason'])
        self.assertIn('nothing was saved', result['reason'])
        self.assertEqual(result['turn_id'], MID)
        self.assertNotIn('journal_receipt', self.calls)  # nothing was written, so nothing to look up
        self.assertEqual(self.perform('journal_receipt', turn_id=MID)['status'], 'not_found')

    def test_exact_quote_still_commits(self):
        _, result = self.save('paper kite memory')
        self.assertEqual(result['status'], 'committed')

    def test_paraphrased_quote_is_refused_not_unknown(self):
        _, result = self.save('keep the kite memory')
        self.assert_refused(result, 'quote_not_in_source')

    def test_smart_quote_substitution_is_refused_not_unknown(self):
        _, result = self.save('Don’t lose it')
        self.assert_refused(result, 'quote_not_in_source')

    def test_source_edited_during_the_turn_is_refused_not_unknown(self):
        edited = copy.deepcopy(self.msg)
        edited['text'] = FAKE + ' (edited)'

        def operation(op, **p):
            if op == 'journal_commit':
                self.chat.exact_message.side_effect = lambda room, mid: copy.deepcopy(edited)
            return self.production(op, **p)
        _, result = self.save('paper kite memory', operation)
        self.assert_refused(result, 'source_changed')

    def test_source_gone_is_refused_not_unknown(self):
        def gone(room, mid):
            raise ChatNotFound('no such message in this room')

        def operation(op, **p):
            if op == 'journal_commit':
                self.chat.exact_message.side_effect = gone
            return self.production(op, **p)
        _, result = self.save('paper kite memory', operation)
        self.assert_refused(result, 'source_unavailable')

    def real_chat(self, stdout, code):
        """The production Chat over a stand-in CLI that prints `stdout` and exits with `code`."""
        script = f'import sys; sys.stdout.write({stdout!r}); sys.exit({code})'
        return Chat([sys.executable, '-I', '-c', script], 5)

    def save_reading_through(self, chat):
        def operation(op, **p):
            if op == 'journal_commit':
                self.chat.exact_message.side_effect = chat.exact_message
            return self.production(op, **p)
        return self.save('paper kite memory', operation)[1]

    def test_a_server_not_found_through_the_real_chat_is_refused(self):
        answer = json.dumps({'success': False, 'error': 'NOT_FOUND: No such message in this room (HTTP 404)'})
        self.assert_refused(self.save_reading_through(self.real_chat(answer, 1)), 'source_unavailable')

    def test_a_read_with_no_message_through_the_real_chat_is_refused(self):
        self.assert_refused(self.save_reading_through(self.real_chat(json.dumps({'message': None}), 0)),
                            'source_unavailable')

    def test_a_failed_or_unreadable_source_read_stays_unknown(self):
        busy = json.dumps({'success': False, 'error': 'UNAVAILABLE: try again (HTTP 503)'})
        for stdout, code in ((busy, 1), ('not json', 0), ('', 1)):
            self.calls, self.failures = [], []
            result = self.save_reading_through(self.real_chat(stdout, code))
            self.assertEqual(result['status'], 'unknown', stdout)
            self.assertEqual(result.get('failure'), 'worker_error', stdout)

    def test_a_corrected_save_after_a_refusal_commits_in_the_same_turn(self):
        turn, first = self.save('keep the kite memory')
        self.assertEqual(first['status'], 'refused')
        draft = dict(text='The owner asked to keep the kite memory.', tags=['lesson'],
                     sources=[dict(id=MID, quote='paper kite memory')])
        second = turn.invoke({'function': dict(name='journal_commit', arguments=json.dumps(draft))})
        self.assertEqual(second['status'], 'committed')
        self.assertEqual(second['turn_id'], MID)

    def test_timeout_stays_unknown_and_says_so(self):
        def operation(op, **p):
            if op == 'journal_commit':
                self.calls.append(op)
                self.failures.append('timeout')
                return None
            return self.production(op, **p)
        _, result = self.save('paper kite memory', operation)
        self.assertEqual(result['status'], 'unknown')
        self.assertIn('do not retry', result['reason'])
        self.assertEqual(result.get('failure'), 'timeout')
        self.assertEqual(self.calls.count('journal_commit'), 1)

    def test_worker_crash_stays_unknown_and_says_so(self):
        def operation(op, **p):
            if op == 'journal_commit':
                self.calls.append(op)
                self.failures.append('worker_error')
                return None
            return self.production(op, **p)
        _, result = self.save('paper kite memory', operation)
        self.assertEqual(result['status'], 'unknown')
        self.assertEqual(result.get('failure'), 'worker_error')


if __name__ == '__main__':
    unittest.main(verbosity=2)
