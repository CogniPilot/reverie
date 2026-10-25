"""Seed a private laptop Nix store using only a reviewed image's own closure."""
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import time
try:
    from .worker_storage import storage_paths, lock_paths, read_metadata, validate_storage
except ImportError:
    import sys
    package_root=str(Path(__file__).resolve().parents[1])
    if package_root not in sys.path:sys.path.insert(0,package_root)
    from reverie.worker_storage import storage_paths, lock_paths, read_metadata, validate_storage

SESSION = re.compile(r'^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$')


def session_directory(config, session_id):
    if not isinstance(session_id, str) or not SESSION.fullmatch(session_id):
        raise ValueError('Invalid Nix store session identity')
    root = Path(config['stateRoot'])
    if root.resolve() != root or root.is_relative_to(Path(config['scratchRoot']).resolve()):
        raise ValueError('Laptop state must be durable and outside scratch')
    if any(root.is_relative_to(Path(m['source']).resolve()) for m in config.get('mounts', [])):
        raise ValueError('Laptop state must be outside shared mounts')
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    root_info = root.lstat()
    if not stat.S_ISDIR(root_info.st_mode) or root_info.st_uid != config['uid'] or root_info.st_mode & 0o077:
        raise ValueError('Laptop state root must be a private directory owned by its user')
    directory = root / session_id
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = directory.lstat()
    if directory.resolve() != directory or not stat.S_ISDIR(info.st_mode) or info.st_uid != config['uid'] or info.st_mode & 0o077:
        raise ValueError('Laptop state must be a private directory owned by its user')
    return directory


def check_storage_fences(config,session_id,directory):
    """Shared by startup locking and actual store selection; no empty fallback."""
    paths=storage_paths(config,session_id)
    fence=directory/'nix-migration.json'
    if fence.exists() or fence.is_symlink():
        marker=read_metadata(fence,config['uid'],limit=65536)
        allowed=(paths.kind=='employee' and isinstance(marker,dict) and
                 set(marker)=={'version','token','employeeId','sessionId','state'} and
                 type(marker['version']) is int and marker['version']==2 and
                 marker['employeeId']==paths.identity and marker['sessionId']==session_id and
                 marker['state']=='employee-canonical' and isinstance(marker['token'],str) and
                 re.fullmatch('[0-9a-f]{32}',marker['token']))
        if not allowed:raise RuntimeError('Laptop Nix migration is fenced; owner must finish or roll it back')
        validate_storage(config,paths)
    if paths.kind=='employee':
        _stable,employee_fence=lock_paths(config,paths)
        if employee_fence.exists() or employee_fence.is_symlink():raise RuntimeError('Employee laptop data is fenced')
    return paths


