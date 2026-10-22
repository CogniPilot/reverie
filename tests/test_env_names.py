import unittest
from reverie import env_names

class EnvNamesTest(unittest.TestCase):
    def test_settings(self):
        self.assertEqual(env_names.get("MODEL", env={"REVERIE_MODEL": "local"}), "local")
        self.assertEqual(env_names.get("MODEL", "default", env={"REVERIE_MODEL": ""}), "default")
        self.assertFalse(env_names.is_set("MODEL", env={}))
        with self.assertRaises(KeyError):
            env_names.require("REVERIE_MODEL", env={})

    def test_children_receive_settings(self):
        self.assertEqual(env_names.child_env({"PATH": "/bin"}, MODEL="local"),
                         {"PATH": "/bin", "REVERIE_MODEL": "local"})
