"""Human aliases are labels, never execution/storage authority; tiny owned data."""
import os
from pathlib import Path
import unittest

from tests import test_worker_storage as fixture
from reverie.worker_storage import storage_paths,storage_guard,prepare_storage,read_metadata
from reverie.worker_storage_labels import label_plan,apply_labels,hostname


class EmployeeLabelTests(unittest.TestCase):
    setUpBase=fixture.EmployeeStorageTests.setUp
    write=fixture.EmployeeStorageTests.write

    def setUp(self):
        self.setUpBase();self.labels=self.root/'labels';self.paths=storage_paths(self.config,fixture.OLD)
        with storage_guard(self.config,fixture.OLD):prepare_storage(self.config,self.paths)

    def test_default_preview_is_readonly_and_alias_has_permanent_identity(self):
        plan=label_plan(self.config,self.labels)
        self.assertFalse(self.labels.exists());self.assertEqual(plan['labels'],{'Kit':fixture.EMPLOYEE})
        self.assertEqual(plan['authority'],'NONE_LABELS_ONLY')
        apply_labels(self.config,self.labels)
        self.assertEqual(os.readlink(self.labels/'Kit'),str(self.paths.root))
        self.assertEqual((self.labels/'Kit/home').resolve(),self.paths.home)
        self.assertEqual((self.labels/'Kit/nix').resolve(),self.paths.nix)
        self.assertEqual(read_metadata(self.file,os.getuid()),self.company)
        self.assertEqual(self.labels.stat().st_mode&0o777,0o700)

    def test_rename_only_changes_label_and_future_hostname_not_data_or_off_intent(self):
        (self.paths.home/'retained').write_text('latest employee data')
        before=self.paths.home.stat().st_ino
        apply_labels(self.config,self.labels)
        self.assertEqual(hostname(self.config,self.paths),'kit-'+fixture.EMPLOYEE[:8])
        self.employee['name']='Quill';self.write(self.file,self.company)
        apply_labels(self.config,self.labels)
        self.assertFalse((self.labels/'Kit').is_symlink())
        self.assertEqual(os.readlink(self.labels/'Quill'),str(self.paths.root))
        self.assertEqual(self.paths.home.stat().st_ino,before)
        self.assertEqual((self.paths.home/'retained').read_text(),'latest employee data')
        self.assertEqual(hostname(self.config,self.paths),'quill-'+fixture.EMPLOYEE[:8])
        self.assertTrue(self.employee['onVacation']);self.assertFalse(self.employee['desiredRunning'])

    def test_casefold_collision_and_unsafe_names_refuse_without_labels(self):
        self.company['employees'].append({**self.employee,'id':fixture.PEER,'sessionId':fixture.NEW,'name':'kit'})
        self.write(self.file,self.company)
        with self.assertRaisesRegex(ValueError,'collision'):label_plan(self.config,self.labels)
        self.company['employees'].pop()
        for value in ('../Kit','Kit/other','.labels.json','Kit\\other','Kit\x00',' Kit','Kit.','Kit\n'):
            self.employee['name']=value;self.write(self.file,self.company)
            with self.subTest(name=value),self.assertRaises(ValueError):label_plan(self.config,self.labels)
        self.assertFalse(self.labels.exists())

    def test_foreign_existing_name_is_never_adopted_or_overwritten(self):
        self.labels.mkdir(mode=0o700);(self.labels/'Kit').symlink_to(self.public,target_is_directory=True)
        with self.assertRaisesRegex(ValueError,'another path'):apply_labels(self.config,self.labels)
        self.assertEqual(os.readlink(self.labels/'Kit'),str(self.public))
        self.assertFalse((self.labels/'.labels.json').exists())

    def test_foreign_modified_old_label_blocks_rename_without_deletion(self):
        apply_labels(self.config,self.labels)
        (self.labels/'Kit').unlink();(self.labels/'Kit').write_text('foreign retained path')
        self.employee['name']='Quill';self.write(self.file,self.company)
        with self.assertRaisesRegex(ValueError,'Foreign'):apply_labels(self.config,self.labels)
        self.assertEqual((self.labels/'Kit').read_text(),'foreign retained path')
        self.assertFalse((self.labels/'Quill').exists())

    def test_label_root_symlinks_and_shared_scratch_data_overlap_refuse(self):
        self.labels.symlink_to(self.public,target_is_directory=True)
        with self.assertRaises(ValueError):apply_labels(self.config,self.labels)
        self.labels.unlink()
        for path in (self.public/'labels',self.scratch/'labels',self.state/'labels',self.root):
            with self.subTest(root=path),self.assertRaises(ValueError):label_plan(self.config,path)
        self.assertEqual(list(self.public.iterdir()),[])

    def test_unpublished_data_cannot_acquire_a_human_alias(self):
        (self.paths.root/'storage.json').unlink()
        with self.assertRaises(FileNotFoundError):apply_labels(self.config,self.labels)
        self.assertFalse((self.labels/'Kit').is_symlink())

    def test_human_name_never_acts_as_employee_or_session_selector(self):
        apply_labels(self.config,self.labels)
        with self.assertRaises(ValueError):storage_paths(self.config,'Kit')
        self.assertEqual(storage_paths(self.config,fixture.OLD).identity,fixture.EMPLOYEE)


if __name__=='__main__':unittest.main()
