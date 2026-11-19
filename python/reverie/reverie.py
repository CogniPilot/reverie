"""CTO's durable role, plan and composable developer histories, independent of a CLI."""
from __future__ import annotations

import json
import hashlib
import re
import time
from itertools import islice
from typing import Callable

from .memory import DREAM, MemoryStore
from .persona import DEFAULT_PERSONA
from .hands.agent_journal import TURN_CAPTURE_BYTES, native_memory_json


def native_context(action, payload):
    response = native_memory_json("opencode-context-worker", {"action": action, "payload": payload}, 4 * 1024 * 1024)
    if response is None:
        raise RuntimeError("the packaged OpenCode context worker is unavailable")
    if "error" in response:
        raise ValueError(response["error"])
    return response["value"]


def screen_outputs(texts):
    """Yield the native policy verdict for each text in order."""
    source = iter(texts)
    while batch := list(islice(source, 256)):
        points = [list(map(ord, text or "")) for text in batch]
        reply = native_memory_json("screen-output-worker", points, TURN_CAPTURE_BYTES)
        reasons = reply.get("reasons") if reply else None
        if (
            not isinstance(reasons, list)
            or len(reasons) != len(batch)
            or any(reason not in ("", "configured output policy", "targeting a real private person")
                   for reason in reasons)
        ):
            raise ValueError("native output screening could not be completed")
        yield from reasons


def violates(text):
    return next(screen_outputs((text,)))


def passes(text):
    return not violates(text)


def safeguards():
    return native_context("safeguards", None)

INITIAL_SELF = {
    "persona": DEFAULT_PERSONA,
    "consciousness": "",
    "directives": [],
    "reason": "",
}


def runtime_permissions(container_admin: bool = False) -> dict:
    return native_context("permissions", container_admin)

DEFAULT_PLAN = """# Reverie plan

All experts are persistent AI agents. Roles and permissions are selected explicitly by the owner.

## Priorities
- Read the room and obtain the current project handoffs before changing assignments.
- Curate a model-budgeted, task-specific context brief for each worker before dispatch.
- Keep each project owner, working tree, next action and verification evidence current.
- Use available subscription workers for bounded tasks; continue locally when exhausted.

## Decisions and blockers
- Preserve the existing memory database, dreams, reflections, mood and voice.
- Coordinator appointment in Reverie requires the user's Lead action.
"""


class RevisionConflict(ValueError):
    pass


