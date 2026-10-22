"""Minimal OpenAI-compatible chat client for the local llama-server router (stdlib only)."""
from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from typing import Callable, Sequence

_THINK = re.compile(r"<think>.*?</think>", re.S)
_SENTENCE_END = re.compile(r"""[.!?]['")]*$""")


class LLMError(RuntimeError):
    pass


Transport = Callable[[str, bytes, int], bytes]


def _urllib_transport(url: str, body: bytes, timeout: int) -> bytes:
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def clean_reply(text: str, max_chars: int = 600) -> str:
    text = _THINK.sub("", text or "")
    text = text.replace("*", "")
    text = " ".join(text.split())
    return text[:max_chars]


def limit_words(text: str, max_words: int) -> str:
    """Trim to ``max_words`` (0 or less means no limit), cutting at the last sentence end inside the limit."""
    words = text.split()
    if max_words <= 0 or len(words) <= max_words:
        return text
    head = words[:max_words]
    for i in range(len(head), 0, -1):
        if _SENTENCE_END.search(head[i - 1]):
            return " ".join(head[:i])
    return " ".join(head)


class ChatClient:
    def __init__(self, api_base: str, model: str, timeout: int = 240, transport: Transport | None = None):
        self.api_base = api_base.rstrip("/")
        self.model = model
        self.timeout = timeout
        self._transport = transport or _urllib_transport

    def chat(
        self,
        messages: Sequence[dict],
        max_tokens: int = 220,
        temperature: float = 0.9,
        max_chars: int = 600,
        extra: dict | None = None,
    ) -> str:
        """Returns the cleaned assistant text. Raises :class:`LLMError` on any failure."""
        body = {
            "model": self.model,
            "messages": list(messages),
            "max_tokens": max_tokens,
            "temperature": temperature,
            "chat_template_kwargs": {"enable_thinking": False},
        }
        if extra:
            body.update(extra)
        try:
            raw = self._transport(self.api_base + "/chat/completions", json.dumps(body).encode(), self.timeout)
            d = json.loads(raw)
            content = d["choices"][0]["message"].get("content") or ""
        except (urllib.error.URLError, OSError, ValueError, KeyError, IndexError, TypeError) as e:
            raise LLMError(f"chat request failed: {e!r}") from e
        return clean_reply(content, max_chars)
