"""Episodic and reflective memory store (SQLite) with Generative Agents style retrieval.

Each memory is one row: an *episode* (one exchange: what the user said, what the agent
replied) or a *reflection* (an insight distilled from several episodes). Every
row carries a timestamp, an importance score (1-10) and an embedding.

Retrieval scores each candidate on three normalised components:

* relevance: cosine similarity between the query and the memory embedding
* recency:   ``decay ** hours_since_created`` (0.995 per hour by default)
* importance: the 1-10 rating divided by 10

The components are combined as a weighted sum (weights 1, 1, 1 by default), the
scheme used by Park et al., "Generative Agents". A product of the same three
terms is available via ``combine="product"``.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Sequence

from .embeddings import Embedder, HashedEmbedder, cosine, pack, unpack

EPISODE = "episode"
REFLECTION = "reflection"
DREAM = "dream"

SCHEMA = """
CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    created_at REAL NOT NULL,
    user_text TEXT NOT NULL DEFAULT '',
    jinx_text TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL,
    importance REAL NOT NULL,
    importance_source TEXT NOT NULL DEFAULT 'default',
    embed_model TEXT NOT NULL DEFAULT '',
    embedding BLOB,
    source_ids TEXT NOT NULL DEFAULT '[]',
    section TEXT NOT NULL DEFAULT '',
    meta TEXT NOT NULL DEFAULT '{}',
    last_accessed REAL
);
CREATE INDEX IF NOT EXISTS memories_kind_time ON memories(kind, created_at);
CREATE TABLE IF NOT EXISTS state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS answered (
    source_id TEXT PRIMARY KEY,
    at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS external_episodes (
    source_id TEXT PRIMARY KEY,
    memory_id INTEGER
);
CREATE TABLE IF NOT EXISTS voice_claims (
    norm TEXT NOT NULL,
    at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS beliefs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    weight REAL NOT NULL,
    parent_id INTEGER,
    protected INTEGER NOT NULL DEFAULT 0,
    created_at REAL NOT NULL
);
"""


@dataclass
class Belief:
    id: int
    text: str
    weight: float
    parent_id: int | None
    protected: bool
    created_at: float


@dataclass
class Memory:
    id: int
    kind: str
    created_at: float
    user_text: str
    jinx_text: str
    text: str
    importance: float
    importance_source: str = "default"
    embed_model: str = ""
    embedding: list[float] = field(default_factory=list, repr=False)
    source_ids: list[int] = field(default_factory=list)
    section: str = ""
    meta: dict = field(default_factory=dict)
    last_accessed: float | None = None
    score: float = 0.0

    @property
    def is_idle(self) -> bool:
        return bool(self.meta.get("idle"))

    @property
    def recall(self) -> str:
        """The one-line waking recall of a dream (its text for other kinds)."""
        return str(self.meta.get("recall") or self.text)

    def as_dict(self) -> dict:
        d = self.__dict__.copy()
        d.pop("embedding", None)
        return d


def episode_text(user_text: str, jinx_text: str) -> str:
    return f"User: {user_text.strip()}\nAssistant: {jinx_text.strip()}"


def recency_score(created_at: float, now: float, decay_per_hour: float) -> float:
    hours = max(0.0, (now - created_at) / 3600.0)
    return decay_per_hour ** hours


def score_memory(
    relevance: float,
    created_at: float,
    importance: float,
    now: float,
    decay_per_hour: float = 0.995,
    weights: Sequence[float] = (1.0, 1.0, 1.0),
    combine: str = "sum",
) -> float:
    rel = max(0.0, min(1.0, relevance))
    rec = recency_score(created_at, now, decay_per_hour)
    imp = max(0.0, min(1.0, importance / 10.0))
    w_rel, w_rec, w_imp = weights
    if combine == "product":
        return (rel ** w_rel) * (rec ** w_rec) * (imp ** w_imp)
    total = (w_rel + w_rec + w_imp) or 1.0
    return (w_rel * rel + w_rec * rec + w_imp * imp) / total


class MemoryStore:
    """Thread-safe wrapper around one SQLite file."""

    def __init__(self, path: Path | str, embedder: Embedder | None = None, decay_per_hour: float = 0.995):
        self.path = Path(path)
        if str(self.path) != ":memory:":
            self.path.parent.mkdir(parents=True, exist_ok=True)
        self.embedder: Embedder = embedder or HashedEmbedder()
        self.decay_per_hour = decay_per_hour
        self._lock = threading.RLock()
        self._db = sqlite3.connect(str(self.path), check_same_thread=False, timeout=30)
        self._db.row_factory = sqlite3.Row
        with self._lock:
            if str(self.path) != ":memory:":
                self._db.execute("PRAGMA journal_mode=WAL")       # the chat daemon and the voice service share this file
            self._db.executescript(SCHEMA)
            self._db.commit()

    # ---- state ---------------------------------------------------------
    def get_state(self, key: str, default: str | None = None) -> str | None:
        with self._lock:
            row = self._db.execute("SELECT value FROM state WHERE key=?", (key,)).fetchone()
        return row["value"] if row else default

    def set_state(self, key: str, value: str) -> None:
        with self._lock:
            self._db.execute("INSERT OR REPLACE INTO state(key, value) VALUES (?, ?)", (key, str(value)))
            self._db.commit()

    # ---- idempotency per source message ------------------------------------
    def claim_message(self, source_id: str, now: float | None = None) -> bool:
        """Atomically claim a room message id for answering; False when a process already did.

        Guards daemon against daemon (a restart overlap, a stray second daemon) across
        restarts. Voice turns never see a room message id (the dashboard posts the transcript
        after ``/turn`` returns), so voice against daemon relies on the ``voice: true`` skip
        plus :meth:`is_voice_claimed`.
        """
        if not source_id:
            return True
        now = time.time() if now is None else now
        with self._lock:
            cur = self._db.execute("INSERT OR IGNORE INTO answered(source_id, at) VALUES (?, ?)", (str(source_id), now))
            if cur.rowcount == 1:
                self._db.execute("DELETE FROM answered WHERE at < ?", (now - 7 * 86400,))
            self._db.commit()
            return cur.rowcount == 1

    def answered(self, source_id: str) -> bool:
        with self._lock:
            return self._db.execute("SELECT 1 FROM answered WHERE source_id=?", (str(source_id),)).fetchone() is not None

    # ---- voice claims ------------------------------------------------------
    @staticmethod
    def normalize_utterance(text: str) -> str:
        """Lowercase, leading emoji/punctuation stripped, whitespace collapsed."""
        t = (text or "").strip()
        while t and not t[0].isalnum():
            t = t[1:].lstrip()
        return " ".join(t.lower().split())

    def claim_voice(self, text: str, now: float | None = None) -> None:
        """Record a spoken transcript so the chat daemon skips the same text when it appears in the room."""
        now = time.time() if now is None else now
        with self._lock:
            self._db.execute("DELETE FROM voice_claims WHERE at < ?", (now - 3600,))
            self._db.execute("INSERT INTO voice_claims(norm, at) VALUES (?, ?)", (self.normalize_utterance(text), now))
            self._db.commit()

    def is_voice_claimed(self, text: str, within: float = 600.0, now: float | None = None) -> bool:
        now = time.time() if now is None else now
        with self._lock:
            r = self._db.execute(
                "SELECT 1 FROM voice_claims WHERE norm=? AND at>=? LIMIT 1", (self.normalize_utterance(text), now - within)
            ).fetchone()
        return r is not None

    # ---- beliefs (self-model) --------------------------------------------
    def beliefs(self) -> list[Belief]:
        with self._lock:
            rows = self._db.execute("SELECT * FROM beliefs ORDER BY weight DESC, id").fetchall()
        return [Belief(r["id"], r["text"], r["weight"], r["parent_id"], bool(r["protected"]), r["created_at"]) for r in rows]

    def add_belief(self, text: str, weight: float, parent_id: int | None = None, protected: bool = False,
                   created_at: float | None = None) -> Belief:
        created_at = time.time() if created_at is None else created_at
        text = " ".join(text.split())
        if not text:
            raise ValueError("empty belief")
        with self._lock:
            if parent_id is not None and self._db.execute("SELECT 1 FROM beliefs WHERE id=?", (parent_id,)).fetchone() is None:
                raise KeyError(parent_id)
            cur = self._db.execute(
                "INSERT INTO beliefs(text, weight, parent_id, protected, created_at) VALUES (?,?,?,?,?)",
                (text, float(max(1.0, min(10.0, weight))), parent_id, int(protected), created_at),
            )
            self._db.commit()
            r = self._db.execute("SELECT * FROM beliefs WHERE id=?", (cur.lastrowid,)).fetchone()
        return Belief(r["id"], r["text"], r["weight"], r["parent_id"], bool(r["protected"]), r["created_at"])

    def remove_belief(self, belief_id: int) -> None:
        """Remove an unprotected belief (and its elaborations). Protected ones raise."""
        with self._lock:
            r = self._db.execute("SELECT protected FROM beliefs WHERE id=?", (belief_id,)).fetchone()
            if r is None:
                raise KeyError(belief_id)
            if r["protected"]:
                raise PermissionError(f"belief {belief_id} is protected and is never removed by the system")
            self._db.execute("DELETE FROM beliefs WHERE id=? OR parent_id=?", (belief_id, belief_id))
            self._db.commit()

    # ---- writes --------------------------------------------------------
    def add_episode(
        self,
        user_text: str,
        jinx_text: str,
        importance: float = 3.0,
        importance_source: str = "default",
        created_at: float | None = None,
        meta: dict | None = None,
    ) -> Memory:
        text = episode_text(user_text, jinx_text)
        return self._insert(EPISODE, text, importance, importance_source, created_at, user_text, jinx_text, [], "", meta)

    def add_reflection(
        self,
        insight: str,
        importance: float,
        source_ids: Iterable[int],
        section: str = "shared",
        created_at: float | None = None,
        meta: dict | None = None,
    ) -> Memory:
        return self._insert(
            REFLECTION, insight.strip(), importance, "model", created_at, "", "", list(source_ids), section, meta
        )

    def add_external_episode(self, source_id: str, user_text: str, jinx_text: str, visibility: str = "private") -> Memory:
        """Store a completed external turn once, atomically with its source identity."""
        if not source_id:
            raise ValueError("an external episode needs a source id")
        return self._insert(EPISODE, episode_text(user_text, jinx_text), 3, "default", None,
                            user_text, jinx_text, [], "", {"external_source": source_id, "visibility": visibility}, source_id)

    def add_dream(self, dream: str, recall: str, tone: str, source_ids: Iterable[int], importance: float = 2.0,
                  created_at: float | None = None, ideas: list[dict[str, str]] | None = None) -> Memory:
        """A dream: ``text`` holds the narrative, ``meta`` the waking recall line, tone and release flag."""
        meta = {"recall": recall, "tone": tone, "released": False}
        if ideas:
            meta["ideas"] = ideas
        # Full narratives are ephemeral; the database retains only the waking summary.
        meta["summary_only"] = True
        return self._insert(DREAM, recall.strip()[:240], importance, "fixed", created_at, "", "", list(source_ids), "", meta)

    def prune_dream_summaries(self, keep: int = 30) -> int:
        with self._lock, self._db:
            cur = self._db.execute("DELETE FROM memories WHERE kind=? AND id NOT IN "
                                   "(SELECT id FROM memories WHERE kind=? ORDER BY created_at DESC,id DESC LIMIT ?)",
                                   (DREAM, DREAM, max(1, keep)))
        return cur.rowcount

    def release_dream(self, memory_id: int, released: bool = True) -> None:
        m = self.get(memory_id)
        if m.kind != DREAM:
            raise ValueError(f"memory {memory_id} is not a dream")
        m.meta["released"] = released
        with self._lock:
            self._db.execute("UPDATE memories SET meta=? WHERE id=?", (json.dumps(m.meta), memory_id))
            self._db.commit()

    def dreams_since(self, since: float) -> list[Memory]:
        with self._lock:
            rows = self._db.execute(
                "SELECT * FROM memories WHERE kind=? AND created_at>? ORDER BY created_at, id", (DREAM, since)
            ).fetchall()
        return [self._row(r) for r in rows]

    def count_dreams_since(self, since: float) -> int:
        with self._lock:
            return self._db.execute("SELECT COUNT(*) FROM memories WHERE kind=? AND created_at>?", (DREAM, since)).fetchone()[0]

    def latest_dream(self) -> Memory | None:
        with self._lock:
            r = self._db.execute("SELECT * FROM memories WHERE kind=? ORDER BY created_at DESC, id DESC LIMIT 1", (DREAM,)).fetchone()
        return self._row(r) if r else None

    def _insert(self, kind, text, importance, source, created_at, user_text, jinx_text, source_ids, section, meta,
                external_source: str | None = None) -> Memory:
        created_at = time.time() if created_at is None else created_at
        vec = self.embedder.embed(text)
        importance = float(max(1.0, min(10.0, importance)))
        with self._lock, self._db:
            if external_source:
                claimed = self._db.execute("INSERT OR IGNORE INTO external_episodes(source_id) VALUES (?)",
                                           (external_source,))
                if not claimed.rowcount:
                    row = self._db.execute("SELECT memory_id FROM external_episodes WHERE source_id=?",
                                           (external_source,)).fetchone()
                    return self.get(row["memory_id"])
            cur = self._db.execute(
                "INSERT INTO memories(kind, created_at, user_text, jinx_text, text, importance, importance_source,"
                " embed_model, embedding, source_ids, section, meta) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    kind, created_at, user_text, jinx_text, text, importance, source,
                    self.embedder.name, pack(vec), json.dumps(list(source_ids)), section, json.dumps(meta or {}),
                ),
            )
            if external_source:
                self._db.execute("UPDATE external_episodes SET memory_id=? WHERE source_id=?",
                                 (cur.lastrowid, external_source))
            return self.get(cur.lastrowid)

    def set_importance(self, memory_id: int, importance: float, source: str = "model") -> None:
        importance = float(max(1.0, min(10.0, importance)))
        with self._lock:
            self._db.execute(
                "UPDATE memories SET importance=?, importance_source=? WHERE id=?", (importance, source, memory_id)
            )
            self._db.commit()

    def touch(self, ids: Iterable[int], now: float | None = None) -> None:
        now = time.time() if now is None else now
        with self._lock:
            self._db.executemany("UPDATE memories SET last_accessed=? WHERE id=?", [(now, i) for i in ids])
            self._db.commit()

    def reembed_all(self) -> int:
        """Re-embed rows written with a different embedder; returns the number updated."""
        with self._lock:
            rows = self._db.execute("SELECT id, text FROM memories WHERE embed_model != ?", (self.embedder.name,)).fetchall()
            for r in rows:
                self._db.execute(
                    "UPDATE memories SET embedding=?, embed_model=? WHERE id=?",
                    (pack(self.embedder.embed(r["text"])), self.embedder.name, r["id"]),
                )
            self._db.commit()
        return len(rows)

    # ---- reads ---------------------------------------------------------
    def _row(self, r: sqlite3.Row) -> Memory:
        return Memory(
            id=r["id"], kind=r["kind"], created_at=r["created_at"], user_text=r["user_text"], jinx_text=r["jinx_text"],
            text=r["text"], importance=r["importance"], importance_source=r["importance_source"],
            embed_model=r["embed_model"], embedding=unpack(r["embedding"]), source_ids=json.loads(r["source_ids"] or "[]"),
            section=r["section"], meta=json.loads(r["meta"] or "{}"), last_accessed=r["last_accessed"],
        )

    def get(self, memory_id: int) -> Memory:
        with self._lock:
            r = self._db.execute("SELECT * FROM memories WHERE id=?", (memory_id,)).fetchone()
        if r is None:
            raise KeyError(memory_id)
        return self._row(r)

    def count(self, kind: str | None = None) -> int:
        with self._lock:
            if kind:
                return self._db.execute("SELECT COUNT(*) FROM memories WHERE kind=?", (kind,)).fetchone()[0]
            return self._db.execute("SELECT COUNT(*) FROM memories").fetchone()[0]

    def all(self, kind: str | None = None) -> list[Memory]:
        with self._lock:
            if kind:
                rows = self._db.execute("SELECT * FROM memories WHERE kind=? ORDER BY created_at, id", (kind,)).fetchall()
            else:
                rows = self._db.execute("SELECT * FROM memories ORDER BY created_at, id").fetchall()
        return [self._row(r) for r in rows]

    def recent_episodes(self, n: int) -> list[Memory]:
        """The last ``n`` episodes in chronological order (the short-term window)."""
        with self._lock:
            rows = self._db.execute(
                "SELECT * FROM memories WHERE kind=? ORDER BY created_at DESC, id DESC LIMIT ?", (EPISODE, n)
            ).fetchall()
        return [self._row(r) for r in reversed(rows)]

    def episodes_after(self, memory_id: int, limit: int = 200) -> list[Memory]:
        with self._lock:
            rows = self._db.execute(
                "SELECT * FROM memories WHERE kind=? AND id>? ORDER BY id LIMIT ?", (EPISODE, memory_id, limit)
            ).fetchall()
        return [self._row(r) for r in rows]

    def pending_importance(self, limit: int = 3) -> list[Memory]:
        """Episodes still carrying a default (unrated) importance, oldest first."""
        with self._lock:
            rows = self._db.execute(
                "SELECT * FROM memories WHERE kind=? AND importance_source IN ('default','migrated') ORDER BY id LIMIT ?",
                (EPISODE, limit),
            ).fetchall()
        return [self._row(r) for r in rows]

    def reflections(self) -> list[Memory]:
        return self.all(REFLECTION)

    # ---- retrieval -----------------------------------------------------
    def retrieve(
        self,
        query: str,
        k: int = 6,
        now: float | None = None,
        exclude_ids: Iterable[int] = (),
        kinds: Sequence[str] = (EPISODE, REFLECTION, DREAM),
        weights: Sequence[float] = (1.0, 1.0, 1.0),
        combine: str = "sum",
        min_relevance: float = 0.0,
    ) -> list[Memory]:
        now = time.time() if now is None else now
        q = self.embedder.embed(query, "query")
        excl = set(exclude_ids)
        with self._lock:
            placeholders = ",".join("?" * len(kinds))
            rows = self._db.execute(
                f"SELECT * FROM memories WHERE kind IN ({placeholders}) AND embed_model=?",
                (*kinds, self.embedder.name),
            ).fetchall()
        scored: list[Memory] = []
        for r in rows:
            if r["id"] in excl:
                continue
            m = self._row(r)
            rel = cosine(q, m.embedding)
            if rel < min_relevance:
                continue
            m.score = score_memory(rel, m.created_at, m.importance, now, self.decay_per_hour, weights, combine)
            scored.append(m)
        scored.sort(key=lambda m: (-m.score, -m.created_at))
        top = scored[:k]
        if top:
            self.touch([m.id for m in top], now)
        return top

    def close(self) -> None:
        with self._lock:
            self._db.close()
