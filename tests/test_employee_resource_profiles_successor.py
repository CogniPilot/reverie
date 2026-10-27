import os
import stat
import errno
import unittest
from unittest.mock import patch
from reverie import employee_resource_profiles as m
from tests import test_employee_resource_profiles as a


class Successor(unittest.TestCase):
    def setUp(self):
        self.f=a.Controls('test_persist_reload_and_new_sid_exact_policy')
        self.f.setUp();self.addCleanup(self.f.doCleanups)
        self.f.save();self.root=self.f.root;self.s=self.f.store

    def put_next(self):
        return self.s.put(a.E,dict(a.R,memoryMiB=8192),a.bind(),
                          expected_revision=1,expected_profile_version=1,
                          expected_binding=a.bind())

    def test_rebound_commit_is_explicit_uncertain_and_retained(self):
        original=os.rename
        moved=self.root.with_name(self.root.name+'-uncertain')
        changed=False
        def rename(src,dst,**kwargs):
            nonlocal changed
            if str(src).startswith('.profiles-') and str(dst)=='profiles.json':
                original(self.root,moved);self.root.mkdir(mode=0o700);changed=True
            return original(src,dst,**kwargs)
        try:
            with patch.object(m.os,'rename',side_effect=rename):
                with self.assertRaisesRegex(m.CommitUncertain,'COMMIT_OUTCOME_UNCERTAIN') as raised:
                    self.put_next()
            self.assertIsInstance(raised.exception.__cause__,m.Refusal)
            self.assertEqual(str(raised.exception.__cause__),'STORE_DIRECTORY_REBOUND')
        finally:
            if changed:
                self.root.rmdir();original(moved,self.root)
        # Refusal did not mean no write; original store retains the new revision.
        self.assertEqual(self.s.snapshot()['revision'],2)
        self.assertEqual(self.s.snapshot()['profiles'][a.E]['version'],2)

    def test_postrename_io_error_keeps_type_and_uncertainty_note(self):
        original=os.fsync
        def fsync(fd):
            if stat.S_ISDIR(os.fstat(fd).st_mode):
                raise OSError(errno.EIO,'synthetic directory sync error')
            return original(fd)
        with patch.object(m.os,'fsync',side_effect=fsync):
            with self.assertRaises(OSError) as raised:
                self.put_next()
        self.assertEqual(raised.exception.errno,errno.EIO)
        self.assertIn('COMMIT_OUTCOME_UNCERTAIN_RETAIN_EVIDENCE',raised.exception.__notes__)
        self.assertEqual(self.s.snapshot()['revision'],2)


if __name__=='__main__':unittest.main(verbosity=2)
