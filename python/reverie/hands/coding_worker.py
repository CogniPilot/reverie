import json
import multiprocessing
import os
import signal
import time
from dataclasses import asdict

from coding_process_guard import protect
from coding_tasks import Limits, run_task


def worker_main(connection, parent_pid, messages, tools, limits, options, epoch):
    protect(parent_pid)
    deadline = time.monotonic() + limits['seconds']
    sequence = 0

    def request(kind, payload):
        nonlocal sequence
        sequence += 1
        value = {'epoch': epoch, 'sequence': sequence, 'kind': kind, 'payload': payload}
        raw = json.dumps(value, ensure_ascii=False, allow_nan=False).encode('utf-8')
        if len(raw) > 1048576:
            raise ValueError('worker request limit')
        connection.send_bytes(raw)
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not connection.poll(remaining):
            raise TimeoutError('task deadline')
        reply = json.loads(connection.recv_bytes(1048576))
        if (type(reply.get('epoch')) is not int or reply['epoch'] != epoch or
                reply.get('sequence') != sequence or reply.get('ok') is not True):
            raise RuntimeError('controller refused request')
        return reply.get('result')

    try:
        result = run_task(messages, tools,
            lambda payload, timeout: request('model', {'request': payload, 'timeout': timeout}),
            lambda payload, timeout, cap: request('tool', {'request': payload, 'timeout': timeout, 'cap': cap}),
            lambda: request('authorize', None), limits=Limits(**limits), request_options=options,
            progress=lambda event: request('progress', event))
        connection.send_bytes(json.dumps({'epoch': epoch, 'kind': 'result', 'result': asdict(result)},
                                        ensure_ascii=False, allow_nan=False).encode('utf-8'))
    except Exception:
        try:
            connection.send_bytes(json.dumps({'epoch': epoch, 'kind': 'failed',
                                               'error': 'worker_failed'}).encode('utf-8'))
        except (OSError, EOFError):
            pass
    finally:
        connection.close()


class CodingWorker:
    def __init__(self, messages, tools, limits, options, *, epoch=1):
        if type(epoch) is not int or epoch <= 0:
            raise ValueError('invalid task epoch')
        self.epoch = epoch
        context = multiprocessing.get_context('fork')
        parent, child = context.Pipe()
        self.connection = parent
        self.process = context.Process(target=worker_main,
            args=(child, os.getpid(), messages, tools, asdict(limits), options, epoch), daemon=True)
        self.process.start()
        child.close()
        self.closed = False

    def poll(self):
        if self.closed:
            return None
        if self.connection.poll():
            try:
                event = json.loads(self.connection.recv_bytes(1048576))
                if not isinstance(event, dict):
                    raise ValueError('worker event')
                if type(event.get('epoch')) is not int or event['epoch'] != self.epoch:
                    raise ValueError('worker epoch')
                return event
            except (ValueError, OSError, EOFError):
                return {'epoch': self.epoch, 'kind': 'failed', 'error': 'invalid_worker_event'}
        if not self.process.is_alive():
            return {'epoch': self.epoch, 'kind': 'failed', 'error': 'worker_exited'}
        return None

    def reply(self, sequence, result=None, error=None):
        raw = json.dumps({'epoch': self.epoch, 'sequence': sequence, 'ok': error is None, 'result': result},
                         ensure_ascii=False, allow_nan=False).encode('utf-8')
        if len(raw) > 1048576:
            raise ValueError('worker response limit')
        self.connection.send_bytes(raw)

    def close(self):
        if self.closed:
            return
        self.closed = True
        self.connection.close()
        if self.process.is_alive():
            self.process.kill()
        self.process.join()
