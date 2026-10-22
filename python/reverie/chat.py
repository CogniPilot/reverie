"""The chat daemon: ``python -m reverie.chat``.

Runs in the foreground of its own Reverie shell session. A guard thread drains
stdin so that anything typed into the pane is discarded, never executed. The
main loop polls the room every ``poll_interval`` seconds and answers user
messages immediately, GPU busy or not. A maintenance thread does the optional
work only when the GPU is free and no hold file exists: importance ratings for
unrated episodes, an idle joke every ``joke_interval`` seconds, and a reflection
pass at most every ``reflect_interval`` seconds.
"""
from __future__ import annotations

import random
import sys
import threading
import time
from typing import Sequence

from .beliefs import ensure_seeded, render
from .config import Config
from .dream import Dreamer, waking_recall
from .embeddings import make_embedder
from .gpu import GpuLock
from .importance import rate_episode
from .instance import initial_self_for
from .floors import violates
from .llm import ChatClient, LLMError, limit_words
from .log import get, setup
from .memory import DREAM, EPISODE, Memory, MemoryStore
from .migrate import migrate_history
from .mood import load_mood
from .persona import build_system_prompt, load_persona, read_profile
from .reflection import Reflector
from .room import Room, is_for_me

TOPICS = [
    "Modelica compilers", "the Rust borrow checker", "Lean 4 proofs", "quadrotor SLAM", "git rebase",
    "AI agents in a chatroom", "cargo build times", "NixOS", "swap space", "code review", "WASM in the browser",
    "tmux sessions", "a full scratch drive", "DCO sign-offs", "a GPU with nothing to do",
]
IDLE_USER_TEXT = "(idle moment; a joke was requested)"


def _is_idle_user_text(text: str) -> bool:
    return text.startswith("(idle moment")


