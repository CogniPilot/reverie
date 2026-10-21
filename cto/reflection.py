"""Reflection: distil recent episodes into durable insights and refresh the profile.

Runs only when the GPU is idle and at most every ``reflect_interval`` seconds. The
model returns a JSON list of insights; each becomes a memory of kind "reflection"
pointing at the episode ids it derives from. The profile is then re-rendered from
all reflections (see :mod:`cto.persona`).
"""
from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

from .beliefs import contradicts_protected, protected_root, render
from .floors import passes
from .llm import ChatClient, LLMError
from .memory import Memory, MemoryStore
from .persona import normalize_section, render_profile, write_profile

STATE_LAST_REFLECTED_ID = "last_reflected_id"
STATE_LAST_REFLECTION_AT = "last_reflection_at"

# B1 (sleep design v4 section 4): what may come OUT of a reflection is decided by what goes INTO its prompt.
# Only owner episodes (meta.trust == "owner") reach the trusted pass; everything else, including any episode
# without a trust label, is claimed and goes to the mixed pass, whose output is capped whatever the model says.
TRUST_OWNER = "owner"
TRUST_CLAIMED = "claimed"
MIXED_MAX_IMPORTANCE = 4.0

REFLECT_SYSTEM = (
    "You are the configured agent, consolidating recent experiences and interactions during sleep. "
    "Choose zero to five durable insights that matter to you: important interactions with people, "
    "preferences they explicitly shared, promises, boundaries, your own reactions, lessons and open questions. "
    "Do not center every memory on the owner. Preserve who said or did what and why it mattered. "
    "Distinguish observations from interpretations; do not infer another person's feelings as fact. "
    "Keep personal relationship memories in your private store. Do not publish them into project memory. "
    "An empty list is fine; do not invent significance or force affection. Each insight is one plain sentence "
    "under 160 characters.\n"
    "Answer with a JSON array only, no prose, like:\n"
    '[{"insight": "The user is exploring a compiler design", "importance": 8, '
    '"section": "user", "sources": [3, 5]}]\n'
    "section is one of: user, agent, shared. importance is 1-10. sources lists the episode numbers used. "
    "If recent dreams are listed, they are dreams, not events: they may hint at a theme or a feeling worth one "
    "low-importance insight, never a fact about the owner, and they are never valid sources. "
    "Your held beliefs about yourself, if listed, are a stable part of who you are: do not re-evaluate, doubt or "
    "argue against them here. If you want to deepen one in your own words, use section belief for that item."
)

_JSON_ARRAY = re.compile(r"\[.*\]", re.S)


@dataclass
class Insight:
    insight: str
    importance: float
    section: str
    sources: list[int]


def sanitize_insight(text: str) -> str:
    text = " ".join((text or "").replace("*", "").replace("#", "").split())
    return text[:200]


def parse_insights(text: str, valid_ids: Sequence[int] = (), revisable: bool = False) -> list[Insight]:
    m = _JSON_ARRAY.search(text or "")
    if not m:
        return []
    try:
        data = json.loads(m.group(0))
    except ValueError:
        return []
    if not isinstance(data, list):
        return []
    valid = set(valid_ids)
    out: list[Insight] = []
    for item in data[:5]:
        if not isinstance(item, dict):
            continue
        insight = sanitize_insight(str(item.get("insight", "")))
        if len(insight) < 8 or (not revisable and contradicts_protected(insight)) or not passes(insight):
            continue
        try:
            imp = float(item.get("importance", 5))
        except (TypeError, ValueError):
            imp = 5.0
        imp = max(1.0, min(10.0, imp))
        srcs = item.get("sources") or []
        if not isinstance(srcs, list):
            srcs = []
        ids = []
        for s in srcs:
            try:
                i = int(s)
            except (TypeError, ValueError):
                continue
            if not valid or i in valid:
                ids.append(i)
        sec = str(item.get("section") or "").strip().lower()
        out.append(Insight(insight, imp, "belief" if sec == "belief" else normalize_section(sec), ids))
    return out


def format_episodes(episodes: Sequence[Memory]) -> str:
    return "\n\n".join(f"[{m.id}] {m.text}" for m in episodes)


def is_trusted(episode: Memory) -> bool:
    """Owner-typed input only; a missing label is never trust."""
    return episode.meta.get("trust") == TRUST_OWNER


