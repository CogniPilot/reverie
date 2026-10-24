"""Seed a private laptop Nix store using only a reviewed image's own closure."""
import json
import os
from pathlib import Path
import re
import stat
import time

SESSION = re.compile(r'^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$')


def private_store(config, session_id):
    if not isinstance(session_id, str) or not SESSION.fullmatch(session_id):
        raise ValueError('Invalid Nix store session identity')
    scratch = Path(config['scratchRoot']) / session_id
    scratch.mkdir(mode=0o700, parents=True, exist_ok=True)
    if scratch.is_symlink() or scratch.resolve() != scratch:
        raise ValueError('Invalid laptop scratch directory')
    path = scratch / 'nix'
    path.mkdir(mode=0o700, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != config['uid'] or info.st_mode & 0o077:
        raise ValueError('Laptop Nix store must be a private directory owned by its user')
    return path


def prepare_args(config, session_id, path):
    """A networkless, unprivileged helper; the one bind is already-owned scratch."""
    if not isinstance(session_id, str) or not SESSION.fullmatch(session_id):
        raise ValueError('Invalid Nix store session identity')
    expected = Path(config['scratchRoot']) / session_id / 'nix'
    if path != expected:
        raise ValueError('Nix store is outside this laptop scratch directory')
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
