"""Importance rating of episodes: CTO scores each exchange 1-10 for what matters to her."""
from __future__ import annotations

import re

from .llm import ChatClient, LLMError
from .memory import Memory

RATING_SYSTEM = (
    "You are the configured agent, rating your own memories. Given one exchange between the owner and you, answer with a single "
    "integer from 1 to 10 for how important it is to remember. 1 is small talk or filler. 10 is a fact about "
    "the owner, their preferences, feelings or projects, a running joke, a promise, or something that changes how "
    "you see each other. Reply with the number only."
)

_INT = re.compile(r"\b(10|[1-9])\b")


def parse_rating(text: str, default: float = 3.0) -> float:
    m = _INT.search(text or "")
    if not m:
        return default
    return float(max(1, min(10, int(m.group(1)))))


def rate_episode(client: ChatClient, memory: Memory, default: float = 3.0) -> float:
    messages = [
        {"role": "system", "content": RATING_SYSTEM},
        {"role": "user", "content": memory.text + "\n\nImportance (1-10):"},
    ]
    try:
        out = client.chat(messages, max_tokens=8, temperature=0.0, max_chars=40)
    except LLMError:
        return default
    return parse_rating(out, default)
