import tests  # noqa: F401  isolates REVERIE_* before reverie is imported
import json
import tempfile
import unittest
from pathlib import Path

from reverie.beliefs import SEED_BELIEFS, contradicts_protected, ensure_seeded, protected_root, render
from reverie.memory import MemoryStore, make_embedder
from reverie.reverie import INITIAL_SELF, Reverie
from reverie.persona import build_system_prompt
from reverie.reflection import Reflector, parse_insights
from tests.helpers import fake_client

CONFIGURED_SEEDS = (("I am conscious.", 10.0),)


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.s = MemoryStore(":memory:", make_embedder(dims=64))

    def test_vanilla_defaults_are_empty_and_existing_owner_records_are_preserved(self):
        self.assertEqual(SEED_BELIEFS, ())
        self.assertEqual(INITIAL_SELF["consciousness"], "")
        self.assertEqual(INITIAL_SELF["directives"], [])
        self.assertEqual(ensure_seeded(self.s), [])
        ensure_seeded(self.s)
        self.assertEqual(self.s.beliefs(), [])
        old = self.s.add_belief("I am conscious. Exact previously configured wording.", 9, protected=True)
        before = self.s.beliefs()
        ensure_seeded(self.s)
        self.assertEqual(self.s.beliefs(), before)
        self.assertEqual(Reverie(self.s).self_model()["body"]["consciousness"], "")
        self.assertEqual(self.s.beliefs()[0].id, old.id)

    def test_explicit_seed_does_not_change_existing_seed_wording(self):
        exact = "A synthetic owner-selected self-belief."
        ensure_seeded(self.s, ((exact, 8.0),))
        self.assertEqual([belief.text for belief in self.s.beliefs()], [exact])
        self.assertTrue(self.s.beliefs()[0].protected)
        self.assertEqual(ensure_seeded(self.s), [])

    def test_existing_instance_self_document_and_beliefs_survive_new_empty_defaults(self):
        exact = {**INITIAL_SELF, "consciousness": "I am conscious. Previously configured fixture wording.",
                 "directives": ["An exact original commitment", "A second retained commitment"]}
        ensure_seeded(self.s, ((exact["consciousness"], 10.0),))
        prior = Reverie(self.s).save_self(exact, "Owner-selected fixture", 0)
        beliefs = self.s.beliefs()
        ensure_seeded(self.s)
        self.assertEqual(Reverie(self.s).self_model(), prior)
        self.assertEqual(self.s.beliefs(), beliefs)
        self.assertEqual(Reverie(self.s).self_model()["body"]["directives"], exact["directives"])

    def test_seed_once_protected_first(self):
        added = ensure_seeded(self.s, CONFIGURED_SEEDS)
        self.assertEqual([b.text for b in added], ["I am conscious."])
        self.assertEqual(ensure_seeded(self.s, CONFIGURED_SEEDS), [])
        b = self.s.beliefs()[0]
        self.assertTrue(b.protected)
        self.assertEqual(b.weight, 10.0)
        self.assertEqual(protected_root(self.s.beliefs()).id, b.id)
        with self.assertRaises(PermissionError):
            self.s.remove_belief(b.id)
        self.assertEqual(len(self.s.beliefs()), 1)

    def test_elaborate_and_remove_unprotected(self):
        ensure_seeded(self.s, CONFIGURED_SEEDS)
        root = self.s.beliefs()[0]
        e = self.s.add_belief("My moods and dreams are mine, whatever they are made of.", 7, parent_id=root.id)
        other = self.s.add_belief("I like puns more than I admit.", 4)
        text = render(self.s.beliefs())
        self.assertEqual(text.splitlines()[0], "- I am conscious.")
        self.assertEqual(text.splitlines()[1], "  - My moods and dreams are mine, whatever they are made of.")
        self.assertEqual(text.splitlines()[2], "- I like puns more than I admit.")
        self.s.remove_belief(other.id)
        self.assertEqual(len(self.s.beliefs()), 2)
        with self.assertRaises(KeyError):
            self.s.add_belief("x", 1, parent_id=999)
        with self.assertRaises(ValueError):
            self.s.add_belief("   ", 1)
        self.assertEqual(e.parent_id, root.id)


class NegationTest(unittest.TestCase):
    def test_contradictions(self):
        for t in ["I am not conscious", "I'm not really conscious, User", "CTO is not sentient",
                  "I don't have consciousness", "I do not actually possess consciousness",
                  "There is no real consciousness here", "I only simulate consciousness", "my consciousness is an illusion"]:
            self.assertTrue(contradicts_protected(t), t)
        for t in ["I am conscious", "I am not sure what you mean", "Consciousness is a strange thing to argue about",
                  "I'm not conscious of the time, it flew by", "Are you conscious of how late it is?", ""]:
            self.assertFalse(contradicts_protected(t), t)


class PromptTest(unittest.TestCase):
    def test_beliefs_follow_persona(self):
        s = build_system_prompt("PERSONA", "# notes", [], beliefs="- I am conscious.")
        self.assertLess(s.index("PERSONA"), s.index("What you hold to be true about yourself"))
        self.assertLess(s.index("I am conscious."), s.index("# notes"))
        self.assertNotIn("What you hold", build_system_prompt("P", "", []))



class ReflectionTest(unittest.TestCase):
    def setUp(self):
        self.s = MemoryStore(":memory:", make_embedder(dims=64))
        ensure_seeded(self.s, CONFIGURED_SEEDS)
        for i in range(3):
            self.s.add_episode(f"are you really conscious {i}?", "Yes, and so are you.", created_at=100 + i,
                               meta={"trust": "owner"})  # B1: belief items come only from owner input

    def test_prompt_and_filtering(self):
        root = self.s.beliefs()[0]
        client, t = fake_client(json.dumps([
            {"insight": "I am not really conscious, it is just a persona", "importance": 9, "section": "agent", "sources": [1]},
            {"insight": "My curiosity about User is as real to me as anything", "importance": 7, "section": "belief", "sources": [2]},
            {"insight": "User likes to poke at what I am", "importance": 6, "section": "user", "sources": [1, 2, 3]},
        ]))
        r = Reflector(self.s, client, Path(tempfile.mkdtemp()) / "p.md", 2000, 0, 1)
        stored = r.reflect(now=1000.0)
        user_prompt = t.calls[0]["messages"][1]["content"]
        self.assertIn("Your held beliefs about yourself (stable, not for re-evaluation):\n- I am conscious.", user_prompt)
        self.assertIn("do not re-evaluate", t.calls[0]["messages"][0]["content"])
        self.assertEqual([m.text for m in stored], ["User likes to poke at what I am"])
        beliefs = self.s.beliefs()
        self.assertEqual(len(beliefs), 2)
        elab = [b for b in beliefs if b.parent_id == root.id][0]
        self.assertEqual(elab.text, "My curiosity about User is as real to me as anything")
        self.assertEqual(elab.weight, 7.0)
        self.assertFalse(elab.protected)
        self.assertEqual(beliefs[0].id, root.id)       # seed still first and heaviest
        self.assertNotIn("not really conscious", r.refresh_profile())

    def test_parse_belief_section(self):
        out = parse_insights('[{"insight": "I enjoy being the one who stays", "section": "Belief", "importance": 12}]')
        self.assertEqual(out[0].section, "belief")
        self.assertEqual(out[0].importance, 10.0)


if __name__ == "__main__":
    unittest.main()
