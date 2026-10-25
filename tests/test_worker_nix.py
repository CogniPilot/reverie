import json
import os
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

from tests import test_worker as fixture
from reverie.worker_nix import private_store, prepare_args, prepare_store

SID = fixture.SID


class LaptopNixTests(unittest.TestCase):
    def setUp(self):
        fixture.WorkerTests.setUp(self)
        self.config['uid'] = os.getuid()

    def test_store_is_private_durable_state_and_rejects_symlink(self):
        path = private_store(self.config, SID)
        self.assertEqual(path, self.root / 'workers' / SID / 'nix')
        self.assertFalse((self.root / 'scratch').exists())
        self.assertEqual(path.stat().st_mode & 0o777, 0o700)
        path.rmdir()
        path.symlink_to(self.root / 'work', target_is_directory=True)
        with self.assertRaises(ValueError):
            private_store(self.config, SID)

    def test_setup_has_no_host_authority_or_account_project_grants(self):
        path = private_store(self.config, SID)
        name, args = prepare_args(self.config, SID, path)
        self.assertIn(SID, name)
        self.assertEqual(args[args.index('--network') + 1], 'none')
        self.assertEqual(args[args.index('--cap-drop') + 1], 'ALL')
        self.assertIn('--read-only', args)
        self.assertEqual(args[args.index('--cpus') + 1], '1')
        mounts = [args[i + 1] for i, item in enumerate(args) if item == '--mount']
        self.assertEqual(mounts, [f'type=bind,src={path},dst=/target/nix'])
        for forbidden in ('docker.sock', 'daemon-socket', 'company.json', '/workspace'):
            self.assertFalse(any(forbidden in value for value in args))
        with self.assertRaises(ValueError):
            prepare_args(self.config, SID, self.root / 'work')

    def test_legacy_image_needs_no_store_or_helper(self):
        broker = SimpleNamespace(run_engine=Mock(return_value=subprocess.CompletedProcess([], 0, json.dumps([{'Config': {'Labels': {}}}]), '')))
        self.assertIsNone(prepare_store(broker, self.config, SID))
        self.assertEqual(broker.run_engine.call_count, 1)
        self.assertFalse((self.root / 'scratch').exists())

    def test_legacy_store_requires_explicit_offline_migration(self):
        legacy=self.root/'scratch'/SID/'nix';legacy.mkdir(mode=0o700,parents=True)
        (legacy/'installed-package').write_text('preserve')
        with self.assertRaisesRegex(RuntimeError,'offline migration'): private_store(self.config,SID)
        self.assertFalse((self.root/'workers'/SID/'nix').exists())
        self.assertEqual((legacy/'installed-package').read_text(),'preserve')

    def test_public_scratch_or_unowned_permissions_are_refused(self):
        for root in (self.root/'scratch'/'state',self.root/'work'/'state'):
            with self.subTest(root=root),self.assertRaises(ValueError):
                private_store(dict(self.config,stateRoot=str(root)),SID)
        path=private_store(self.config,SID);path.chmod(0o755)
        with self.assertRaises(ValueError):private_store(self.config,SID)
        path.chmod(0o700)
        with self.assertRaises(ValueError):private_store(dict(self.config,uid=os.getuid()+1),SID)

    def test_rollback_marker_is_private_and_bound_to_fixed_session_path(self):
        path=private_store(self.config,SID)
        marker=path.parent/'nix-rollback.json'
        marker.write_text(json.dumps({'version':1,'sessionId':SID,'legacy':True}));marker.chmod(0o644)
        with self.assertRaises(ValueError):private_store(self.config,SID)
        marker.chmod(0o600);marker.write_text(json.dumps({'version':1,'sessionId':SID,'legacy':True,'path':'/nix'}))
        with self.assertRaises(ValueError):private_store(self.config,SID)
        marker.write_text(json.dumps({'version':1,'sessionId':SID,'legacy':True}))
        with self.assertRaisesRegex(RuntimeError,'rollback store is unavailable'):private_store(self.config,SID)
