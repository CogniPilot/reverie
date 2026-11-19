import json
import os
import selectors
import signal
import socket
import subprocess
import threading
import time
from dataclasses import asdict

if __package__:
    from .agent_journal import native_memory_command
else:
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


class WorkerSocket:
    def __init__(self, worker, initial, *, environment=None, terminal=False, startup_limit=FRAME_BYTES, reply_limit=FRAME_BYTES, send_limit=FRAME_BYTES):
        self.closed = False
        self.input = bytearray()
        self.output = self.packet(initial, startup_limit)
        self.reply_limit = reply_limit
        self.send_limit = send_limit
        self.connection, child = socket.socketpair()
        self.connection.setblocking(False)
        try:
            env = {'PATH': os.defpath, 'LANG': 'C.UTF-8'}
            env.update(environment or {})
            self.process = subprocess.Popen(native_memory_command(worker, resolve=True),
                stdin=None if terminal else child, stdout=None if terminal else subprocess.DEVNULL,
                stderr=child if terminal else subprocess.DEVNULL,
                start_new_session=True, env=env)
        except BaseException:
            self.connection.close()
            raise
        finally:
            child.close()

    @staticmethod
    def packet(value, limit=FRAME_BYTES):
        frame = json.dumps(value, ensure_ascii=False, allow_nan=False).encode('utf-8')
        if len(frame) > limit:
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
        while True:
            boundary = self.input.find(b'\n')
            if boundary >= 0:
                frame = self.input[:boundary]
                del self.input[:boundary + 1]
                return json.loads(frame)
            if len(self.input) > self.reply_limit:
                raise ValueError('worker event limit')
            if not budget:
                return None
            try:
                data = self.connection.recv(min(budget, 65536, self.reply_limit + 1 - len(self.input)))
            except BlockingIOError:
                return None
            if not data:
                if self.input:
                    raise ValueError('incomplete worker event')
                raise EOFError('worker exited')
            self.input.extend(data)
            budget -= len(data)
    def send(self, message):
        if self.closed or self.output:
            raise ValueError('worker reply unavailable')
        self.output = self.packet(message, self.send_limit)
        self.send_pending()

    def wait(self, seconds):
        deadline = time.monotonic() + seconds
        with selectors.DefaultSelector() as selector:
            selector.register(self.connection, selectors.EVENT_READ)
            while True:
                self.send_pending()
                packet = self.next_event()
                if packet is not None:
                    return packet
                mask = selectors.EVENT_READ | (selectors.EVENT_WRITE if self.output else 0)
                selector.modify(self.connection, mask)
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not selector.select(remaining):
                    raise TimeoutError('worker reply deadline')

    def close(self, *, grace=0):
        if self.closed:
            return
        self.closed = True
        self.connection.close()
        try:
            self.process.wait(timeout=grace)
            return
        except subprocess.TimeoutExpired:
            self.process.kill()
        self.process.wait()


class Terminal:
    """Forward observations and local prompts across the native terminal boundary."""

    def __init__(self, cfg, *, output=None, interactive=None):
        self.cfg = cfg
        self.output = output
        self.interactive = interactive is not False
        self.quit_requested = False
        self.worker = None
        self.lock = threading.RLock()

    def start(self):
        fields = ('api_base', 'model', 'self_name', 'poll_s', 'prompt_cap_chars',
                  'reply_max_tokens', 'message_cap_chars')
        settings = {key: self.cfg[key] for key in fields}
        secrets = [os.environ[name] for name in (self.cfg.get('model_key_env'), 'REVERIE_PASSWORD')
                   if name and os.environ.get(name)]
        settings.update(interactive=self.interactive, capture=self.output is not None, secrets=secrets,
                        coding=bool(self.cfg.get('coding')), search=bool(self.cfg.get('search')),
                        memory=bool(self.cfg.get('memory_instance')), trace=self.cfg.get('model_events_file'))
        try:
            self.worker = WorkerSocket('hands-terminal-worker', settings, terminal=True,
                                       environment={'TERM': os.environ.get('TERM', '')})
            self._receive()
        except (OSError, EOFError, ValueError):
            self._close()
            print('Terminal unavailable; the harness will continue.', file=self.output, flush=True)
        return self

    def _receive(self):
        reply = self.worker.wait(2)
        self.interactive = reply['interactive']
        for line in reply['lines']:
            print(line, file=self.output, flush=True)
        return reply

    def _request(self, action, **fields):
        with self.lock:
            if self.worker is not None:
                try:
                    self.worker.send({'action': action, **fields})
                    return self._receive()
                except (OSError, EOFError, ValueError):
                    self._close()
        return {}

    def _close(self):
        if self.worker is not None:
            self.worker.close(grace=1)
            self.worker = None
        self.interactive = False

    def event(self, kind, **data):
        self._request('observe', event={'kind': kind, **data})

    def log(self, *parts):
        kind = 'error' if parts and ('failed' in str(parts[0]) or 'unavailable' in str(parts[0])) else 'note'
        self.event(kind, text=' '.join(map(str, parts)))

    def summary(self):
        status = getattr(self.cfg.get('_attention'), 'status', 'not started')
        return self._request('status', phone_wake=status).get('summary', 'Terminal unavailable')

    def has_input(self):
        return self.interactive and self._request('poll', take_input=False).get('pending', False)

    def pending(self):
        if self.interactive:
            return self._request('poll', take_input=True).get('prompt')
        return None

    def clear(self):
        self._request('clear')

    def stop(self):
        self._request('stop')
        self._close()