class Brain:
    """Everything the daemon knows how to do, without the polling loop (so tests can drive it)."""

    def __init__(self, cfg: Config, store: MemoryStore, client: ChatClient, room: Room):
        self.cfg = cfg
        self.store = store
        self.client = client
        self.room = room
        self.reflector = Reflector(
            store, client, cfg.profile_path, cfg.profile_max_chars, cfg.reflect_interval, cfg.reflect_min_episodes
        )
        self.dreamer = Dreamer(store, client, cfg.sleep_min_idle, cfg.dreams_per_sleep, cfg.dream_spacing, cfg.dream_mood_weight)
        self.dreamer.system_prompt_path = cfg.dream_prompt_path
        self.dreamer.creative_context = self.creative_context
        self.log = get()
        self.last_activity = time.time()
        self._llm_lock = threading.Lock()
        self.gpu = GpuLock("chat", cfg.gpu_lock_path, cfg.gpu_yield_path, cfg.gpu_activity_path)
        self.gpu_dream = GpuLock("dream", cfg.gpu_lock_path, cfg.gpu_yield_path, cfg.gpu_activity_path)

    # ---- prompt assembly ---------------------------------------------
    def short_term(self) -> list[Memory]:
        return self.store.recent_episodes(self.cfg.short_term_turns)

    def history_messages(self, episodes: Sequence[Memory]) -> list[dict]:
        msgs: list[dict] = []
        for m in episodes:
            msgs.append({"role": "user", "content": m.user_text})
            msgs.append({"role": "assistant", "content": m.assistant_text})
        return msgs

    def build_messages(self, user_text: str, now: float | None = None,
                       recall_long_term: bool = True) -> tuple[list[dict], list[Memory]]:
        now = time.time() if now is None else now
        recent = self.short_term()
        recalled = (self.store.retrieve(user_text, k=self.cfg.recall_k, now=now, exclude_ids=[m.id for m in recent])
                    if recall_long_term else [])
        last = self.store.latest_dream()
        last_dream = waking_recall(last) if last and now - last.created_at <= self.cfg.dream_recall_hours * 3600 else ""
        persona = (self.cfg.instance.persona if self.cfg.instance and not self.cfg.persona_path.exists()
                   else load_persona(self.cfg.persona_path))
        if self.store.get_state("revisable_self_model") == "1":
            from .reverie import Reverie
            persona = Reverie(self.store, initial_self_for(self.cfg.instance)).self_model()["body"]["persona"]
        system = build_system_prompt(persona, read_profile(self.cfg.profile_path), recalled,
                                     mood=load_mood(self.store, now).describe(), last_dream=last_dream,
                                     beliefs=render(self.store.beliefs()),
                                     beliefs_revisable=self.store.get_state("revisable_self_model") == "1")
        messages = [{"role": "system", "content": system}] + self.history_messages(recent)
        messages.append({"role": "user", "content": user_text})
        return messages, recalled

    def creative_context(self) -> str:
        """Open questions from the actual plan and histories, with no prescribed dream subject."""
        from .reverie import Reverie
        reverie = Reverie(self.store)
        parts = [reverie.plan()["body"][:4000]]
        for name, record in reverie.profiles().items():
            profile = record["body"]
            parts.append(f"{name}: {profile['role']}\n{profile.get('long_term', '')[:500]}\n"
                         f"{profile.get('short_term', '')[:500]}")
        return "\n\n".join(parts)[:8000]

    def _with_gpu(self, fn):
        """Run ``fn`` holding the chat-priority GPU lock. A lower-priority holder (training)
        is asked to yield; if it does not within ``gpu_lock_wait`` seconds the call goes
        ahead anyway, because replies are never blocked."""
        got = False
        try:
            got = self.gpu.acquire(timeout=self.cfg.gpu_lock_wait)
        except OSError as e:
            self.log.warning("gpu lock unavailable: %r", e)
        if not got:
            self.log.warning("proceeding without the gpu lock")
        try:
            return fn()
        finally:
            if got:
                self.gpu.release()

    # ---- actions -----------------------------------------------------
    def generate(self, messages: list[dict], max_tokens: int, max_words: int | None = None) -> str | None:
        """One generation, trimmed to the safety word cap (``max_words`` 0 disables). A reply that
        crosses the configured output checks and privacy safeguards (see reverie.floors) is regenerated once at a lower
        temperature, then dropped."""
        temperature = self.cfg.reply_temperature
        cap = self.cfg.reply_max_words if max_words is None else max_words
        for attempt in range(2):
            try:
                with self._llm_lock:
                    text = self._with_gpu(lambda: self.client.chat(messages, max_tokens, temperature, max(self.cfg.reply_max_chars, 4 * max_tokens)))
            except LLMError as e:
                self.log.warning("generation failed: %s", e)
                return None
            text = limit_words(text, cap)
            if not text:
                return None
            crossed = violates(text)
            if not crossed:
                return text
            self.log.warning("reply dropped at a hard floor (%s), attempt %d", crossed, attempt + 1)
            temperature = max(0.2, temperature - 0.4)
        return None

    def reply(self, user_text: str, post: bool = True, max_tokens: int | None = None, max_words: int | None = None) -> str | None:
        """Answer one user message: recall, generate, post to the room (unless ``post`` is False,
        as for voice turns the dashboard relays itself), and store the episode."""
        messages, recalled = self.build_messages(user_text)
        text = self.generate(messages, max_tokens or self.cfg.reply_max_tokens, max_words)
        if not text:
            return None
        if post and not self.room.say(text):
            self.log.warning("could not post reply")
        self.store.add_episode(user_text, text, self.cfg.default_importance, "default")
        self.last_activity = time.time()
        self.log.info("reply (%d recalled): %s", len(recalled), text)
        return text

    def joke(self) -> str | None:
        prompt = (
            "Nobody said anything for a while. Say one new short, playful line to the owner, a joke or a teasing "
            "one-liner, about " + random.choice(TOPICS) + ". Do not repeat an earlier joke."
        )
        messages, _ = self.build_messages(prompt)
        text = self.generate(messages, 160)
        if not text or self.room.gpu_busy():
            return None
        self.room.say(text)
        self.store.add_episode(IDLE_USER_TEXT, text, self.cfg.joke_importance, "default", meta={"idle": True})
        self.last_activity = time.time()
        self.log.info("joke: %s", text)
        return text

    def rate_pending(self, limit: int | None = None) -> int:
        n = 0
        for m in self.store.pending_importance(limit or self.cfg.rate_batch):
            if m.is_idle:
                self.store.set_importance(m.id, self.cfg.joke_importance, "fixed")
                continue
            with self._llm_lock:
                score = self._with_gpu(lambda: rate_episode(self.client, m, self.cfg.default_importance))
            self.store.set_importance(m.id, score, "model")
            n += 1
            self.log.info("rated #%d importance %.0f", m.id, score)
        return n

    def reflect_if_due(self) -> int:
        if not self.reflector.due():
            return 0
        with self._llm_lock:
            stored = self._with_gpu(self.reflector.reflect)
        self.log.info("reflection: %d insights", len(stored))
        return len(stored)

    def dream_if_due(self) -> Memory | None:
        """One dream, only in the sleep window and only if the lowest lock role can be taken at once."""
        if not self.dreamer.due(self.last_activity):
            return None
        if not self.gpu_dream.acquire(timeout=0):
            return None
        try:
            with self._llm_lock:
                mem = self.dreamer.dream()
        finally:
            self.gpu_dream.release()
        if mem:
            self.log.info("dream (%s, from %s): %s | recall: %s", mem.meta.get("tone"), mem.source_ids, mem.text, mem.recall)
        return mem

    def maintenance_step(self) -> None:
        """One unit of optional work; called only when the GPU is free and not held."""
        if self.rate_pending():
            return
        if self.reflect_if_due():
            return
        if self.dream_if_due():
            return
        if time.time() - self.last_activity >= self.cfg.joke_interval:
            self.joke()


