"""Bounded local image files from a scoped, authenticated attachment reader.

The transport supplies ``fetch`` and ``current``; neither URLs, uploader names,
server filesystem paths nor credentials are accepted in a materialization request.
This component does not start laptops, acknowledge messages or type into panes.
"""
from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
import os
from pathlib import Path
import re
import stat
import threading
import time
import uuid

UUID = re.compile(r'[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\Z')
MAX_FILES = 4
MAX_FILE_BYTES = 8 * 1024 * 1024
MAX_REQUEST_BYTES = 16 * 1024 * 1024
MAX_CACHE_BYTES = 64 * 1024 * 1024
MAX_CACHE_FILES = 32
LIFETIME_SECONDS = 1800


class ImagePathRefused(ValueError):
    """Closed refusal category, without transport or private-path error text."""


def request(value):
    if (type(value) is not dict or set(value) != {'version', 'sessionId', 'roomId', 'messageId', 'generation', 'fileIds'}
            or type(value['version']) is not int or value['version'] != 1):
        raise ImagePathRefused('invalid_request')
    for name in ('sessionId', 'roomId', 'messageId'):
        if type(value[name]) is not str or not UUID.fullmatch(value[name]):
            raise ImagePathRefused('invalid_identity')
    if type(value['generation']) is not str or not re.fullmatch('[0-9a-f]{64}', value['generation']):
        raise ImagePathRefused('invalid_generation')
    ids = value['fileIds']
    if (type(ids) is not list or not 1 <= len(ids) <= MAX_FILES
            or any(type(item) is not str or not UUID.fullmatch(item) for item in ids)
            or len(set(ids)) != len(ids)):
        raise ImagePathRefused('invalid_files')
    return {**value, 'fileIds': tuple(ids)}


def image_extension(data):
    """Detect supported raster signatures; never infer a suffix from a name/MIME."""
    if type(data) is not bytes or not data or len(data) > MAX_FILE_BYTES:
        raise ImagePathRefused('invalid_bytes')
    if data.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'png'
    if data.startswith(b'\xff\xd8\xff'):
        return 'jpg'
    if data[:6] in (b'GIF87a', b'GIF89a'):
        return 'gif'
    if len(data) >= 12 and data[:4] == b'RIFF' and data[8:12] == b'WEBP':
        return 'webp'
    raise ImagePathRefused('unsupported_image')


def directory(path):
    """Open one private directory using descriptor-relative, no-follow traversal.

    Existing ancestors may be ordinary owned or system directories. The selected
    cache itself must be owned by the current uid and mode 0700. No chmod/repair.
    """
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts:
        raise ImagePathRefused('unsafe_cache')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for part in path.parts[1:]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            os.close(fd)
            fd = child
        info = os.fstat(fd)
        if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise ImagePathRefused('unsafe_cache')
        return fd
    except BaseException:
        os.close(fd)
        raise


@dataclass(frozen=True)
class _Entry:
    name: str
    inode: tuple
    size: int
    deadline: float
    digest: str


