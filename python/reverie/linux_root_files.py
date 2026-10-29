"""Bounded Linux init-root file access. No namespace switch, exec or authority.

Linux openat2 on x86_64/aarch64; unsupported kernels/architectures refuse.
All callers supply fixed validated paths, never arbitrary request paths.
"""
import ctypes
import os
from pathlib import Path
import platform
from .owner_terminal_channel import need


def open_in_root(root, path, *, path_link=False):
    need(platform.machine() in ('x86_64', 'aarch64'), 'OPENAT2_PLATFORM_UNQUALIFIED')
    need(type(path) is str and path.startswith('/') and '..' not in Path(path).parts, 'FIXED_ROOT_PATH')
    class How(ctypes.Structure):
        _fields_ = [('flags', ctypes.c_uint64), ('mode', ctypes.c_uint64), ('resolve', ctypes.c_uint64)]
    # Linux x86_64/aarch64 openat2=437; IN_ROOT|NO_MAGICLINKS|NO_SYMLINKS.
    flags = os.O_PATH | os.O_NOFOLLOW | os.O_CLOEXEC if path_link else os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC
    how = How(flags, 0, 0x10 | 0x02 | 0x04)
    libc = ctypes.CDLL(None, use_errno=True)
    fd = libc.syscall(437, root, os.fsencode(path), ctypes.byref(how), ctypes.sizeof(how))
    if fd < 0:
        raise OSError(ctypes.get_errno(), 'Qualified root path unavailable')
    return fd


def mapped_root_uid(pid):
    with (Path('/proc') / str(pid) / 'uid_map').open('rb') as stream:
        raw = stream.read(4097)
    need(len(raw) <= 4096, 'UID_MAP_BOUND')
    rows = [tuple(int(n) for n in line.split()) for line in raw.splitlines()]
    need(1 <= len(rows) <= 64 and all(len(row) == 3 and row[2] > 0 for row in rows), 'UID_MAP_REQUIRED')
    selected = [outside for inside, outside, size in rows if inside == 0 and size > 0]
    need(len(selected) == 1, 'ROOT_UID_MAPPING_REQUIRED')
    return selected[0]
