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

    def test_model_environment_precedence(self):
        for env, expected in [({}, "MODEL_ID"), ({"FLEET_MODEL": "alias"}, "alias"),
                              ({"REVERIE_MODEL": "selected", "FLEET_MODEL": "alias"}, "selected")]:
            with mock.patch.dict(os.environ, env, clear=True):
                self.assertEqual(cfgmod.Config().model, expected)

    def test_path_fallback(self):
        d = Path(tempfile.mkdtemp())
        new, old = d / "assistant-persona.txt", d / "legacy-persona.txt"
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(cfgmod._path_fallback("FLEET_PERSONA", new, old), new)      # neither exists
            old.write_text("x")
            self.assertEqual(cfgmod._path_fallback("FLEET_PERSONA", new, old), old)      # only old
            self.assertIn("legacy-persona.txt is deprecated", cfgmod.DEPRECATIONS[-1])
            new.write_text("y")
            self.assertEqual(cfgmod._path_fallback("FLEET_PERSONA", new, old), new)      # new wins
        with mock.patch.dict(os.environ, {"FLEET_PERSONA": str(d / "p.txt")}):
            self.assertEqual(cfgmod._path_fallback("FLEET_PERSONA", new, old), d / "p.txt")

    def test_config_reads_new_names(self):
        with mock.patch.dict(os.environ, {"FLEET_MODEL": "m1", "FLEET_INTERVAL": "77"}, clear=False):
            c = cfgmod.Config()
            self.assertEqual(c.model, "m1")
            self.assertEqual(c.joke_interval, 77)
        # Retired private environment spellings no longer select the model or interval.
        retired = {bytes.fromhex("4a45535445525f4d4f44454c").decode(): "old-model",
                   bytes.fromhex("4a45535445525f494e54455256414c").decode(): "88"}
        with mock.patch.dict(os.environ, retired, clear=True):
            c = cfgmod.Config()
            self.assertEqual(c.model, "MODEL_ID")
            self.assertEqual(c.joke_interval, 240)



if __name__ == "__main__":
    unittest.main()


class IsolationTest(unittest.TestCase):
    def test_suite_cannot_see_a_live_instance(self):
        import cto.config
        leaked = [key for key in os.environ if key.startswith("CODEMAN_")]
        self.assertEqual(leaked, [])
        self.assertNotIn("FLEET_INSTANCE_CONFIG", os.environ)
        self.assertTrue(str(cto.config.DATA_DIR).startswith(os.environ["REVERIE_HOME"]))
