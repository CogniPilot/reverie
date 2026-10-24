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
from model_events import TraceWriter


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
    def __init__(self, api_base, *, key_env=None, timeout_s=300, max_response_bytes=262144, token_meter=None,
                 events_file=None):
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
        self.max_stream_bytes = min(8 * 1024 * 1024, 32 * max_response_bytes)
        self.events_file = events_file
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
        key = None
        if self.key_env is not None:
            key = os.environ.get(self.key_env)
            if not key:
                raise ValueError('configured API key is unavailable')
            headers['Authorization'] = 'Bearer ' + key
        trace = TraceWriter(self.events_file, secrets=(key,)) if self.events_file is not None else None
        request_payload = payload
        if trace is not None:
            request_payload = dict(payload, stream=True,
                                   stream_options=dict(payload.get('stream_options') or {}, include_usage=True))
        body = json.dumps(request_payload, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf-8')
        request = urllib.request.Request(self.endpoint, data=body, headers=headers)
        try:
            with self.opener.open(request, timeout=timeout) as stream:
                if trace is not None:
                    response = self.read_stream(stream, trace)
                else:
                    raw = stream.read(self.max_response_bytes + 1)
                    if len(raw) > self.max_response_bytes:
                        raise ValueError('model response limit')
                    response = json.loads(raw)
        finally:
            if trace is not None:
                trace.flush()
        choices = response.get('choices') if isinstance(response, dict) else None
        if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
            raise ValueError('invalid model response')
        message = choices[0].get('message')
        if not isinstance(message, dict):
            raise ValueError('invalid model message')
        result = dict(message)
        result['_finish_reason'] = choices[0].get('finish_reason')
        if isinstance(response.get('timings'), dict):
            result['_timings'] = response['timings']
        if measured is not None:
            result['_context_stats'] = measured
        if isinstance(response.get('usage'), dict):
            result['_usage'] = response['usage']
        if isinstance(response.get('model'), str):
            result['_model'] = response['model']
        return result

    def read_stream(self, stream, trace):
        message = {'role': 'assistant', 'content': ''}
        response = {'choices': [{'message': message, 'finish_reason': None}]}
        calls = {}
        decoded_bytes = 0
        wire_bytes = 0
        pending = []
        pending_bytes = 0
        done = False

        def append(target, key, value):
            nonlocal decoded_bytes
            if value is None:
                return
            if not isinstance(value, str):
                raise ValueError('invalid stream delta')
            decoded_bytes += len(value.encode('utf-8'))
            if decoded_bytes > self.max_response_bytes:
                raise ValueError('model response limit')
            target[key] = target.get(key, '') + value

        def consume(data):
            nonlocal done
            if data.strip() == b'[DONE]':
                done = True
                return
            chunk = json.loads(data)
            if not isinstance(chunk, dict) or chunk.get('error') is not None:
                raise ValueError('invalid model stream')
            for name in ('usage', 'timings'):
                if isinstance(chunk.get(name), dict):
                    response[name] = chunk[name]
            if isinstance(chunk.get('model'), str):
                response['model'] = chunk['model']
            choices = chunk.get('choices', [])
            if not isinstance(choices, list):
                raise ValueError('invalid stream choices')
            for choice in choices:
                if not isinstance(choice, dict):
                    raise ValueError('invalid stream choice')
                if choice.get('index', 0) != 0:
                    continue
                delta = choice.get('delta') or {}
                if not isinstance(delta, dict):
                    raise ValueError('invalid stream delta')
                for field, kind in (('reasoning_content', 'thinking'), ('reasoning', 'thinking'), ('content', 'answer')):
                    if delta.get(field) is not None:
                        append(message, field, delta[field])
                        trace.write(kind, delta[field])
                tool_calls = delta.get('tool_calls') or []
                if not isinstance(tool_calls, list):
                    raise ValueError('invalid stream tool calls')
                for tool in tool_calls:
                    if not isinstance(tool, dict) or type(tool.get('index')) is not int or not 0 <= tool['index'] < 64:
                        raise ValueError('invalid stream tool index')
                    call = calls.setdefault(tool['index'], {'id': '', 'type': 'function',
                                                            'function': {'name': '', 'arguments': ''}})
                    append(call, 'id', tool.get('id'))
                    if tool.get('type') not in (None, 'function'):
                        raise ValueError('invalid stream tool type')
                    function = tool.get('function') or {}
                    if not isinstance(function, dict):
                        raise ValueError('invalid stream function')
                    append(call['function'], 'name', function.get('name'))
                    append(call['function'], 'arguments', function.get('arguments'))
                finish = choice.get('finish_reason')
                if finish is not None:
                    if not isinstance(finish, str):
                        raise ValueError('invalid stream finish reason')
                    response['choices'][0]['finish_reason'] = finish

        while not done:
            line = stream.readline(min(self.max_response_bytes + 4097, self.max_stream_bytes - wire_bytes + 1))
            if not line:
                if pending:
                    consume(b'\n'.join(pending))
                break
            wire_bytes += len(line)
            if wire_bytes > self.max_stream_bytes or len(line) > self.max_response_bytes + 4096:
                raise ValueError('model stream limit')
            if line in (b'\n', b'\r\n'):
                if pending:
                    consume(b'\n'.join(pending))
                pending, pending_bytes = [], 0
            elif line.startswith(b'data:'):
                data = line[5:].strip()
                pending_bytes += len(data)
                if pending_bytes > self.max_response_bytes + 4096:
                    raise ValueError('model stream event limit')
                pending.append(data)
        if not done or response['choices'][0]['finish_reason'] is None:
            raise ValueError('incomplete model stream')
        if calls:
            if sorted(calls) != list(range(len(calls))):
                raise ValueError('incomplete stream tool calls')
            message['tool_calls'] = [calls[index] for index in sorted(calls)]
        if len(json.dumps(response, ensure_ascii=False).encode('utf-8')) > self.max_response_bytes:
            raise ValueError('model response limit')
        return response


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
                             token_meter=config.get('token_meter'), events_file=config.get('events_file'))
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
