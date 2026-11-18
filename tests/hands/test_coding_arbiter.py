import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest

from coding_process import BoundedProcess, ModelArbiter
from test_coding_support import ModelEndpoint, wait_model_reply


REQUEST = {'model': 'configured-model', 'messages': [{'role': 'user', 'content': 'task'}]}


class ArbiterTests(unittest.TestCase):
    def arbiter(self, *, hold_first=False, **settings):
        endpoint = ModelEndpoint(self, hold_first=hold_first)
        arbiter = ModelArbiter(endpoint.url, **settings)
        self.addCleanup(arbiter.cancel)
        return arbiter, endpoint

    def test_chat_preempts_live_model_call_then_resumes_same_request(self):
        arbiter, endpoint = self.arbiter(hold_first=True)
        arbiter.submit(REQUEST, 10)
        self.assertEqual(endpoint.receive(), ('/v1/chat/completions', REQUEST))
        started = time.monotonic()
        self.assertIsNone(arbiter.poll())
        self.assertLess(time.monotonic() - started, .75)
        arbiter.pause_for_chat()
        self.assertTrue(endpoint.disconnected.wait(2))
        self.assertIsNone(arbiter.poll())
        self.assertTrue(endpoint.requests.empty())
        arbiter.resume()
        self.assertEqual(endpoint.receive(), ('/v1/chat/completions', REQUEST))
        self.assertEqual(wait_model_reply(arbiter)['result']['content'], 'Done.')
        endpoint.release.set()
        arbiter.cancel()
        self.assertEqual(arbiter.preemptions, 1)
        self.assertEqual(arbiter.requests_started, 2)

    def test_optional_trace_path_stays_out_of_the_actual_provider_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            trace = Path(directory) / 'private-events.jsonl'
            arbiter, endpoint = self.arbiter(events_file=str(trace))
            arbiter.submit(REQUEST, 10)
            _, request = endpoint.receive()
            self.assertTrue(request['stream'])
            self.assertNotIn('events_file', request)
            self.assertNotIn(str(trace), json.dumps(request))
            self.assertTrue(wait_model_reply(arbiter)['ok'])
            self.assertIn('Done.', trace.read_text())

    def test_only_one_coding_request_can_occupy_the_slot(self):
        arbiter, _ = self.arbiter()
        arbiter.submit(REQUEST, 10)
        with self.assertRaises(RuntimeError):
            arbiter.submit(REQUEST, 10)

    def test_completed_result_releases_slot(self):
        arbiter, endpoint = self.arbiter()
        for epoch in (1, 2):
            arbiter.submit(REQUEST, 10)
            self.assertEqual(endpoint.receive(), ('/v1/chat/completions', REQUEST))
            result = wait_model_reply(arbiter)
            self.assertTrue(result['ok'])
            self.assertEqual(result['epoch'], epoch)
            self.assertEqual(result['result']['content'], 'Done.')
            self.assertIsNone(arbiter.poll())

    def test_resume_does_not_restart_an_expired_request(self):
        arbiter, endpoint = self.arbiter()
        arbiter.pause_for_chat()
        arbiter.submit(REQUEST, .1)
        time.sleep(.15)
        arbiter.resume()
        self.assertEqual(wait_model_reply(arbiter), {'ok': False, 'error': 'model_deadline'})
        arbiter.cancel()
        self.assertTrue(endpoint.requests.empty())
        self.assertEqual(arbiter.requests_started, 0)

    def test_each_request_watchdog_is_recorded(self):
        arbiter, _ = self.arbiter(hold_first=True, timeout_s=.2)
        arbiter.submit(REQUEST, 10)
        result = wait_model_reply(arbiter)
        self.assertIn(result['error'], ('timeout', 'model_timeout'))
        arbiter.cancel()
        self.assertEqual(arbiter.watchdog_events, [{'request': 1, 'reason': result['error']}])
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
