import tests  # noqa: F401  isolates CODEMAN_*/FLEET_* before cto is imported
import json
import random
import tempfile
import unittest
from pathlib import Path

from cto.dream import DREAM_SYSTEM, Dreamer, parse_dream, sample_episodes
from cto.embeddings import HashedEmbedder
from cto.memory import DREAM, MemoryStore
from cto.mood import Mood, load_mood, save_mood
from cto.persona import build_system_prompt
from cto.reflection import Reflector
from cto.train.config import TrainConfig
from cto.train.dataset import build_examples
from tests.helpers import fake_client, safety_floor_terms, synthetic_safety_lexicon

H = 3600.0
NOW = 1_000_000.0


def fill(store, n_recent=10, n_old=10):
    ids = {"recent": [], "old": []}
    for i in range(n_recent):
        imp = 9 if i == n_recent - 1 else 2
        ids["recent"].append(store.add_episode(f"recent {i}", "ok", imp, created_at=NOW - i * H).id)
    for i in range(n_old):
        ids["old"].append(store.add_episode(f"old {i}", "ok", 5, created_at=NOW - (100 + i) * H).id)
    store.add_episode("(idle moment; a joke was requested)", "ha", 2, meta={"idle": True}, created_at=NOW)
    return ids


class SamplingTest(unittest.TestCase):
    def setUp(self):
        self.s = MemoryStore(":memory:", HashedEmbedder(64))
        self.ids = fill(self.s)

    def test_counts_and_mix(self):
        eps = self.s.all("episode")
        for seed in range(5):
            chosen = sample_episodes(eps, random.Random(seed), NOW, n_recent=4, n_old=1)
            self.assertEqual(len(chosen), 5)
            self.assertEqual(len({m.id for m in chosen}), 5)
            self.assertFalse(any(m.is_idle for m in chosen))
            old = [m for m in chosen if m.id in self.ids["old"]]
            self.assertGreaterEqual(len(old), 1)
            self.assertEqual([m.created_at for m in chosen], sorted(m.created_at for m in chosen))
        self.assertEqual(len(sample_episodes(eps, random.Random(0), NOW, n_recent=9, n_old=9)), 8)   # clamped to 6 + 2
        self.assertEqual(len(sample_episodes(eps, random.Random(0), NOW, n_recent=1, n_old=0)), 4)   # clamped to 3 + 1

    def test_weighted_toward_recent_and_important(self):
        eps = self.s.all("episode")
        hits = {"important": 0, "newest": 0, "stale": 0}
        important = self.ids["recent"][-1]        # 9 hours old, importance 9
        newest = self.ids["recent"][0]
        stale = self.ids["recent"][5]             # 5 hours old, importance 2
        for seed in range(200):
            chosen = {m.id for m in sample_episodes(eps, random.Random(seed), NOW)}
            hits["important"] += important in chosen
            hits["newest"] += newest in chosen
            hits["stale"] += stale in chosen
        self.assertGreater(hits["important"], hits["stale"])
        self.assertGreater(hits["newest"], hits["stale"])

    def test_empty(self):
        self.assertEqual(sample_episodes([], random.Random(0), NOW), [])


class ParseTest(unittest.TestCase):
    def test_default_prompt_is_family_friendly(self):
        self.assertIn("family-friendly and suitable for a general audience", DREAM_SYSTEM)

    @synthetic_safety_lexicon()
    def test_parse_json_and_fallbacks(self):
        d = parse_dream('{"dream": "I float over the warehouse while the quadrotor hums a lullaby.", "recall": "I dreamed the quadrotor sang to me", "tone": "warm"}')
        self.assertEqual(d.tone, "warm")
        self.assertTrue(d.recall.startswith("I dreamed"))
        d2 = parse_dream("just prose about the lean proofs turning into staircases that never end")
        self.assertEqual(d2.tone, "strange")
        self.assertTrue(d2.recall.startswith("I dreamed"))
        d3 = parse_dream('{"dream": "a long enough dream about swap space", "recall": "the swap drive overflowed", "tone": "weird"}')
        self.assertEqual(d3.tone, "strange")
        self.assertEqual(d3.recall, "I dreamed the swap drive overflowed")
        self.assertIsNone(parse_dream("short"))
        self.assertIsNotNone(parse_dream('{"dream": "a pleasantly long dream about an ordinary walk", "recall": "x"}'))
        age_term, explicit_term = safety_floor_terms()
        self.assertIsNone(parse_dream(json.dumps({"dream": f"{age_term} and {explicit_term} appear as markers", "recall": "x"})))


