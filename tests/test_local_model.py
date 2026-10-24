import importlib.util
import contextlib
import io
import os
import socket
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('reverie_local_model', Path(__file__).resolve().parents[1] / 'apps/host/local-model.py')
local_model = importlib.util.module_from_spec(spec)
spec.loader.exec_module(local_model)


class LocalModelTests(unittest.TestCase):
    def test_vision_projector_and_image_budget_reach_server_and_saved_service_config(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            model = root / 'model.gguf'; model.touch()
            projector = root / 'mmproj.gguf'; projector.touch()
            for service in (False, True):
                with self.subTest(service=service), \
                        patch.object(local_model.Path, 'home', return_value=root), \
                        patch.dict(os.environ, {'REVERIE_MODEL_SCRATCH': str(root / 'scratch'),
                            'REVERIE_MODEL_BUILD_EXPR': '/fixture/build.nix', 'REVERIE_MODEL_NIXPKGS': '/fixture/nixpkgs',
                            'REVERIE_MODEL_SYSTEM': 'x86_64-linux'}), \
                        patch.object(local_model, 'run', return_value=SimpleNamespace(stdout='/fixture/runtime\n')), \
                        patch.object(local_model.os, 'execv') as execute, \
                        patch.object(local_model, 'install_service') as install, contextlib.redirect_stdout(io.StringIO()):
                    argv = ['--model', str(model), '--mmproj', str(projector), '--image-max-tokens', '2048',
                            '--gpu', 'cpu', '--context', '32768', '--sampling-profile', 'qwen3.8-thinking']
                    local_model.main(argv + (['--install-service'] if service else []))
                    if service:
                        config = install.call_args.args[0]
                        self.assertEqual(config['mmproj'], str(projector))
                        self.assertEqual(config['image-max-tokens'], 2048)
                        self.assertEqual(config['sampling-profile'], 'qwen3.8-thinking')
                        execute.assert_not_called()
                    else:
                        args = execute.call_args.args[1]
                        self.assertEqual(args[args.index('--mmproj') + 1], str(projector))
                        self.assertEqual(args[args.index('--image-max-tokens') + 1], '2048')
                        self.assertEqual(args[args.index('--ctx-size') + 1], '32768')
                        self.assertEqual(args[args.index('--temp') + 1], '1.0')

    def test_restart_removes_only_an_abandoned_private_socket(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'model.sock'
            local_model.prepare_socket(path)
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
                listener.bind(str(path))
                path.chmod(0o600)
                listener.listen(1)
                with self.assertRaises(ValueError):
                    local_model.prepare_socket(path)
                self.assertTrue(path.is_socket())
            local_model.prepare_socket(path)
            self.assertFalse(path.exists())
            path.write_text('preserve me')
            with self.assertRaises(ValueError):
                local_model.prepare_socket(path)
            self.assertEqual(path.read_text(), 'preserve me')

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
