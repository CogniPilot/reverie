import http.server
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import time
import unittest

from agent_journal import native_memory_command
from model_events import TraceReader


class ModelClientTests(unittest.TestCase):
    def test_worker_emits_live_trace_before_completion_and_stdout_stays_one_json_result(self):
        release = threading.Event()
        provider_can_close = threading.Event()
        thought = 'Provider reasoning is visible before the final response. ' * 3
        key = 'synthetic-trace-key'
        seen = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                seen.append((self.path, self.headers.get('Authorization'), payload))
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.end_headers()
                first = {'choices': [{'delta': {'reasoning_content': thought + key[:8]}}]}
                self.wfile.write(b'data: ' + json.dumps(first).encode() + b'\n\n')
                self.wfile.flush()
                release.wait(5)
                final = {'model': 'served-model', 'choices': [{'delta': {
                    'reasoning_content': key[8:], 'content': 'Final answer'}, 'finish_reason': 'stop'}]}
                self.wfile.write(b'data: ' + json.dumps(final).encode() + b'\n\ndata: [DONE]\n\n')
                self.wfile.flush()
                provider_can_close.wait(5)

        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / 'events'
                config = {'epoch': 1, 'api_base': f'http://127.0.0.1:{server.server_port}/v1',
                          'key_env': 'TEST_API_KEY', 'timeout_s': 3, 'max_response_bytes': 262144,
                          'events_file': str(path), 'payload': {'model': 'model', 'messages': [],
                                                                'max_tokens': 32, 'stream': False}}
                command = native_memory_command('hands-model-worker')
                command[0] = shutil.which(command[0])
                self.assertIsNotNone(command[0])
                process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE, start_new_session=True, env={'PATH': os.defpath, 'TEST_API_KEY': key})
                try:
                    process.stdin.write(json.dumps(config).encode())
                    process.stdin.close()
                    deadline = time.monotonic() + 2
                    while not path.exists() or 'Provider reasoning' not in path.read_text():
                        self.assertLess(time.monotonic(), deadline)
                        time.sleep(0.005)
                    self.assertIsNone(process.poll())
                    release.set()
                    self.assertEqual(process.wait(timeout=2), 0)
                    stdout = process.stdout.read().decode()
                    self.assertEqual(len(stdout.splitlines()), 1)
                    result = json.loads(stdout)
                    self.assertTrue(result['ok'], result)
                    self.assertEqual(result['epoch'], 1)
                    self.assertEqual(result['result']['content'], 'Final answer')
                    self.assertEqual(result['result']['reasoning_content'], thought + key)
                    self.assertNotIn(key, path.read_text())
                    events = TraceReader(path, from_end=False).poll()
                    self.assertEqual(''.join(e['text'] for e in events if e['kind'] == 'thinking'),
                                     thought + '[redacted]')
                    self.assertEqual(''.join(e['text'] for e in events if e['kind'] == 'answer'), 'Final answer')
                    self.assertEqual(process.stderr.read(), b'')
                    self.assertEqual(seen, [('/v1/chat/completions', 'Bearer ' + key, {
                        'model': 'model', 'messages': [], 'stream': True, 'max_tokens': 32,
                        'stream_options': {'include_usage': True},
                    })])
                finally:
                    release.set()
                    provider_can_close.set()
                    if process.poll() is None:
                        process.kill()
                        process.wait()
                    process.stdout.close()
                    process.stderr.close()
        finally:
            release.set()
            provider_can_close.set()
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)
