"""Fixed H actor. Serialized by LedgerService, never reachable from worker J.

Only a consumed private capability can reach Popen. No caller selects an engine,
container, executable, environment, path or launch arguments. Guest settlement
and client-process settlement are separate facts; missing either is retained.
"""
import base64
import copy
import hashlib
import fcntl
import json
import os
from pathlib import Path
import secrets
import select
import signal
import struct
import subprocess
import stat
import socket
import time

from . import human_terminal_protocol as protocol
from .owner_terminal_channel import Program, read_proc
from .owner_terminal_channel import Handoff
from .human_shell_capabilities import open_directory
from .owner_terminal_toolkit import verify_guest, verify_monitor


class HumanTerminal:
    def __init__(self, installation, engine_program, channel):
        self.installation, self.engine = installation, engine_program
        self.sessions = {}
        self.unknown = set()
        self.settlements = {}
        self.process = read_proc(os.getpid())
        value = installation.value['hostProgram']
        self.program = Program(value['executable'], tuple(value['argv']))
        entry = Path(__file__).resolve().parents[2] / 'scripts/reverie-owner-terminal-host'
        source = entry.stat()
        protocol.need(str(entry).startswith('/nix/store/') and source.st_uid == 0
                      and stat.S_ISREG(source.st_mode) and not source.st_mode & 0o222,
                      'IMMUTABLE_H_ENTRY_REQUIRED')
        protocol.need(len(self.program.argv) == 6 and Path(self.program.argv[0]).samefile(self.program.executable)
                      and self.program.argv[1:] == ('-I', '-B', str(entry), '--policy', str(installation.path)),
                      'FIXED_H_ENTRY_REQUIRED')
        self.program.matches(self.process)
        self.digest = hashlib.sha256(protocol.canonical(self.process)).hexdigest()
        protocol.need(isinstance(channel, Handoff) and channel.state == 'CONNECTED'
                      and getattr(channel.website, 'installation', None) is installation,
                      'PROTECTED_H_CHANNEL_REQUIRED')
        self.peer_channel = channel
        info = os.fstat(channel.node.fileno())
        self.peer_descriptor = (info.st_dev, info.st_ino)
        rows = Path('/proc/self/cgroup').read_text().splitlines()
        protocol.need(len(rows) == 1 and rows[0].startswith('0::/')
                      and Path(rows[0][3:]).name == 'reverie-owner-terminal.service', 'FIXED_H_USER_SERVICE_REQUIRED')
        self.cgroup = Path('/sys/fs/cgroup') / rows[0][3:].lstrip('/')
        info = self.cgroup.stat(); self.cgroup_identity = (info.st_dev, info.st_ino)
        info = installation.roots['ledgerRoot'].stat()
        self.root_identity = (info.st_dev, info.st_ino, info.st_uid, stat.S_IMODE(info.st_mode))

    def assert_current_peer(self, consumer_digest):
        protocol.need(consumer_digest == self.digest and read_proc(os.getpid()) == self.process,
                      'PROTECTED_H_CONSUMER_CHANGED')
        self.program.matches(self.process)
        group = self.cgroup.stat()
        protocol.need((group.st_dev, group.st_ino) == self.cgroup_identity, 'H_SERVICE_CGROUP_CHANGED')
        for file, expected in (('memory.max', '268435456'), ('memory.swap.max', '0'), ('pids.max', '64')):
            protocol.need((self.cgroup / file).read_text().strip() == expected, 'H_SERVICE_LIMIT_CHANGED')
        channel = self.peer_channel
        protocol.need(channel.state == 'CONNECTED' and not select.select([channel.pidfd], [], [], 0)[0], 'H_BACKEND_PEER_ENDED')
        fd = channel.node.fileno(); info = os.fstat(fd)
        protocol.need(stat.S_ISSOCK(info.st_mode) and (info.st_dev, info.st_ino) == self.peer_descriptor
                      and fcntl.fcntl(fd, fcntl.F_GETFD) & fcntl.FD_CLOEXEC
                      and struct.unpack('3i', channel.node.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)) == channel.credentials,
                      'H_PROTECTED_DESCRIPTOR_CHANGED')
        channel.website.assert_process(channel.credentials, 'node')
        self.installation.assert_website()

    def capture_target(self, employee_id):
        self.assert_current_peer(self.digest)
        return self.installation.target_binding(employee_id)

    def marker(self, shell, value):
        # Persist no output/input/proof/cookie. Durable one-shot intent is never
        # deleted or reused, including failed/unknown post-spawn outcomes.
        root = self.installation.roots['ledgerRoot']
        raw = protocol.canonical(value)
        directory = open_directory(root)
        try:
            info = os.fstat(directory)
            protocol.need((info.st_dev, info.st_ino, info.st_uid, stat.S_IMODE(info.st_mode)) == self.root_identity,
                          'H_PRIVATE_LEDGER_REBOUND')
            fd = os.open('shell-' + shell + '.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                         0o600, dir_fd=directory)
            try:
                with os.fdopen(fd, 'wb', closefd=False) as stream:
                    stream.write(raw); stream.flush(); os.fsync(fd)
            finally:
                os.close(fd)
            os.fsync(directory)
        finally:
            os.close(directory)

    def open(self, capability, current):
        request = capability.request
        channel = protocol.Channel(request, current, capability=capability)
        shell = request['shellId']
        protocol.need(shell not in self.sessions and shell not in self.unknown and len(self.sessions) < 4,
                      'H_CAPACITY_OR_REPLAY')
        protocol.need(len(getattr(self,'settlements',{}))+len(self.unknown)<256,
                      'H_GENERATION_CAPACITY_REFRESH_REQUIRED')
        self.assert_current_peer(self.digest)
        target = self.installation.human_binding(request)
        target_group = _capture_target_group(target)
        self.marker(shell, {'state': 'H_START_INTENT_NO_REPLAY', 'requestId': request['requestId'],
                            'authorizationRef': request['authorizationRef'], 'consumerDigest': self.digest,
                            'target': target})
        self.unknown.add(shell)
        # Same accepted fixed human launcher. It now speaks a bounded framed
        # pipe and owns its own PTY rather than Docker allocating a PTY whose
        # guest lifetime is hidden behind client-process exit.
        args = protocol.exec_argv(request, current, capability=capability)
        protocol.need(args[:2] == ['exec', '-it'], 'FIXED_H_ARGV')
        args[1] = '-i'
        args[2:2] = ['--interactive=true']
        # Pin engine executable by installed immutable Program, never PATH.
        engine = Path(self.engine)
        info = engine.stat()
        protocol.need(str(engine).startswith('/nix/store/') and engine.resolve(strict=True) == engine
                      and stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o222
                      and info.st_mode & 0o111,
                      'IMMUTABLE_ENGINE_REQUIRED')
        environment = {'HOME': str(self.installation.roots['controlRoot']), 'PATH': str(engine.parent),
                       'DOCKER_HOST': 'unix://' + self.installation.value['engineSocket'],
                       'DOCKER_CONFIG': str(self.installation.roots['controlRoot'] / 'docker')}
        directory = open_directory(self.installation.roots['controlRoot'] / 'docker')
        try:
            metadata = os.fstat(directory)
            protocol.need(metadata.st_uid == os.getuid() and stat.S_IMODE(metadata.st_mode) == 0o700, 'PRIVATE_ENGINE_CONFIG_REQUIRED')
            with os.scandir(directory) as entries:
                protocol.need(next(entries, None) is None, 'EMPTY_ENGINE_CONFIG_REQUIRED')
        finally:
            os.close(directory)
        self.assert_current_peer(self.digest)
        self.installation.assert_human_binding(target)
        channel._check(self.installation.observe(request['employeeId']))
        self.installation.assert_human_binding(target)
        protocol.need(request['expiresAtEpochMs'] - int(time.time()*1000) >= 5000, 'H_START_BUDGET_EXPIRED')
        child = subprocess.Popen([str(engine), *args], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 stderr=subprocess.DEVNULL, env=environment, start_new_session=True)
        binding = read_proc(child.pid)
        pidfd = os.pidfd_open(child.pid)
        record = {'child': child, 'binding': binding, 'pidfd': pidfd, 'channel': channel,
                  'nonce': secrets.token_hex(32), 'buffer': bytearray(), 'settled': False,
                  'target': target, 'targetCgroup': target_group,
                  'prepared': None, 'permitted': False, 'ready': None, 'pending': bytearray()}
        self.sessions[shell] = record
        self.marker(shell + '-client', {'state': 'H_CLIENT_CAPTURED_NO_REPLAY', 'client': binding, 'target': target})
        os.set_blocking(child.stdout.fileno(), False)
        os.set_blocking(child.stdin.fileno(), False)
        initial = b'H1' + record['nonce'].encode('ascii') + struct.pack('!QHH', request['expiresAtEpochMs'], request['cols'], request['rows'])
        protocol.need(os.write(child.stdin.fileno(), initial) == len(initial), 'H_START_UNCONFIRMED')
        deadline = time.monotonic() + 2
        while record['prepared'] is None and time.monotonic() < deadline:
            self.read(record, include_pending=False)
            if record['prepared'] is None:
                time.sleep(0.01)
        protocol.need(record['prepared'] is not None, 'H_MONITOR_BINDING_UNCONFIRMED_NO_RETRY')
        # Kernel-verified monitor in the captured worker namespace, then a
        # fresh authenticated capability check. One private GO, never replayed.
        self.installation.assert_human_binding(target)
        channel._check(self.installation.observe(request['employeeId']))
        self.marker(shell + '-prepared', {'state': 'H_MONITOR_KERNEL_VERIFIED_BEFORE_GO',
                                           'target': target, 'monitor': record['prepared']})
        self.installation.assert_human_binding(target)
        channel._expiry()
        go = b'G' + struct.pack('!I', 64) + record['nonce'].encode('ascii')
        protocol.need(os.write(child.stdin.fileno(), go) == len(go), 'H_PERMIT_UNCONFIRMED_NO_REPLAY')
        record['permitted'] = True
        while record['ready'] is None and time.monotonic() < deadline:
            record['pending'].extend(self.read(record, include_pending=False))
            protocol.need(len(record['pending']) <= 65536, 'H_EARLY_OUTPUT_BOUND')
            if record['ready'] is None:
                time.sleep(0.01)
        protocol.need(record['ready'] is not None, 'H_READY_UNCONFIRMED_NO_RETRY')
        self.marker(shell + '-ready', {'state': 'H_PTY_KERNEL_VERIFIED', 'target': target, 'guest': record['ready']})
        channel._expiry()
        return {'state': 'OPEN', 'shellId': shell}

    def handle(self, action, capability, current, payload):
        request = capability.request
        if action == 'open':
            protocol.need(payload is None, 'H_OPEN_SCHEMA')
            return self.open(capability, current)
        shell = request['shellId']
        protocol.need(shell in self.sessions, 'H_REFERENCE_UNAVAILABLE_NO_REPLAY')
        record = self.sessions[shell]
        channel = record['channel']
        self.assert_current_peer(self.digest)
        channel._check(self.installation.observe(request['employeeId']))
        if action == 'end':
            protocol.need(payload is None, 'H_CLOSE_SCHEMA')
            return self.finish(shell)
        if action in ('input', 'resize'):
            if action == 'input':
                protocol.need(type(payload) is str and len(payload) <= 5464, 'H_INPUT_BOUND')
                data = base64.b64decode(payload, validate=True)
                protocol.need(len(data) <= 4096, 'H_INPUT_BOUND')
                kind = b'I'
            else:
                data = protocol.canonical(payload)
                kind = b'R'
            channel.receive(kind, data, current)
            if kind == b'R':
                data = struct.pack('!HH', *payload)
            frame = kind + struct.pack('!I', len(data)) + data
            self.installation.assert_human_binding(record['target'])
            channel._expiry()
            protocol.need(os.write(record['child'].stdin.fileno(), frame) == len(frame), 'H_INPUT_UNCONFIRMED_NO_REPLAY')
            return {'state': 'OPEN', 'output': ''}
        protocol.need(action == 'poll' and payload is None, 'H_OPERATION')
        output = self.read(record)
        if output:
            channel.output(output, current)
        return {'state': 'SETTLED' if record['settled'] else 'OPEN',
                'output': base64.b64encode(output).decode('ascii')}

    def read(self, record, *, include_pending=True):
        child = record['child']
        if select.select([child.stdout], [], [], 0)[0]:
            data = os.read(child.stdout.fileno(), 16389)
            record['buffer'].extend(data)
            record['eof'] = not data
        buffer = record['buffer']
        protocol.need(len(buffer) <= 65536, 'H_OUTPUT_BOUND')
        output = bytearray()
        if include_pending and record.get('pending'):
            output.extend(record['pending'][:4096]); del record['pending'][:4096]
        while len(buffer) >= 5:
            kind, size = bytes(buffer[:1]), struct.unpack('!I', buffer[1:5])[0]
            protocol.need(size <= 16384, 'H_GUEST_FRAME_BOUND')
            if len(buffer) < size + 5:
                break
            if kind == b'O' and len(output) + size > 4096:
                break
            data = bytes(buffer[5:size + 5]); del buffer[:size + 5]
            if kind == b'O':
                protocol.need(record.get('ready') is not None, 'H_OUTPUT_BEFORE_READY')
                output.extend(data)
            elif kind == b'P':
                value = protocol.decode(data)
                protocol.need(type(value) is dict and record.get('prepared') is None and record.get('ready') is None
                              and value.get('nonce') == record['nonce'], 'H_MONITOR_BINDING')
                self.installation.assert_human_binding(record['target'])
                verify_monitor(record['target'], value)
                record['prepared'] = value
            elif kind == b'A':
                value = protocol.decode(data)
                protocol.need(type(value) is dict and record.get('ready') is None
                              and record.get('permitted') is True and record.get('prepared') is not None
                              and value.get('nonce') == record['nonce']
                              and value.get('monitorPid') == record['prepared']['monitorPid']
                              and value.get('monitorStart') == record['prepared']['monitorStart'], 'H_READY_BINDING')
                self.installation.assert_human_binding(record['target'])
                verify_guest(record['target'], value)
                record['ready'] = value
            else:
                value = protocol.decode(data)
                protocol.need(kind == b'X' and type(value) is dict
                              and set(value) == {'nonce', 'settled', 'failureClass'}
                              and value['nonce'] == record['nonce'] and value['settled'] is True
                              and value['failureClass'] is None, 'H_GUEST_SETTLEMENT_UNCONFIRMED')
                record['settled'] = True
        if record.get('eof') and not output:
            protocol.need(record['settled'] and not buffer, 'H_GUEST_LOST_NO_SETTLEMENT')
        return bytes(output)

    def finish(self, shell):
        record = self.sessions[shell]
        child = record['child']
        end = time.monotonic() + 5
        failure = None
        proof = None
        try:
            if child.poll() is None:
                try:
                    os.write(child.stdin.fileno(), b'Q\0\0\0\0')
                finally:
                    child.stdin.close()
            while child.poll() is None and time.monotonic() < end:
                self.read(record)
                time.sleep(0.01)
            if child.poll() is None:
                # The exact local client may be settled; this does NOT prove
                # guest cleanup. unknown remains retained in all such cases.
                protocol.need(read_proc(child.pid) == record['binding'], 'H_CLIENT_REPLACED')
                signal.pidfd_send_signal(record['pidfd'], signal.SIGKILL)
                child.wait(timeout=max(0.001, end + 1 - time.monotonic()))
            while time.monotonic() < end and (not record['settled'] or record['buffer']):
                self.read(record)
                if record.get('eof') and not record['buffer']:
                    break
            protocol.need(record['settled'] and child.returncode == 0, 'H_PHYSICAL_SETTLEMENT_UNKNOWN')
            protocol.need(record.get('ready') is not None, 'H_NATIVE_READY_UNAVAILABLE')
            self.installation.assert_guest_gone(record['target'], record['ready'])
            proof = copy.deepcopy({'target': record['target'], 'ready': record['ready'],
                                   'client': record['binding'], 'targetCgroup': record['targetCgroup']})
        except BaseException as error:
            failure = error
        finally:
            # Attempt every owned finalizer exactly once. A failed close is
            # uncertain; never retry its numeric FD after it may have closed.
            errors = []
            for close in (record['channel'].close, lambda: os.close(record['pidfd']),
                          *[stream.close for stream in (child.stdin, child.stdout) if stream is not None]):
                try: close()
                except BaseException as error: errors.append(error)
            del self.sessions[shell]
        if failure is not None or errors:
            self.unknown.add(shell)
            if failure is None: failure = RuntimeError('H_LOCAL_CLEANUP_UNCONFIRMED_NO_REPLAY')
            for error in errors: failure.add_note('H_LOCAL_FINALIZER_UNCONFIRMED:' + type(error).__name__)
            raise failure
        self.marker(shell + '-settled', {'state': 'H_GUEST_AND_CLIENT_SETTLED',
                                        'clientPid': child.pid, 'clientStart': record['binding']['start']})
        protocol.need(len(protocol.canonical(proof))<=65536,'H_NATIVE_SETTLEMENT_BOUND')
        self.marker(shell + '-native-settled', proof)
        if not hasattr(self, 'settlements'): self.settlements = {}
        self.settlements[shell] = hashlib.sha256(protocol.canonical(proof)).hexdigest()
        self.unknown.discard(shell)
        return {'state': 'SETTLED'}

    def close(self):
        for shell in list(self.sessions):
            try:
                self.finish(shell)
            except BaseException:
                self.unknown.add(shell)
        return not self.unknown


def _capture_target_group(target):
    from .owner_terminal_lifecycle import _group_binding
    return _group_binding(target['init']['pid'])
