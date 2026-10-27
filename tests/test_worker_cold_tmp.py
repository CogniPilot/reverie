"""Owned source controls. No engine, provider or personal instance operations."""
import tests  # noqa: F401
from contextlib import contextmanager
import json
import mmap
import os
from pathlib import Path
import socket
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from reverie import worker_cold_tmp as cold
from reverie.cleanup import lease
from reverie.worker_tmp import prepare_temporary

EMP = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
SID = '11111111-2222-4333-8444-555555555555'


class ColdTemporaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.config = {'stateRoot': str(self.root/'state'), 'scratchRoot': str(self.root/'scratch'),
                       'uid': os.getuid(), 'mounts': [], 'coldTemporaryCleanup':
                       {'version': 1, 'enabled': True, 'hostLeaseDirectories': []}}
        root = self.root/'state/employees'/EMP; root.mkdir(mode=0o700, parents=True)
        home = root/'home'; home.mkdir(mode=0o700)
        self.paths = SimpleNamespace(kind='employee', identity=EMP, session=SID, root=root,
                                    home=home, scratch=self.root/'scratch/employees'/EMP)
        cold.initialize_leases(self.config, self.paths, fresh_home=True)
        self.tmp = prepare_temporary(self.config, self.paths.scratch)
        self.proc = self.root/'owned-empty-proc'; self.proc.mkdir()
        self.calls = []
        self.scan = lambda keys, **kw: cold._same_uid_references(keys, proc=self.proc, **kw)
        self.base = home/'.local/state/reverie/leases'

    def guard(self, keys): self.calls.append(keys)
    def clear(self, guard=None, scan=None):
        return cold.clear_cold_temporary(self.config, self.paths, guard or self.guard, process_scan=scan or self.scan)
    def marker(self, name='payload'):
        p = self.tmp/name; p.parent.mkdir(parents=True, exist_ok=True); p.write_bytes(b'owned tmp')
        return p
    def pending(self): return self.paths.root/cold.PENDING

    def test_cold_clear_keeps_tmp_inode_durable_home_nix_tasks_and_other_employee(self):
        home = self.paths.home/'durable'; home.write_bytes(b'home')
        nix = self.paths.root/'nix'; nix.mkdir(); (nix/'durable').write_bytes(b'nix')
        tasks = self.paths.scratch/'tasks'; tasks.mkdir(); (tasks/'handoff').write_bytes(b'tasks')
        peer = self.root/'scratch/employees/bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee/tmp'
        peer.mkdir(parents=True); (peer/'owned').write_bytes(b'peer')
        self.marker('nested/deep/build'); inode = self.tmp.stat().st_ino
        result = self.clear()
        self.assertEqual(result['state'], 'COLD_TMP_CLEARED'); self.assertEqual(list(self.tmp.iterdir()), [])
        self.assertEqual(self.tmp.stat().st_ino, inode); self.assertEqual(self.tmp.stat().st_mode & 0o777, 0o700)
        self.assertEqual([home.read_bytes(), (nix/'durable').read_bytes(), (tasks/'handoff').read_bytes(), (peer/'owned').read_bytes()], [b'home',b'nix',b'tasks',b'peer'])
        self.assertFalse(self.pending().exists()); self.assertEqual(len(list(self.paths.root.glob('cold-tmp-complete-*.json'))), 1)
        probe = self.tmp/'writable'; probe.write_bytes(b'yes'); self.assertEqual(probe.read_bytes(), b'yes')

    def test_disabled_never_wipes_and_does_not_bypass_existing_pending(self):
        p = self.marker(); self.config.pop('coldTemporaryCleanup')
        self.assertEqual(self.clear()['state'], 'COLD_TMP_CLEANUP_DISABLED'); self.assertTrue(p.exists()); self.assertFalse(self.calls)
        self.pending().write_text('{}')
        with self.assertRaisesRegex(RuntimeError, 'reconciliation'): self.clear()
        self.assertTrue(p.exists())

    def test_active_lease_and_reservation_refuse_before_any_delete(self):
        p = self.marker()
        with patch.dict(os.environ, REVERIE_LEASE_DIR=str(self.base)):
            with lease.hold([str(self.tmp)], 'owned-test'):
                with self.assertRaises(lease.LeaseError): self.clear()
            lease.reserve(str(self.tmp), '1h', owner='fixture')
            with self.assertRaises(lease.LeaseError): self.clear()
        self.assertTrue(p.exists()); self.assertFalse(self.pending().exists())

    def test_missing_or_malformed_lease_evidence_is_unknown(self):
        p = self.marker(); missing = self.root/'missing-host-leases'
        self.config['coldTemporaryCleanup']['hostLeaseDirectories'] = [str(missing)]
        with self.assertRaises(OSError): self.clear()
        self.config['coldTemporaryCleanup']['hostLeaseDirectories'] = []
        (self.base/(lease.key_of(self.tmp)+'.reserve.json')).write_text('{malformed')
        with self.assertRaises(lease.LeaseError): self.clear()
        self.assertTrue(p.exists()); self.assertFalse(self.pending().exists())

    def test_symlink_is_unlinked_without_touching_target_but_root_alias_refuses(self):
        outside = self.root/'outside'; outside.mkdir(); victim = outside/'keep'; victim.write_bytes(b'preserve')
        (self.tmp/'alias').symlink_to(outside, target_is_directory=True); self.clear()
        self.assertEqual(victim.read_bytes(), b'preserve')
        self.tmp.rmdir(); self.tmp.symlink_to(outside, target_is_directory=True)
        with self.assertRaises((RuntimeError, ValueError, OSError)): self.clear()
        self.assertEqual(victim.read_bytes(), b'preserve')

    def test_hardlinks_keep_markers_and_sockets_refuse_without_partial_delete(self):
        p = self.marker('a')
        keep = self.tmp/'.keep'; keep.touch()
        with self.assertRaises(RuntimeError): self.clear()
        keep.unlink(); alias = self.root/'hardlink'; os.link(p, alias)
        with self.assertRaises(RuntimeError): self.clear()
        alias.unlink(); sock = socket.socket(socket.AF_UNIX); self.addCleanup(sock.close)
        descriptor = os.open(self.tmp, os.O_RDONLY | os.O_DIRECTORY)
        try: sock.bind('/proc/self/fd/'+str(descriptor)+'/active.sock')
        finally: os.close(descriptor)
        with self.assertRaisesRegex(RuntimeError, 'special state'): self.clear()
        self.assertTrue(p.exists()); self.assertFalse(self.pending().exists())

    def test_task_and_source_markers_refuse_before_any_delete(self):
        p = self.marker('first')
        for name in ('.reverie-task.json', '.git', '.hg', '.svn'):
            marker = self.tmp/name; marker.write_bytes(b'unknown or unfinished source')
            with self.subTest(name=name), self.assertRaisesRegex(RuntimeError, 'task/source marker'): self.clear()
            self.assertTrue(p.exists()); self.assertFalse(self.pending().exists()); marker.unlink()

    def test_real_same_uid_open_file_refuses(self):
        p = self.marker(); own = self.proc/str(os.getpid()); own.symlink_to(Path('/proc')/str(os.getpid()), target_is_directory=True)
        with p.open('rb'):
            with self.assertRaisesRegex(RuntimeError, 'live process reference'): self.clear()
        self.assertTrue(p.exists()); self.assertFalse(self.pending().exists())

    def test_real_same_uid_mapping_without_open_fd_refuses(self):
        p = self.marker(); own = self.proc/str(os.getpid()); own.symlink_to(Path('/proc')/str(os.getpid()), target_is_directory=True)
        with p.open('rb') as stream:
            mapped = mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ, trackfd=False)
        try:
            with self.assertRaisesRegex(RuntimeError, 'mapped file'): self.clear()
        finally: mapped.close()
        self.assertTrue(p.exists()); self.assertFalse(self.pending().exists())

    def test_same_device_nested_mount_metadata_refuses(self):
        p = self.marker(); inode = p.stat().st_ino; original = cold._mount_id
        def mounted(fd): return original(fd) + (1 if os.fstat(fd).st_ino == inode else 0)
        with patch.object(cold, '_mount_id', side_effect=mounted), self.assertRaisesRegex(RuntimeError, 'nested or changed mount'): self.clear()
        self.assertTrue(p.exists()); self.assertFalse(self.pending().exists())

    def test_swapped_lease_directory_refuses_after_barrier_acquisition(self):
        p = self.marker(); calls = 0
        def guard(keys):
            nonlocal calls
            calls += 1
            if calls == 2:
                self.base.rename(self.root/'prior-lease-dir'); self.base.mkdir(mode=0o700)
        with self.assertRaisesRegex(RuntimeError, 'lease directory changed'): self.clear(guard)
        self.assertTrue(p.exists()); self.assertFalse(self.pending().exists())

    def test_incomplete_owned_process_metadata_refuses(self):
        p = self.marker(); own = self.proc/'123'; own.mkdir(); (own/'stat').write_text('123 (owned) S '+'0 '*30); (own/'fd').mkdir(); (own/'status').write_text('Uid: '+(' '.join([str(os.getuid())]*4))+'\n')
        with self.assertRaises((RuntimeError, OSError)): self.clear()
        self.assertTrue(p.exists()); self.assertFalse(self.pending().exists())

    def test_root_swap_before_attempt_is_refused_without_deleting_moved_tree(self):
        p = self.marker(); moved = self.root/'moved'; count = 0
        def guard(keys):
            nonlocal count
            count += 1
            if count == 2: self.tmp.rename(moved); self.tmp.mkdir(mode=0o700)
        with self.assertRaisesRegex(RuntimeError, 'root changed'): self.clear(guard)
        self.assertEqual((moved/p.name).read_bytes(), b'owned tmp'); self.assertFalse(self.pending().exists())

    def test_unlink_fault_retains_pending_and_blocks_next_launch_even_if_disabled(self):
        self.marker('a'); tail = self.marker('z'); original = os.unlink
        def fail(name, *args, **kw):
            if name == 'z': raise OSError('owned fixture injected unlink failure')
            return original(name, *args, **kw)
        with patch('os.unlink', side_effect=fail), self.assertRaises(OSError): self.clear()
        self.assertFalse((self.tmp/'a').exists()); self.assertTrue(tail.exists()); self.assertTrue(self.pending().exists())
        self.config.pop('coldTemporaryCleanup')
        with self.assertRaisesRegex(RuntimeError, 'reconciliation'): self.clear()
        self.assertTrue(tail.exists())

    def test_early_mount_identity_failure_releases_all_owned_descriptors(self):
        p = self.marker(); before = len(os.listdir('/proc/self/fd'))
        for _ in range(3):
            with patch.object(cold, '_mount_id', side_effect=RuntimeError('owned metadata failure')), self.assertRaises(RuntimeError): self.clear()
        self.assertEqual(len(os.listdir('/proc/self/fd')), before)
        self.assertTrue(p.exists()); self.assertFalse(self.pending().exists())

    def test_partial_pending_write_fences_cleanup_before_first_delete(self):
        p = self.marker(); original = os.write; calls = 0
        def fail(fd, raw):
            nonlocal calls
            calls += 1
            if calls == 1: return original(fd, raw[:8])
            raise OSError('owned partial metadata write')
        with patch('os.write', side_effect=fail), self.assertRaises(OSError): self.clear()
        self.assertTrue(p.exists()); self.assertTrue(self.pending().exists())
        with self.assertRaisesRegex(RuntimeError, 'reconciliation'): self.clear()

    def test_late_file_activity_refuses_with_pending_fence(self):
        p = self.marker(); calls = 0
        def guard(keys):
            nonlocal calls
            calls += 1
            if calls == 3: p.write_bytes(b'new unique activity')
        with self.assertRaisesRegex(RuntimeError, 'entry changed'): self.clear(guard)
        self.assertEqual(p.read_bytes(), b'new unique activity'); self.assertTrue(self.pending().exists())

    def test_completion_flush_failure_keeps_fence_after_business_clear(self):
        self.marker(); original = os.fsync; key = self.paths.root.stat(); identity = (key.st_dev, key.st_ino)
        def fail(fd):
            st = os.fstat(fd)
            if (st.st_dev, st.st_ino) == identity and list(self.paths.root.glob('cold-tmp-complete-*.json')):
                raise OSError('owned completion directory flush failure')
            return original(fd)
        with patch('os.fsync', side_effect=fail), self.assertRaises(OSError): self.clear()
        self.assertTrue(self.pending().exists()); self.config.pop('coldTemporaryCleanup')
        with self.assertRaisesRegex(RuntimeError, 'reconciliation'): self.clear()

    def test_lease_finalizer_failure_keeps_fence(self):
        self.marker(); original = lease.janitor
        @contextmanager
        def fail(*args, **kw):
            with original(*args, **kw): yield
            raise OSError('owned lease finalizer failure')
        with patch.object(lease, 'janitor', fail), self.assertRaises(OSError): self.clear()
        self.assertTrue(self.pending().exists())
        self.config.pop('coldTemporaryCleanup')
        with self.assertRaisesRegex(RuntimeError, 'reconciliation'): self.clear()

    def test_no_flush_occurs_after_successful_fence_release(self):
        self.marker(); original = os.fsync
        def before_release(fd):
            if list(self.paths.root.glob('cold-tmp-complete-*.json')):
                self.assertTrue(self.pending().exists(), 'fallible flush after fence release')
            return original(fd)
        with patch('os.fsync', side_effect=before_release): self.assertEqual(self.clear()['state'], 'COLD_TMP_CLEARED')
        self.assertFalse(self.pending().exists())

    def test_unknown_native_or_async_guard_never_authorizes_deletion(self):
        p = self.marker()
        def refuse(keys): raise RuntimeError('owned native snapshot unavailable')
        with self.assertRaises(RuntimeError): self.clear(refuse)
        async def asynchronous(keys): return None
        with self.assertRaisesRegex(RuntimeError, 'Synchronous'): self.clear(asynchronous)
        self.assertTrue(p.exists()); self.assertFalse(self.pending().exists())

    def test_bounded_inventory_refuses_before_attempt(self):
        p = self.marker(); self.marker('extra')
        with patch.object(cold, 'MAX_ENTRIES', 1), self.assertRaises((RuntimeError, lease.LeaseError)): self.clear()
        with patch.object(cold, 'MAX_BYTES', 1), self.assertRaises(RuntimeError): self.clear()
        self.assertTrue(p.exists()); self.assertFalse(self.pending().exists())
        with self.assertRaises(lease.LeaseError):
            with lease.janitor(str(self.tmp), str(self.paths.scratch), bases=[self.base], max_entries=1, deadline=time.monotonic()+1): pass

    def test_policy_rejects_unknown_fields_host_aliases_and_exposed_host_lease_roots(self):
        self.config['coldTemporaryCleanup']['extra'] = True
        with self.assertRaises(ValueError): cold.policy(self.config)
        self.config['coldTemporaryCleanup'].pop('extra')
        self.config['coldTemporaryCleanup']['hostLeaseDirectories'] = [str(self.paths.scratch)]
        with self.assertRaises(ValueError): cold.policy(self.config)



