"""Private host-side custody for regenerable laptop image copies.

The ledger and held lock live beside employee storage, outside the laptop's
home and scratch binds. A restart removes only files whose directory identity,
inode, size, mode and hash match the last committed custody record. Unknown or
modified data refuses reconciliation; nothing is inferred disposable by name.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import uuid

from .chat_image_paths import ImagePathRefused, MAX_CACHE_FILES, MAX_FILE_BYTES, directory

NAME = '.chat-image-custody.json'
LOCK = '.chat-image-custody.lock'
IMAGE = re.compile(r'[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.(?:png|jpg|gif|webp)\Z')


def identity(info):
    return [info.st_dev, info.st_ino]


def private_file(info, limit):
    return (stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_nlink == 1
            and stat.S_IMODE(info.st_mode) == 0o600 and info.st_size <= limit)


class ImageCacheCustody:
    def __init__(self, state_root, cache_root):
        self.state_root, self.cache_root = Path(state_root), Path(cache_root)
        self.fd = directory(self.state_root)
        self.lock_fd = None
        try:
            self.lock_fd = os.open(LOCK, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=self.fd)
            if not private_file(os.fstat(self.lock_fd), 0):
                raise ImagePathRefused('custody_unavailable')
            try:
                fcntl.flock(self.lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                raise ImagePathRefused('custody_busy') from None
            self.state_identity = identity(os.fstat(self.fd))
            cache = directory(self.cache_root)
            try:
                self.cache_identity = identity(os.fstat(cache))
            finally:
                os.close(cache)
        except BaseException:
            self.close()
            raise

    def _current(self):
        for path, expected in ((self.state_root, self.state_identity), (self.cache_root, self.cache_identity)):
            fd = directory(path)
            try:
                if identity(os.fstat(fd)) != expected:
                    raise ImagePathRefused('custody_changed')
            finally:
                os.close(fd)

    def _read(self):
        try:
            fd = os.open(NAME, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=self.fd)
        except FileNotFoundError:
            return None
        try:
            if not private_file(os.fstat(fd), 65536):
                raise ImagePathRefused('custody_unavailable')
            raw = os.read(fd, 65537)
        finally:
            os.close(fd)
        try:
            def unique(items):
                result = {}
                for key, item in items:
                    if key in result:
                        raise ValueError('duplicate')
                    result[key] = item
                return result
            value = json.loads(raw, object_pairs_hook=unique)
            if (type(value) is not dict or set(value) != {'version', 'cache', 'entries'}
                    or type(value['version']) is not int or value['version'] != 1
                    or type(value['cache']) is not list or len(value['cache']) != 2
                    or any(type(number) is not int or number < 0 for number in value['cache'])
                    or type(value['entries']) is not list
                    or len(value['entries']) > MAX_CACHE_FILES):
                raise ValueError('shape')
            names = set()
            for entry in value['entries']:
                if (type(entry) is not dict or set(entry) != {'name', 'inode', 'size', 'sha256'}
                        or type(entry['name']) is not str or not IMAGE.fullmatch(entry['name'])
                        or entry['name'] in names or type(entry['inode']) is not list or len(entry['inode']) != 2
                        or any(type(number) is not int or number < 0 for number in entry['inode'])
                        or type(entry['size']) is not int or not 1 <= entry['size'] <= MAX_FILE_BYTES
                        or type(entry['sha256']) is not str or not re.fullmatch('[0-9a-f]{64}', entry['sha256'])):
                    raise ValueError('entry')
                names.add(entry['name'])
            return value, raw
        except (UnicodeError, ValueError, KeyError, TypeError):
            raise ImagePathRefused('custody_unavailable') from None

    def recover(self):
        self._current()
        fd = directory(self.cache_root)
        try:
            record = self._read()
            files = set(os.listdir(fd))
            if record is None:
                if files:
                    raise ImagePathRefused('cache_not_empty')
                return
            value, raw = record
            entries = value['entries']
            if value['cache'] != self.cache_identity:
                if files:
                    raise ImagePathRefused('cache_not_empty')
                # Scratch may have been retained/replaced or wiped. Preserve its
                # old ownership record; never chase or clean another directory.
                if entries:
                    self._retain(raw)
                self.checkpoint(())
                return
            known = {entry['name'] for entry in entries}
            if files - known:
                raise ImagePathRefused('cache_not_empty')
            checked = []
            # Validate the complete set before removing any recorded file.
            for entry in entries:
                if entry['name'] not in files:
                    continue
                image = os.open(entry['name'], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=fd)
                try:
                    before = os.fstat(image)
                    if (not private_file(before, MAX_FILE_BYTES) or identity(before) != entry['inode']
                            or before.st_size != entry['size']):
                        raise ImagePathRefused('custody_changed')
                    digest = hashlib.sha256()
                    size = 0
                    while chunk := os.read(image, 65536):
                        size += len(chunk)
                        if size > entry['size']:
                            raise ImagePathRefused('custody_changed')
                        digest.update(chunk)
                    after = os.fstat(image)
                    if (digest.hexdigest() != entry['sha256'] or size != entry['size'] or
                            (before.st_mtime_ns, before.st_ctime_ns) != (after.st_mtime_ns, after.st_ctime_ns)):
                        raise ImagePathRefused('custody_changed')
                    checked.append(entry)
                finally:
                    os.close(image)
            self._current()
            for entry in checked:
                info = os.stat(entry['name'], dir_fd=fd, follow_symlinks=False)
                if identity(info) != entry['inode'] or not private_file(info, MAX_FILE_BYTES):
                    raise ImagePathRefused('custody_changed')
                os.unlink(entry['name'], dir_fd=fd)
            os.fsync(fd)
            self.checkpoint(())
        finally:
            os.close(fd)

    def _retain(self, raw):
        retained = [name for name in os.listdir(self.fd) if name.startswith('.chat-image-custody-retained-')]
        if len(retained) >= 16:
            raise ImagePathRefused('custody_retention_limit')
        name = '.chat-image-custody-retained-' + str(uuid.uuid4()) + '.json'
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=self.fd)
        try:
            with os.fdopen(fd, 'wb', closefd=False) as output:
                output.write(raw)
                output.flush()
                os.fsync(fd)
            os.fsync(self.fd)
        finally:
            os.close(fd)

    def checkpoint(self, entries):
        self._current()
        value = {'version': 1, 'cache': self.cache_identity, 'entries': [
            {'name': entry.name, 'inode': list(entry.inode), 'size': entry.size, 'sha256': entry.digest}
            for entry in entries]}
        raw = json.dumps(value, sort_keys=True, separators=(',', ':')).encode()
        if len(raw) > 65536 or len(value['entries']) > MAX_CACHE_FILES:
            raise ImagePathRefused('custody_limit')
        temporary = '.chat-image-custody-' + str(uuid.uuid4()) + '.tmp'
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=self.fd)
        try:
            with os.fdopen(fd, 'wb', closefd=False) as output:
                output.write(raw)
                output.flush()
                os.fsync(fd)
            os.replace(temporary, NAME, src_dir_fd=self.fd, dst_dir_fd=self.fd)
            os.fsync(self.fd)
        finally:
            os.close(fd)
            try:
                os.unlink(temporary, dir_fd=self.fd)
            except FileNotFoundError:
                pass

    def close(self):
        if self.lock_fd is not None:
            os.close(self.lock_fd)
            self.lock_fd = None
        if self.fd >= 0:
            os.close(self.fd)
            self.fd = -1
