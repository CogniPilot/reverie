"""Packaged -I/-B file loading and package loading, over fake owned control ports."""
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

from tests import test_worker as fixture

ROOT = Path(__file__).resolve().parents[1]
WORKER = ROOT / 'python/reverie/worker.py'
CHILD = ROOT / 'tests/fixtures/worker_entry_control.py'
MODES = ('package', 'runpy', 'spec')


class WorkerFileEntryTests(unittest.TestCase):
    def setUp(self):
        case = fixture.WorkerTests(); case.setUp(); self.addCleanup(case.doCleanups)
        self.config = case.root / 'broker.json'
        case.config.update(uid=os.getuid(), gid=os.getgid())
        Path(case.config['companyFile']).write_text(json.dumps({'employees': [{
            'id': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'owner': 'fixture-owner',
            'sessionId': fixture.SID, 'sessionGeneration': 1,
            'desiredRunning': True, 'onVacation': False}]}))
        self.config.write_text(json.dumps(case.config)); self.config.chmod(0o600)

    def control(self, mode, action):
        result = subprocess.run([sys.executable, '-I', '-B', str(CHILD), str(WORKER), mode, action, str(self.config)],
                                env={**os.environ, 'HOME': str(self.config.parent),
                                     'REVERIE_HOME': str(self.config.parent / 'isolated-home')},
                                cwd=self.config.parent, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_status_control_works_in_package_and_file_modes_without_engine_work(self):
        for mode in MODES:
            with self.subTest(mode=mode):
                value = self.control(mode, 'status')
                self.assertEqual(value['kind'], 'J')
                self.assertEqual(value['body']['runningSessionIds'], [])
                self.assertEqual(value['engineCalls'], [])

    def test_first_provider_health_control_imports_real_observer_in_every_entry_mode(self):
        for mode in MODES:
            with self.subTest(mode=mode):
                value = self.control(mode, 'provider-health')
                self.assertEqual(value['kind'], 'J', value)
                health = value['body']['providerHealth']
                self.assertEqual(health['purpose'], 'worker-provider-health-v1')
                self.assertEqual(health['providers'][0]['sessionId'], fixture.SID)
                self.assertEqual(health['providers'][0]['state'], 'unknown')
                self.assertEqual(value['engineCalls'], [['inspect', '--format']] * 2)
                self.assertEqual(value['package'], 'reverie')

    def test_closed_resume_y_and_c_dispatch_have_package_parity(self):
        for mode in MODES:
            with self.subTest(mode=mode):
                value = self.control(mode, 'register')
                self.assertEqual(value['registered'], [os.getuid()]); self.assertTrue(value['eof'])
                value = self.control(mode, 'worker-resume-channel')
                self.assertEqual(value['body'], {'fixtureOwnerUID': os.getuid()})

    def test_foreign_peer_and_extra_provider_selector_still_refuse_before_engine_work(self):
        for mode in MODES:
            for action in ('foreign-status', 'provider-health-with-selector'):
                with self.subTest(mode=mode, action=action):
                    value = self.control(mode, action)
                    self.assertEqual(value['kind'], 'E'); self.assertEqual(value['engineCalls'], [])

    def test_actual_isolated_file_entry_help_remains_available(self):
        result = subprocess.run([sys.executable, '-I', '-B', str(WORKER), '--help'],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr); self.assertIn('broker', result.stdout)

    def test_actual_file_client_controls_reach_the_file_loaded_broker(self):
        for action in ('status', 'provider-health'):
            with self.subTest(action=action):
                value = self.control('cli', action)
                self.assertEqual(value['actualClientReturncode'], 0, value)
                if action == 'provider-health':
                    self.assertEqual(value['body']['providerHealth']['providers'][0]['state'], 'unknown')
                    self.assertEqual(len(value['engineCalls']), 2)
                else:
                    self.assertEqual(value['engineCalls'], [])

    def test_exact_goal_helpers_dispatch_before_broker_loading_in_file_and_module_modes(self):
        code = '''import json,runpy,sys,types
from pathlib import Path
worker,mode,flag=sys.argv[1:]
module=types.ModuleType('reverie.goal_custody_client')
module.main=lambda *,stream:print(json.dumps({'stream':stream}))or 0
sys.modules[module.__name__]=module
sys.argv=[worker,'client',flag]
if mode=='package':
 sys.path.insert(0,str(Path(worker).parents[1]));runpy.run_module('reverie.worker',run_name='__main__')
else:runpy.run_path(worker,run_name='__main__')
'''
        for mode in ('file', 'package'):
            for flag in ('--goal-custody', '--goal-custody-stream'):
                with self.subTest(mode=mode, flag=flag):
                    result = subprocess.run([sys.executable, '-I', '-B', '-c', code, str(WORKER), mode, flag],
                                            cwd=self.config.parent, capture_output=True, text=True, timeout=10)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(json.loads(result.stdout), {'stream': flag.endswith('-stream')})
