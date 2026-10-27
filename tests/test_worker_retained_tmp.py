"""Owned non-destructive namespace controls; never engine/native acceptance."""
from contextlib import contextmanager
import errno
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from reverie import worker_cold_tmp as cold
from reverie import worker_retained_tmp as retained
from reverie.cleanup import lease
from reverie.worker_tmp import prepare_temporary

EMP='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
SID='11111111-2222-4333-8444-555555555555'
IMAGE='sha256:'+'a'*64


class RetainedTemporary(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.base=Path(self.temp.name).resolve()
        root=self.base/'state/employees'/EMP;root.mkdir(mode=0o700,parents=True)
        home=root/'home';home.mkdir(mode=0o700)
        self.paths=SimpleNamespace(kind='employee',identity=EMP,session=SID,root=root,home=home,
                                   scratch=self.base/'scratch/employees'/EMP)
        self.config={'stateRoot':str(self.base/'state'),'scratchRoot':str(self.base/'scratch'),
                     'uid':os.getuid(),'image':IMAGE,'mounts':[],
                     'coldTemporaryCleanup':{'version':1,'enabled':True,'hostLeaseDirectories':[],
                                             'strategy':'retain-and-replace'}}
        cold.initialize_leases(self.config,self.paths,fresh_home=True)
        self.tmp=prepare_temporary(self.config,self.paths.scratch)
        self.old=self.tmp.stat().st_dev,self.tmp.stat().st_ino
        self.marker=self.tmp/'payload';self.marker.write_bytes(b'owned old bytes')
        self.home=self.paths.home/'preserve';self.home.write_bytes(b'durable home')
        self.leasebase=self.paths.home/'.local/state/reverie/leases'
        self.observations={'knownReferences':[],'unknownReferences':[{'pid':10,'kind':'FD_IDENTITY_UNAVAILABLE'}],
                           'counts':{'known':0,'unknown':1},'allInitiallyEnumeratedProcessesVisited':True,
                           'absenceOfReferencesProven':False,'treeWalkPerformed':False}
        self.native={'containerId':'b'*64,'image':IMAGE,'pid':123,'startTick':'456'}

    def prepare(self,**kw):
        return retained.prepare_retained(self.config,self.paths,lambda _keys:None,
                                         references=kw.pop('references',lambda *_a,**_kw:self.observations),**kw)
    def finish(self,ready,callback=None):
        return retained.finish_retained(self.config,self.paths,ready,callback or (lambda:self.native),references=lambda *_a,**_kw:self.observations)
    def pending(self):return self.paths.root/cold.PENDING

    def test_unknown_retains_exact_old_inode_bytes_and_fresh_writable_inode(self):
        ready=self.prepare()
        self.assertEqual(ready.old_key,self.old)
        self.assertEqual((ready.data.stat().st_dev,ready.data.stat().st_ino),self.old)
        self.assertEqual((ready.data/'payload').read_bytes(),b'owned old bytes')
        self.assertNotEqual(ready.new_key,self.old)
        self.assertEqual(list(self.tmp.iterdir()),[])
        (self.tmp/'writable').write_bytes(b'yes')
        self.assertTrue(self.pending().is_file())
        self.assertTrue((ready.envelope/'.keep').is_file())
        reservation=self.leasebase/(lease.key_of(ready.envelope)+'.reserve.json')
        self.assertEqual(lease._reservation_state(self.leasebase,lease.key_of(ready.envelope)),lease.IN_USE)
        self.assertTrue(reservation.is_file())
        result=self.finish(ready)
        self.assertEqual(result['state'],'OLD_TMP_RETAINED_FRESH_TMP_READY')
        self.assertFalse(result['oldDataDeleted']);self.assertFalse(result['deepTreeInspected'])
        self.assertEqual(result['nativeContainer'],self.native)
        self.assertFalse(self.pending().exists())
        self.assertEqual(self.home.read_bytes(),b'durable home')

    def test_known_holder_after_unknown_refuses_before_namespace_change(self):
        obs={**self.observations,'counts':{'known':1,'unknown':1},
             'knownReferences':[{'pid':20,'kind':'FD_REFERENCE'}]}
        with self.assertRaisesRegex(RuntimeError,'Known live'):
            self.prepare(references=lambda *_a,**_kw:obs)
        self.assertEqual(self.tmp.stat().st_ino,self.old[1])
        self.assertEqual(self.marker.read_bytes(),b'owned old bytes')
        self.assertFalse(self.pending().exists())

    def test_active_registered_descendant_refuses(self):
        child=self.tmp/'build';child.mkdir()
        with patch.dict(os.environ,REVERIE_LEASE_DIR=str(self.leasebase)),lease.hold(child,wait=0):
            with self.assertRaises(lease.LeaseError):self.prepare()
        self.assertFalse(self.pending().exists())
        self.assertEqual(self.marker.read_bytes(),b'owned old bytes')

    def rewrite_guest_lease_path(self,key,path):
        for file in self.leasebase.glob(key+'*.json'):
            value=json.loads(file.read_text());value['path']=path;file.write_text(json.dumps(value))

    def test_guest_tmp_descendant_metadata_maps_to_host_and_refuses(self):
        child=self.tmp/'build';child.mkdir()
        with patch.dict(os.environ,REVERIE_LEASE_DIR=str(self.leasebase)),lease.hold(child,wait=0):
            self.rewrite_guest_lease_path(lease.key_of(child),'/tmp/build')
            with self.assertRaisesRegex(lease.LeaseError,'live registered'):self.prepare()
        self.assertFalse(self.pending().exists())

    def test_guest_home_active_task_is_not_misclassified_as_tmp(self):
        child=self.paths.home/'durable-task';child.mkdir()
        with patch.dict(os.environ,REVERIE_LEASE_DIR=str(self.leasebase)),lease.hold(child,wait=0):
            self.rewrite_guest_lease_path(lease.key_of(child),'/home/agent/durable-task')
            ready=self.prepare()
        self.assertEqual((ready.data/'payload').read_bytes(),b'owned old bytes')

    def test_guest_absolute_workspace_symlink_uses_guest_root(self):
        work=self.base/'workspace';work.mkdir();child=work/'task';child.mkdir()
        self.config['mounts']=[{'source':str(work),'destination':'/workspace','readOnly':False}]
        (self.paths.home/'workspace').symlink_to('/workspace',target_is_directory=True)
        with patch.dict(os.environ,REVERIE_LEASE_DIR=str(self.leasebase)),lease.hold(child,wait=0):
            self.rewrite_guest_lease_path(lease.key_of(child),'/home/agent/workspace/task')
            ready=self.prepare()
        self.assertTrue(ready.data.is_dir())

    def test_unresolvable_guest_active_path_is_unknown_and_refuses(self):
        child=self.tmp/'build';child.mkdir()
        with patch.dict(os.environ,REVERIE_LEASE_DIR=str(self.leasebase)),lease.hold(child,wait=0):
            self.rewrite_guest_lease_path(lease.key_of(child),'/tmp/wrong-directory')
            with self.assertRaisesRegex(lease.LeaseError,'cannot be resolved'):self.prepare()
        self.assertFalse(self.pending().exists())

    def test_no_unlink_of_any_old_inode(self):
        original=os.unlink
        def protect(name,*args,**kw):
            if kw.get('dir_fd') is not None:
                value=os.fstat(kw['dir_fd'])
                self.assertNotEqual((value.st_dev,value.st_ino),self.old,'old TMP content unlink')
            return original(name,*args,**kw)
        with patch('os.unlink',protect):
            ready=self.prepare();self.finish(ready)
        self.assertEqual((ready.data/'payload').read_bytes(),b'owned old bytes')

    def test_root_preservation_marker_refuses_but_deep_marker_is_retained(self):
        (self.tmp/'.keep').write_bytes(b'preserve')
        with self.assertRaisesRegex(RuntimeError,'preservation'):self.prepare()
        self.assertFalse(self.pending().exists())
        (self.tmp/'.keep').unlink()
        child=self.tmp/'deep';child.mkdir();(child/'.keep').write_bytes(b'keep old data')
        ready=self.prepare()
        self.assertEqual((ready.data/'deep/.keep').read_bytes(),b'keep old data')
        self.assertFalse(json.loads((self.paths.root/('cold-tmp-retained-ready-'+ready.epoch+'.json')).read_text())['deepTreeInspected'])

    def test_big_sparse_tree_not_walked_or_deleted(self):
        with (self.tmp/'sparse').open('wb') as stream:stream.truncate(3<<30)
        for i in range(4100):(self.tmp/str(i)).touch()
        original=os.scandir
        def no_old_walk(path):
            if isinstance(path,int) and (os.fstat(path).st_dev,os.fstat(path).st_ino)==self.old:
                raise AssertionError('old TMP tree walk')
            if not isinstance(path,int) and Path(path)==self.tmp:raise AssertionError('old TMP tree walk')
            return original(path)
        with patch('os.scandir',no_old_walk):ready=self.prepare()
        self.assertEqual((ready.data/'sparse').stat().st_size,3<<30)
        self.assertEqual(len(list(ready.data.iterdir())),4102)
        self.assertEqual(list(self.tmp.iterdir()),[])

    def test_stage_mkdir_failure_fences_and_policy_removed_still_refuses(self):
        original=os.mkdir
        def fail_stage(name,*a,**kw):
            if str(name).startswith('.cold-fresh-'):raise OSError(errno.EIO,'owned injected mkdir failure')
            return original(name,*a,**kw)
        with patch('os.mkdir',fail_stage):
            with self.assertRaises(OSError):self.prepare()
        self.assertTrue(self.pending().exists())
        self.assertEqual(self.marker.read_bytes(),b'owned old bytes')
        config={k:v for k,v in self.config.items() if k!='coldTemporaryCleanup'}
        with self.assertRaisesRegex(RuntimeError,'reconciliation'):
            cold.clear_cold_temporary(config,self.paths,lambda _keys:None)

    def test_first_rename_lost_result_preserves_old_data_and_fence(self):
        original=retained._rename_noreplace
        def lost(*a):original(*a);raise OSError(errno.EIO,'owned lost rename result')
        with patch.object(retained,'_rename_noreplace',lost):
            with self.assertRaises(OSError):self.prepare()
        self.assertTrue(self.pending().exists());self.assertFalse(self.tmp.exists())
        data=list(retained.retired_root(self.config,self.paths).glob('*/data'))
        self.assertEqual(len(data),1);self.assertEqual((data[0]/'payload').read_bytes(),b'owned old bytes')
        with self.assertRaisesRegex(RuntimeError,'reconciliation'):self.prepare()

    def test_second_rename_lost_result_preserves_both_inodes_and_fence(self):
        original=retained._rename_noreplace;calls=0
        def lost(*a):
            nonlocal calls
            calls+=1;original(*a)
            if calls==2:raise OSError(errno.EIO,'owned lost publication result')
        with patch.object(retained,'_rename_noreplace',lost):
            with self.assertRaises(OSError):self.prepare()
        self.assertTrue(self.pending().exists());self.assertTrue(self.tmp.is_dir())
        self.assertNotEqual(self.tmp.stat().st_ino,self.old[1])
        data=list(retained.retired_root(self.config,self.paths).glob('*/data'))
        self.assertEqual(data[0].stat().st_ino,self.old[1])

    def test_post_rename_directory_fsync_failure_keeps_fence(self):
        rename=retained._rename_noreplace;flush=os.fsync;moved=False;injected=False
        def mark(*args):
            nonlocal moved
            rename(*args);moved=True
        def fail(fd):
            nonlocal injected
            if moved and not injected:
                injected=True;raise OSError(errno.EIO,'owned post-rename directory flush failure')
            return flush(fd)
        with patch.object(retained,'_rename_noreplace',mark),patch('os.fsync',fail):
            with self.assertRaises(OSError):self.prepare()
        self.assertTrue(injected);self.assertTrue(self.pending().exists())
        data=list(retained.retired_root(self.config,self.paths).glob('*/data'))
        self.assertEqual((data[0]/'payload').read_bytes(),b'owned old bytes')
        with self.assertRaisesRegex(RuntimeError,'reconciliation'):self.prepare()

    def test_intent_file_fsync_failure_fences_without_moving_old_root(self):
        flush=os.fsync;injected=False
        def fail(fd):
            nonlocal injected
            if os.readlink('/proc/self/fd/'+str(fd))==str(self.pending()) and not injected:
                injected=True;raise OSError(errno.EIO,'owned intent flush failure')
            return flush(fd)
        with patch('os.fsync',fail):
            with self.assertRaises(OSError):self.prepare()
        self.assertTrue(injected);self.assertTrue(self.pending().exists())
        self.assertEqual(self.tmp.stat().st_ino,self.old[1])
        self.assertEqual(self.marker.read_bytes(),b'owned old bytes')

    def test_actual_noreplace_never_overwrites_existing_destination(self):
        source=self.paths.scratch/'src';source.mkdir();dest=self.paths.scratch/'dest';dest.mkdir()
        (dest/'unique').write_bytes(b'retain')
        fd=os.open(self.paths.scratch,os.O_RDONLY|os.O_DIRECTORY)
        try:
            with self.assertRaises(FileExistsError):retained._rename_noreplace(fd,'src',fd,'dest')
        finally:os.close(fd)
        self.assertTrue(source.is_dir());self.assertEqual((dest/'unique').read_bytes(),b'retain')

    def test_prepared_result_loss_does_not_allow_a_second_rotation(self):
        self.prepare()
        with self.assertRaisesRegex(RuntimeError,'reconciliation'):self.prepare()
        self.assertEqual(len(list(retained.retired_root(self.config,self.paths).glob('*/data'))),1)

    def test_new_host_holder_before_native_commit_keeps_fence(self):
        ready=self.prepare()
        obs={**self.observations,'counts':{'known':1,'unknown':1}}
        with self.assertRaisesRegex(RuntimeError,'appeared before canonical'):
            retained.finish_retained(self.config,self.paths,ready,lambda:self.native,
                                     references=lambda *_a,**_kw:obs)
        self.assertTrue(self.pending().exists())

    def test_new_active_lease_before_native_commit_keeps_fence(self):
        ready=self.prepare()
        with patch.dict(os.environ,REVERIE_LEASE_DIR=str(self.leasebase)),lease.hold(self.tmp,wait=0):
            with self.assertRaises(lease.LeaseError):self.finish(ready)
        self.assertTrue(self.pending().exists())

    def test_native_confirmation_failure_keeps_ready_fenced(self):
        ready=self.prepare()
        def fail():raise RuntimeError('current container binding unknown')
        with self.assertRaisesRegex(RuntimeError,'binding unknown'):self.finish(ready,fail)
        self.assertTrue(self.pending().exists());self.assertTrue((ready.data/'payload').exists())

    def test_epoch_parent_replacement_with_same_data_inode_refuses(self):
        ready=self.prepare()
        preserved=ready.envelope.with_name('preserved-envelope')
        ready.envelope.rename(preserved);ready.envelope.mkdir(mode=0o700)
        (preserved/'data').rename(ready.data)
        (preserved/'.keep').rename(ready.envelope/'.keep')
        with self.assertRaisesRegex(RuntimeError,'envelope custody'):self.finish(ready)
        self.assertTrue(self.pending().exists())
        self.assertEqual((ready.data/'payload').read_bytes(),b'owned old bytes')

    def test_known_durable_outcome_does_not_claim_fence_already_released(self):
        ready=self.prepare();calls=0
        def changed():
            nonlocal calls
            calls+=1;return self.native if calls==1 else {**self.native,'pid':124}
        with self.assertRaisesRegex(RuntimeError,'binding changed'):self.finish(ready,changed)
        outcome=json.loads((self.paths.root/('cold-tmp-retained-'+ready.epoch+'.json')).read_text())
        self.assertEqual(outcome['state'],'OLD_TMP_RETAINED_FRESH_TMP_BOUND_PENDING_RELEASE')
        self.assertEqual(outcome['requiresAbsentFenceForUse'],cold.PENDING)
        self.assertTrue(self.pending().exists())

    def test_session_or_owner_change_cannot_adopt_prepared_epoch(self):
        ready=self.prepare()
        old=self.paths.session
        self.paths.session='99999999-2222-4333-8444-555555555555'
        with self.assertRaisesRegex(RuntimeError,'binding changed'):self.finish(ready)
        self.paths.session=old;self.paths.owner='different-owner'
        with self.assertRaisesRegex(RuntimeError,'binding changed'):self.finish(ready)
        self.assertTrue(self.pending().exists())

    def test_finish_container_drift_keeps_fence(self):
        ready=self.prepare();calls=0
        def changed():
            nonlocal calls
            calls+=1;return self.native if calls==1 else {**self.native,'pid':124}
        with self.assertRaisesRegex(RuntimeError,'binding changed'):self.finish(ready,changed)
        self.assertTrue(self.pending().exists())

    def test_lease_finalizer_failure_keeps_namespace_fenced(self):
        original=lease.retirement
        @contextmanager
        def fail(*a,**kw):
            with original(*a,**kw) as result:yield result
            raise OSError(errno.EIO,'owned lease finalizer failure')
        with patch.object(lease,'retirement',fail):
            with self.assertRaises(OSError):self.prepare()
        self.assertTrue(self.pending().exists());self.assertTrue(self.tmp.is_dir())

    def test_finish_descriptor_close_failure_keeps_fence(self):
        ready=self.prepare();original=os.close;injected=False
        def fail(fd):
            nonlocal injected
            target=os.fstat(fd);matches=(target.st_dev,target.st_ino)==ready.control_stamp[:2]
            original(fd)
            if matches and not injected:
                injected=True;raise OSError(errno.EIO,'owned control finalizer failure')
        with patch('os.close',fail):
            with self.assertRaises(OSError):self.finish(ready)
        self.assertTrue(injected);self.assertTrue(self.pending().exists())
