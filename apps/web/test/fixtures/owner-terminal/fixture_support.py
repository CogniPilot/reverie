"""Owned test infrastructure; no production bootstrap/authority substitutions.

Nix's rootless build namespace maps host-owned immutable store files to nobody.
Only the explicit Nix check may normalize the exact already selected Node inode's
UID for this fixture. Every other stat field and all real channel checks remain.
"""
import os
from pathlib import Path
import select
import time
from unittest.mock import patch


def run_backend(entry, node, argv, *, normalize_unmapped_node=False):
    if not normalize_unmapped_node:
        return entry(node, argv)
    selected = Path(node)
    original = selected.stat()
    if original.st_uid == 0:
        return entry(node, argv)
    if (original.st_uid != 65534 or Path('/').stat().st_uid != 65534 or
            not node.startswith('/nix/store/') or selected.resolve(strict=True) != selected):
        raise ValueError('Owned Nix node fixture metadata unavailable')
    identity = (original.st_dev, original.st_ino, original.st_mode, original.st_uid, original.st_gid)
    native_stat = Path.stat

    def fixture_stat(path, *args, **kwargs):
        info = native_stat(path, *args, **kwargs)
        if path != selected:
            return info
        if (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid) != identity:
            raise ValueError('Owned Nix node fixture identity changed')
        fields = list(info)
        fields[4] = 0
        return os.stat_result(fields)

    with patch.object(Path, 'stat', fixture_stat):
        return entry(node, argv)


def stop_child(process):
    if process.poll() is None:
        process.kill()
    return process.communicate(timeout=3)


def accept_child(listener, process, stage, *, timeout=3):
    deadline = time.monotonic() + timeout
    while True:
        ended = process.poll() is not None
        remaining = deadline - time.monotonic()
        if ended or remaining <= 0:
            stdout, stderr = stop_child(process)
            raise AssertionError(
                f'Owned backend {stage} failed (exit {process.returncode}): '
                f'stdout={stdout[:4096]!r}; stderr={stderr[:4096]!r}')
        if select.select([listener], [], [], min(remaining, .05))[0]:
            return listener.accept()[0]
