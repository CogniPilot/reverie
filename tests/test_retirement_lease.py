"""Canonical metadata-first barriers for non-destructive retained trees."""
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch
from reverie.cleanup import lease


class RetirementLease(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.tmp = self.base / 'scratch/tmp'
        self.tmp.mkdir(parents=True, mode=0o700)
        self.leases = self.base / 'leases'
        self.leases.mkdir(mode=0o700)
        self.env = patch.dict(os.environ, REVERIE_LEASE_DIR=str(self.leases))
        self.env.start()
        self.addCleanup(self.env.stop)

    def guard(self, **kw):
        return lease.retirement(self.tmp, self.tmp.parent, [self.leases],
                                deadline=time.monotonic() + 3, **kw)

    def test_no_subtree_walk_and_unrelated_active_lease_allowed(self):
        other = self.base / 'other'
        other.mkdir()
        with lease.hold(other, wait=0), patch.object(lease, '_keys_for', side_effect=AssertionError('walk')):
            with self.guard() as proof:
                self.assertFalse(proof['treeWalkPerformed'])

    def test_workspace_reservation_above_declared_scope_preserves_old_root_boundary(self):
        lease.reserve(self.base, '5m')
        with self.guard():
            pass

    def test_explicit_retention_reservation_does_not_change_environment(self):
        other = self.base / 'retired-envelope'
        other.mkdir()
        selected = self.base / 'selected-leases'
        selected.mkdir(mode=0o700)
        key = lease.reserve(other, '24h', base=selected)
        self.assertTrue((selected / (key + '.reserve.json')).is_file())
        self.assertFalse((self.leases / (key + '.reserve.json')).exists())

    def test_live_descendant_and_ancestor_each_refuse(self):
        child = self.tmp / 'build'
        child.mkdir()
        for path in (child, self.tmp.parent):
            with self.subTest(path=path), lease.hold(path, wait=0):
                with self.assertRaisesRegex(lease.LeaseError, 'live registered'):
                    with self.guard():
                        self.fail('must not retire active task')

    def test_live_descendant_reservation_refuses(self):
        child = self.tmp / 'staged'
        child.mkdir()
        lease.reserve(child, '5m')
        with self.assertRaisesRegex(lease.LeaseError, 'live registered'):
            with self.guard():
                self.fail('must not retire reserved input')

    def test_symlink_parent_path_does_not_hide_active_descendant(self):
        alias = self.base / 'alias'
        alias.symlink_to(self.tmp, target_is_directory=True)
        child = self.tmp / 'build'
        child.mkdir()
        with lease.hold(alias / 'build', wait=0):
            with self.assertRaisesRegex(lease.LeaseError, 'live registered'):
                with self.guard():
                    self.fail('alias active task hidden')

    def test_mount_relationship_callback_can_refuse_alias_lease(self):
        other = self.base / 'other'
        other.mkdir()
        with lease.hold(other, wait=0):
            with self.assertRaisesRegex(lease.LeaseError, 'live registered'):
                with self.guard(related=lambda _path: True):
                    self.fail('mount relationship must add protection')

    def test_async_relationship_does_not_authorize(self):
        other = self.base / 'other'
        other.mkdir()
        async def not_sync(_path):
            return False
        with lease.hold(other, wait=0):
            with self.assertRaisesRegex(lease.LeaseError, 'synchronous'):
                with self.guard(related=not_sync):
                    self.fail('async classification silently admitted')

    def test_lease_directory_replacement_during_transaction_refuses(self):
        with self.assertRaisesRegex(lease.LeaseError, 'directory changed'):
            with self.guard():
                self.leases.rename(self.base / 'preserved-old-leases')
                self.leases.mkdir(mode=0o700)

    def test_record_bound_refuses_and_barriers_release(self):
        other = self.base / 'other'
        other.mkdir()
        lease.reserve(other, '1m')
        with self.assertRaisesRegex(lease.LeaseError, 'bound'):
            with self.guard(max_records=1):
                self.fail('partial metadata inventory admitted')
        with self.guard():
            pass

    def test_replaced_live_path_refuses(self):
        other = self.base / 'other'
        other.mkdir()
        with lease.hold(other, wait=0):
            other.rename(self.base / 'retained')
            other.mkdir()
            with self.assertRaisesRegex(lease.LeaseError, 'path changed'):
                with self.guard():
                    self.fail('stale inode evidence admitted')

    def test_active_missing_metadata_refuses(self):
        other = self.tmp / 'other'
        other.mkdir()
        with lease.hold(other, wait=0):
            key = lease.key_of(other)
            for path in self.leases.glob(key + '*.json'):
                path.unlink()
            with self.assertRaisesRegex(lease.LeaseError, 'no path evidence'):
                with self.guard():
                    self.fail('ambiguous active lock admitted')
