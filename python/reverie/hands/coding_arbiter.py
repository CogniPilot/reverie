import json
import os
import sys
import time

from coding_process import BoundedProcess


class ModelArbiter:
    def __init__(self, api_base, *, key_env=None, timeout_s=300, max_response_bytes=262144,
                 token_meter=None, events_file=None, process_factory=BoundedProcess, clock=time.monotonic,
                 prepare_request=None):
        self.api_base = api_base
        self.key_env = key_env
        self.timeout_s = timeout_s
        self.max_response_bytes = max_response_bytes
        self.token_meter = token_meter
        self.events_file = events_file
        self.factory = process_factory
        self.clock = clock
        self.job = None
        self.pending = None
        self.deadline = None
        self.paused = False
        self.preemptions = 0
        self.requests_started = 0
        self.watchdog_events = []
        self.epoch = 0
        self.prepare_request = prepare_request
        self.preparation_error = None

    def submit(self, payload, remaining):
        if self.pending is not None:
            raise RuntimeError('model slot already has a coding request')
        self.pending = payload
        self.preparation_error = None
        self.deadline = self.clock() + remaining
        if not self.paused:
            self.start()

    def start(self):
        if self.deadline - self.clock() <= 0:
            return
        payload = self.pending
        if self.prepare_request is not None:
            try:
                payload = self.prepare_request(payload)
                if not isinstance(payload, dict): raise ValueError('Invalid prepared request')
            except Exception:
                self.preparation_error = 'model_context_unavailable'
                return
        remaining = self.deadline - self.clock()
        if remaining <= 0:
            return
        self.epoch += 1
        config = {'api_base': self.api_base, 'key_env': self.key_env,
                  'timeout_s': min(self.timeout_s, remaining), 'max_response_bytes': self.max_response_bytes,
                  'payload': payload, 'token_meter': self.token_meter, 'epoch': self.epoch,
                  'events_file': self.events_file}
        environment = {'PATH': os.defpath, 'LANG': 'C.UTF-8'}
        if self.key_env is not None and self.key_env in os.environ:
            environment[self.key_env] = os.environ[self.key_env]
        worker = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'coding_model_client.py')
        self.job = self.factory([sys.executable, '-I', '-B', worker, '--worker'],
                                json.dumps(config, ensure_ascii=False).encode('utf-8'),
                                min(self.timeout_s, remaining), self.max_response_bytes,
                                environment=environment)
        self.requests_started += 1

    def pause_for_chat(self):
        self.paused = True
        if self.job is not None:
            self.epoch += 1
            self.job.cancel('preempted_for_chat')
            self.job = None
            self.preemptions += 1

    def resume(self):
        self.paused = False
        if self.pending is not None and self.job is None and not self.preparation_error:
            self.start()

    def poll(self):
        if self.pending is None:
            return None
        if self.preparation_error:
            error = self.preparation_error
            self.pending, self.job, self.preparation_error = None, None, None
            return {'ok': False, 'error': error}
        if self.clock() >= self.deadline:
            self.cancel()
            return {'ok': False, 'error': 'model_deadline'}
        if self.paused:
            return None
        if self.job is None:
            self.start()
        if not self.job.poll():
            return None
        if self.job.error:
            answer = {'ok': False, 'error': self.job.error}
        else:
            try:
                answer = json.loads(self.job.output)
                if not isinstance(answer, dict) or type(answer.get('ok')) is not bool:
                    raise ValueError('invalid model worker result')
                if type(answer.get('epoch')) is not int or answer['epoch'] != self.epoch:
                    answer = {'ok': False, 'error': 'stale_model_epoch'}
            except (ValueError, TypeError):
                answer = {'ok': False, 'error': 'invalid_model_worker_result'}
        if answer.get('error') in ('timeout', 'model_timeout'):
            self.watchdog_events.append({'request': self.requests_started, 'reason': answer['error']})
        self.pending, self.job = None, None
        return answer

    def cancel(self):
        self.epoch += 1
        if self.job is not None:
            self.job.cancel('task_cancelled')
        self.job, self.pending = None, None
