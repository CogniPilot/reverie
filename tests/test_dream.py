import tests  # noqa: F401  isolates REVERIE_* before reverie is imported
import json
import tempfile
import unittest
from pathlib import Path

from reverie.chat import Dreamer
from reverie.memory import DREAM, MemoryStore, make_embedder
from reverie.persona import build_system_prompt
from reverie.reflection import Reflector
from tests.helpers import fake_client, output_policy_terms, synthetic_output_policy

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


class DreamerTest(unittest.TestCase):
    def setUp(self):
        self.s = MemoryStore(":memory:", make_embedder(dims=64))
        fill(self.s)
        self.resp = json.dumps({"dream": "The scratch drive fills with warm sand and User laughs from somewhere above the build logs.",
                                "recall": "I dreamed the scratch drive turned into a beach", "tone": "playful",
                                "ideas": [{"hypothesis": "Fast builds need fewer writes", "check": "Measure writes"}]})

    def dreamer(self, responder="good", **kw):
        client, t = fake_client(self.resp if responder == "good" else responder)
        return Dreamer(self.s, client, sleep_min_idle=1800, per_sleep=1, spacing=3600, **kw), t

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
        from reverie.chat import main

        dreamer, transport = self.dreamer()
        dreamer.per_sleep = 0
        daemon = SimpleNamespace(brain=SimpleNamespace(dreamer=dreamer))
        with patch('reverie.chat.ChatDaemon', return_value=daemon), patch('reverie.chat.time.time', return_value=NOW), redirect_stdout(io.StringIO()):
            self.assertEqual(main(['--dream']), 0)
        self.assertEqual(len(transport.calls), 1)
        self.assertEqual(self.s.count(DREAM), 1)

    def test_dream_stores_and_nudges_mood(self):
        d, t = self.dreamer()
        self.s.set_state("mood", json.dumps({"valence": "0.6", "arousal": "0.25", "updated_at": NOW}))
        m = d.dream(now=NOW)
        self.assertEqual(m.kind, DREAM)
        self.assertEqual(m.meta["tone"], "playful")
        self.assertFalse(m.meta["released"])
        self.assertTrue(m.recall.startswith("I dreamed"))
        self.assertIn("Unverified dream hypothesis: Fast builds need fewer writes Check before using: Measure writes",
                      m.waking_recall())
        self.assertGreaterEqual(len(m.source_ids), 4)
        prompt = t.calls[0]["messages"][1]["content"]
        self.assertIn("fell asleep feeling bright and happy.", prompt)
        self.assertIn(f"[{m.source_ids[0]}]", prompt)
        self.assertEqual(json.loads(self.s.get_state("mood")), {"valence": 0.7, "arousal": 0.35, "updated_at": NOW})
        self.assertEqual(self.s.latest_dream().id, m.id)
        # quota: one per sleep window, spaced
        self.assertFalse(d.due(last_activity=NOW - 2000, now=NOW + 10))         # quota for this sleep window used
        self.assertFalse(d.due(last_activity=NOW + 5, now=NOW + 5 + 2000))      # new window, but spacing (3600) not elapsed
        self.assertTrue(d.due(last_activity=NOW + 5, now=NOW + 5000))           # new window, idle and spaced

    @synthetic_output_policy()
    def test_dream_rejects_denied_output_before_writing(self):
        first_marker, second_marker = output_policy_terms()
        dreamer, _ = self.dreamer(json.dumps({
            "dream": f"{first_marker} and {second_marker} appear in a dream", "recall": "a short recall",
        }))
        self.assertIsNone(dreamer.dream(now=NOW))
        self.assertEqual(self.s.count(DREAM), 0)
        self.assertIsNone(self.s.get_state("mood"))

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
