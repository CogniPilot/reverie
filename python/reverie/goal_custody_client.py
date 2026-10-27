"""Small closed client for the existing private worker-broker G operation.

No path/command/caller inputs or credentials. Keeping this entry free of the
worker supervisor's imports avoids starting a supervisor interpreter per check.
SO_PEERCRED, endpoint inode and closed bounded protocol remain mandatory.
"""
import json
import os
from pathlib import Path
import re
import socket
import stat
import struct
import sys
import time


def project(args=None, *, emit=True):
    if args is not None and any(getattr(args, key, None) for key in
            ['control', 'caller_session', 'session_id', 'cwd', 'command', 'attach_only']):
        raise ValueError('Goal custody client accepts no operation or identity inputs')
    path = os.environ.get('REVERIE_WORKER_SOCKET')
    if not path:
        raise ValueError('Private Goal broker endpoint unavailable')
    info = Path(path).lstat()
    if not stat.S_ISSOCK(info.st_mode) or info.st_mode & 0o077:
        raise ValueError('Private Goal broker endpoint unavailable')
    with socket.socket(socket.AF_UNIX) as connection:
        deadline = time.monotonic() + 1.75
        def remaining():
            value = deadline - time.monotonic()
            if value <= 0:
                raise ValueError('Private Goal custody deadline exceeded')
            connection.settimeout(value)
        remaining()
        connection.connect(path)
        peer = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        current = Path(path).lstat()
        if peer[1] != os.getuid() or (info.st_dev, info.st_ino, info.st_mode) != (current.st_dev, current.st_ino, current.st_mode):
            raise ValueError('Private Goal broker endpoint changed')
        payload = b'{"action":"goal-custody"}'
        remaining()
        connection.sendall(b'G' + struct.pack('!I', len(payload)) + payload)
        def read(size):
            data = bytearray()
            while len(data) < size:
                remaining()
                chunk = connection.recv(size - len(data))
                if not chunk:
                    raise ValueError('Private Goal custody unavailable')
                data.extend(chunk)
            return bytes(data)
        header = read(5)
        length = struct.unpack('!I', header[1:])[0]
        if header[0:1] != b'J' or length > 32768:
            raise ValueError('Private Goal custody unavailable')
        result = json.loads(read(length))
        if (not isinstance(result, dict) or set(result) != {'version', 'configDigest', 'identities'} or
                type(result['version']) is not int or result['version'] != 1 or not isinstance(result['configDigest'], str) or
                not re.fullmatch('[a-f0-9]{64}', result['configDigest']) or not isinstance(result['identities'], dict)):
            raise ValueError('Private Goal custody unavailable')
        expected = {name + suffix for name in ['config', 'key', 'canonical', 'nonce', 'authority'] for suffix in ['', 'Root']} | {'canonicalLock', 'nonceLock', 'noncePending', 'nonceParent'}
        if set(result['identities']) != expected or any(value is not None and
                (not isinstance(value, list) or len(value) != 5 or any(not isinstance(part, str) or not re.fullmatch('[0-9]{1,24}', part) for part in value))
                for value in result['identities'].values()):
            raise ValueError('Private Goal custody unavailable')
        if emit:
            print(json.dumps(result, separators=(',', ':')))
    return 0 if emit else result


def main(stream=False):
    try:
        if stream:
            while True:
                operation = sys.stdin.buffer.read(1)
                if not operation:
                    return 0
                if operation != b'G':
                    raise ValueError('Closed Goal helper operation refused')
                result = json.dumps(project(emit=False), separators=(',', ':')).encode()
                if len(result) > 32768:
                    raise ValueError('Closed Goal helper output exceeds bound')
                sys.stdout.buffer.write(b'J' + struct.pack('!I', len(result)) + result)
                sys.stdout.buffer.flush()
        return project()
    except (OSError, ValueError):
        print('Private Goal custody unavailable', file=sys.stderr)
        return 1
