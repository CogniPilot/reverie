"""Actual isolated file entry and canonical API; owned paths, no engine/service."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


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


if __name__ == '__main__':
    unittest.main()
