import json
import time
import unittest

from coding_tasks import Limits
from coding_worker import CodingWorker
from test_coding_tasks import MESSAGES, TOOLS, call, response


class WorkerTests(unittest.TestCase):
    def worker(self, seconds=2):
        worker = CodingWorker(MESSAGES, TOOLS, Limits(seconds=seconds), {'model': 'configured-model'})
        self.addCleanup(worker.close)
        return worker

    def drive(self, worker, model_replies):
        replies = iter(model_replies)
        effects = []
        events = []
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            event = worker.poll()
            if event is None:
                time.sleep(0.002)
                continue
            events.append(event)
            kind = event['kind']
            if kind in ('failed', 'result'):
                return event, effects, events
            if kind == 'model':
                result = next(replies)
            elif kind == 'tool':
                effects.append(event['payload']['request'])
                result = response()
            else:
                result = None
            worker.reply(event['sequence'], result)
        self.fail('worker did not finish')

    def test_worker_asks_parent_for_authority_model_and_tools(self):
        worker = self.worker()
        result, effects, events = self.drive(worker, [call(), {'content': 'Complete.'}])
        self.assertEqual(result['kind'], 'result')
        self.assertEqual(result['result']['status'], 'completed')
        self.assertEqual(result['result']['steps'], 1)
        self.assertEqual(len(effects), 1)
        self.assertEqual(events[0]['kind'], 'authorize')
        self.assertIn('progress', [event['kind'] for event in events])

    def test_parent_remains_free_while_worker_waits_for_model(self):
        worker = self.worker()
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline:
            event = worker.poll()
            if event is None:
                time.sleep(0.002)
                continue
            if event['kind'] == 'authorize':
                worker.reply(event['sequence'], None)
            elif event['kind'] == 'model':
                break
        else:
            self.fail('no model request')
        started = time.monotonic()
        self.assertIsNone(worker.poll())
        self.assertLess(time.monotonic() - started, 0.1)
        worker.reply(event['sequence'], {'content': 'Reply after chat.'})
        while time.monotonic() < deadline:
            result = worker.poll()
            if result is not None:
                self.assertEqual(result['kind'], 'result')
                self.assertEqual(result['result']['text'], 'Reply after chat.')
                return
            time.sleep(0.002)
        self.fail('model response was not delivered')

    def test_close_kills_and_reaps_worker(self):
        worker = self.worker()
        worker.close()
        self.assertFalse(worker.process.is_alive())
        worker.close()

    def test_stale_task_epoch_cannot_grant_permission(self):
        worker = self.worker()
        deadline = time.monotonic() + 1
        event = None
        while time.monotonic() < deadline:
            event = worker.poll()
            if event:
                break
            time.sleep(0.002)
        self.assertIsNotNone(event)
        self.assertEqual(event['kind'], 'authorize')
        worker.connection.send_bytes(json.dumps({'epoch': worker.epoch + 1,
            'sequence': event['sequence'], 'ok': True, 'result': None}).encode())
        while time.monotonic() < deadline:
            event = worker.poll()
            if event:
                self.assertEqual(event['kind'], 'result')
                self.assertEqual(event['result']['reason'], 'authorization_unavailable')
                break
            time.sleep(0.002)
        else:
            self.fail('stale permission reply did not stop the task')


if __name__ == '__main__':
    unittest.main()
