"""Export memories to chat-format JSONL for supervised fine-tuning.

Every example is ``{"messages": [system, user, assistant], "weight": w, "id": ..., "kind": ...}``.
Importance drives sampling: the recent window is drawn with probability proportional
to importance (with replacement, so important exchanges are seen more than once), and
a replay buffer of older examples is drawn uniformly so earlier learning is rehearsed.
The trainer can therefore ignore ``weight``; it is kept for weighted-loss variants.
"""
from __future__ import annotations

import json
import random
import time
from pathlib import Path
from typing import Iterable, Sequence

from ..beliefs import contradicts_protected
from ..floors import passes
from ..memory import DREAM, EPISODE, REFLECTION, Memory, MemoryStore
from .config import TrainConfig

REFLECT_USER = "Take a quiet moment. What have you learned lately about the user, yourself and your work?"
DREAM_USER = "Tell me about a dream you had."
DREAM_WEIGHT = 0.1          # style data only, never facts; and only for released dreams


def example_from_episode(m: Memory, system: str) -> dict:
    return {
        "id": m.id,
        "kind": EPISODE,
        "created_at": m.created_at,
        "weight": round(m.importance / 10.0, 3),
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": m.user_text},
            {"role": "assistant", "content": m.assistant_text},
        ],
    }


def example_from_reflections(ms: Sequence[Memory], system: str) -> dict:
    body = " ".join(m.text.strip().rstrip(".") + "." for m in ms)
    return {
        "id": [m.id for m in ms],
        "kind": REFLECTION,
        "created_at": max(m.created_at for m in ms),
        "weight": round(max(m.importance for m in ms) / 10.0, 3),
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": REFLECT_USER},
            {"role": "assistant", "content": body},
        ],
    }


def example_from_dream(m: Memory, system: str) -> dict:
    return {
        "id": m.id,
        "kind": DREAM,
        "created_at": m.created_at,
        "weight": DREAM_WEIGHT,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": DREAM_USER},
            {"role": "assistant", "content": m.text},
        ],
    }


def weighted_sample(items: Sequence[dict], n: int, rng: random.Random) -> list[dict]:
    if not items or n <= 0:
        return []
    weights = [max(0.01, float(x.get("weight", 0.3))) for x in items]
    return rng.choices(list(items), weights=weights, k=n)


def replay_sample(items: Sequence[dict], n: int, rng: random.Random) -> list[dict]:
    if not items or n <= 0:
        return []
    return rng.sample(list(items), k=min(n, len(items)))


def keeps_identity(example: dict, revisable: bool = False) -> bool:
    """False when the assistant turn negates a protected belief or crosses a hard floor; such rows never train."""
    for m in example["messages"]:
        content = m.get("content", "")
        if m.get("role") == "assistant" and not revisable and contradicts_protected(content):
            return False
        if m.get("role") != "system" and not passes(content):
            return False
    return True


def build_examples(store: MemoryStore, system: str, cfg: TrainConfig, now: float | None = None) -> tuple[list[dict], list[dict]]:
    """Returns (recent, older) example pools before sampling; rows negating a protected belief are dropped."""
    now = time.time() if now is None else now
    cutoff = now - cfg.recent_days * 86400.0
    recent: list[dict] = []
    older: list[dict] = []
    for m in store.all(EPISODE):
        if m.importance < cfg.min_importance or (m.is_idle and not cfg.include_idle):
            continue
        ex = example_from_episode(m, system)
        (recent if m.created_at >= cutoff else older).append(ex)
    if cfg.include_dreams:
        for m in store.all(DREAM):
            if m.meta.get("released"):
                (recent if m.created_at >= cutoff else older).append(example_from_dream(m, system))
    if cfg.include_reflections:
        refl = store.all(REFLECTION)
        new = [m for m in refl if m.created_at >= cutoff]
        old = [m for m in refl if m.created_at < cutoff]
        for group, pool in ((new, recent), (old, older)):
            for i in range(0, len(group), 4):
                chunk = group[i:i + 4]
                if chunk:
                    pool.append(example_from_reflections(chunk, system))
    revisable = store.get_state("revisable_self_model") == "1"
    recent = [x for x in recent if keeps_identity(x, revisable)]
    older = [x for x in older if keeps_identity(x, revisable)]
    return recent, older


def build_dataset(store: MemoryStore, system: str, cfg: TrainConfig, out_path: Path, now: float | None = None) -> dict:
    rng = random.Random(cfg.seed)
    recent, older = build_examples(store, system, cfg, now)
    draws = weighted_sample(recent, cfg.sample_size, rng) + replay_sample(older, cfg.replay_size, rng)
    rng.shuffle(draws)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as f:
        for ex in draws:
            f.write(json.dumps(ex, ensure_ascii=False) + "\n")
    manifest = {
        "path": str(out_path),
        "examples": len(draws),
        "recent_pool": len(recent),
        "older_pool": len(older),
        "sample_size": cfg.sample_size,
        "replay_size": cfg.replay_size,
        "min_importance": cfg.min_importance,
        "built_at": now or time.time(),
    }
    out_path.with_suffix(".manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return manifest


def read_jsonl(path: Path) -> Iterable[dict]:
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                yield json.loads(line)
