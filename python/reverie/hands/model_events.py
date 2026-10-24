"""Opt-in, owner-private display events. These are never chat or task instructions."""
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import uuid

TRACE_BYTES = 4 * 1024 * 1024
EVENT_CHARS = 4096
POLL_BYTES = 262144
CONTROLS = re.compile(r'[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]')
CREDENTIALS = re.compile(r'(?i)(?:bearer\s+|(?:api[_-]?key|password)["\']?\s*[=:]\s*["\']?|'
                         r'authorization["\']?\s*[=:]\s*["\']?(?:(?:bearer|basic)\s+)?)[^\s"\',;}]+')


def sanitize(text, secrets=()):
    for secret in secrets:
        if secret:
            text = text.replace(secret, '[redacted]')
    return CONTROLS.sub('', CREDENTIALS.sub('[redacted]', text))


def private_open(path, flags):
    path = Path(path)
    if not path.is_absolute() or path.parent.resolve() != path.parent:
        raise ValueError('trace requires an absolute nonsymlink directory')
    parent = path.parent.stat()
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.getuid() or parent.st_mode & 0o077:
        raise ValueError('trace directory must be private and owned')
    fd = os.open(path, flags | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    info = os.fstat(fd)
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or
            stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1 or info.st_size > TRACE_BYTES):
        os.close(fd)
        raise ValueError('trace must be an owned 0600 regular file, at most 4MiB')
    return fd


class TraceWriter:
    def __init__(self, path, *, secrets=(), max_bytes=TRACE_BYTES):
        if type(max_bytes) is not int or not 1024 <= max_bytes <= TRACE_BYTES:
            raise ValueError('invalid trace budget')
        self.path, self.max_bytes = Path(path), max_bytes
        self.secrets = tuple(value for value in secrets if isinstance(value, str) and value)
        if any(len(value) > 4096 for value in self.secrets):
            raise ValueError('invalid trace redaction key')
        self.keep = max((len(value) - 1 for value in self.secrets), default=0)
        self.pending = {'thinking': '', 'answer': ''}
        os.close(private_open(self.path, os.O_RDWR | os.O_CREAT | os.O_APPEND))

    def write(self, kind, text):
        if kind not in self.pending or not isinstance(text, str):
            raise ValueError('invalid display event')
        text = self.pending[kind] + text
        for secret in self.secrets:
            text = text.replace(secret, '[redacted]')
        ready = len(text) - min(len(text), self.keep)
        for match in CREDENTIALS.finditer(text):
            if match.start() < ready < match.end() or match.end() == len(text):
                ready = min(ready, match.start())
        self.pending[kind] = text[ready:]
        self._append(kind, sanitize(text[:ready], self.secrets))

    def flush(self):
        for kind, text in self.pending.items():
            self._append(kind, sanitize(text, self.secrets))
            self.pending[kind] = ''

    def _append(self, kind, text):
        if not text:
            return
        fd = private_open(self.path, os.O_RDWR | os.O_CREAT | os.O_APPEND)
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return  # Display is best effort; it never blocks the model deadline.
            chunk_chars = min(EVENT_CHARS, (self.max_bytes - 512) // 4)
            for offset in range(0, len(text), chunk_chars):
                raw = (json.dumps({'kind': kind, 'text': text[offset:offset + chunk_chars]},
                                  ensure_ascii=False) + '\n').encode('utf-8')
                if os.fstat(fd).st_size + len(raw) > self.max_bytes:
                    os.ftruncate(fd, 0)
                if os.fstat(fd).st_size == 0:
                    os.write(fd, (json.dumps({'reset': uuid.uuid4().hex}) + '\n').encode())
                view = memoryview(raw)
                while view:
                    view = view[os.write(fd, view):]
        finally:
            os.close(fd)


class TraceReader:
    def __init__(self, path, *, from_end=True):
        self.path = Path(path)
        self.offset, self.identity, self.generation = 0, None, None
        try:
            fd = private_open(self.path, os.O_RDONLY)
        except FileNotFoundError:
            return
        with os.fdopen(fd, 'rb') as stream:
            info = os.fstat(stream.fileno())
            self.identity = (info.st_dev, info.st_ino)
            self.generation = stream.readline(512)
            self.offset = info.st_size if from_end else 0

    def poll(self):
        try:
            fd = private_open(self.path, os.O_RDONLY)
        except FileNotFoundError:
            return []
        with os.fdopen(fd, 'rb') as stream:
            try:
                fcntl.flock(stream.fileno(), fcntl.LOCK_SH | fcntl.LOCK_NB)
            except BlockingIOError:
                return []
            info = os.fstat(stream.fileno())
            identity = (info.st_dev, info.st_ino)
            generation = stream.readline(512)
            if identity != self.identity or generation != self.generation or info.st_size < self.offset:
                self.offset = 0
            self.identity, self.generation = identity, generation
            stream.seek(self.offset)
            raw = stream.read(POLL_BYTES)
            complete = raw.rfind(b'\n') + 1
            self.offset += complete
            events = []
            for line in raw[:complete].splitlines():
                try:
                    item = json.loads(line)
                    if (isinstance(item, dict) and item.get('kind') in ('thinking', 'answer') and
                            isinstance(item.get('text'), str) and len(item['text']) <= EVENT_CHARS):
                        events.append({'kind': item['kind'], 'text': sanitize(item['text'])})
                except (ValueError, UnicodeError, RecursionError):
                    continue
            return events
