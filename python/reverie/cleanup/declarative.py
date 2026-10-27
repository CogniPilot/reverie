"""Initialize or verify NixOS-declared dry-run state, without managing units.

The isolated Nix launcher supplies every executable. Deployment settings come
from an immutable Nix output. Existing state is never adopted or upgraded.
"""
from __future__ import annotations

import argparse
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

# -I excludes PYTHONPATH and the script directory. Load only the packaged sibling;
# the launcher and this entire output are in the immutable, root-owned Nix store.
_spec = importlib.util.spec_from_file_location(
    '_reverie_prune_host_install', Path(__file__).with_name('host_install.py'))
H = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(H)

MANAGER = 'nixos-declarative-dry-run-v1'


class DeclaredInstaller(H.Installer):
    """The separate r12 launcher selects this class, never a caller argument.

    The historical r8 bootstrap and its declaration launcher retain H.Installer.
    Declaration-specific policy/config extensions belong here, not in H.
    """
    source_hashes = {
        'reverie_prune.py': 'fbed566fbdfe89d312abb8b1b32354e5f44f35b94918028ce882fbf444b17181',
        'lease.py': '4a1022e5536f989f9d4ef8495e52d035c497e2567b331b6f82aacbb5285f3d41',
    }

    def pins(self):
        for key, path in self.paths.items():
            H.immutable(path, directory=key in ('package', 'closure'))
        for name, checksum in self.source_hashes.items():
            if H.digest(H.read_file(self.paths['package'] / 'libexec/reverie' / name)) != checksum:
                raise ValueError('Reviewed r12 prune/lease package source hash differs')
        H.immutable(self.paths['package'] / 'bin/reverie-prune')
        H.immutable(self.paths['closure'] / 'bin/reverie-prune-declared')
        H.immutable(self.paths['systemctl'].parent / 'systemd-detect-virt')

    def policy(self, raw):
        return H.policy(raw, self.state)

    def config_text(self, settings):
        inventory = [str(self.paths['closure'] / 'bin/reverie-prune-declared'),
                     '--state-dir', str(self.state), '--inventory']
        return '\n'.join('laptops_cmd = ' + json.dumps(inventory, ensure_ascii=False)
                         if line.startswith('laptops_cmd = ') else line
                         for line in super().config_text(settings).splitlines()) + '\n'


def source_hashes(installer):
    return getattr(installer, 'source_hashes', H.SOURCE_HASHES)


def declared_units(installer):
    """Never mask, replace or use bootstrap/transient units or runtime drop-ins."""
    for name in (H.SERVICE, H.TIMER):
        for path in (H.UNITS / name, H.UNITS / (name + '.d')):
            if path.exists() or path.is_symlink():
                raise ValueError('Runtime cleanup units/drop-ins conflict with the declared service; owner-controlled migration is required')
        response = installer.run([str(installer.paths['systemctl']), 'show',
                                  '--property=LoadState', '--property=FragmentPath', name])
        lines = response.stdout.splitlines()
        values = dict(line.split('=', 1) for line in lines if '=' in line)
        if (response.returncode or len(lines) != 2 or set(values) != {'LoadState', 'FragmentPath'} or
                values['LoadState'] != 'loaded' or
                values['FragmentPath'] != '/etc/systemd/system/' + name):
            raise ValueError('Cannot confirm the NixOS-declared cleanup unit binding')


def expected_files(installer, settings):
    files = {'deployment.json': H.encoded(settings),
             'prune.toml': installer.config_text(settings).encode()}
    files.update({'lib/' + name: H.read_file(installer.paths['package'] / 'libexec/reverie' / name)
                  for name in source_hashes(installer)})
    return files


