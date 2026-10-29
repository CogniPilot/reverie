"""Non-authorizing same-kernel website provenance for fixed native actors.

This module produces facts, never owner approval, capabilities or a process
launch. Fixed host private configuration selects all inputs. Engine operations
are bounded Unix-socket metadata GETs only. Callers still own protected storage,
peer admission and their independent current-owner/purpose-specific checks.
"""
import copy
from collections import deque
import hashlib
import http.client
import json
import os
from pathlib import Path
import socket
import stat
import time

from .owner_terminal_channel import Program, WebsitePeer, digest, need, read_proc
from .linux_root_files import open_in_root, mapped_root_uid

MAX_CODE_FILE = 256 * 1024**2
MAX_CODE_TOTAL = 512 * 1024**2
ENGINE_SECONDS = 2.0
MAX_ENGINE_BODY = 2 * 1024**2
MAX_ENGINE_WIRE = MAX_ENGINE_BODY + 65536


def _remaining(deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError('ENGINE_METADATA_DEADLINE')
    return remaining


class _MetadataSocket(socket.socket):
    """One deadline at the raw I/O boundary, including HTTP header buffering.

    http.client's makefile uses SocketIO.recv_into. A per-read inactivity timeout
    alone permits an arbitrarily progressing header/body to outlive the budget.
    """
    def __init__(self, deadline):
        super().__init__(socket.AF_UNIX, socket.SOCK_STREAM)
        self.deadline, self.received = deadline, 0

    def connect(self, address):
        self.settimeout(_remaining(self.deadline))
        result = super().connect(address)
        _remaining(self.deadline)
        return result

    def sendall(self, data, flags=0):
        self.settimeout(_remaining(self.deadline))
        result = super().sendall(data, flags)
        _remaining(self.deadline)
        return result

    def recv_into(self, buffer, nbytes=0, flags=0):
        self.settimeout(_remaining(self.deadline))
        count = super().recv_into(buffer, nbytes, flags)
        self.received += count
        need(self.received <= MAX_ENGINE_WIRE, 'ENGINE_METADATA_WIRE_BOUND')
        _remaining(self.deadline)
        return count


def mounts(value):
    need(type(value) is list and len(value) <= 256, 'COMPLETE_MOUNTS_REQUIRED')
    destinations = [row.get('Destination') if type(row) is dict else None for row in value]
    need(all(type(path) is str and path.startswith('/') and str(Path(path)) == path and '..' not in Path(path).parts
             for path in destinations) and len(set(destinations)) == len(destinations), 'MOUNT_DESTINATIONS')
    return sorted(copy.deepcopy(value), key=lambda row: row['Destination'])


def host_config(value):
    need(type(value) is dict and 'OomKillDisable' in value
         and (value['OomKillDisable'] is None or value['OomKillDisable'] is False), 'OOM_KILLER_MUST_REMAIN_ENABLED')
    # Docker 29's null and false both mean enabled. All other fields, including
    # unknown future fields, are retained exactly. Nothing is omitted.
    return {**value, 'OomKillDisable': False}


def protected_backend(item):
    host = item['HostConfig']
    need(host.get('ReadonlyRootfs') is True and host.get('Privileged') is False
         and host.get('CapDrop') == ['ALL'] and 'CapAdd' in host and host['CapAdd'] in (None, [])
         and host.get('PidMode') in ('', 'private')
         and any(value in ('no-new-privileges', 'no-new-privileges:true') for value in host.get('SecurityOpt', [])),
         'PROTECTED_WEBSITE_NAMESPACE_REQUIRED')
    for mount in mounts(item['Mounts']):
        target = Path(mount['Destination'])
        need(not (target == Path('/nix') or target.is_relative_to('/nix') or Path('/nix').is_relative_to(target)),
             'IMMUTABLE_BACKEND_CODE_MASKED')
    environment = item['Config'].get('Env')
    need(type(environment) is list and len(environment) <= 256 and all(type(value) is str for value in environment),
         'FIXED_BACKEND_ENV_REQUIRED')
    denied = {'NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH', 'PYTHONHOME', 'GCONV_PATH', 'OPENSSL_CONF', 'OPENSSL_MODULES'}
    need(not any(value.split('=', 1)[0] in denied or value.startswith('LD_') for value in environment),
         'BACKEND_LOADER_ENV_REFUSED')


def socket_identity(path):
    value = Path(path).lstat()
    need(stat.S_ISSOCK(value.st_mode), 'ENGINE_SOCKET_REQUIRED')
    return value.st_dev, value.st_ino, value.st_uid, value.st_gid


class Engine:
    """No engine CLI, mutation, environment proxies or arbitrary route producer."""
    def __init__(self, path, identity, engine_id):
        need(type(path) is str and path.startswith('/') and '..' not in Path(path).parts, 'ENGINE_SOCKET_PATH')
        need(type(identity) in (list, tuple) and len(identity) == 4 and all(type(n) is int and n >= 0 for n in identity),
             'ENGINE_SOCKET_IDENTITY')
        need(type(engine_id) is str and 1 <= len(engine_id) <= 200, 'ENGINE_ID_REQUIRED')
        self.path, self.identity, self.engine_id = path, tuple(identity), engine_id

    def get(self, route):
        deadline = time.monotonic() + ENGINE_SECONDS
        need(route in ('/info', '/containers/json?all=1') or type(route) is str and (
             route.startswith('/containers/') and route.endswith('/json')
             and len(route[12:-5]) == 64 and all(c in '0123456789abcdef' for c in route[12:-5]) or
             route.startswith('/images/sha256:') and route.endswith('/json')
             and len(route[15:-5]) == 64 and all(c in '0123456789abcdef' for c in route[15:-5])),
             'FIXED_ENGINE_METADATA_ONLY')
        need(socket_identity(self.path) == self.identity, 'ENGINE_SOCKET_REBOUND')
        connection = http.client.HTTPConnection('localhost', timeout=ENGINE_SECONDS)
        response = None
        try:
            connection.sock = _MetadataSocket(deadline)
            connection.sock.connect(self.path); connection.request('GET', route)
            response = connection.getresponse()
            need(response.status == 200 and (response.length is None or
                 0 <= response.length <= MAX_ENGINE_BODY), 'ENGINE_METADATA_UNAVAILABLE')
            raw = response.read(MAX_ENGINE_BODY + 1)
            need(len(raw) <= MAX_ENGINE_BODY and response.length in (None, 0), 'ENGINE_METADATA_UNAVAILABLE')
            need(socket_identity(self.path) == self.identity, 'ENGINE_SOCKET_CHANGED')
            result = json.loads(raw)
            _remaining(deadline)
            return result
        finally:
            try:
                if response is not None:
                    response.close()
            finally:
                connection.close()

    def guard(self):
        value = self.get('/info')
        need(value.get('ID') == self.engine_id and value.get('OSType') == 'linux'
             and value.get('KernelVersion') == os.uname().release, 'SAME_KERNEL_ENGINE_REQUIRED')


def _program_invocation(executable, argv, files):
    need(argv[0].startswith('/nix/store/'), 'INVOCATION_EXECUTABLE_CHANGED')
    declared = str(Path(argv[0]).resolve(strict=True))
    need(executable in files and declared in files, 'MANIFESTED_PROGRAM_REQUIRED')
    if declared != executable:
        # This is the fixed Python bootstrap ABI, not a generic wrapper selector.
        need(len(argv) >= 2 and argv[1] == '-I', 'INVOCATION_EXECUTABLE_CHANGED')
        from .owner_terminal_native import qualify_python
        qualify_python(argv[0], executable)
    return declared


class WebsiteFacts:
    """A fresh one-incarnation observer; constructor inputs are host-only facts.

    Closed selection keys match the existing R2 WebsitePeer plus full security
    digests. initPid/initStart may both be null ONLY before bind_once(). That
    method never starts anything and can run once, after engine Running is true.
    Programs must be supplied by the qualified immutable package/launcher.
    """
    KEYS = {'containerId', 'imageId', 'configDigest', 'hostConfigDigest', 'mountsDigest',
            'initPid', 'initStart', 'uid', 'gid', 'bootstrap', 'node', 'codeFiles'}

    def __init__(self, engine, selection):
        need(type(selection) is dict and set(selection) == self.KEYS, 'WEBSITE_FACT_SELECTION_SCHEMA')
        for key in ('containerId', 'configDigest', 'hostConfigDigest', 'mountsDigest'):
            need(type(selection[key]) is str and len(selection[key]) == 64
                 and all(c in '0123456789abcdef' for c in selection[key]), 'WEBSITE_FACT_DIGEST')
        need(type(selection['imageId']) is str and selection['imageId'].startswith('sha256:')
             and len(selection['imageId']) == 71 and all(c in '0123456789abcdef' for c in selection['imageId'][7:]), 'WEBSITE_IMAGE_ID')
        need((selection['initPid'] is None and selection['initStart'] is None) or
             (type(selection['initPid']) is int and selection['initPid'] > 1
              and type(selection['initStart']) is int and selection['initStart'] > 0), 'WEBSITE_INIT_SELECTION')
        self.engine, self.selection, self.binding = engine, copy.deepcopy(selection), None
        self.initial = None
        self.code_cache = {}
        files = selection['codeFiles']
        need(type(files) is dict and 1 <= len(files) <= 4096, 'IMMUTABLE_CODE_MANIFEST_REQUIRED')
        total = 0
        for path, expected in files.items():
            need(type(path) is str and path.startswith('/nix/store/') and str(Path(path)) == path and '..' not in Path(path).parts,
                 'IMMUTABLE_CODE_PATH')
            need(type(expected) is dict and set(expected) == {'sha256', 'bytes'} and type(expected['bytes']) is int
                 and 0 <= expected['bytes'] <= MAX_CODE_FILE and type(expected['sha256']) is str
                 and len(expected['sha256']) == 64 and all(c in '0123456789abcdef' for c in expected['sha256']), 'IMMUTABLE_CODE_BINDING')
            total += expected['bytes']
        need(total <= MAX_CODE_TOTAL, 'IMMUTABLE_CODE_TOTAL_BOUND')
        for stage in ('bootstrap', 'node'):
            value = selection[stage]
            need(type(value) is dict and set(value) == {'executable', 'argv'} and type(value['argv']) is list
                 and 1 <= len(value['argv']) <= 32 and all(type(x) is str and 0 < len(x) <= 4096 and '\0' not in x for x in value['argv']),
                 'FIXED_WEBSITE_PROGRAM')
            _program_invocation(value['executable'], value['argv'], files)
            for argument in value['argv'][1:]:
                if argument.startswith('/nix/store/'):
                    need(str(Path(argument).resolve(strict=True)) in files, 'UNMANIFESTED_BACKEND_ARGV_CODE')
        need(type(selection['uid']) is int and type(selection['gid']) is int
             and selection['uid'] == os.getuid() and selection['gid'] == os.getgid()
             and os.getuid() > 0, 'ORDINARY_OWNER_WEBSITE_REQUIRED')

    def _item(self):
        self.engine.guard()
        v = self.selection
        item = self.engine.get('/containers/'+v['containerId']+'/json')
        need(item['Id'] == v['containerId'] and item['Image'] == v['imageId']
             and item['State']['Running'] is True and type(item['State']['Pid']) is int and item['State']['Pid'] > 1
             and item['Config']['User'] == str(v['uid'])+':'+str(v['gid'])
             and digest(item['Config']) == v['configDigest'] and digest(host_config(item['HostConfig'])) == v['hostConfigDigest']
             and digest(mounts(item['Mounts'])) == v['mountsDigest'], 'WEBSITE_FULL_SPEC_CHANGED')
        protected_backend(item)
        return item

    def bind_once(self):
        need(self.binding is None, 'WEBSITE_BINDING_NO_REPLAY')
        item = self._item(); initial = read_proc(item['State']['Pid'])
        if self.selection['initPid'] is not None or self.selection['initStart'] is not None:
            need((self.selection['initPid'], self.selection['initStart']) == (initial['pid'], initial['start']), 'WEBSITE_INITIAL_BINDING_CHANGED')
        self.binding = {**copy.deepcopy(self.selection), 'initPid': initial['pid'], 'initStart': initial['start']}
        self.initial = initial
        self.inspect()
        self.qualify_code()
        return copy.deepcopy(self.binding)

    def inspect(self):
        need(self.binding is not None, 'WEBSITE_BINDING_UNAVAILABLE')
        item = self._item(); initial = read_proc(self.binding['initPid'])
        need(item['State']['Pid'] == initial['pid'] and initial == self.initial, 'WEBSITE_INIT_CHANGED')
        again = self._item()
        need(again['State']['Pid'] == initial['pid'] and read_proc(initial['pid']) == initial, 'WEBSITE_NATIVE_RACE')
        self.engine.guard()
        return item

    def qualify_file(self, path):
        need(path in self.selection['codeFiles'], 'UNMANIFESTED_BACKEND_CODE')
        expected = self.selection['codeFiles'][path]
        host = Path(path)
        need(host.resolve(strict=True) == host, 'CANONICAL_HOST_CODE_REQUIRED')
        hostfd = os.open(host, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
        root = guest = None
        try:
            trusted = os.fstat(hostfd)
            need(stat.S_ISREG(trusted.st_mode) and trusted.st_uid == 0 and not trusted.st_mode & 0o222
                 and trusted.st_size == expected['bytes'], 'IMMUTABLE_HOST_CODE_REQUIRED')
            root = os.open('/proc/'+str(self.binding['initPid'])+'/root', os.O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
            guest = open_in_root(root, path)
            actual = os.fstat(guest)
            need(stat.S_ISREG(actual.st_mode) and not actual.st_mode & 0o222
                 and actual.st_uid == mapped_root_uid(self.binding['initPid']) and actual.st_size == expected['bytes']
                 and os.fstatvfs(guest).f_flag & os.ST_RDONLY, 'PROTECTED_IMAGE_CODE_REQUIRED')
            stamp = lambda value: (value.st_dev,value.st_ino,value.st_mode,value.st_uid,value.st_size,value.st_mtime_ns,value.st_ctime_ns)
            key = (path, stamp(trusted), stamp(actual))
            if self.code_cache.get(path) != key:
                for fd in (hostfd, guest):
                    hasher, count = hashlib.sha256(), 0
                    while data := os.read(fd, min(1024**2, MAX_CODE_FILE + 1 - count)):
                        count += len(data); need(count <= MAX_CODE_FILE, 'BACKEND_CODE_BOUND'); hasher.update(data)
                    need(count == expected['bytes'] and hasher.hexdigest() == expected['sha256'], 'BACKEND_CODE_BYTES_CHANGED')
                need(stamp(os.fstat(hostfd)) == stamp(trusted) and stamp(os.fstat(guest)) == stamp(actual), 'BACKEND_CODE_READ_CHANGED')
                self.code_cache[path] = key
            return actual.st_dev, actual.st_ino
        finally:
            if guest is not None: os.close(guest)
            if root is not None: os.close(root)
            os.close(hostfd)

    def qualify_code(self):
        self.inspect()
        for path in self.selection['codeFiles']:
            self.qualify_file(path)
        self.inspect()

    def qualify_alias(self, path, executable):
        """Only the exact immutable host's link chain, never generic guest links.

        pythonInvocation may be a Nix env symlink; pythonExecutable is canonical.
        The argv spelling remains exact while every allowed guest link and the
        final immutable bytes/inode are independently checked in that namespace.
        """
        need(type(path) is str and path.startswith('/nix/store/') and Path(path).resolve(strict=True) == Path(executable),
             'FIXED_INVOCATION_ALIAS_REQUIRED')
        root = os.open('/proc/'+str(self.binding['initPid'])+'/root', os.O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
        current, pending, links = Path('/'), deque(Path(path).parts[1:]), 0
        try:
            while pending:
                current = current / pending.popleft()
                info = current.lstat()
                need(info.st_uid == 0, 'IMMUTABLE_HOST_ALIAS_REQUIRED')
                if stat.S_ISLNK(info.st_mode):
                    links += 1; need(links <= 32 and str(current).startswith('/nix/store/'), 'INVOCATION_LINK_BOUND')
                    expected = os.readlink(current)
                    fd = open_in_root(root, str(current), path_link=True)
                    try:
                        actual = os.fstat(fd)
                        need(stat.S_ISLNK(actual.st_mode) and actual.st_uid == mapped_root_uid(self.binding['initPid'])
                             and os.fstatvfs(fd).f_flag & os.ST_RDONLY and os.readlink('', dir_fd=fd) == expected,
                             'IMAGE_INVOCATION_ALIAS_CHANGED')
                    finally:
                        os.close(fd)
                    target = Path(os.path.normpath(expected if expected.startswith('/') else str(current.parent / expected)))
                    need(str(target).startswith('/nix/store/'), 'INVOCATION_ALIAS_ESCAPES_CODE_ROOT')
                    pending = deque([*target.parts[1:], *pending]); current = Path('/')
                elif pending:
                    need(stat.S_ISDIR(info.st_mode), 'HOST_INVOCATION_PARENT_CHANGED')
            need(current == Path(executable), 'INVOCATION_TARGET_CHANGED')
        finally:
            os.close(root)
        return self.qualify_file(executable)

    def program(self, executable, argv):
        return NamespaceProgram(executable, tuple(argv), self)


class NamespaceProgram(Program):
    """Host immutable bytes and guest inode are deliberately different facts."""
    def __init__(self, executable, argv, facts):
        need(type(facts) is WebsiteFacts and facts.binding is not None, 'BOUND_WEBSITE_FACTS_REQUIRED')
        need(type(executable) is str and executable in facts.selection['codeFiles'] and type(argv) is tuple
             and 1 <= len(argv) <= 32 and all(type(v) is str and 0 < len(v) <= 4096 and '\0' not in v for v in argv),
             'FIXED_MANIFESTED_PROGRAM_REQUIRED')
        _program_invocation(executable, argv, facts.selection['codeFiles'])
        for value in argv[1:]:
            if value.startswith('/nix/store/'):
                need(str(Path(value).resolve(strict=True)) in facts.selection['codeFiles'], 'UNMANIFESTED_BACKEND_ARGV_CODE')
        object.__setattr__(self, 'facts', facts)
        super().__init__(executable, argv)

    def matches(self, process):
        self.facts.inspect()
        declared = str(Path(self.argv[0]).resolve(strict=True))
        identity = self.facts.qualify_alias(self.argv[0], declared)
        if declared != self.executable:
            # Qualify BOTH guest files; the actual guest executable inode remains
            # distinct from host Nix-store and from the wrapper's copied inode.
            identity = self.facts.qualify_file(self.executable)
        for value in self.argv[1:]:
            if value.startswith('/nix/store/'):
                self.facts.qualify_alias(value, str(Path(value).resolve(strict=True)))
        need(process['exe'] == identity and process['argv'] ==
             hashlib.sha256(b'\0'.join(value.encode() for value in self.argv)+b'\0').hexdigest(), 'PROGRAM_CHANGED')
        self.facts.inspect()


class ProtectedPeer(WebsitePeer):
    """Existing R2 kernel peer/ancestry/program proof plus fixed full facts.

    No cookie, owner scope, entitlement, purpose or capability crosses this API.
    A separate actor may additionally check its protected root/ledger custody.
    """
    def __init__(self, facts):
        need(type(facts) is WebsiteFacts and facts.binding is not None, 'BOUND_WEBSITE_FACTS_REQUIRED')
        self.facts = facts; v = facts.binding
        super().__init__(facts.engine.path, v['containerId'], v['imageId'], v['configDigest'],
                         v['initPid'], v['initStart'], v['uid'], v['gid'],
                         facts.program(v['bootstrap']['executable'], tuple(v['bootstrap']['argv'])),
                         facts.program(v['node']['executable'], tuple(v['node']['argv'])))

    def with_bootstrap(self, program):
        need(isinstance(program, Program), 'FIXED_BOOTSTRAP_PROGRAM_REQUIRED')
        selected = copy.copy(self)
        object.__setattr__(selected, 'bootstrap', self.facts.program(program.executable, program.argv))
        return selected

    def inspect(self): return self.facts.inspect()

    def assert_process(self, credentials, stage):
        value = super().assert_process(credentials, stage)
        with (Path('/proc') / str(credentials[0]) / 'status').open('rb') as stream:
            raw = stream.read(65537)
        need(len(raw) <= 65536, 'BACKEND_STATUS_BOUND')
        fields = dict(line.split(':', 1) for line in raw.decode('ascii').splitlines() if ':' in line)
        need(fields.get('NoNewPrivs', '').strip() == '1' and
             all(int(fields[key].strip(), 16) == 0 for key in ('CapInh', 'CapPrm', 'CapEff', 'CapAmb', 'CapBnd')),
             'BACKEND_KERNEL_PRIVILEGE_CHANGED')
        need(read_proc(credentials[0]) == value, 'BACKEND_STATUS_RACE')
        return value