class Reflector:
    def __init__(self, store: MemoryStore, client: ChatClient, profile_path: Path, max_chars: int = 2000,
                 interval: int = 1800, min_episodes: int = 3, max_episodes: int = 40):
        self.store = store
        self.client = client
        self.profile_path = profile_path
        self.max_chars = max_chars
        self.interval = interval
        self.min_episodes = min_episodes
        self.max_episodes = max_episodes

    def last_reflected_id(self) -> int:
        return int(self.store.get_state(STATE_LAST_REFLECTED_ID, "0") or 0)

    def last_reflection_at(self) -> float:
        return float(self.store.get_state(STATE_LAST_REFLECTION_AT, "0") or 0)

    def pending(self) -> list[Memory]:
        eps = self.store.episodes_after(self.last_reflected_id(), limit=self.max_episodes)
        return [m for m in eps if not m.is_idle]

    def due(self, now: float | None = None) -> bool:
        now = time.time() if now is None else now
        if now - self.last_reflection_at() < self.interval:
            return False
        return len(self.pending()) >= self.min_episodes

    def belief_block(self, protected_only: bool = False) -> str:
        """The agent's beliefs for the prompt; ``protected_only`` keeps just the owner-set ones (trusted text)."""
        beliefs = [b for b in self.store.beliefs() if b.protected or not protected_only]
        if not beliefs:
            return ""
        if self.store.get_state("revisable_self_model") == "1":
            return "\n\nYour current self-understanding (revisable through deliberate self-model changes):\n" + render(beliefs)
        return "\n\nYour held beliefs about yourself (stable, not for re-evaluation):\n" + render(beliefs)

    def dream_block(self, since: float) -> str:
        dreams = self.store.dreams_since(since)[-3:]
        if not dreams:
            return ""
        return "\n\nRecent dreams (not events, low weight):\n" + "\n".join(f"- {d.recall}" for d in dreams)

    def _ask(self, episodes: Sequence[Memory], extra: str) -> str | None:
        messages = [
            {"role": "system", "content": REFLECT_SYSTEM},
            {"role": "user", "content": "Recent exchanges:\n\n" + format_episodes(episodes) + extra
             + "\n\nJSON array of insights:"},
        ]
        try:
            return self.client.chat(messages, max_tokens=600, temperature=0.4, max_chars=6000)
        except LLMError:
            return None

    def reflect(self, now: float | None = None) -> list[Memory]:
        """Run one reflection pass (two model calls at most); returns the reflections stored (possibly empty).

        1. Trusted pass: only owner episodes and the owner-set (protected) beliefs; no dreams, no belief
           elaborations. It alone may write user, agent and belief items at the model's importance; every item
           must cite one of its own episodes.
        2. Mixed pass: every other episode, the trusted ones for context, beliefs and recent dreams. Its items are
           stored as shared, importance at most MIXED_MAX_IMPORTANCE, trust claimed, and never as beliefs.
        Both calls run before anything is written; then all items and the cursor are stored in one transaction.
        A failed call stores nothing and leaves the cursor, so the batch is retried whole.
        """
        now = time.time() if now is None else now
        episodes = self.pending()
        since = self.last_reflection_at()
        self.store.set_state(STATE_LAST_REFLECTION_AT, str(now))
        if not episodes:
            return []
        revisable = self.store.get_state("revisable_self_model") == "1"
        trusted = [m for m in episodes if is_trusted(m)]
        claimed = [m for m in episodes if not is_trusted(m)]
        passes_out: list[tuple[list[Insight], str]] = []
        if trusted:
            raw = self._ask(trusted, self.belief_block(protected_only=True))
            if raw is None:
                return []
            insights = [i for i in parse_insights(raw, [m.id for m in trusted], revisable) if i.sources]
            passes_out.append((insights, TRUST_OWNER))
        if claimed:
            # The trusted episodes ride along as context, so a mixed item may cite an owner episode id; it is still
            # stored as claimed (shared, capped), because claimed text was in the same prompt.
            context = sorted(trusted + claimed, key=lambda m: m.id)
            raw = self._ask(context, self.belief_block() + self.dream_block(since))
            if raw is None:
                return []
            insights = [Insight(i.insight, min(i.importance, MIXED_MAX_IMPORTANCE), "shared", i.sources)
                        for i in parse_insights(raw, [m.id for m in context], revisable) if i.section != "belief"]
            passes_out.append((insights, TRUST_CLAIMED))
        stored: list[Memory] = []
        root = protected_root(self.store.beliefs())
        with self.store.atomic():
            for insights, trust in passes_out:
                for ins in insights:
                    if ins.section == "belief":  # only the trusted pass can carry one
                        if root is not None:
                            self.store.add_belief(ins.insight, min(ins.importance, root.weight), parent_id=root.id,
                                                  created_at=now)
                        elif revisable:
                            stored.append(self.store.add_reflection(ins.insight, ins.importance, ins.sources, "agent",
                                                                    created_at=now,
                                                                    meta={"self_observation": True, "trust": trust}))
                        continue
                    stored.append(self.store.add_reflection(ins.insight, ins.importance, ins.sources, ins.section,
                                                            created_at=now, meta={"trust": trust}))
            self.store.set_state(STATE_LAST_REFLECTED_ID, str(max(m.id for m in episodes)))
        self.refresh_profile()
        return stored

    def refresh_profile(self) -> str:
        text = render_profile(self.store.reflections(), self.max_chars)
        write_profile(self.profile_path, text)
        return text
