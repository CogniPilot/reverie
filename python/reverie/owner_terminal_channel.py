"""Two-phase Linux website channel candidate. No issuer, ledger or PTY.

Composition installs one fixed WebsitePeer per reviewed website incarnation.
Only that process can pass bootstrap -> exec -> Node handoff. No identity is
accepted from message bodies; kernel credentials are checked on every chunk.
"""
from dataclasses import dataclass
import hashlib
import http.client
import json
import os
from pathlib import Path
import select
import socket
import stat
import struct
import time


class Refusal(ValueError):
    pass


def need(value, code):
    if not value:
        raise Refusal(code)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def read_proc(pid):
    root = Path('/proc') / str(pid)
    with (root / 'stat').open('rb') as stream:
        raw = stream.read(8193)
    need(len(raw) <= 8192, 'PROCESS_BOUND')
    fields = raw.rsplit(b')', 1)[1].split()
    need(fields[0] not in (b'Z', b'X'), 'PROCESS_ENDED')
    with (root / 'cmdline').open('rb') as stream:
        argv = stream.read(65537)
    need(0 < len(argv) <= 65536, 'ARGV_BOUND')
    executable = (root / 'exe').stat()
    return {'pid': pid, 'start': int(fields[19]), 'parent': int(fields[1]),
            'argv': hashlib.sha256(argv).hexdigest(),
            'exe': (executable.st_dev, executable.st_ino),
            'namespaces': tuple((root / 'ns' / n).stat().st_ino for n in ('mnt', 'pid', 'user'))}


@dataclass(frozen=True)
class Program:
    executable: str
    argv: tuple[str, ...]

    def matches(self, process):
        path = Path(self.executable)
        need(str(path).startswith('/nix/store/') and path.resolve(strict=True) == path, 'IMMUTABLE_PROGRAM')
        info = path.stat()
        need(info.st_uid == 0 and stat.S_ISREG(info.st_mode) and not info.st_mode & 0o222, 'IMMUTABLE_PROGRAM')
        raw = b'\0'.join(s.encode() for s in self.argv) + b'\0'
        need(process['exe'] == (info.st_dev, info.st_ino) and process['argv'] == hashlib.sha256(raw).hexdigest(), 'PROGRAM_CHANGED')


@dataclass(frozen=True)
class WebsitePeer:
    # These are trusted supervisor inputs, NEVER request/message fields.
    engine_socket: str
    container_id: str
    image_id: str
    config_digest: str
    init_pid: int
    init_start: int
    uid: int
    gid: int
    bootstrap: Program
    node: Program

    def inspect(self):
        need(len(self.container_id) == 64 and all(c in '0123456789abcdef' for c in self.container_id), 'EXACT_CONTAINER')
        # Fixed GET only; no environment proxies, redirects, CLI or mutation.
        connection = http.client.HTTPConnection('localhost', timeout=2)
        connection.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.sock.settimeout(2)
        try:
            connection.sock.connect(self.engine_socket)
            connection.request('GET', '/containers/' + self.container_id + '/json')
            response = connection.getresponse()
            raw = response.read(2 * 1024 * 1024 + 1)
            need(response.status == 200 and len(raw) <= 2 * 1024 * 1024, 'ENGINE_UNAVAILABLE')
            item = json.loads(raw)
            need(item['Id'] == self.container_id and item['Image'] == self.image_id
                 and item['State']['Running'] is True and item['State']['Pid'] == self.init_pid
                 and digest(item['Config']) == self.config_digest, 'WEBSITE_CHANGED')
            need(item['Config']['User'] == f'{self.uid}:{self.gid}', 'WEBSITE_UID_CHANGED')
            # Pinning full Config also binds installed entrypoint/Cmd/Env.
            return item
        finally:
            connection.close()

    def assert_process(self, credentials, stage):
        pid, uid, gid = credentials
        need(uid == self.uid == os.getuid() and gid == self.gid and pid > 1, 'PEER_IDENTITY')
        self.inspect()
        initial = read_proc(self.init_pid)
        need(initial['start'] == self.init_start, 'WEBSITE_RESTARTED')
        peer = read_proc(pid)
        need(peer['namespaces'] == initial['namespaces'], 'WRONG_NAMESPACE')
        current = peer
        for _ in range(32):
            if current['pid'] == self.init_pid:
                break
            need(current['parent'] > 1 and current['parent'] != current['pid'], 'NOT_WEBSITE_PROCESS')
            current = read_proc(current['parent'])
        else:
            raise Refusal('PROCESS_DEPTH')
        (self.bootstrap if stage == 'bootstrap' else self.node).matches(peer)
        self.inspect()
        need(read_proc(pid) == peer and read_proc(self.init_pid) == initial, 'PROCESS_RACE')
        return peer


