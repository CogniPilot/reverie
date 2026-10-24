"""Reverie Harness' terminal conversation view, rendered inside the existing console PTY.

The inference/poll loop stays on the main thread (its deadline uses SIGALRM).
One UI thread owns curses and queues input; it never calls a model or chat API.
Non-interactive runs retain readable, timestamped output without terminal escapes.
"""
from collections import deque
from datetime import datetime, timezone
import os
import queue
import re
import sys
import textwrap
import threading
import time
import urllib.parse
from model_events import TraceReader


CONTROL = re.compile(r'\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|[\x00-\x08\x0b-\x1f\x7f-\x9f]')
BEARER = re.compile(r'(?i)\bBearer\s+[^\s"\']+')
QUERY_SECRET = re.compile(r'(?i)((?:api[_-]?key|token|password|secret)=)[^&\s"\']+')


class DebugTerminal:
    def __init__(self, cfg, *, output=None, interactive=None):
        self.cfg = cfg
        self.output = sys.stdout if output is None else output
        self.interactive = (sys.stdin.isatty() and self.output.isatty() and
                            os.environ.get('TERM', '') not in ('', 'dumb')) if interactive is None else interactive
        self.records = deque(maxlen=200)
        self.inputs = queue.Queue(maxsize=16)
        self.lock = threading.RLock()
        self.ready = threading.Event()
        self.closed = threading.Event()
        self.thread = None
        self.trace_thread = None
        self.trace = None
        self.trace_failed = False
        if cfg.get('model_events_file'):
            try:
                self.trace = TraceReader(cfg['model_events_file'])
            except (OSError, ValueError):
                self.trace_failed = True
        self.quit_requested = False
        self.phase = 'Starting'
        self.phase_since = time.monotonic()
        self.polls = self.errors = self.replies = self.room_count = 0
        self.last_poll = 'not yet'
        self.api_model = 'unverified'
        self.usage = 'not reported'
        self.revision = 0
        self._secrets = tuple(value for name in (cfg.get('model_key_env'), 'REVERIE_PASSWORD')
                              if name and (value := os.environ.get(name)))

    def clean(self, text):
        text = str(text)
        for secret in self._secrets:
            text = text.replace(secret, '[redacted]')
        text = BEARER.sub('Bearer [redacted]', text)
        text = QUERY_SECRET.sub(r'\1[redacted]', text)
        return CONTROL.sub('', text).replace('\t', '    ')[:12000]

    def endpoint(self):
        try:
            parsed = urllib.parse.urlsplit(self.cfg['api_base'])
            # Never show credentials, query strings or fragments.
            host = parsed.hostname or '?'
            if ':' in host:
                host = '[' + host + ']'
            port = ':' + str(parsed.port) if parsed.port else ''
            return self.clean(parsed.scheme + '://' + host + port + parsed.path)
        except (ValueError, KeyError):
            return '(invalid endpoint)'

    def summary(self):
        with self.lock:
            return self.clean(
                f"Reverie Harness / Python PID {os.getpid()} | configured model: {self.cfg['model']}\n"
                f"Endpoint: {self.endpoint()} | API-reported model: {self.api_model}\n"
                f"State: {self.phase} | polls: {self.polls}, rooms: {self.room_count}, "
                f"posted replies: {self.replies}, errors: {self.errors}\n"
                f"Prompt cap: {self.cfg['prompt_cap_chars']} characters; "
                f"reply cap: {self.cfg['reply_max_tokens']} tokens | usage: {self.usage}\n"
                f"Coding: {'enabled' if self.cfg.get('coding') else 'off'}; "
                f"search: {'enabled' if self.cfg.get('search') else 'off'}; "
                f"memory recall: {'enabled' if self.cfg.get('memory_instance') else 'off'}"
            )

    def start(self):
        if self.interactive:
            self.thread = threading.Thread(target=self._screen, name='hands-terminal', daemon=True)
            self.thread.start()
            self.ready.wait(2)
        if not self.interactive:
            self._print(self.summary())
        if self.trace is not None:
            self.trace_thread = threading.Thread(target=self._trace_loop, name='hands-model-trace', daemon=True)
            self.trace_thread.start()
        if self.trace_failed:
            self.event('note', text='Model trace unavailable: private-file checks failed.')
        return self

    def stop(self):
        self.closed.set()
        if self.thread:
            self.thread.join(2)
        if self.trace_thread:
            self.trace_thread.join(2)
        self.poll_trace(drain=True)
        self._print('Reverie Harness stopped.')

    def _print(self, text):
        print(self.clean(text), file=self.output, flush=True)

    def event(self, kind, **data):
        """Runtime observations; never display model request bodies, headers or keys."""
        if kind == 'model_done':
            self.poll_trace(drain=True)
        stamp = datetime.now(timezone.utc).strftime('%H:%M:%S')
        body = None
        with self.lock:
            phase = {
                'poll': 'Polling rooms', 'idle': 'Waiting for messages',
                'incoming': 'Preparing reply', 'model_start': 'Waiting for model',
                'model_done': 'Model answered', 'posting': 'Posting room reply',
                'reply': 'Waiting for messages', 'local_reply': 'Waiting for messages',
                'error': 'Error; loop will retry', 'stopped': 'Stopped',
            }.get(kind)
            if phase:
                self.phase, self.phase_since = phase, time.monotonic()
            if kind == 'poll':
                self.polls += 1
                self.last_poll = stamp
            elif kind == 'rooms':
                self.room_count = data['count']
            elif kind == 'incoming':
                body = f"{data['sender']} [{data['room']}]\n{data['text']}"
            elif kind == 'model_start':
                body = f"Model request: {data['chars']} characters"
            elif kind == 'model_done':
                if isinstance(data.get('model'), str) and data['model']:
                    self.api_model = self.clean(data['model'])
                usage = data.get('usage')
                if isinstance(usage, dict):
                    counts = {k: v for k, v in usage.items()
                              if k in ('prompt_tokens', 'completion_tokens', 'total_tokens') and
                              type(v) is int and v >= 0}
                    self.usage = ', '.join(f'{k}={v}' for k, v in counts.items()) or 'not reported'
                body = f"Model answered in {data['seconds']:.2f}s | API model: {self.api_model}"
            elif kind in ('reply', 'local_reply'):
                if kind == 'reply':
                    confirmed = bool(data.get('confirmed'))
                    self.replies += int(confirmed)
                    label = 'posted' if confirmed else 'post returned without a receipt'
                else:
                    label = 'terminal'
                body = f"{self.cfg['self_name']} [{data['room']}; {label}]\n{data['text']}"
            elif kind == 'error':
                self.errors += 1
                body = 'ERROR: ' + data['text']
            elif kind == 'note':
                body = data['text']
            if body is not None:
                body = self.clean(body)
                self.records.append((stamp, kind, body))
                self.revision += 1
                if not self.interactive:
                    self._print(f'[{stamp}] {body}')

    def _trace_loop(self):
        while not self.closed.wait(0.1):
            self.poll_trace()

    def poll_trace(self, *, drain=False):
        with self.lock:
            if self.trace is None:
                return
            try:
                for _ in range(16 if drain else 1):
                    events = self.trace.poll()
                    if not events:
                        break
                    # Coalesce token deltas into bounded transcript rows. Curses
                    # redraws at most ten times a second, independently of inference.
                    grouped = []
                    for event in events:
                        kind, text = event['kind'], self.clean(event['text'])
                        if grouped and grouped[-1][0] == kind:
                            grouped[-1][1] += text
                        else:
                            grouped.append([kind, text])
                    for kind, text in grouped:
                        delta = text
                        stamp = datetime.now(timezone.utc).strftime('%H:%M:%S')
                        label = 'Thinking' if kind == 'thinking' else 'Answer stream'
                        phase = 'Thinking' if kind == 'thinking' else 'Receiving answer'
                        if self.phase != phase:
                            self.phase, self.phase_since = phase, time.monotonic()
                        if self.records and self.records[-1][1] == kind:
                            stamp, _, before = self.records.pop()
                            text = before[len(label) + 1:] + text
                        if len(text) > 12000:
                            text = '[earlier trace text omitted]\n' + text[-11900:]
                        self.records.append((stamp, kind, label + '\n' + text))
                        self.revision += 1
                        if not self.interactive:
                            # Plain diagnostics retain the same bounded coalesced
                            # deltas, without printing the accumulated row again.
                            self._print(f'[{stamp}] {label}: {delta}')
            except (OSError, ValueError):
                self.trace = None
                self.trace_failed = True
                self.event('note', text='Model trace unavailable: private-file checks failed.')

    def log(self, *parts):
        text = ' '.join(map(str, parts))
        kind = 'error' if parts and ('failed' in str(parts[0]) or 'unavailable' in str(parts[0])) else 'note'
        self.event(kind, text=text)

    def pending(self):
        try:
            return self.inputs.get_nowait()
        except queue.Empty:
            return None

    def clear(self):
        with self.lock:
            self.records.clear()
            self.revision += 1

    def _screen(self):
        try:
            import curses
            curses.wrapper(self._run_screen)
        except Exception:
            # A missing terminfo/curses installation must not stop the agent loop.
            self.interactive = False
            self.ready.set()
            self._print('Interactive terminal unavailable; using plain harness diagnostics.')
            self._print(self.summary())

    def _run_screen(self, screen):
        import curses
        curses.noecho()
        curses.cbreak()
        screen.keypad(True)
        screen.timeout(100)
        colors = False
        try:
            curses.start_color()
            curses.use_default_colors()
            for i, color in enumerate((curses.COLOR_CYAN, curses.COLOR_GREEN, curses.COLOR_YELLOW, curses.COLOR_RED), 1):
                curses.init_pair(i, color, -1)
            colors = True
        except curses.error:
            pass
        self.ready.set()
        text, cursor, scroll = '', 0, 0
        cached, cache_key = [], None
        while not self.closed.is_set():
            height, width = screen.getmaxyx()
            width = max(1, width - 1)
            with self.lock:
                key = (self.revision, width)
                if key != cache_key:
                    cached = []
                    for stamp, kind, body in self.records:
                        for line in ('[' + stamp + '] ' + body).splitlines():
                            for wrapped in textwrap.wrap(line, max(1, width), replace_whitespace=False) or ['']:
                                cached.append((wrapped, kind))
                    cache_key = key
                phase = self.phase
                elapsed = time.monotonic() - self.phase_since
                status = f'{phase} ({elapsed:.1f}s) | last poll {self.last_poll} UTC | rooms {self.room_count} | errors {self.errors}'
                title = self.clean(f"Reverie Harness | {self.cfg['self_name']} | configured: {self.cfg['model']} | PID {os.getpid()}")
                endpoint = f'{self.endpoint()} | API model: {self.api_model}'
            screen.erase()

            def put(row, value, style=0):
                if 0 <= row < height:
                    try:
                        screen.addnstr(row, 0, self.clean(value), width, style)
                    except curses.error:
                        pass  # narrow terminal / wide Unicode at the right edge

            put(0, title, curses.A_BOLD)
            put(1, endpoint, curses.color_pair(1) if colors else 0)
            put(2, status)
            rows = max(0, height - 6)
            scroll = min(scroll, max(0, len(cached) - rows))
            end = max(0, len(cached) - scroll)
            start = max(0, end - rows)
            for row, (line, kind) in enumerate(cached[start:end], 3):
                color = 4 if kind == 'error' else 2 if kind in ('reply', 'local_reply') else 0
                put(row, line, curses.color_pair(color) if colors and color else 0)
            put(height - 3, f'Local prompt | queued {self.inputs.qsize()} | /help /status /clear /quit | PgUp/PgDn scroll')
            visible = max(1, width - 2)
            left = max(0, cursor - visible + 1)
            put(height - 2, '> ' + text[left:left + visible])
            put(height - 1, 'Terminal prompts stay here; room replies appear above.' + (' [SCROLLED]' if scroll else ''))
            try:
                screen.move(max(0, height - 2), min(max(0, width - 1), 2 + cursor - left))
                screen.refresh()
                key = screen.get_wch()
            except curses.error:
                continue
            if key in ('\n', '\r', curses.KEY_ENTER):
                if text.strip():
                    try:
                        self.inputs.put_nowait(text.strip())
                        text, cursor, scroll = '', 0, 0
                    except queue.Full:
                        self.event('note', text='Input queue full; wait for the current reply.')
            elif key in (curses.KEY_BACKSPACE, '\b', '\x7f'):
                if cursor:
                    text, cursor = text[:cursor - 1] + text[cursor:], cursor - 1
            elif key == curses.KEY_DC:
                text = text[:cursor] + text[cursor + 1:]
            elif key == curses.KEY_LEFT:
                cursor = max(0, cursor - 1)
            elif key == curses.KEY_RIGHT:
                cursor = min(len(text), cursor + 1)
            elif key == curses.KEY_HOME:
                cursor = 0
            elif key == curses.KEY_END:
                cursor, scroll = len(text), 0
            elif key == curses.KEY_PPAGE:
                scroll += max(1, rows // 2)
            elif key == curses.KEY_NPAGE:
                scroll = max(0, scroll - max(1, rows // 2))
            elif key == '\x15':
                text, cursor = '', 0
            elif isinstance(key, str) and key.isprintable() and len(text) < self.cfg['message_cap_chars']:
                text = text[:cursor] + key + text[cursor:]
                cursor += len(key)
