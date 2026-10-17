import tests  # noqa: F401  isolates CODEMAN_*/FLEET_* before cto is imported
import json
import tempfile
import unittest
from pathlib import Path

from cto.embeddings import HashedEmbedder
from cto.importance import parse_rating, rate_episode
from cto.memory import MemoryStore
from cto.reflection import Reflector, parse_insights
from tests.helpers import fake_client


class ParseTest(unittest.TestCase):
    def test_parse_rating(self):
        self.assertEqual(parse_rating("7"), 7.0)
        self.assertEqual(parse_rating("I would say 10 out of 10"), 10.0)
        self.assertEqual(parse_rating("Importance: 3."), 3.0)
        self.assertEqual(parse_rating("none"), 3.0)
        self.assertEqual(parse_rating("", default=5.0), 5.0)
        self.assertEqual(parse_rating("42"), 3.0)

    def test_parse_insights_tolerates_noise(self):
        raw = 'Sure! Here you go:\n[{"insight": "User builds **compiler**", "importance": 12, "section": "User", "sources": [1, "2", "x", 9]},' \
              ' {"insight": "short"}, "junk", {"insight": "We joke about swap space constantly", "importance": "6", "section": "nothing"}]\nDone.'
        out = parse_insights(raw, valid_ids=[1, 2, 3])
        self.assertEqual(len(out), 2)
        self.assertEqual(out[0].insight, "User builds compiler")
        self.assertEqual(out[0].importance, 10.0)
        self.assertEqual(out[0].section, "user")
        self.assertEqual(out[0].sources, [1, 2])
        self.assertEqual(out[1].section, "shared")
        self.assertEqual(out[1].importance, 6.0)

    def test_parse_insights_bad(self):
        self.assertEqual(parse_insights("no json"), [])
        self.assertEqual(parse_insights("[1, 2"), [])
        self.assertEqual(parse_insights('{"insight": "x"}'), [])
        self.assertEqual(len(parse_insights(json.dumps([{"insight": f"insight {i} is long enough"} for i in range(9)]))), 5)


class CleanTest(unittest.TestCase):
    def test_limit_words(self):
        from cto.llm import limit_words
        self.assertEqual(limit_words("one two three", 5), "one two three")
        self.assertEqual(limit_words("a b c. d e f g", 4), "a b c.")
        self.assertEqual(limit_words("a b c d e f g", 4), "a b c d")
        self.assertEqual(limit_words("a b c d e f g", 0), "a b c d e f g")
        self.assertEqual(limit_words("a! b c d e f", 4), "a!")
        self.assertEqual(limit_words("so true!\" she said and then more words here", 3), "so true!\"")


class RateTest(unittest.TestCase):
    def test_rate_episode(self):
        s = MemoryStore(":memory:", HashedEmbedder(64))
        m = s.add_episode("I got the Lean proof through", "Knew you would.")
        client, t = fake_client("8")
        self.assertEqual(rate_episode(client, m), 8.0)
        self.assertEqual(t.calls[0]["max_tokens"], 8)
        self.assertIn("Lean proof", t.calls[0]["messages"][1]["content"])
        bad, _ = fake_client(None)
        self.assertEqual(rate_episode(bad, m, default=4.0), 4.0)


class ReflectorTest(unittest.TestCase):
    def setUp(self):
        self.s = MemoryStore(":memory:", HashedEmbedder(64))
        self.profile = Path(tempfile.mkdtemp()) / "profile.md"

    def reflector(self, responder, interval=1800, min_eps=3):
        client, t = fake_client(responder)
        return Reflector(self.s, client, self.profile, 2000, interval, min_eps), t

    def test_not_due_without_episodes(self):
        r, _ = self.reflector("[]")
        self.assertFalse(r.due(now=1e9))
        self.s.add_episode("a", "b")
        self.assertFalse(r.due(now=1e9))

    def test_reflect_stores_and_updates_profile(self):
        ids = [self.s.add_episode(f"I work on compiler part {i}", "Nice.", created_at=100 + i).id for i in range(3)]
        self.s.add_episode("(idle moment; a joke was requested)", "ha", meta={"idle": True})
        resp = json.dumps([
            {"insight": "User works on a Modelica compiler called compiler", "importance": 9, "section": "user", "sources": ids[:2]},
            {"insight": "I like teasing him about build times", "importance": 6, "section": "agent", "sources": [ids[2]]},
        ])
        r, t = self.reflector(resp)
        self.assertTrue(r.due(now=1e9))
        stored = r.reflect(now=1e9)
        self.assertEqual(len(stored), 2)
        self.assertEqual(stored[0].source_ids, ids[:2])
        self.assertEqual(r.last_reflected_id(), ids[-1] + 0 if False else max(m.id for m in self.s.episodes_after(0) if not m.is_idle))
        self.assertEqual(r.last_reflection_at(), 1e9)
        prompt = t.calls[0]["messages"][1]["content"]
        self.assertIn(f"[{ids[0]}]", prompt)
        self.assertNotIn("idle moment", prompt)
        text = self.profile.read_text()
        self.assertIn("## About the user\n- (9) User works on a Modelica compiler called compiler", text)
        self.assertIn("## About the agent\n- (6) I like teasing", text)
        self.assertFalse(r.due(now=1e9 + 10))        # interval not elapsed
        self.assertFalse(r.due(now=1e9 + 4000))      # nothing new
        self.assertEqual(r.pending(), [])

    def test_reflect_survives_bad_api(self):
        for i in range(3):
            self.s.add_episode(f"x{i}", "y")
        r, _ = self.reflector(None)
        self.assertEqual(r.reflect(now=5.0), [])
        self.assertEqual(r.last_reflection_at(), 5.0)
        self.assertEqual(self.s.count("reflection"), 0)
        self.assertEqual(len(r.pending()), 3)         # retried next time


if __name__ == "__main__":
    unittest.main()
