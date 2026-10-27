"""Bounded descriptor-based IO shared by the module's cleanup acceptance ports."""
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import stat
import struct
import time
import uuid

MAX_MESSAGE = 32768


class Refused(ValueError):
    pass


class Unconfirmed(RuntimeError):
    pass


def require(value, message):
    if not value:
        raise Refused(message)


def canonical_id(value):
    require(isinstance(value, str) and str(uuid.UUID(value)) == value, 'canonical UUID required')
    return value


def nonce(value):
    require(isinstance(value, str) and re.fullmatch('[a-f0-9]{64}', value), 'invalid attempt nonce')
    return value


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def decoded(data):
    def unique(items):
        result = {}
        for name, value in items:
            require(name not in result, 'duplicate JSON field')
            result[name] = value
        return result
    return json.loads(data, object_pairs_hook=unique, parse_constant=lambda _: (_ for _ in ()).throw(Refused('nonfinite JSON value')))


def digest(value):
    return hashlib.sha256(value if isinstance(value, bytes) else encoded(value)).hexdigest()


def inode(info):
    return f'{info.st_dev}-{info.st_ino}'


def absolute(value):
    require(isinstance(value, (str, Path)), 'absolute path required')
    path = Path(value)
    require(path.is_absolute() and path.anchor == '/' and os.path.normpath(str(value)) == str(value) and not any(ord(c) < 32 for c in str(value)), 'canonical absolute path required')
    return path


def relative(value):
    require(isinstance(value, str) and value and not Path(value).is_absolute() and os.path.normpath(value) == value and '..' not in Path(value).parts and not any(ord(c) < 32 for c in value), 'canonical relative path required')
    return value


def open_directory(value, *, uid=None, protected=False):
    path = absolute(value)
    descriptor = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for component in path.parts[1:]:
            if protected:
                info = os.fstat(descriptor)
                require(info.st_uid == 0 and not info.st_mode & 0o022, 'unprotected root directory ancestor')
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        info = os.fstat(descriptor)
        if protected:
            require(info.st_uid == 0 and not info.st_mode & 0o022, 'unprotected root directory')
        if uid is not None:
            require(info.st_uid == uid, 'unexpected directory owner')
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def child_directory(parent, name, *, uid=None):
    require(isinstance(name, str) and '/' not in name and name not in ('', '.', '..'), 'plain child name required')
    descriptor = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
    try:
        if uid is not None:
            require(os.fstat(descriptor).st_uid == uid, 'unexpected child directory owner')
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def regular(parent, name, *, write=False, uid=None, private=False, allow_links=False):
    require(isinstance(name, str) and '/' not in name and name not in ('', '.', '..'), 'plain filename required')
    flags = (os.O_RDWR if write else os.O_RDONLY) | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
    descriptor = os.open(name, flags, dir_fd=parent)
    try:
        info = os.fstat(descriptor)
        require(stat.S_ISREG(info.st_mode) and (allow_links or info.st_nlink == 1), 'single-link regular file required')
        if uid is not None:
            require(info.st_uid == uid, 'unexpected file owner')
        if private:
            require(not info.st_mode & 0o077, 'private file required')
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def snapshot(descriptor, limit=MAX_MESSAGE):
    before = os.fstat(descriptor)
    require(stat.S_ISREG(before.st_mode), 'regular snapshot required')
    chunks = bytearray()
    while len(chunks) <= limit:
        data = os.read(descriptor, min(65536, limit + 1 - len(chunks)))
        if not data:
            break
        chunks.extend(data)
    after = os.fstat(descriptor)
    stamp = lambda s: (s.st_dev, s.st_ino, s.st_mode, s.st_uid, s.st_gid, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
    require(len(chunks) <= limit and stamp(before) == stamp(after), 'snapshot changed or exceeds bound')
    return bytes(chunks)


def read_path(value, *, uid=None, protected=False, limit=MAX_MESSAGE, allow_links=False):
    path = absolute(value)
    parent = open_directory(path.parent, protected=protected)
    try:
        descriptor = regular(parent, path.name, uid=0 if protected else uid, allow_links=allow_links)
        try:
            if protected:
                require(not os.fstat(descriptor).st_mode & 0o022, 'root file is writable by others')
            data = snapshot(descriptor, limit)
            require(inode(os.stat(path.name, dir_fd=parent, follow_symlinks=False)) == inode(os.fstat(descriptor)), 'snapshot name replaced')
            return data
        finally:
            os.close(descriptor)
    finally:
        os.close(parent)


def send_message(connection, value, deadline):
    data = encoded(value)
    require(len(data) <= MAX_MESSAGE, 'message too large')
    connection.settimeout(max(0.001, deadline - time.monotonic()))
    require(time.monotonic() < deadline, 'message deadline elapsed')
    connection.sendall(struct.pack('!I', len(data)) + data)


def receive_message(connection, deadline):
    def exact(size):
        data = bytearray()
        while len(data) < size:
            require(time.monotonic() < deadline, 'message deadline elapsed')
            connection.settimeout(max(0.001, deadline - time.monotonic()))
            part = connection.recv(size - len(data))
            if not part:
                raise Unconfirmed('peer disconnected before a complete reply')
            data.extend(part)
        return bytes(data)
    size = struct.unpack('!I', exact(4))[0]
    require(0 < size <= MAX_MESSAGE, 'message length outside bound')
    return decoded(exact(size))


def peer_uid(connection):
    return struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))[1]

