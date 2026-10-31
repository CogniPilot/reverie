"""Prepare dedicated phase-3 fixture custody; never run a test or manage units."""
import argparse
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import sys

_spec = importlib.util.spec_from_file_location('_prune_selftest_host', Path(__file__).with_name('host_install.py'))
H = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(H)

PRUNE_SHA = '55f26deec48c2c5d25b7d2509aa2ec28a22b1ebb0a6747c8be021a79129d4bed'
LEASE_SHA = '606cacea83ebb70bb805423e67be44168fec411d3e5c62c5e563c416ab6891aa'
KIT = {
    'selftest.py': '2468295330b1d75a4c7eefff6f8f1d2669e792cf13515277c2b1143e6a6c591c',
    'p3kit.py': '34a1642b16484aeb876277e87a058556ef8f47c608cc64acf3268b06f37c6a83',
    'suite.py': '3dd4961eeda3045a0962bb2c1af491370b3526fbdaa955b078128f8df4027e98',
    'p3_host_runner.sh': '401569b70f20f7f7f0883134d3a1ca88832f8dc33bf6de46bca7c593847e7927',
}


def policy(raw):
    keys = {'version', 'b_mount', 'laptops_root', 'laptop_uid', 'laptop_gid', 'uid', 'gid', 'base', 'state', 'live_state'}
    if not isinstance(raw, dict) or set(raw) != keys or type(raw['version']) is not int or raw['version'] != 1:
        raise ValueError('Exact version-1 selftest configuration required')
    result = dict(raw)
    for name in ('b_mount', 'base', 'state', 'live_state'):
        result[name] = H.absolute(raw[name])
    b, base, state, live = (result[name] for name in ('b_mount', 'base', 'state', 'live_state'))
    if b == Path('/') or not os.path.ismount(H.plain_directory(b)):
        raise ValueError('Selftest requires the actual disposable filesystem mount')
    if not re.fullmatch(r'[A-Za-z0-9._-]+', base.name) or base.name in ('.', '..') or base.parent != b:
        raise ValueError('Fixture must be a dedicated plain-named immediate child of the disposable mount')
    relative = raw['laptops_root']
    if not isinstance(relative, str) or not relative or Path(relative).is_absolute() or '..' in Path(relative).parts or os.path.normpath(relative) != relative:
        raise ValueError('Canonical relative laptops root required')
    laptops = b / relative
    if base.is_relative_to(laptops) or laptops.is_relative_to(base):
        raise ValueError('Synthetic fixture must remain outside real laptop scratch')
    if state.is_relative_to(b) or state.is_relative_to(live) or live.is_relative_to(state):
        raise ValueError('Receipt state must be outside the disposable mount and production state')
    if state in map(Path, ('/', '/etc', '/var', '/var/lib', '/run', '/home', '/nix', '/nix/store')):
        raise ValueError('Dedicated protected receipt state required')
    for name, real in (('uid', 'laptop_uid'), ('gid', 'laptop_gid')):
        if any(type(raw[key]) is not int or raw[key] <= 0 for key in (name, real)) or raw[name] == raw[real]:
            raise ValueError('Dedicated nonzero fixture UID/GID must differ from the real laptop')
    for path in (b, base, state):
        H.protected_chain(path, missing=True)
    return result


def prepare(config, package, prune, detect_virt, *, run=H.command):
    if sys.platform != 'linux' or os.geteuid() != 0:
        raise ValueError('Selftest custody requires owner-authorized Linux host root')
    for path in (config, package, prune, detect_virt):
        H.immutable(path, directory=path == package)
    if run([str(detect_virt), '--container', '--quiet']).returncode != 1:
        raise ValueError('Selftest custody requires the real systemd host')
    for name, checksum in KIT.items():
        if H.digest(H.read_file(package / 'libexec/reverie/selftest' / name)) != checksum:
            raise ValueError('Reviewed selftest kit hash differs')
    lease = package / 'libexec/reverie/lease.py'
    if H.digest(H.read_file(lease)) != LEASE_SHA or H.digest(H.read_file(prune)) != PRUNE_SHA:
        raise ValueError('Reviewed prune/lease hash differs')
    raw = H.read_file(config)
    settings = policy(json.loads(raw))
    base, state = settings['base'], settings['state']
    marker = H.encoded({'version': 1, 'manager': 'reverie-prune-selftest-r2', 'config_sha256': H.digest(raw),
                        'kit': KIT, 'prune': PRUNE_SHA, 'lease': LEASE_SHA,
                        'mount_dev_ino': [settings['b_mount'].stat().st_dev, settings['b_mount'].stat().st_ino]})
    # Never adopt even an empty pre-existing directory without our exact marker.
    for directory, name in ((base, '.selftest-owner.json'), (state, 'selftest-install.json')):
        if directory.exists():
            H.protected_chain(directory / name)
            if H.read_file(directory / name) != marker:
                raise ValueError('Foreign or changed selftest state requires owner-reviewed migration')
    fresh_state = not state.exists()
    H.mkdir_protected(state)
    fd = os.open(state / 'prepare.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    with os.fdopen(fd, 'r+') as lock:
        H.protected_chain(state / 'prepare.lock')
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        if fresh_state:
            H.mkdir_protected(state / 'lib')
            H.atomic(state / 'lib/lease.py', H.read_file(lease), 0o444)
            H.atomic(state / 'selftest-install.json', marker, 0o600)
        H.protected_chain(state / 'lib/lease.py')
        if H.digest(H.read_file(state / 'lib/lease.py')) != LEASE_SHA:
            raise ValueError('Protected selftest lease copy changed')
        if not base.exists():
            H.mkdir_protected(base)
            # The fixture user must traverse the base, but cannot create entries.
            base.chmod(0o711)
            H.atomic(base / '.selftest-owner.json', marker, 0o600)
    return {'status': 'PREPARED_SELFTEST_ONLY', 'tests_started': False}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    for flag in ('config', 'package', 'prune', 'detect-virt'):
        parser.add_argument('--' + flag, type=Path, required=True)
    arguments = sys.argv[1:] if argv is None else argv
    for flag in ('config', 'package', 'prune', 'detect-virt'):
        if sum(arg.split('=', 1)[0] == '--' + flag for arg in arguments) > 1:
            parser.error('Fixed selftest bindings cannot be overridden')
    args = parser.parse_args(arguments)
    try:
        print(json.dumps(prepare(args.config, args.package, args.prune, args.detect_virt), sort_keys=True))
        return 0
    except (ValueError, OSError, KeyError, TypeError) as error:
        print('reverie-prune-selftest-prepare: ' + str(error), file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
