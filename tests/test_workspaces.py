import tests  # noqa: F401  isolates REVERIE_* before reverie is imported
from pathlib import Path
import tempfile
import unittest
from reverie.workspaces import Workspaces

class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.manager = Workspaces(self.root/"owned")

    def test_cleanup_requires_handoff_and_preserves_active_and_unrelated_data(self):
        path = self.manager.create("completed")
        (path/"build-output").write_text("disposable")
        other = self.root/"private-memory"; other.write_text("keep")
        (path/"external-link").symlink_to(other)
        with self.assertRaises(ValueError): self.manager.clean("completed", True)
        self.manager.finish("completed", "Verified project handoff #42")
        with self.manager.lease("completed"):
            with self.assertRaises(BlockingIOError): self.manager.clean("completed", True)
        self.assertFalse(self.manager.clean("completed")["removed"])
        self.assertTrue(path.exists())
        self.assertTrue(self.manager.clean("completed", True)["removed"])
        self.assertEqual(other.read_text(), "keep")

    def test_source_unowned_paths_and_symlink_roots_are_preserved(self):
        task = self.manager.create("source")
        (task/".git").mkdir()
        self.manager.finish("source", "handoff")
        with self.assertRaises(ValueError): self.manager.clean("source", True)
        with self.assertRaises(ValueError): self.manager.path("../elsewhere")
        (self.manager.root/"linked").symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(ValueError): self.manager.path("linked")
        with self.assertRaises(ValueError): Workspaces(self.root)
