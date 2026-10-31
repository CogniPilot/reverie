"""Real H source producer/entry bindings; owned isolated policy fixture only."""
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import unittest

from tests import test_worker_service_package as package_fixture

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(shutil.which('nix-instantiate'), 'normal Nix evaluator unavailable')
class OwnerTerminalPythonPackageTests(unittest.TestCase):
    def setUp(self):
        self.fixture = package_fixture.WorkerServicePackageTests()
        self.fixture.setUp(); self.addCleanup(self.fixture.doCleanups)
        f = self.fixture
        self.runtime = f.root / 'host-runtime'
        expression = '''let
          root = builtins.toPath SOURCE;
          python = { outPath = PYTHON; interpreter = PYTHON + "/bin/python3"; };
          pkgs = {
            python3 = python; docker-client = "/unused/docker"; systemd = "/unused/systemd";
            bash = "/unused/bash"; coreutils = "/unused/coreutils";
            lib = { getBin = x: x; optionals = b: x: if b then x else []; };
            writeShellApplication = a: a;
            symlinkJoin = a: a.passthru;
            writeText = _: text: text;
            runCommand = name: _: script:
              if name == "reverie-owner-terminal-python-source" then { outPath = RUNTIME; inherit script; }
              else if name == "reverie-worker-task-perf-policy" then PERF
              else { outPath = "/unused/producer"; inherit script; };
          };
          args = { inherit pkgs; src = SOURCE; memory = "/unused/memory"; };
          host = import (root + "/nix/owner-terminal-host.nix") (args // {
            console = "/unused/console"; memoryPackage = "/unused/package"; entrypoint = "/unused/entry";
          });
          lifecycle = import (root + "/nix/owner-terminal-lifecycle.nix") (args // {
            profile = "terminal"; websiteManifest = "/unused/manifest";
            imageProvenance = "/unused/provenance"; toolkit = "/unused/toolkit";
          });
          website = import (root + "/nix/owner-terminal-website.nix") (args // {
            lifecycle = "/unused/lifecycle"; workerUnit = "/unused/unit";
            workerBrokerSource = "/unused/broker-source";
          });
          runtime = import (root + "/nix/owner-terminal-python-source.nix") { inherit pkgs; src = SOURCE; };
        in { producer = runtime.script; host = host.host.text;
          lifecycle = lifecycle.script; website = website.script; }
        '''
        for key, value in {'SOURCE': str(ROOT), 'PYTHON': str(Path(sys.executable).parent.parent),
                           'RUNTIME': str(self.runtime), 'PERF': str(f.perf.parents[1])}.items():
            expression = expression.replace(key, json.dumps(value))
        result = subprocess.run(['nix-instantiate', '--eval', '--strict', '--json', '--expr', expression],
                                capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.package = json.loads(result.stdout)
        result = subprocess.run(['bash', '-euc', self.package['producer']],
                                env=dict(os.environ, out=str(self.runtime)),
                                capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.entry = Path(shlex.split(next(line.strip() for line in self.package['host'].splitlines()
                                         if line.strip().startswith('exec ')))[4])

    def probe(self):
        # Resolve a synthetic current employee and model only the immutable file
        # boundary; leave actual native.policy_digest/artifact validation intact.
        code = '''import json,runpy,sys
from pathlib import Path
from unittest.mock import patch
runpy.run_path(sys.argv[1],run_name='packaged_host_fixture')
from reverie import owner_terminal_native as native,worker_perf as perf,worker_gpu as gpu
manifest=json.loads(Path(sys.argv[2]).read_text());eid='11111111-1111-1111-1111-111111111111'
config={'employeePerfPolicies':{eid:'task-v1'},'rootlessDocker':{
'enabled':True,'seccompProfile':manifest['baseProfile'],'seccompSha256':manifest['baseSHA256']}}
with patch.object(perf,'_read',side_effect=lambda path:Path(path).read_bytes()), \\
     patch.object(gpu,'current_employee',return_value={'id':eid}):
 value=native.policy_digest(config,'22222222-2222-2222-2222-222222222222')
print(json.dumps({'native':native.__file__,'perf':perf.__file__,'policyDigest':value}))
'''
        return subprocess.run([sys.executable, '-I', '-B', '-c', code, str(self.entry),
                               str(self.fixture.perf / 'worker-perf-profile.json')],
                              capture_output=True, text=True, timeout=20)

    def test_host_real_policy_digest_uses_its_produced_perf_runtime(self):
        result = self.probe(); self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.entry, self.runtime / 'scripts/reverie-owner-terminal-host')
        value = json.loads(result.stdout)
        self.assertEqual(value['native'], str(self.runtime / 'python/reverie/owner_terminal_native.py'))
        self.assertEqual(value['perf'], str(self.runtime / 'python/reverie/worker_perf.py'))
        manifest = self.fixture.manifest
        selected = {'rootlessDocker': {'enabled': True, 'seccompProfile': manifest['profile'],
                    'seccompSha256': manifest['profileSHA256']}, '_taskPerfPolicy': 'task-v1'}
        self.assertEqual(value['policyDigest'], hashlib.sha256(json.dumps(selected, sort_keys=True).encode()).hexdigest())
        self.assertFalse((self.runtime / 'python/reverie/worker-resume-program.json').exists())

    def test_lifecycle_host_entry_and_both_local_tools_share_generated_runtime(self):
        for key in ('lifecycle', 'website'):
            with self.subTest(tool=key):
                self.assertIn(str(self.runtime / 'python'), self.package[key])
                self.assertNotIn(str(ROOT / 'python'), self.package[key])
        self.assertIn(str(self.runtime / 'scripts/reverie-owner-terminal-host'), self.package['lifecycle'])
        self.assertEqual((self.runtime / 'python/reverie/worker-perf-profile.json').read_bytes(),
                         (self.fixture.perf / 'worker-perf-profile.json').read_bytes())

    def test_missing_generated_host_manifest_still_refuses(self):
        (self.runtime / 'python/reverie/worker-perf-profile.json').unlink()
        result = self.probe(); self.assertNotEqual(result.returncode, 0)
        self.assertIn('FileNotFoundError', result.stderr)


if __name__ == '__main__':
    unittest.main()
