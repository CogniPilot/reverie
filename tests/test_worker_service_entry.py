"""Actual isolated file entry and canonical API; owned paths, no engine/service."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
from contextlib import redirect_stdout
from io import StringIO


ROOT = Path(__file__).resolve().parents[1]
ENTRY = ROOT / 'python/reverie/worker_service.py'


@unittest.skipIf(os.getuid() == 0 or os.getuid() != os.geteuid(), 'ordinary owner entry requires a non-root real UID')
class WorkerServiceEntryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        config = self.root / 'broker.json'
        config.write_text('{}')
        config.chmod(0o600)
        self.alias = self.root / 'config-alias.json'
        self.alias.symlink_to(config)
        self.operation = self.root / 'operation'
        self.operation.mkdir(mode=0o700)
        empty_path = self.root / 'no-programs'
        empty_path.mkdir(mode=0o700)
        self.env = dict(os.environ, HOME=str(self.root), PATH=str(empty_path))
        for key in ('REVERIE_WORKER_CONFIG', 'REVERIE_WORKER_SERVICE_UNIT',
                    'REVERIE_WORKER_SERVICE_PYTHON', 'REVERIE_WORKER_SERVICE_ENTRY',
                    'DOCKER_HOST', 'DOCKER_CONTEXT'):
            self.env.pop(key, None)

    def invoke(self, prefix, action):
        argv = [sys.executable, '-I', '-B', *prefix, '--config', str(self.alias), '--diagnostic',
                action, '--operation', str(self.operation)]
        if action == 'prepare-worker-image-switch':
            argv += ['--selection', str(self.root / 'never-read-selection.json')]
        else:
            argv += ['--plan-sha256', '0' * 64]
        result = subprocess.run(argv, env=self.env, cwd=self.root, capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(result.stdout, '')
        self.assertEqual(list(self.operation.iterdir()), [])
        self.assertFalse((self.root / '.config').exists())
        return json.loads(result.stderr.splitlines()[-1])

    def check_action(self, action):
        code = ('import sys; sys.path.insert(0, ' + repr(str(ROOT / 'python')) + '); '
                'from reverie.worker_service import main; raise SystemExit(main())')
        canonical = self.invoke(['-c', code], action)
        self.assertEqual(canonical['reason'], 'WORKER_IMAGE_CANONICAL_CONFIG_REQUIRED')
        self.assertEqual(self.invoke([str(ENTRY)], action), canonical)

    def test_file_prepare_reaches_same_canonical_config_guard_as_api(self):
        self.check_action('prepare-worker-image-switch')

    def test_file_apply_reaches_same_canonical_config_guard_as_api(self):
        self.check_action('apply-worker-image-switch')


class WorkerServiceMergedCommandsTests(unittest.TestCase):
    """Both independently added command families survive source integration."""

    def invoke(self, argv):
        from reverie.worker_service import main
        output = StringIO()
        old_umask = os.umask(0o077)
        try:
            with redirect_stdout(output):
                result = main(argv)
        finally:
            os.umask(old_umask)
        self.assertEqual(result, 0)
        return json.loads(output.getvalue())

    def test_mount_prepare_still_dispatches_its_selection_without_provisioning_recovery(self):
        with patch('reverie.worker_service.WorkerService') as service, \
                patch('reverie.worker_mount_relocation.MountRelocation') as relocation, \
                patch('reverie.worker_recovery_auth.provision') as provision:
            relocation.return_value.prepare.return_value = {'prepared': 'mount'}
            self.assertEqual(self.invoke(['prepare-mount-relocation', '--operation', '/fixture/operation',
                                         '--selection', '/fixture/selection']), {'prepared': 'mount'})
            relocation.assert_called_once_with(service.return_value, Path('/fixture/operation'))
            relocation.return_value.prepare.assert_called_once_with(Path('/fixture/selection'))
            provision.assert_not_called()

    def test_mount_apply_still_dispatches_the_exact_plan_without_provisioning_recovery(self):
        with patch('reverie.worker_service.WorkerService'), \
                patch('reverie.worker_mount_relocation.MountRelocation') as relocation, \
                patch('reverie.worker_recovery_auth.provision') as provision:
            relocation.return_value.apply.return_value = {'applied': 'mount'}
            self.assertEqual(self.invoke(['apply-mount-relocation', '--operation', '/fixture/operation',
                                         '--plan-sha256', 'a' * 64]), {'applied': 'mount'})
            relocation.return_value.apply.assert_called_once_with('a' * 64)
            provision.assert_not_called()

    def test_recovery_prepare_still_dispatches_only_through_explicit_preflight(self):
        with patch('reverie.worker_service.WorkerService') as service, \
                patch('reverie.worker_mount_relocation.MountRelocation') as relocation, \
                patch('reverie.worker_recovery_auth.provision') as provision:
            engine = Mock()
            service.return_value.resource_probe.return_value.run_engine = engine
            provision.return_value = {'prepared': 'recovery'}
            self.assertEqual(self.invoke(['prepare-recovery-auth']), {'prepared': 'recovery'})
            service.return_value.positive_preflight.assert_called_once_with()
            service.return_value.resource_probe.assert_called_once_with(service.return_value.positive_preflight.return_value)
            provision.assert_called_once_with(service.return_value.positive_preflight.return_value, engine)
            relocation.assert_not_called()
            engine.assert_not_called()


if __name__ == '__main__':
    unittest.main()
