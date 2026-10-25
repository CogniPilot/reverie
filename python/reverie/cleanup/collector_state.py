"""Prepare private collector output without adopting another application's data."""
import argparse
import json
import os
from pathlib import Path
import stat

MARKER = b'{"application":"reverie-collect","version":1}\n'


def prepare(value):
    if os.geteuid() != 0:
        raise ValueError('Collector service state requires ordinary host administrator activation')
    path = Path(value)
    if (not path.is_absolute() or os.path.normpath(str(path)) != str(path) or
            any(ord(c) < 32 or ord(c) == 127 for c in str(path)) or
            str(path) in ('/', '/var', '/var/lib', '/etc', '/home', '/run', '/usr', '/nix', '/nix/store')):
        raise ValueError('A dedicated canonical state directory is required')
    for parent in [*reversed(path.parents), path]:
        if not parent.exists() and not parent.is_symlink():
            parent.mkdir(mode=0o700)
        info = parent.lstat()
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022):
            raise ValueError('Collector state ancestry must be root-owned real directories, not writable by others')
    if path.stat().st_mode & 0o077:
        raise ValueError('Collector state must be private; existing directories are never chmodded or chowned')
    marker = path / '.reverie-collector-state.json'
    if marker.exists() or marker.is_symlink():
        fd = os.open(marker, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
        with os.fdopen(fd, 'rb') as stream:
            info = os.fstat(stream.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or
                    info.st_mode & 0o077 or stream.read(len(MARKER) + 1) != MARKER):
                raise ValueError('Collector state marker is invalid')
    else:
        if any(path.iterdir()):
            raise ValueError('Refusing to adopt existing collector state without its custody marker')
        fd = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(MARKER)
            stream.flush()
            os.fsync(stream.fileno())
    return {'status': 'COLLECTOR_STATE_READY', 'state': str(path)}


def main():
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument('--state-dir', required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(prepare(args.state_dir), sort_keys=True))
        return 0
    except (OSError, ValueError) as error:
        print('reverie-collect-state: ' + str(error))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
