from __future__ import annotations
"""Shared fakes: an in-memory LLM, a fake room, and a temporary Config."""

import json
from contextlib import contextmanager
import tempfile
from pathlib import Path
from typing import Callable

from reverie.config import Config
from reverie.llm import ChatClient
from reverie.room import Room


class FakeTransport:
    """Stands in for HTTP; ``responder(messages) -> str`` chooses the content."""

    def __init__(self, responder: Callable[[list[dict]], str] | str = "ok"):
        self.responder = responder
        self.calls: list[dict] = []

    def __call__(self, url: str, body: bytes, timeout: int) -> bytes:
        req = json.loads(body)
        self.calls.append(req)
        content = self.responder(req["messages"]) if callable(self.responder) else self.responder
        if content is None:
            return b"not json at all"
        return json.dumps({"choices": [{"message": {"role": "assistant", "content": content}}]}).encode()


def fake_client(responder="ok") -> tuple[ChatClient, FakeTransport]:
    t = FakeTransport(responder)
    return ChatClient("http://test/v1", "test-model", 5, transport=t), t


class FakeRoom(Room):
    def __init__(self, session_id="me", hold_path: Path | None = None, busy=False):
        super().__init__(session_id, hold_path or Path(tempfile.mkdtemp()) / "hold", runner=self._runner)
        self.inbox: list[dict] = []
        self.said: list[str] = []
        self.busy = busy
        self.ls_fails = False

    def _runner(self, cmd, timeout):
        cmd = list(cmd)
        if cmd[:4] == ["reverie", "agent", "chat", "read"]:
            return json.dumps({"messages": self.inbox})
        if cmd[:4] == ["reverie", "agent", "chat", "say"]:
            assert "--to" not in cmd, cmd
            self.said.append(cmd[-1])
            return ""
        if cmd[:3] == ["reverie", "agent", "ls"]:
            if self.ls_fails:
                raise RuntimeError("down")
            return "x review-gpu: standing [agent, busy]\n" if self.busy else "x review-gpu: standing [agent, idle]\n"
        return ""

    def post(self, text, kind="user", to="all", mid=None):
        m = {"id": mid or f"m{len(self.inbox)+1}", "from": {"kind": kind, "name": "USER"}, "to": to, "text": text}
        self.inbox.append(m)
        return m


def temp_config() -> Config:
    d = Path(tempfile.mkdtemp())
    cfg = Config()
    cfg.data_dir = d / "data"
    cfg.db_path = d / "data" / "memory.sqlite"
    cfg.profile_path = d / "data" / "profile.md"
    cfg.persona_path = d / "persona.txt"
    cfg.legacy_history = d / "legacy-history.json"
    cfg.hold_path = d / "hold"
    cfg.log_path = d / "reverie.log"
    cfg.gpu_lock_path = d / "gpu.lock"
    cfg.gpu_yield_path = d / "gpu.yield"
    cfg.gpu_activity_path = d / "gpu.activity"
    cfg.session_id = "me"
    cfg.ensure_dirs()
    return cfg


def output_policy_terms() -> tuple[str, str]:
    """Neutral tokens used by the synthetic owner-selected policy."""
    return "policy_marker", "restricted_marker"


@contextmanager
def synthetic_output_policy():
    """Exercise output rejection without shipping a default topic policy."""
    import json
    import re
    from unittest.mock import patch
    policy = json.dumps({"denied_patterns": [r"(?s)(?=.*\bpolicy_marker\b)(?=.*\brestricted_marker\b)"]})
    with patch.dict("os.environ", {"REVERIE_OUTPUT_POLICY": policy}), patch(
            "reverie.floors._ABUSE", re.compile(r"\b(?:abuse_marker|lives at)\b", re.I)):
        yield
