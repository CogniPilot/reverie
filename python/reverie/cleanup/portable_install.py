"""Install or verify the optional r12 dry-run cleanup on a Linux systemd host.

A pinned release is copied into a root-owned prefix and persistent units use one explicit supported directory; nothing
starts or enables. Installation needs ordinary owner sudo; normal application startup requires no host adapter.
Custody of data is a root-owned, non-group/world-writable, non-symlink chain plus sha256 pins:
Reverie's files are pinned in this source, and the operating system's python, docker and systemctl are bound by resolved
path and sha256 at install, then re-verified on every run. Only Nix program paths use the existing immutable-output rule.
The revision is fixed here; no argument selects another one. Acceptance workflow wiring remains separate.
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import types

HOST_INSTALL_SHA256 = 'fec0f01dba16c0f78a2dc83d15c4eeb2a9b14f63eb996b36b624e10906289b9e'


def _require_root_chain(path):
    """As root, this file and every ancestor must be root-owned, not group/world writable and not symlinks, so a user
    who can write the directory cannot change what root runs. Checked before any other code is loaded."""
    for part in [*reversed(path.parents), path]:
        info = os.lstat(part)
        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise SystemExit('reverie-prune-portable: refusing to run as root from a path that is not root-controlled: ' + str(part))


def _load_host_install():
    """Read the sibling's bytes once, compare them with the pin, then execute exactly those bytes. Nothing unverified runs."""
    here = Path(os.path.abspath(__file__))
    nix_program = here.is_relative_to(Path('/nix/store'))
    if os.geteuid() == 0 and not nix_program:
        _require_root_chain(here)
    path = here.with_name('host_install.py')
    # The pin authenticates these bytes before execution. Nix source aliases
    # are checked through immutable() below; ordinary release inputs stay strict.
    readable = path.resolve(strict=True) if nix_program else path
    fd = os.open(readable, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC)
    with os.fdopen(fd, 'rb') as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise SystemExit('reverie-prune-portable: host_install.py is not a regular file')
        data = stream.read(4 * 1024 * 1024 + 1)
    if hashlib.sha256(data).hexdigest() != HOST_INSTALL_SHA256:
        raise SystemExit('reverie-prune-portable: host_install.py does not match its pinned sha256')
    module = types.ModuleType('_reverie_prune_host_install')
    module.__file__ = str(path)
    exec(compile(data, str(path), 'exec'), module.__dict__)  # noqa: S102  the bytes were just verified against the pin
    if os.geteuid() == 0 and nix_program:
        # Only the exact digest-verified helper runs before this check. Reuse its
        # existing multiuser Nix program rule; no data-directory exception follows.
        module.immutable(here)
        module.immutable(path)
    return module


H = _load_host_install()

MANAGER = 'portable-dry-run-v1'
MARKER = '# Managed by reverie-prune-portable v1; DRY-RUN ONLY\n'
UNITS = Path('/etc/systemd/system')
UNIT_DIRS = (UNITS, Path('/usr/local/lib/systemd/system'))
RUNTIME_UNITS = H.UNITS
SOURCE_HASHES = {
    'reverie_prune.py': '55f26deec48c2c5d25b7d2509aa2ec28a22b1ebb0a6747c8be021a79129d4bed',
    'lease.py': '606cacea83ebb70bb805423e67be44168fec411d3e5c62c5e563c416ab6891aa',
    'host_install.py': HOST_INSTALL_SHA256,
}
RELEASE = 'r12-' + SOURCE_HASHES['reverie_prune.py'][:12]
RELEASE_FILES = ('reverie_prune.py', 'lease.py', 'host_install.py', 'portable_install.py')
BINDINGS = ('python', 'docker', 'systemctl', 'systemd-detect-virt')
FORBIDDEN_STATE = tuple(map(Path, ('/', '/etc', '/usr', '/var', '/var/lib', '/run', '/home', '/nix', '/nix/store')))
IDENTITY_KEYS = ('fstype', 'mount_root', 'source')


def _line(value):
    return isinstance(value, str) and value != '' and not any(c in value for c in '\n\r\0')


