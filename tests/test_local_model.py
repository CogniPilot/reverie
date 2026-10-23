import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('reverie_local_model', Path(__file__).resolve().parents[1] / 'apps/host/local-model.py')
local_model = importlib.util.module_from_spec(spec)
spec.loader.exec_module(local_model)


class LocalModelTests(unittest.TestCase):
    def test_selects_actual_gpu_architecture_instead_of_assuming_a_3090(self):
        for capability in ['8.6', '8.9', '12.0']:
            with self.subTest(capability=capability), patch.object(local_model, 'run', return_value=SimpleNamespace(stdout=f'0, 7.5\n1, {capability}\n')):
                self.assertEqual(local_model.gpu_capability('1'), capability)
        with patch.object(local_model, 'run') as execute:
            self.assertEqual(local_model.gpu_capability('cpu'), '')
            execute.assert_not_called()
        for invalid in ['-1', '0;anything', 'all']:
            with self.assertRaises(ValueError):
                local_model.gpu_capability(invalid)
        with patch.object(local_model, 'run', return_value=SimpleNamespace(stdout='0, N/A\n')):
            with self.assertRaises(ValueError):
                local_model.gpu_capability('0')

    def test_reuses_private_key_and_refuses_symlink_or_public_permissions(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'models/key'
            local_model.private_key(path)
            value = path.read_bytes()
            local_model.private_key(path)
            self.assertEqual(path.read_bytes(), value)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            path.chmod(0o644)
            with self.assertRaises(ValueError):
                local_model.private_key(path)
            path.unlink()
            path.symlink_to(Path(directory) / 'target')
            with self.assertRaises(OSError):
                local_model.private_key(path)

    def test_container_binding_uses_only_the_existing_owner_control_mount(self):
        import json
        row = {'Mounts': [{'Type': 'bind', 'RW': True, 'Destination': '/run/reverie-control', 'Source': '/synthetic/control'}]}
        with patch.object(local_model, 'run', return_value=SimpleNamespace(stdout=json.dumps([row]))):
            self.assertEqual(local_model.container_control('reverie'), Path('/synthetic/control'))
        row['Mounts'][0]['RW'] = False
        with patch.object(local_model, 'run', return_value=SimpleNamespace(stdout=json.dumps([row]))):
            with self.assertRaises(ValueError):
                local_model.container_control('reverie')
        with self.assertRaises(ValueError):
            local_model.container_control('unsafe;name')


if __name__ == '__main__':
    unittest.main()