class ModelArbiter(WorkerSocket):
    def __init__(self, api_base, *, key_env=None, timeout_s=300, max_response_bytes=262144,
                 token_meter=None, events_file=None, prepare_request=None):
        self.prepare_request = prepare_request
        self.payload = None
        self.resume_pending = False
        self.preemptions = 0
        self.requests_started = 0
        self.watchdog_events = []
        settings = {'api_base': api_base, 'key_env': key_env, 'timeout_s': timeout_s,
                    'max_response_bytes': max_response_bytes, 'token_meter': token_meter, 'events_file': events_file}
        environment = {key_env: os.environ[key_env]} if key_env is not None and key_env in os.environ else None
        super().__init__('hands-model-slot-worker', settings, environment=environment)
        try:
            if self.wait(2) != {'kind': 'idle'}:
                raise ValueError('model slot refused initialization')
        except BaseException:
            self.close()
            raise

    def _request(self, action, **fields):
        self.send({'action': action, **fields})
        return self.wait(2)

    def _prepare(self, reply):
        if reply['kind'] != 'prepare':
            return
        payload = self.payload
        if self.prepare_request is not None:
            try:
                payload = self.prepare_request(payload)
                if not isinstance(payload, dict):
                    raise ValueError('Invalid prepared request')
            except Exception:
                payload = None
        self._request('prepared', payload=payload)

    def submit(self, payload, remaining):
        reply = self._request('submit', seconds=remaining)
        if reply['kind'] == 'busy':
            raise RuntimeError('model slot already has a coding request')
        self.payload = payload
        self._prepare(reply)

    def pause_for_chat(self):
        if not self.resume_pending:
            self._request('pause')
            self.resume_pending = True

    def resume(self):
        if self.resume_pending:
            self.resume_pending = False
            self._prepare(self._request('resume'))

    def poll(self):
        if self.payload is None:
            return None
        reply = self._request('poll')
        if reply['kind'] == 'answer':
            self.payload = None
            return reply['answer']
        return None

    def cancel(self):
        if self.closed:
            return
        try:
            stats = self._request('finish')['stats']
            self.preemptions = stats['preemptions']
            self.requests_started = stats['requests_started']
            self.watchdog_events = stats['watchdog_events']
        except (EOFError, OSError, ValueError):
            pass
        finally:
            self.payload = None
            self.close()


class CodingWorker(WorkerSocket):
    def __init__(self, messages, tools, limits, options, *, epoch=1):
        if type(epoch) is not int or epoch <= 0:
            raise ValueError('invalid task epoch')
        self.epoch = epoch
        super().__init__('hands-coding-worker', {'epoch': epoch, 'messages': messages, 'tools': tools,
                                               'limits': asdict(limits), 'options': options})

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
        except EOFError:
            return {'epoch': self.epoch, 'kind': 'failed', 'error': 'worker_exited'}
        except (ValueError, OSError):
            return {'epoch': self.epoch, 'kind': 'failed', 'error': 'invalid_worker_event'}

    def reply(self, sequence, result=None, error=None):
        self.send({'epoch': self.epoch, 'sequence': sequence, 'ok': error is None, 'result': result})
