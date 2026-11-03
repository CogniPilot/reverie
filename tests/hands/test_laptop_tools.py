import json
from pathlib import Path
import tempfile
import unittest

from reverie.hands.laptop_tools import task_paths
from reverie.hands.coding_tasks import control_request, permitted_sender
from reverie.hands.launcher import runtime_settings
from reverie.hands import workspace_dispatch as tools


class LaptopToolsTests(unittest.TestCase):
    def test_read_edit_and_run_real_tests(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'sum.py').write_text('def add(a, b):\n    return a - b\n')
            self.assertTrue(tools.dispatch(str(root), {'version': 1, 'name': 'read_file', 'args': {'path': 'sum.py'}})['ok'])
            edited = tools.dispatch(str(root), {'version': 1, 'name': 'edit_file', 'args': {
                'path': 'sum.py', 'old': 'return a - b', 'new': 'return a + b'}})
            self.assertTrue(edited['ok'])
            (root / 'check.py').write_text('from sum import add\nassert add(2, 3) == 5\n')
            import sys
            result = tools.dispatch(str(root), {'version': 1, 'name': 'run_tests', 'args': {}},
                                    {'test_argv': [sys.executable, 'check.py']})
            self.assertTrue(result['ok'])
            self.assertEqual(result['exit_code'], 0)
            for bad in ('../outside', '/etc/passwd'):
                result = tools.dispatch(str(root), {'version': 1, 'name': 'read_file', 'args': {'path': bad}})
                self.assertFalse(result['ok'])

    def test_task_identity_and_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve(); task = root / 'example'; task.mkdir()
            (task / 'work').mkdir()
            manifest = task / 'manifest.json'
            manifest.write_text(json.dumps({'version': 1, 'task_id': 'example'}))
            self.assertEqual(task_paths(root, task), (task / 'work', manifest))
            (root / 'alias').symlink_to(task)
            with self.assertRaises(ValueError):
                task_paths(root, root / 'alias')
            manifest.write_text(json.dumps({'version': 1, 'task_id': 'different'}))
            with self.assertRaises(ValueError):
                task_paths(root, task)

    def test_external_marker_does_not_grant_authority(self):
        message = {'text': '[external agent] /code example Fix it. @Jester',
                   'from': {'kind': 'agent', 'sessionId': 'external'}}
        self.assertEqual(control_request(message)['task_id'], 'example')
        settings = {'tasks': {'example': {'rooms': ['room'], 'delegate_sessions': []}}}
        self.assertFalse(permitted_sender(settings, 'room', 'example', message))
        settings['tasks']['example']['delegate_sessions'] = ['external']
        self.assertTrue(permitted_sender(settings, 'room', 'example', message))

    def test_private_prompt_budget_is_bounded(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'settings.json'
            path.write_text('{"prompt_cap_chars":120000}'); path.chmod(0o600)
            self.assertEqual(runtime_settings(path)['prompt_cap_chars'], 120000)
            path.write_text('{"prompt_cap_chars":120001}')
            with self.assertRaises(ValueError): runtime_settings(path)