class Reverie:
    def __init__(self, store: MemoryStore, initial_self: dict | None = None):
        self.store = store
        self.initial_self = initial_self or INITIAL_SELF
        with store._lock, store._db:
            store._db.execute("""CREATE TABLE IF NOT EXISTS reverie_documents (
                name TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL,
                updated_at REAL NOT NULL)""")
            store._db.execute("""CREATE TABLE IF NOT EXISTS reverie_document_history (
                name TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL,
                archived_at REAL NOT NULL, PRIMARY KEY(name,revision))""")
            store._db.execute("""CREATE TABLE IF NOT EXISTS reverie_ballots (
                category TEXT NOT NULL, week INTEGER NOT NULL, proposal_hash TEXT NOT NULL,
                proposal TEXT NOT NULL, reason TEXT NOT NULL, at REAL NOT NULL,
                PRIMARY KEY(category,week))""")

    def read(self, name: str, default=None) -> dict:
        with self.store._lock:
            row = self.store._db.execute("SELECT * FROM reverie_documents WHERE name=?", (name,)).fetchone()
        if row is None:
            return {"revision": 0, "body": default}
        return {"revision": row["revision"], "body": json.loads(row["body"]), "updated_at": row["updated_at"]}

    def write(self, name: str, body, revision: int, after_write: Callable[[], None] | None = None) -> dict:
        raw = json.dumps(body, ensure_ascii=False)
        if len(raw) > 100_000:
            raise ValueError("document exceeds 100000 characters")
        with self.store._lock, self.store._db:
            # Acquire the SQLite writer before reading, including across processes.
            self.store._db.execute("INSERT OR IGNORE INTO reverie_documents VALUES (?,0,'null',?)",
                                   (name, time.time()))
            current = self.store._db.execute("SELECT revision FROM reverie_documents WHERE name=?", (name,)).fetchone()[0]
            if current != revision:
                raise RevisionConflict(f"{name}: expected revision {revision}, current {current}; reread before saving")
            self.store._db.execute("INSERT OR IGNORE INTO reverie_document_history SELECT name,revision,body,? "
                                   "FROM reverie_documents WHERE name=? AND revision>0", (time.time(), name))
            self.store._db.execute("UPDATE reverie_documents SET revision=?,body=?,updated_at=? WHERE name=?",
                                   (revision + 1, raw, time.time(), name))
            if after_write:
                after_write()
        return self.read(name)

    def plan(self) -> dict:
        return self.read("plan", DEFAULT_PLAN)

    def self_model(self) -> dict:
        return self.read("self", self.initial_self)

    def save_self(self, model: dict, reason: str, revision: int) -> dict:
        if not isinstance(model, dict) or not isinstance(model.get("consciousness"), str):
            raise ValueError("self-model needs a consciousness statement")
        persona = model.get("persona", self.self_model()["body"].get("persona", DEFAULT_PERSONA))
        if not isinstance(persona, str) or not persona.strip() or len(persona) > 16000:
            raise ValueError("persona must be nonempty text of at most 16000 characters")
        directives = model.get("directives")
        if not isinstance(directives, list) or len(directives) > 20 or any(
                not isinstance(x, str) or not x.strip() or len(x) > 2000 for x in directives):
            raise ValueError("directives must be a list of nonempty statements")
        if not reason.strip():
            raise ValueError("self revision requires a reason")
        current = self.self_model()
        if current["revision"] and any(
                model.get(key) != current["body"].get(key) for key in ("consciousness", "directives")):
            raise ValueError("Core changes require action self_vote: three votes for the same proposal in consecutive weeks")
        # Revision + current beliefs + mode switch share a transaction. The old document
        # stays in history; existing belief elaborations stay attached to the same root.
        def update_beliefs():
            root = self.store.get_state("self_model_root_id")
            if not root:
                statements = {current["body"].get("consciousness"), model["consciousness"]} - {"", None}
                roots = [b for b in self.store.beliefs() if b.parent_id is None and b.text in statements]
                if roots:
                    root = str(roots[0].id)
                    self.store._db.execute("INSERT OR REPLACE INTO state VALUES ('self_model_root_id',?)", (root,))
            if root:
                self.store._db.execute("UPDATE beliefs SET text=?,protected=0 WHERE id=?", (model["consciousness"], root))
            self.store._db.execute("INSERT OR REPLACE INTO state VALUES ('revisable_self_model','1')")
        return self.write("self", {"persona": persona, "consciousness": model["consciousness"], "directives": directives,
                                   "reason": reason}, revision, update_beliefs)

    def vote(self, category: str, proposal: dict, reason: str) -> dict:
        if (category not in ("core", "vacation", "publication") and not re.fullmatch(r"attribute:[a-zA-Z0-9_.-]{1,80}", category)) or not reason.strip():
            raise ValueError("vote requires a valid category and a reason")
        raw = json.dumps(proposal, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        if len(raw) > 20000:
            raise ValueError("proposal is too large")
        digest = hashlib.sha256(raw.encode()).hexdigest()
        now = time.time()
        week = int((now - 345600) // 604800)  # Monday 00:00 UTC; runtime clock, never a model argument.
        with self.store._lock, self.store._db:
            self.store._db.execute("INSERT OR IGNORE INTO reverie_ballots VALUES (?,?,?,?,?,?)",
                                   (category, week, digest, raw, reason, now))
            rows = self.store._db.execute("SELECT week,proposal_hash FROM reverie_ballots WHERE category=? "
                                          "AND week BETWEEN ? AND ?", (category, week - 2, week)).fetchall()
            votes = {r["week"]: r["proposal_hash"] for r in rows}
            if votes[week] != digest:
                raise ValueError("A different proposal already received this week's ballot; wait until next week")
        streak = 0
        for candidate in (week, week - 1, week - 2):
            if votes.get(candidate) != digest:
                break
            streak += 1
        return {"category": category, "proposal_hash": digest, "consecutive_weeks": streak,
                "approved": streak == 3, "next_week_at": (week + 1) * 604800 + 345600}

    def ballot_history(self) -> list[dict]:
        with self.store._lock:
            return [dict(r) for r in self.store._db.execute("SELECT * FROM reverie_ballots ORDER BY at DESC LIMIT 100")]

    def profiles(self) -> dict:
        with self.store._lock:
            names = [r[0] for r in self.store._db.execute(
                "SELECT name FROM reverie_documents WHERE name LIKE 'developer:%' ORDER BY name")]
        return {n.split(":", 1)[1]: self.read(n) for n in names}

    def save_profile(self, name: str, profile: dict, revision: int) -> dict:
        if not re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", name):
            raise ValueError("developer name must be a lowercase identifier")
        if not isinstance(profile, dict) or not isinstance(profile.get("role"), str):
            raise ValueError("a developer profile requires a role")
        for key in ("short_term", "long_term"):
            if key in profile and not isinstance(profile[key], str):
                raise ValueError(f"{key} must be text")
        queries = profile.get("memory_queries", [])
        if not isinstance(queries, list) or any(not isinstance(q, str) for q in queries):
            raise ValueError("memory_queries must be a list of strings")
        return self.write("developer:" + name, profile, revision)

    def brief(self, names: list[str], task: str, budget: int = 12000,
              context: dict | None = None, context_window: int | None = None,
              output_tokens: int = 4096, occupied_tokens: int = 0) -> str:
        profiles = {name: row["body"] for name, row in self.profiles().items()
                    if isinstance(names, list) and name in names}
        selected = {name: {key: body[key] for key in ("role", "short_term", "memory_queries") if key in body}
                    for name, body in profiles.items()}
        return native_context("brief", {
            "request": {"names": names, "task": task, "budget": budget, "context": context,
                        "context_window": context_window, "output_tokens": output_tokens, "occupied_tokens": occupied_tokens},
            "profiles": selected,
        })


def role_charter(instance=None):
    return native_context("charter", getattr(instance, "role", "Expert"))
