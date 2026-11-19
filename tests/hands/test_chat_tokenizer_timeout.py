"""Optional chat statistics must not replace strict coding admission or deadlines."""
import http.server
import json
import threading
import time
import unittest
import urllib.error

from coding_chat import model_completion
from coding_process import ModelArbiter


class ChatTokenizerTimeoutTests(unittest.TestCase):
    def fixture(self, *, delay=0, tokens=1, status=200, context=64):
        events = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                self.respond()

            def do_POST(self):
                self.respond()

            def respond(self):
                events.append(self.path)
                size = int(self.headers.get('Content-Length', '0'))
                if size:
                    self.rfile.read(size)
                if self.path == '/props':
                    time.sleep(delay)
                    body = {'default_generation_settings': {'n_ctx': context}, 'total_slots': 1}
                    code = status
                elif self.path == '/apply-template':
                    body, code = {'prompt': 'a fixed template'}, 200
                elif self.path == '/tokenize':
                    body, code = {'tokens': [1] * tokens}, 200
                elif self.path == '/v1/chat/completions':
                    body = {'choices': [{'message': {'content': 'DIAGNOSTIC_OK'}, 'finish_reason': 'stop'}]}
                    code = 200
                else:
                    raise AssertionError('unexpected path')
                raw = json.dumps(body).encode()
                try:
                    self.send_response(code)
                    self.send_header('Content-Length', str(len(raw)))
                    self.end_headers()
                    self.wfile.write(raw)
                except (BrokenPipeError, ConnectionResetError):
                    pass

        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(lambda: (server.shutdown(), server.server_close(), thread.join(2)))
        return 'http://127.0.0.1:' + str(server.server_port), events

    @staticmethod
    def config(base, *, timeout=2, meter_timeout=.04):
        return {
            'api_base': base + '/v1', 'timeout_s': timeout, 'max_response_bytes': 262144,
            'token_meter': {'base_url': base, 'context_ceiling': 64, 'margin': 0, 'timeout_s': meter_timeout},
            'payload': {'model': 'fixture', 'messages': [{'role': 'user', 'content': 'test'}],
                        'max_tokens': 2, 'stream': False},
        }

    def coding_response(self, base, *, meter_timeout=1):
        config = self.config(base, meter_timeout=meter_timeout)
        arbiter = ModelArbiter(config['api_base'], timeout_s=3, token_meter=config['token_meter'])
        self.addCleanup(arbiter.cancel)
        arbiter.submit(config['payload'], 3)
        while (result := arbiter.poll()) is None:
            time.sleep(.01)
        return result

    def test_real_delayed_tokenizer_plain_chat_completes_once_with_unknown_counts(self):
        base, events = self.fixture(delay=.15)
        result = model_completion(self.config(base))
        self.assertEqual(result['content'], 'DIAGNOSTIC_OK')
        self.assertEqual(result['_token_meter_status'], 'unavailable')
        self.assertNotIn('_context_stats', result)
        self.assertEqual(events, ['/props', '/v1/chat/completions'])

    def test_same_delayed_tokenizer_default_strict_coding_never_sends_completion(self):
        base, events = self.fixture(delay=.15)
        result = self.coding_response(base, meter_timeout=.04)
        self.assertEqual(result, {'ok': False, 'epoch': 1, 'error': 'model_timeout'})
        self.assertEqual(events, ['/props'])

    def test_measured_context_overflow_still_refuses_even_for_optional_chat_meter(self):
        base, events = self.fixture(tokens=63)
        result = model_completion(self.config(base, meter_timeout=1))
        self.assertTrue(result['_context_overflow'])
        self.assertFalse(result['_context_stats']['admitted'])
        self.assertEqual(events, ['/props', '/apply-template', '/tokenize'])

    def test_isolated_coding_worker_reaches_the_native_meter(self):
        base, events = self.fixture()
        result = self.coding_response(base)
        self.assertTrue(result['ok'], result)
        self.assertEqual(result['result']['_context_stats']['prompt_tokens'], 1)
        self.assertEqual(events, ['/props', '/apply-template', '/tokenize', '/v1/chat/completions'])

    def test_authentication_error_is_not_an_optional_timeout(self):
        base, events = self.fixture(status=401)
        with self.assertRaises(urllib.error.HTTPError) as error:
            model_completion(self.config(base, meter_timeout=1))
        self.assertEqual(error.exception.code, 401)
        self.assertEqual(events, ['/props'])

    def test_malformed_meter_result_still_refuses(self):
        base, events = self.fixture(context=True)
        with self.assertRaises(ValueError):
            model_completion(self.config(base, meter_timeout=1))
        self.assertEqual(events, ['/props'])

    def test_whole_request_deadline_never_falls_back(self):
        base, events = self.fixture(delay=.6)
        started = time.monotonic()
        with self.assertRaises(TimeoutError):
            model_completion(self.config(base, timeout=.15, meter_timeout=1))
        self.assertLess(time.monotonic() - started, .5)
        self.assertNotIn('/v1/chat/completions', events)
