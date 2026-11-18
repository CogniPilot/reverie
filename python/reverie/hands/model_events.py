"""Opt-in, owner-private display events. These are never chat or task instructions."""
import fcntl
import json
import os
from pathlib import Path
import re
import stat

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


def private_open(path):
    path = Path(path)
    if not path.is_absolute() or path.parent.resolve() != path.parent:
        raise ValueError('trace requires an absolute nonsymlink directory')
    parent = path.parent.stat()
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.getuid() or parent.st_mode & 0o077:
        raise ValueError('trace directory must be private and owned')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    info = os.fstat(fd)
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or
            stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1 or info.st_size > TRACE_BYTES):
        os.close(fd)
        raise ValueError('trace must be an owned 0600 regular file, at most 4MiB')
    return fd


class TraceReader:
    def __init__(self, path, *, from_end=True):
        self.path = Path(path)
        self.offset, self.identity, self.generation = 0, None, None
        try:
            fd = private_open(self.path)
        except FileNotFoundError:
            return
        with os.fdopen(fd, 'rb') as stream:
            info = os.fstat(stream.fileno())
            self.identity = (info.st_dev, info.st_ino)
            self.generation = stream.readline(512)
            self.offset = info.st_size if from_end else 0

    def poll(self):
        try:
            fd = private_open(self.path)
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
