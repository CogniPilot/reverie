"""Owned path/root FDs and real mount-location checks; engine/guest table ports only."""
import copy
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

from reverie import owner_terminal_bind_sources as B
from reverie import owner_terminal_lifecycle as L
from reverie import worker_cold_tmp as C
from reverie.owner_terminal_native import inventory, physical


class BindSources(unittest.TestCase):
    def setUp(self):
        temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup)
        self.root=Path(temporary.name).resolve()
        self.a=self.root/'a';self.b=self.root/'b'
        for path in (self.a,self.b):path.mkdir(mode=0o700)
        self.alias=self.root/'scratch';self.alias.symlink_to(self.a,target_is_directory=True)
        self.mount={'Type':'bind','Source':str(self.alias),'Destination':str(self.a),'RW':True,'Propagation':'rprivate'}
        self.item={'Id':'a'*64,'Image':'sha256:'+'b'*64,'Name':'/fixture','Config':{'Labels':{}},
                   'State':{'Running':True,'Pid':os.getpid(),'Status':'running','Paused':False,'Restarting':False,'Dead':False},
                   'Mounts':[self.mount]}
        outer=self
        class Engine:
            def get(self,route):
                if route=='/containers/json?all=1':return [B.inspected_row(outer.item)]
                assert route=='/containers/'+'a'*64+'/json'
                return copy.deepcopy(outer.item)
            def guard(self):pass
        self.engine=Engine();self.table=C.read_mount_table()
        device,root=C._mount_location(self.a,self.table)
        self.guest=self.table+[{'id':10**9,'device':device,'root':root,'point':self.a}]
        self.enterContext(patch.object(B,'read_mount_table',side_effect=lambda pid='self':
            copy.deepcopy(self.table if pid=='self' else self.guest)))

    def bound(self):return B.bound_mounts(self.engine,inventory(self.engine))

    def test_original_strict_physical_refuses_alias_and_normal_binding_preserves_spelling(self):
        with self.assertRaisesRegex(ValueError,'PHYSICAL_PATH_REQUIRED'):physical(self.alias)
        with self.bound() as rows:
            self.assertEqual(rows[0].path,self.a)
            self.assertEqual(rows[0].facts['source'],str(self.alias))
            self.assertEqual(rows[0].process['pid'],os.getpid())
            protected=self.root/'protected';protected.mkdir(mode=0o700)
            rows[0].exclude(protected,self.table)  # actual _mount_location FDs
        self.assertEqual(self.mount['Source'],str(self.alias))

    def test_normal_directory_writes_do_not_change_custody(self):
        with self.bound() as rows:
            before=copy.deepcopy(rows[0].facts)
            (self.a/'new-output').write_text('ordinary fixture output');(self.a/'new-directory').mkdir()
            rows[0].check_source();self.assertEqual(rows[0].facts,before)

    def test_pre_capture_retarget_or_replacement_with_real_directory_cannot_hide_old_mount(self):
        for real in (False,True):
            with self.subTest(real=real):
                self.alias.unlink()
                if real:self.alias.mkdir(mode=0o700)
                else:self.alias.symlink_to(self.b,target_is_directory=True)
                with self.assertRaisesRegex(ValueError,'H_BIND_GUEST_SOURCE_CHANGED'):
                    with self.bound():self.fail('different source accepted')
                if real:self.alias.rmdir()
                else:self.alias.unlink()
                self.alias.symlink_to(self.a,target_is_directory=True)

    def test_pre_capture_canonical_replacement_also_requires_old_guest_inode(self):
        self.mount['Source']=str(self.a)
        held=os.open(self.a,os.O_PATH|os.O_DIRECTORY);self.addCleanup(os.close,held)
        self.a.rename(self.root/'retained-a');self.a.mkdir(mode=0o700)
        with patch.object(B,'open_in_root',side_effect=lambda *a,**k:os.dup(held)):
            with self.assertRaisesRegex(ValueError,'H_BIND_GUEST_SOURCE_CHANGED'):
                with self.bound():self.fail('canonical replacement hid old mount')

    def test_foreign_alias_owner_and_link_cycles_refuse(self):
        with patch.object(B.os,'getuid',return_value=os.getuid()+1):
            with self.assertRaisesRegex(ValueError,'H_BIND_ALIAS_OWNER_REQUIRED'):
                with self.bound():self.fail('foreign alias accepted')
        self.alias.unlink();self.alias.symlink_to(self.alias)
        with self.assertRaisesRegex(ValueError,'H_BIND_SOURCE_LINK_BOUND'):B._source(str(self.alias))

    def test_late_retarget_permissions_and_init_change_refuse(self):
        with self.assertRaisesRegex(ValueError,'H_BIND_SOURCE_CHANGED'):
            with self.bound():
                self.alias.unlink();self.alias.symlink_to(self.b,target_is_directory=True)
        self.alias.unlink();self.alias.symlink_to(self.a,target_is_directory=True)
        with self.assertRaisesRegex(ValueError,'H_BIND_ALIAS_PRIVATE_DIRECTORY_REQUIRED'):
            with self.bound():self.a.chmod(0o755)
        self.a.chmod(0o700)
        with self.assertRaisesRegex(ValueError,'H_BIND_CONTAINER_CHANGED'):
            with self.bound():self.item['State']['Pid']+=1000000

    def test_cold_is_prospective_only_and_contradictory_or_null_state_refuses(self):
        self.item['State'].update(Running=False,Pid=0,Status='exited')
        with self.bound() as rows:
            self.assertIsNone(rows[0].process);self.assertIsNone(rows[0].guest_table)
        for changed in ({'Pid':1},{'Running':None},{'Paused':None},{'Restarting':True},{'Dead':True},{'Status':'running'}):
            original=copy.deepcopy(self.item['State']);self.item['State'].update(changed)
            with self.subTest(changed=changed),self.assertRaises((ValueError,KeyError)):
                with self.bound():self.fail('unknown cold state accepted')
            self.item['State']=original

    def test_private_alias_and_nested_kernel_exposure_refuse(self):
        with self.bound() as rows:
            with self.assertRaisesRegex(RuntimeError,'aliases protected storage'):
                rows[0].exclude(self.a,self.table)
            protected=self.root/'protected';protected.mkdir(mode=0o700)
            dev,root=C._mount_location(protected,self.table)
            rows[0].guest_table.append({'id':10**9+1,'device':dev,'root':root,'point':self.a/'hidden'})
            with self.assertRaisesRegex(RuntimeError,'nested protected mount alias'):
                rows[0].exclude(protected,self.table)
            rows[0].guest_table.pop()

    def test_retained_source_survives_old_stop_but_never_retarget_or_close(self):
        with self.bound() as rows:held=rows[0].retain()
        self.addCleanup(held.close)
        self.item['State'].update(Running=False,Pid=0,Status='exited')
        (self.a/'after-stop').write_text('safe churn');held.check_source()
        self.alias.unlink();self.alias.symlink_to(self.b,target_is_directory=True)
        with self.assertRaisesRegex(ValueError,'H_BIND_SOURCE_CHANGED'):held.check_source()
        held.close()
        with self.assertRaisesRegex(ValueError,'H_BIND_PROOF_CLOSED'):held.check_source()

    def test_dup_is_closed_if_ancestor_close_reports_failure(self):
        before=set(os.listdir('/proc/self/fd'));original=B._close;calls=0
        def close(fds):
            nonlocal calls
            calls+=1;original(fds)
            if calls==1:raise OSError('owned close control')
        with patch.object(B,'_close',side_effect=close),self.assertRaises(OSError):B._source(str(self.alias))
        self.assertEqual(set(os.listdir('/proc/self/fd')),before)

    def test_actual_initial_guard_accepts_scratch_alias_with_absent_future_unit(self):
        initial=L.InitialInstallation.__new__(L.InitialInstallation)
        initial.path=self.root/'initial.json';initial.value={'workerConfig':str(self.root/'broker.json')}
        initial.path.write_text(json.dumps(initial.value));initial.path.chmod(0o600)
        initial.identity=L.private_bytes(initial.path)[1]
        initial.roots={name:self.root/name for name in ('controlBase','ledgerBase','bootstrapRoot')}
        for path in initial.roots.values():path.mkdir(mode=0o700)
        initial.root_ids={n:(p.stat().st_dev,p.stat().st_ino,p.stat().st_mode,p.stat().st_uid,p.stat().st_gid)
                          for n,p in initial.roots.items()}
        config={'uid':os.getuid(),'gid':os.getgid(),'mounts':[]}
        for name in ('stateRoot','companyRoot','scratchRoot','apiSocketRoot'):
            path=self.root/name;path.mkdir(mode=0o700);config[name]=str(path)
        Path(initial.value['workerConfig']).write_text('{}');Path(initial.value['workerConfig']).chmod(0o600)
        initial.lock_path=self.root/'update.lock';initial.lock_path.write_bytes(b'')
        initial.engine=self.engine
        home=self.root/'home';unitparent=home/'.config/systemd/user';unitparent.mkdir(parents=True)
        self.assertFalse((unitparent/L.UNIT).exists())
        with patch.dict(os.environ,HOME=str(home)),patch('reverie.worker.load_config',return_value=config):
            self.assertEqual(initial.guard(),config)
        self.assertFalse((unitparent/L.UNIT).exists())


if __name__=='__main__':unittest.main()
