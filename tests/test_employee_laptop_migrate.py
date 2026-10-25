"""Real tiny same-FS moves/SQLite/locks; synthetic engine, never providers or real data."""
from copy import deepcopy
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock,patch

from tests import test_worker_storage as storage_fixture
EMPLOYEE,OLD,NEW=storage_fixture.EMPLOYEE,storage_fixture.OLD,storage_fixture.NEW
from reverie.employee_laptop_migrate import EmployeeMigration,registered_paths
from reverie.worker_nix_migrate import tree_digest,digest,private_json
from reverie.worker_storage import storage_paths,lock_paths,read_metadata,storage_guard
from reverie.worker_nix import store_guard,private_store,prepare_store


class PairedEmployeeMigrationTests(unittest.TestCase):
    setUpBase=storage_fixture.EmployeeStorageTests.setUp
    write=storage_fixture.EmployeeStorageTests.write

    def setUp(self):
        self.setUpBase()
        self.config.update(deployment='test',image='sha256:'+'b'*64,maxWorkers=12)
        self.sid=self.state/OLD;self.sid.mkdir(mode=0o700)
        self.home=self.sid/'home';self.home.mkdir(mode=0o700)
        self.nix=self.sid/'nix';self.nix.mkdir(mode=0o700)
        (self.home/'.ssh').mkdir(mode=0o700)
        (self.home/'.ssh/config').write_text('synthetic retained SSH config, not credentials')
        self.package='a'*32+'-fixture'
        (self.nix/'store'/self.package).mkdir(parents=True)
        (self.nix/'store'/self.package/'payload').write_bytes(b'registered owned data')
        (self.home/'.nix-profile').symlink_to('/nix/store/'+self.package)
        db=self.nix/'var/nix/db/db.sqlite';db.parent.mkdir(parents=True)
        with closing(sqlite3.connect(db)) as conn:
            conn.execute('CREATE TABLE ValidPaths(path TEXT)')
            conn.execute('INSERT INTO ValidPaths VALUES(?)',('/nix/store/'+self.package,))
            conn.commit()
        self.native={'id':OLD,'mode':'codex','workingDir':'/workspace/retained','subscriptionProfile':{'id':'fixture-account'},
                     'codexConfig':{'resumeSessionId':'11111111-2222-4333-8444-555555555556'},
                     '__envOverrides':{'DO_NOT_EXPORT':'synthetic-secret-must-not-appear'}}
        self.write(self.file.with_name('state.json'),{'sessions':{OLD:self.native}})
        self.item={'Id':'c'*64,'Name':'/test-agent-'+OLD,'Image':'sha256:'+'a'*64,
                   'State':{'Running':False,'Pid':0},'Config':{'Labels':{'reverie.worker':'test','reverie.session':OLD}},
                   'HostConfig':{'Memory':1024,'MemorySwap':1024,'PidsLimit':128},
                   'Mounts':[{'Type':'bind','Source':str(self.home),'Destination':'/home/agent','RW':True},
                             {'Type':'bind','Source':str(self.nix),'Destination':'/nix','RW':True},
                             {'Type':'bind','Source':str(self.public),'Destination':'/workspace','RW':True}]}
        self.items=[self.item];self.migration=EmployeeMigration(self.config)
        def run(args,timeout=120):
            if args[0]=='ps':return ' '.join(row['Id'] for row in self.items)
            if args[0]=='inspect':return json.dumps(self.items)
            raise AssertionError('Migration must never stop/start/exec/create a container')
        self.migration.run=Mock(side_effect=run)
        self.receipt=self.root/'paired-receipt.json'
        self.original_company=deepcopy(self.company)

    def plan(self):
        plan=self.migration.plan(OLD)
        private_json(self.receipt,plan,exclusive=True)
        return plan

    def phase(self,action,plan):
        self.migration.phase(action,plan,lambda value:private_json(self.receipt,value))

    def assert_off(self):
        self.assertEqual(read_metadata(self.file,os.getuid()),self.original_company)
        self.assertTrue(all(call.args[0][0] in ('ps','inspect') for call in self.migration.run.call_args_list))

    def test_full_pair_publication_preserves_inodes_profiles_registered_paths_and_off_intent(self):
        plan=self.plan();old_home=self.home.stat().st_ino;old_nix=self.nix.stat().st_ino
        self.assertNotIn('synthetic-secret-must-not-appear',json.dumps(plan))
        self.assertEqual(plan['runtimeSelection']['codexConfig']['resumeSessionId'],self.native['codexConfig']['resumeSessionId'])
        self.phase('stage',plan);self.assertEqual(plan['phase'],'staged')
        self.assertFalse(self.home.exists());self.assertFalse(self.nix.exists())
        self.phase('publish',plan);paths=storage_paths(self.config,OLD)
        self.assertEqual(plan['phase'],'published')
        self.assertEqual(paths.home.stat().st_ino,old_home);self.assertEqual(paths.nix.stat().st_ino,old_nix)
        self.assertEqual(os.readlink(paths.home/'.nix-profile'),'/nix/store/'+self.package)
        self.assertEqual((paths.home/'.ssh/config').read_text(),'synthetic retained SSH config, not credentials')
        self.assertEqual(registered_paths(paths.nix),plan['registrations'])
        self.assertEqual(read_metadata(self.sid/'storage-owner.json',os.getuid())['employeeId'],EMPLOYEE)
        self.assertEqual(read_metadata(self.sid/'nix-migration.json',os.getuid())['state'],'employee-canonical')
        with store_guard(self.config,OLD):pass  # New broker accepts the fixed legacy-source barrier.
        before=tree_digest(paths.nix,os.getuid())
        self.assertEqual(private_store(self.config,OLD),paths.nix)
        self.assertEqual(tree_digest(paths.nix,os.getuid()),before)
        self.assertFalse(self.nix.exists())  # No empty SID seed/fallback was created.
        self.phase('verify-data',plan);self.assertIn('dataVerifiedAt',plan)
        self.assertEqual(plan['runtimeAcceptance'],'DEFERRED_NO_PROVIDER_STARTED');self.assert_off()

    def test_running_target_or_foreign_writable_parent_refuses_before_moves(self):
        self.item['State']['Running']=True
        with self.assertRaisesRegex(ValueError,'stop'):self.migration.plan(OLD)
        self.item['State']['Running']=False
        writer=deepcopy(self.item);writer.update(Id='d'*64,State={'Running':True})
        writer['Mounts']=[{'Type':'bind','Source':str(self.state),'Destination':'/foreign','RW':True}]
        self.items.append(writer)
        with self.assertRaisesRegex(ValueError,'running container'):self.migration.plan(OLD)
        self.assertTrue(self.home.exists());self.assertTrue(self.nix.exists());self.assert_off()

    def test_each_phase_reads_the_durable_json_receipt_from_the_previous_process(self):
        self.plan()
        for action in ('stage','publish','verify-data'):
            plan=read_metadata(self.receipt,os.getuid())
            self.phase(action,plan)
        published=read_metadata(self.receipt,os.getuid())
        self.assertEqual(published['phase'],'published')
        self.assertIn('dataVerifiedAt',published)
        self.assertFalse(self.home.exists());self.assertFalse(self.nix.exists())
        self.assert_off()

    def test_package_seed_diagnostics_use_the_published_home_after_sid_home_is_moved(self):
        plan=self.plan();self.phase('stage',plan);self.phase('publish',plan)
        paths=storage_paths(self.config,OLD)
        helper='e'*64
        def engine(args,optional=False):
            if args[:2]==['image','inspect']:
                return subprocess.CompletedProcess(args,0,json.dumps([{'Config':{'Labels':{'reverie.worker.nix-store':'1'}}}]),'')
            if args==['inspect',helper]:
                return subprocess.CompletedProcess(args,0,json.dumps([{'State':{'Running':False,'ExitCode':0}}]),'')
            if args[0]=='inspect':return subprocess.CompletedProcess(args,1,'','')
            if args[0]=='create':return subprocess.CompletedProcess(args,0,helper,'')
            if args[0] in ('start','rm'):return subprocess.CompletedProcess(args,0,'','')
            if args[0]=='logs':return subprocess.CompletedProcess(args,0,'synthetic seed completed\n','')
            raise AssertionError(args)
        broker=SimpleNamespace(run_engine=engine,stopping=threading.Event(),allowed=lambda sid:True,nix_prepare_lock=threading.Lock())
        config=dict(self.config,gid=os.getgid(),budgetMode='admission')
        self.assertEqual(prepare_store(broker,config,OLD),paths.nix)
        self.assertEqual((paths.home/'.reverie-nix-prepare.log').read_text(),'synthetic seed completed\n')
        self.assertFalse(self.home.exists())
        self.assert_off()

    def test_intent_native_recipe_and_config_changes_refuse_without_partial_move(self):
        plan=self.plan()
        self.employee['onVacation']=False;self.write(self.file,self.company)
        with self.assertRaisesRegex(ValueError,'intent'):self.phase('stage',plan)
        self.employee['onVacation']=True;self.write(self.file,self.company)
        native=deepcopy(self.native);native['codexConfig']['resumeSessionId']=NEW
        self.write(self.file.with_name('state.json'),{'sessions':{OLD:native}})
        with self.assertRaisesRegex(ValueError,'native'):self.phase('stage',plan)
        self.write(self.file.with_name('state.json'),{'sessions':{OLD:self.native}})
        self.config['image']='sha256:'+'f'*64
        with self.assertRaisesRegex(ValueError,'configuration'):self.phase('stage',plan)
        self.assertTrue(self.home.exists());self.assertTrue(self.nix.exists())

    def test_partial_home_move_is_explicitly_resumable_without_copy_or_overwrite(self):
        plan=self.plan();component=self.migration.component
        def fail_nix(plan,name,stage,save):
            if name=='nix':raise OSError('synthetic interruption after home rename')
            return component(plan,name,stage,save)
        with patch.object(self.migration,'component',side_effect=fail_nix):
            with self.assertRaises(OSError):self.phase('stage',plan)
        self.assertFalse(self.home.exists());self.assertTrue(self.nix.exists())
        self.assertTrue((Path(plan['stage'])/'home/.ssh/config').exists())
        self.phase('stage',plan);self.phase('publish',plan)
        self.assertEqual(plan['phase'],'published');self.assert_off()

    def test_abort_restores_both_latest_components_without_wake(self):
        plan=self.plan();self.phase('stage',plan)
        self.phase('abort',plan)
        self.assertEqual(plan['phase'],'aborted')
        self.assertEqual(tree_digest(self.home,os.getuid()),plan['trees']['home'])
        self.assertEqual(tree_digest(self.nix,os.getuid()),plan['trees']['nix'])
        self.assertFalse((self.sid/'nix-migration.json').exists());self.assert_off()

    def test_conflicting_recreated_old_path_never_overwritten_during_abort(self):
        plan=self.plan();self.phase('stage',plan)
        self.home.mkdir(mode=0o700);(self.home/'unrelated').write_text('retain')
        with self.assertRaisesRegex(ValueError,'conflict'):self.phase('abort',plan)
        self.assertEqual((self.home/'unrelated').read_text(),'retain')
        self.assertTrue((Path(plan['stage'])/'home/.ssh/config').exists());self.assert_off()

    def test_publication_interruption_after_final_rename_resumes_exact_inode(self):
        plan=self.plan();self.phase('stage',plan)
        source=Path(plan['stage']);destination=Path(plan['destination'])
        source.rename(destination)  # kernel completed rename; receipt still staged.
        self.phase('publish',plan)
        self.assertEqual(plan['phase'],'published');self.assert_off()

    def test_published_data_never_rolls_back_to_stale_sid_copy(self):
        plan=self.plan();self.phase('stage',plan);self.phase('publish',plan)
        paths=storage_paths(self.config,OLD);(paths.home/'latest').write_text('new canonical data')
        with self.assertRaisesRegex(ValueError,'authoritative'):self.phase('abort',plan)
        self.assertEqual((paths.home/'latest').read_text(),'new canonical data');self.assert_off()

    def test_foreign_fence_and_existing_canonical_destination_are_never_adopted(self):
        plan=self.plan();paths=storage_paths(self.config,OLD)
        with storage_guard(self.config,OLD,migration=True):
            _lock,fence=lock_paths(self.config,paths);private_json(fence,{'version':1,'token':'f'*32})
        with self.assertRaisesRegex(ValueError,'Foreign'):self.phase('stage',plan)
        self.assertTrue(self.home.exists());self.assertFalse(Path(plan['stage']).exists())
        paths.root.parent.mkdir(mode=0o700,exist_ok=True);paths.root.mkdir(mode=0o700)
        with self.assertRaisesRegex(ValueError,'already exists'):self.migration.plan(OLD)

    def test_registered_missing_path_refuses_even_with_valid_sqlite(self):
        (self.nix/'store'/self.package/'payload').unlink();(self.nix/'store'/self.package).rmdir()
        with self.assertRaisesRegex(ValueError,'Registered Nix path'):self.migration.plan(OLD)

    def test_stopped_legacy_mount_requires_matching_published_sid_preservation(self):
        self.item['Mounts'][1]['Source']=str(self.scratch/OLD/'nix')
        with self.assertRaisesRegex(ValueError,'published preservation receipt'):self.migration.plan(OLD)
        receipt={'session':OLD,'direction':'durable','phase':'published','destination':str(self.nix),
                 'container':self.item['Id'],'config':digest(self.config),'tree':tree_digest(self.nix,os.getuid()),
                 'registrations':registered_paths(self.nix)}
        preservation=self.root/'old-nix-proof.json';private_json(preservation,receipt)
        plan=self.migration.plan(OLD,preservation)
        self.assertEqual(plan['sources']['nix'],str(self.nix));self.assertIsNotNone(plan['nixPreservation'])
        receipt['session']=NEW;private_json(preservation,receipt)
        with self.assertRaisesRegex(ValueError,'does not bind'):self.migration.plan(OLD,preservation)

    def test_private_store_and_guard_both_reject_arbitrary_or_mismatched_v2_barrier(self):
        plan=self.plan();self.phase('stage',plan);self.phase('publish',plan)
        paths=storage_paths(self.config,OLD)
        valid=read_metadata(self.sid/'nix-migration.json',os.getuid())
        invalid=[{'version':2},{**valid,'employeeId':NEW},{**valid,'sessionId':NEW},
                 {**valid,'token':'not-a-token'},{**valid,'extra':'forbidden'},{'version':1,'token':plan['token']}]
        for marker in invalid:
            private_json(self.sid/'nix-migration.json',marker)
            with self.subTest(marker=marker):
                with self.assertRaises((RuntimeError,ValueError)):private_store(self.config,OLD)
                with self.assertRaises((RuntimeError,ValueError)):
                    with store_guard(self.config,OLD):pass
            self.assertFalse(self.nix.exists())
        private_json(self.sid/'nix-migration.json',valid)
        self.assertEqual(private_store(self.config,OLD),paths.nix)

    def test_claude_top_level_native_resume_and_advisor_model_are_pinned(self):
        native={'id':OLD,'mode':'claude','workingDir':'/workspace/retained','model':'fixture-primary',
                'advisorModel':'fixture-advisor','resumeSessionId':'fixture-native-thread','subscriptionProfile':{'id':'fixture-account'}}
        self.write(self.file.with_name('state.json'),{'sessions':{OLD:native}})
        plan=self.plan()
        self.assertEqual(plan['runtimeSelection']['resumeSessionId'],'fixture-native-thread')
        self.assertEqual(plan['runtimeSelection']['advisorModel'],'fixture-advisor')
        for key in ('resumeSessionId','advisorModel'):
            changed={**native,key:'changed'};self.write(self.file.with_name('state.json'),{'sessions':{OLD:changed}})
            with self.subTest(key=key),self.assertRaisesRegex(ValueError,'native'):
                self.phase('stage',plan)
            self.assertTrue(self.home.exists());self.assertTrue(self.nix.exists())
        self.assert_off()

    def test_raw_legacy_recipe_auth_or_env_never_enters_receipt_but_changes_refuse(self):
        self.employee['runtimeRecipe']={'mode':'codex','__envOverrides':{'TOKEN':'synthetic-recipe-secret'},
                                        'legacyProviderConfig':{'auth':'synthetic-auth-secret'}}
        self.write(self.file,self.company);plan=self.plan()
        self.assertNotIn('runtimeRecipe',plan['employee'])
        self.assertNotIn('synthetic-recipe-secret',json.dumps(plan))
        self.assertNotIn('synthetic-auth-secret',json.dumps(plan))
        self.assertEqual(plan['employee']['runtimeRecipeSha256'],digest(self.employee['runtimeRecipe']))
        self.employee['runtimeRecipe']['__envOverrides']['TOKEN']='changed'
        self.write(self.file,self.company)
        with self.assertRaisesRegex(ValueError,'Employee/intent'):self.phase('stage',plan)
        self.assertTrue(self.home.exists());self.assertTrue(self.nix.exists())


if __name__=='__main__':unittest.main()
