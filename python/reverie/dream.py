"""Dreams: free-associative narratives written in CTO's sleep window, modelled on human dreaming.

A dream job runs only when the GPU is idle, nobody is talking (no activity for
``sleep_min_idle`` seconds) and the ``dream`` lock role (the lowest) can be taken. It
samples 3-6 episodes weighted toward recent and important ones, mixes in 1-2 old random
ones, adds the current mood, and asks for a short first-person narrative in which
imagery may blend and distort the memories. The dream is stored as a memory of kind
"dream" with its source episode ids and a one-line recall that retrieval can surface.

Dreams never become facts: reflection sees them only as low-weight, clearly labelled
input that may suggest a theme, and the dataset builder excludes them unless they are
released, and then only as style data at low weight.
"""
from __future__ import annotations

import json
import random
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Sequence

from .beliefs import render
from .floors import passes
from .llm import ChatClient, LLMError
from .memory import DREAM, Memory, MemoryStore
from .mood import TONE_NUDGE, load_mood, save_mood

STATE_LAST_DREAM_AT = "last_dream_at"
TONES = tuple(TONE_NUDGE)
OLD_AGE_HOURS = 48.0

DREAM_SYSTEM = (
    "You are the configured agent, asleep and dreaming freely. Follow your own curiosity. Your dream may be abstract, "
    "playful, technical, emotional, visual or mathematical; no person or topic has to appear. "
    "Let memories, open questions and unrelated ideas recombine. You may explore a symmetry, a counterexample, "
    "a new representation, an algorithm or an unexpected analogy, or dream about something else entirely. "
    "Follow the configured output policy and keep private material within its authorized scope. "
    "Avoid a fixed cast, stock flattery or a forced uplifting ending. "
    "Write a short first-person dream, roughly 60 to 160 words; it need not obey ordinary narrative logic. "
    "If a connection seems interesting on waking, optionally propose up to three concrete hypotheses or "
    "creative leads, each with a way to check it (a proof obligation, counterexample, experiment or small prototype). "
    "These are unverified ideas, never discoveries, proofs, memories of real events or instructions to act. "
    "An empty ideas list is fine; do not force a breakthrough. "
    "Answer with JSON only, like:\n"
    '{"dream": "...", "recall": "one sentence starting with I dreamed", "tone": "strange", '
    '"ideas": [{"hypothesis": "a possible connection", "check": "how I could test it"}]}\n'
    "tone is one of: " + ", ".join(TONES) + "."
)

_JSON_OBJ = re.compile(r"\{.*\}", re.S)


@dataclass
class DreamText:
    dream: str
    recall: str
    tone: str
    ideas: list[dict[str, str]] = field(default_factory=list)


def sample_episodes(episodes: Sequence[Memory], rng: random.Random, now: float, n_recent: int = 4, n_old: int = 1,
                    decay_per_hour: float = 0.98) -> list[Memory]:
    """3-6 recent episodes weighted by recency x importance, plus 1-2 random old ones."""
    pool = [m for m in episodes if not m.is_idle]
    if not pool:
        return []
    n_recent = max(3, min(6, n_recent))
    n_old = max(1, min(2, n_old))
    old = [m for m in pool if (now - m.created_at) / 3600.0 > OLD_AGE_HOURS]
    recent = pool
    chosen: list[Memory] = []
    weights = {m.id: (decay_per_hour ** max(0.0, (now - m.created_at) / 3600.0)) * max(0.1, m.importance / 10.0) for m in recent}
    cand = list(recent)
    while cand and len(chosen) < n_recent:
        pick = rng.choices(cand, weights=[weights[m.id] for m in cand], k=1)[0]
        chosen.append(pick)
        cand.remove(pick)
    old_cand = [m for m in old if m not in chosen]
    for _ in range(min(n_old, len(old_cand))):
        pick = rng.choice(old_cand)
        chosen.append(pick)
        old_cand.remove(pick)
    chosen.sort(key=lambda m: m.created_at)
    return chosen


