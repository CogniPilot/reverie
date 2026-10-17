import tests  # noqa: F401  isolates CODEMAN_*/FLEET_* before cto is imported
import unittest
from cto.backend import argv_for, resolve_session

class BackendTests(unittest.TestCase):
    def test_model_arguments_are_preserved_without_shell_interpolation(self):
        self.assertEqual(argv_for("opencode","local/qwen"), ["opencode","--agent","cto","--model","local/qwen"])
        self.assertEqual(argv_for("codex","configured-model"), ["codex","--model","configured-model"])
        self.assertEqual(argv_for("claude","configured-model"), ["claude","--model","configured-model"])
        with self.assertRaises(ValueError): argv_for("codex","")

    def test_current_session_resolution_is_unique(self):
        self.assertEqual(resolve_session({"sessions":[{"id":"abcd-123"}]},"abcd")["id"],"abcd-123")
        with self.assertRaises(ValueError): resolve_session([{"id":"abcd-1"},{"id":"abcd-2"}],"abcd")
