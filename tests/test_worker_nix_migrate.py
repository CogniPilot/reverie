import copy
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import unittest
from unittest.mock import patch

from tests import test_worker as fixture
from reverie import worker_nix_migrate as migration_module
from reverie.worker_nix import private_store, store_guard, store_path
from reverie.worker_nix_migrate import Migration, digest, private_json, read_private, registration, tree_digest

SID=fixture.SID
EMPLOYEE='11111111-2222-4333-8444-555555555556'
SENTINEL='/nix/store/'+'b'*32+'-migration-sentinel'


class SyntheticMigration(Migration):
    def __init__(self, config, items):
        super().__init__(config); self.items=items; self.calls=[]

    def containers(self, deployment_only=False): return list(self.items.values())

    def target(self, sid, expected=None):
        item=self.items[sid]
        if expected and item['Id']!=expected: raise ValueError('Exact container identity changed')
        return item

    def run(self,args,timeout=120):
        self.calls.append(args)
        if args[0]=='stop':
            next(x for x in self.items.values() if x['Id']==args[-1])['State'].update(Running=False,Pid=0)
            return ''
        if args[0]=='exec':
            if 'nix-store' in args: return 'sha256:sentinel'
            if 'curl' in args: return '200'
            return '0'
        raise AssertionError(args)


