"""Real directory moves, journals and kernel locks; only engine/manager ports fake."""
import copy
import fcntl
import json
import os
from pathlib import Path
import subprocess
import time
import unittest
from unittest.mock import patch

from reverie import worker_mount_relocation as M
from reverie import worker_resource_reservations as R
from reverie.worker_service import UNIT
from tests import test_worker_service_upgrade as F


class MountRelocationTests(unittest.TestCase):
    def setUp(self):
        f = F.GPUServiceUpgradeTests(); f.setUp(); self.addCleanup(f.doCleanups)
        self.f = f; self.service = f.service; self.config = f.config
        self.old = f.root / 'old' / 'cases'; self.old.parent.mkdir(mode=0o700); self.old.mkdir(mode=0o755)
        self.new = f.root / 'new' / 'cases'; self.new.parent.mkdir(mode=0o700)
        (self.old / 'unique.txt').write_text('retained source')
        self.config['mounts'].append({'source': str(self.old), 'destination': '/projects/cases', 'readOnly': False})
        self.config['resourceReservations'] = f.selected['resourceReservations']
        self.service.config_path.write_bytes(M.encoded(self.config))
        F.FakeNative.rows = []
        R.provision(self.service.resource_probe(self.config))
        storage_locks = Path(self.config['stateRoot']) / 'storage-locks'
        storage_locks.mkdir(mode=0o700)
        (storage_locks / 'employee-fixture.lock').touch(mode=0o600)
        self.leases = f.root / 'leases'; self.leases.mkdir(mode=0o700)
        (self.leases / 'barrier.lock').touch(mode=0o600)
        self.enterContext(patch.dict(os.environ, {'REVERIE_LEASE_DIR': str(self.leases)}))
        self.m = M.MountRelocation(self.service, f.operation)
        self.enterContext(patch.object(self.m, '_engine', return_value={'endpoint': 'unix:///fake', 'engineId': 'fake', 'socketStamp': []}))
        def inactive(config):
            M.need(not f.active, 'MOUNT_RELOCATION_BROKER_MUST_BE_INACTIVE')
        self.enterContext(patch.object(self.m, '_inactive', side_effect=inactive))
        self.enterContext(patch.object(F.FakeNative, 'stopped_state', create=True, return_value={
            'Running': False, 'Pid': 0, 'Status': 'exited', 'StartedAt': '', 'Paused': False, 'Restarting': False, 'Dead': False}))
        f.active = False
        self.selection = f.selection_path
        self.selection.write_bytes(M.encoded({'oldSource': str(self.old), 'newSource': str(self.new)}))
        self.original = self.service.config_path.read_bytes()
        # A retained unknown expired batch, including STEP without ACK, is not
        # silently declared complete, removed, credited or granted replay.
        self.hr = f.control / 'host-resume'; self.hr.mkdir(mode=0o700)
        self.oid = '3224585f-ef67-4be8-86b9-0b69481af46c'
        self.actor = self.hr / self.oid; self.actor.mkdir(mode=0o700)
        self.plan = {'operationId': self.oid, 'expiresAt': int(time.time()) - 3600}
        self.write(self.actor / 'PLAN.json', self.plan)
        self.write(self.actor / 'ATTEMPT.json', {'unknown': True})
        self.write(self.actor / 'STEP-4.json', {'unknown': True})
        (self.actor / 'operation.lock').touch(mode=0o600)
        self.write(self.hr / 'ACTIVE.json', {'purpose': 'retained', 'operationId': self.oid,
                                           'planDigest': M.digest((self.actor / 'PLAN.json').read_bytes())})
        self.history = {str(p): (p.read_bytes(), M.stamp(p)) for p in self.hr.rglob('*') if p.is_file()}

    def write(self, path, value):
        path.write_bytes(M.encoded(value)); path.chmod(0o600)

    def prepare(self):
        return self.m.prepare(self.selection)['planSHA256']

    def move(self):
        self.old.rename(self.new); self.old.symlink_to(self.new)

    def unchanged_history(self):
        self.assertEqual(self.history, {str(p): (p.read_bytes(), M.stamp(p)) for p in self.hr.rglob('*') if p.is_file()})

    def test_equivalent_move_preserves_inode_journals_and_every_other_setting(self):
        inode = self.old.stat().st_ino; sha = self.prepare(); self.move()
        result = self.m.apply(sha)
        self.assertEqual(result['state'], 'COMMITTED')
        self.assertEqual(self.new.stat().st_ino, inode)
        after = json.loads(self.service.config_path.read_bytes())
        wanted = copy.deepcopy(self.config); wanted['mounts'][-1]['source'] = str(self.new)
        self.assertEqual(after, wanted)
        self.assertEqual(json.loads(M.private(R.marker(after)))['configurationDigest'], R.domain_digest(after))
        self.unchanged_history(); self.assertFalse(R.pending(after).exists())
        self.assertTrue((self.f.operation / 'DONE.json').exists())
        self.assertEqual((self.new / 'unique.txt').read_text(), 'retained source')
        with self.assertRaisesRegex(ValueError, 'ALREADY_CONSUMED'): self.m.apply(sha)

    def test_selection_cannot_change_destination_flags_or_other_policy(self):
        self.write(self.selection, {'oldSource': str(self.old), 'newSource': str(self.new), 'readOnly': True})
        with self.assertRaisesRegex(ValueError, 'CLOSED_SELECTION'): self.prepare()
        self.assertEqual(self.service.config_path.read_bytes(), self.original)

    def test_changed_live_config_even_whitespace_refuses_before_attempt(self):
        sha = self.prepare(); self.move()
        self.service.config_path.write_bytes(self.original + b' ')
        with self.assertRaisesRegex(ValueError, 'CAS_CHANGED'): self.m.apply(sha)
        self.assertFalse((self.f.operation / 'ATTEMPT.json').exists())

    def test_changed_mount_permissions_or_other_settings_refuses(self):
        sha = self.prepare(); self.move()
        changed = copy.deepcopy(self.config); changed['mounts'][-1]['readOnly'] = True; changed['memoryMiB'] += 1
        self.service.config_path.write_bytes(M.encoded(changed))
        with self.assertRaisesRegex(ValueError, 'CAS_CHANGED'): self.m.apply(sha)
        self.assertFalse((self.f.operation / 'ATTEMPT.json').exists())

    def test_directory_inode_or_symlink_substitution_refuses(self):
        sha = self.prepare(); self.move(); self.new.rename(self.new.with_name('saved')); self.new.mkdir(mode=0o755)
        with self.assertRaisesRegex(ValueError, 'DIRECTORY_REPLACED'): self.m.apply(sha)
        self.new.rmdir(); self.new.symlink_to(self.new.with_name('saved'))
        with self.assertRaises(OSError): self.m.apply(sha)
        self.assertEqual(self.service.config_path.read_bytes(), self.original)

    def test_parent_replacement_and_wrong_compatibility_link_refuse(self):
        sha = self.prepare(); self.move(); self.old.unlink(); self.old.symlink_to('/tmp')
        with self.assertRaisesRegex(ValueError, 'EXACT_COMPATIBILITY_LINK'): self.m.apply(sha)
        self.old.unlink(); self.old.parent.rename(self.old.parent.with_name('saved-parent')); self.old.parent.mkdir(mode=0o700)
        self.old.symlink_to(self.new)
        with self.assertRaisesRegex(ValueError, 'PARENT_CHANGED'): self.m.apply(sha)

    def test_live_broker_worker_or_website_refuses(self):
        self.f.active = True
        with self.assertRaisesRegex(ValueError, 'BROKER_MUST_BE_INACTIVE'): self.prepare()
        self.f.active = False
        for row in [{'Config': {'Labels': {'reverie.worker': self.config['deployment']}}},
                    {'Name': '/' + self.config['serverContainer'], 'Config': {'Labels': {}}}]:
            F.FakeNative.rows = [{**row, 'State': {'Running': True, 'Pid': 123}}]
            with self.assertRaisesRegex(ValueError, 'LIVE_CONTAINER'): self.prepare()

    def test_live_storage_or_host_task_lease_refuses(self):
        lock = next((Path(self.config['stateRoot']) / 'storage-locks').glob('*.lock'))
        with lock.open('r+') as stream:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError): self.prepare()
        lock = self.leases / '1-2.lock'; lock.touch(mode=0o600)
        with lock.open('r+') as stream:
            fcntl.flock(stream, fcntl.LOCK_SH | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError): self.prepare()

    def test_foreign_running_container_with_shared_or_private_storage_refuses(self):
        for source in (str(self.old), self.config['stateRoot'], self.config['scratchRoot']):
            F.FakeNative.rows = [{'Name': '/foreign', 'Config': {'Labels': {}},
                                 'State': {'Running': True, 'Pid': 123},
                                 'Mounts': [{'Type': 'bind', 'Source': source, 'Destination': '/work', 'RW': True}]}]
            with self.assertRaisesRegex(ValueError, 'FOREIGN_LIVE_WRITER'): self.prepare()

    def test_unexpired_actor_or_live_host_job_refuses(self):
        self.plan['expiresAt'] = int(time.time()) + 300; self.write(self.actor / 'PLAN.json', self.plan)
        with self.assertRaisesRegex(ValueError, 'UNEXPIRED_HOST_ACTOR'): self.prepare()
        self.plan['expiresAt'] = 1; self.write(self.actor / 'PLAN.json', self.plan)
        self.write(self.hr / 'ACTIVE.json', {'purpose': 'retained', 'operationId': self.oid,
                                           'planDigest': M.digest((self.actor / 'PLAN.json').read_bytes())})
        self.write(self.f.control / 'operations/host-job.intent.json', {})
        with self.assertRaisesRegex(ValueError, 'HOST_JOB_OUTCOME'): self.prepare()

    def test_interrupted_config_replace_leaves_pending_and_cannot_retry(self):
        sha = self.prepare(); self.move(); replace = os.replace
        def fail_binding(source, destination, **kwargs):
            if destination == R.marker(self.config).name: raise OSError('injected interruption')
            return replace(source, destination, **kwargs)
        with patch.object(M.os, 'replace', side_effect=fail_binding), self.assertRaises((OSError, ValueError)):
            self.m.apply(sha)
        self.assertTrue(R.pending(self.config).exists())
        self.assertTrue((self.f.operation / 'ATTEMPT.json').exists())
        self.assertFalse((self.f.operation / 'DONE.json').exists())
        with self.assertRaisesRegex(ValueError, 'ALREADY_CONSUMED'): self.m.apply(sha)
        with self.assertRaisesRegex(ValueError, 'RECONCILIATION'): R.ReservationGate(self.service.resource_probe(self.config))
        self.unchanged_history()

    def test_history_changed_after_prepare_is_not_overwritten(self):
        sha = self.prepare(); self.move(); path = self.actor / 'STEP-4.json'; self.write(path, {'owner': 'new observation'})
        with self.assertRaisesRegex(ValueError, 'CAS_CHANGED'): self.m.apply(sha)
        self.assertEqual(json.loads(path.read_bytes()), {'owner': 'new observation'})

    def test_live_host_actor_kernel_lock_rejects_even_expired_metadata(self):
        with (self.actor / 'operation.lock').open('r+') as stream:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError): self.prepare()

    def test_unknown_or_live_reservation_and_registry_alias_reject(self):
        (self.leases / '1-2.lock').touch(mode=0o600)
        self.write(self.leases / '1-2.reserve.json', {'malformed': True})
        with self.assertRaisesRegex(ValueError, 'LIVE_OR_UNKNOWN_RESERVATION'): self.prepare()
        (self.leases / '1-2.reserve.json').unlink()
        (self.leases / '1-2.path.json').symlink_to(self.selection)
        with self.assertRaises((OSError, ValueError)): self.prepare()

    def test_lease_appearing_after_prepare_blocks_apply(self):
        sha = self.prepare(); self.move(); lock = self.leases / '1-2.lock'; lock.touch(mode=0o600)
        with lock.open('r+') as stream:
            fcntl.flock(stream, fcntl.LOCK_SH | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError): self.m.apply(sha)
        self.assertFalse((self.f.operation / 'ATTEMPT.json').exists())

    def test_late_config_cas_change_stays_fenced_without_overwriting_owner_edit(self):
        sha = self.prepare(); self.move(); original = M.exclusive
        edited = self.original + b'  '
        def change(path, raw):
            original(path, raw)
            if path == R.pending(self.config): self.service.config_path.write_bytes(edited)
        with patch.object(M, 'exclusive', side_effect=change), self.assertRaisesRegex(ValueError, 'REPLACE_CAS_CHANGED'):
            self.m.apply(sha)
        self.assertEqual(self.service.config_path.read_bytes(), edited)
        self.assertTrue(R.pending(self.config).exists()); self.unchanged_history()

    def test_finalizer_failure_keeps_startup_fence_after_both_replacements(self):
        sha = self.prepare(); self.move(); original = os.replace
        def change(source, destination, **kwargs):
            original(source, destination, **kwargs)
            if destination == R.marker(self.config).name:
                (self.leases / '3-4.lock').touch(mode=0o600)
        with patch.object(M.os, 'replace', side_effect=change), self.assertRaisesRegex(ValueError, 'LEASE_REGISTRY_CHANGED'):
            self.m.apply(sha)
        self.assertFalse((self.f.operation / 'DONE.json').exists())
        self.assertTrue(R.pending(self.config).exists())
        self.unchanged_history()

    def test_real_manager_observation_refuses_active_service(self):
        fields = dict(Id=UNIT, LoadState='loaded', ActiveState='active', SubState='running', MainPID='123',
                      ControlPID='0', Job='', FragmentPath=str(self.service.unit), DropInPaths='', NeedDaemonReload='no')
        def manager(args): return subprocess.CompletedProcess(args, 0, ''.join(k+'='+v+'\n' for k,v in fields.items()), '')
        with patch.object(self.service, 'run', side_effect=manager):
            with self.assertRaisesRegex(ValueError, 'BROKER_MUST_BE_INACTIVE'):
                M.MountRelocation._inactive(self.m, self.config)


if __name__ == '__main__': unittest.main()
