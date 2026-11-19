from __future__ import annotations
"""Shared fakes: an in-memory LLM, a fake room, and a temporary Config."""

import json
import subprocess
from contextlib import contextmanager
import tempfile
from pathlib import Path
from typing import Callable

from reverie.config import ChatClient, Config


def install_opencode(workspace: Path, *options: str) -> None:
    subprocess.run(["reverie-opencode", "--install", str(workspace), *options],
                   capture_output=True, check=True, timeout=30)


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
    from unittest.mock import patch
    policy = json.dumps({"denied_patterns": [r"(?s)(?=.*\bpolicy_marker\b)(?=.*\brestricted_marker\b)"]})
    with patch.dict("os.environ", {"REVERIE_OUTPUT_POLICY": policy}):
        yield
