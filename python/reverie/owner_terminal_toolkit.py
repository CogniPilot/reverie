"""Metadata/bytes qualification of direct read-only image-root static programs.

No exec, mount, namespace transition or private-data read. Linux openat2 anchors
the fixed paths in the exact engine init's root, rejects symlinks/magic links,
and reads only the two bounded public toolkit ELF files and kernel metadata.
"""
import copy
import hashlib
import json
import os
from pathlib import Path
import stat

from .owner_terminal_channel import need, read_proc
from .linux_root_files import open_in_root, mapped_root_uid
from .human_shell_capabilities import open_directory

FILES = ('/opt/reverie/human/bin/reverie-human-shell', '/opt/reverie/human/bin/bash')
MAX_PROGRAM = 16 * 1024**2


def immutable_manifest(path):
    path = Path(path)
    need(str(path).startswith('/nix/store/') and path.resolve(strict=True) == path, 'IMMUTABLE_TOOLKIT_MANIFEST_REQUIRED')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        need(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o222
             and info.st_size <= 8192, 'IMMUTABLE_TOOLKIT_MANIFEST_REQUIRED')
        raw = os.read(fd, 8193); need(len(raw) <= 8192, 'TOOLKIT_MANIFEST_BOUND')
        value = json.loads(raw)
        need(type(value) is dict and set(value) == {'version', 'static', 'files'} and value['version'] == 1
             and value['static'] is True and set(value['files']) == set(FILES), 'STATIC_TOOLKIT_MANIFEST_REQUIRED')
        for row in value['files'].values():
            need(type(row) is dict and set(row) == {'sha256', 'bytes'} and type(row['bytes']) is int
                 and 4 <= row['bytes'] <= MAX_PROGRAM and type(row['sha256']) is str
                 and len(row['sha256']) == 64 and all(c in '0123456789abcdef' for c in row['sha256']), 'TOOLKIT_FILE_BINDING')
        return value
    finally:
        os.close(fd)






