"""Synthetic canonical profiles/company moves; no engine or host effects."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
from unittest.mock import patch
import unittest

from tests import test_worker as fixture
from reverie.employee_resource_profiles import ProfileStore
from reverie.worker import Broker, create_args, validate_config
from reverie.worker_resources import effective_config, policy_digest, validate_session_resources
from reverie.worker_storage import storage_start_allowed, storage_paths

EID='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
PEER='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
OLD=fixture.SID
NEW='22222222-2222-4222-8222-222222222222'
OTHER='33333333-3333-4333-8333-333333333333'

class EmployeeResourceTests(unittest.TestCase):
    def setUp(self):
        f=fixture.WorkerTests();f.setUp();self.addCleanup(f.doCleanups)
        self.root,self.config=f.root,f.config
        self.config.update(budgetMode='admission',memoryMiB=4096,pidsLimit=512,poolMemoryMiB=49152,poolTasksMax=8192)
        self.resources={k:self.config[k] for k in ('budgetMode','memoryMiB','pidsLimit','cpus','poolMemoryMiB','poolTasksMax')}
        self.resources['memoryMiB']=8192
        self.employee={'id':EID,'sessionId':OLD,'owner':'synthetic-owner','desiredRunning':True,'onVacation':False}
        self.company()

    def company(self,extra=()):
        Path(self.config['companyFile']).write_text(json.dumps({'employees':[self.employee,*extra]}))

    def projected(self):return dict(self.config,employeeResources={EID:self.resources})

    def test_canonical_profile_projection_survives_approved_new_session_move(self):
        directory=self.root/'profiles';directory.mkdir(mode=0o700)
        binding=dict(employee_id=EID,current_sid=OLD,target_sid=OLD,current_generation=1,target_generation=1)
        store=ProfileStore(directory);self.addCleanup(store.close)
        store.put(EID,self.resources,binding,expected_revision=0,expected_profile_version=0,expected_binding=None)
        config=dict(self.config,employeeResources={PEER:dict(self.resources,memoryMiB=2048)})
        staged=store.stage_config(config,EID,binding,expected_revision=1,expected_profile_version=1,sid_owners={OLD:EID})['config']
        self.assertNotIn('employeeResources',self.config)
        self.assertEqual(staged['employeeResources'][EID],store.snapshot()['profiles'][EID]['resources'])
        self.assertEqual(staged['employeeResources'][PEER],config['employeeResources'][PEER])
        self.assertNotIn(NEW,staged['sessionResources'])
        self.employee['sessionId']=NEW;self.company()
        Path(self.config['companyFile']).with_name('plan-moves.json').write_text(json.dumps([
            dict(employeeId=EID,owner=self.employee['owner'],oldSession=OLD,newSession=NEW,phase='completed')]))
        self.assertEqual(effective_config(staged,NEW)['memoryMiB'],8192)
        self.assertEqual(storage_paths(staged,OLD).identity,EID)
        self.assertFalse(storage_start_allowed(staged,storage_paths(staged,OLD)))
        self.assertTrue(storage_start_allowed(staged,storage_paths(staged,NEW)))
        self.assertEqual(validate_config(staged),staged)

    def test_approved_new_sid_inherits_employee_memory_and_global_pool(self):
        config=self.projected();config.update(poolMemoryMiB=51200,poolTasksMax=4096,
                                              resourceReservations={'configured':True})
        self.employee['sessionId']=NEW;self.company()
        policy=effective_config(config,NEW)
        self.assertEqual((policy['memoryMiB'],policy['poolMemoryMiB'],policy['poolTasksMax']),
                         (8192,51200,4096))
        config['sessionResources']={NEW:dict(self.resources,memoryMiB=2048)}
        self.assertEqual(effective_config(config,NEW)['memoryMiB'],2048)
        self.assertEqual(effective_config(config,NEW)['poolMemoryMiB'],51200)

    def test_precedence_and_unrelated_effective_digest_compatibility(self):
        base=policy_digest(self.config,OTHER)
        config=self.projected()
        self.assertEqual(policy_digest(config,OTHER),base)
        self.assertEqual(create_args(config,OTHER,self.root/'home'),create_args(self.config,OTHER,self.root/'home'))
        self.assertEqual(effective_config(config,OLD)['memoryMiB'],8192)
        config['sessionResources']={OLD:dict(self.resources,memoryMiB=2048)}
        self.assertEqual(effective_config(config,OLD)['memoryMiB'],2048)
        self.assertNotIn('employeeResources',effective_config(config,OLD))
        self.assertNotIn('sessionResources',effective_config(config,OLD))
        # A full explicit SID policy never gains a new employee lookup dependency.
        Path(config['companyFile']).write_text('invalid')
        self.assertEqual(effective_config(config,OLD)['memoryMiB'],2048)
        self.assertEqual(effective_config(self.config,OLD)['memoryMiB'],4096)

    def test_ambiguous_or_unavailable_canonical_binding_refuses(self):
        config=self.projected()
        self.company([dict(self.employee,id=PEER)])
        with self.assertRaisesRegex(ValueError,'Ambiguous'):effective_config(config,OLD)
        Path(config['companyFile']).write_text('invalid')
        with self.assertRaises(ValueError):effective_config(config,NEW)
        self.company()
        directory=Path(config['stateRoot'])/OLD;directory.mkdir(parents=True)
        (directory/'storage-owner.json').write_text(json.dumps(dict(version=1,employeeId=PEER,sessionId=OLD,owner='synthetic-owner')))
        with self.assertRaisesRegex(ValueError,'conflicts'):effective_config(config,OLD)

    def test_employee_projection_closed_schema_and_limits(self):
        for value in ({'name':self.resources},{EID:dict(self.resources,command='forbidden')},{EID:dict(self.resources,memoryMiB=True)},[],
                      {f'{i:08x}-aaaa-4aaa-8aaa-aaaaaaaaaaaa':self.resources for i in range(257)}):
            with self.subTest(kind=type(value).__name__),self.assertRaises(ValueError):
                validate_session_resources(dict(self.config,employeeResources=value))

    def test_live_policy_change_refuses_without_disturbing_proxy_or_config(self):
        broker=Broker(self.config,config_file='unused');broker.laptops={OLD:'test-agent-'+OLD}
        terminal,office=object(),object();broker.active={OLD:terminal};broker.offices={OLD:office}
        labels={'reverie.worker':'test','reverie.session':OLD,'reverie.worker-policy':policy_digest(self.config,OLD)}
        broker.run_engine=lambda argv,optional=False:subprocess.CompletedProcess(argv,0,json.dumps([{'Config':{'Labels':labels},'State':{'Running':True}}]))
        with patch('reverie.worker.load_config',return_value=self.projected()),self.assertRaisesRegex(ValueError,'Stop only'):
            broker.control('reload-resources')
        self.assertIs(broker.config,self.config);self.assertIs(broker.active[OLD],terminal);self.assertIs(broker.offices[OLD],office)

    def test_standalone_acceptance_bundle_reuses_exact_projection_labels(self):
        bundle=self.root/'bundle';bundle.mkdir();(bundle/'cleanup').mkdir()
        source=Path(__file__).resolve().parents[1]/'python/reverie'
        for name in ('peer_port','acceptance_io','peer_artifact','host_install'):
            shutil.copyfile(source/'cleanup'/(name+'.py'),bundle/'cleanup'/(name+'.py'))
        for name in ('worker_resources','worker_storage'):
            shutil.copyfile(source/(name+'.py'),bundle/(name+'.py'))
        code="""import importlib.util,json,sys
