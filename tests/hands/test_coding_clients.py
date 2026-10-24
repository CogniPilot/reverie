import io
import http.server
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from coding_model_client import ModelClient, NoRedirect
from model_events import TraceReader


class ModelClientTests(unittest.TestCase):
    def stream_client(self, directory, chunks, *, suffix=b'data: [DONE]\n\n', **options):
        path = Path(directory) / 'events.jsonl'
        client = ModelClient('http://127.0.0.1:9999/v1', events_file=str(path), **options)
        body = b''.join(b'data: ' + json.dumps(chunk).encode() + b'\n\n' for chunk in chunks) + suffix
        seen = []
        class Opener:
            def open(self, request, timeout):
                seen.append(request)
                return io.BytesIO(body)
        client.opener = Opener()
        return client, path, seen

    def test_stream_reconstructs_reasoning_answer_tools_and_final_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            chunks = [
                {'model': 'served-model', 'choices': [{'index': 0, 'delta': {'reasoning_content': 'Private plan. '}}]},
                {'choices': [{'delta': {'reasoning_content': 'Inspect first.', 'content': 'Observed ',
                    'tool_calls': [{'index': 0, 'id': 'call_', 'type': 'function',
                                    'function': {'name': 'run_', 'arguments': '{'}}]}}]},
                {'choices': [{'delta': {'content': 'answer.', 'tool_calls': [{'index': 0, 'id': '1',
                                    'function': {'name': 'tests', 'arguments': '}'}}]}, 'finish_reason': 'tool_calls'}]},
                {'choices': [], 'usage': {'prompt_tokens': 10, 'completion_tokens': 12},
                 'timings': {'predicted_n': 12}},
            ]
            client, path, seen = self.stream_client(directory, chunks)
            payload = {'model': 'requested-model', 'max_tokens': 16384, 'stream': False,
                       'messages': [{'role': 'user', 'content': 'task input'}]}
            result = client(payload, 2)
            self.assertEqual(result['content'], 'Observed answer.')
            self.assertEqual(result['reasoning_content'], 'Private plan. Inspect first.')
            self.assertEqual(result['tool_calls'], [{'id': 'call_1', 'type': 'function',
                                                     'function': {'name': 'run_tests', 'arguments': '{}'}}])
            self.assertEqual(result['_finish_reason'], 'tool_calls')
            self.assertEqual(result['_model'], 'served-model')
            self.assertEqual(result['_usage']['completion_tokens'], 12)
            self.assertEqual(result['_timings'], {'predicted_n': 12})
            sent = json.loads(seen[0].data)
            self.assertTrue(sent['stream'])
            self.assertEqual(sent['stream_options'], {'include_usage': True})
            self.assertEqual(sent['max_tokens'], 16384)
            self.assertNotIn('temperature', sent)
            self.assertFalse(payload['stream'])
            events = TraceReader(path, from_end=False).poll()
            self.assertEqual(''.join(e['text'] for e in events if e['kind'] == 'thinking'), result['reasoning_content'])
            self.assertEqual(''.join(e['text'] for e in events if e['kind'] == 'answer'), result['content'])
            self.assertNotIn('task input', path.read_text())
            self.assertNotIn('run_tests', path.read_text())

    def test_worker_emits_live_trace_before_completion_and_stdout_stays_one_json_result(self):
        release = threading.Event()
        thought = 'Provider reasoning is visible before the final response. ' * 3
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_POST(self):
                self.rfile.read(int(self.headers['Content-Length']))
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.end_headers()
                first = {'choices': [{'delta': {'reasoning_content': thought}}]}
                self.wfile.write(b'data: ' + json.dumps(first).encode() + b'\n\n'); self.wfile.flush()
                release.wait(3)
                final = {'model': 'served-model', 'choices': [{'delta': {'content': 'Final answer'}, 'finish_reason': 'stop'}]}
                self.wfile.write(b'data: ' + json.dumps(final).encode() + b'\n\ndata: [DONE]\n\n')
                self.wfile.flush()
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / 'events'
                config = {'epoch': 1, 'api_base': f'http://127.0.0.1:{server.server_port}/v1',
                          'key_env': 'TEST_API_KEY', 'timeout_s': 3, 'max_response_bytes': 262144,
                          'events_file': str(path), 'payload': {'model': 'model', 'messages': []}}
                worker = Path(__file__).resolve().parents[2] / 'python/reverie/hands/coding_model_client.py'
                process = subprocess.Popen([sys.executable, '-I', '-B', str(worker), '--worker'],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    env={'PATH': os.defpath, 'TEST_API_KEY': 'synthetic-key'})
                try:
                    process.stdin.write(json.dumps(config).encode()); process.stdin.close()
                    deadline = time.monotonic() + 2
                    while not path.exists() or 'Provider reasoning' not in path.read_text():
                        self.assertLess(time.monotonic(), deadline)
                        time.sleep(0.005)
                    self.assertIsNone(process.poll())
                    release.set()
                    process.wait(timeout=3)
                    stdout = process.stdout.read().decode()
                    self.assertEqual(len(stdout.splitlines()), 1)
                    result = json.loads(stdout)
                    self.assertTrue(result['ok'])
                    self.assertEqual(result['epoch'], 1)
                    self.assertEqual(result['result']['content'], 'Final answer')
                    self.assertEqual(result['result']['reasoning_content'], thought)
                    self.assertNotIn('synthetic-key', path.read_text())
                    self.assertEqual(process.stderr.read(), b'')
                finally:
                    release.set()
                    if process.poll() is None:
                        process.kill(); process.wait()
                    process.stdout.close(); process.stderr.close()
        finally:
            release.set(); server.shutdown(); server.server_close(); thread.join(timeout=2)

    def test_stream_trace_redacts_credentials_split_between_provider_deltas(self):
        with tempfile.TemporaryDirectory() as directory:
            chunks = [{'choices': [{'delta': {'reasoning': 'key=fixture-'}}]},
                      {'choices': [{'delta': {'reasoning': 'secret-key', 'content': 'ok'}, 'finish_reason': 'stop'}]}]
            client, path, seen = self.stream_client(directory, chunks, key_env='TEST_API_KEY')
            with patch.dict(os.environ, {'TEST_API_KEY': 'fixture-secret-key'}, clear=True):
                result = client({'model': 'model'}, 2)
            self.assertEqual(result['content'], 'ok')
            self.assertNotIn('fixture-secret-key', path.read_text())
            self.assertNotIn('Authorization', path.read_text())
            self.assertEqual(seen[0].headers['Authorization'], 'Bearer fixture-secret-key')

    def test_stream_refuses_incomplete_or_malformed_events(self):
        cases = [([{'choices': [{'delta': {'content': 'partial'}, 'finish_reason': 'stop'}]}], b''),
                 ([{'choices': [{'delta': {'content': 'partial'}}]}], b'data: [DONE]\n\n'),
                 ([{'choices': [{'delta': {'content': ['bad']}, 'finish_reason': 'stop'}]}], b'data: [DONE]\n\n'),
                 ([{'choices': [{'delta': {'tool_calls': [{'index': True}]}, 'finish_reason': 'stop'}]}], b'data: [DONE]\n\n')]
        for chunks, suffix in cases:
            with self.subTest(chunks=chunks), tempfile.TemporaryDirectory() as directory:
                client, _, _ = self.stream_client(directory, chunks, suffix=suffix)
                with self.assertRaises(ValueError):
                    client({}, 2)

    def test_stream_caps_both_decoded_payload_and_wire_heartbeats(self):
        with tempfile.TemporaryDirectory() as directory:
            client, _, _ = self.stream_client(directory, [
                {'choices': [{'delta': {'reasoning_content': 'x' * 200}}]},
                {'choices': [{'delta': {'content': 'x' * 200}, 'finish_reason': 'stop'}]}], max_response_bytes=300)
            with self.assertRaises(ValueError):
                client({}, 2)
            client, _, _ = self.stream_client(directory, [], suffix=b':' + b'x' * 500 + b'\n')
            client.max_stream_bytes = 100
            with self.assertRaises(ValueError):
                client({}, 2)

    def test_slow_stream_read_remains_under_the_original_wall_deadline(self):
        with tempfile.TemporaryDirectory() as directory:
            client = ModelClient('http://127.0.0.1:9999/v1', events_file=str(Path(directory) / 'events'))
            class Slow(io.BytesIO):
                def readline(self, *args):
                    time.sleep(10)
            class Opener:
                def open(self, *args, **kwargs):
                    return Slow()
            client.opener = Opener()
            started = time.monotonic()
            with self.assertRaises(TimeoutError):
                client({}, 0.02)
            self.assertLess(time.monotonic() - started, 1)
            self.assertEqual(signal.getitimer(signal.ITIMER_REAL), (0.0, 0.0))

    def test_local_and_hosted_use_identical_client_and_timeout(self):
        payload = {'model': 'configured-model', 'messages': [{'role': 'user', 'content': 'Task'}]}
        expected = {'choices': [{'message': {'content': 'Reply'}}], 'timings': {'predicted_n': 3}}
        for endpoint in ('http://127.0.0.1:9999/v1', 'https://provider.invalid/v1'):
            client = ModelClient(endpoint, timeout_s=300)
            seen = []
            class Opener:
                def open(self, request, timeout):
                    seen.append((request, timeout))
                    return io.BytesIO(json.dumps(expected).encode())
            client.opener = Opener()
            result = client(payload, 5)
            self.assertEqual(result['content'], 'Reply')
            self.assertEqual(result['_timings']['predicted_n'], 3)
            self.assertEqual(seen[0][1], 5)
            self.assertEqual(json.loads(seen[0][0].data), payload)
            self.assertEqual(seen[0][0].full_url, endpoint + '/chat/completions')
            self.assertNotIn('Authorization', seen[0][0].headers)

    def test_only_explicit_key_environment_variable_is_used(self):
        client = ModelClient('https://provider.invalid/v1', key_env='TEST_API_KEY')
        seen = []
        class Opener:
            def open(self, request, timeout):
                seen.append(request)
                return io.BytesIO(b'{"choices":[{"message":{"content":"ok"}}]}')
        client.opener = Opener()
        with patch.dict(os.environ, {'TEST_API_KEY': 'synthetic-key'}, clear=True):
            client({'model': 'model'}, 1)
        self.assertEqual(seen[0].headers['Authorization'], 'Bearer synthetic-key')
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(ValueError):
                client({'model': 'model'}, 1)

    def test_response_cap_and_bad_envelopes_fail_closed(self):
        client = ModelClient('http://127.0.0.1:9999/v1', max_response_bytes=20)
        class Opener:
            def open(self, *args, **kwargs):
                return io.BytesIO(b'x' * 21)
        client.opener = Opener()
        with self.assertRaises(ValueError):
            client({}, 1)

    def test_no_cross_endpoint_redirect_for_credentials(self):
        self.assertIsNone(NoRedirect().redirect_request(None, None, 302, '', {}, 'https://other.invalid'))
        with self.assertRaises(ValueError):
            ModelClient('https://username:secret@provider.invalid/v1')

    def test_slow_transport_is_interrupted_by_wall_timer(self):
        client = ModelClient('http://127.0.0.1:9999/v1')
        class Opener:
            def open(self, *args, **kwargs):
                time.sleep(10)
        client.opener = Opener()
        started = time.monotonic()
        previous = signal.getsignal(signal.SIGALRM)
        with self.assertRaises(TimeoutError):
            client({}, 0.02)
        self.assertLess(time.monotonic() - started, 1)
        self.assertEqual(signal.getsignal(signal.SIGALRM), previous)
        self.assertEqual(signal.getitimer(signal.ITIMER_REAL), (0.0, 0.0))


if __name__ == '__main__':
    unittest.main()
