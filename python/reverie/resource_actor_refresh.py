"""Owner-local transport proof for explicit facts refresh, never an RPC grant."""
import hashlib
import os
from pathlib import Path
import re
import socket
import stat
import struct
import time

from .goal_private import private_entry
from .owner_terminal_channel import Program, read_proc
from .website_image_provenance import immutable
from .worker_service_transport_upgrade import IsolatedInterpreterObserver, _immutable as interpreter_file


def _generation_root(service, target):
    """The existing owner registration retains its own immutable generation."""
    path = service.gcroot
    parent = path.parent.lstat()
    info = path.lstat()
    if (path.parent.resolve(strict=True) != path.parent or not stat.S_ISDIR(parent.st_mode)
            or parent.st_uid != os.getuid() or parent.st_mode & 0o077
            or not stat.S_ISLNK(info.st_mode) or info.st_uid != os.getuid()
            or os.readlink(path) != str(service.store_root(target))
            or path.resolve(strict=True) != service.store_root(target)):
        raise ValueError('Existing private broker generation root differs')
    return (info.st_dev, info.st_ino, info.st_uid, info.st_gid, info.st_mode,
            info.st_mtime_ns, info.st_ctime_ns, os.readlink(path),
            parent.st_dev, parent.st_ino, parent.st_uid, parent.st_gid, parent.st_mode)


def _python_graph(entry):
    """Compare bounded immutable Python inputs, independent of website assets."""
    from .worker_service import STORE_ROOT
    if entry.parts[-3:] != ('python', 'reverie', 'worker.py'):
        raise ValueError('Fixed registered broker source layout required')
    root = entry.parent.parent
    if not root.is_relative_to(STORE_ROOT) or root.resolve(strict=True) != root:
        raise ValueError('Canonical registered Python source required')
    result = {}; total = 0; count = 0; pending = [root]
    while pending:
        with os.scandir(pending.pop()) as entries:
            for entry in entries:
                count += 1
                if count > 4096 or entry.is_symlink():
                    raise ValueError('Bounded regular registered Python source required')
                path = Path(entry.path)
                if entry.is_dir(follow_symlinks=False):
                    pending.append(path)
                    continue
                path = immutable(path, 16 * 1024**2)
                raw = path.read_bytes(); total += len(raw)
                if total > 64 * 1024**2:
                    raise ValueError('Registered Python source graph exceeds bound')
                result[str(path.relative_to(root))] = hashlib.sha256(raw).hexdigest()
    if 'reverie/worker.py' not in result:
        raise ValueError('Registered broker source graph is incomplete')
    return result


def _registered_program(service, invocation, entry):
    """Resolve only the existing private registration, never a caller program.

    A website-only rebuild changes the whole source store path. An installed
    broker can remain registered when its complete Python inputs are unchanged;
    Python changes still require a coordinated broker-generation upgrade.
    """
    target = service.target_unit()
    if not service.unit.is_symlink():
        raise ValueError('Existing registered broker unit required')
    installed = service.unit.resolve(strict=True)
    _generation_root(service, installed)
    from .worker_service import STORE_ROOT
    from .worker_service_upgrade import unit_record
    immutable(installed, 8192)
    record = unit_record(service, installed)
    wrapper = immutable(record['entries']['ExecStart']['path'], 8192)
    lines = [line for line in wrapper.read_text().splitlines() if line]
    if (len(lines) != 6 or not re.fullmatch('#!' + re.escape(str(STORE_ROOT)) + r'/[^/\s]+/bin/bash', lines[0])
            or lines[1:4] != ['set -o errexit', 'set -o nounset', 'set -o pipefail']):
        raise ValueError('Fixed isolated registered broker wrapper required')
    prefix = re.escape(str(STORE_ROOT)) + r'/[^/\s"$;`]+/bin'
    if not re.fullmatch(r'export PATH="' + prefix + r'(?::' + prefix + r')*:\$PATH"', lines[4]):
        raise ValueError('Fixed registered broker tool path required')
    match = re.fullmatch(r'exec (' + prefix + r'/python3) -I -B (' +
                         re.escape(str(STORE_ROOT)) + r'/[^/\s"$;`]+/python/reverie/worker\.py) broker "\$@"', lines[-1])
    if match is None:
        raise ValueError('Fixed isolated registered broker invocation required')
    previous_invocation, previous_entry = map(Path, match.groups())
    immutable(previous_invocation.resolve(strict=True), 256 * 1024**2)
    immutable(previous_entry, 16 * 1024**2)
    if ((installed == target and previous_entry != entry) or
            (installed != target and _python_graph(previous_entry) != _python_graph(entry))):
        raise ValueError('Registered broker Python inputs differ; coordinated upgrade required')
    return previous_invocation, previous_entry, installed


