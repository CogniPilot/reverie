import json
import os
import selectors
import signal
import socket
import subprocess
import time
from dataclasses import asdict

from agent_journal import native_memory_command


FRAME_BYTES = 1048576
POLL_BYTES = 262144


class BoundedProcess:
    def __init__(self, argv, body, timeout, max_output, *, environment=None, clock=time.monotonic,
                 parent_bound=False):
        if timeout <= 0 or max_output <= 0:
            raise ValueError('positive process budgets required')
        self.clock = clock
        self.deadline = clock() + timeout
        self.max_output = max_output
        self.input = body
        self.position = 0
        self.output = bytearray()
        self.diagnostics = 0
        self.stderr_tail = bytearray()
        self.error = None
        self.done = False
        self.selector = selectors.DefaultSelector()
        command = list(argv)
        if not parent_bound:
            command = native_memory_command('hands-guard', resolve=True) + command
        self.process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, env=environment,
                                        close_fds=True, start_new_session=True, bufsize=0)
        for stream, events in ((self.process.stdin, selectors.EVENT_WRITE),
                               (self.process.stdout, selectors.EVENT_READ),
                               (self.process.stderr, selectors.EVENT_READ)):
            os.set_blocking(stream.fileno(), False)
            self.selector.register(stream, events)

    def cancel(self, reason='cancelled'):
        if self.done:
            return
        self.error = reason
        self.finish()

    def finish(self):
        if self.done:
            return
        try:
            os.killpg(self.process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
            if not stream.closed:
                stream.close()
        self.selector.close()
        self.process.wait()
        self.done = True

    def poll(self):
        if self.done:
            return True
        if self.clock() >= self.deadline:
            self.cancel('timeout')
            return True
        work = 0
        while work < POLL_BYTES:
            ready = self.selector.select(0)
            if not ready:
                break
            for key, _ in ready:
                stream = key.fileobj
                if stream is self.process.stdin:
                    try:
                        sent = os.write(stream.fileno(), self.input[self.position:self.position + 16384])
                        self.position += sent
                        work += sent
                    except BlockingIOError:
                        continue
                    except BrokenPipeError:
                        self.position = len(self.input)
                    if self.position >= len(self.input):
                        self.selector.unregister(stream)
                        stream.close()
                    continue
                try:
                    chunk = os.read(stream.fileno(), 16384)
                except BlockingIOError:
                    continue
                work += len(chunk)
                if not chunk:
                    self.selector.unregister(stream)
                    stream.close()
                elif stream is self.process.stdout:
                    if len(self.output) + len(chunk) > self.max_output:
                        self.cancel('output_limit')
                        return True
                    self.output.extend(chunk)
                else:
                    self.diagnostics += len(chunk)
                    self.stderr_tail.extend(chunk)
                    del self.stderr_tail[:-4096]
                    if self.diagnostics > 4096:
                        self.cancel('diagnostics_limit')
                        return True
        if not self.selector.get_map() and self.process.poll() is not None:
            if self.process.returncode != 0:
                self.error = 'process_failed'
            self.finish()
        return self.done


class CodingWorker:
    def __init__(self, messages, tools, limits, options, *, epoch=1):
        if type(epoch) is not int or epoch <= 0:
            raise ValueError('invalid task epoch')
        self.epoch = epoch
        self.closed = False
        self.input = bytearray()
        self.output = self.packet({'epoch': epoch, 'messages': messages, 'tools': tools,
                                   'limits': asdict(limits), 'options': options})
        self.connection, child = socket.socketpair()
        self.connection.setblocking(False)
        try:
            self.process = subprocess.Popen(native_memory_command('hands-coding-worker', resolve=True),
                stdin=child, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                start_new_session=True, env={'PATH': os.defpath, 'LANG': 'C.UTF-8'})
        except BaseException:
            self.connection.close()
            raise
        finally:
            child.close()

    @staticmethod
    def packet(value):
        frame = json.dumps(value, ensure_ascii=False, allow_nan=False).encode('utf-8')
        if len(frame) > FRAME_BYTES:
            raise ValueError('worker frame limit')
        return memoryview(frame + b'\n')

    def send_pending(self):
        if self.output:
            try:
                sent = self.connection.send(self.output[:POLL_BYTES])
                self.output = self.output[sent:]
            except (BlockingIOError, BrokenPipeError):
                pass

    def next_event(self):
        budget = POLL_BYTES
        while budget:
            boundary = self.input.find(b'\n')
            if boundary >= 0:
                frame = self.input[:boundary]
                del self.input[:boundary + 1]
                return json.loads(frame)
            if len(self.input) > FRAME_BYTES:
                raise ValueError('worker event limit')
            try:
                data = self.connection.recv(min(budget, 65536, FRAME_BYTES + 1 - len(self.input)))
            except BlockingIOError:
                return None
            if not data:
                if self.input:
                    raise ValueError('incomplete worker event')
                return {'epoch': self.epoch, 'kind': 'failed', 'error': 'worker_exited'}
            self.input.extend(data)
            budget -= len(data)
        return None

    def poll(self):
        if self.closed:
            return None
        try:
            self.send_pending()
            event = self.next_event()
            if event is not None and (not isinstance(event, dict) or
                    type(event.get('epoch')) is not int or event['epoch'] != self.epoch):
                raise ValueError('invalid worker event')
            return event
        except (ValueError, OSError):
            return {'epoch': self.epoch, 'kind': 'failed', 'error': 'invalid_worker_event'}

    def reply(self, sequence, result=None, error=None):
        if self.closed or self.output:
            raise ValueError('worker reply unavailable')
        self.output = self.packet({'epoch': self.epoch, 'sequence': sequence,
                                   'ok': error is None, 'result': result})
        self.send_pending()

    def close(self):
        if self.closed:
            return
        self.closed = True
        self.connection.close()
        if self.process.poll() is None:
            self.process.kill()
        self.process.wait()
