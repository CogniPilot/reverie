import json
import os
import sys
import time
import unittest

from coding_arbiter import ModelArbiter
from coding_process import BoundedProcess


class FakeProcess:
    instances = []
    def __init__(self, argv, body, timeout, max_output, **kwargs):
        self.argv = argv
        self.body = json.loads(body)
        self.timeout = timeout
        self.output = json.dumps({'epoch': self.body['epoch'], 'ok': True,
                                  'result': {'content': 'Done.'}}).encode()
        self.error = None
        self.done = False
        self.__class__.instances.append(self)
    def poll(self):
        return self.done
    def cancel(self, reason):
        self.error = reason
        self.done = True


class ArbiterTests(unittest.TestCase):
    def setUp(self):
        FakeProcess.instances = []
        self.arbiter = ModelArbiter('http://127.0.0.1:9999/v1', process_factory=FakeProcess, clock=lambda: 0)
        self.addCleanup(self.arbiter.cancel)

    def test_chat_preempts_only_model_call_then_resumes_same_request(self):
        request = {'model': 'configured-model', 'messages': [{'role': 'user', 'content': 'task'}]}
        self.arbiter.submit(request, 60)
        original = FakeProcess.instances[0]
        self.arbiter.pause_for_chat()
        self.assertEqual(original.error, 'preempted_for_chat')
        self.assertIsNone(self.arbiter.poll())
        self.assertEqual(len(FakeProcess.instances), 1)
        self.arbiter.resume()
        self.assertEqual(len(FakeProcess.instances), 2)
        self.assertEqual(FakeProcess.instances[1].body['payload'], request)
        self.assertEqual(self.arbiter.preemptions, 1)
        self.assertEqual(self.arbiter.requests_started, 2)

    def test_optional_trace_path_reaches_only_private_worker_configuration(self):
        self.arbiter.events_file = '/private/events.jsonl'
        request = {'model': 'model', 'messages': []}
        self.arbiter.submit(request, 60)
        job = FakeProcess.instances[0]
        self.assertEqual(job.body['events_file'], '/private/events.jsonl')
        self.assertNotIn('events_file', job.body['payload'])
        self.assertNotIn('/private/events.jsonl', job.output.decode())

    def test_only_one_coding_request_can_occupy_the_slot(self):
        self.arbiter.submit({}, 60)
        with self.assertRaises(RuntimeError):
            self.arbiter.submit({}, 60)

    def test_completed_result_releases_slot(self):
        self.arbiter.submit({}, 60)
        FakeProcess.instances[0].done = True
        result = self.arbiter.poll()
        self.assertTrue(result['ok'])
        self.assertEqual(result['result'], {'content': 'Done.'})
        self.assertIsNone(self.arbiter.poll())
        self.arbiter.submit({}, 60)

    def test_parent_task_deadline_is_not_reset_by_preemption(self):
        timestamp = [0]
        arbiter = ModelArbiter('http://127.0.0.1:9999/v1', process_factory=FakeProcess,
                               clock=lambda: timestamp[0])
        arbiter.submit({}, 5)
        arbiter.pause_for_chat()
        timestamp[0] = 6
        arbiter.resume()
        self.assertEqual(len(FakeProcess.instances), 1)
        self.assertEqual(arbiter.poll(), {'ok': False, 'error': 'model_deadline'})

    def test_each_request_watchdog_is_recorded(self):
        self.arbiter.submit({}, 60)
        FakeProcess.instances[0].done = True
        FakeProcess.instances[0].error = 'timeout'
        self.assertEqual(self.arbiter.poll()['error'], 'timeout')
        self.assertEqual(self.arbiter.watchdog_events, [{'request': 1, 'reason': 'timeout'}])

    def test_cancelled_request_response_cannot_run_as_the_new_epoch(self):
        self.arbiter.submit({'messages': []}, 60)
        stale = bytes(FakeProcess.instances[0].output)
        old_epoch = self.arbiter.epoch
        self.arbiter.pause_for_chat()
        self.arbiter.resume()
        current = FakeProcess.instances[-1]
        self.assertGreater(self.arbiter.epoch, old_epoch)
        current.output = stale
        current.done = True
        result = self.arbiter.poll()
        self.assertFalse(result['ok'])
        self.assertEqual(result['error'], 'stale_model_epoch')


class BoundedProcessTests(unittest.TestCase):
    def job(self, script, *, body=b'', timeout=2, cap=4096):
        process = BoundedProcess([sys.executable, '-I', '-B', '-c', script], body,
                                  timeout, cap, environment={'PATH': os.defpath})
        self.addCleanup(process.cancel)
        return process

    def finish(self, process):
        end = time.monotonic() + 3
        while not process.poll():
            self.assertLess(time.monotonic(), end)
            time.sleep(0.005)

    def test_poll_returns_without_waiting_for_a_sleeping_child(self):
        process = self.job('import time;time.sleep(30)', timeout=0.1)
        started = time.monotonic()
        self.assertFalse(process.poll())
        self.assertLess(time.monotonic() - started, 0.1)
        self.finish(process)
        self.assertEqual(process.error, 'timeout')

    def test_request_and_result_are_bounded_without_blocking_chat(self):
        process = self.job('import sys;body=sys.stdin.buffer.read();sys.stdout.buffer.write(body)', body=b'fixture')
        self.finish(process)
        self.assertEqual(bytes(process.output), b'fixture')
        self.assertIsNone(process.error)

    def test_output_flood_is_killed(self):
        process = self.job('import sys;sys.stdout.write("x"*1000000)')
        self.finish(process)
        self.assertEqual(process.error, 'output_limit')
        self.assertLessEqual(len(process.output), 4096)

    def test_diagnostic_flood_is_killed_and_not_retained(self):
        process = self.job('import sys;sys.stderr.write("x"*1000000)')
        self.finish(process)
        self.assertEqual(process.error, 'diagnostics_limit')
        self.assertEqual(bytes(process.output), b'')

    def test_stdin_remains_data_and_environment_is_explicit(self):
        process = self.job('import os,json,sys;print(json.dumps({"body":json.load(sys.stdin),"env":dict(os.environ)}))',
                           body=b'{"path":"fixture; not a shell"}')
        self.finish(process)
        result = json.loads(process.output)
        self.assertEqual(result['body']['path'], 'fixture; not a shell')
        self.assertNotIn('HOME', result['env'])
        self.assertNotIn('CODEMAN_SESSION_ID', result['env'])


if __name__ == '__main__':
    unittest.main()
