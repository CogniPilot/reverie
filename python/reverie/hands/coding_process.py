import os
import selectors
import signal
import subprocess
import sys
import time


class BoundedProcess:
    def __init__(self, argv, body, timeout, max_output, *, environment=None, clock=time.monotonic):
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
        guard = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'coding_process_guard.py')
        command = [sys.executable, '-I', '-B', guard, str(os.getpid())] + list(argv)
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
        while work < 262144:
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