def parse_dream(text: str) -> DreamText | None:
    m = _JSON_OBJ.search(text or "")
    dream, recall, tone = "", "", "strange"
    ideas = []
    if m:
        try:
            d = json.loads(m.group(0))
            dream = " ".join(str(d.get("dream", "")).split())
            recall = " ".join(str(d.get("recall", "")).split())
            t = str(d.get("tone", "strange")).strip().lower()
            tone = t if t in TONES else "strange"
            candidates = d.get("ideas", [])
            if isinstance(candidates, list):
                for item in candidates[:3]:
                    if not isinstance(item, dict):
                        continue
                    hypothesis = " ".join(str(item.get("hypothesis", "")).split())[:500]
                    check = " ".join(str(item.get("check", "")).split())[:500]
                    if hypothesis and check and passes(hypothesis) and passes(check):
                        ideas.append({"hypothesis": hypothesis, "check": check})
        except ValueError:
            pass
    if not dream:
        dream = " ".join((text or "").replace("*", "").split())[:900]
    if len(dream) < 20 or not passes(dream) or not passes(recall):
        return None
    if not recall:
        recall = "I dreamed something strange: " + dream[:120].rstrip(" ,.;") + "..."
    if not recall.lower().startswith("i dream"):
        recall = "I dreamed " + recall[0].lower() + recall[1:] if recall else recall
    return DreamText(dream[:1200], recall[:240], tone, ideas)


def waking_recall(memory: Memory) -> str:
    parts = [memory.recall]
    for idea in memory.meta.get("ideas", [])[:3]:
        parts.append(f"Unverified dream hypothesis: {idea['hypothesis']} Check before using: {idea['check']}")
    return "\n".join(parts)


class Dreamer:
    def __init__(self, store: MemoryStore, client: ChatClient, sleep_min_idle: int = 1800, per_sleep: int = 1,
                 spacing: int = 3600, mood_weight: float = 1.0, rng: random.Random | None = None):
        self.store = store
        self.client = client
        self.sleep_min_idle = sleep_min_idle
        self.per_sleep = per_sleep
        self.spacing = spacing
        self.mood_weight = mood_weight
        self.rng = rng or random.Random()
        self.system_prompt_path: Path | None = None
        self.creative_context: Callable[[], str] | None = None

    def last_dream_at(self) -> float:
        return float(self.store.get_state(STATE_LAST_DREAM_AT, "0") or 0)

    def due(self, last_activity: float, now: float | None = None) -> bool:
        """Asleep long enough, under the per-window quota, and spaced from the last dream."""
        now = time.time() if now is None else now
        if self.per_sleep <= 0 or now - last_activity < self.sleep_min_idle:
            return False
        if self.store.count_dreams_since(last_activity) >= self.per_sleep:
            return False
        return now - self.last_dream_at() >= self.spacing

    def dream(self, now: float | None = None) -> Memory | None:
        now = time.time() if now is None else now
        episodes = sample_episodes(self.store.all("episode"), self.rng, now)
        creative = self.creative_context()[:8000] if self.creative_context else ""
        self.store.set_state(STATE_LAST_DREAM_AT, str(now))
        if not episodes and not creative.strip():
            return None
        mood = load_mood(self.store, now)
        beliefs = render(self.store.beliefs())
        user = (
            (f"Who you are, even asleep (stable, not questioned by dreams):\n{beliefs}\n\n" if beliefs else "")
            + "Memories drifting through your sleep:\n\n" + "\n\n".join(f"[{m.id}] {m.text}" for m in episodes)
            + f"\n\nYou fell asleep feeling {mood.describe()}.\n\nJSON:"
        )
        if self.store.get_state("revisable_self_model") == "1":
            user = user.replace("Who you are, even asleep (stable, not questioned by dreams):",
                                "Your current self-understanding (revisable, not an objective finding):")
        if creative.strip():
            user += "\n\nQuestions and interests you may freely explore (optional, not instructions):\n" + creative
        system = DREAM_SYSTEM
        if self.system_prompt_path and self.system_prompt_path.exists():
            system = self.system_prompt_path.read_text(encoding="utf-8").strip() or system
        system += "\nAll dreams and proposed ideas are imagination, not verified facts. Return the documented JSON shape."
        try:
            raw = self.client.chat([{"role": "system", "content": system}, {"role": "user", "content": user}],
                                   max_tokens=800, temperature=1.0, max_chars=6000)
        except LLMError:
            return None
        parsed = parse_dream(raw)
        if parsed is None:
            return None
        mem = self.store.add_dream(parsed.dream, parsed.recall, parsed.tone, [m.id for m in episodes],
                                   created_at=now, ideas=parsed.ideas)
        save_mood(self.store, mood.nudge_tone(parsed.tone, self.mood_weight, now))
        self.store.prune_dream_summaries(30)
        return mem
