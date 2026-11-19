import tests  # noqa: F401  isolates REVERIE_* before reverie is imported
import json
import tempfile
import unittest
from pathlib import Path

from reverie.memory import DREAM, MemoryStore, make_embedder
from reverie.persona import build_system_prompt
from reverie.reflection import Reflector
from tests.helpers import fake_client

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


class NoFactsRuleTest(unittest.TestCase):
    def setUp(self):
        self.s = MemoryStore(":memory:", make_embedder(dims=64))
        fill(self.s, 3, 3)
        self.d = self.s.add_dream("I dream that User owns a castle made of compilers and I am its moat.",
                                  "I dreamed User owned a castle", "strange", [1, 2], importance=10, created_at=NOW - 10)

    def test_release_flag_stays_in_existing_dream_metadata(self):
        self.assertFalse(self.d.meta["released"])
        self.s.release_dream(self.d.id)
        self.assertTrue(self.s.get(self.d.id).meta["released"])
        self.assertEqual(self.s.get(self.d.id).recall, self.d.recall)
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
