import json
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest

from reverie.worker import create_args, load_config
from reverie.worker_gpu import gpu_create_args, validate_gpu_grants


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
        self.assertEqual(gpu_create_args({'gpuGrants': {self.session: self.device}}, self.session), ['--device', self.device])

    def test_rejects_broad_devices_paths_flags_and_non_session_grants(self):
        for value in ['nvidia.com/gpu=all', 'nvidia.com/gpu=0', '/dev/nvidia0', '--privileged',
                      self.device + ',all', self.device + '\n--privileged', 0, None]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_gpu_grants({self.session: value})
        for value in [None, [], {self.other.upper(): self.device, '*': self.device}, {'bev': self.device}]:
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
            config['gpuGrants'][self.session] = 'nvidia.com/gpu=all'
            path.write_text(json.dumps(config))
            with self.assertRaises(ValueError):
                load_config(path)
