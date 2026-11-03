"""A save result names the ID receipt needs; receipt also takes the save's entry_id, still hash-checked."""
import json
import sqlite3
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_journal_cli as cli
from test_journal_cli import journal

GENERIC = 'invalid_arguments_or_source'
SAVE_TURN = '40000000-0000-0000-0000-000000000001'


class ReceiptIdTests(unittest.TestCase):
    setUp, op = cli.CliTests.setUp, cli.CliTests.op
    message, turn, run_cli, saved = cli.CliTests.message, cli.CliTests.turn, cli.CliTests.run_cli, cli.CliTests.saved

    def save_result(self):
        src = self.message(101, 'Rory: All hail the Lantern Keeper.', at=999)
        result = self.run_cli(self.turn(1, history=[src]), cli.SAVE.format(id=src['id']))
        self.assertEqual(result['status'], 'committed', result)
        return result

    def test_first_line_of_the_save_result_is_enough_for_receipt(self):
        shown = journal.encoded(self.save_result())  # what the model reads after the frame line
        first_field = json.loads(shown, object_pairs_hook=lambda pairs: pairs)[0]
        self.assertEqual(first_field, ('check_with', f'receipt {SAVE_TURN}'))
        receipt = self.run_cli(self.turn(3, 'Did my save land?'), first_field[1])
        self.assertEqual(receipt['status'], 'committed', receipt)
        self.assertEqual(receipt['turn_id'], SAVE_TURN)

    def test_save_result_carries_turn_and_entry(self):
        result = self.save_result()
        self.assertEqual((result['turn_id'], result['entry_id']), (SAVE_TURN, 1))
        self.assertLessEqual(len(journal.encoded(result)), journal.RESULT_CHARS)

    def test_receipt_by_entry_id_matches_receipt_by_turn_id(self):
        entry = self.saved(1)
        by_entry = self.run_cli(self.turn(3, 'Did my save land?'), f'receipt {entry}')
        by_turn = self.run_cli(self.turn(4, 'Did my save land?'), f'receipt {SAVE_TURN}')
        self.assertEqual(by_entry['status'], 'committed', by_entry)
        self.assertEqual(by_entry, by_turn)
        self.assertEqual(set(by_entry), {'status', 'turn_id', 'entry_id', 'committed_ms', 'payload_sha256', 'evidence'})

    def test_unknown_entry_id_is_not_found_not_a_refusal(self):
        self.saved(1)
        turn = self.turn(3, 'Did my save land?')
        result = self.run_cli(turn, 'receipt 9')
        self.assertEqual(result['status'], 'not_found', result)
        self.assertEqual(result['entry_id'], 9)
        self.assertIn('not proof', result['evidence'])
        self.assertEqual(turn.calls, 1)

    def test_stored_bytes_that_do_not_match_their_hash_are_a_conflict(self):
        entry = self.saved(1)
        db = sqlite3.connect(next(self.root.rglob('memory.sqlite')))
        db.execute("UPDATE hands_journal SET payload=replace(payload, 'Lantern', 'Muffin') WHERE id=?", (entry,))
        db.commit()
        db.close()
        for ref in (str(entry), SAVE_TURN):
            result = self.run_cli(self.turn(3, 'Did my save land?'), f'receipt {ref}')
            self.assertEqual(result['status'], 'conflict', (ref, result))
            self.assertNotIn('payload_sha256', result)

    def test_worker_answer_for_another_entry_is_refused(self):
        turn = self.turn(3, 'Did my save land?')
        turn.operation = lambda op, **p: {'status': 'committed', 'turn_id': SAVE_TURN, 'entry_id': 2,
                                          'committed_ms': 1, 'payload_sha256': '0' * 64, 'evidence': 'x'}
        result = self.run_cli(turn, 'receipt 1')
        self.assertEqual(result['status'], 'refused')
        self.assertTrue(result['reason'].startswith(GENERIC), result)

    def test_non_numbers_and_zero_still_get_the_named_refusal(self):
        for bad in ('0', '007', 'a1b2c3d4', '1234567890'):
            result = self.run_cli(self.turn(3, 'Did my save land?'), f'receipt {bad}')
            self.assertTrue(result['reason'].startswith('receipt_needs_message_id; '), (bad, result))
            self.assertEqual(self.ops, ['journal_status'])  # no worker read

    def test_help_says_entry_id_works(self):
        self.assertIn('check_with', journal.help_text('save', False))
        self.assertIn('entry_id number also works', journal.help_text('receipt', False))
        for topic in ('save', 'receipt'):
            self.assertLessEqual(len(journal.encoded({'status': 'ok', 'help': journal.help_text(topic, False)})),
                                 journal.RESULT_CHARS)


if __name__ == '__main__':
    unittest.main(verbosity=2)
