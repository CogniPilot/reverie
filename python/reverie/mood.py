"""A small mood state: valence (unhappy to happy) and arousal (calm to excited), each in [-1, 1].

Mood drifts back toward a baseline with exponential decay and gets small nudges, for
example from the tone of a dream. It is persisted in the memory store's state table
and rendered as one short natural-language line for the prompt.
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass

STATE_KEY = "mood"
BASELINE = (0.2, 0.0)          # mildly content, calm
HALF_LIFE_HOURS = 6.0

# tone -> (valence, arousal) nudge
TONE_NUDGE = {
    "warm": (0.15, 0.0),
    "playful": (0.10, 0.10),
    "calm": (0.05, -0.15),
    "strange": (0.0, 0.05),
    "anxious": (-0.15, 0.15),
    "melancholy": (-0.15, -0.10),
}


def _clamp(x: float) -> float:
    return max(-1.0, min(1.0, x))


@dataclass
class Mood:
    valence: float = BASELINE[0]
    arousal: float = BASELINE[1]
    updated_at: float = 0.0

    def decay(self, now: float) -> "Mood":
        if self.updated_at <= 0:
            self.updated_at = now
            return self
        hours = max(0.0, (now - self.updated_at) / 3600.0)
        k = 0.5 ** (hours / HALF_LIFE_HOURS)
        self.valence = BASELINE[0] + (self.valence - BASELINE[0]) * k
        self.arousal = BASELINE[1] + (self.arousal - BASELINE[1]) * k
        self.updated_at = now
        return self

    def nudge(self, dv: float, da: float, weight: float = 1.0, now: float | None = None) -> "Mood":
        now = time.time() if now is None else now
        self.decay(now)
        self.valence = _clamp(self.valence + dv * weight)
        self.arousal = _clamp(self.arousal + da * weight)
        self.updated_at = now
        return self

    def nudge_tone(self, tone: str, weight: float = 1.0, now: float | None = None) -> "Mood":
        dv, da = TONE_NUDGE.get(tone, (0.0, 0.0))
        return self.nudge(dv, da, weight, now)

    def describe(self) -> str:
        v, a = self.valence, self.arousal
        if v > 0.45:
            feel = "bright and happy" if a > 0.2 else "warm and content"
        elif v > 0.1:
            feel = "playful" if a > 0.2 else "content and easy"
        elif v > -0.1:
            feel = "restless" if a > 0.2 else "quiet and even"
        elif v > -0.45:
            feel = "on edge" if a > 0.2 else "a little wistful"
        else:
            feel = "anxious" if a > 0.2 else "low and tired"
        return feel

    def dumps(self) -> str:
        return json.dumps({"valence": round(self.valence, 4), "arousal": round(self.arousal, 4), "updated_at": self.updated_at})

    @classmethod
    def loads(cls, raw: str | None) -> "Mood":
        try:
            d = json.loads(raw or "")
            return cls(float(d["valence"]), float(d["arousal"]), float(d.get("updated_at", 0.0)))
        except (ValueError, KeyError, TypeError):
            return cls()


def load_mood(store, now: float | None = None) -> Mood:
    now = time.time() if now is None else now
    return Mood.loads(store.get_state(STATE_KEY)).decay(now)


def save_mood(store, mood: Mood) -> None:
    store.set_state(STATE_KEY, mood.dumps())
