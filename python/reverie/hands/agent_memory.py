"""Existing instance and room custody for the Hands journal worker."""
from __future__ import annotations
from pathlib import Path
from typing import Callable
from uuid import UUID

from reverie.instance import load_instance
from reverie.memory import MemoryStore


def uuid(value):
    if not isinstance(value, str) or str(UUID(value)) != value:
        raise ValueError('canonical full UUID required')
    return value


class RoomMemory:
    def __init__(self, instance_file: Path, access: Callable[[str], str | None], embedder=None):
        if not Path(instance_file).is_absolute():
            raise ValueError('select an absolute owner instance config')
        self.instance = load_instance(Path(instance_file))
        self.root = self.instance.data_dir / 'harness-room-memory-v1'
        self.access = access
        self.embedder = embedder

    def _allowed(self, room):
        uuid(room)
        if self.access(room) != 'shared':
            raise PermissionError('current shared-room membership required; DMs excluded')

    def _open(self, room):
        self._allowed(room)
        directory = self.root / room
        for path in [self.root, directory, directory / 'memory.sqlite']:
            if path.is_symlink():
                raise ValueError('room memory path may not be a symlink')
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        directory.mkdir(mode=0o700, exist_ok=True)
        store = MemoryStore(directory / 'memory.sqlite', embedder=self.embedder)
        (directory / 'memory.sqlite').chmod(0o600)
        return store
