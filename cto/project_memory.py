"""Explicit project-wide recall, physically separate from CTO's personal memory."""
from __future__ import annotations

import re
from pathlib import Path

from .memory import MemoryStore


class ProjectMemory:
    def __init__(self, root: Path, project: str):
        if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", project):
            raise ValueError("project must be a lowercase project identifier")
        self.project = project
        self.store = MemoryStore(root / project / "memory.sqlite")

    def lookup(self, query: str) -> list[dict]:
        return [m.as_dict() for m in self.store.retrieve(query, k=6)]

    def remember(self, text: str, source: str) -> dict:
        if not text.strip() or not source.strip():
            raise ValueError("project memory requires a fact and a verification source")
        return self.store.add_reflection(text[:8000], 7, [], "shared",
            meta={"project": self.project, "source": source[:1000], "visibility": "project"}).as_dict()

    def close(self):
        self.store.close()