def program_path(path, *, directory=False):
    """Trust executable/source code only; configuration and data never use this rule."""
    path = H.absolute(path)
    if path.is_relative_to(H.STORE):
        return H.immutable(path, directory=directory)
    return H.protected_chain(path)


def given_program_path(path):
    """The stable name in units must be root-controlled as well as its resolved target."""
    path = H.absolute(path)
    if path.is_relative_to(H.STORE):
        return H.immutable(path)
    H.protected_chain(path.parent)
    info = path.lstat()
    symlink = stat.S_ISLNK(info.st_mode)
    if (info.st_uid != 0 or (not symlink and info.st_mode & 0o022) or
            not (symlink or stat.S_ISREG(info.st_mode))):
        raise ValueError('Given program leaf must be root-owned and controlled')
    return path


def program_bytes(path, *, limit=1024 * 1024):
    """Read verified program bytes, following only the existing immutable leaf rule."""
    return H.read_file(program_path(path), limit=limit)


def binding(path):
    """An OS executable: resolved once, a regular executable file, and root-owned along its whole resolved chain."""
    given = H.absolute(path)
    given_program_path(given)
    resolved = H.absolute(os.path.realpath(given))
    program_path(resolved)
    info = resolved.lstat()
    if not (info.st_mode & 0o100) or not H.stat.S_ISREG(info.st_mode):
        raise ValueError('A fixed tool binding must be a regular executable file')
    return {'path': str(given), 'resolved': str(resolved), 'sha256': H.digest(H.read_file(resolved, limit=256 * 1024 * 1024))}


