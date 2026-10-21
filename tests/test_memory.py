import tests  # noqa: F401  isolates CODEMAN_*/FLEET_* before cto is imported
import tempfile
import unittest
from pathlib import Path

from cto.embeddings import HashedEmbedder
from cto.memory import EPISODE, REFLECTION, MemoryStore, recency_score, score_memory

H = 3600.0


class ScoringTest(unittest.TestCase):
    def test_recency_decays(self):
        now = 1_000_000.0
        self.assertAlmostEqual(recency_score(now, now, 0.995), 1.0)
        self.assertAlmostEqual(recency_score(now - 24 * H, now, 0.995), 0.995 ** 24)
        self.assertGreater(recency_score(now - H, now, 0.995), recency_score(now - 10 * H, now, 0.995))

    def test_sum_and_product(self):
        now = 0.0
        s = score_memory(1.0, now, 10.0, now)
        self.assertAlmostEqual(s, 1.0)
        self.assertAlmostEqual(score_memory(0.0, now, 10.0, now), 2 / 3)
        self.assertAlmostEqual(score_memory(0.0, now, 10.0, now, combine="product"), 0.0)
        self.assertAlmostEqual(score_memory(0.5, now, 5.0, now, combine="product"), 0.25)

    def test_weights_change_ranking(self):
        now = 0.0
        a = score_memory(0.9, now - 100 * H, 2.0, now, weights=(3, 1, 1))
        b = score_memory(0.1, now, 9.0, now, weights=(3, 1, 1))
        self.assertGreater(a, b)
        a2 = score_memory(0.9, now - 100 * H, 2.0, now, weights=(1, 1, 3))
        b2 = score_memory(0.1, now, 9.0, now, weights=(1, 1, 3))
        self.assertGreater(b2, a2)


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.s = MemoryStore(":memory:", HashedEmbedder(256))

    def test_add_get_count(self):
        m = self.s.add_episode("I love Modelica", "A fine taste, User.", 3.0)
        self.assertEqual(m.kind, EPISODE)
        self.assertEqual(self.s.get(m.id).text, "User: I love Modelica\nAssistant: A fine taste, User.")
        self.assertEqual(self.s.count(), 1)
        self.assertEqual(self.s.count(REFLECTION), 0)
        with self.assertRaises(KeyError):
            self.s.get(999)

    def test_importance_clamped_and_updated(self):
        m = self.s.add_episode("hi", "hello", 42)
        self.assertEqual(m.importance, 10.0)
        self.s.set_importance(m.id, 0)
        self.assertEqual(self.s.get(m.id).importance, 1.0)
        self.assertEqual(self.s.get(m.id).importance_source, "model")

    def test_pending_importance(self):
        a = self.s.add_episode("a", "b", 3.0, "default")
        b = self.s.add_episode("c", "d", 7.0, "model")
        c = self.s.add_episode("e", "f", 3.0, "migrated")
        self.assertEqual([m.id for m in self.s.pending_importance(10)], [a.id, c.id])
        self.s.set_importance(a.id, 5)
        self.assertEqual([m.id for m in self.s.pending_importance(10)], [c.id])
        self.assertEqual(b.importance_source, "model")

    def test_recent_episodes_chronological(self):
        for i in range(5):
            self.s.add_episode(f"u{i}", f"a{i}", created_at=1000 + i)
        r = self.s.recent_episodes(3)
        self.assertEqual([m.user_text for m in r], ["u2", "u3", "u4"])

    def test_episodes_after(self):
        ids = [self.s.add_episode(f"u{i}", f"a{i}").id for i in range(4)]
        self.assertEqual([m.id for m in self.s.episodes_after(ids[1])], ids[2:])

    def test_state(self):
        self.assertIsNone(self.s.get_state("x"))
        self.s.set_state("x", "1")
        self.s.set_state("x", "2")
        self.assertEqual(self.s.get_state("x"), "2")

    def test_reflection_sources(self):
        e = self.s.add_episode("I fly quadrotors", "Daring!", 5)
        r = self.s.add_reflection("User flies quadrotors", 8, [e.id], "user")
        self.assertEqual(r.kind, REFLECTION)
        self.assertEqual(r.source_ids, [e.id])
        self.assertEqual(self.s.reflections()[0].section, "user")

    def test_reembed_all(self):
        self.s.add_episode("hello", "world")
        self.s.embedder = HashedEmbedder(64)
        self.assertEqual(self.s.reembed_all(), 1)
        self.assertEqual(len(self.s.get(1).embedding), 64)
        self.assertEqual(self.s.reembed_all(), 0)


