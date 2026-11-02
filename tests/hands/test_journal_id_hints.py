"""source/receipt with an entry number or a malformed ID get a named refusal; valid IDs behave as before."""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_journal_cli as cli
from test_journal_cli import journal

GENERIC = 'invalid_arguments_or_source'


class IdHintTests(unittest.TestCase):
    setUp, op = cli.CliTests.setUp, cli.CliTests.op
    message, turn, run_cli, saved = cli.CliTests.message, cli.CliTests.turn, cli.CliTests.run_cli, cli.CliTests.saved

    def test_source_with_entry_number_names_it(self):
        turn = self.turn(2, 'What was my title?')
        result = self.run_cli(turn, 'source 1')
        self.assertEqual(result['status'], 'refused')
        self.assertTrue(result['reason'].startswith('source_needs_message_id; 1 looks like an entry_id.'), result)
        self.assertIn('source_ids', result['reason'])
        self.assertNotIn(GENERIC, result['reason'])
        self.assertEqual(turn.calls, 1)
        self.assertEqual(self.ops, ['journal_status'])  # no worker read for the bad ID

    def test_receipt_with_entry_number_names_it(self):
        result = self.run_cli(self.turn(2, 'Did my save land?'), 'receipt 0')
        self.assertTrue(result['reason'].startswith('receipt_needs_message_id; 0 looks like an entry_id.'), result)
        self.assertIn('turn_id', result['reason'])  # 1-999999999 are entry_id lookups now (test_receipt_ids)

    def test_short_or_malformed_id_is_not_echoed(self):
        for bad in ('a1b2c3d4', 'a1b2c3d4-9444', '<script>', '12345678901234567890', '\u00b2'):
            reason = self.run_cli(self.turn(2, 'Check it.'), f'source {bad}')['reason']
            self.assertTrue(reason.startswith('source_needs_message_id; Use '), reason)
            self.assertNotIn(bad, reason)

    def test_non_string_id_through_the_direct_tool(self):
        turn = self.turn(2, 'Check it.')
        result = turn.invoke({'function': {'name': 'journal_source', 'arguments': json.dumps({'message_id': 7})}})
        self.assertTrue(result['reason'].startswith('source_needs_message_id; Use '), result)

    def test_valid_source_and_receipt_unchanged(self):
        self.saved(1)
        src = next(m for m in self.messages.values() if 'Lantern Keeper.' in m['text'])
        got = self.run_cli(self.turn(3, 'What was my title?'), f'source {src["id"]}')
        self.assertEqual(got['status'], 'available', got)
        receipt = self.run_cli(self.turn(4, 'Did my save land?'), 'receipt 40000000-0000-0000-0000-000000000001')
        self.assertEqual(receipt['status'], 'committed', receipt)

    def test_help_names_the_id_kind(self):
        self.assertIn('An entry_id number is not a message ID', journal.help_text('source', False))
        self.assertIn("The save's entry_id number also works", journal.help_text('receipt', False))
        for topic in ('source', 'receipt'):
            self.assertLessEqual(len(journal.encoded({'status': 'ok', 'help': journal.help_text(topic, False)})),
                                 journal.RESULT_CHARS)


if __name__ == '__main__':
    unittest.main(verbosity=2)
