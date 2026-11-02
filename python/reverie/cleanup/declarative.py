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
import re
import subprocess
import sys

# -I excludes PYTHONPATH and the script directory. Load only the packaged sibling;
# the launcher and this entire output are in the immutable, root-owned Nix store.
_spec = importlib.util.spec_from_file_location(
    '_reverie_prune_host_install', Path(__file__).with_name('host_install.py'))
H = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(H)

MANAGER = 'nixos-declarative-dry-run-v1'
MODES = ('dry-run-only', 'live-enabled')
IDENTITY_KEYS = ('fstype', 'mount_root', 'source')
ACCEPTANCE_KEYS = {'dry_run_report_sha256', 'signoff', 'selftest_receipt', 'selftest_receipt_sha256'}
RECEIPT_COPY = 'live-selftest-receipt.json'


def _line(value):
    return isinstance(value, str) and value != '' and not any(c in value for c in '\n\r\0')


class DeclaredInstaller(H.Installer):
    """The separate r12 launcher selects this class, never a caller argument.

    The historical r8 bootstrap and its declaration launcher retain H.Installer.
    Declaration-specific policy/config extensions belong here, not in H.
    """
    source_hashes = {
        'reverie_prune.py': '55f26deec48c2c5d25b7d2509aa2ec28a22b1ebb0a6747c8be021a79129d4bed',
        'lease.py': '606cacea83ebb70bb805423e67be44168fec411d3e5c62c5e563c416ab6891aa',
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
        """The r8 policy for the shared keys, plus the declared r12 keys: root identities (r12 admits only operator-approved
        roots, also in dry-run) and the live switch with its acceptance record. Live is never the default."""
        if not isinstance(raw, dict):
            raise ValueError('Unknown deployment key or unsupported configuration version')
        raw = dict(raw)
        identities = raw.pop('root_identities', {})
        live = raw.pop('live_enabled', False)
        acceptance = raw.pop('live_acceptance', None)
        settings = H.policy(raw, self.state)
        if type(live) is not bool:
            raise ValueError('live_enabled must be a boolean')
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
        if live:
            hexes = ('dry_run_report_sha256', 'selftest_receipt_sha256')
            if (not isinstance(acceptance, dict) or set(acceptance) != ACCEPTANCE_KEYS or
                    not all(isinstance(acceptance[k], str) and re.fullmatch(r'[0-9a-f]{64}', acceptance[k]) for k in hexes) or
                    not _line(acceptance['signoff']) or len(acceptance['signoff']) > 256 or
                    not _line(acceptance['selftest_receipt'])):
                raise ValueError('Live enablement requires the accepted dry-run report sha256, a reviewer sign-off and '
                                 'the self-test PASS receipt path and sha256')
            receipt = H.absolute(acceptance['selftest_receipt'])
            if receipt.is_relative_to(self.state):
                raise ValueError('The self-test receipt must come from outside the fresh live state directory')
            acceptance = dict(acceptance, selftest_receipt=str(receipt))
            if settings['checkout_roots']:
                raise ValueError('Live enablement does not yet cover checkout roots')
        elif acceptance is not None:
            raise ValueError('live_acceptance is only meaningful with live_enabled = true')
        settings['root_identities'] = clean
        settings['live_enabled'] = live
        if live:
            settings['live_acceptance'] = dict(acceptance)
        return settings

    def config_text(self, settings):
        inventory = [str(self.paths['closure'] / 'bin/reverie-prune-declared'),
                     '--state-dir', str(self.state), '--inventory']
        text = '\n'.join('laptops_cmd = ' + json.dumps(inventory, ensure_ascii=False)
                         if line.startswith('laptops_cmd = ') else line
                         for line in super().config_text(settings).splitlines()) + '\n'
        head = 'live_enabled = false\n'
        if not text.startswith(head):
            raise ValueError('Unexpected base cleanup configuration layout')
        table = ', '.join(json.dumps(root) + ' = {' + ', '.join(f'{k} = {json.dumps(v)}' for k, v in ident.items()) + '}'
                          for root, ident in sorted(settings['root_identities'].items()))
        return ('live_enabled = ' + ('true' if settings['live_enabled'] else 'false') + '\n' + text[len(head):] +
                'root_identities = {' + table + '}\n')

    def selftest_receipt(self, settings, data=None):
        """Live only with a PASS receipt of the module self-test naming exactly this package's prune and lease.
        Returns the verified receipt bytes (the declared file, or the copy already in state)."""
        acceptance = settings['live_acceptance']
        if data is None:
            path = Path(acceptance['selftest_receipt'])
            H.protected_chain(path)
            data = H.read_file(path)
        if H.digest(data) != acceptance['selftest_receipt_sha256']:
            raise ValueError('Self-test receipt differs from the sha256 named in the live declaration')
        receipt = json.loads(data)
        files = receipt.get('files') if isinstance(receipt, dict) else None
        def pinned(name):
            entry = files.get(name) if isinstance(files, dict) else None
            return entry[1] if isinstance(entry, list) and len(entry) == 2 else None
        if (receipt.get('status') != 'PASS' or pinned('prune') != self.source_hashes['reverie_prune.py'] or
                pinned('lease') != self.source_hashes['lease.py']):
            raise ValueError('Live enablement requires a self-test PASS receipt for this exact prune and lease')
        return data

    def check(self):
        """Exact installed declared state in either mode: binding, pins, every recorded digest, and a prune.toml whose live
        switch matches the recorded mode and settings. Replaces the r8 installer's dry-run-only check for r12 state."""
        H.protected_chain(self.state)
        manifest = json.loads(H.read_file(self.state / 'install.json'))
        mode = manifest.get('mode')
        if mode not in MODES or manifest.get('paths') != {k: str(v) for k, v in self.paths.items()}:
            raise ValueError('Installed declared tool binding differs')
        self.pins()
        for name, expected in manifest['files'].items():
            path = self.state / name
            H.protected_chain(path)
            if H.digest(H.read_file(path)) != expected:
                raise ValueError('Installed config/code changed; re-declare fresh state after review')
        settings = json.loads(H.read_file(self.state / 'deployment.json'))
        text = H.read_file(self.state / 'prune.toml').decode()
        live = mode == 'live-enabled'
        if (H.tomllib.loads(text).get('live_enabled') is not live or settings.get('live_enabled') is not live or
                text != self.config_text(settings)):
            raise ValueError('Only the exact installed declared configuration is allowed')
        if live:
            if RECEIPT_COPY not in manifest['files']:
                raise ValueError('Live state lacks its verified self-test receipt')
            self.selftest_receipt(settings, H.read_file(self.state / RECEIPT_COPY))
        return settings


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
    if settings.get('live_enabled') is True:
        files[RECEIPT_COPY] = installer.selftest_receipt(settings)  # verified copy, digest-pinned in the manifest
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
    live = settings.get('live_enabled') is True
    manifest = {'version': 1, 'mode': MODES[1] if live else MODES[0], 'manager': MANAGER,
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
    return {'status': 'CHECKED_DECLARED_LIVE_ENABLED' if live else 'CHECKED_DECLARED_DRY_RUN_ONLY',
            'state': str(installer.state), 'live_prune_qualified': live, 'units_modified': False}


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