class MoodTest(unittest.TestCase):
    def test_decay_and_nudge(self):
        m = Mood(0.9, 0.9, updated_at=NOW)
        m.decay(NOW + 6 * H)
        self.assertAlmostEqual(m.valence, 0.2 + 0.7 / 2, places=6)
        self.assertAlmostEqual(m.arousal, 0.45, places=6)
        m.nudge_tone("anxious", 1.0, now=NOW + 6 * H)
        self.assertAlmostEqual(m.valence, 0.55 - 0.15, places=6)
        m.nudge(5, 5, now=NOW + 6 * H)
        self.assertEqual((m.valence, m.arousal), (1.0, 1.0))
        self.assertEqual(Mood(0.9, 0.5).describe(), "bright and happy")
        self.assertEqual(Mood(-0.9, -0.5).describe(), "low and tired")
        self.assertEqual(Mood().describe(), "content and easy")

    def test_persist(self):
        s = MemoryStore(":memory:", HashedEmbedder(64))
        self.assertEqual(load_mood(s, NOW).valence, 0.2)
        save_mood(s, Mood(-0.5, 0.0, NOW))
        self.assertAlmostEqual(load_mood(s, NOW).valence, -0.5)
        self.assertEqual(Mood.loads("garbage").valence, 0.2)


class DreamerTest(unittest.TestCase):
    def setUp(self):
        self.s = MemoryStore(":memory:", HashedEmbedder(64))
        fill(self.s)
        self.resp = json.dumps({"dream": "The scratch drive fills with warm sand and User laughs from somewhere above the build logs.",
                                "recall": "I dreamed the scratch drive turned into a beach", "tone": "playful"})

    def dreamer(self, responder="good", **kw):
        client, t = fake_client(self.resp if responder == "good" else responder)
        return Dreamer(self.s, client, sleep_min_idle=1800, per_sleep=1, spacing=3600, rng=random.Random(1), **kw), t

    def test_due_only_in_sleep_window(self):
        d, _ = self.dreamer()
        self.assertFalse(d.due(last_activity=NOW - 100, now=NOW))
        self.assertTrue(d.due(last_activity=NOW - 2000, now=NOW))
        d.per_sleep = 0
        self.assertFalse(d.due(last_activity=NOW - 2000, now=NOW))

    def test_explicit_dream_cli_bypasses_background_opt_out(self):
        import io
        from contextlib import redirect_stdout
        from types import SimpleNamespace
        from unittest.mock import patch
        from cto.chat import main

        dreamer, transport = self.dreamer()
        dreamer.per_sleep = 0
        daemon = SimpleNamespace(brain=SimpleNamespace(dreamer=dreamer))
        with patch('cto.chat.ChatDaemon', return_value=daemon), patch('cto.dream.time.time', return_value=NOW), redirect_stdout(io.StringIO()):
            self.assertEqual(main(['--dream']), 0)
        self.assertEqual(len(transport.calls), 1)
        self.assertEqual(self.s.count(DREAM), 1)

    def test_dream_stores_and_nudges_mood(self):
        d, t = self.dreamer()
        before = load_mood(self.s, NOW)
        m = d.dream(now=NOW)
        self.assertEqual(m.kind, DREAM)
        self.assertEqual(m.meta["tone"], "playful")
        self.assertFalse(m.meta["released"])
        self.assertTrue(m.recall.startswith("I dreamed"))
        self.assertGreaterEqual(len(m.source_ids), 4)
        prompt = t.calls[0]["messages"][1]["content"]
        self.assertIn("fell asleep feeling", prompt)
        self.assertIn(f"[{m.source_ids[0]}]", prompt)
        after = load_mood(self.s, NOW)
        self.assertGreater(after.valence, before.valence)
        self.assertEqual(self.s.latest_dream().id, m.id)
        # quota: one per sleep window, spaced
        self.assertFalse(d.due(last_activity=NOW - 2000, now=NOW + 10))         # quota for this sleep window used
        self.assertFalse(d.due(last_activity=NOW + 5, now=NOW + 5 + 2000))      # new window, but spacing (3600) not elapsed
        self.assertTrue(d.due(last_activity=NOW + 5, now=NOW + 5000))           # new window, idle and spaced

    def test_dream_survives_bad_api(self):
        d, _ = self.dreamer(responder=None)
        self.assertIsNone(d.dream(now=NOW))
        self.assertEqual(self.s.count(DREAM), 0)
        self.assertEqual(d.last_dream_at(), NOW)

    def test_retrieval_and_prompt_mark_dreams_as_dreams(self):
        d, _ = self.dreamer()
        m = d.dream(now=NOW)
        hits = self.s.retrieve("the scratch drive and the beach", k=3, now=NOW)
        self.assertIn(m.id, [h.id for h in hits])
        text = build_system_prompt("P", "", [m], mood="playful", last_dream=m.recall)
        self.assertIn("A dream you had (not something that happened): I dreamed", text)
        self.assertIn("Right now you feel playful.", text)
        self.assertIn("While you slept you had a dream", text)
        self.assertNotIn("Right now", build_system_prompt("P", "", []))


