"""Reverie chatroom integration: read the room, post as CTO, and check whether the GPU is free."""
from __future__ import annotations

import json
import logging
import subprocess
from pathlib import Path
from typing import Callable, Sequence

Runner = Callable[[Sequence[str], int], str]


def _run(cmd: Sequence[str], timeout: int) -> str:
    return subprocess.run(list(cmd), capture_output=True, text=True, timeout=timeout).stdout


def is_for_me(message: dict, session_id: str) -> bool:
    """True for user messages addressed to everyone or directly to this session."""
    if (message.get("from") or {}).get("kind") != "user":
        return False
    to = message.get("to")
    if to in (None, "all", "everyone"):
        return True
    if isinstance(to, str):
        return to == session_id
    if isinstance(to, list):
        if any(t in ("all", "everyone") for t in to if isinstance(t, str)):
            return True
        return session_id in to or any(isinstance(t, dict) and t.get("id") == session_id for t in to)
    return False


class Room:
    def __init__(self, session_id: str, hold_path: Path, runner: Runner | None = None,
                 legacy_hold_path: Path | None = None):
        self.session_id = session_id
        self.hold_path = hold_path
        self.legacy_hold_path = legacy_hold_path
        self._warned_legacy_hold = False
        self._run = runner or _run

    def messages(self) -> list[dict]:
        try:
            out = self._run(["reverie", "agent", "chat", "read", "--json"], 30)
            d = json.loads(out)
        except Exception:
            return []
        msgs = d.get("messages", []) if isinstance(d, dict) else d
        return [m for m in msgs if isinstance(m, dict) and "id" in m]

    def say(self, text: str, to: str = "user") -> bool:
        try:
            self._run(["reverie", "agent", "chat", "say", "--to", to, text], 30)
            return True
        except Exception:
            return False

    def status(self, progress: str) -> None:
        try:
            self._run(["reverie", "agent", "chat", "status", "--progress", progress], 30)
        except Exception:
            pass

    def held(self) -> bool:
        if self.hold_path.exists():
            return True
        if self.legacy_hold_path is not None and self.legacy_hold_path.exists():
            if not self._warned_legacy_hold:
                logging.getLogger("fleet").warning("%s is deprecated, use %s", self.legacy_hold_path, self.hold_path)
                self._warned_legacy_hold = True
            return True
        return False

    def gpu_busy(self) -> bool:
        """The hold file counts as busy; so does any review-gpu session that is busy.

        When the Reverie API cannot be reached the GPU is assumed busy, which only
        delays optional work (jokes, ratings, reflection); replies are never gated.
        """
        if self.held():
            return True
        try:
            out = self._run(["reverie", "agent", "ls"], 20)
        except Exception:
            return True
        if not out.strip() or "ECONNREFUSED" in out:
            return True
        return any("review-gpu" in line and "busy" in line for line in out.splitlines())