class ImagePaths:
    """An owned service-lifetime cache. Caller closes it when its binding ends.

    ``fetch(scope, file_id, max_bytes)`` must freshly check membership, exact
    message/file linkage and current binding, including for repeated requests.
    No cache hit can bypass it. ``current(scope)`` is rechecked after I/O and
    before returning paths. Only a running owner may expose READY results.
    """

    def __init__(self, root, public_root, fetch, current, *, clock=time.monotonic, checkpoint=None, close_hook=None):
        self.root = Path(root)
        self.public_root = Path(public_root)
        if not self.public_root.is_absolute() or '..' in self.public_root.parts:
            raise ImagePathRefused('unsafe_cache')
        self.fd = directory(self.root)
        # Never adopt unknown files or a previous process's apparent cache hits.
        if os.listdir(self.fd):
            os.close(self.fd)
            raise ImagePathRefused('cache_not_empty')
        self.fetch, self.current, self.clock = fetch, current, clock
        self.entries = {}
        self.persist = checkpoint or (lambda entries: None)
        self.close_hook = close_hook or (lambda: None)
        self.lock = threading.Lock()
        self.admission = threading.BoundedSemaphore(1)
        self.stopped = threading.Event()
        self.failed = False
        try:
            self.thread = threading.Thread(target=self._reap, name='chat-image-expiry', daemon=True)
            self.thread.start()
        except BaseException:
            self.stopped.set()
            thread = getattr(self, 'thread', None)
            if thread is not None and thread.is_alive():
                thread.join(timeout=2)
            os.close(self.fd)
            self.fd = -1
            self.close_hook()
            raise

    def _check(self, scope):
        if self.stopped.is_set() or self.failed or not self.thread.is_alive():
            raise ImagePathRefused('cache_unavailable')
        try:
            current = self.current(scope)
        except Exception:
            current = False
        if current is not True:
            raise ImagePathRefused('binding_changed')
        # Detect directory replacement rather than exposing an alias to another tree.
        fd = directory(self.root)
        try:
            if (os.fstat(fd).st_dev, os.fstat(fd).st_ino) != (os.fstat(self.fd).st_dev, os.fstat(self.fd).st_ino):
                raise ImagePathRefused('cache_changed')
        finally:
            os.close(fd)

    def _checkpoint(self):
        try:
            self.persist(tuple(self.entries.values()))
        except Exception:
            self.failed = True
            raise ImagePathRefused('custody_unconfirmed') from None

    def _remove(self, entry):
        try:
            info = os.stat(entry.name, dir_fd=self.fd, follow_symlinks=False)
        except FileNotFoundError:
            self.entries.pop(entry.name, None)
            self._checkpoint()
            return
        if ((info.st_dev, info.st_ino) != entry.inode or not stat.S_ISREG(info.st_mode)
                or info.st_uid != os.getuid() or info.st_nlink != 1):
            self.failed = True
            raise ImagePathRefused('cache_changed')
        os.unlink(entry.name, dir_fd=self.fd)
        self.entries.pop(entry.name, None)
        self._checkpoint()

    def _verify(self, entry):
        fd = os.open(entry.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=self.fd)
        try:
            before = os.fstat(fd)
            if ((before.st_dev, before.st_ino) != entry.inode or not stat.S_ISREG(before.st_mode)
                    or before.st_uid != os.getuid() or before.st_nlink != 1
                    or stat.S_IMODE(before.st_mode) != 0o600 or before.st_size != entry.size):
                raise ImagePathRefused('write_unconfirmed')
            with os.fdopen(fd, 'rb', closefd=False) as stream:
                data = stream.read(entry.size + 1)
            after = os.fstat(fd)
            if (len(data) != entry.size or hashlib.sha256(data).hexdigest() != entry.digest or
                    (before.st_mtime_ns, before.st_ctime_ns) != (after.st_mtime_ns, after.st_ctime_ns)):
                raise ImagePathRefused('write_unconfirmed')
        finally:
            os.close(fd)

    def expire(self):
        with self.lock:
            for entry in tuple(self.entries.values()):
                if self.clock() >= entry.deadline:
                    self._remove(entry)

    def _reap(self):
        while not self.stopped.wait(0.5):
            try:
                self.expire()
            except Exception:
                self.failed = True
                return

    @contextmanager
    def _claim(self):
        if not self.admission.acquire(blocking=False):
            raise ImagePathRefused('busy')
        try:
            yield
        finally:
            self.admission.release()

    def materialize(self, value):
        scope = request(value)
        made = []
        with self._claim():
            try:
                self._check(scope)
                self.expire()
                total = 0
                results = []
                for file_id in scope['fileIds']:
                    self._check(scope)
                    # This callback is the ordinary authenticated API reader, not
                    # filesystem access to the shared attachment backing store.
                    data = self.fetch(scope, file_id, MAX_FILE_BYTES)
                    extension = image_extension(data)
                    total += len(data)
                    if total > MAX_REQUEST_BYTES:
                        raise ImagePathRefused('request_limit')
                    self._check(scope)
                    with self.lock:
                        if (len(self.entries) >= MAX_CACHE_FILES or
                                sum(entry.size for entry in self.entries.values()) + len(data) > MAX_CACHE_BYTES):
                            raise ImagePathRefused('cache_limit')
                        name = f'{uuid.uuid4()}.{extension}'
                        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                                     0o600, dir_fd=self.fd)
                        info = os.fstat(fd)
                        entry = _Entry(name, (info.st_dev, info.st_ino), len(data),
                                       self.clock() + LIFETIME_SECONDS, hashlib.sha256(data).hexdigest())
                        self.entries[name] = entry
                        made.append(entry)
                        try:
                            with os.fdopen(fd, 'wb', closefd=False) as output:
                                output.write(data)
                                output.flush()
                                os.fsync(fd)
                            finished = os.fstat(fd)
                            if (finished.st_size != len(data) or finished.st_nlink != 1 or
                                    stat.S_IMODE(finished.st_mode) != 0o600):
                                raise ImagePathRefused('write_unconfirmed')
                        finally:
                            os.close(fd)
                        self._verify(entry)
                        self._checkpoint()
                        results.append({'fileId': file_id, 'path': str(self.public_root / name),
                                        'bytes': len(data), 'expiresInSeconds': LIFETIME_SECONDS})
                self._check(scope)
                with self.lock:
                    for entry in made:
                        self._verify(entry)
                        if self.clock() >= entry.deadline:
                            raise ImagePathRefused('expired')
                for item, entry in zip(results, made):
                    item['expiresInSeconds'] = max(1, int(entry.deadline - self.clock()))
                return {'version': 1, 'status': 'ready', 'generation': scope['generation'], 'sessionId': scope['sessionId'],
                        'roomId': scope['roomId'], 'messageId': scope['messageId'], 'files': results}
            except BaseException:
                with self.lock:
                    for entry in made:
                        self._remove(entry)
                raise

    def retire(self):
        """End this generation without deleting retained/replaced scratch data.

        The committed custody record survives. Its next owner reconciles the
        same directory or preserves that record when a new empty cache appears.
        """
        if self.fd < 0:
            return
        with self._claim():
            self.stopped.set()
            self.thread.join(timeout=2)
            if self.thread.is_alive():
                raise ImagePathRefused('expiry_unsettled')
            os.close(self.fd)
            self.fd = -1
            self.close_hook()

    def close(self):
        if self.fd < 0:
            return
        # The owner first settles active calls; no cleanup races with a producer.
        with self._claim():
            self.stopped.set()
            self.thread.join(timeout=2)
            if self.thread.is_alive():
                raise ImagePathRefused('expiry_unsettled')
            with self.lock:
                for entry in tuple(self.entries.values()):
                    self._remove(entry)
            os.close(self.fd)
            self.fd = -1
            self.close_hook()