class RegisteredTransport:
    """Hold the existing registered broker peer through a metadata-only refresh.

    No frame is sent. Service selection, private config, kernel peer credentials,
    fixed program and socket/process incarnation must all remain unchanged.
    """
    def __init__(self, service, config):
        self.service, self.config = service, config
        self.socket = None
        invocation = Path(os.environ.get('REVERIE_WORKER_SERVICE_PYTHON', ''))
        entry = Path(os.environ.get('REVERIE_WORKER_SERVICE_ENTRY', ''))
        # Interpreter invocation may be a Nix-owned symlink to its immutable ELF.
        immutable(invocation.resolve(strict=True), 256 * 1024**2)
        entry = immutable(entry, 16 * 1024**2)
        if not invocation.is_absolute() or not str(invocation).startswith('/nix/store/'):
            raise ValueError('Fixed packaged broker invocation required')
        expected_invocation = invocation
        invocation, entry, self.target = _registered_program(service, invocation, entry)
        # A makeBinaryWrapper is an ELF program, not necessarily a symlink to
        # the interpreter the kernel ultimately runs. Observe both the fixed
        # current tool and the actual registered wrapper's declared invocation.
        self.interpreter_observer = IsolatedInterpreterObserver(time.monotonic() + 15)
        expected = self.interpreter_observer.observe(expected_invocation)
        self.interpreter = (expected if invocation == expected_invocation else
                            self.interpreter_observer.observe(invocation))
        if (self.interpreter['executable'] != expected['executable'] or
                self.interpreter['exeIdentity'] != expected['exeIdentity']):
            raise ValueError('Registered broker interpreter ABI differs; coordinated upgrade required')
        self.program = Program(self.interpreter['executable'], (self.interpreter['argv0'], '-I', '-B', str(entry),
                                                'broker', '--config', str(service.config_path)))
        self.selection = self.observe()
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.socket = sock
        try:
            sock.settimeout(2)
            sock.connect(config['socket'])
            self.credentials = struct.unpack('3i', sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            if self.credentials != (self.selection['pid'], os.getuid(), os.getgid()):
                raise ValueError('Registered broker kernel peer differs')
            self.guard()
        except BaseException:
            self.close()
            raise

    def observe(self):
        from .worker_service import environment_selection
        from .worker import load_config
        service = self.service
        if not service.unit.is_symlink() or service.unit.resolve(strict=True) != self.target:
            raise ValueError('Reviewed broker service generation is not installed')
        env = private_entry(str(service.environment), limit=65536)
        if env[1] != environment_selection(service.config_path).encode():
            raise ValueError('Installed private broker selection differs')
        selected = private_entry(str(service.config_path), limit=1024 * 1024)
        if load_config(service.config_path) != self.config or private_entry(str(service.config_path), limit=1024 * 1024) != selected:
            raise ValueError('Private broker configuration changed')
        result = service.manager('show', 'reverie-worker-broker.service',
                                 '--property=MainPID,FragmentPath,DropInPaths,ActiveState,SubState')
        fields = {}
        for line in result.stdout.splitlines():
            key, separator, value = line.partition('=')
            if not separator or key in fields:
                raise ValueError('Exact registered broker properties required')
            fields[key] = value
        if (set(fields) != {'MainPID', 'FragmentPath', 'DropInPaths', 'ActiveState', 'SubState'} or
                fields['DropInPaths'] or fields['ActiveState'] != 'active' or fields['SubState'] != 'running' or
                Path(fields['FragmentPath']).resolve(strict=True) != self.target or
                not fields['MainPID'].isdecimal() or int(fields['MainPID']) <= 1):
            raise ValueError('Unmodified running registered broker required')
        invocation = Path(self.interpreter['declared'])
        actual = interpreter_file(invocation, executable=True)
        if (actual['canonical'] != self.interpreter['invocation'] or
                actual['signature'] != self.interpreter['identitySignature'] or
                actual['sha256'] != self.interpreter['sha256'] or
                actual['identity'] != self.interpreter['identity']):
            raise ValueError('Registered declared interpreter changed')
        pid = int(fields['MainPID']); process = read_proc(pid)
        self.program.matches(process)
        path = Path(self.config['socket'])
        if path.resolve(strict=True) != path or path.parent.resolve(strict=True) != path.parent:
            raise ValueError('Canonical private broker socket required')
        parent, info = path.parent.stat(), path.lstat()
        if (parent.st_uid != os.getuid() or parent.st_mode & 0o077 or
                not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid() or
                info.st_mode & 0o077 or info.st_nlink != 1):
            raise ValueError('Private owner broker socket required')
        if read_proc(pid) != process:
            raise ValueError('Broker incarnation changed')
        return {'pid': pid, 'process': process, 'config': selected, 'environment': env,
                'socket': (info.st_dev, info.st_ino, info.st_uid, info.st_gid, info.st_mode),
                'unit': fields, 'generationRoot': _generation_root(service, self.target)}

    def guard(self):
        if self.observe() != self.selection:
            raise ValueError('Registered broker transport changed during refresh')
        if self.socket is None or struct.unpack('3i', self.socket.getsockopt(
                socket.SOL_SOCKET, socket.SO_PEERCRED, 12)) != self.credentials:
            raise ValueError('Registered broker peer changed during refresh')

    def close(self):
        sock, self.socket = self.socket, None
        if sock is not None:
            sock.close()

    def finalize(self):
        self.guard()
        self.close()
