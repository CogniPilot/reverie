import json
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest

from reverie.worker import create_args, load_config
from reverie.worker_gpu import gpu_create_args, validate_gpu_grants

GPU_LIBRARY_ENV = "LD_LIBRARY_PATH=/usr/local/nvidia/lib64:/usr/local/nvidia/lib"


class WorkerGPUTests(unittest.TestCase):
    session = '11111111-1111-1111-1111-111111111111'
    other = '22222222-2222-2222-2222-222222222222'
    device = 'nvidia.com/gpu=GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

    def test_host_migration_can_import_worker_from_an_explicit_path(self):
        spec = importlib.util.spec_from_file_location('isolated_worker_test', Path(__file__).parents[1] / 'python/reverie/worker.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.assertEqual(module.gpu_create_args({}, self.session), [])

    def test_absent_and_unselected_grants_expose_no_devices(self):
        self.assertEqual(gpu_create_args({}, self.session), [])
        self.assertEqual(gpu_create_args({'gpuGrants': {self.other: self.device}}, self.session), [])
        self.assertEqual(gpu_create_args({'gpuGrants': {self.session: self.device}}, self.session), ['--device', self.device, '--env', GPU_LIBRARY_ENV])

    def test_rejects_broad_devices_paths_flags_and_non_session_grants(self):
        for value in ['nvidia.com/gpu=all', 'nvidia.com/gpu=0', '/dev/nvidia0', '--privileged',
                      self.device + ',all', self.device + '\n--privileged', 0, None]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_gpu_grants({self.session: value})
        for value in [None, [], {self.other.upper(): self.device, '*': self.device}, {'invalid-session': self.device}]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_gpu_grants(value)

    def test_broker_config_and_creation_preserve_resource_and_security_limits(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            project = root / 'project'
            project.mkdir()
            config = dict(version=1, deployment='test', image='sha256:' + 'a' * 64,
                          serverContainer='test-console', socket=str(root / 'control/broker.sock'),
                          stateRoot=str(root / 'homes'), companyFile=str(root / 'company.json'),
                          companyRoot=str(root / 'company'), scratchRoot=str(root / 'scratch'),
                          apiSocketRoot=str(root / 'api'), budgetMode='admission',
                          uid=os.getuid() or 1000, gid=os.getgid() or 1000, memoryMiB=4096,
                          poolMemoryMiB=8192, poolTasksMax=8192, cgroupParent='reverie-workers.slice',
                          pidsLimit=512, cpus=0, maxWorkers=2, maintenanceSessions=[],
                          mounts=[dict(source=str(project), destination='/workspace', readOnly=False)])
            path = root / 'broker.json'
            path.write_text(json.dumps(config))
            path.chmod(0o600)
            self.assertEqual(load_config(path), config)
            config['gpuGrants'] = {self.session: self.device}
            path.write_text(json.dumps(config))
            granted = load_config(path)
            _, _, args = create_args(granted, self.session, root / 'home')
            self.assertEqual(args[args.index('--device') + 1], self.device)
            self.assertEqual(args[args.index('--memory') + 1], '4096m')
            self.assertEqual(args[args.index('--pids-limit') + 1], '512')
            self.assertEqual(args[args.index('--cap-drop') + 1], 'ALL')
            self.assertEqual(args[args.index('--security-opt') + 1], 'no-new-privileges')
            self.assertIn('--read-only', args)
            self.assertNotIn('--cpus', args)
            self.assertNotIn('--privileged', args)
            _, _, ordinary = create_args(granted, self.other, root / 'other-home')
            self.assertNotIn('--device', ordinary)
            def environments(argv):
                return [argv[i + 1] for i, value in enumerate(argv[:-1]) if value == '--env']
            # Preserve every existing container default. Only the selected CDI
            # laptop gains these two fixed guest aliases, with no host paths.
            self.assertEqual(environments(args), environments(ordinary) + [GPU_LIBRARY_ENV])
            self.assertEqual([value for value in environments(ordinary)
                              if value.startswith('LD_LIBRARY_PATH=')], [])
            config['gpuGrants'][self.session] = 'nvidia.com/gpu=all'
            path.write_text(json.dumps(config))
            with self.assertRaises(ValueError):
                load_config(path)


class EmployeeGPUTests(unittest.TestCase):
    employee='11111111-2222-3333-4444-555555555555'
    other_employee='66666666-7777-8888-9999-aaaaaaaaaaaa'
    session=WorkerGPUTests.session
    other=WorkerGPUTests.other
    device=WorkerGPUTests.device
    next_session='33333333-3333-3333-3333-333333333333'

    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve();project=self.root/'project';project.mkdir()
        self.config=dict(version=1,deployment='fixture',image='sha256:'+'a'*64,
            serverContainer='fixture-console',socket=str(self.root/'control/broker.sock'),
            stateRoot=str(self.root/'homes'),companyFile=str(self.root/'company.json'),
            companyRoot=str(self.root/'company'),scratchRoot=str(self.root/'scratch'),
            apiSocketRoot=str(self.root/'api'),budgetMode='admission',uid=os.getuid()or 1000,
            gid=os.getgid()or 1000,memoryMiB=4096,poolMemoryMiB=8192,poolTasksMax=8192,
            cgroupParent='fixture.slice',pidsLimit=512,cpus=0,maxWorkers=2,maintenanceSessions=[],
            mounts=[dict(source=str(project),destination='/workspace',readOnly=False)])
        self.company={'employees':[{'id':self.employee,'sessionId':self.session,'sessionGeneration':1,
            'owner':'fixture-owner','desiredRunning':True,'onVacation':False},
            {'id':self.other_employee,'sessionId':self.other,'sessionGeneration':1,
            'owner':'fixture-owner','desiredRunning':True,'onVacation':False}],'retired':[]}
        self.save()
    def save(self):
        path=Path(self.config['companyFile']);path.write_text(json.dumps(self.company));path.chmod(0o600)

    def test_default_empty_projection_and_other_laptop_labels_remain_byte_exact(self):
        from reverie.worker_resources import policy_digest,effective_config
        before=create_args(self.config,self.other,self.root/'other-home')
        policy=policy_digest(self.config,self.other)
        selected={**self.config,'employeeGpuGrants':{self.employee:self.device}}
        self.assertEqual(create_args(selected,self.other,self.root/'other-home'),before)
        self.assertEqual(policy_digest(selected,self.other),policy)
        self.assertEqual(effective_config({**self.config,'employeeGpuGrants':{}},self.other),self.config)
        _,_,args=create_args(selected,self.session,self.root/'home')
        self.assertEqual(args[args.index('--device')+1],self.device)
        self.assertEqual(args[args.index('--memory')+1],'4096m')
        self.assertEqual(args[args.index('--cap-drop')+1],'ALL')
        self.assertNotIn('employeeGpuGrants',effective_config(selected,self.session))

    def test_current_completed_move_and_restart_inherit_without_granting_historical_sid(self):
        selected={**self.config,'employeeGpuGrants':{self.employee:self.device}}
        self.assertEqual(gpu_create_args(selected,self.session),['--device',self.device,'--env',GPU_LIBRARY_ENV])
        row=self.company['employees'][0];row.update(sessionId=self.next_session,sessionGeneration=2);self.save()
        journal=Path(self.config['companyFile']).with_name('plan-moves.json')
        journal.write_text(json.dumps([{'employeeId':self.employee,'owner':'fixture-owner',
            'oldSession':self.session,'newSession':self.next_session,'phase':'completed'}]));journal.chmod(0o600)
        self.assertEqual(gpu_create_args(selected,self.next_session),['--device',self.device,'--env',GPU_LIBRARY_ENV])
        self.assertEqual(gpu_create_args(selected,self.session),[])
        row['sessionGeneration']=3;self.save()
        self.assertEqual(gpu_create_args(selected,self.next_session),['--device',self.device,'--env',GPU_LIBRARY_ENV])

    def test_explicit_legacy_sid_grant_wins_and_legacy_policy_is_unchanged(self):
        from reverie.worker_resources import effective_config
        override='nvidia.com/gpu=GPU-bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee'
        legacy={**self.config,'gpuGrants':{self.session:override}}
        selected={**legacy,'employeeGpuGrants':{self.employee:self.device}}
        self.assertEqual(effective_config(selected,self.session),legacy)
        self.assertEqual(gpu_create_args(selected,self.session),['--device',override,'--env',GPU_LIBRARY_ENV])
        self.assertEqual(gpu_create_args(legacy,self.session),['--device',override,'--env',GPU_LIBRARY_ENV])

    def test_retired_ambiguous_missing_generation_and_binding_drift_never_mint_a_grant(self):
        from unittest.mock import patch
        from reverie import worker_storage as S
        selected={**self.config,'employeeGpuGrants':{self.employee:self.device}}
        row=self.company['employees'].pop(0);self.company['retired']=[row];self.save()
        self.assertEqual(gpu_create_args(selected,self.session),[])
        self.company['retired']=[];self.company['employees'].append(row);row.pop('sessionGeneration');self.save()
        with self.assertRaises(ValueError):gpu_create_args(selected,self.session)
        row['sessionGeneration']=1;self.company['employees'].append(dict(row));self.save()
        with self.assertRaises(ValueError):gpu_create_args(selected,self.session)
        self.company['employees'].pop();self.save();original=S.storage_paths;calls=0
        def mutate(config,sid):
            nonlocal calls
            result=original(config,sid);calls+=1
            if calls==2:row['sessionGeneration']=2;self.save()
            return result
        with patch.object(S,'storage_paths',side_effect=mutate),self.assertRaisesRegex(ValueError,'binding changed'):
            gpu_create_args(selected,self.session)

    def test_permission_projection_does_not_override_off_or_vacation_execution_gates(self):
        from reverie.worker_storage import storage_paths,storage_start_allowed
        selected={**self.config,'employeeGpuGrants':{self.employee:self.device}}
        for field in ('desiredRunning','onVacation'):
            self.company['employees'][0].update(desiredRunning=True,onVacation=False)
            self.company['employees'][0][field]=field=='onVacation';self.save()
            self.assertEqual(gpu_create_args(selected,self.session),['--device',self.device,'--env',GPU_LIBRARY_ENV])
            self.assertFalse(storage_start_allowed(selected,storage_paths(selected,self.session)))

    def test_flat_resource_bundle_uses_same_projection_and_requires_fixed_gpu_dependency(self):
        from reverie.worker_resources import effective_config
        import shutil
        selected={**self.config,'employeeGpuGrants':{self.employee:self.device}}
        flat=self.root/'flat';flat.mkdir()
        for name in ('worker_resources','worker_gpu','worker_storage'):
            shutil.copy2(Path(__file__).parents[1]/'python/reverie'/f'{name}.py',flat/f'{name}.py')
        spec=importlib.util.spec_from_file_location('flat_gpu_resource_test',flat/'worker_resources.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        self.assertEqual(module.effective_config(selected,self.session),effective_config(selected,self.session))
        (flat/'worker_gpu.py').unlink()
        with self.assertRaises(OSError):module.effective_config(selected,self.session)
