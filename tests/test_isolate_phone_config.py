import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('isolate_phone_config', Path(__file__).resolve().parents[1]/'apps/host/isolate.py')
isolate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(isolate)


class IsolatePhoneConfigTests(unittest.TestCase):
    def test_durable_selection_defaults_off_and_requires_a_boolean_for_the_selected_console(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.assertFalse(isolate.admin_phone_wake(root, 'reverie'))
            file = root/'deployment.json'
            for value in (False, True):
                file.write_text(json.dumps({'containerName': 'reverie', 'adminPhoneWake': value}))
                self.assertIs(isolate.admin_phone_wake(root, 'reverie'), value)
            file.write_text(json.dumps({'containerName': 'reverie'}))
            self.assertFalse(isolate.admin_phone_wake(root, 'reverie'))
            for value in ('enabled', 1, None, {}, []):
                file.write_text(json.dumps({'containerName': 'reverie', 'adminPhoneWake': value}))
                with self.assertRaisesRegex(ValueError, 'boolean'):
                    isolate.admin_phone_wake(root, 'reverie')
            file.write_text(json.dumps({'containerName': 'another', 'adminPhoneWake': True}))
            with self.assertRaisesRegex(ValueError, 'select this console'):
                isolate.admin_phone_wake(root, 'reverie')

    def test_isolated_replacement_refreshes_phone_setting_without_losing_other_overrides(self):
        old = {'Config': {'Env': ['BASE=old', 'KEEP=owner', 'REVERIE_ADMIN_PHONE_WAKE=enabled',
                                  'REVERIE_ADMIN_PHONE_WAKE=disabled', 'REVERIE_WORKER_SOCKET=old']}}
        image = {'Config': {'Env': ['BASE=old']}}
        for value in (False, True):
            result = isolate.server_environment(old, image, value)
            self.assertIn('KEEP=owner', result)
            self.assertNotIn('BASE=old', result)
            self.assertEqual([v for v in result if v.startswith('REVERIE_ADMIN_PHONE_WAKE=')],
                             ['REVERIE_ADMIN_PHONE_WAKE=enabled'] if value else [])
            self.assertEqual([v for v in result if v.startswith('REVERIE_WORKER_SOCKET=')],
                             ['REVERIE_WORKER_SOCKET=/run/reverie-workers/broker.sock'])

    def test_activation_rejects_a_changed_phone_selection_before_touching_broker_or_console(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); state = root/'state'; state.mkdir()
            (root/'deployment.json').write_text(json.dumps({'containerName': 'reverie', 'adminPhoneWake': True}))
            (state/'plan.json').write_text(json.dumps({'adminPhoneWake': False}))
            with patch.object(isolate, 'run') as run:
                with self.assertRaisesRegex(ValueError, 'prepare a fresh plan'):
                    isolate.activate(SimpleNamespace(name='reverie'), root, state)
                run.assert_not_called()


    def test_prepare_uses_native_flake_reference_for_all_four_build_targets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); repo = root/'source'; repo.mkdir()
            state = root/'state'; state.mkdir()
            old = {'State': {'Running': True}, 'HostConfig': {'NetworkMode': 'bridge'}}
            calls = []
            def fake_run(args, **kwargs):
                calls.append(args)
                if args[0] == 'docker':
                    return json.dumps([old])
                raise RuntimeError('stop before any build or mutation')
            with patch.object(Path, 'home', return_value=root), patch.object(isolate, 'run', side_effect=fake_run):
                with self.assertRaisesRegex(RuntimeError, 'stop before'):
                    isolate.prepare(SimpleNamespace(name='reverie', repo=str(repo)), root, state)
            build = calls[-1]
            self.assertEqual(build[:2], ['nix', 'build'])
            self.assertEqual(build[-4:], [str(repo.resolve())+'#'+name for name in
                ['dockerImage', 'workerImage', 'workerBroker', 'workerService']])
            self.assertFalse(any(value.startswith('path:') for value in build))