class OfflineNixMigrationTests(unittest.TestCase):
    def setUp(self):
        fixture.WorkerTests.setUp(self); self.config['uid']=os.getuid()
        (self.root/'workers').mkdir(mode=0o700)
        self.state=self.root/'workers'/SID; self.state.mkdir(mode=0o700)
        self.home=self.state/'home';self.home.mkdir(mode=0o700)
        (self.home/'.nix-profile').symlink_to(SENTINEL)
        self.source=self.root/'scratch'/SID/'nix';self.source.mkdir(mode=0o700,parents=True)
        db=self.source/'var/nix/db';db.mkdir(parents=True)
        with closing(sqlite3.connect(db/'db.sqlite')) as conn, conn:
            conn.execute('CREATE TABLE ValidPaths (id INTEGER PRIMARY KEY,path TEXT)')
            conn.execute('INSERT INTO ValidPaths(path) VALUES (?)',(SENTINEL,))
        package=self.source/'store'/Path(SENTINEL).name;package.mkdir(parents=True)
        (package/'sentinel').write_text('non-base installed object\n')
        (package/'sentinel-link').symlink_to('sentinel')
        os.link(package/'sentinel',package/'hardlink')
        gc=self.source/'var/nix/gcroots';gc.mkdir();(gc/'profile').symlink_to('/home/agent/.nix-profile')
        (self.root/'company.json').write_text(json.dumps({'employees':[dict(id=EMPLOYEE,sessionId=SID,desiredRunning=True,onVacation=False,runtimeRecipe={'model':'synthetic-model','subscriptionProfile':{'id':'selected'}})]}))
        self.target=dict(Id='a'*64,Image=self.config['image'],State=dict(Running=True,Pid=123),Config={'Labels':{'reverie.worker':'test','reverie.session':SID}},HostConfig={'Memory':4096},Mounts=[dict(Type='bind',Source=str(p),Destination=d,RW=True) for p,d in [(self.source,'/nix'),(self.home,'/home/agent'),(self.source.parent,'/scratch')]])
        self.migration=SyntheticMigration(self.config,{SID:self.target})
        self.plan=self.migration.plan(SID,sentinel=SENTINEL)
        self.saved=[]

    def phase(self,action): self.migration.phase(action,self.plan,lambda v:self.saved.append(copy.deepcopy(v)))

    def assert_employee_requires_paired_storage(self):
        # These tests qualify the legacy Nix-only DATA executor. Its published
        # SID directory/rollback selector never authorizes a new employee-aware
        # broker to seed an empty home or reopen a stale SID copy.
        canonical=self.root/'workers/employees'/EMPLOYEE/'nix'
        with self.assertRaisesRegex(RuntimeError,'paired offline migration'):
            private_store(self.config,SID)
        self.assertEqual(store_path(self.config,SID),canonical)
        self.assertFalse(canonical.exists())

    def test_offline_copy_preserves_db_objects_profiles_permissions_and_hardlinks(self):
        before=registration(self.source)
        self.phase('quiesce'); self.phase('stage'); self.phase('publish')
        durable=self.state/'nix'
        self.assertEqual(registration(durable),before)
        self.assertEqual(tree_digest(durable,os.getuid()),tree_digest(self.source,os.getuid()))
        package=durable/'store'/Path(SENTINEL).name
        self.assertEqual((package/'sentinel').stat().st_ino,(package/'hardlink').stat().st_ino)
        self.assertEqual(os.readlink(package/'sentinel-link'),'sentinel')
        self.assertEqual(os.readlink(self.home/'.nix-profile'),SENTINEL)
        self.assertEqual(durable.stat().st_mode&0o777,0o700)
        self.assertTrue(self.source.exists()); self.assertFalse(self.migration.fence(self.plan).exists())
        self.assert_employee_requires_paired_storage()
        self.assertEqual([c[0] for c in self.migration.calls],['exec','stop'])

    def test_rollback_copies_latest_writes_and_keeps_both_originals(self):
        self.phase('quiesce'); self.phase('stage'); self.phase('publish')
        durable=self.state/'nix';(durable/'store/new-after-migration').write_text('keep latest installation')
        self.target['Mounts'][0]['Source']=str(durable)
        self.target['Id']='c'*64;self.target['State'].update(Running=True,Pid=456)
        self.plan=self.migration.plan(SID,'legacy',SENTINEL)
        self.phase('quiesce');self.phase('stage');self.phase('publish')
        self.assertEqual((self.source/'store/new-after-migration').read_text(),'keep latest installation')
        self.assertTrue(Path(self.plan['retained']).exists())
        self.assertTrue((durable/'store/new-after-migration').exists())
        self.assert_employee_requires_paired_storage()

    def test_no_copy_before_fence_and_stopped_exact_target(self):
        with self.assertRaises(FileNotFoundError): self.phase('stage')
        self.target['Id']='b'*64
        with self.assertRaises(ValueError): self.phase('quiesce')
        self.assertFalse((self.state/'nix-migration.json').exists())

    def test_running_plan_requires_sentinel_before_any_stop_or_publication(self):
        self.migration.calls.clear()
        with self.assertRaisesRegex(ValueError,'sentinel before planning'):
            self.migration.plan(SID)
        self.assertEqual(self.migration.calls,[])
        self.assertTrue(self.target['State']['Running'])
        self.assertFalse(self.migration.fence(self.plan).exists())
        self.assertFalse((self.state/'nix').exists())

    def test_older_running_receipt_without_sentinel_is_rejected_before_quiescence(self):
        self.plan.update(sentinel=None,sentinelHash=None)
        self.migration.calls.clear()
        with self.assertRaisesRegex(ValueError,'sentinel before quiescence'):self.phase('quiesce')
        self.assertEqual(self.migration.calls,[])
        self.assertTrue(self.target['State']['Running'])
        self.assertFalse(self.migration.fence(self.plan).exists())

    def test_forward_publication_flushes_selector_removal_before_receipt_and_unfencing(self):
        rollback=self.state/'nix-rollback.json'
        private_json(rollback,{'version':1,'sessionId':SID,'legacy':True})
        self.phase('quiesce');self.phase('stage')
        receipts=self.root/'receipts';receipts.mkdir(mode=0o700)
        receipt=receipts/'migration.json';private_json(receipt,self.plan)
        observations=[];sync=migration_module.sync_directory
        def record(path):
            if path==self.state:
                observations.append((rollback.exists(),self.migration.fence(self.plan).exists(),read_private(receipt)['phase']))
            sync(path)
        with patch.object(migration_module,'sync_directory',side_effect=record):
            self.migration.phase('publish',self.plan,lambda value:private_json(receipt,value))
        self.assertEqual(observations,[(False,True,'staged'),(False,False,'published')])
        self.assertEqual(read_private(receipt)['phase'],'published')
        self.assert_employee_requires_paired_storage()

    def test_selector_flush_failure_retains_fence_and_staged_receipt_for_retry(self):
        rollback=self.state/'nix-rollback.json'
        private_json(rollback,{'version':1,'sessionId':SID,'legacy':True})
        self.phase('quiesce');self.phase('stage')
        receipts=self.root/'receipts';receipts.mkdir(mode=0o700)
        receipt=receipts/'migration.json';private_json(receipt,self.plan)
        with patch.object(migration_module,'sync_directory',side_effect=OSError('synthetic fsync failure')):
            with self.assertRaisesRegex(OSError,'synthetic fsync failure'):
                self.migration.phase('publish',self.plan,lambda value:private_json(receipt,value))
        self.assertEqual(read_private(receipt)['phase'],'staged')
        self.assertTrue(self.migration.fence(self.plan).exists())
        self.assertTrue(self.source.exists())
        with self.assertRaisesRegex(RuntimeError,'fenced'):private_store(self.config,SID)
        # An interrupted unlink may reappear after a crash. Recreate that exact
        # selector, then replay the persisted receipt against the published tree.
        private_json(rollback,{'version':1,'sessionId':SID,'legacy':True})
        recovered=read_private(receipt)
        self.migration.phase('publish',recovered,lambda value:private_json(receipt,value))
        self.assertEqual(read_private(receipt)['phase'],'published')
        self.assert_employee_requires_paired_storage()

    def test_reverse_publication_flushes_legacy_selector_before_unfencing(self):
        self.phase('quiesce');self.phase('stage');self.phase('publish')
        self.target['Mounts'][0]['Source']=str(self.state/'nix')
        self.target['Id']='c'*64;self.target['State'].update(Running=True,Pid=456)
        self.plan=self.migration.plan(SID,'legacy',SENTINEL)
        self.phase('quiesce');self.phase('stage')
        observations=[];sync=migration_module.sync_directory
        def record(path):
            if path==self.state:
                observations.append(((self.state/'nix-rollback.json').exists(),self.migration.fence(self.plan).exists(),self.plan['phase']))
            sync(path)
        with patch.object(migration_module,'sync_directory',side_effect=record):self.phase('publish')
        self.assertEqual(observations,[(True,True,'staged'),(True,False,'published')])
        self.assert_employee_requires_paired_storage()

    def test_retry_flushes_absent_selector_before_publishing_the_receipt(self):
        rollback=self.state/'nix-rollback.json'
        private_json(rollback,{'version':1,'sessionId':SID,'legacy':True})
        self.phase('quiesce');self.phase('stage')
        receipts=self.root/'receipts';receipts.mkdir(mode=0o700)
        receipt=receipts/'migration.json';private_json(receipt,self.plan)
        with patch.object(migration_module,'sync_directory',side_effect=OSError('synthetic fsync failure')):
            with self.assertRaises(OSError):
                self.migration.phase('publish',self.plan,lambda value:private_json(receipt,value))
        self.assertFalse(rollback.exists())
        recovered=read_private(receipt);observations=[];sync=migration_module.sync_directory
        def record(path):
            if path==self.state:observations.append((self.migration.fence(recovered).exists(),read_private(receipt)['phase']))
            sync(path)
        with patch.object(migration_module,'sync_directory',side_effect=record):
            self.migration.phase('publish',recovered,lambda value:private_json(receipt,value))
        self.assertEqual(observations,[(True,'staged'),(False,'published')])

    def test_abort_flushes_selector_changes_and_fence_removal(self):
        self.phase('quiesce');self.phase('stage')
        observations=[];sync=migration_module.sync_directory
        def record(path):
            if path==self.state:
                observations.append(((self.state/'nix-rollback.json').exists(),self.migration.fence(self.plan).exists(),self.plan['phase']))
            sync(path)
        with patch.object(migration_module,'sync_directory',side_effect=record):self.phase('abort')
        self.assertEqual(observations,[(True,True,'staged'),(True,False,'aborted')])
        self.assert_employee_requires_paired_storage()

    def test_reverse_abort_flushes_selector_removal_before_unfencing(self):
        self.phase('quiesce');self.phase('stage');self.phase('publish')
        self.target['Mounts'][0]['Source']=str(self.state/'nix')
        self.target['Id']='c'*64;self.target['State'].update(Running=True,Pid=456)
        self.plan=self.migration.plan(SID,'legacy',SENTINEL)
        self.phase('quiesce');self.phase('stage')
        # A reverse publication interrupted after writing its selector can still
        # have a staged receipt. Aborting must durably restore durable selection.
        rollback=self.state/'nix-rollback.json'
        private_json(rollback,{'version':1,'sessionId':SID,'legacy':True})
        observations=[];sync=migration_module.sync_directory
        def record(path):
            if path==self.state:
                observations.append((rollback.exists(),self.migration.fence(self.plan).exists(),self.plan['phase']))
            sync(path)
        with patch.object(migration_module,'sync_directory',side_effect=record):self.phase('abort')
        self.assertEqual(observations,[(False,True,'staged'),(False,False,'aborted')])
        self.assert_employee_requires_paired_storage()

    def test_new_activity_after_plan_requires_fresh_checkpoint_before_stop(self):
        self.target['State']['Pid']=456
        with self.assertRaisesRegex(ValueError,'fresh checkpoint'):self.phase('quiesce')
        self.assertFalse(self.migration.fence(self.plan).exists())
        self.assertFalse(any(c[0]=='stop' for c in self.migration.calls))

    def test_fence_and_sid_lock_cover_overlapping_legacy_data_operations(self):
        with store_guard(self.config,SID,migration=True):
            with self.assertRaises(BlockingIOError): self.phase('quiesce')
        self.phase('quiesce')
        with self.assertRaises(RuntimeError):
            with store_guard(self.config,SID): pass
        with self.assertRaises(RuntimeError): private_store(self.config,SID)

    def test_existing_legacy_fence_refuses_before_employee_binding_lookup(self):
        self.phase('quiesce')
        (self.root/'company.json').write_text(json.dumps({'employees':[{'id':'malformed','sessionId':SID}]}))
        with self.assertRaisesRegex(RuntimeError,'fenced'):private_store(self.config,SID)
        with self.assertRaisesRegex(RuntimeError,'fenced'):
            with store_guard(self.config,SID):pass
        self.assertTrue(self.source.exists())

    def test_other_container_with_write_access_blocks_copy(self):
        self.phase('quiesce')
        self.migration.items['other']=dict(Id='d'*64,State={'Running':True,'Pid':44},Config={'Labels':{}},Mounts=[dict(Type='bind',Source=str(self.source.parent),Destination='/shared',RW=True)])
        # Treat it as a nondeployment writer, not a deployment peer.
        original=self.migration.containers
        self.migration.containers=lambda deployment_only=False:[self.target] if deployment_only else original()
        with self.assertRaisesRegex(ValueError,'running container'): self.phase('stage')
        self.assertFalse(Path(self.plan['stage']).exists())

    def test_copy_mutation_and_db_corruption_leave_fence_and_original(self):
        self.phase('quiesce');self.phase('stage')
        (Path(self.plan['stage'])/'store/changed').write_text('unsafe')
        with self.assertRaisesRegex(ValueError,'Stage changed'):self.phase('publish')
        self.assertTrue(self.migration.fence(self.plan).exists());self.assertTrue(self.source.exists())
        (self.source/'var/nix/db/db.sqlite').write_text('broken')
        with self.assertRaises(sqlite3.DatabaseError): registration(self.source)

    def test_current_recipe_and_running_intent_are_required(self):
        employee=json.loads((self.root/'company.json').read_text());employee['employees'][0]['runtimeRecipe']['model']='other'
        (self.root/'company.json').write_text(json.dumps(employee))
        with self.assertRaisesRegex(ValueError,'runtime recipe'): self.phase('quiesce')
        self.assertFalse(self.migration.fence(self.plan).exists())

    def test_image_skew_requires_explicit_separate_review_before_quiescence(self):
        self.target['Image']='sha256:'+'9'*64
        with self.assertRaisesRegex(ValueError,'image compatibility'):self.migration.plan(SID,sentinel=SENTINEL)
        self.assertFalse(self.migration.fence(self.plan).exists())
        self.plan=self.migration.plan(SID,sentinel=SENTINEL,allow_image_upgrade=True)
        self.assertEqual(self.plan['image'],self.target['Image'])
        self.assertEqual(self.plan['replacementImage'],self.config['image'])
        self.phase('quiesce');self.phase('stage');self.phase('publish')
        self.target['Id']='f'*64;self.target['State'].update(Running=True,Pid=456)
        self.target['Mounts'][0]['Source']=self.plan['destination']
        with self.assertRaisesRegex(ValueError,'image, state or resources'):self.phase('verify')
        self.target['Image']=self.config['image'];self.phase('verify')
        self.assertEqual(self.plan['phase'],'verified')

    def test_abort_restores_explicit_legacy_selection_without_deleting_stage(self):
        self.phase('quiesce');self.phase('stage');self.phase('abort')
        self.assert_employee_requires_paired_storage()
        self.assertTrue(Path(self.plan['stage']).exists())
        self.assertFalse(self.migration.fence(self.plan).exists())

    def test_verified_fresh_recreation_proves_registered_sentinel_and_grants(self):
        self.phase('quiesce');self.phase('stage');self.phase('publish')
        self.target['Id']='f'*64;self.target['State'].update(Running=True,Pid=456)
        self.target['Mounts'][0]['Source']=self.plan['destination']
        self.phase('verify');self.assertEqual(self.plan['phase'],'verified')

    def test_originally_stopped_expert_has_no_automatic_wake(self):
        self.migration.calls.clear()
        self.target['State'].update(Running=False,Pid=0)
        self.plan=self.migration.plan(SID)
        self.phase('quiesce');self.phase('stage');self.phase('publish')
        self.assertFalse(self.target['State']['Running'])
        self.assertFalse(any(c[0] in ('start','create','exec') for c in self.migration.calls))
        self.target['Id']='f'*64;self.target['State'].update(Running=True,Pid=456)
        with self.assertRaisesRegex(ValueError,'must stay stopped'):self.phase('verify')

    def test_receipt_paths_cannot_escape_session_binding(self):
        self.plan['destination']=str(self.root/'other')
        with self.assertRaisesRegex(ValueError,'fixed laptop'):self.phase('quiesce')

    def test_private_receipt_exclusive_and_atomic(self):
        path=self.state/'receipt.json';private_json(path,self.plan,exclusive=True)
        self.assertEqual(read_private(path)['token'],self.plan['token'])
        self.assertEqual(path.stat().st_mode&0o777,0o600)
        with self.assertRaises(FileExistsError):private_json(path,self.plan,exclusive=True)
        path.chmod(0o644)
        with self.assertRaises(ValueError):read_private(path)

    def test_failed_stage_and_interrupted_publish_are_recoverable(self):
        self.phase('quiesce');self.phase('stage')
        Path(self.plan['stage']).rename(self.plan['destination'])
        self.phase('publish')
        self.assertEqual(self.plan['phase'],'published')
        self.assertFalse(self.migration.fence(self.plan).exists())

    def test_committed_wal_after_abrupt_exit_is_copied_consistently(self):
        db=self.source/'var/nix/db/db.sqlite'
        code="import sqlite3,os,sys;c=sqlite3.connect(sys.argv[1]);c.execute('PRAGMA journal_mode=WAL');c.execute(\"INSERT INTO ValidPaths(path) VALUES ('/nix/store/cccccccccccccccccccccccccccccccc-wal-object')\");c.commit();os._exit(0)"
        subprocess.run([sys.executable,'-c',code,str(db)],check=True)
        self.assertTrue(db.with_name('db.sqlite-wal').exists())
        self.phase('quiesce');self.phase('stage');self.phase('publish')
        self.assertEqual(registration(self.state/'nix')['paths'],2)
