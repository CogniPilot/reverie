import tests  # noqa: F401  isolates CODEMAN_*/FLEET_* before cto is imported
import tempfile
import unittest
from pathlib import Path

from cto.memory import Memory
from cto.persona import (DEFAULT_PERSONA, build_system_prompt, load_persona, normalize_section, read_profile,
                          render_profile, write_profile)


def refl(i, text, imp, section="shared", created=1000.0):
    return Memory(id=i, kind="reflection", created_at=created, user_text="", assistant_text="", text=text,
                  importance=imp, section=section)


class PersonaTest(unittest.TestCase):
    def test_load_persona_default_and_file(self):
        d = Path(tempfile.mkdtemp())
        self.assertEqual(load_persona(d / "missing.txt"), DEFAULT_PERSONA)
        (d / "p.txt").write_text("You are CTO.\n")
        self.assertEqual(load_persona(d / "p.txt"), "You are CTO.")
        (d / "e.txt").write_text("  \n")
        self.assertEqual(load_persona(d / "e.txt"), DEFAULT_PERSONA)

    def test_normalize_section(self):
        self.assertEqual(normalize_section("User"), "user")
        self.assertEqual(normalize_section("myself"), "agent")
        self.assertEqual(normalize_section(None), "shared")
        self.assertEqual(normalize_section("banana"), "shared")

    def test_render_sections_and_order(self):
        text = render_profile([refl(1, "likes coffee", 5, "user"), refl(2, "I tease them", 7, "agent"),
                               refl(3, "we joked about swap", 9, "shared"), refl(4, "hates bugs", 8, "user")])
        self.assertIn("## About the user\n- (8) hates bugs\n- (5) likes coffee", text)
        self.assertIn("## About the agent\n- (7) I tease them", text)
        self.assertIn("## Shared history\n- (9) we joked about swap", text)
        self.assertTrue(text.startswith("# Agent notes"))

    def test_render_bounded_prunes_low_importance_then_oldest(self):
        items = [refl(i, f"insight number {i} " + "x" * 80, imp, "user", created=float(i))
                 for i, imp in enumerate([5, 5, 9, 2, 5, 9, 7, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5])]
        text = render_profile(items, max_chars=600)
        self.assertLessEqual(len(text), 600)
        self.assertIn("insight number 2 ", text)
        self.assertIn("insight number 5 ", text)
        self.assertNotIn("insight number 3 ", text)   # importance 2 goes first
        # among the fives the oldest are dropped first
        self.assertNotIn("insight number 0 ", text)
        self.assertIn("insight number 24 ", text)

    def test_empty_profile(self):
        self.assertEqual(render_profile([]), "# Agent notes\n")

    def test_write_read(self):
        p = Path(tempfile.mkdtemp()) / "profile.md"
        self.assertEqual(read_profile(p), "")
        write_profile(p, "hello\n")
        self.assertEqual(read_profile(p), "hello")
        self.assertFalse(p.with_suffix(".tmp").exists())

    def test_system_prompt(self):
        mems = [refl(1, "User likes rust", 8, "user"),
                Memory(id=2, kind="episode", created_at=0, user_text="hi", assistant_text="hello", text="User: hi\nCTO: hello", importance=3)]
        s = build_system_prompt("PERSONA", "# notes\n- (8) x", mems)
        self.assertTrue(s.startswith("PERSONA"))
        self.assertIn("# notes", s)
        self.assertIn("You concluded earlier: User likes rust", s)
        self.assertIn("- User: hi / CTO: hello", s)
        self.assertTrue(s.rstrip().endswith("- User: hi / CTO: hello"))
        self.assertEqual(build_system_prompt("P", "", []), "P")
        self.assertNotIn("PG-13", DEFAULT_PERSONA)


if __name__ == "__main__":
    unittest.main()

class LegacySectionCompatibility(unittest.TestCase):
    def test_historical_sections_keep_their_meaning(self):
        self.assertEqual(normalize_section("owner"), "user")
        self.assertEqual(normalize_section("assistant"), "agent")

    def test_instance_aliases_come_from_config(self):
        from unittest import mock
        self.assertEqual(normalize_section("alex"), "shared")
        with mock.patch.dict("os.environ", {"FLEET_OWNER_ALIASES": "alex", "FLEET_AGENT_ALIASES": "robin, sam"}):
            self.assertEqual(normalize_section("Alex"), "user")
            self.assertEqual(normalize_section("sam"), "agent")
