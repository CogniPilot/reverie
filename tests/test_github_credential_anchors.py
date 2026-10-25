"""Synthetic directory anchoring only: never calls the installer or copies a token."""
import os
from pathlib import Path
import tempfile
import unittest
from reverie.github_credentials import DirectoryAnchor, selected_home, credential_directory

SESSION = '11111111-2222-4333-8444-555555555555'

class CredentialAnchorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state = self.root/'state'
        self.home = self.state/SESSION/'home'
        self.home.mkdir(parents=True)
        self.policy = {'stateRoot': str(self.state)}

    def test_state_root_ancestor_alias_refuses_before_any_copy(self):
        alias = self.root/'alias'; alias.symlink_to(self.state, target_is_directory=True)
        with self.assertRaises(ValueError): selected_home({'stateRoot': str(alias)}, SESSION)
        self.assertEqual(list(self.root.rglob('*.token')), [])

    def test_session_ancestor_and_final_home_aliases_refuse(self):
        moved = self.root/'moved'; self.home.parent.rename(moved)
        self.home.parent.symlink_to(moved, target_is_directory=True)
        with self.assertRaises(ValueError): selected_home(self.policy, SESSION)
        self.home.parent.unlink(); moved.rename(self.home.parent)
        self.home.rename(self.root/'other-home'); self.home.symlink_to(self.root/'other-home', target_is_directory=True)
        with self.assertRaises(ValueError): selected_home(self.policy, SESSION)
        self.assertEqual(list(self.root.rglob('*.token')), [])

    def test_retained_ancestry_detects_replacement_and_never_follows_new_home(self):
        anchor = selected_home(self.policy, SESSION); self.addCleanup(anchor.close)
        old_inode = os.fstat(anchor.fd).st_ino
        self.home.rename(self.home.with_name('retained-home')); self.home.mkdir()
        with self.assertRaises(ValueError): anchor.check()
        self.assertEqual(os.fstat(anchor.fd).st_ino, old_inode)
        self.assertEqual(list(self.root.rglob('*.token')), [])

    def test_state_root_replacement_also_invalidates_retained_descriptors(self):
        anchor = selected_home(self.policy, SESSION); self.addCleanup(anchor.close)
        self.state.rename(self.root/'old-state'); self.home.mkdir(parents=True)
        with self.assertRaises(ValueError): anchor.check()
        self.assertEqual(list(self.root.rglob('*.token')), [])

    def test_canonical_anchor_retains_private_subdirectories_and_rejects_subtree_alias(self):
        anchor = selected_home(self.policy, SESSION); self.addCleanup(anchor.close)
        fd = credential_directory(anchor, [('.config', False), ('reverie', False), ('credentials', True)])
        self.assertEqual(os.fstat(fd).st_mode & 0o777, 0o700)
        anchor.check()
        outside = self.root/'outside'; outside.mkdir()
        (self.home/'.config/reverie/credentials/github').symlink_to(outside, target_is_directory=True)
        with self.assertRaises(OSError): credential_directory(anchor, [('github', True)])
        self.assertEqual(list(outside.iterdir()), [])

    def test_private_directory_or_home_custody_drift_refuses_before_copy(self):
        anchor = selected_home(self.policy, SESSION); self.addCleanup(anchor.close)
        credential_directory(anchor, [('credentials', True)])
        (self.home/'credentials').chmod(0o755)
        with self.assertRaises(ValueError): anchor.check()
        (self.home/'credentials').chmod(0o700); self.home.chmod(0o777)
        with self.assertRaises(ValueError): anchor.check()
        self.assertEqual(list(self.root.rglob('*.token')), [])

    def test_installer_wiring_anchors_all_destinations_before_source_read_without_execution(self):
        import ast
        import inspect
        from reverie.github_credentials import install
        tree = ast.parse(inspect.getsource(install))
        calls = [n for n in ast.walk(tree) if isinstance(n, ast.Call)]
        named = lambda n: n.func.id if isinstance(n.func, ast.Name) else ''
        home_line = next(n.lineno for n in calls if named(n) == 'selected_home')
        source_line = next(n.lineno for n in calls if named(n) == 'private_read' and isinstance(n.args[0], ast.Name) and n.args[0].id == 'source')
        copy_line = min(n.lineno for n in calls if named(n) == 'atomic')
        self.assertLess(home_line, source_line)
        self.assertLess(source_line, copy_line)
        self.assertTrue(any(isinstance(n.func, ast.Attribute) and n.func.attr == 'check' and home_line < n.lineno < source_line for n in calls))
