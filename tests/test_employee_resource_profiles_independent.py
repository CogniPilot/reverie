import copy
import errno
import json
import os
import stat
import unittest
from unittest.mock import patch
from reverie import employee_resource_profiles as m
from tests import test_employee_resource_profiles as a


class Independent(unittest.TestCase):
    def setUp(self):
        self.f = a.Controls('test_persist_reload_and_new_sid_exact_policy')
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        self.s = self.f.store
        self.root = self.f.root
        self.f.save()

    def put_next(self):
        return self.s.put(a.E, dict(a.R, memoryMiB=8192), a.bind(),
                          expected_revision=1, expected_profile_version=1,
                          expected_binding=a.bind())

    def test_rename_failure_preserves_previous_document_and_cleans_temp(self):
        before = (self.root / 'profiles.json').read_bytes()
        with patch.object(m.os, 'rename', side_effect=OSError(errno.EIO, 'synthetic rename failure')):
            with self.assertRaises(OSError):
                self.put_next()
        self.assertEqual((self.root / 'profiles.json').read_bytes(), before)
        self.assertEqual(list(self.root.glob('.profiles-*')), [])
        self.assertEqual(self.s.snapshot()['revision'], 1)

    def test_file_fsync_failure_refuses_before_rename(self):
        before = (self.root / 'profiles.json').read_bytes()
        original = os.fsync
        def fsync(fd):
            if stat.S_ISREG(os.fstat(fd).st_mode):
                raise OSError(errno.EIO, 'synthetic file fsync failure')
            return original(fd)
        with patch.object(m.os, 'fsync', side_effect=fsync):
            with self.assertRaises(OSError):
                self.put_next()
        self.assertEqual((self.root / 'profiles.json').read_bytes(), before)
        self.assertEqual(list(self.root.glob('.profiles-*')), [])

    def test_directory_fsync_error_retains_uncertain_commit_for_readback(self):
        original = os.fsync
        def fsync(fd):
            if stat.S_ISDIR(os.fstat(fd).st_mode):
                raise OSError(errno.EIO, 'synthetic directory fsync failure')
            return original(fd)
        with patch.object(m.os, 'fsync', side_effect=fsync):
            with self.assertRaises(OSError):
                self.put_next()
        self.assertEqual(self.s.snapshot()['revision'], 2)
        self.assertEqual(self.s.snapshot()['profiles'][a.E]['version'], 2)
        self.assertEqual(list(self.root.glob('.profiles-*')), [])

    def test_directory_rebound_at_commit_must_not_ack_success(self):
        original = os.rename
        moved = self.root.with_name(self.root.name + '-moved-at-commit')
        swapped = False
        def rename(src, dst, **kwargs):
            nonlocal swapped
            if str(src).startswith('.profiles-') and str(dst) == 'profiles.json':
                original(self.root, moved)
                self.root.mkdir(mode=0o700)
                swapped = True
            return original(src, dst, **kwargs)
        try:
            with patch.object(m.os, 'rename', side_effect=rename):
                with self.assertRaises(m.Refusal):
                    self.put_next()
        finally:
            if swapped:
                self.root.rmdir()
                original(moved, self.root)

    def test_restrictive_umask_must_not_ack_an_unreadable_committed_file(self):
        old = os.umask(0o200)
        error = None
        try:
            try:
                self.put_next()
            except (m.Refusal, OSError) as exc:
                error = exc
        finally:
            os.umask(old)
        if error is None:
            self.assertEqual(stat.S_IMODE((self.root / 'profiles.json').stat().st_mode), 0o600)
            self.assertEqual(self.s.snapshot()['revision'], 2)

    def test_hardlinked_data_and_lock_refuse(self):
        data = self.root / 'profiles.json'
        other = self.root / 'data-alias'
        os.link(data, other)
        try:
            with self.assertRaisesRegex(m.Refusal, 'PRIVATE_STORE_FILE'):
                self.s.snapshot()
        finally:
            other.unlink()
        lock = self.root / 'profiles.lock'
        os.link(lock, self.root / 'lock-alias')
        with self.assertRaisesRegex(m.Refusal, 'PRIVATE_STORE_FILE'):
            self.s.snapshot()

    def test_type_sensitive_binding_and_version_refuse_without_write(self):
        before = (self.root / 'profiles.json').read_bytes()
        for new_binding in (dict(a.bind(), current_generation=True), dict(a.bind(), target_generation=2.0), dict(a.bind(), target_generation=0)):
            with self.subTest(binding=new_binding), self.assertRaises(m.Refusal):
                self.s.put(a.E, a.R, new_binding, expected_revision=1,
                           expected_profile_version=1, expected_binding=a.bind())
            self.assertEqual((self.root / 'profiles.json').read_bytes(), before)
        with self.assertRaises(m.Refusal):
            self.s.put(a.E, a.R, a.bind(), expected_revision=1.0,
                       expected_profile_version=1, expected_binding=a.bind())

    def test_stage_exact_unrelated_digest_and_input_copy_preservation(self):
        config = dict(a.R, sessionResources={a.C:dict(a.R, memoryMiB=4096)}, unrelated='preserve')
        original = copy.deepcopy(config)
        digest = m.policy_digest(config, a.C)
        result = self.s.stage_config(config, a.E, a.bind(), expected_revision=1,
                                     expected_profile_version=1, sid_owners={a.A:a.E, a.B:a.E})
        self.assertEqual(config, original)
        self.assertEqual(m.policy_digest(result['config'], a.C), digest)
        self.assertEqual(result['config']['unrelated'], 'preserve')
        result['config']['sessionResources'][a.B]['memoryMiB'] = 1
        self.assertEqual(self.s.snapshot()['profiles'][a.E]['resources'], a.R)

    def test_foreign_target_and_missing_pending_do_not_default(self):
        with self.assertRaisesRegex(m.Refusal, 'SID_OWNER_MISMATCH'):
            self.s.stage_config(a.R, a.E, a.bind(), expected_revision=1,
                                expected_profile_version=1, sid_owners={a.A:a.E, a.B:a.F})
        with self.assertRaisesRegex(m.Refusal, 'NO_DEFAULT'):
            self.s.stage_config(a.R, a.F, a.bind(a.F,a.C,a.C), expected_revision=1,
                                expected_profile_version=0, sid_owners={a.C:a.F})

    def test_short_read_and_data_change_during_load(self):
        original = os.read
        with patch.object(m.os, 'read', side_effect=lambda fd,n: original(fd,min(7,n))):
            self.assertEqual(self.s.snapshot()['revision'], 1)
        changed = False
        raw = (self.root / 'profiles.json').read_bytes()
        def read(fd,n):
            nonlocal changed
            part = original(fd,min(7,n))
            if not changed:
                (self.root / 'profiles.json').write_bytes(raw+b' ')
                changed = True
            return part
        with patch.object(m.os, 'read', side_effect=read):
            with self.assertRaisesRegex(m.Refusal, 'STORE_CHANGED'):
                self.s.snapshot()


if __name__ == '__main__':
    unittest.main(verbosity=2)