class ColdNativeAdmissionTests(unittest.TestCase):
    def setUp(self):
        from tests import test_worker_storage as fixtures
        self.fixtures = fixtures
        fixtures.EmployeeStorageTests.setUp(self)
        self.employee.update(desiredRunning=True, onVacation=False)
        fixtures.EmployeeStorageTests.write(self, self.file, self.company)
        self.broker = fixtures.BrokerEmployeeLeaseTests.broker(self)
        self.paths, _ = self.broker.claim_storage(fixtures.OLD)
        from reverie.worker_storage import prepare_storage
        prepare_storage(self.config, self.paths)
        self.tmp = prepare_temporary(self.config, self.paths.scratch)
        st = self.tmp.stat(); self.keys = frozenset({(st.st_dev, st.st_ino)})
        self.items = []; self.drift = False; self.ps = 0
        import subprocess
        def engine(args, optional=False):
            if args == ['ps', '--all', '--quiet', '--no-trunc']:
                self.ps += 1
                ids = [v['Id'] for v in self.items]
                if self.drift and self.ps % 2 == 0: ids.append('b'*64)
                return subprocess.CompletedProcess(args, 0, '\n'.join(ids), '')
            if args[0] == 'inspect':
                return subprocess.CompletedProcess(args, 0, json.dumps(self.items), '')
            raise AssertionError('Native source fixture permits metadata GET only')
        self.broker.run_engine = engine
        import reverie.worker as worker
        fd = os.open(self.tmp, os.O_PATH); mount_id = cold._mount_id(fd); os.close(fd)
        st = self.tmp.stat(); self.device = (os.major(st.st_dev), os.minor(st.st_dev))
        self.extra_id = mount_id + 1000000
        self.host_table = [{'id':mount_id,'device':self.device,'root':Path('/'),'point':Path('/')}]
        self.container_extra = []
        def table(pid='self'):
            if pid == 'self': return list(self.host_table)
            return [{'id':100+i,'device':self.device,'root':Path(m['Source']).resolve(),'point':Path(m['Destination'])}
                    for i,item in enumerate(self.items) for m in item['Mounts']] + list(self.container_extra)
        metadata = patch.object(worker, 'read_mount_table', side_effect=table); metadata.start(); self.addCleanup(metadata.stop)
    def write(self, path, value):
        self.fixtures.EmployeeStorageTests.write(self, path, value)
    def item(self, source, *, rw=False, running=True, name='/other'):
        return {'Id':'a'*64,'Name':name,'State':{'Running':running,'Pid':123 if running else 0,'Paused':False,'Restarting':False},
                'Mounts':[{'Type':'bind','Source':str(source),'Destination':'/owned-bind','RW':rw}]}
    def test_empty_complete_engine_census_and_real_held_storage_lease_pass(self):
        self.assertIsNone(self.broker.admit_cold_temporary(self.paths, self.keys))
        self.assertEqual(self.ps, 2)
    def test_running_reader_writer_and_ancestor_grants_refuse(self):
        for source,rw in [(self.tmp,False),(self.tmp,True),(self.paths.scratch,False)]:
            with self.subTest(rw=rw,source=source):
                self.items=[self.item(source,rw=rw)]
                with self.assertRaisesRegex(RuntimeError,'live container'): self.broker.admit_cold_temporary(self.paths,self.keys)
    def test_unrelated_live_bind_with_exact_namespace_is_allowed(self):
        self.items=[self.item(self.public,rw=True)]
        self.assertIsNone(self.broker.admit_cold_temporary(self.paths,self.keys))

    def test_live_parent_with_nested_same_device_alias_is_refused(self):
        self.items=[self.item(self.public,rw=True)]
        self.host_table.append({'id':self.extra_id,'device':self.device,'root':self.tmp,'point':self.public/'nested'})
        with self.assertRaisesRegex(RuntimeError,'nested protected mount alias'):
            self.broker.admit_cold_temporary(self.paths,self.keys)

    def test_live_parent_with_broader_filesystem_alias_is_refused(self):
        self.items=[self.item(self.public,rw=False)]
        self.host_table.append({'id':self.extra_id,'device':self.device,'root':self.tmp.parent,'point':self.public/'nested'})
        with self.assertRaisesRegex(RuntimeError,'nested protected mount alias'):
            self.broker.admit_cold_temporary(self.paths,self.keys)

    def test_retained_container_private_alias_is_refused_without_host_alias(self):
        self.items=[self.item(self.public,rw=True)]
        self.container_extra=[{'id':999,'device':self.device,'root':self.tmp,'point':Path('/owned-bind/nested')}]
        with self.assertRaisesRegex(RuntimeError,'retains a nested'):
            self.broker.admit_cold_temporary(self.paths,self.keys)

    def test_unknown_relevant_namespace_refuses(self):
        self.items=[self.item(self.public)]
        with patch('reverie.worker.read_mount_table',side_effect=RuntimeError('owned namespace unavailable')):
            with self.assertRaises(RuntimeError): self.broker.admit_cold_temporary(self.paths,self.keys)

    def test_configured_or_live_writable_alias_to_private_marker_root_refuses(self):
        # The same bounded mount proof also protects terminal marker custody.
        self.host_table.append({'id':self.extra_id,'device':self.device,'root':self.paths.root,'point':self.public/'nested'})
        with self.assertRaisesRegex(RuntimeError,'nested protected mount alias'):
            self.broker.admit_cold_temporary(self.paths,self.keys)
        self.host_table.pop(); parent=self.root/'live-parent'; parent.mkdir(mode=0o700)
        self.items=[self.item(parent,rw=True)]
        self.host_table.append({'id':self.extra_id,'device':self.device,'root':self.paths.root,'point':parent/'nested'})
        with self.assertRaisesRegex(RuntimeError,'nested protected mount alias'):
            self.broker.admit_cold_temporary(self.paths,self.keys)

    def test_prior_name_must_be_absent_even_when_stopped(self):
        name='/test-agent-'+self.fixtures.OLD
        self.items=[self.item(self.public,running=False,name=name)]
        with self.assertRaisesRegex(RuntimeError,'Prior named'): self.broker.admit_cold_temporary(self.paths,self.keys)
    def test_changed_inventory_missing_lease_or_owner_pause_refuse(self):
        self.drift=True
        with self.assertRaises(RuntimeError): self.broker.admit_cold_temporary(self.paths,self.keys)
        self.drift=False;self.employee['desiredRunning']=False;self.write(self.file,self.company)
        with self.assertRaises(RuntimeError): self.broker.admit_cold_temporary(self.paths,self.keys)
        self.employee['desiredRunning']=True;self.write(self.file,self.company);self.broker.release_storage(self.fixtures.OLD)
        with self.assertRaisesRegex(RuntimeError,'storage lease'): self.broker.admit_cold_temporary(self.paths,self.keys)

class MountMetadataTests(unittest.TestCase):
    def test_kernel_escape_paths_and_malformed_escape(self):
        self.assertEqual(cold._mount_path(r'/owned\040space'), Path('/owned space'))
        self.assertEqual(cold._mount_path(r'/owned\134slash'), Path('/owned'+chr(92)+'slash'))
        with self.assertRaises(RuntimeError): cold._mount_path(r'/owned\777bad')
    def test_actual_self_namespace_binds_owned_directory_without_engine(self):
        with tempfile.TemporaryDirectory() as directory:
            p=Path(directory).resolve(); table=cold.read_mount_table()
            device,root=cold._mount_location(p,table); st=p.stat()
            self.assertEqual(device,(os.major(st.st_dev),os.minor(st.st_dev))); self.assertTrue(root.is_absolute())

if __name__ == '__main__': unittest.main()
