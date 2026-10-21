import tests  # noqa: F401  isolates CODEMAN_*/FLEET_* before cto is imported
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from cto import config as cfgmod


class FallbackTest(unittest.TestCase):
    def setUp(self):
        cfgmod.DEPRECATIONS.clear()

    def test_env_fallback(self):
        with mock.patch.dict(os.environ, {"JESTER_MODEL": "old-model"}, clear=False):
            os.environ.pop("REVERIE_MODEL", None)
            os.environ.pop("FLEET_MODEL", None)
            self.assertEqual(cfgmod._env_fallback("REVERIE_MODEL", "JESTER_MODEL", "d"), "old-model")
            self.assertEqual(cfgmod.DEPRECATIONS, ["JESTER_MODEL is deprecated, use REVERIE_MODEL"])
        with mock.patch.dict(os.environ, {"REVERIE_MODEL": "new", "JESTER_MODEL": "old"}):
            cfgmod.DEPRECATIONS.clear()
            self.assertEqual(cfgmod._env_fallback("REVERIE_MODEL", "JESTER_MODEL", "d"), "new")
            self.assertEqual(cfgmod.DEPRECATIONS, [])
        with mock.patch.dict(os.environ, {"FLEET_MODEL": "older-spelling"}, clear=True):
            self.assertEqual(cfgmod._env_fallback("REVERIE_MODEL", "JESTER_MODEL", "d"), "older-spelling")
        with mock.patch.dict(os.environ, {"REVERIE_MODEL": "new", "FLEET_MODEL": "older-spelling"}, clear=True):
            self.assertEqual(cfgmod._env_fallback("REVERIE_MODEL", "JESTER_MODEL", "d"), "new")
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(cfgmod._env_fallback("REVERIE_MODEL", "JESTER_MODEL", "d"), "d")

    def test_path_fallback(self):
        d = Path(tempfile.mkdtemp())
        new, old = d / "assistant-persona.txt", d / "jester-persona.txt"
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(cfgmod._path_fallback("FLEET_PERSONA", new, old), new)      # neither exists
            old.write_text("x")
            self.assertEqual(cfgmod._path_fallback("FLEET_PERSONA", new, old), old)      # only old
            self.assertIn("jester-persona.txt is deprecated", cfgmod.DEPRECATIONS[-1])
            new.write_text("y")
            self.assertEqual(cfgmod._path_fallback("FLEET_PERSONA", new, old), new)      # new wins
        with mock.patch.dict(os.environ, {"FLEET_PERSONA": str(d / "p.txt")}):
            self.assertEqual(cfgmod._path_fallback("FLEET_PERSONA", new, old), d / "p.txt")

    def test_config_reads_new_names(self):
        with mock.patch.dict(os.environ, {"FLEET_MODEL": "m1", "FLEET_INTERVAL": "77"}, clear=False):
            c = cfgmod.Config()
            self.assertEqual(c.model, "m1")
            self.assertEqual(c.joke_interval, 77)
        with mock.patch.dict(os.environ, {"JESTER_INTERVAL": "88"}, clear=False):
            os.environ.pop("FLEET_INTERVAL", None)
            cfgmod.DEPRECATIONS.clear()
            c = cfgmod.Config()
            self.assertEqual(c.joke_interval, 88)
            self.assertTrue(any("JESTER_INTERVAL" in x for x in c.deprecations()))


if __name__ == "__main__":
    unittest.main()


class IsolationTest(unittest.TestCase):
    def test_suite_cannot_see_a_live_instance(self):
        import cto.config
        leaked = [key for key in os.environ if key.startswith("CODEMAN_")]
        self.assertEqual(leaked, [])
        self.assertNotIn("FLEET_INSTANCE_CONFIG", os.environ)
        self.assertTrue(str(cto.config.DATA_DIR).startswith(os.environ["REVERIE_HOME"]))
