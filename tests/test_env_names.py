import io
import unittest
from contextlib import redirect_stderr

from cto import env_names


class EnvNamesTest(unittest.TestCase):
    def setUp(self):
        env_names._reported.clear()

    def test_new_name_wins_over_the_old_spelling(self):
        env = {"REVERIE_MODEL": "new", "FLEET_MODEL": "old"}
        self.assertEqual(env_names.get("MODEL", env=env), "new")
        self.assertEqual(env_names.lookup("REVERIE_MODEL", env=env), "new")

    def test_old_spelling_is_read_and_reported_once(self):
        err = io.StringIO()
        with redirect_stderr(err):
            self.assertEqual(env_names.get("MODEL", env={"FLEET_MODEL": "old"}), "old")
            self.assertEqual(env_names.get("MODEL", env={"FLEET_MODEL": "old"}), "old")
        self.assertEqual(err.getvalue().count("FLEET_MODEL is deprecated; use REVERIE_MODEL"), 1)

    def test_empty_values_fall_through_to_the_default(self):
        self.assertEqual(env_names.get("MODEL", "d", env={"REVERIE_MODEL": "", "FLEET_MODEL": ""}), "d")
        self.assertFalse(env_names.is_set("MODEL", env={}))

    def test_require_accepts_either_spelling_and_raises_when_neither(self):
        with redirect_stderr(io.StringIO()):
            self.assertEqual(env_names.require("REVERIE_INSTANCE_CONFIG", env={"FLEET_INSTANCE_CONFIG": "/i"}), "/i")
        with self.assertRaises(KeyError):
            env_names.require("REVERIE_INSTANCE_CONFIG", env={})

    def test_children_get_both_names(self):
        env = env_names.child_env({"PATH": "/bin"}, INSTANCE_CONFIG="/i")
        self.assertEqual(env, {"PATH": "/bin", "REVERIE_INSTANCE_CONFIG": "/i", "FLEET_INSTANCE_CONFIG": "/i"})


if __name__ == "__main__":
    unittest.main()
