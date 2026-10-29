"""Explicit ordinary-owner installation, never invoked by a browser or worker.

Install only an already reviewed private policy and a fixed immutable launcher.
No engine mutation, website replacement, service start or laptop wake. A new
website must use the separately packaged Python->Node two-phase entrypoint and
exact read-only bootstrap mount; an ordinary website cannot self-enroll.
"""
import os
from pathlib import Path
import stat

from .owner_terminal_native import Installation, physical
from .human_shell_capabilities import open_directory


UNIT = 'reverie-owner-terminal.service'


def need(ok, message):
    if not ok:
        raise ValueError(message)


def quoted(value):
    need(type(value) is str and value.startswith('/') and not any(c in value for c in '\n\r\0%'), 'Fixed absolute path required')
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"') + '"'


def unit_text(policy, launcher):
    # Existing protected directories must already be owner-selected outside all
    # worker grants. This operation never repairs permissions on a live root.
    lock_paths = []
    if getattr(policy, 'value', {}).get('version') == 2:
        from .owner_terminal_resource_binding import locking_paths
        lock_paths = locking_paths(policy.config)
    from .owner_terminal_resource_binding import require_disjoint_roots
    require_disjoint_roots(getattr(policy, 'config', {}), policy.roots.values())
    return '\n'.join([
        '[Unit]', 'Description=Reverie protected owner human-terminal H service',
        'StartLimitBurst=1', 'StartLimitIntervalSec=infinity',
        '[Service]', 'Type=simple', 'Restart=no', 'UMask=0077',
        'ExecStart=' + quoted(str(launcher)) + ' --policy ' + quoted(str(policy.path)),
        'UnsetEnvironment=LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT LD_ORIGIN_PATH GLIBC_TUNABLES GCONV_PATH BASH_ENV ENV PYTHONPATH PYTHONHOME NODE_OPTIONS NODE_PATH OPENSSL_CONF OPENSSL_MODULES',
        'NoNewPrivileges=true', 'ProtectSystem=strict', 'ProtectHome=read-only', 'PrivateTmp=true',
        'RestrictAddressFamilies=AF_UNIX', 'MemoryMax=256M', 'MemorySwapMax=0', 'TasksMax=64',
        'TimeoutStopSec=30', 'KillMode=control-group',
        'ReadWritePaths=' + ' '.join(quoted(str(path)) for path in [*policy.roots.values(), *lock_paths]),
        '[Install]', 'WantedBy=default.target', '',
    ])


def install(policy_path, expected, launcher, *, home=None):
    need(os.geteuid() != 0 and os.getuid() == os.geteuid(), 'Use the ordinary owner user-service account')
    policy = Installation(policy_path, expected)
    launcher = physical(launcher)
    info = launcher.stat()
    need(str(launcher).startswith('/nix/store/') and stat.S_ISREG(info.st_mode) and info.st_uid == 0
         and not info.st_mode & 0o222 and info.st_mode & 0o111, 'Immutable installed launcher required')
    home = physical(home if home is not None else Path.home())
    directory = home / '.config/systemd/user'
    # Never follow a newly selected home/config symlink or adopt a foreign unit.
    current = open_directory(home)
    try:
        for part in ('.config', 'systemd', 'user'):
            try:
                os.mkdir(part, 0o700, dir_fd=current); os.fsync(current)
            except FileExistsError:
                pass
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=current)
            info = os.fstat(child)
            if info.st_uid != os.getuid() or info.st_mode & 0o022:
                os.close(child)
                raise ValueError('Owned real unit directory required')
            os.close(current); current = child
        root = open_directory(policy.roots['controlRoot'])
        try:
            try:
                os.mkdir('docker', 0o700, dir_fd=root); os.fsync(root)
            except FileExistsError:
                pass
        finally:
            os.close(root)
        docker = open_directory(policy.roots['controlRoot'] / 'docker')
        try:
            info = os.fstat(docker)
            need(info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700, 'Private empty engine configuration required')
            with os.scandir(docker) as entries:
                need(next(entries, None) is None, 'Private engine configuration must be empty')
        finally:
            os.close(docker)
        policy.guard()
    except BaseException:
        os.close(current)
        raise
    try:
        path = directory / UNIT
        raw = unit_text(policy, launcher).encode()
        need(not os.path.lexists(path), 'Prior owner-terminal unit must be preserved and explicitly reviewed')
        fd = os.open(UNIT, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=current)
        try:
            with os.fdopen(fd, 'wb', closefd=False) as stream:
                stream.write(raw); stream.flush(); os.fsync(fd)
        finally:
            os.close(fd)
        os.fsync(current)
        again = open_directory(directory)
        try:
            need((os.fstat(again).st_dev, os.fstat(again).st_ino) == (os.fstat(current).st_dev, os.fstat(current).st_ino),
                 'Installed unit parent changed; retain evidence')
        finally:
            os.close(again)
    finally:
        os.close(current)
    # Deliberately no daemon-reload/enable/start. The owner reviews this concrete
    # unit alongside the new website spec and native capacity/custody evidence.
    return {'installedUnit': str(path), 'started': False, 'enabled': False,
            'websiteMount': {'source': str(policy.roots['bootstrapRoot']),
                             'destination': '/run/reverie-owner-terminal', 'readOnly': True}}