class ChatDaemon:
    def __init__(self, cfg: Config | None = None, brain: Brain | None = None):
        self.cfg = cfg or Config()
        self.cfg.ensure_dirs()
        self.log = setup(self.cfg.log_path, stderr=sys.stderr.isatty())
        for line in self.cfg.deprecations():
            self.log.warning("deprecated: %s", line)
        if brain is None:
            embedder = make_embedder(self.cfg.embed_url, self.cfg.embed_model, self.cfg.embed_dims,
                                     self.cfg.embed_doc_prefix, self.cfg.embed_query_prefix)
            store = MemoryStore(self.cfg.db_path, embedder, self.cfg.recency_decay_per_hour)
            n = store.reembed_all()
            if n:
                self.log.info("re-embedded %d memories with %s", n, embedder.name)
            if self.cfg.instance:
                from .reverie import Reverie
                initial = initial_self_for(self.cfg.instance)
                reverie = Reverie(store, initial)
                if reverie.self_model()["revision"] == 0:
                    reverie.save_self(initial, "Owner-selected initial instance identity", 0)
            for b in ensure_seeded(store):
                self.log.info("seeded belief #%d: %s", b.id, b.text)
            imported = migrate_history(store, self.cfg.legacy_history, self.cfg.default_importance)
            if imported:
                self.log.info("imported %d legacy exchanges from %s", imported, self.cfg.legacy_history)
            client = ChatClient(self.cfg.api_base, self.cfg.model, self.cfg.request_timeout)
            room = Room(self.cfg.session_id, self.cfg.hold_path, legacy_hold_path=self.cfg.legacy_hold_path)
            brain = Brain(self.cfg, store, client, room)
            if not self.cfg.profile_path.exists():
                brain.reflector.refresh_profile()
        self.brain = brain
        self.seen: set = set()
        self._stop = threading.Event()

    def _drain_stdin(self) -> None:
        try:
            for _ in sys.stdin:
                pass
        except Exception:
            pass

    def _maintenance_loop(self) -> None:
        while not self._stop.is_set():
            try:
                if not self.brain.room.gpu_busy():
                    self.brain.maintenance_step()
            except Exception as e:  # never die
                self.log.error("maintenance error: %r", e)
            self._stop.wait(15)

    def tick(self) -> int:
        """Answer every new user message once; returns the number of replies."""
        n = 0
        for m in self.brain.room.messages():
            mid = m.get("id")
            if mid in self.seen:
                continue
            self.seen.add(mid)
            if not is_for_me(m, self.cfg.session_id):
                continue
            if m.get("voice"):
                continue                      # spoken turns are answered by the voice service
            text = (m.get("text") or "").strip()
            if not text:
                continue
            if self.brain.store.is_voice_claimed(text):
                self.log.info("skipping a spoken transcript already answered by voice: %s", text[:80])
                continue
            if not self.brain.store.claim_message(mid):
                self.log.info("skipping message %s: already answered by another process or run", mid)
                continue
            if self.brain.reply(text):
                n += 1
        return n

    def run(self) -> None:
        threading.Thread(target=self._drain_stdin, daemon=True).start()
        self.seen = {m.get("id") for m in self.brain.room.messages()}  # never answer messages from before this start
        self.log.info(
            "reverie started: model %s, %d episodes, %d reflections, %d dreams, embedder %s",
            self.cfg.model, self.brain.store.count(EPISODE), self.brain.store.count("reflection"),
            self.brain.store.count(DREAM), self.brain.store.embedder.name,
        )
        threading.Thread(target=self._maintenance_loop, daemon=True).start()
        while not self._stop.is_set():
            try:
                self.tick()
            except Exception as e:
                self.log.error("loop error: %r", e)
                self._stop.wait(30)
            self._stop.wait(self.cfg.poll_interval)

    def stop(self) -> None:
        self._stop.set()


