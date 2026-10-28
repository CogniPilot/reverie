"""Owned metadata/file/child fixtures only; no engine, GPU, service or provider."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
from reverie import worker_gpu_preflight as P
from reverie.worker_resources import policy_digest
from tests import test_worker_gpu as F


class GPUPreflightTests(unittest.TestCase):
    def setUp(self):
        self.fixture=F.EmployeeGPUTests();self.fixture.setUp();self.addCleanup(self.fixture.doCleanups)
        self.root=self.fixture.root;self.config=self.fixture.config;self.device=self.fixture.device
        self.cdi=self.root/'cdi';self.cdi.mkdir(mode=0o755)
        self.spec=self.cdi/'nvidia.json'
        self.value={'cdiVersion':'0.3.0','kind':'nvidia.com/gpu','devices':[
            {'name':self.device.split('=',1)[1],'containerEdits':{'deviceNodes':[{'path':'/dev/nvidia0'}]}}],
            'containerEdits':{'mounts':[{'hostPath':'/nix/store/synthetic-driver/lib.so',
                'containerPath':'/nix/store/synthetic-driver/lib.so','options':['ro']}],
                'hooks':[{'hookName':'createContainer','path':'/nix/store/synthetic-hook/bin/hook'}]}}
        self.save()
        self.info={'ID':'owned-engine','OSType':'linux','KernelVersion':os.uname().release,
                   'ServerVersion':'29.0.0','CDISpecDirs':[str(self.cdi)]}
        self.image={'Id':self.config['image'],'Config':{'User':f"{self.config['uid']}:{self.config['gid']}",
                    'Labels':{'org.reverie.worker.browser':'1'}}}
        row=self.fixture.company['employees'][0]
        self.native={'Id':'b'*64,'Image':self.config['image'],'Config':{'User':self.image['Config']['User'],
            'Labels':{'reverie.employee':row['id'],'reverie.session':row['sessionId'],
                      'reverie.worker':self.config['deployment'],'reverie.worker-policy':policy_digest(self.config,row['sessionId'])}},
            'State':{'Running':True,'Pid':os.getpid(),'OOMKilled':False,'StartedAt':'2000-01-01T00:00:00Z'},
            'HostConfig':{'ReadonlyRootfs':True,'Memory':4096*1048576,'MemorySwap':4096*1048576,
                          'PidsLimit':512,'Devices':[],'DeviceRequests':None,'CapDrop':['ALL'],'CapAdd':None,
                          'Privileged':False,'PidMode':''}}
        self.calls=[]
    def save(self):self.spec.write_text(json.dumps(self.value));self.spec.chmod(0o644)
    def engine_read(self,args):
        self.calls.append(args)
        if args[:2]==['context','inspect']:return 'unix:///synthetic/owned.sock'
        if args[0]=='info':return copy.deepcopy(self.info)
        if args[:2]==['image','inspect']:return copy.deepcopy(self.image)
        if args[:2]==['container','inspect']:return copy.deepcopy(self.native)
        raise AssertionError('Only fixed metadata routes are available')
    def check(self,**kwargs):
        with patch.object(P,'run',side_effect=self.engine_read),patch.object(P.D,'require_image')as image_guard, \
             patch.object(P,'physical_device',return_value={'uuid':self.device.split('=',1)[1],'deviceMinor':'0'}), \
             patch.dict(os.environ,{'DOCKER_HOST':'unix:///synthetic/owned.sock','DOCKER_CONTEXT':''}):
            result=P.check(self.config,self.fixture.employee,self.device,**kwargs)
            image_guard.assert_called_once_with(self.config,self.image)
            return result

    def test_actual_stores_and_own_process_metadata_do_not_mint_setup_or_compute_authority(self):
        result=self.check(browser=True,spec_sha256=hashlib.sha256(self.spec.read_bytes()).hexdigest())
        self.assertEqual(result['employee']['sessionGeneration'],1)
        self.assertEqual(result['currentLaptop']['process']['pid'],os.getpid())
        self.assertEqual(result['resources']['memoryMiB'],4096)
        self.assertIsNone(result['currentlyConfiguredGrant'])
        self.assertTrue(result['cdi']['hostPolicyReviewRequired'])
        self.assertFalse(result['GPUComputeOrRenderingVerified']);self.assertFalse(result['effectsPerformed'])
        self.assertEqual([x[0]for x in self.calls],['info','image','container','info','container'])
        self.assertNotEqual(result['policyDomain']['before'],result['policyDomain']['proposed'])

    def test_spec_drift_aliases_and_other_images_or_native_limits_refuse(self):
        for mutation in ('digest','case-alias','other-image','limits','binding'):
            with self.subTest(mutation=mutation):
                saved=(copy.deepcopy(self.value),copy.deepcopy(self.image),copy.deepcopy(self.native))
                if mutation=='case-alias':self.value['devices'].append({'name':self.device.split('=',1)[1].upper()});self.save()
                if mutation=='other-image':self.image['Id']='sha256:'+'c'*64
                if mutation=='limits':self.native['HostConfig']['Memory']+=1048576
                if mutation=='binding':self.native['Config']['Labels']['reverie.employee']=self.fixture.other_employee
                kwargs={'spec_sha256':'f'*64}if mutation=='digest'else{}
                with self.assertRaises(ValueError):self.check(**kwargs)
                self.value,self.image,self.native=saved;self.save()

    def test_missing_driver_or_cdi_does_not_require_gpu_for_generic_workers(self):
        self.info['CDISpecDirs']=[]
        with self.assertRaisesRegex(ValueError,'CDI'):self.check()
        self.assertEqual(P.G.gpu_create_args(self.config,self.fixture.session),[])
        self.info['CDISpecDirs']=[str(self.cdi)];self.image['Config']['Labels']={}
        self.assertFalse(self.check()['browserProfile'])
        with self.assertRaisesRegex(ValueError,'browser image'):self.check(browser=True)

    def test_symlink_writable_duplicate_or_oversize_cdi_sources_are_unknown(self):
        original=self.spec.read_bytes()
        self.spec.chmod(0o666)
        with self.assertRaises(ValueError):P.cdi_device([str(self.cdi)],self.device)
        self.spec.chmod(0o644);duplicate=self.cdi/'other.json';duplicate.write_bytes(original)
        with self.assertRaisesRegex(ValueError,'ambiguous'):P.cdi_device([str(self.cdi)],self.device)
        duplicate.unlink();self.spec.unlink();self.spec.symlink_to(self.root/'outside')
        with self.assertRaises(OSError):P.cdi_device([str(self.cdi)],self.device)
        self.spec.unlink();self.spec.write_bytes(b' '*262145)
        with self.assertRaises(ValueError):P.cdi_device([str(self.cdi)],self.device)
        with self.assertRaises(ValueError):P.decode_cdi(b'{"devices":[],"devices":[]}')

    @unittest.skipUnless(importlib.util.find_spec('yaml'),'YAML is verified by the opt-in packaged tool environment')
    def test_yaml_specs_use_safe_unique_alias_free_parser(self):
        import yaml
        self.assertEqual(P.decode_cdi(b'kind: nvidia.com/gpu\ndevices: []\n')['devices'],[])
        for raw in (b'kind: one\nkind: two\n',b'x: &x []\ny: *x\n',b'x: !!python/object/apply:os.system [echo]'):
            with self.assertRaises((ValueError,yaml.YAMLError)):P.decode_cdi(raw)

    def test_owner_intent_drift_after_blocking_metadata_is_reported_not_authorized(self):
        original=self.engine_read
        def changed(args):
            result=original(args)
            if args[:2]==['container','inspect']:
                self.fixture.company['employees'][0]['onVacation']=True;self.fixture.save()
            return result
        with patch.object(P,'run',side_effect=changed),patch.object(P.D,'require_image'), \
             patch.object(P,'physical_device',return_value={'uuid':self.device.split('=',1)[1],'deviceMinor':'0'}), \
             patch.dict(os.environ,{'DOCKER_HOST':'unix:///synthetic/owned.sock','DOCKER_CONTEXT':''}):
            with self.assertRaisesRegex(ValueError,'intent changed'):P.check(self.config,self.fixture.employee,self.device)

    def test_fixed_metadata_child_timeout_and_output_bounds_kill_and_reap(self):
        bin=self.root/'bin';bin.mkdir();tool=bin/'docker';real=P.subprocess.Popen;children=[]
        def capture(*args,**kwargs):
            child=real(*args,**kwargs);children.append(child);return child
        for body in ("import time;time.sleep(2)","print('x'*2048)"):
            tool.write_text('#!'+sys.executable+'\n'+body+'\n');tool.chmod(0o700)
            with patch.object(P,'COMMAND_SECONDS',.1),patch.object(P,'LIMIT',128), \
                 patch.dict(os.environ,{'PATH':str(bin)}),patch.object(P.subprocess,'Popen',side_effect=capture):
                with self.assertRaises((ValueError,P.subprocess.SubprocessError)):P.run(['info','--format',P.INFO_FORMAT])
            self.assertIsNotNone(children[-1].poll());self.assertTrue(children[-1].stdout.closed)

    def test_unknown_commands_formats_and_mutations_refuse_before_spawn(self):
        with patch.object(P.subprocess,'Popen',side_effect=AssertionError('No subprocess may run')):
            for args in (['run','--privileged'],['exec','fixture','sh'],['info'],
                         ['image','inspect','--format',P.IMAGE_FORMAT,'mutable:tag'],
                         ['container','inspect','--format','{{json .Config.Env}}','foreign']):
                with self.assertRaises(ValueError):P.run(args)

    def test_current_kernel_uuid_not_numeric_index_binds_the_cdi_entry(self):
        kernel=self.root/'kernel';kernel.mkdir();gpu=kernel/'0000:01:00.0';gpu.mkdir()
        information=gpu/'information'
        information.write_text('Model: Synthetic GPU\nGPU UUID: '+self.device.split('=',1)[1]+
                               '\nBus Location: 0000:01:00.0\nDevice Minor: 0\n')
        with patch.object(P,'GPU_ROOT',kernel):
            self.assertEqual(P.physical_device(self.device)['deviceMinor'],'0')
            with self.assertRaises(ValueError):P.physical_device('nvidia.com/gpu=GPU-bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee')
            information.write_text('GPU UUID: '+self.device.split('=',1)[1]+'\n')
            with self.assertRaises(ValueError):P.physical_device(self.device)
        self.value['devices'][0]['containerEdits']['deviceNodes'][0]['path']='/dev/nvidia1';self.save()
        with self.assertRaisesRegex(ValueError,'physical node'):self.check()
