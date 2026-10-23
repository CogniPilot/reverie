import io
import json
import os
import signal
import time
import unittest
from unittest.mock import patch

from coding_model_client import ModelClient, NoRedirect


class ModelClientTests(unittest.TestCase):
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
