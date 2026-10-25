import tests  # noqa: F401  isolates REVERIE_* before reverie is imported
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from reverie.workspaces import Workspaces

class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        leases = self.root/"leases"; leases.mkdir(mode=0o700)  # private lease dir; never the real one
        env = patch.dict(os.environ, {"REVERIE_LEASE_DIR": str(leases)}); env.start(); self.addCleanup(env.stop)
        self.manager = Workspaces(self.root/"owned")

    def test_cleanup_requires_handoff_and_preserves_active_and_unrelated_data(self):
        path = self.manager.create("completed")
        (path/"build-output").write_text("disposable")
        other = self.root/"private-memory"; other.write_text("keep")
        (path/"external-link").symlink_to(other)
        with self.assertRaises(ValueError): self.manager.clean("completed", True)
        self.manager.finish("completed", "Verified project handoff #42")
        # r4 API: operation() is the per-workspace mutex; lease.hold() is the real lease that the janitor respects.
        with self.manager.operation("completed"):
            with self.assertRaises(BlockingIOError): self.manager.clean("completed", True)
        with self.manager.lease.hold([str(path)], "test-holder"):
            with self.assertRaises(self.manager.lease.LeaseError): self.manager.clean("completed", True)
        self.assertTrue((path/"build-output").exists())
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
