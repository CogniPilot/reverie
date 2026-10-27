"""Fixed nonroot lease acceptance helper, injected only by the trusted broker.

Self contained for already-running older laptop images. Its wire protocol accepts
no path, code, shell, argv, PID, mount or timing override. Only its own probe
fixtures are retired. Production entry uses the existing laptop home/tmp binds.
"""
import fcntl
import json
import math
import os
from pathlib import Path
import select
import stat
import struct
import sys
import time
import uuid

MAX = 32768
HOLD_SECONDS = 600
REFUSAL_SECONDS = 5


def require(ok, why):
    if not ok:
        raise ValueError(why)


def key(info):
    return f'{info.st_dev}-{info.st_ino}'


def read_exact(size, deadline):
    value = bytearray()
    while len(value) < size:
        remaining = deadline - time.monotonic()
        require(remaining > 0 and select.select([sys.stdin.buffer], [], [], remaining)[0], 'helper deadline elapsed')
        data = os.read(sys.stdin.fileno(), size - len(value))
        require(data, 'helper controller disconnected')
        value.extend(data)
    return bytes(value)


def receive(deadline):
    size = struct.unpack('!I', read_exact(4, deadline))[0]
    require(0 < size <= MAX, 'message too large')
    def unique(items):
        out = {}
        for name, value in items:
            require(name not in out, 'duplicate field')
            out[name] = value
        return out
    return json.loads(read_exact(size, deadline), object_pairs_hook=unique)


def reply(value):
    data = json.dumps(value, sort_keys=True, allow_nan=False).encode()
    require(len(data) <= MAX, 'reply too large')
    sys.stdout.buffer.write(struct.pack('!I', len(data)) + data)
    sys.stdout.buffer.flush()


def directory(path):
    require(path.is_absolute() and path.anchor == '/' and os.path.normpath(str(path)) == str(path), 'canonical directory required')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for name in path.parts[1:]:
            new = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            os.close(fd)
            fd = new
        require(os.fstat(fd).st_uid == os.geteuid(), 'directory owner differs')
        return fd
    except BaseException:
        os.close(fd)
        raise


def create_directory(parent, name):
    os.mkdir(name, mode=0o700, dir_fd=parent)
    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
    require(os.fstat(fd).st_uid == os.geteuid(), 'fixture owner differs')
    return fd


def opened(parent, name, *, create=False):
    fd = os.open(name, os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC | (os.O_CREAT if create else 0), 0o600, dir_fd=parent)
    try:
        require(stat.S_ISREG(os.fstat(fd).st_mode) and os.fstat(fd).st_uid == os.geteuid(), 'private owned regular lock required')
        return fd
    except BaseException:
        os.close(fd)
        raise


