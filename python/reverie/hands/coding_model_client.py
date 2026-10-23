import json
import math
import os
import re
import signal
import sys
import urllib.parse
import urllib.request
from contextlib import contextmanager

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from coding_tokens import NoRedirect, TokenMeter


@contextmanager
def deadline(seconds):
    if signal.getitimer(signal.ITIMER_REAL) != (0.0, 0.0):
        raise RuntimeError('model client cannot replace an active process timer')
    previous = signal.getsignal(signal.SIGALRM)
    def expired(signum, frame):
        raise TimeoutError('model deadline')
    signal.signal(signal.SIGALRM, expired)
    try:
        signal.setitimer(signal.ITIMER_REAL, seconds)
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


class ModelClient:
    def __init__(self, api_base, *, key_env=None, timeout_s=300, max_response_bytes=262144, token_meter=None):
        parsed = urllib.parse.urlsplit(api_base)
        if (parsed.scheme not in ('http', 'https') or not parsed.hostname or
                parsed.username is not None or parsed.password is not None or parsed.query or parsed.fragment):
            raise ValueError('invalid model endpoint')
        if key_env is not None and (not isinstance(key_env, str) or not re.fullmatch(r'[A-Z_][A-Z0-9_]*', key_env)):
            raise ValueError('invalid API key environment variable name')
        if type(timeout_s) not in (int, float) or not math.isfinite(timeout_s) or timeout_s <= 0:
            raise ValueError('invalid model timeout')
        if type(max_response_bytes) is not int or max_response_bytes <= 0:
            raise ValueError('invalid response cap')
        self.endpoint = api_base.rstrip('/') + '/chat/completions'
        self.key_env = key_env
        self.timeout_s = timeout_s
        self.max_response_bytes = max_response_bytes
        self.token_meter = TokenMeter(**token_meter) if token_meter is not None else None
        self.opener = urllib.request.build_opener(NoRedirect())

    def __call__(self, payload, remaining):
        if remaining <= 0:
            raise TimeoutError('task deadline')
        timeout = min(self.timeout_s, remaining)
        with deadline(timeout):
            return self.request(payload, timeout)

    def request(self, payload, timeout):
        measured = self.token_meter.measure(payload) if self.token_meter is not None else None
        if measured is not None and not measured['admitted']:
            return {'_context_overflow': True, '_context_stats': measured}
        headers = {'Content-Type': 'application/json'}
        if self.key_env is not None:
            key = os.environ.get(self.key_env)
            if not key:
                raise ValueError('configured API key is unavailable')
            headers['Authorization'] = 'Bearer ' + key
        body = json.dumps(payload, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf-8')
        request = urllib.request.Request(self.endpoint, data=body, headers=headers)
        with self.opener.open(request, timeout=timeout) as stream:
            raw = stream.read(self.max_response_bytes + 1)
        if len(raw) > self.max_response_bytes:
            raise ValueError('model response limit')
        response = json.loads(raw)
        choices = response.get('choices') if isinstance(response, dict) else None
        if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
            raise ValueError('invalid model response')
        message = choices[0].get('message')
        if not isinstance(message, dict):
            raise ValueError('invalid model message')
        result = dict(message)
        if isinstance(response.get('timings'), dict):
            result['_timings'] = response['timings']
        if measured is not None:
            result['_context_stats'] = measured
        if isinstance(response.get('usage'), dict):
            result['_usage'] = response['usage']
        return result


def worker():
    raw = sys.stdin.buffer.read(1048577)
    if len(raw) > 1048576:
        raise ValueError('model worker input limit')
    config = json.loads(raw)
    epoch = config['epoch']
    if type(epoch) is not int or epoch <= 0:
        raise ValueError('invalid model request epoch')
    try:
        client = ModelClient(config['api_base'], key_env=config.get('key_env'),
                             timeout_s=config['timeout_s'], max_response_bytes=config['max_response_bytes'],
                             token_meter=config.get('token_meter'))
        return {'epoch': epoch, 'ok': True, 'result': client(config['payload'], config['timeout_s'])}
    except Exception as error:
        timed_out = isinstance(error, TimeoutError) or isinstance(getattr(error, 'reason', None), TimeoutError)
        return {'epoch': epoch, 'ok': False, 'error': 'model_timeout' if timed_out else 'model_request_failed'}


if __name__ == '__main__':
    try:
        result = worker()
    except Exception:
        result = {'ok': False, 'error': 'invalid_model_worker_input'}
    print(json.dumps(result, ensure_ascii=False, allow_nan=False))