def qualify(item, manifest, *, uid, gid):
    host = item['HostConfig']
    need('CapAdd' in host and (host['CapAdd'] is None or type(host['CapAdd']) is list), 'TOOLKIT_CAPABILITIES_UNKNOWN')
    caps = host['CapAdd'] if host['CapAdd'] is not None else []
    need(type(caps) is list and all(type(c) is str for c in caps), 'TOOLKIT_CAPABILITIES_UNKNOWN')
    caps = {c.removeprefix('CAP_') for c in caps}
    need(host.get('ReadonlyRootfs') is True and host.get('Privileged') is False
         and host.get('PidMode') in ('', 'private') and host.get('CapDrop') == ['ALL']
         and caps <= {'SETUID', 'SETGID'} and item['Config']['User'] == str(uid)+':'+str(gid),
         'PROTECTED_TOOLKIT_NAMESPACE_REQUIRED')
    for mount in item['Mounts']:
        destination = Path(mount['Destination'])
        need(not (destination == Path('/opt/reverie/human') or destination.is_relative_to('/opt/reverie/human')
                  or Path('/opt/reverie/human').is_relative_to(destination)
                  or destination == Path('/proc') or Path('/proc').is_relative_to(destination)
                  or destination.is_relative_to('/proc')),
             'TOOLKIT_OR_KERNEL_METADATA_MASKED')
    pid = item['State']['Pid']
    initial = read_proc(pid)
    owner = mapped_root_uid(pid)
    root = os.open('/proc/'+str(pid)+'/root', os.O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for name in FILES:
            fd = open_in_root(root, name)
            try:
                info = os.fstat(fd); wanted = manifest['files'][name]
                need(stat.S_ISREG(info.st_mode) and info.st_uid == owner and stat.S_IMODE(info.st_mode) == 0o555
                     and os.fstatvfs(fd).f_flag & os.ST_RDONLY and info.st_nlink == 1 and info.st_size == wanted['bytes'], 'IMAGE_TOOLKIT_METADATA_CHANGED')
                result = hashlib.sha256(); count = 0; prefix = b''
                while data := os.read(fd, min(1024**2, MAX_PROGRAM + 1 - count)):
                    if not prefix: prefix = data[:4]
                    count += len(data); need(count <= MAX_PROGRAM, 'IMAGE_TOOLKIT_BOUND'); result.update(data)
                need(prefix == b'\x7fELF' and count == wanted['bytes'] and result.hexdigest() == wanted['sha256'],
                     'IMAGE_TOOLKIT_BYTES_CHANGED')
                after = os.fstat(fd)
                need((after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns) ==
                     (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns), 'IMAGE_TOOLKIT_READ_CHANGED')
            finally:
                os.close(fd)
        # Agent account resolution used by the existing fixed --user agent
        # argv must agree with the qualified current numeric laptop identity.
        fd = open_in_root(root, '/etc/passwd')
        try:
            raw = os.read(fd, 65537); need(len(raw) <= 65536, 'IMAGE_ACCOUNT_BOUND')
            agents = [line.split(b':') for line in raw.splitlines() if line.startswith(b'agent:')]
            need(len(agents) == 1 and len(agents[0]) == 7 and agents[0][2:4] == [str(uid).encode(), str(gid).encode()],
                 'IMAGE_AGENT_IDENTITY_CHANGED')
        finally:
            os.close(fd)
    finally:
        os.close(root)
    need(read_proc(pid) == initial, 'TOOLKIT_INIT_CHANGED')
    return initial


class StorageRootCustody:
    """Held host/guest bind-root FDs, not Docker Source-path assertions.

    The fixed installer supplies exactly home and nix paths from trusted storage
    resolution. No path, identity, FD or callback is accepted from an H request.
    Mutable directory contents/timestamps are not identity. Every admission
    reopens both pathnames and verifies them against the still-held originals.
    """
    DESTINATIONS = {'home': '/home/agent', 'nix': '/nix'}

    def __init__(self, initial, paths):
        need(type(paths) is dict and set(paths) == set(self.DESTINATIONS), 'H_STORAGE_ROOT_SCHEMA')
        self.initial = copy.deepcopy(initial)
        self.paths = {name: str(path) for name, path in paths.items()}
        self.root = None; self.hosts = {}; self.guests = {}; self.identities = {}
        try:
            need(read_proc(initial['pid']) == initial, 'H_STORAGE_INIT_CHANGED')
            self.root = os.open('/proc/'+str(initial['pid'])+'/root', os.O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
            self.root_identity = self.identity(self.root)
            for name, destination in self.DESTINATIONS.items():
                self.hosts[name] = open_directory(self.paths[name])
                self.guests[name] = open_in_root(self.root, destination)
                identity = self.identity(self.hosts[name])
                need(identity == self.identity(self.guests[name]), 'H_STORAGE_BIND_ROOT_MISMATCH')
                self.identities[name] = identity
            self.assert_current()
        except BaseException:
            self.close(); raise

    @staticmethod
    def identity(fd):
        value = os.fstat(fd)
        need(stat.S_ISDIR(value.st_mode), 'H_STORAGE_DIRECTORY_REQUIRED')
        return value.st_dev, value.st_ino

    def snapshot(self):
        # Decimal strings retain the full kernel integer even on filesystems
        # whose inode values exceed JavaScript's exact-integer range. This is
        # private native metadata, never an owner grant or browser selector.
        return {'initRoot': [str(value) for value in self.root_identity],
                'directories': {name: {'source': self.paths[name],
                    'identity': [str(value) for value in self.identities[name]]}
                    for name in self.DESTINATIONS}}

    def assert_current(self):
        need(self.root is not None and read_proc(self.initial['pid']) == self.initial, 'H_STORAGE_INIT_CHANGED')
        self._paths_current()
        need(read_proc(self.initial['pid']) == self.initial, 'H_STORAGE_INIT_CHANGED')
        # One final metadata bracket after the last blocking PID producer.
        # No additional native/PID observation follows it; this is a finite
        # check, not an atomic reservation or an unbounded retry loop.
        self._paths_current()

    def _paths_current(self):
        current_root = os.open('/proc/'+str(self.initial['pid'])+'/root', os.O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
        try:
            need(self.identity(current_root) == self.root_identity == self.identity(self.root), 'H_STORAGE_INIT_ROOT_CHANGED')
            for name, destination in self.DESTINATIONS.items():
                expected = self.identities[name]
                need(self.identity(self.hosts[name]) == expected == self.identity(self.guests[name]), 'H_HELD_STORAGE_ROOT_CHANGED')
                current_host = open_directory(self.paths[name])
                current_guest = None
                try:
                    current_guest = open_in_root(current_root, destination)
                    need(self.identity(current_host) == expected == self.identity(current_guest), 'H_STORAGE_ROOT_CHANGED')
                finally:
                    if current_guest is not None: os.close(current_guest)
                    os.close(current_host)
        finally:
            os.close(current_root)

    def close(self):
        for table in (self.hosts, self.guests):
            for fd in table.values(): os.close(fd)
            table.clear()
        if self.root is not None:
            os.close(self.root); self.root = None


def verify_guest(binding, acknowledgement):
    need(type(acknowledgement) is dict and set(acknowledgement) ==
         {'nonce', 'monitorPid', 'monitorStart', 'childPid', 'childStart'}, 'GUEST_READY_SCHEMA')
    for name in ('monitorPid', 'childPid', 'monitorStart', 'childStart'):
        need(type(acknowledgement[name]) is int and acknowledgement[name] > 1, 'GUEST_KERNEL_IDENTITY_REQUIRED')
    need(acknowledgement['monitorPid'] != acknowledgement['childPid'], 'GUEST_DISTINCT_PROCESSES_REQUIRED')
    initial = read_proc(binding['init']['pid'])
    need(initial == binding['init'], 'H_LAPTOP_INIT_CHANGED')
    root = os.open('/proc/'+str(initial['pid'])+'/root', os.O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for role in ('monitor', 'child'):
            pid = acknowledgement[role+'Pid']
            fd = open_in_root(root, '/proc/'+str(pid)+'/stat')
            try:
                raw = os.read(fd, 8193); need(len(raw) <= 8192, 'GUEST_KERNEL_STAT_BOUND')
            finally:
                os.close(fd)
            fields = raw.rsplit(b')', 1)[1].split()
            need(fields[0] not in (b'Z', b'X') and int(fields[19]) == acknowledgement[role+'Start'], 'GUEST_PROCESS_CHANGED')
            if role == 'child':
                need(int(fields[1]) == acknowledgement['monitorPid'], 'GUEST_CHILD_ANCESTRY_CHANGED')
    finally:
        os.close(root)
    need(read_proc(initial['pid']) == initial, 'H_LAPTOP_INIT_CHANGED')


def verify_monitor(binding, acknowledgement):
    need(type(acknowledgement) is dict and set(acknowledgement) == {'nonce', 'monitorPid', 'monitorStart'},
         'GUEST_MONITOR_SCHEMA')
    need(type(acknowledgement['monitorPid']) is int and acknowledgement['monitorPid'] > 1
         and type(acknowledgement['monitorStart']) is int and acknowledgement['monitorStart'] > 1,
         'GUEST_MONITOR_IDENTITY')
    initial = read_proc(binding['init']['pid'])
    need(initial == binding['init'], 'H_LAPTOP_INIT_CHANGED')
    root = os.open('/proc/'+str(initial['pid'])+'/root', os.O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        fd = open_in_root(root, '/proc/'+str(acknowledgement['monitorPid'])+'/stat')
        try:
            raw = os.read(fd, 8193); need(len(raw) <= 8192, 'GUEST_KERNEL_STAT_BOUND')
        finally:
            os.close(fd)
        fields = raw.rsplit(b')', 1)[1].split()
        need(fields[0] not in (b'Z', b'X') and int(fields[19]) == acknowledgement['monitorStart'], 'GUEST_MONITOR_CHANGED')
    finally:
        os.close(root)
    need(read_proc(initial['pid']) == initial, 'H_LAPTOP_INIT_CHANGED')


def guest_gone(binding, acknowledgement):
    initial = read_proc(binding['init']['pid'])
    need(initial == binding['init'], 'H_LAPTOP_INIT_CHANGED')
    root = os.open('/proc/'+str(initial['pid'])+'/root', os.O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for role in ('monitor', 'child'):
            try:
                fd = open_in_root(root, '/proc/'+str(acknowledgement[role+'Pid'])+'/stat')
            except FileNotFoundError:
                continue
            try:
                raw = os.read(fd, 8193); need(len(raw) <= 8192, 'GUEST_KERNEL_STAT_BOUND')
            finally:
                os.close(fd)
            fields = raw.rsplit(b')', 1)[1].split()
            need(int(fields[19]) != acknowledgement[role+'Start'], 'H_GUEST_PROCESS_REMAINS')
    finally:
        os.close(root)
    need(read_proc(initial['pid']) == initial, 'H_LAPTOP_INIT_CHANGED')