class NoFactsRuleTest(unittest.TestCase):
    def setUp(self):
        self.s = MemoryStore(":memory:", HashedEmbedder(64))
        fill(self.s, 3, 3)
        self.d = self.s.add_dream("I dream that User owns a castle made of compilers and I am its moat.",
                                  "I dreamed User owned a castle", "strange", [1, 2], importance=10, created_at=NOW - 10)

    def test_dataset_excludes_dreams_unless_released_and_then_style_only(self):
        cfg = TrainConfig(min_importance=1, recent_days=1)
        recent, older = build_examples(self.s, "SYS", cfg, NOW)
        self.assertFalse(any(x["kind"] == DREAM for x in recent + older))
        cfg.include_dreams = True
        recent, older = build_examples(self.s, "SYS", cfg, NOW)
        self.assertFalse(any(x["kind"] == DREAM for x in recent + older))          # not released
        self.s.release_dream(self.d.id)
        recent, older = build_examples(self.s, "SYS", cfg, NOW)
        dreams = [x for x in recent + older if x["kind"] == DREAM]
        self.assertEqual(len(dreams), 1)
        self.assertEqual(dreams[0]["weight"], 0.1)
        self.assertEqual(dreams[0]["messages"][1]["content"], "Tell me about a dream you had.")
        with self.assertRaises(ValueError):
            self.s.release_dream(1)

    def test_reflection_labels_dreams_and_rejects_them_as_sources(self):
        client, t = fake_client(json.dumps([
            {"insight": "User seems to carry a lot about their builds", "importance": 3, "section": "shared", "sources": [1, self.d.id]},
        ]))
        r = Reflector(self.s, client, Path(tempfile.mkdtemp()) / "p.md", 2000, 0, 1)
        stored = r.reflect(now=NOW)
        prompt = t.calls[0]["messages"][1]["content"]
        self.assertIn("Recent dreams (not events, low weight)", prompt)
        self.assertIn("I dreamed User owned a castle", prompt)
        self.assertIn("never a fact about the owner", t.calls[0]["messages"][0]["content"])
        self.assertEqual(stored[0].source_ids, [1])      # the dream id is not a valid source
        # the dream's own text never appears in the profile
        self.assertNotIn("castle", r.refresh_profile())

    def test_dream_not_in_reflection_pending(self):
        client, _ = fake_client("[]")
        r = Reflector(self.s, client, Path(tempfile.mkdtemp()) / "p.md")
        self.assertFalse(any(m.kind == DREAM for m in r.pending()))


if __name__ == "__main__":
    unittest.main()