class Handoff:
    """Serialized one-use state machine over an already installed listener.

    Listener creation/custody and worker-grant exclusion are supervisor duties.
    Caller owns the listener; close/unlink it immediately after accept_node.
    Any exception irreversibly fails this object; a new website start is needed.
    """
    def __init__(self, website, *, clock=time.monotonic):
        need(isinstance(website, WebsitePeer), 'FIXED_WEBSITE_BINDING')
        self.website = website
        self.clock = clock
        self.deadline = clock() + 10
        self.state = 'BOOTSTRAP'
        self.process = None
        self.pidfd = None
        self.node = None

    def close(self):
        self.state = 'CLOSED'
        if self.node is not None:
            self.node.close()
            self.node = None
        if self.pidfd is not None:
            os.close(self.pidfd)
            self.pidfd = None

    def _time(self):
        need(self.clock() < self.deadline, 'HANDOFF_EXPIRED')

    def bootstrap(self, connection):
        try:
            need(self.state == 'BOOTSTRAP', 'NO_RETRY')
            self._time()
            credentials = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            self.process = self.website.assert_process(credentials, 'bootstrap')
            self.pidfd = os.pidfd_open(credentials[0])
            need(not select.select([self.pidfd], [], [], 0)[0], 'PROCESS_ENDED')
            self._time()
            connection.settimeout(max(.001, self.deadline - self.clock()))
            connection.sendall(b'EXEC\n')
            # Bootstrap must exec with CLOEXEC; no arbitrary data/early Node claim.
            need(connection.recv(1) == b'', 'BOOTSTRAP_DID_NOT_EXEC')
            self._time()
            self.state = 'NODE'
        except BaseException:
            self.close()
            raise
        finally:
            connection.close()

    def accept_node(self, connection):
        try:
            need(self.state == 'NODE', 'NO_RETRY')
            self._time()
            credentials = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            need(credentials[0] == self.process['pid'] and not select.select([self.pidfd], [], [], 0)[0], 'WRONG_EXEC_PEER')
            current = self.website.assert_process(credentials, 'node')
            need(current['start'] == self.process['start'], 'PID_REUSED')
            connection.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)
            connection.settimeout(2)
            self._time()
            self.node = connection
            self.credentials = credentials
            self.state = 'CONNECTED'
            connection.sendall(b'READY\n')
            return self
        except BaseException:
            connection.close()
            self.close()
            raise

    def read(self, limit=8192):
        """One bounded chunk, not a ledger operation or owner assertion.

        Fixed authority/ledger composition must additionally frame and recheck
        session scope/current target. Ancillary descriptor transfer is refused.
        """
        try:
            need(self.state == 'CONNECTED' and type(limit) is int and 1 <= limit <= 8192, 'CHANNEL_BOUND')
            need(not select.select([self.pidfd], [], [], 0)[0], 'PROCESS_ENDED')
            self.website.assert_process(self.credentials, 'node')
            data, ancillary, flags, _ = self.node.recvmsg(limit, socket.CMSG_SPACE(12), socket.MSG_CMSG_CLOEXEC)
            # A hostile peer must not leak SCM_RIGHTS FDs into this service.
            for level, kind, raw in ancillary:
                if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                    for index in range(0, len(raw) - 3, 4):
                        os.close(struct.unpack('i', raw[index:index + 4])[0])
            need(data and not flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC), 'CHANNEL_CLOSED_OR_TRUNCATED')
            need(len(ancillary) == 1 and ancillary[0][:2] == (socket.SOL_SOCKET, socket.SCM_CREDENTIALS)
                 and len(ancillary[0][2]) == 12
                 and struct.unpack('3i', ancillary[0][2]) == self.credentials, 'FOREIGN_DESCRIPTOR_WRITER')
            self.website.assert_process(self.credentials, 'node')
            return data
        except BaseException:
            self.close()
            raise