class PortableInstaller(H.Installer):
    """Prefix custody in place of Nix-store custody. The bootstrap and declared installers are unchanged."""

    def __init__(self, state, prefix, python, docker, systemctl, *, unit_dir=None, run=H.command):
        self.state = H.absolute(state)
        self.prefix = H.absolute(prefix)
        self.release = self.prefix / RELEASE
        self.unit_dir = H.absolute(UNITS if unit_dir is None else unit_dir)
        if self.unit_dir not in UNIT_DIRS:
            raise ValueError('Choose exactly /etc/systemd/system or /usr/local/lib/systemd/system')
        tools = {'python': H.absolute(python), 'docker': H.absolute(docker), 'systemctl': H.absolute(systemctl)}
        tools['systemd-detect-virt'] = tools['systemctl'].parent / 'systemd-detect-virt'
        self.paths = {'package': self.release, **tools}
        self.run = run

    @classmethod
    def from_state(cls, state, *, run=H.command):
        """Units call --check/--inventory with only the state directory; every other binding comes from install.json."""
        state = H.absolute(state)
        H.protected_chain(state / 'install.json')
        manifest = json.loads(H.read_file(state / 'install.json'))
        if manifest.get('manager') != MANAGER:
            raise ValueError('State was not installed by the portable installer')
        p = manifest['paths']
        if 'unit_directory' not in manifest:
            raise ValueError('Installed unit directory binding is missing; owner-reviewed migration required')
        return cls(state, Path(p['package']).parent, p['python'], p['docker'], p['systemctl'],
                   unit_dir=manifest['unit_directory'], run=run)

    def policy(self, raw):
        """host_install.policy for the shared keys plus the r12 root identities (same rules as the declared installer's
        r1b). r12 admits only operator-approved roots, also in dry-run. This installer is dry-run only: any live key refuses."""
        if not isinstance(raw, dict):
            raise ValueError('Unknown deployment key or unsupported configuration version')
        raw = dict(raw)
        identities = raw.pop('root_identities', {})
        if raw.get('live_enabled', False) is not False or 'live_acceptance' in raw:
            raise ValueError('The portable installer is dry-run only; live enablement goes through its own reviewed path')
        settings = H.policy(raw, self.state)
        if not isinstance(identities, dict):
            raise ValueError('root_identities must map configured roots to approved mount identities')
        clean = {}
        for root, ident in identities.items():
            if (not isinstance(ident, dict) or sorted(ident) != list(IDENTITY_KEYS) or
                    not all(_line(ident[k]) for k in IDENTITY_KEYS) or not ident['mount_root'].startswith('/')):
                raise ValueError('Each root identity needs exactly source, fstype and an absolute mount_root')
            clean[str(H.absolute(root))] = {k: ident[k] for k in IDENTITY_KEYS}
        for root in [settings['b_mount'], *settings['checkout_roots']]:
            if root not in clean:
                raise ValueError('Every configured root (disposable mount, checkout roots) needs an approved root identity')
        if clean[settings['b_mount']]['mount_root'] != '/':
            raise ValueError('The disposable mount must map the full filesystem root')
        settings['root_identities'] = clean
        return settings

    def tool(self, name):
        return self.paths[name] if name == 'package' else Path(self.bindings_cache[name]['resolved'])

    def bindings(self):
        return {name: binding(self.paths[name]) for name in BINDINGS}

    def pins(self):
        program_path(self.release, directory=True)
        for name in RELEASE_FILES:
            program_path(self.release / name)
        for name, expected in SOURCE_HASHES.items():
            if H.digest(program_bytes(self.release / name)) != expected:
                raise ValueError('Reviewed release source hash differs')
        self.bindings_cache = self.bindings()

    def entry(self, *args):
        # Units name the GIVEN interpreter path (e.g. /usr/bin/python3), so an OS minor upgrade that retargets it keeps
        # working; custody is still checked on the resolved file every run.
        return [str(self.paths['python']), '-I', '-B', str(self.release / 'portable_install.py'), '--state-dir', str(self.state), *args]

    def config_text(self, settings):
        """The bootstrap's generated prune.toml, with the inventory helper bound to this release (no Nix launcher)."""
        st = self.state
        values = dict(live_enabled=False, b_mount=settings['b_mount'], laptops_root=settings['laptops_root'],
                      laptop_home_root=settings['laptop_home_root'], lease_dir_template='{home}/' + settings['lease_subdir'],
                      lease_lib=str(st / 'lib/lease.py'), host_lease_dirs=[str(st / 'host-leases')],
                      registry_dir=str(st / 'registry'), checkout_roots=settings['checkout_roots'],
                      log_dir=str(st / 'logs'), lock_path=str(st / 'prune.lock'),
                      high_water_pct=settings['high_water_pct'], low_water_pct=settings['low_water_pct'],
                      laptops_cmd=self.entry('--inventory'))
        table = ', '.join(json.dumps(root) + ' = {' + ', '.join(f'{k} = {json.dumps(v)}' for k, v in ident.items()) + '}'
                          for root, ident in sorted(settings.get('root_identities', {}).items()))
        return ''.join(f'{key} = {str(value).lower() if isinstance(value, bool) else json.dumps(value, ensure_ascii=False)}\n'
                       for key, value in values.items()) + 'root_identities = {' + table + '}\n'

    def units(self, settings):
        """The bootstrap's unit text and hardening line for line, with only the launcher lines and marker changed. Live
        stays off: the generated config has live_enabled = false and ExecStart never passes --live."""
        args = lambda *values: ' '.join(H.unit_arg(value) for value in values)
        leases = [Path(settings['laptop_home_root']) / eid / 'home' / settings['lease_subdir'] for eid in settings['employee_ids']]
        start = [self.paths['python'], '-I', '-B', self.release / 'reverie_prune.py',
                 '--config', self.state / 'prune.toml', '--dry-run', '--pass', 'all']
        service = MARKER + '\n'.join([
            '[Unit]', 'Description=Reverie cleanup observation (dry-run only)',
            'RequiresMountsFor=' + args(settings['b_mount'], settings['laptop_home_root']),
            '[Service]', 'Type=oneshot', 'User=root', 'Group=root', 'UMask=0077',
            'ExecStartPre=' + args(*self.entry('--check')),
            'ExecStart=' + args(*start),
            'TimeoutStartSec=600', 'MemoryMax=1G', 'TasksMax=64', 'CPUQuota=100%', 'Nice=19', 'IOSchedulingClass=idle',
            'NoNewPrivileges=true', 'PrivateTmp=false', 'PrivateUsers=false', 'ProtectProc=default', 'ProcSubset=all',
            'ProtectSystem=strict', 'ReadWritePaths=' + args(self.state, *leases),
            'ReadOnlyPaths=' + args(settings['b_mount'], settings['laptop_home_root']),
            'StandardOutput=journal', 'StandardError=journal', ''])
        calendar = {'hourly': 'hourly', 'daily': 'daily', 'half-hourly': '*-*-* *:00,30:00'}[settings['cadence']]
        timer = MARKER + '\n'.join(['[Unit]', 'Description=Reverie dry-run cleanup observation timer', '[Timer]',
                                     'OnCalendar=' + calendar, 'Persistent=false', 'AccuracySec=1min',
                                     'Unit=' + H.SERVICE, '[Install]', 'WantedBy=timers.target', ''])
        return service, timer

    def prepare(self, config):
        self.pins()
        H.protected_chain(self.state, missing=True)
        H.protected_chain(self.unit_dir, missing=True)
        if self.state in FORBIDDEN_STATE or self.state.is_relative_to(self.prefix):
            raise ValueError('Choose a dedicated protected application state directory outside the release prefix')
        raw = H.read_file(config)
        settings = self.policy(json.loads(raw))
        service, timer = self.units(settings)
        unit_paths = self.manager_unit_paths()
        mount = Path(settings['b_mount']).stat()
        plan = {'version': 1, 'mode': 'dry-run-only', 'manager': MANAGER, 'state': str(self.state),
                'paths': {k: str(v) for k, v in self.paths.items()}, 'bindings': self.bindings_cache,
                'config_sha256': H.digest(raw), 'settings': settings, 'b_mount_dev_ino': [mount.st_dev, mount.st_ino],
                'source_hashes': SOURCE_HASHES, 'installer_sha256': H.digest(program_bytes(self.release / 'portable_install.py')),
                'prune_config_sha256': H.digest(self.config_text(settings).encode()),
                'service_sha256': H.digest(service.encode()), 'timer_sha256': H.digest(timer.encode()),
                'unit_directory': str(self.unit_dir), 'manager_unit_paths': unit_paths,
                'unit_source_sha256': self.unit_source_sha256(settings, unit_paths),
                'units_survive_reboot': True, 'starts_units': False, 'live_prune_qualified': False}
        return plan, H.digest(H.encoded(plan))

    def check(self):
        H.protected_chain(self.state)
        manifest = json.loads(H.read_file(self.state / 'install.json'))
        if (manifest.get('mode') != 'dry-run-only' or manifest.get('manager') != MANAGER or
                manifest.get('paths') != {k: str(v) for k, v in self.paths.items()} or
                manifest.get('unit_directory') != str(self.unit_dir)):
            raise ValueError('Installed dry-run tool binding differs')
        self.pins()
        # Custody of an OS tool is its root-owned chain (enforced by binding() in pins()). A changed sha
        # or resolved path, e.g. after an OS package upgrade, is recorded as evidence and does not stop the service.
        recorded = manifest.get('bindings') or {}
        self.binding_changes = sorted(name for name in BINDINGS if recorded.get(name) != self.bindings_cache.get(name))
        if H.digest(program_bytes(self.release / 'portable_install.py')) != manifest.get('installer_sha256'):
            raise ValueError('Installed portable installer changed')
        for name, expected in manifest['files'].items():
            path = (self.unit_dir / name) if name in (H.SERVICE, H.TIMER) else (self.state / name)
            H.protected_chain(path)
            if H.digest(H.read_file(path)) != expected:
                raise ValueError('Installed config, code or unit changed; re-prepare and review')
        settings = json.loads(H.read_file(self.state / 'deployment.json'))
        text = H.read_file(self.state / 'prune.toml').decode()
        if H.tomllib.loads(text).get('live_enabled') is not False or text != self.config_text(settings):
            raise ValueError('Only the exact installed dry-run configuration is allowed')
        unit_paths = self.manager_unit_paths()
        if (manifest.get('manager_unit_paths') != unit_paths or
                manifest.get('unit_source_sha256') != self.unit_source_sha256(settings, unit_paths)):
            raise ValueError('Installed unit source/manager directory binding changed; owner review required')
        self.verify_unit_sources(unit_paths, inactive=False, installed=True)
        return settings

    def manager_unit_paths(self):
        """Read only the fixed system manager property; never choose a fallback directory."""
        response = self.run([str(self.tool('systemctl')), 'show', '--property=UnitPath', '--value'])
        if response.returncode or not isinstance(response.stdout, str) or len(response.stdout) > 65536:
            raise ValueError('Cannot read the system manager UnitPath')
        raw = response.stdout.split()
        if not 0 < len(raw) <= 128 or len(set(raw)) != len(raw):
            raise ValueError('Ambiguous or oversized system manager UnitPath')
        paths = [str(H.absolute(value)) for value in raw]
        if str(self.unit_dir) not in paths:
            raise ValueError('Selected unit directory is absent from the system manager UnitPath')
        return paths

    def unit_source_sha256(self, settings, unit_paths):
        service, timer = self.units(settings)
        return H.digest(H.encoded({'unit_directory': str(self.unit_dir), 'manager_unit_paths': unit_paths,
                                  'installer_sha256': H.digest(program_bytes(self.release / 'portable_install.py')),
                                  'service_sha256': H.digest(service.encode()), 'timer_sha256': H.digest(timer.encode())}))

    def verify_unit_sources(self, unit_paths, *, inactive, installed=False):
        H.protected_chain(self.unit_dir, missing=not installed)
        for name in (H.SERVICE, H.TIMER):
            # Refuse even a lower-priority foreign unit: later manager changes
            # must not silently select an unrelated installation.
            shadows = [Path(directory) / suffix for directory in unit_paths
                       for suffix in (name, name + '.d')
                       if Path(directory) != self.unit_dir or suffix != name]
            shadows.extend((RUNTIME_UNITS / name, RUNTIME_UNITS / (name + '.d')))
            for path in shadows:
                if path.exists() or path.is_symlink():
                    raise ValueError('Foreign, runtime or drop-in cleanup units conflict; owner-controlled migration is required')
            properties = ('LoadState', 'FragmentPath', 'DropInPaths')
            if inactive:
                properties += ('ActiveState', 'SubState') + (('MainPID', 'ControlPID') if name == H.SERVICE else ())
            response = self.run([str(self.tool('systemctl')), 'show', *['--property=' + key for key in properties], name])
            if response.returncode or not isinstance(response.stdout, str) or len(response.stdout) > 65536:
                raise ValueError('Cannot read bounded cleanup unit source properties')
            lines = response.stdout.splitlines()
            values = dict(line.split('=', 1) for line in lines if '=' in line)
            if (len(lines) != len(properties) or
                    set(values) != set(properties) or values['LoadState'] not in ('loaded', 'not-found') or values['DropInPaths']):
                raise ValueError('Cannot confirm exact cleanup unit sources without drop-ins')
            if inactive and (values['ActiveState'] != 'inactive' or values['SubState'] != 'dead' or
                             (name == H.SERVICE and (values['MainPID'] != '0' or values['ControlPID'] != '0'))):
                raise ValueError('Cannot confirm inactive/dead cleanup units with no running processes')
            target = self.unit_dir / name
            if values['LoadState'] == 'not-found':
                if installed or values['FragmentPath'] or target.exists() or target.is_symlink():
                    raise ValueError('Unexpected cleanup unit fragment')
            else:
                if values['FragmentPath'] != str(target):
                    raise ValueError('Refusing to shadow an existing cleanup unit from another installation')
                H.protected_chain(target)
                if not H.read_file(target).startswith(MARKER.encode()):
                    raise ValueError('Existing cleanup unit is not owned by the portable installer')

    def require_inactive_units(self, expected_paths, *, installed=False):
        paths = self.manager_unit_paths()
        if paths != expected_paths:
            raise ValueError('System manager UnitPath changed since preparation')
        self.verify_unit_sources(paths, inactive=True, installed=installed)

    def apply(self, config, expected, *, enable_timer=False):
        if sys.platform != 'linux' or os.geteuid() != 0:
            raise ValueError('Apply requires ordinary owner-authorized root on the Linux host')
        if enable_timer:
            raise ValueError('Timer enablement unavailable: reviewed real lease, selftest and dry acceptance required')
        plan, actual = self.prepare(config)
        if expected != actual:
            raise ValueError('Prepared plan digest changed; review preparation again')
        container = self.run([str(self.tool('systemd-detect-virt')), '--container', '--quiet'])
        if container.returncode != 1:
            raise ValueError('Apply requires the systemd host, not container root or an unknown container boundary')
        settings = plan['settings']
        for eid in settings['employee_ids']:
            directory = H.plain_directory(Path(settings['laptop_home_root']) / eid / 'home' / settings['lease_subdir'])
            info = directory.lstat()
            if (info.st_uid, info.st_gid) != (settings['laptop_uid'], settings['laptop_gid']) or info.st_mode & 0o077:
                raise ValueError('Pre-create private persistent lease directories owned by the laptop user before installation')
        self.require_inactive_units(plan['manager_unit_paths'])
        H.mkdir_protected(self.state)
        H.mkdir_protected(self.state / 'docker-config')
        H.inventory(settings, self.tool('docker'), config_dir=self.state / 'docker-config', run=self.run)
        lock_fd = os.open(self.state / 'install.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        with os.fdopen(lock_fd, 'r+') as lock:
            H.protected_chain(self.state / 'install.lock')
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.require_inactive_units(plan['manager_unit_paths'])
            for directory in ('lib', 'host-leases', 'registry', 'logs'):
                H.mkdir_protected(self.state / directory)
            files = {'deployment.json': H.encoded(settings), 'prune.toml': self.config_text(settings).encode()}
            files.update({'lib/lease.py': program_bytes(self.release / 'lease.py')})
            for name, data in files.items():
                H.atomic(self.state / name, data, 0o444 if name.startswith('lib/') else 0o600)
            if H.digest(H.read_file(self.state / 'lib/lease.py')) != SOURCE_HASHES['lease.py']:
                raise ValueError('Copied executable source failed hash verification')
            service, timer = self.units(settings)
            files.update({H.SERVICE: service.encode(), H.TIMER: timer.encode()})
            manifest = {'version': 1, 'mode': 'dry-run-only', 'manager': MANAGER, 'plan_sha256': actual,
                        'paths': plan['paths'], 'bindings': plan['bindings'], 'installer_sha256': plan['installer_sha256'],
                        'unit_directory': str(self.unit_dir), 'manager_unit_paths': plan['manager_unit_paths'],
                        'unit_source_sha256': plan['unit_source_sha256'],
                        'files': {name: H.digest(data) for name, data in files.items()}}
            H.atomic(self.state / 'install.json', H.encoded(manifest), 0o600)
            H.mkdir_protected(self.unit_dir)
            for name, value in ((H.SERVICE, service), (H.TIMER, timer)):
                H.atomic(self.unit_dir / name, value.encode(), 0o644)
            response = self.run([str(self.tool('systemctl')), 'daemon-reload'])
            if response.returncode:
                raise ValueError('Units installed inactive but systemd reload was not confirmed')
            self.require_inactive_units(plan['manager_unit_paths'], installed=True)
            self.check()
        return {'status': 'INSTALLED_INACTIVE', 'plan_sha256': actual, 'timer_enabled': enable_timer, 'units_started': False,
                'unit_directory': str(self.unit_dir), 'unit_source_sha256': plan['unit_source_sha256'], 'units_survive_reboot': True,
                'next': f'Run the self-test, then systemctl start {H.SERVICE}; inspect private reports before enabling the timer.'}


def install_release(source, prefix):
    """Copy an unpacked, verified release into <prefix>/<RELEASE>. Idempotent for identical bytes; never overwrites."""
    if sys.platform != 'linux' or os.geteuid() != 0:
        raise ValueError('Release installation requires ordinary owner-authorized root on the Linux host')
    source, prefix = H.absolute(source), H.absolute(prefix)
    # Root reads release bytes only from a root-owned directory the owner extracted the pinned tarball into.
    H.protected_chain(source)
    for name in (*RELEASE_FILES, 'SHA256SUMS'):
        H.protected_chain(source / name)
    sums = {}
    for line in H.read_file(source / 'SHA256SUMS').decode().splitlines():
        checksum, _, name = line.partition('  ')
        sums[name] = checksum
    if set(sums) != set(RELEASE_FILES):
        raise ValueError('Release SHA256SUMS must list exactly the release files')
    data = {}
    for name in RELEASE_FILES:
        data[name] = H.read_file(source / name)
        if H.digest(data[name]) != sums[name] or (name in SOURCE_HASHES and sums[name] != SOURCE_HASHES[name]):
            raise ValueError('Release file does not match its pinned sha256')
    if data['portable_install.py'] != H.read_file(H.absolute(__file__)):
        raise ValueError('Run the installer from the release being installed')
    target = prefix / RELEASE
    H.mkdir_protected(target)
    for name in RELEASE_FILES:
        path = target / name
        if path.exists() or path.is_symlink():
            H.protected_chain(path)
            if H.read_file(path) != data[name]:
                raise ValueError('An installed release file differs; a new revision needs a new prefix entry')
        else:
            H.atomic(path, data[name], 0o444)
    return {'status': 'RELEASE_INSTALLED', 'release': str(target), 'files': sums}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument('--state-dir', default='/var/lib/reverie-prune')
    parser.add_argument('--prefix', default='/usr/local/lib/reverie-prune')
    parser.add_argument('--unit-dir', choices=[str(path) for path in UNIT_DIRS])
    for flag in ('python', 'docker', 'systemctl'):
        parser.add_argument('--' + flag)
    parser.add_argument('--config', type=Path)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--install-release', type=Path, metavar='UNPACKED_RELEASE_DIR')
    modes.add_argument('--apply', action='store_true')
    modes.add_argument('--inventory', action='store_true')
    modes.add_argument('--check', action='store_true')
    parser.add_argument('--expect-plan')
    parser.add_argument('--render-units', type=Path, metavar='DIR', help='with prepare: also write the rendered units here (for systemd-analyze verify)')
    parser.add_argument('--enable-timer', action='store_true')
    arguments = sys.argv[1:] if argv is None else argv
    for flag in ('state-dir', 'prefix', 'unit-dir', 'python', 'docker', 'systemctl', 'config'):
        if sum(a.split('=', 1)[0] == '--' + flag for a in arguments) > 1:
            parser.error('Fixed bindings cannot be overridden')
    args = parser.parse_args(arguments)
    try:
        if args.install_release:
            result = install_release(args.install_release, args.prefix)
        elif args.inventory or args.check:
            if args.python or args.docker or args.systemctl or args.config or args.unit_dir:
                raise ValueError('Check and inventory use only the bindings recorded at install')
            installer = PortableInstaller.from_state(args.state_dir)
            settings = installer.check()
            if args.inventory:
                result = H.inventory(settings, installer.tool('docker'), config_dir=installer.state / 'docker-config', run=installer.run)
            else:
                result = {'status': 'CHECKED_PORTABLE_DRY_RUN_ONLY', 'binding_changes': installer.binding_changes}
        else:
            if not (args.python and args.docker and args.systemctl and args.config):
                raise ValueError('Prepare/apply need explicit --python, --docker, --systemctl and an owner-reviewed --config')
            if args.enable_timer and not args.apply:
                raise ValueError('--enable-timer requires explicit --apply')
            installer = PortableInstaller(args.state_dir, args.prefix, args.python, args.docker, args.systemctl, unit_dir=args.unit_dir)
            if args.apply:
                result = installer.apply(args.config, args.expect_plan, enable_timer=args.enable_timer)
            else:
                plan, digest = installer.prepare(args.config)
                if args.render_units:
                    service, timer = installer.units(plan['settings'])
                    args.render_units.mkdir(parents=True, exist_ok=True)
                    (args.render_units / H.SERVICE).write_text(service)
                    (args.render_units / H.TIMER).write_text(timer)
                result = {'plan': plan, 'plan_sha256': digest}
        print(json.dumps(result, sort_keys=True, indent=2))
        return 0
    except (ValueError, OSError, KeyError, TypeError, json.JSONDecodeError, subprocess.SubprocessError) as error:
        print('reverie-prune-portable: ' + str(error), file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
