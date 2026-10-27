"""Private Goal filesystem checks, never a custody proof without current mount inspection.

Only explicit operator paths enter this module. No discovery, initializer, chmod,
key generation, grants, credentials in diagnostics or permissive fallback.
"""
import hashlib
import json
import os
from pathlib import Path
import stat


def absolute(value):
    if not isinstance(value, str) or not value.startswith('/') or value == '/' or any(c in value for c in '\0\r\n'):
        raise ValueError('Private Goal configuration unavailable')
    path = Path(value)
    if str(path) != value or '..' in path.parts:
        raise ValueError('Private Goal configuration unavailable')
    return path


def overlaps(left, right):
    return left.is_relative_to(right) or right.is_relative_to(left)


def fingerprint(info):
    return [str(info.st_dev), str(info.st_ino), str(info.st_size), str(info.st_mtime_ns), str(info.st_ctime_ns)]


class PrivateBatch:
    """One synchronous projection only: shared anchored FDs, never cached authority."""
    def __enter__(self):
        self.root = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
        self.descriptors, self.entries, self.directories, self.absent = [self.root], [], {}, []
        return self

    def __exit__(self, kind, value, traceback):
        try:
            if kind is None:
                check_entries(self.entries)
                for path in self.absent:
                    try:
                        path.lstat()
                    except FileNotFoundError:
                        pass
                    else:
                        raise ValueError('Private Goal entry appeared during check')
        finally:
            for fd in reversed(self.descriptors): os.close(fd)


def check_entries(entries):
    for entry, issued in entries:
        fresh = entry.lstat()
        if stat.S_ISLNK(fresh.st_mode) or (fresh.st_dev, fresh.st_ino, fresh.st_uid, fresh.st_mode) != (issued.st_dev, issued.st_ino, issued.st_uid, issued.st_mode):
            raise ValueError('Private Goal ancestry changed')


def private_entry(value, *, uid=None, directory=False, absent=False, limit=None, _batch=None):
    """Anchored no-follow traversal plus fresh path/FD identity checks.

    Modes alone do not establish custody: callers must separately reject every
    configured and actually mounted worker exposure, including read-only aliases.
    """
    uid = os.getuid() if uid is None else uid
    path = absolute(value)
    descriptors, entries = (_batch.descriptors, _batch.entries) if _batch else ([], [])
    current = Path('/')
    root = _batch.root if _batch else os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    if not _batch: descriptors.append(root)
    try:
        for component in path.parts[1:-1]:
            current /= component
            if _batch and current in _batch.directories:
                root = _batch.directories[current]
                continue
            root = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root)
            descriptors.append(root)
            info = os.fstat(root)
            sticky_root = info.st_uid == 0 and info.st_mode & stat.S_ISVTX
            if info.st_uid not in (0, uid) or (info.st_mode & 0o022 and not sticky_root):
                raise ValueError('Private Goal ancestry unavailable')
            entries.append((current, info))
            if _batch: _batch.directories[current] = root
        parent = os.fstat(root)
        if parent.st_uid != uid or parent.st_mode & 0o077:
            raise ValueError('Private Goal parent unavailable')
        flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | (os.O_DIRECTORY if directory else 0)
        try:
            fd = os.open(path.name, flags, dir_fd=root)
        except FileNotFoundError:
            if not absent:
                raise
            fd = None
        if fd is None:
            result = (None, None)
        else:
            descriptors.append(fd)
            info = os.fstat(fd)
            expected_kind = stat.S_ISDIR if directory else stat.S_ISREG
            if not expected_kind(info.st_mode) or info.st_uid != uid or info.st_mode & 0o077 or (not directory and info.st_nlink != 1):
                raise ValueError('Private Goal entry unavailable')
            entries.append((path, info))
            data = None
            if limit is not None:
                if directory or info.st_size > limit:
                    raise ValueError('Private Goal entry exceeds bound')
                data = bytearray()
                while len(data) <= limit:
                    chunk = os.read(fd, min(65536, limit + 1 - len(data)))
                    if not chunk:
                        break
                    data.extend(chunk)
                if len(data) > limit or fingerprint(os.fstat(fd)) != fingerprint(info):
                    raise ValueError('Private Goal entry changed during read')
                data = bytes(data)
            result = (fingerprint(info), data)
        if not _batch: check_entries(entries)
        if fd is None:
            if _batch: _batch.absent.append(path)
            try:
                path.lstat()
            except FileNotFoundError:
                pass
            else:
                raise ValueError('Private Goal entry appeared during check')
        return result
    finally:
        if not _batch:
            for fd in reversed(descriptors): os.close(fd)


def private_json(value, *, limit=65536):
    identity, raw = private_entry(value, limit=limit)
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError('Private Goal record unavailable')
    return data, hashlib.sha256(raw).hexdigest(), identity


def assert_unexposed(paths, exposed_roots):
    if not isinstance(exposed_roots, list) or not exposed_roots:
        raise ValueError('Current Goal mount inventory unavailable')
    roots = [(absolute(value), absolute(value).resolve(strict=True)) for value in dict.fromkeys(exposed_roots)]
    for value in dict.fromkeys(paths):
        target = absolute(value)
        real = target.resolve(strict=False)
        for root, resolved in roots:
            if any(overlaps(a, b) for a in (target, real) for b in (root, resolved)):
                raise ValueError('Private Goal scope exposed to a worker')
