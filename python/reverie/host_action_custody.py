"""Host-only signing-key custody checks; no discovery or laptop API.

The service must supply a complete, current host inventory of bind sources from
both worker configuration and engine inspection. An absent inventory refuses.
This does not prove that the inventory is complete or authorize service startup.
"""
import os
from pathlib import Path
import stat


def _absolute(value):
    path = Path(value)
    if not path.is_absolute() or '..' in path.parts:
        raise ValueError('Absolute normalized custody path required')
    return path


def _overlap(left, right):
    return left.is_relative_to(right) or right.is_relative_to(left)


def load_key(path, *, exposed_roots, uid=None):
    """Read exactly one private 32-byte key through anchored no-follow FDs.

    Reject lexical AND resolved mount overlap, including read-only exposures.
    Trusted root-owned sticky ancestors permit ordinary private runtime fixtures;
    all other ancestors must be owned by root/the service and not writable by
    another user. Never include paths, key bytes or exception contents in logs.
    """
    uid = os.getuid() if uid is None else uid
    target = _absolute(path)
    if not isinstance(exposed_roots, (list, tuple)) or not exposed_roots:
        raise ValueError('Complete host mount inventory required')
    resolved = target.resolve(strict=True)
    for root in exposed_roots:
        root = _absolute(root)
        real = root.resolve(strict=True)
        if any(_overlap(a, b) for a in (target, resolved) for b in (root, real)):
            raise ValueError('Signing key overlaps an exposed mount')
    if resolved.is_relative_to('/nix/store'):
        raise ValueError('Signing keys cannot enter the package store')
    directory = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for component in target.parts[1:-1]:
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                            dir_fd=directory)
            os.close(directory)
            directory = child
            info = os.fstat(directory)
            sticky_root = info.st_uid == 0 and info.st_mode & stat.S_ISVTX
            if info.st_uid not in (0, uid) or (info.st_mode & 0o022 and not sticky_root):
                raise ValueError('Untrusted signing-key ancestor')
        parent = os.fstat(directory)
        if parent.st_uid != uid or parent.st_mode & 0o077:
            raise ValueError('Signing-key directory must be private and owned')
        fd = os.open(target.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                     dir_fd=directory)
        try:
            before = os.fstat(fd)
            if (not stat.S_ISREG(before.st_mode) or before.st_uid != uid or
                    before.st_mode & 0o077 or before.st_nlink != 1 or before.st_size != 32):
                raise ValueError('Invalid private signing-key file')
            key = os.read(fd, 33)
            after = os.fstat(fd)
            if (len(key) != 32 or (before.st_dev, before.st_ino, before.st_size,
                    before.st_mtime_ns, before.st_ctime_ns) != (after.st_dev,
                    after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)):
                raise ValueError('Signing key changed during read')
            return key
        finally:
            os.close(fd)
    finally:
        os.close(directory)
