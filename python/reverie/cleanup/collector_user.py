"""Opt-in USER observations. This never adopts the root collector or grants effects."""
import argparse
import contextlib
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

MARKER = b'{"application":"reverie-user-observations","version":1}\n'
UNIT = 'reverie-observations'
MAX_CONFIG = 16384


def sibling(name):
    path = Path(__file__).resolve().with_name(name + '.py')
    spec = importlib.util.spec_from_file_location('_observations_' + name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def canonical(value):
    p = Path(value)
    if not p.is_absolute() or str(p) != value or '..' in p.parts or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError('Canonical absolute path required')
    return p


def ancestry(path):
    """Owner home is the explicit trust anchor, never a permission to adopt /tmp."""
    home = Path.home().resolve(strict=True)
    if not path.is_relative_to(home) or path == home or path.resolve(strict=False) != path:
        raise ValueError('User observation paths must be real descendants of the owner home')
    for p in [home, *reversed(path.relative_to(home).parents)]:
        p = p if p == home else home / p
        if p == home or p.exists():
            s = p.lstat()
            if not stat.S_ISDIR(s.st_mode) or s.st_uid != os.getuid() or s.st_mode & 0o022:
                raise ValueError('User observation ancestry is not owned and protected')


def private_bytes(path, limit=MAX_CONFIG):
    ancestry(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        s = os.fstat(fd)
        if not stat.S_ISREG(s.st_mode) or s.st_uid != os.getuid() or s.st_nlink != 1 or s.st_mode & 0o077 or s.st_size > limit:
            raise ValueError('Private observation file custody refused')
        chunks, length = [], 0
        while True:
            piece = os.read(fd, min(262144, limit+1-length))
            if not piece: break
            chunks.append(piece); length += len(piece)
            if length > limit: raise ValueError('Private observation file bound exceeded')
        data = b''.join(chunks)
        stamp = lambda v: (v.st_dev, v.st_ino, v.st_size, v.st_mtime_ns, v.st_ctime_ns)
        if len(data) > limit or stamp(os.fstat(fd)) != stamp(s) or stamp(path.lstat()) != stamp(s):
            raise ValueError('Observation file changed or exceeded its bound')
        return data
    finally:
        os.close(fd)


def unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate configuration key')
        result[key] = value
    return result


def configuration(path):
    cfg = json.loads(private_bytes(canonical(str(path))), object_pairs_hook=unique)
    if not isinstance(cfg, dict) or set(cfg) != {'version', 'mode', 'stateDirectory', 'intervalSeconds', 'retentionDays', 'rollupRetentionDays', 'drives', 'gpuExecutable'} or type(cfg['version']) is not int or cfg['version'] != 1 or cfg['mode'] != 'user-observations':
        raise ValueError('Unsupported user observation configuration')
    state = canonical(cfg['stateDirectory']); ancestry(state)
    if state == path.parent or state.is_relative_to(path):
        raise ValueError('State must be separate from configuration')
    for key, high in [('intervalSeconds', 86400), ('retentionDays', 365), ('rollupRetentionDays', 3650)]:
        if type(cfg[key]) is not int or not (30 if key == 'intervalSeconds' else 1) <= cfg[key] <= high:
            raise ValueError('Observation limit refused')
    if not isinstance(cfg['drives'], dict) or len(cfg['drives']) > 16:
        raise ValueError('Drive labels refused')
    for label, value in cfg['drives'].items():
        if not re.fullmatch('[A-Za-z0-9][A-Za-z0-9_.-]{0,31}', label):
            raise ValueError('Drive label refused')
        canonical(value)
    gpu = cfg['gpuExecutable']
    if gpu is not None:
        executable = canonical(gpu)
        s = executable.stat()
        if not executable.is_relative_to('/nix/store') or executable.resolve() != executable or executable.name != 'nvidia-smi' or not stat.S_ISREG(s.st_mode) or s.st_uid != 0 or s.st_mode & 0o222 or not s.st_mode & 0o111:
            raise ValueError('Select a matching immutable NVIDIA tool explicitly')
    return cfg


def state_directory(cfg, create=False):
    path = canonical(cfg['stateDirectory']); ancestry(path)
    if create:
        path.mkdir(parents=True, mode=0o700, exist_ok=True)
    s = path.lstat()
    if not stat.S_ISDIR(s.st_mode) or s.st_uid != os.getuid() or s.st_mode & 0o077:
        raise ValueError('User observation state must be private')
    marker = path / '.reverie-user-observations.json'
    if create and not marker.exists() and not marker.is_symlink():
        if any(path.iterdir()):
            raise ValueError('Refusing to adopt existing observations')
        exclusive(marker, MARKER)
    if private_bytes(marker) != MARKER:
        raise ValueError('Wrong user observation marker')
    return path


def exclusive(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        with os.fdopen(fd, 'wb', closefd=False) as stream:
            stream.write(data); stream.flush(); os.fsync(fd)
    finally:
        os.close(fd)
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try: os.fsync(directory)
    finally: os.close(directory)


@contextlib.contextmanager
def operation(path):
    lock = path.parent / '.observations-control.lock'
    fd = os.open(lock, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        s = os.fstat(fd)
        if not stat.S_ISREG(s.st_mode) or s.st_uid != os.getuid() or s.st_nlink != 1 or s.st_mode & 0o077:
            raise ValueError('User observation lock refused')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally: os.close(fd)


def runtime():
    entry = Path(__file__).resolve(strict=True)
    info = entry.stat()
    if not entry.is_relative_to('/nix/store') or info.st_uid != 0 or info.st_mode & 0o222:
        raise ValueError('Service control requires the immutable packaged entry')
    value = json.loads(Path(__file__).resolve().with_name('collector-runtime.json').read_bytes())
    if set(value) != {'python', 'systemctl'}:
        raise ValueError('Fixed packaged runtime required')
    for p in value.values():
        path = canonical(p); s = path.stat()
        if not path.is_relative_to('/nix/store') or s.st_uid != 0 or s.st_mode & 0o222 or not stat.S_ISREG(s.st_mode):
            raise ValueError('Immutable packaged tools required')
    return value


def unit_text(path, cfg):
    tools = runtime()
    quote = lambda s: '"' + str(s).replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%').replace('$', '$$') + '"'
    entry = Path(__file__).resolve()
    service = '\n'.join(['[Unit]', 'Description=Reverie user resource observations (no effect authority)', '[Service]', 'Type=oneshot', 'UMask=0077',
        'ExecStart=' + ' '.join(quote(x) for x in [tools['python'], '-I', '-B', entry, '--config', path, 'sample']),
        'TimeoutStartSec=90', 'TimeoutStopSec=5', 'MemoryMax=256M', 'MemorySwapMax=0', 'TasksMax=32', 'CPUQuota=50%',
        'NoNewPrivileges=yes', 'Nice=19', 'MemoryAccounting=yes', 'TasksAccounting=yes', 'CPUAccounting=yes',
        'KillMode=control-group', 'SendSIGKILL=yes', 'ProtectSystem=strict', 'ReadWritePaths=' + quote(cfg['stateDirectory']), '',
    ])
    timer = '\n'.join(['[Unit]', 'Description=Reverie periodic user observations', '[Timer]', 'OnBootSec='+str(cfg['intervalSeconds']),
        'OnUnitActiveSec='+str(cfg['intervalSeconds']), 'AccuracySec=5s', 'Persistent=false', 'Unit='+UNIT+'.service', '[Install]', 'WantedBy=timers.target', ''])
    return service, timer


def verify_service():
    """Fail before sampling if the fixed user unit/kernel budget is not active."""
    result = subprocess.run([runtime()['systemctl'], '--user', 'show', UNIT+'.service',
        '--property=MainPID,ControlGroup,TimeoutStartUSec,TimeoutStopUSec'], capture_output=True, text=True, check=True, timeout=3)
    if len(result.stdout) > 8192: raise ValueError('Unit observation bound exceeded')
    rows = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
    group = rows.get('ControlGroup', '')
    if rows.get('MainPID') != str(os.getpid()) or not group.startswith('/') or '..' in Path(group).parts:
        raise ValueError('Not the actual collector service process')
    def seconds(text):
        parts = re.findall(r'(\d+(?:\.\d+)?)(us|ms|min|s|h)', text)
        if not parts or re.sub(r'\d+(?:\.\d+)?(?:us|ms|min|s|h)|\s+', '', text): raise ValueError('Unknown unit duration')
        return sum(float(n)*{'us': .000001, 'ms': .001, 's': 1, 'min': 60, 'h': 3600}[unit] for n, unit in parts)
    if not 0 < seconds(rows.get('TimeoutStartUSec', '')) <= 90 or not 0 < seconds(rows.get('TimeoutStopUSec', '')) <= 5:
        raise ValueError('Unit deadline unavailable')
    if Path('/proc/self/cgroup').read_text().strip() != '0::'+group:
        raise ValueError('Collector cgroup binding changed')
    root = Path('/sys/fs/cgroup')/group.lstrip('/')
    for name, value in [('memory.max', 256 << 20), ('memory.swap.max', 0), ('pids.max', 32)]:
        if (root/name).read_text().strip() != str(value): raise ValueError('Collector kernel budget unavailable')
    quota, period = (root/'cpu.max').read_text().split()
    if not quota.isdigit() or not period.isdigit() or not 0 < int(quota) <= int(period)/2:
        raise ValueError('Collector CPU budget unavailable')
    if Path('/proc/self/cgroup').read_text().strip() != '0::'+group:
        raise ValueError('Collector cgroup binding changed')


def require_installed_units(path, cfg):
    directory = Path.home()/'.config/systemd/user'
    for suffix, expected in zip(['service', 'timer'], unit_text(path, cfg)):
        if private_bytes(directory/(UNIT+'.'+suffix)) != expected.encode():
            raise ValueError('Refusing to start a different or modified unit')


def unit_metadata(suffix):
    if suffix not in ('service', 'timer'): raise ValueError('Fixed unit suffix required')
    result = subprocess.run([runtime()['systemctl'], '--user', 'show', UNIT+'.'+suffix,
                            '--all', '--property=LoadState,FragmentPath,DropInPaths'],
                            capture_output=True, text=True, timeout=3)
    if len(result.stdout) > 8192: raise ValueError('Unit metadata bound exceeded')
    rows = unique(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
    if set(rows) != {'LoadState', 'FragmentPath', 'DropInPaths'} or result.returncode not in (0, 1, 4):
        raise ValueError('Unit metadata unavailable')
    if rows['LoadState'] == 'not-found' and not rows['FragmentPath'] and not rows['DropInPaths']:
        return rows
    if result.returncode != 0 or rows['LoadState'] != 'loaded': raise ValueError('Unit is not loaded normally')
    return rows


def registered_units(path, *, allow_absent=False):
    """Installed ownership is independent of a damaged configuration/history."""
    record = json.loads(private_bytes(path.parent/'.observations-units.json'), object_pairs_hook=unique)
    if (not isinstance(record, dict) or set(record) != {'version', 'purpose', 'config', 'units'} or
        type(record['version']) is not int or record['version'] != 1 or record['purpose'] != 'reverie-user-observations-units' or
        record['config'] != str(path) or not isinstance(record['units'], dict) or set(record['units']) != {'service', 'timer'}):
        raise ValueError('Installed unit record refused')
    directory = Path.home()/'.config/systemd/user'
    for suffix, digest in record['units'].items():
        if not isinstance(digest, str) or not re.fullmatch('[a-f0-9]{64}', digest): raise ValueError('Unit digest refused')
        target = directory/(UNIT+'.'+suffix)
        if target.exists() or target.is_symlink():
            if hashlib.sha256(private_bytes(target)).hexdigest() != digest: raise ValueError('Registered unit was modified')
        elif not allow_absent: raise ValueError('Registered unit is missing')
        actual = unit_metadata(suffix)
        if actual['LoadState'] == 'not-found' and allow_absent: continue
        if actual['FragmentPath'] != str(target) or actual['DropInPaths']:
            raise ValueError('Foreign or overridden unit fragment refused')
    return record


def install_units(path, cfg):
    directory = Path.home()/'.config/systemd/user'; ancestry(directory/'unit')
    content = dict(zip(['service', 'timer'], unit_text(path, cfg)))
    record = {'version': 1, 'purpose': 'reverie-user-observations-units', 'config': str(path),
              'units': {suffix: hashlib.sha256(text.encode()).hexdigest() for suffix, text in content.items()}}
    registered = path.parent/'.observations-units.json'
    if registered.exists() or registered.is_symlink():
        if registered_units(path, allow_absent=True) != record: raise ValueError('Existing installation differs; no automatic replacement')
    else:
        for suffix in content:
            target = directory/(UNIT+'.'+suffix)
            actual = unit_metadata(suffix)
            if target.exists() or target.is_symlink() or actual['LoadState'] != 'not-found':
                raise ValueError('Refusing to adopt a pre-existing same-name unit')
        # Record only our exact intended files before publication. It cannot
        # authorize a command alone: every control rechecks bytes+real fragments.
        exclusive(registered, (json.dumps(record, sort_keys=True)+'\n').encode())
    directory.mkdir(parents=True, mode=0o700, exist_ok=True)
    for suffix, text in content.items():
        target = directory/(UNIT+'.'+suffix)
        if not target.exists(): exclusive(target, text.encode())
    registered_units(path, allow_absent=True)
    subprocess.run([runtime()['systemctl'], '--user', 'daemon-reload'], check=True, timeout=10)
    registered_units(path)


def sample(path, cfg):
    verify_service()
    state = state_directory(cfg)
    # The accepted collector remains the only sampler/retention implementation.
    # Its configured prune input stays disabled in this distinct user mode.
    collector = sibling('collector')
    current = {**collector.DEFAULTS, 'out_dir': str(state), 'label': 'user-observations', 'interval_s': cfg['intervalSeconds'],
               'retention_days': cfg['retentionDays'], 'rollup_retention_days': cfg['rollupRetentionDays'], 'drives': cfg['drives'],
               'gpu': 'off' if cfg['gpuExecutable'] is None else 'auto', 'nvidia_smi': cfg['gpuExecutable'] or '/disabled/nvidia-smi',
               'prune_log_dir': ''}
    # Refuse path substitution before the existing fixed-name writer opens files.
    for count, child in enumerate(state.iterdir(), 1):
        if count > 1024: raise ValueError('Observation file count exceeded')
        if child.name not in {'.reverie-user-observations.json', '.lock', 'state.json', 'state.json.tmp', 'prune-runs.jsonl'} and not (
            collector.SAMPLE_RE.fullmatch(child.name) or collector.ROLLUP_RE.fullmatch(child.name)):
            raise ValueError('Unexpected file in dedicated observation state')
        private_bytes(child, 64 << 20)
    before = private_bytes(path); old_mask = os.umask(0o077)
    original_env = dict(os.environ)
    try:
        # Matching driver tooling needs no office/provider credentials or hooks.
        for key in list(os.environ):
            if key not in ('HOME', 'LANG', 'LC_ALL', 'USER', 'LOGNAME', 'PATH'): del os.environ[key]
        code, _ = collector.sample_once(current)
    finally:
        os.environ.clear(); os.environ.update(original_env); os.umask(old_mask)
    if private_bytes(path) != before or configuration(path) != cfg:
        raise ValueError('Observation configuration changed')
    return code


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument('--config', default=str(Path.home()/'reverie/resource-history/config.json'))
    parser.add_argument('action', choices=['init', 'install', 'enable', 'disable', 'start', 'stop', 'status', 'sample'])
    args = parser.parse_args(argv); path = canonical(args.config)
    try:
        ancestry(path)
        if args.action == 'init':
            path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
            cfg = {'version': 1, 'mode': 'user-observations', 'stateDirectory': str(path.parent/'history'), 'intervalSeconds': 300,
                   'retentionDays': 30, 'rollupRetentionDays': 400, 'drives': {}, 'gpuExecutable': None}
            with operation(path):
                if not path.exists(): exclusive(path, (json.dumps(cfg, indent=2)+'\n').encode())
                state_directory(configuration(path), create=True)
        elif args.action == 'sample':
            # The controlling start process can hold the unit-operation lock
            # while systemd waits. Sampling uses the accepted collector's own
            # lock, never the parent's unit-control lock.
            cfg = configuration(path)
            return sample(path, cfg)
        elif args.action in ('stop', 'disable', 'status'):
            # Do not load corrupt/missing config or state to stop registered own
            # units; no name-only stop of a foreign producer is permitted.
            with operation(path):
                if args.action == 'status':
                    try: registered_units(path); owned = True
                    except (OSError, ValueError, TypeError): owned = False
                    print(json.dumps({'unit': UNIT, 'ownership': 'registered-current' if owned else 'unowned-or-unavailable'}))
                    subprocess.run([runtime()['systemctl'], '--user', 'show', UNIT+'.service', UNIT+'.timer',
                                    '--property=ActiveState,SubState,Result,LastTriggerUSec,NextElapseUSecRealtime'], check=True, timeout=3)
                else:
                    registered_units(path)
                    command = ['stop', UNIT+'.timer', UNIT+'.service'] if args.action == 'stop' else ['disable', '--now', UNIT+'.timer']
                    subprocess.run([runtime()['systemctl'], '--user', *command], check=True, timeout=10)
        else:
            cfg = configuration(path)
            with operation(path):
                state_directory(cfg)
                if args.action == 'install':
                    install_units(path, cfg)
                else:
                    registered_units(path); require_installed_units(path, cfg)
                    commands = {'enable': ['enable', '--now', UNIT+'.timer'], 'start': ['start', UNIT+'.service']}
                    subprocess.run([runtime()['systemctl'], '--user', *commands[args.action]], check=True, timeout=95 if args.action == 'start' else 10)
        return 0
    except (OSError, ValueError, TypeError, subprocess.SubprocessError):
        print('User observation operation refused or unavailable', file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