def initialize(installer, config):
    if sys.platform != 'linux' or os.geteuid() != 0:
        raise ValueError('Declared state requires ordinary owner-authorized root on the Linux host')
    installer.pins()
    H.immutable(config)
    container = installer.run([str(installer.paths['systemctl'].parent / 'systemd-detect-virt'), '--container', '--quiet'])
    if container.returncode != 1:
        raise ValueError('Declared state requires the systemd host, not container root or an unknown boundary')
    declared_units(installer)
    H.protected_chain(installer.state, missing=True)
    if installer.state in map(Path, ('/', '/etc', '/usr', '/var', '/var/lib', '/run', '/home', '/nix', '/nix/store')):
        raise ValueError('Choose a dedicated protected application state directory')
    raw = json.loads(H.read_file(config))
    settings = installer.policy(raw) if isinstance(installer, DeclaredInstaller) else H.policy(raw, installer.state)
    for eid in settings['employee_ids']:
        directory = H.plain_directory(Path(settings['laptop_home_root']) / eid / 'home' / settings['lease_subdir'])
        info = directory.lstat()
        if (info.st_uid, info.st_gid) != (settings['laptop_uid'], settings['laptop_gid']) or info.st_mode & 0o077:
            raise ValueError('Persistent lease directories must already be private and owned by the laptop user')
    files = expected_files(installer, settings)
    manifest = {'version': 1, 'mode': 'dry-run-only', 'manager': MANAGER,
                'paths': {key: str(value) for key, value in installer.paths.items()},
                'files': {name: H.digest(data) for name, data in files.items()}}
    H.mkdir_protected(installer.state)
    lock_fd = os.open(installer.state / 'install.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    with os.fdopen(lock_fd, 'r+') as lock:
        H.protected_chain(installer.state / 'install.lock')
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        declared_units(installer)
        installed = installer.state / 'install.json'
        if installed.exists() or installed.is_symlink():
            H.protected_chain(installed)
            if H.read_file(installed) != H.encoded(manifest):
                raise ValueError('Declared configuration/package changed or state has another owner; explicitly declare fresh state after owner review')
            installer.check()
        else:
            if set(p.name for p in installer.state.iterdir()) != {'install.lock'}:
                raise ValueError('Refusing to adopt existing or partially initialized state; explicitly declare fresh state')
            for directory in ('lib', 'host-leases', 'registry', 'logs', 'docker-config'):
                H.mkdir_protected(installer.state / directory)
            # Verify actual read-only engine protocol before installing executable state.
            H.inventory(settings, installer.paths['docker'], config_dir=installer.state / 'docker-config', run=installer.run)
            for name, data in files.items():
                H.atomic(installer.state / name, data, 0o444 if name.startswith('lib/') else 0o600)
            for name, checksum in source_hashes(installer).items():
                path = installer.state / 'lib' / name
                H.protected_chain(path)
                if H.digest(H.read_file(path)) != checksum:
                    raise ValueError('Copied executable source failed hash verification')
            H.atomic(installed, H.encoded(manifest), 0o600)
            installer.check()
        H.inventory(settings, installer.paths['docker'], config_dir=installer.state / 'docker-config', run=installer.run)
    return {'status': 'CHECKED_DECLARED_DRY_RUN_ONLY', 'state': str(installer.state),
            'live_prune_qualified': False, 'units_modified': False}


def main(argv=None, *, installer_type=H.Installer):
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    pins = ('package', 'python', 'docker', 'systemctl', 'nix-store', 'closure')
    for flag in pins:
        parser.add_argument('--' + flag, required=True)
    parser.add_argument('--state-dir', required=True)
    parser.add_argument('--config', type=Path)
    parser.add_argument('--inventory', action='store_true')
    arguments = sys.argv[1:] if argv is None else argv
    for flag in (*pins, 'state-dir', 'config'):
        if sum(a.split('=', 1)[0] == '--' + flag for a in arguments) > 1:
            parser.error('Declared bindings cannot be overridden')
    args = parser.parse_args(arguments)
    try:
        installer = installer_type(args.state_dir, args.package, args.python, args.docker,
                                   args.systemctl, args.nix_store, args.closure)
        if args.inventory:
            if args.config is not None:
                raise ValueError('Inventory uses only the installed root-controlled configuration')
            settings = installer.check()
            manifest = json.loads(H.read_file(installer.state / 'install.json'))
            if manifest.get('manager') != MANAGER:
                raise ValueError('Inventory requires matching declared state')
            result = H.inventory(settings, installer.paths['docker'], config_dir=installer.state / 'docker-config', run=installer.run)
        else:
            if args.config is None:
                raise ValueError('Initialization requires an immutable --config')
            result = initialize(installer, args.config)
        print(json.dumps(result, sort_keys=True))
        return 0
    except (ValueError, OSError, KeyError, TypeError, json.JSONDecodeError, subprocess.SubprocessError) as error:
        print('reverie-prune-declared: ' + str(error), file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