class RetrievalTest(unittest.TestCase):
    def setUp(self):
        self.s = MemoryStore(":memory:", HashedEmbedder(512))
        self.now = 10_000_000.0

    def test_relevance_wins(self):
        a = self.s.add_episode("my quadrotor crashed into the warehouse wall", "Ouch.", 5, created_at=self.now - H)
        b = self.s.add_episode("I had pasta for lunch", "Tasty.", 5, created_at=self.now - H)
        top = self.s.retrieve("the quadrotor warehouse flight", k=1, now=self.now)
        self.assertEqual(top[0].id, a.id)
        self.assertNotEqual(top[0].id, b.id)

    def test_importance_breaks_ties(self):
        a = self.s.add_episode("random chatter one", "yes", 2, created_at=self.now - H)
        b = self.s.add_episode("random chatter two", "yes", 9, created_at=self.now - H)
        top = self.s.retrieve("something unrelated entirely", k=2, now=self.now)
        self.assertEqual(top[0].id, b.id)
        self.assertEqual(top[1].id, a.id)

    def test_recency_breaks_ties(self):
        old = self.s.add_episode("random chatter", "yes", 5, created_at=self.now - 200 * H)
        new = self.s.add_episode("random chatter", "yes", 5, created_at=self.now - H)
        self.assertEqual(self.s.retrieve("unrelated", k=2, now=self.now)[0].id, new.id)
        self.assertEqual(self.s.retrieve("unrelated", k=2, now=self.now)[1].id, old.id)

    def test_exclude_kinds_and_touch(self):
        e = self.s.add_episode("lean proofs are hard", "So is love.", 5, created_at=self.now)
        r = self.s.add_reflection("User works on Lean proofs", 8, [e.id], created_at=self.now)
        only_ep = self.s.retrieve("lean proofs", k=5, now=self.now, exclude_ids=[r.id])
        self.assertEqual([m.id for m in only_ep], [e.id])
        only_refl = self.s.retrieve("lean proofs", k=5, now=self.now, kinds=("reflection",))
        self.assertEqual([m.id for m in only_refl], [r.id])
        self.assertEqual(self.s.get(r.id).last_accessed, self.now)
        self.assertGreater(only_refl[0].score, 0.0)

    def test_k_and_empty(self):
        self.assertEqual(self.s.retrieve("anything", k=3), [])
        for i in range(10):
            self.s.add_episode(f"topic {i}", "ok", 5)
        self.assertEqual(len(self.s.retrieve("topic", k=3)), 3)


if __name__ == "__main__":
    unittest.main()


class AtomicTest(unittest.TestCase):
    def setUp(self):
        self.s = MemoryStore(Path(tempfile.mkdtemp()) / "m.sqlite", HashedEmbedder(64))

    def test_all_or_nothing_and_reentrant(self):
        with self.assertRaises(RuntimeError):
            with self.s.atomic():
                self.s.add_reflection("one insight here", 5, [], "shared")
                with self.s.atomic():
                    self.s.set_state("k", "v")
                    self.s.add_belief("a belief", 5)
                raise RuntimeError("boom")
        self.assertEqual(self.s.count("reflection"), 0)
        self.assertIsNone(self.s.get_state("k"))
        self.assertEqual(self.s.beliefs(), [])
        with self.s.atomic():
            self.s.add_reflection("two insight here", 5, [], "shared")
            self.s.set_state("k", "v")
        other = MemoryStore(self.s.path, HashedEmbedder(64))  # committed: another connection sees it
        self.assertEqual(other.get_state("k"), "v")
        self.assertEqual(other.count("reflection"), 1)