def main(argv: Sequence[str] | None = None) -> int:
    import argparse

    p = argparse.ArgumentParser(prog="python -m reverie.chat", description="Run the CTO chat daemon.")
    p.add_argument("--check", action="store_true", help="print paths, counts and router reachability, then exit")
    p.add_argument("--reflect", action="store_true", help="run one reflection pass now and exit")
    p.add_argument("--dream", action="store_true", help="dream once now (ignores the sleep window) and exit")
    p.add_argument("--dreams", action="store_true", help="list stored dreams and exit")
    p.add_argument("--release-dream", type=int, metavar="ID", help="mark a dream as released for style training and exit")
    p.add_argument("--beliefs", action="store_true", help="print her held beliefs (self-model) and exit")
    p.add_argument("--rate", action="store_true", help="rate pending episodes now and exit")
    p.add_argument("--profile", action="store_true", help="print the current profile and exit")
    p.add_argument("--recall", metavar="TEXT", help="print what CTO would recall for TEXT and exit")
    args = p.parse_args(argv)
    d = ChatDaemon()
    if args.profile:
        print(read_profile(d.cfg.profile_path))
        return 0
    if args.recall:
        for m in d.brain.store.retrieve(args.recall, k=d.cfg.recall_k):
            print(f"{m.score:.3f} [{m.kind} #{m.id} imp {m.importance:.0f}] {m.text.replace(chr(10), ' / ')}")
        return 0
    if args.rate:
        print(f"rated {d.brain.rate_pending(limit=50)} episodes")
        return 0
    if args.dream:
        m = d.brain.dreamer.dream()
        print(f"[{m.meta.get('tone')}] {m.text}\n-> {m.recall}" if m else "no dream")
        return 0
    if args.dreams:
        for m in d.brain.store.all(DREAM):
            print(f"#{m.id} [{m.meta.get('tone')}{' released' if m.meta.get('released') else ''}] from {m.source_ids}: {m.recall}")
        return 0
    if args.beliefs:
        for b in d.brain.store.beliefs():
            print(f"#{b.id} ({b.weight:.0f}{', protected' if b.protected else ''}{f', elaborates #{b.parent_id}' if b.parent_id else ''}) {b.text}")
        return 0
    if args.release_dream:
        d.brain.store.release_dream(args.release_dream)
        print(f"dream #{args.release_dream} released")
        return 0
    if args.reflect:
        for m in d.brain.reflector.reflect():
            print(f"[{m.section}] ({m.importance:.0f}) {m.text}")
        return 0
    if args.check:
        st = d.brain.store
        print(f"db:       {d.cfg.db_path} ({st.count(EPISODE)} episodes, {st.count('reflection')} reflections)")
        print(f"profile:  {d.cfg.profile_path}")
        print(f"persona:  {d.cfg.persona_path}")
        print(f"log:      {d.cfg.log_path}")
        print(f"embedder: {st.embedder.name}")
        print(f"session:  {d.cfg.session_id or '(not inside a Reverie session)'}")
        try:
            out = d.brain.client.chat([{"role": "user", "content": "Say hi in three words."}], max_tokens=12, temperature=0.0)
            print(f"router:   ok ({d.cfg.api_base}, {d.cfg.model}): {out}")
        except LLMError as e:
            print(f"router:   unreachable ({e})")
        return 0
    d.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
