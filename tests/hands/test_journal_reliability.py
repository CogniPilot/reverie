"""Journal command time limits and failure reasons, through the real memory_op subprocess path."""
import json
import sys
import tempfile
import time
import unittest
from pathlib import Path

HANDS = Path(__file__).resolve().parents[2] / 'python/reverie/hands'
sys.path[:0] = [str(HANDS), str(HANDS.parents[1])]
import agent_journal as journal
import agent_loop as loop

ROOM = '20000000-0000-0000-0000-000000000002'
MID = '30000000-0000-0000-0000-000000000003'
WORKERS = {
    'slow': 'import sys, time, json\nsys.stdin.read()\ntime.sleep(1.0)\nprint(json.dumps({"status": "available", "entries": []}))\n',
    'fast': 'import sys, json\nsys.stdin.read()\nprint(json.dumps({"status": "available", "entries": []}))\n',
    'broken': 'import sys\nsys.stdin.read()\nsys.exit(1)\n',
}


class ReliabilityTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='reliability-'); self.addCleanup(temp.cleanup)
        self.dir = Path(temp.name)
        for name, body in WORKERS.items():
            (self.dir / f'{name}.py').write_text(body)
        self.cfg = dict(loop.DEFAULTS, memory_instance=str(self.dir / 'instance.json'), self_session_id='s', cli=None,
                        journal_enabled=True)

    def run_op(self, worker, op, **cfg):
        failures = []
        started = time.monotonic()
        result = loop.memory_op(dict(self.cfg, memory_worker_name=str(self.dir / f'{worker}.py'), **cfg),
                                ROOM, op, failures=failures, query='kite')
        return result, failures, time.monotonic() - started

    def test_journal_commands_get_their_own_longer_limit(self):
        result, failures, _ = self.run_op('slow', 'journal_recall', memory_timeout_s=0.3, journal_command_timeout_s=3)
        self.assertEqual(result['status'], 'available')
        self.assertEqual(failures, [])

    def test_timeout_is_reported_as_timeout_and_bounded(self):
        result, failures, elapsed = self.run_op('slow', 'journal_recall', journal_command_timeout_s=0.3)
        self.assertIsNone(result)
        self.assertEqual(failures, ['timeout'])
        self.assertLess(elapsed, 0.9)

    def test_status_uses_its_own_limit(self):
        result, failures, _ = self.run_op('slow', 'journal_status', journal_status_timeout_s=0.3, journal_command_timeout_s=3)
        self.assertIsNone(result)
        self.assertEqual(failures, ['timeout'])

    def test_other_memory_ops_keep_memory_timeout(self):
        result, failures, _ = self.run_op('slow', 'recall', memory_timeout_s=0.3, journal_command_timeout_s=3)
        self.assertIsNone(result)
        self.assertEqual(failures, ['timeout'])

    def test_broken_worker_is_reported_as_worker_error(self):
        result, failures, _ = self.run_op('broken', 'journal_recall')
        self.assertIsNone(result)
        self.assertEqual(failures, ['worker_error'])

    def test_unavailable_command_carries_only_its_own_failure(self):
        failures = []
        def operation(op, **payload):
            if op == 'journal_status':
                return {'status': 'available', 'checkpoint': None}
            failures.append('timeout')
            return None
        msg = dict(id=MID, roomId=ROOM, at=100, text='Read-only: what happened?', **{'from': {'name': 'Fixture'}})
        turn = journal.Turn({'journal_enabled': True, 'memory_instance': 'synthetic'}, ROOM, [], msg, operation,
                            failures=failures)
        call = {'function': {'name': 'journal', 'arguments': json.dumps({'command': 'recall kite'})}}
        self.assertEqual(turn.invoke(call), {'status': 'unavailable', 'failure': 'timeout'})
        failures.append('worker_error')  # an older failure must not leak into the next command's report
        ok = {'function': {'name': 'journal', 'arguments': json.dumps({'command': 'receipt ' + MID})}}
        def quiet(op, **payload):
            return {'status': 'available', 'checkpoint': None} if op == 'journal_status' else None
        turn.operation = quiet
        self.assertEqual(turn.invoke(ok), {'status': 'unavailable'})


if __name__ == '__main__':
    unittest.main(verbosity=2)