# Keep unreaped owned clients reachable: uncertainty never becomes a success or a retry.
OWNED_UNCONFIRMED = {}


def command(argv, *, timeout=30, limit=8*1024*1024):
    import selectors
    import signal
    import subprocess
    for pid, old in list(OWNED_UNCONFIRMED.items()):
        if old.poll() is not None:
            del OWNED_UNCONFIRMED[pid]
    require(not OWNED_UNCONFIRMED, 'previous owned command remains unconfirmed')
    process=subprocess.Popen(argv,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                             start_new_session=True,env={'PATH':os.defpath,'LANG':'C','LC_ALL':'C'})
    deadline=time.monotonic()+timeout;output={process.stdout:bytearray(),process.stderr:bytearray()};total=0
    try:
        with selectors.DefaultSelector() as selector:
            for stream in output:
                os.set_blocking(stream.fileno(),False);selector.register(stream,selectors.EVENT_READ)
            while selector.get_map():
                require(time.monotonic()<deadline,'fixed command deadline elapsed')
                for event,_ in selector.select(max(0,deadline-time.monotonic())):
                    try:data=os.read(event.fileobj.fileno(),min(65536,limit+1-total))
                    except BlockingIOError:continue
                    if not data:selector.unregister(event.fileobj);continue
                    total+=len(data);require(total<=limit,'fixed command output exceeds bound');output[event.fileobj].extend(data)
        while process.poll() is None:
            require(time.monotonic()<deadline,'fixed command reap deadline elapsed')
            time.sleep(min(.01,max(0,deadline-time.monotonic())))
        return subprocess.CompletedProcess(argv,process.returncode,output[process.stdout].decode('utf-8','replace'),output[process.stderr].decode('utf-8','replace'))
    except BaseException:
        if process.poll() is None:
            try:os.killpg(process.pid,signal.SIGKILL)
            except ProcessLookupError:pass
            end=time.monotonic()+1
            while process.poll() is None and time.monotonic()<end:time.sleep(.01)
            if process.poll() is None:
                OWNED_UNCONFIRMED[process.pid]=process
                raise Unconfirmed('owned command could not be reaped within its cleanup bound')
        raise
    finally:
        process.stdout.close();process.stderr.close()


def peer_registry(path, uid, employee):
    value=decoded(read_path(path,uid=uid,limit=1024*1024))
    require(not Path(path).stat().st_mode&0o022,'company registry is writable by others')
    rows=value.get('employees') if isinstance(value,dict) else None
    require(isinstance(rows,list) and len(rows)<=10000 and all(isinstance(row,dict) for row in rows),'canonical employee registry unavailable')
    ids=[row.get('id') for row in rows];sessions=[row.get('sessionId') for row in rows if row.get('sessionId') is not None]
    require(all(isinstance(v,str) for v in ids) and len(ids)==len(set(ids)) and len(sessions)==len(set(sessions)),'canonical employee identities ambiguous')
    selected=[row for row in rows if row.get('id')==employee]
    require(len(selected)==1,'configured employee unavailable')
    row=selected[0];session=canonical_id(row.get('sessionId'));generation=row.get('sessionGeneration')
    require(type(generation) is int and generation>0 and 'bindingMigration' not in row,'canonical session generation unknown or migrating')
    require(row.get('desiredRunning') is True and not row.get('onVacation') and not row.get('sleeping'),'peer is stopped, sleeping or on vacation')
    return {'employeeId':employee,'sessionId':session,'sessionGeneration':generation}
