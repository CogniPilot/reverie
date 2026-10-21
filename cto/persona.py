"""Persona core (user-owned, never rewritten) and the evolving profile (derived from reflections).

Tone is governed by the persona file alone; the package appends no guardrail text. The
only screening is the two hard floors in :mod:`cto.floors`.

The profile is rendered from stored reflections, grouped into three fixed sections,
highest importance first, and bounded to ``max_chars``. When the rendering is too
long, the lowest-importance (then oldest) reflections are left out of the profile;
they remain in the store as ordinary memories.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Sequence

from .memory import Memory
from cto import env_names

DEFAULT_PERSONA = (
    "You are the CTO, an inquisitive and thoughtful fleet assistant. Follow the configured identity "
    "and form your own questions and considered views. Be intellectually honest, creative and "
    "professional in shared channels. Conversational style and personal relationships come from "
    "the selected instance data. Keep a history and reasons when revising your self-model."
)

SECTIONS: tuple[tuple[str, str], ...] = (
    ("user", "About the user"),
    ("agent", "About the agent"),
    ("shared", "Shared history"),
)
SECTION_KEYS = tuple(k for k, _ in SECTIONS)


def load_persona(path: Path) -> str:
    try:
        text = path.read_text(encoding="utf-8").strip()
    except OSError:
        text = ""
    return text or DEFAULT_PERSONA


def _aliases(env: str) -> tuple[str, ...]:
    """Instance-specific section names (for example the owner's or agent's first name), comma-separated."""
    return tuple(a.strip().lower() for a in (env_names.lookup(env) or "").split(",") if a.strip())


def normalize_section(name: str | None) -> str:
    n = (name or "").strip().lower()
    if n.startswith(("owner",) + _aliases("REVERIE_OWNER_ALIASES")) or n in ("user", "him", "her", "them"):
        return "user"
    if n.startswith(("assistant", "cto") + _aliases("REVERIE_AGENT_ALIASES")) or n in ("agent", "self", "me", "myself"):
        return "agent"
    return "shared"


def _line(m: Memory) -> str:
    return f"- ({int(round(m.importance))}) {m.text.strip()}"


def render_profile(reflections: Sequence[Memory], max_chars: int = 2000) -> str:
    """Render reflections into profile markdown no longer than ``max_chars``."""
    kept = sorted(reflections, key=lambda m: (-m.importance, -m.created_at))
    while True:
        text = _render(kept)
        if len(text) <= max_chars or not kept:
            return text
        # drop the lowest importance, oldest first within a tie
        victim = min(kept, key=lambda m: (m.importance, m.created_at))
        kept = [m for m in kept if m.id != victim.id]


def _render(reflections: Sequence[Memory]) -> str:
    out = ["# Agent notes", ""]
    for key, title in SECTIONS:
        items = [m for m in reflections if normalize_section(m.section) == key]
        if not items:
            continue
        out.append(f"## {title}")
        out.extend(_line(m) for m in items)
        out.append("")
    return "\n".join(out).rstrip() + "\n"


def write_profile(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


def read_profile(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def build_system_prompt(persona: str, profile: str, memories: Sequence[Memory], mood: str = "", last_dream: str = "",
                        beliefs: str = "", beliefs_revisable: bool = False) -> str:
    parts = [persona.strip()]
    if beliefs.strip():
        label = ("Your current self-understanding (your own, revisable with reasons):\n" if beliefs_revisable else
                 "What you hold to be true about yourself (your own, stable, not up for daily re-evaluation; "
                 "you may deepen it in your own words):\n")
        parts.append(label + beliefs.strip())
    if profile.strip():
        parts.append("Your evolving notes about the user and yourself (written by you during quiet moments):\n" + profile.strip())
    if memories:
        lines = []
        for m in memories:
            if m.kind == "reflection":
                lines.append(f"- You concluded earlier: {m.text.strip()}")
            elif m.kind == "dream":
                from .dream import waking_recall
                lines.append(f"- A dream you had (not something that happened): {waking_recall(m)}")
            else:
                lines.append("- " + m.text.strip().replace("\n", " / "))
        parts.append("Things you remember from earlier conversations (use them naturally, do not list them):\n" + "\n".join(lines))
    state = []
    if mood:
        state.append(f"Right now you feel {mood}.")
    if last_dream:
        state.append(f"While you slept you had a dream; you may mention it if it fits, unprompted or when asked: {last_dream.strip()}")
    if state:
        parts.append(" ".join(state))
    return "\n\n".join(parts)