def run(home=Path('/home/agent'), temporary=Path('/tmp')):
    require(os.geteuid() != 0, 'helper must run as the existing nonroot laptop user')
    start = receive(time.monotonic() + 10)
    require(isinstance(start, dict) and set(start) == {'version', 'attemptId', 'nonce', 'leaseSubdirectory', 'expiresAt'}, 'invalid prepare envelope')
    attempt, nonce = start['attemptId'], start['nonce']
    require(start['version'] == 1 and isinstance(attempt, str) and str(uuid.UUID(attempt)) == attempt, 'invalid attempt')
    require(isinstance(nonce, str) and len(nonce) == 64 and all(c in '0123456789abcdef' for c in nonce), 'invalid nonce')
    subdir = start['leaseSubdirectory']
    require(isinstance(subdir, str) and subdir and not Path(subdir).is_absolute() and os.path.normpath(subdir) == subdir and '..' not in Path(subdir).parts, 'invalid lease subdirectory')
    expiry = start['expiresAt']
    require(type(expiry) in (int, float) and math.isfinite(expiry) and 75 <= expiry - time.time() <= HOLD_SECONDS, 'invalid bounded expiry')
    deadline = time.monotonic() + min(HOLD_SECONDS, expiry - time.time())
    fds, owned = [], []
    def keep(fd):
        fds.append(fd)
        return fd
    leases = keep(directory(home / subdir))
    temp = keep(directory(temporary))
    fixture_name = '.reverie-lease-gate-' + attempt
    lease_name = '.acceptance-' + attempt
    held_key = reserved_key = None
    root_barrier_key = None
    try:
        fixture = keep(create_directory(temp, fixture_name)); owned.append((temp, fixture_name, key(os.fstat(fixture))))
        held = keep(create_directory(fixture, 'held'));owned.append((fixture,'held',key(os.fstat(held))))
        reserved = keep(create_directory(fixture, 'reserved'));owned.append((fixture,'reserved',key(os.fstat(reserved))))
        lease_fixture = keep(create_directory(leases, lease_name)); owned.append((leases, lease_name, key(os.fstat(lease_fixture))))
        held_key, reserved_key = key(os.fstat(held)), key(os.fstat(reserved))
        barrier = keep(opened(leases, 'barrier.lock', create=True))
        fcntl.flock(barrier, fcntl.LOCK_SH | fcntl.LOCK_NB)
        held_lock = keep(opened(leases, held_key + '.lock', create=True)); fcntl.flock(held_lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
        probe_name = 'acceptance-' + attempt + '.probe.lock'
        probe_fd = os.open(probe_name, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=leases)
        keep(probe_fd); fcntl.flock(probe_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        reservation_name = reserved_key + '.reserve.json'
        reservation = {'version': 1, 'path': str(temporary / fixture_name / 'reserved'), 'created_utc': time.time(), 'until_utc': expiry}
        reserve_fd = os.open(reservation_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=leases)
        with os.fdopen(reserve_fd, 'wb') as stream:
            stream.write(json.dumps(reservation).encode()); stream.flush(); os.fsync(stream.fileno())
        reservation_inode = key(os.stat(reservation_name, dir_fd=leases, follow_symlinks=False))
        fcntl.flock(barrier, fcntl.LOCK_UN)
        probe = {'heldKey': held_key, 'reservedKey': reserved_key, 'barrierKey': key(os.fstat(barrier)), 'probeKey': key(os.fstat(probe_fd)), 'leaseFixtureKey': key(os.fstat(lease_fixture)), 'tmpFixtureKey': key(os.fstat(fixture))}
        reply({'status': 'PREPARED', 'attemptId': attempt, 'nonce': nonce, 'probe': probe, 'uid': os.geteuid(), 'gid': os.getegid()})
        state = 'prepared'
        while True:
            request = receive(deadline)
            require(isinstance(request, dict) and set(request) == {'version', 'method', 'attemptId', 'nonce'} and request['version'] == 1 and request['attemptId'] == attempt and request['nonce'] == nonce, 'invalid control envelope')
            method = request['method']
            if method == 'retireOwn':
                break
            require((state, method) in (('prepared', 'during'), ('during', 'after')), 'control out of order')
            root_barrier = keep(opened(lease_fixture, 'barrier.lock'))
            info = os.fstat(root_barrier)
            root_barrier_key = key(info)
            require(stat.S_IMODE(info.st_mode) == 0o600, 'root fixture mode differs')
            fcntl.flock(root_barrier, fcntl.LOCK_SH | fcntl.LOCK_NB); fcntl.flock(root_barrier, fcntl.LOCK_UN)
            before = time.monotonic()
            if method == 'during':
                end = before + REFUSAL_SECONDS
                while True:
                    try:
                        fcntl.flock(barrier, fcntl.LOCK_SH | fcntl.LOCK_NB)
                    except BlockingIOError:
                        if time.monotonic() >= end:
                            break
                        time.sleep(0.025)
                    else:
                        fcntl.flock(barrier, fcntl.LOCK_UN)
                        raise ValueError('persistent barrier unexpectedly acquired during host hold')
                result = 'REFUSED'
            else:
                fcntl.flock(barrier, fcntl.LOCK_SH | fcntl.LOCK_NB)
                fcntl.flock(barrier, fcntl.LOCK_UN)
                result = 'ACQUIRED'
            require(key(os.stat('barrier.lock', dir_fd=leases, follow_symlinks=False)) == probe['barrierKey'], 'persistent barrier replaced')
            require(key(os.stat('barrier.lock', dir_fd=lease_fixture, follow_symlinks=False)) == key(info), 'root fixture barrier replaced')
            reply({'status': result, 'phase': method, 'attemptId': attempt, 'nonce': nonce, 'durationSeconds': time.monotonic() - before,
                   'barrierKey': probe['barrierKey'], 'rootBarrierKey': key(info), 'rootBarrierUid': info.st_uid, 'rootBarrierGid': info.st_gid, 'rootBarrierMode': stat.S_IMODE(info.st_mode), 'uid': os.geteuid()})
            state = method
        # A retire reply is published only after cleanup; the finally block below owns the actual effects.
    finally:
        # Constant-size retirement only. Unexpected entries are preserved and reported unconfirmed.
        errors=[]
        known=[]
        if reserved_key is not None and 'reservation_inode' in locals():known.append((leases,reservation_name,reservation_inode))
        if 'probe_name' in locals():known.append((leases,probe_name,key(os.fstat(probe_fd))))
        if root_barrier_key is not None:known.append((lease_fixture,'barrier.lock',root_barrier_key))
        try:
            for parent,name,expected in known:
                try:
                    require(key(os.stat(name,dir_fd=parent,follow_symlinks=False))==expected,'owned file replaced during retirement')
                    os.unlink(name,dir_fd=parent)
                except (OSError,ValueError) as error:errors.append(error.__class__.__name__)
            for parent,name,expected in reversed(owned):
                try:
                    require(key(os.stat(name,dir_fd=parent,follow_symlinks=False))==expected,'owned directory replaced during retirement')
                    os.rmdir(name,dir_fd=parent)
                except (OSError,ValueError) as error:errors.append(error.__class__.__name__)
        finally:
            for fd in reversed(fds):
                try:os.close(fd)
                except OSError:pass
        require(not errors,'owned probe cleanup unconfirmed')
    reply({'status': 'RETIRED', 'attemptId': attempt, 'nonce': nonce, 'cleanupComplete': True})


if __name__ == '__main__':
    try:
        run()
    except (ValueError, OSError, EOFError) as error:
        try:
            reply({'status': 'FAILED', 'error': error.__class__.__name__})
        except (OSError, ValueError):
            pass
        raise SystemExit(2)