@contextmanager
def store_guard(config, session_id, *, migration=False):
    """Serialize container creation with owner migration, including helper startup."""
    directory = session_directory(config, session_id)
    fd = os.open(directory / 'nix.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != config['uid'] or info.st_mode & 0o077:
            raise ValueError('Invalid laptop Nix lock')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if not migration:check_storage_fences(config,session_id,directory)
        yield directory
    finally:
        os.close(fd)


def store_path(config, session_id):
    """Only the owner can opt one laptop back into its fixed legacy location."""
    if not isinstance(session_id, str) or not SESSION.fullmatch(session_id):
        raise ValueError('Invalid Nix store session identity')
    paths=storage_paths(config,session_id)
    if paths.kind=='employee':
        # SID-era rollback markers can never redirect a permanent employee to
        # a stale home/store after a later transport has written canonical data.
        return paths.nix
    directory = Path(config['stateRoot']) / session_id
    rollback = directory / 'nix-rollback.json'
    if rollback.exists() or rollback.is_symlink():
        info = rollback.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != config['uid'] or info.st_mode & 0o077:
            raise ValueError('Invalid owner Nix rollback marker')
        if json.loads(rollback.read_text()) != {'version': 1, 'sessionId': session_id, 'legacy': True}:
            raise ValueError('Invalid owner Nix rollback identity')
        return Path(config['scratchRoot']) / session_id / 'nix'
    return directory / 'nix'


def private_store(config, session_id):
    directory = session_directory(config, session_id)
    paths=check_storage_fences(config,session_id,directory)
    path = store_path(config, session_id)
    if paths.kind=='employee':
        validate_storage(config,paths)
    legacy = Path(config['scratchRoot']) / session_id / 'nix'
    if path == legacy and not path.exists():
        raise RuntimeError('Selected laptop rollback store is unavailable; refusing an empty replacement')
    if path != legacy and not path.exists() and (legacy.exists() or legacy.is_symlink()):
        raise RuntimeError('Legacy laptop Nix store requires an offline migration; refusing an empty replacement')
    path.mkdir(mode=0o700, exist_ok=True)
    info = path.lstat()
    if path.resolve() != path or not stat.S_ISDIR(info.st_mode) or info.st_uid != config['uid'] or info.st_mode & 0o077:
        raise ValueError('Laptop Nix store must be a private directory owned by its user')
    return path


def prepare_args(config, session_id, path):
    """A networkless, unprivileged helper; its only writable bind is private state."""
    if not isinstance(session_id, str) or not SESSION.fullmatch(session_id):
        raise ValueError('Invalid Nix store session identity')
    expected = store_path(config, session_id)
    if path != expected:
        raise ValueError('Nix store is outside this laptop private state directory')
    name = config['deployment'] + '-nix-prepare-' + session_id
    args = ['create', '--name', name, '--init', '--read-only', '--cap-drop', 'ALL',
            '--security-opt', 'no-new-privileges', '--network', 'none',
            '--user', f"{config['uid']}:{config['gid']}",
            '--label', 'reverie.nix-prepare=' + config['deployment'],
            '--label', 'reverie.session=' + session_id,
            '--memory', '512m', '--memory-swap', '512m', '--pids-limit', '128', '--cpus', '1',
            '--tmpfs', '/tmp:rw,nosuid,nodev,size=268435456,mode=1777',
            '--tmpfs', '/nix/store/.links:rw,nosuid,nodev,size=1048576,mode=1777',
            '--mount', f'type=bind,src={path},dst=/target/nix',
            '--env', 'HOME=/tmp/nix-bootstrap-home', '--env', 'TMPDIR=/tmp',
            '--entrypoint', '/bin/reverie-nix-store-prepare', config['image']]
    if config['budgetMode'] == 'pool':
        args[1:1] = ['--cgroup-parent', config['cgroupParent']]
    for mount in config['mounts']:
        if mount['destination'] in ('/etc/passwd', '/etc/group') and mount['readOnly']:
            args[1:1] = ['--mount', f"type=bind,src={mount['source']},dst={mount['destination']},readonly"]
    return name, args


def prepare_store(broker, config, session_id, timeout=300):
    image = json.loads(broker.run_engine(['image', 'inspect', config['image']]).stdout)[0]
    if (image['Config'].get('Labels') or {}).get('reverie.worker.nix-store') != '1':
        return None  # Existing images remain usable during a rolling upgrade.
    path = private_store(config, session_id)
    name, args = prepare_args(config, session_id, path)
    deadline = time.monotonic() + timeout
    while not broker.nix_prepare_lock.acquire(timeout=.25):
        if broker.stopping.is_set() or time.monotonic() >= deadline or not broker.allowed(session_id):
            raise RuntimeError('Laptop Nix preparation cancelled before admission')
    created = None
    try:
        if broker.stopping.is_set() or not broker.allowed(session_id):
            raise RuntimeError('Laptop Nix preparation was cancelled')
        previous = broker.run_engine(['inspect', name], optional=True)
        if previous.returncode == 0:
            old = json.loads(previous.stdout)[0]
            labels = old['Config']['Labels'] or {}
            if labels.get('reverie.nix-prepare') != config['deployment'] or labels.get('reverie.session') != session_id:
                raise RuntimeError('Nix preparation name is owned by another deployment')
            if old['State']['Running']:
                raise RuntimeError('A previous laptop Nix preparation is still running')
            broker.run_engine(['rm', old['Id']])
        created = broker.run_engine(args).stdout.strip()
        if len(created) != 64 or any(c not in '0123456789abcdef' for c in created):
            created = None
            raise RuntimeError('Invalid Nix preparation container identity')
        broker.run_engine(['start', created])
        while True:
            state = json.loads(broker.run_engine(['inspect', created]).stdout)[0]['State']
            if not state['Running']:
                if state['ExitCode'] != 0:
                    raise RuntimeError('Laptop Nix store preparation failed; private diagnostics retained')
                break
            if broker.stopping.is_set() or time.monotonic() >= deadline or not broker.allowed(session_id):
                raise RuntimeError('Laptop Nix store preparation cancelled or timed out')
            broker.stopping.wait(.5)
        return path
    finally:
        try:
            if created:
                # No credentials, accounts or projects are mounted into this helper.
                try:
                    logs = broker.run_engine(['logs', '--tail', '100', created], optional=True)
                    log = Path(config['stateRoot']) / session_id / 'home/.reverie-nix-prepare.log'
                    fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
                    with os.fdopen(fd, 'w') as out:
                        out.write((logs.stdout + logs.stderr)[-16384:])
                finally:
                    broker.run_engine(['rm', '--force', created], optional=True)
        finally:
            broker.nix_prepare_lock.release()