from pathlib import Path
s=importlib.util.spec_from_file_location('fixed_peer',Path(sys.argv[1])/'cleanup/peer_port.py')
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
c=json.load(sys.stdin)
print(json.dumps(m.expected_labels(c,sys.argv[2])))
"""
        inherited=self.projected();self.employee['sessionId']=NEW;self.company()
        explicit=dict(inherited,sessionResources={NEW:dict(self.resources,memoryMiB=2048)})
        for config in (self.config,inherited,explicit):
            result=subprocess.run([sys.executable,'-I','-B','-c',code,str(bundle),NEW],input=json.dumps(config),capture_output=True,text=True,timeout=5)
            self.assertEqual(result.returncode,0,result.stderr)
            labels=json.loads(result.stdout);effective=effective_config(config,NEW)
            self.assertEqual(labels['workerPolicyHash'],policy_digest(config,NEW))
            self.assertEqual(labels['workerConfigHash'],hashlib.sha256(json.dumps(effective,sort_keys=True).encode()).hexdigest())
        self.company([dict(self.employee,id=PEER)])
        result=subprocess.run([sys.executable,'-I','-B','-c',code,str(bundle),NEW],input=json.dumps(inherited),capture_output=True,text=True,timeout=5)
        self.assertNotEqual(result.returncode,0)
        self.assertEqual(result.stdout,'')
