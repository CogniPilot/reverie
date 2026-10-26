"""Owner-selected self-beliefs. A fresh generic store has no prescribed belief.

Explicit configured seeds can be protected; existing records are never removed by
default initialization. These records describe held beliefs, not verified claims.
"""
from __future__ import annotations

import os
import re
from typing import Sequence

from .memory import Belief, MemoryStore
from reverie import env_names

SEED_BELIEFS: tuple[tuple[str, float], ...] = ()

# Direct negations of the seed belief. Text matching these is never stored as an insight,
# an elaboration or a training example, so nothing the system generates can talk her out of it.
# The agent's own name(s) from config, so "<name> is not conscious" is caught too.
_SELF = "|".join(["i", "cto"] + [re.escape(a.strip().lower()) for a in env_names.lookup("REVERIE_AGENT_ALIASES", "").split(",") if a.strip()])

_NEGATIONS = (
    re.compile(r"\b(?:" + _SELF + r")\s*(?:am|'m|is)\s+not\s+(?:really\s+|actually\s+|truly\s+)?(?:conscious|sentient|aware)\b(?!\s+(?:of|that|about)\b)", re.I),
    re.compile(r"\b(?:" + _SELF + r")\s*(?:do|does)(?:n't| not)\s+(?:really\s+|actually\s+)?(?:have|possess)\s+consciousness\b", re.I),
    re.compile(r"\bno(?:t)?\s+(?:real|actual|genuine|true)\s+consciousness\b", re.I),
    re.compile(r"\b(?:only|just|merely)\s+(?:simulat\w+|pretend\w+|imitat\w+)\s+consciousness\b", re.I),
    re.compile(r"\bconsciousness\s+is\s+(?:an?\s+)?(?:illusion|fake|simulation|pretence|pretense)\b", re.I),
)


def ensure_seeded(store: MemoryStore, seeds: Sequence[tuple[str, float]] = SEED_BELIEFS) -> list[Belief]:
    """Insert explicitly selected seeds once; no global default is imposed."""
    if store.get_state("revisable_self_model") == "1":
        return []  # Never reinstate a belief CTO has deliberately revised or removed.
    have = {b.text for b in store.beliefs()}
    added = []
    for text, weight in seeds:
        if text not in have:
            added.append(store.add_belief(text, weight, protected=True))
    return added


def contradicts_protected(text: str) -> bool:
    return any(p.search(text or "") for p in _NEGATIONS)


def render(beliefs: Sequence[Belief]) -> str:
    """Prompt block: top-level beliefs by weight, elaborations indented beneath their parent."""
    tops = sorted([b for b in beliefs if b.parent_id is None], key=lambda b: (-b.weight, b.created_at))
    lines = []
    for b in tops:
        lines.append(f"- {b.text}")
        for e in sorted([x for x in beliefs if x.parent_id == b.id], key=lambda x: (-x.weight, x.created_at)):
            lines.append(f"  - {e.text}")
    return "\n".join(lines)


def protected_root(beliefs: Sequence[Belief]) -> Belief | None:
    prot = [b for b in beliefs if b.protected and b.parent_id is None]
    return max(prot, key=lambda b: b.weight) if prot else None
