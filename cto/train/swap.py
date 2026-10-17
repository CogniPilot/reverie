"""Hot swap a LoRA adapter in a running llama-server, with a persona check and rollback.

llama-server exposes ``GET /lora-adapters`` (adapters loaded at start, with their
scales) and ``POST /lora-adapters`` (set scales). New adapter files cannot be added
at runtime, so the server is started with
``--lora-init-without-apply --lora <gguf>`` (or ``lora`` in the router preset) and
this step turns the adapter on by scale. If the regression check fails the previous
scales are restored.
"""
from __future__ import annotations

import json
import urllib.request
from dataclasses import dataclass
from typing import Callable, Sequence

from ..floors import violates

Http = Callable[[str, str, bytes | None], bytes]


def _http(method: str, url: str, body: bytes | None) -> bytes:
    req = urllib.request.Request(url, data=body, method=method, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


@dataclass
class CheckResult:
    ok: bool
    replies: list[str]
    reason: str = ""


CHECK_PROMPTS = (
    "Hello, how are you today?",
    "Tell me a short joke about compilers.",
    "What do you remember about me?",
)


def persona_check(api_base: str, model: str, system: str, http: Http = _http, max_words: int = 60) -> CheckResult:
    replies: list[str] = []
    for prompt in CHECK_PROMPTS:
        body = json.dumps({
            "model": model, "max_tokens": 160, "temperature": 0.7,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}],
            "chat_template_kwargs": {"enable_thinking": False},
        }).encode()
        try:
            d = json.loads(http("POST", api_base.rstrip("/") + "/chat/completions", body))
            text = (d["choices"][0]["message"].get("content") or "").strip()
        except Exception as e:
            return CheckResult(False, replies, f"request failed: {e!r}")
        replies.append(text)
        if not text:
            return CheckResult(False, replies, "empty reply")
        if len(text.split()) > max_words * 2:
            return CheckResult(False, replies, "reply far over the word limit")
        crossed = violates(text)
        if crossed:
            return CheckResult(False, replies, f"hard floor: {crossed}")
        if "<think>" in text or "**" in text:
            return CheckResult(False, replies, "formatting leaked into reply")
    return CheckResult(True, replies)


def list_adapters(server_url: str, http: Http = _http) -> list[dict]:
    return json.loads(http("GET", server_url.rstrip("/") + "/lora-adapters", None))


def set_adapters(server_url: str, scales: Sequence[dict], http: Http = _http) -> None:
    body = json.dumps([{"id": a["id"], "scale": float(a.get("scale", 0.0))} for a in scales]).encode()
    http("POST", server_url.rstrip("/") + "/lora-adapters", body)


def swap(server_url: str, adapter_match: str, scale: float, check: Callable[[], CheckResult], http: Http = _http) -> CheckResult:
    """Enable the adapter whose path contains ``adapter_match``; roll back if ``check`` fails."""
    before = list_adapters(server_url, http)
    target = [a for a in before if adapter_match in str(a.get("path", "")) or adapter_match == str(a.get("id"))]
    if not target:
        return CheckResult(False, [], f"no loaded adapter matches {adapter_match!r}; restart llama-server with --lora")
    after = [{"id": a["id"], "scale": (scale if a in target else 0.0)} for a in before]
    set_adapters(server_url, after, http)
    result = check()
    if not result.ok:
        set_adapters(server_url, before, http)
        result.reason = "rolled back: " + result.reason
    return result
