"""One-time import of the legacy configured legacy-history.json into the episodic store."""
from __future__ import annotations

import json
import os
from pathlib import Path

from .memory import MemoryStore

STATE_KEY = "migrated_legacy_history"


def migrate_history(store: MemoryStore, path: Path, default_importance: float = 3.0) -> int:
    """Pairs user/assistant turns into episodes. Returns the number imported (0 if already done)."""
    if store.get_state(STATE_KEY):
        return 0
    try:
        turns = json.loads(path.read_text(encoding="utf-8"))
        mtime = os.path.getmtime(path)
    except (OSError, ValueError):
        store.set_state(STATE_KEY, "missing")
        return 0
    pairs: list[tuple[str, str]] = []
    pending_user: str | None = None
    for t in turns if isinstance(turns, list) else []:
        role, content = t.get("role"), (t.get("content") or "").strip()
        if role == "user":
            pending_user = content
        elif role == "assistant" and pending_user is not None:
            pairs.append((pending_user, content))
            pending_user = None
    n = len(pairs)
    for i, (u, a) in enumerate(pairs):
        created = mtime - (n - i) * 60.0
        idle = u.startswith("(idle moment")
        store.add_episode(u, a, default_importance, "migrated", created_at=created, meta={"idle": idle, "legacy": True})
    store.set_state(STATE_KEY, str(n))
    return n
