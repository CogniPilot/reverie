"""Prepare/install an inactive, root-controlled DRY-RUN cleanup service.

No imported agent code, arbitrary inventory command, live cleanup or host OS rebuild.
The Nix launcher supplies immutable tool paths; --apply additionally needs host root
and the exact digest printed by preparation. Installing never starts either unit.
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import signal
import stat
import subprocess
import sys
import tempfile
import time
import tomllib
import uuid

SOURCE_HASHES = {
    'reverie_prune.py': 'eee8b1608e1e87117d00b955b6cf6271cea809ab5e0cfd3f77696a05007eb3fb',
    'lease.py': '3458407ef3e2bb71047528d0acebcb2a1266193dd3181ad7fc384b056a72315b',
}
STORE = Path('/nix/store')
UNITS = Path('/run/systemd/system')
SERVICE, TIMER = 'reverie-prune.service', 'reverie-prune.timer'
MARKER = '# Managed by reverie-prune-host v1; DRY-RUN ONLY\n'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, sort_keys=True, indent=2) + '\n').encode()


def absolute(value):
    text = str(value)
    if (not text.startswith('/') or os.path.normpath(text) != text or
            any(ord(c) < 32 or ord(c) == 127 for c in text)):
        raise ValueError('An absolute canonical path without control characters is required')
    return Path(text)


def protected_chain(path, *, missing=False):
    """Every existing ancestor, including /, is root-owned and non-writable by others."""
    path = absolute(path)
    for part in [*reversed(path.parents), path]:
        try:
            info = part.lstat()
        except FileNotFoundError:
            if missing:
                continue
            raise ValueError('A protected installation path is missing') from None
        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('Installation path and all parents must be root-owned, non-symlink and not group/world writable')
        if part != path and not stat.S_ISDIR(info.st_mode):
            raise ValueError('Installation parent is not a directory')
    return path


def plain_directory(path):
    path = absolute(path)
    for part in [*reversed(path.parents), path]:
        if not stat.S_ISDIR(part.lstat().st_mode):
            raise ValueError('Configured directory and all parents must be real directories, not symlinks')
    return path


def immutable(path, *, directory=False):
    """Nix outputs are pinned separately; /nix/store itself may legitimately be 1775."""
    path = absolute(path)
    if not path.is_relative_to(STORE) or len(path.relative_to(STORE).parts) < 1:
        raise ValueError('Use the immutable Nix flake launcher and tool paths')
    protected_chain(STORE.parent)
    store_info = STORE.lstat()
    if (not stat.S_ISDIR(store_info.st_mode) or store_info.st_uid != 0 or
            (store_info.st_mode & 0o022 and not store_info.st_mode & stat.S_ISVTX)):
        raise ValueError('Root-owned Nix store with protected existing output names required')
    base = STORE / path.relative_to(STORE).parts[0]
    for part in [*reversed(path.parents), path]:
        if not part.is_relative_to(base): continue
        info = part.lstat()
        if part == path and stat.S_ISLNK(info.st_mode) and not directory and info.st_uid == 0:
            return immutable(path.resolve(strict=True))
        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('An immutable root-owned Nix output is required')
    info = path.lstat()
    if directory and not stat.S_ISDIR(info.st_mode):
        raise ValueError('Nix output directory required')
    if not directory and not stat.S_ISREG(info.st_mode):
        raise ValueError('Nix output regular file required')
    return path


def read_file(path, limit=1024 * 1024):
    path = absolute(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    with os.fdopen(fd, 'rb') as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or (before.st_nlink != 1 and not path.is_relative_to(STORE)) or before.st_mode & 0o022:
            raise ValueError('A regular, non-writable-by-others input file is required')
        data = stream.read(limit + 1)
        after = os.fstat(stream.fileno())
        stamp = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        if len(data) > limit or stamp(before) != stamp(after) or stamp(after) != stamp(path.lstat()):
            raise ValueError('Input changed or exceeds its size bound')
    return data


def canonical_uuid(value):
    if not isinstance(value, str) or str(uuid.UUID(value)) != value:
        raise ValueError('Canonical employee/session UUID required')
    return value


def policy(raw, state):
    allowed = {'version', 'deployment', 'b_mount', 'laptops_root', 'laptop_home_root', 'employee_ids',
               'laptop_uid', 'laptop_gid', 'checkout_roots', 'live_enabled', 'laptops_cmd', 'lease_subdir',
               'docker_socket', 'cadence', 'high_water_pct', 'low_water_pct'}
    if not isinstance(raw, dict) or set(raw) - allowed or type(raw.get('version')) is not int or raw.get('version') != 1:
        raise ValueError('Unknown deployment key or unsupported configuration version')
    if raw.get('live_enabled', False) is not False or raw.get('laptops_cmd', []) != []:
        raise ValueError('Only live_enabled=false and the built-in fixed inventory helper are supported')
    deployment = raw.get('deployment', '')
    if not isinstance(deployment, str) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}', deployment):
        raise ValueError('Invalid deployment label')
    result = dict(raw, live_enabled=False)
    result.pop('laptops_cmd', None)
    for key in ('b_mount', 'laptop_home_root'):
        result[key] = str(plain_directory(raw[key]))
    b = Path(result['b_mount'])
    if b == Path('/') or not os.path.ismount(b):
        raise ValueError('b_mount must identify an existing disposable filesystem mount, not /')
    if state.is_relative_to(b) or Path(result['laptop_home_root']).is_relative_to(b):
        raise ValueError('Durable state and laptop homes must be outside the disposable filesystem')
    for key, default in [('laptops_root', None), ('lease_subdir', '.local/state/reverie/leases')]:
        value = raw.get(key, default)
        if not isinstance(value, str) or not value or Path(value).is_absolute() or '..' in Path(value).parts or os.path.normpath(value) != value:
            raise ValueError('Relative canonical laptop/lease paths are required')
        result[key] = value
    plain_directory(b / result['laptops_root'])
    ids = raw.get('employee_ids')
    if not isinstance(ids, list) or not ids or len(ids) > 256:
        raise ValueError('Provide the reviewed employee UUID inventory (1..256 entries)')
    result['employee_ids'] = sorted(canonical_uuid(value) for value in ids)
    if len(set(result['employee_ids'])) != len(ids):
        raise ValueError('Duplicate employee UUID')
    for key in ('laptop_uid', 'laptop_gid'):
        if type(raw.get(key)) is not int or raw[key] < 1:
            raise ValueError('Explicit non-root laptop UID/GID required')
    result['checkout_roots'] = [str(plain_directory(p)) for p in raw.get('checkout_roots', [])]
    result['docker_socket'] = str(absolute(raw.get('docker_socket', '/run/docker.sock')))
    result['cadence'] = raw.get('cadence', 'hourly')
    if result['cadence'] not in ('hourly', 'daily', 'half-hourly'):
        raise ValueError('Cadence must be hourly, daily or half-hourly')
    result['high_water_pct'] = raw.get('high_water_pct', 70)
    result['low_water_pct'] = raw.get('low_water_pct', 50)
    if (any(type(result[k]) is not int for k in ('high_water_pct', 'low_water_pct')) or
            not 0 <= result['low_water_pct'] <= result['high_water_pct'] <= 100):
        raise ValueError('Invalid water marks')
    return result


def command(args, *, timeout=30, limit=8 * 1024 * 1024):
    """Bound both output streams while reading, and reap only our own child group."""
    process = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               start_new_session=True, env={'PATH': os.defpath, 'LANG': 'C', 'LC_ALL': 'C'})
    output = {process.stdout: bytearray(), process.stderr: bytearray()}
    deadline, total = time.monotonic() + timeout, 0
    reaped = False
    try:
        with selectors.DefaultSelector() as selector:
            for stream in output: selector.register(stream, selectors.EVENT_READ)
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0: raise ValueError('Fixed tool exceeded its execution time bound')
                for key, _ in selector.select(remaining):
                    data = os.read(key.fileobj.fileno(), min(65536, limit - total + 1))
                    if not data:
                        selector.unregister(key.fileobj)
                        continue
                    total += len(data)
                    if total > limit: raise ValueError('Fixed tool exceeded its combined output bound')
                    output[key.fileobj].extend(data)
            remaining = deadline - time.monotonic()
            if remaining <= 0: raise ValueError('Fixed tool exceeded its execution time bound')
            code = process.wait(timeout=remaining)
            reaped = True
        return subprocess.CompletedProcess(args, code, output[process.stdout].decode('utf-8', 'replace'),
                                           output[process.stderr].decode('utf-8', 'replace'))
    except BaseException:
        if not reaped:
            # Its unreaped leader reserves the PID of our own session group.
            try: os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError: pass
            process.wait()
        raise
    finally:
        process.stdout.close(); process.stderr.close()


def inventory(settings, docker, *, config_dir, run=command):
    """Fixed read-only engine verbs, no environment/account/command inspection or user argv."""
    protected_chain(config_dir)
    if any(Path(config_dir).iterdir()):
        raise ValueError('The inventory Docker configuration directory must remain empty')
    def engine(*args):
        response = run([str(docker), '--config', str(config_dir), '--host', 'unix://' + settings['docker_socket'], *args])
        if response.returncode or len(response.stdout) > 8 * 1024 * 1024:
            raise ValueError('Laptop inventory engine request failed or exceeded its output bound')
        return response.stdout
    ids = engine('ps', '-q', '--no-trunc', '--filter', 'label=reverie.worker=' + settings['deployment']).split()
    if len(ids) > len(settings['employee_ids']) or len(set(ids)) != len(ids) or any(not re.fullmatch('[a-f0-9]{64}', x) for x in ids):
        raise ValueError('Unexpected or duplicate running laptop inventory')
    if not ids:
        return []
    fmt = ('{"id":{{json .Id}},"name":{{json .Name}},"labels":{{json .Config.Labels}},'
           '"user":{{json .Config.User}},"pid":{{.State.Pid}},"running":{{.State.Running}},"mounts":{{json .Mounts}}}')
    rows = [json.loads(line) for line in engine('inspect', '--type', 'container', '--format', fmt, *ids).splitlines()]
    if len(rows) != len(ids) or {r.get('id') for r in rows} != set(ids):
        raise ValueError('Incomplete engine inventory')
    result, seen = [], set()
    for row in rows:
        labels = row.get('labels') or {}
        sid = canonical_uuid(labels.get('reverie.session'))
        if (labels.get('reverie.worker') != settings['deployment'] or row.get('name') != '/' + settings['deployment'] + '-agent-' + sid or
                row.get('running') is not True or row.get('user') != f"{settings['laptop_uid']}:{settings['laptop_gid']}"):
            raise ValueError('Laptop identity or running state changed')
        selected = {}
        for target in ('/home/agent', '/tmp'):
            matches = [m for m in row.get('mounts', []) if m.get('Destination') == target]
            if len(matches) != 1 or matches[0].get('Type') != 'bind' or matches[0].get('RW') is not True:
                raise ValueError('Expected canonical home/tmp bind mounts')
            selected[target] = plain_directory(matches[0]['Source'])
        relative = selected['/home/agent'].relative_to(Path(settings['laptop_home_root']))
        if len(relative.parts) != 2 or relative.parts[1] != 'home':
            raise ValueError('Unexpected employee home layout')
        eid = canonical_uuid(relative.parts[0])
        expected_tmp = Path(settings['b_mount']) / settings['laptops_root'] / eid / 'tmp'
        if eid not in settings['employee_ids'] or eid in seen or selected['/tmp'] != expected_tmp:
            raise ValueError('Unknown, duplicate or mismatched employee binding')
        pid = row.get('pid')
        if type(pid) is not int or pid <= 1 or not os.access(f'/proc/{pid}/mountinfo', os.R_OK):
            raise ValueError('Laptop host init PID is missing or not visible')
        seen.add(eid); result.append({'id': eid, 'init_pid': pid})
    return sorted(result, key=lambda x: x['id'])


def unit_arg(value):
    return json.dumps(str(value).replace('%', '%%').replace('$', '$$'), ensure_ascii=False)


class Installer:
    def __init__(self, state, package, python, docker, systemctl, nix_store, closure, *, run=command):
        self.state = absolute(state)
        self.paths = {key: absolute(value) for key, value in locals().copy().items()
                      if key in ('package', 'python', 'docker', 'systemctl', 'nix_store', 'closure')}
        self.run = run

    def pins(self):
        for key, path in self.paths.items():
            immutable(path, directory=key in ('package', 'closure'))
        for name, expected in SOURCE_HASHES.items():
            if digest(read_file(self.paths['package'] / 'libexec/reverie' / name)) != expected:
                raise ValueError('Reviewed prune/lease package source hash differs')
        immutable(self.paths['package'] / 'bin/reverie-prune')
        immutable(self.paths['closure'] / 'bin/reverie-prune-host')
        immutable(self.paths['systemctl'].parent / 'systemd-detect-virt')

    def config_text(self, settings):
        s = self.state
        values = dict(live_enabled=False, b_mount=settings['b_mount'], laptops_root=settings['laptops_root'],
                      laptop_home_root=settings['laptop_home_root'], lease_dir_template='{home}/' + settings['lease_subdir'],
                      lease_lib=str(s / 'lib/lease.py'), host_lease_dirs=[str(s / 'host-leases')],
                      registry_dir=str(s / 'registry'), checkout_roots=settings['checkout_roots'],
                      log_dir=str(s / 'logs'), lock_path=str(s / 'prune.lock'),
                      high_water_pct=settings['high_water_pct'], low_water_pct=settings['low_water_pct'],
                      laptops_cmd=[str(self.paths['closure'] / 'bin/reverie-prune-host'), '--state-dir', str(s), '--inventory'])
        return ''.join(f'{key} = {str(value).lower() if isinstance(value, bool) else json.dumps(value, ensure_ascii=False)}\n' for key, value in values.items())

    def units(self, settings):
        launcher = self.paths['closure'] / 'bin/reverie-prune-host'
        args = lambda *values: ' '.join(unit_arg(value) for value in values)
        leases = [Path(settings['laptop_home_root']) / eid / 'home' / settings['lease_subdir'] for eid in settings['employee_ids']]
        service = MARKER + '\n'.join([
            '[Unit]', 'Description=Reverie cleanup observation (dry-run only)',
            '[Service]', 'Type=oneshot', 'User=root', 'Group=root', 'UMask=0077',
            'ExecStartPre=' + args(launcher, '--state-dir', self.state, '--check'),
            'ExecStart=' + args(self.paths['package'] / 'bin/reverie-prune', '--config', self.state / 'prune.toml', '--dry-run', '--pass', 'all'),
            'TimeoutStartSec=600', 'MemoryMax=1G', 'TasksMax=64', 'CPUQuota=100%', 'Nice=19', 'IOSchedulingClass=idle',
            'NoNewPrivileges=true', 'PrivateTmp=false', 'PrivateUsers=false', 'ProtectProc=default', 'ProcSubset=all',
            'ProtectSystem=strict', 'ReadWritePaths=' + args(self.state, *leases),
            'ReadOnlyPaths=' + args(settings['b_mount'], settings['laptop_home_root']),
            'StandardOutput=journal', 'StandardError=journal', ''])
        calendar = {'hourly': 'hourly', 'daily': 'daily', 'half-hourly': '*-*-* *:00,30:00'}[settings['cadence']]
        timer = MARKER + '\n'.join(['[Unit]', 'Description=Reverie dry-run cleanup observation timer', '[Timer]',
                                    'OnCalendar=' + calendar, 'Persistent=false', 'AccuracySec=1min',
                                    'Unit=' + SERVICE, '[Install]', 'WantedBy=timers.target', ''])
        return service, timer

    def prepare(self, config):
        self.pins(); protected_chain(self.state, missing=True); protected_chain(UNITS, missing=True)
        if self.state in map(Path, ('/', '/etc', '/usr', '/var', '/var/lib', '/run', '/home', '/nix', '/nix/store')):
            raise ValueError('Choose a dedicated protected application state directory')
        raw = read_file(config)
        settings = policy(json.loads(raw), self.state)
        service, timer = self.units(settings)
        mount = Path(settings['b_mount']).stat()
        plan = {'version': 1, 'mode': 'dry-run-only', 'state': str(self.state), 'paths': {k: str(v) for k, v in self.paths.items()},
                'config_sha256': digest(raw), 'settings': settings, 'b_mount_dev_ino': [mount.st_dev, mount.st_ino],
                'source_hashes': SOURCE_HASHES, 'installer_sha256': digest(read_file(absolute(__file__))),
                'prune_config_sha256': digest(self.config_text(settings).encode()),
                'service_sha256': digest(service.encode()), 'timer_sha256': digest(timer.encode()),
                'unit_directory': str(UNITS), 'units_survive_reboot': False,
                'starts_units': False, 'live_prune_qualified': False}
        return plan, digest(encoded(plan))

    def check(self):
        protected_chain(self.state)
        manifest = json.loads(read_file(self.state / 'install.json'))
        if manifest.get('mode') != 'dry-run-only' or manifest.get('paths') != {k: str(v) for k, v in self.paths.items()}:
            raise ValueError('Installed dry-run tool binding differs')
        self.pins()
        for name, expected in manifest['files'].items():
            path = self.state / name
            protected_chain(path)
            if digest(read_file(path)) != expected:
                raise ValueError('Installed config/code changed; re-prepare and review')
        settings = json.loads(read_file(self.state / 'deployment.json'))
        actual = tomllib.loads(read_file(self.state / 'prune.toml').decode())
        if actual.get('live_enabled') is not False or read_file(self.state / 'prune.toml').decode() != self.config_text(settings):
            raise ValueError('Only the exact installed dry-run configuration is allowed')
        return settings

    def apply(self, config, expected, *, enable_timer=False):
        if sys.platform != 'linux' or os.geteuid() != 0:
            raise ValueError('Apply requires ordinary owner-authorized root on the Linux host')
        plan, actual = self.prepare(config)
        if expected != actual:
            raise ValueError('Prepared plan digest changed; review preparation again')
        container = self.run([str(self.paths['systemctl'].parent / 'systemd-detect-virt'), '--container', '--quiet'])
        if container.returncode != 1:
            raise ValueError('Apply requires the systemd host, not container root or an unknown container boundary')
        settings = plan['settings']
        for eid in settings['employee_ids']:
            directory = plain_directory(Path(settings['laptop_home_root']) / eid / 'home' / settings['lease_subdir'])
            info = directory.lstat()
            if (info.st_uid, info.st_gid) != (settings['laptop_uid'], settings['laptop_gid']) or info.st_mode & 0o077:
                raise ValueError('Pre-create private persistent lease directories owned by the laptop user before installation')
        # A oneshot can be activating while is-active returns nonzero. Require
        # explicit terminal state and no service/control process, not an exit-code guess.
        def require_inactive_units():
            for unit in (SERVICE, TIMER):
                properties = ('LoadState', 'ActiveState', 'SubState', 'FragmentPath') + (('MainPID', 'ControlPID') if unit == SERVICE else ())
                response = self.run([str(self.paths['systemctl']), 'show',
                                     *['--property=' + key for key in properties], unit])
                values = dict(line.split('=', 1) for line in response.stdout.splitlines() if '=' in line)
                if (response.returncode or set(values) != set(properties) or
                        values['LoadState'] not in ('loaded', 'not-found') or
                        values['ActiveState'] != 'inactive' or values['SubState'] != 'dead' or
                        (unit == SERVICE and (values['MainPID'] != '0' or values['ControlPID'] != '0'))):
                    raise ValueError('Cannot confirm inactive/dead cleanup units with no running processes; stop them explicitly before upgrading')
                if values['LoadState'] == 'not-found':
                    if values['FragmentPath']:
                        raise ValueError('Absent cleanup unit unexpectedly has a fragment path')
                else:
                    target = UNITS / unit
                    if values['FragmentPath'] != str(target):
                        raise ValueError('Refusing to shadow an existing cleanup unit from another installation')
                    protected_chain(target)
                    if not read_file(target).startswith(MARKER.encode()):
                        raise ValueError('Existing cleanup unit is not owned by this installer')
        require_inactive_units()
        mkdir_protected(self.state)
        mkdir_protected(self.state / 'docker-config')
        inventory(settings, self.paths['docker'], config_dir=self.state / 'docker-config', run=self.run)
        lock_fd = os.open(self.state / 'install.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        with os.fdopen(lock_fd, 'r+') as lock:
            protected_chain(self.state / 'install.lock')
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            require_inactive_units()
            mkdir_protected(UNITS)
            for directory in ('lib', 'host-leases', 'registry', 'logs', 'gcroots'):
                mkdir_protected(self.state / directory)
            for name in (SERVICE, TIMER):
                target = UNITS / name
                if target.exists() or target.is_symlink():
                    protected_chain(target)
                    if not read_file(target).startswith(MARKER.encode()):
                        raise ValueError('Existing cleanup unit is not owned by this installer')
            files = {'deployment.json': encoded(settings), 'prune.toml': self.config_text(settings).encode()}
            files.update({'lib/' + name: read_file(self.paths['package'] / 'libexec/reverie' / name) for name in SOURCE_HASHES})
            for name, data in files.items():
                atomic(self.state / name, data, 0o444 if name.startswith('lib/') else 0o600)
            for name, expected_hash in SOURCE_HASHES.items():
                if digest(read_file(self.state / 'lib' / name)) != expected_hash:
                    raise ValueError('Copied executable source failed hash verification')
            protected_chain(self.state / 'lib/lease.py')
            root = self.state / 'gcroots' / ('host-' + self.paths['closure'].name.split('-')[0])
            if root.is_symlink():
                if root.resolve() != self.paths['closure']:
                    raise ValueError('Existing service closure pin differs; explicit upgrade review required')
            else:
                response = self.run([str(self.paths['nix_store']), '--add-root', str(root), '--indirect', '--realise', str(self.paths['closure'])])
                if response.returncode or not root.is_symlink() or root.resolve() != self.paths['closure']:
                    raise ValueError('Durable Nix closure root could not be confirmed')
            manifest = {'version': 1, 'mode': 'dry-run-only', 'plan_sha256': actual, 'paths': plan['paths'],
                        'files': {name: digest(data) for name, data in files.items()}}
            atomic(self.state / 'install.json', encoded(manifest), 0o600)
            service, timer = self.units(settings)
            for name, value in ((SERVICE, service), (TIMER, timer)):
                atomic(UNITS / name, value.encode(), 0o644)
            response = self.run([str(self.paths['systemctl']), 'daemon-reload'])
            if response.returncode:
                raise ValueError('Units installed inactive but systemd reload was not confirmed')
            if enable_timer:
                response = self.run([str(self.paths['systemctl']), 'enable', '--runtime', TIMER])
                if response.returncode:
                    raise ValueError('Timer enablement was not confirmed')
        return {'status': 'INSTALLED_INACTIVE', 'plan_sha256': actual, 'timer_enabled': enable_timer, 'units_started': False,
                'unit_directory': str(UNITS), 'units_survive_reboot': False,
                'next': f'After lease-gate acceptance: systemctl start {SERVICE}; inspect private reports before starting the timer.'}


def mkdir_protected(path):
    protected_chain(path, missing=True)
    for parent in [*reversed(path.parents), path]:
        if not parent.exists():
            parent.mkdir(mode=0o700)
    protected_chain(path)


def atomic(path, data, mode):
    protected_chain(path.parent)
    if path.exists() or path.is_symlink():
        protected_chain(path)
    fd, name = tempfile.mkstemp(prefix='.prune-install-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            os.fchmod(stream.fileno(), mode); stream.write(data); stream.flush(); os.fsync(stream.fileno())
        os.replace(name, path)
        directory = os.open(path.parent, os.O_DIRECTORY | os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(name): os.unlink(name)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    for flag in ('package', 'python', 'docker', 'systemctl', 'nix-store', 'closure'):
        parser.add_argument('--' + flag, required=True)
    parser.add_argument('--state-dir', default='/var/lib/reverie-prune')
    parser.add_argument('--config', type=Path)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--apply', action='store_true')
    modes.add_argument('--inventory', action='store_true')
    modes.add_argument('--check', action='store_true')
    parser.add_argument('--expect-plan')
    parser.add_argument('--enable-timer', action='store_true', help='enable runtime-only timer linkage; never starts it now or survives reboot')
    arguments = sys.argv[1:] if argv is None else argv
    for flag in ('package', 'python', 'docker', 'systemctl', 'nix-store', 'closure'):
        if sum(a.split('=', 1)[0] == '--' + flag for a in arguments) > 1:
            parser.error('Nix launcher pins cannot be overridden')
    args = parser.parse_args(arguments)
    try:
        installer = Installer(args.state_dir, args.package, args.python, args.docker, args.systemctl, args.nix_store, args.closure)
        if args.enable_timer and not args.apply:
            raise ValueError('--enable-timer requires explicit --apply')
        if args.inventory or args.check:
            settings = installer.check()
            result = inventory(settings, installer.paths['docker'], config_dir=installer.state / 'docker-config') if args.inventory else {'status': 'CHECKED_DRY_RUN_ONLY'}
        else:
            if args.config is None:
                raise ValueError('Select a private owner-reviewed deployment JSON with --config')
            result = installer.apply(args.config, args.expect_plan, enable_timer=args.enable_timer) if args.apply else dict(zip(('plan', 'plan_sha256'), installer.prepare(args.config)))
        print(json.dumps(result, sort_keys=True, indent=2))
        return 0
    except (ValueError, OSError, KeyError, TypeError, json.JSONDecodeError, subprocess.SubprocessError) as error:
        print('reverie-prune-host: ' + str(error), file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
