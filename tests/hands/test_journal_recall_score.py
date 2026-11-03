"""Recall ranks a pool of text matches by relevance, recency and the entry's own importance, then returns the top two."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_journal_structured as base
from test_journal_structured import journal

DAY = 86400000


class RecallScoreTests(unittest.TestCase):
    setUp, op, add = base.StructuredTests.setUp, base.StructuredTests.op, base.StructuredTests.add

    def recalled(self, query):
        return [e['entry_id'] for e in self.op('journal_recall', query=query)['entries']]

    def test_a_later_keystone_decision_beats_an_older_note_with_more_matching_words(self):
        held, _ = self.add('Clock fix b7build4 review held: part two of the clock fix review still pending.')
        go, _ = self.add('GO on b7build4.', importance='keystone')
        self.assertEqual(self.recalled('clock fix b7build4 review held pending'), [go, held])

    def test_an_important_entry_outside_the_old_top_two_is_found(self):
        notes = [self.add(f'kite kite kite note {n}')[0] for n in range(3)]
        decision, _ = self.add('kite decision', importance='important')
        found = self.recalled('kite')
        self.assertEqual(len(found), 2)
        self.assertEqual(found[0], decision)
        self.assertIn(found[1], notes)

    def test_relevance_still_decides_between_equally_rated_entries(self):
        weak, _ = self.add('kite')
        strong, _ = self.add('azure kite azure ribbon azure tail')
        self.assertEqual(self.recalled('azure ribbon tail')[0], strong)
        self.assertNotIn(weak, self.recalled('azure ribbon tail'))

    def test_corrections_still_replace_the_old_answer(self):
        old, _ = self.add('The old codeword was azure.', importance='keystone')
        new, _ = self.add('Correction: the codeword was cerulean.', supersedes=[old])
        self.assertEqual(self.recalled('azure'), [new])

    def test_scores_combine_scaled_relevance_recency_and_importance(self):
        now = 100 * DAY
        scores = journal.memory_scores([5.0, 1.0], [now - DAY, now - 29 * DAY], [None, None], now)
        self.assertGreater(scores[0], scores[1])  # more relevant and newer
        recent, old = journal.memory_scores([1.0, 1.0], [now, now - 14 * DAY], [None, None], now)
        self.assertAlmostEqual(recent - old, 0.75)  # equal relevance: two half-lives apart
        tied = journal.memory_scores([2.0, 2.0], [now, now], ['keystone', None], now)
        self.assertAlmostEqual(tied[0] - tied[1], 1.0)
        self.assertEqual(journal.memory_scores([], [], [], now), [])
        close = journal.memory_scores([1.0, 1.0], [now, now - 60000], [None, None], now)
        self.assertLess(abs(close[0] - close[1]), 0.001)  # saved a minute apart: no artificial recency gap


if __name__ == '__main__':
    unittest.main(verbosity=2)
