"""Evaluate the real native factory and execute its source producer, without a build/engine."""
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest

from reverie.worker_perf import derivative

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(shutil.which('nix-instantiate'), 'normal Nix evaluator unavailable')
class WorkerServicePackageTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.runtime = self.root / 'runtime'
        self.perf = self.root / 'perf/share/reverie'
        self.resume = self.root / 'resume/share/reverie'
        self.perf.mkdir(parents=True); self.resume.mkdir(parents=True)
        base = {'defaultAction': 'SCMP_ACT_ERRNO', 'syscalls': []}
        base_path = self.root / 'base.json'; profile = self.root / 'profile.json'
        base_path.write_text(json.dumps(base)); profile.write_text(json.dumps(derivative(base)))
        system = {'x86_64': 'x86_64-linux', 'aarch64': 'aarch64-linux'}.get(os.uname().machine)
        if system is None:
            self.skipTest('task perf artifact supports x86_64/aarch64 Linux')
        self.manifest = dict(version=1, purpose='worker-task-perf-profile-v1', system=system,
                             baseProfile=str(base_path), baseSHA256=hashlib.sha256(base_path.read_bytes()).hexdigest(),
                             profile=str(profile), profileSHA256=hashlib.sha256(profile.read_bytes()).hexdigest())
        (self.perf / 'worker-perf-profile.json').write_text(json.dumps(self.manifest))
        (self.resume / 'worker-resume-program.json').write_text('{"fixture":true}\n')
        # Constructor ports expose the ACTUAL producer and launcher text. They
        # suppress derivations, package builds and optional console graph work.
        # The real producer below must copy both generated sidecars itself.
        expression = '''let
          root = builtins.toPath SOURCE;
          python = { outPath = PYTHON; withPackages = _: PYTHON; };
          pkgs = {
            python3 = python; docker-client = "/unused/docker";
            systemd = "/unused/systemd"; nix = "/unused/nix";
            writeTextDir = _: _: "/unused/unit";
            writeShellApplication = a: a.text;
            runCommand = name: _: script:
              if name == "reverie-worker-broker-source" then { outPath = RUNTIME; inherit script; }
              else if name == "reverie-worker-task-perf-policy" then PERF
              else if name == "reverie-worker-resume-program" then RESUME
              else throw "unexpected native producer";
          };
          packages = import (root + "/nix/native-worker-packages.nix") {
            inherit pkgs; src = SOURCE; console = "/unused/console";
          };
        in { launcher = packages.workerServiceSetup; checker = packages.workerServiceCheck; producer = packages.workerBrokerSource.script; }
        '''
        for name, value in {'PYTHON': str(Path(sys.executable).parent.parent),
                            'RUNTIME': str(self.runtime), 'PERF': str(self.perf.parents[1]),
                            'RESUME': str(self.resume.parents[1]), 'SOURCE': str(ROOT)}.items():
            expression = expression.replace(name, json.dumps(value))
        result = subprocess.run(['nix-instantiate', '--eval', '--strict', '--json', '--expr', expression],
                                capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        package = json.loads(result.stdout)
        produced = subprocess.run(['bash', '-euc', package['producer']],
                                  env=dict(os.environ, out=str(self.runtime)),
                                  capture_output=True, text=True, timeout=20)
        self.assertEqual(produced.returncode, 0, produced.stderr)
        command = next(line for line in package['launcher'].splitlines() if line.strip().startswith('exec '))
        argv = shlex.split(command)
        self.assertEqual(argv[:4], ['exec', 'python3', '-I', '-B'])
        self.entry = Path(argv[4])
        self.checker = package['checker']

    def probe(self):
        # Run the actual service file bootstrap in a genuinely isolated child.
        # Only the employee resolver and immutable-file boundary are fixture
        # ports: normal artifact shape/hash/derivative and policy code run.
        code = '''import hashlib,json,runpy,sys
from pathlib import Path
from unittest.mock import patch
runpy.run_path(sys.argv[1],run_name='packaged_service_fixture')
from reverie import worker_service as service,worker_service_transport_upgrade as transport
from reverie import worker_perf as perf,worker_gpu as gpu
manifest=json.loads(Path(sys.argv[2]).read_text())
eid='11111111-1111-1111-1111-111111111111'
config={'employeePerfPolicies':{eid:'task-v1'},'rootlessDocker':{
'enabled':True,'seccompProfile':manifest['baseProfile'],'seccompSha256':manifest['baseSHA256']}}
with patch.object(perf,'_read',side_effect=lambda path:Path(path).read_bytes()), \\
     patch.object(gpu,'current_employee',return_value={'id':eid}):
 value=transport.policy_digest(config,'22222222-2222-2222-2222-222222222222')
print(json.dumps({'service':service.__file__,'transport':transport.__file__,
'perf':perf.__file__,'policyDigest':value}))
'''
        return subprocess.run([sys.executable, '-I', '-B', '-c', code, str(self.entry),
                               str(self.perf / 'worker-perf-profile.json')],
                              capture_output=True, text=True, timeout=20)

    def test_service_uses_produced_runtime_and_selected_perf_policy(self):
        result = self.probe()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.entry, self.runtime / 'python/reverie/worker_service.py')
        checker = shlex.split(next(line for line in self.checker.splitlines() if line.strip().startswith('exec ')))
        self.assertEqual(checker, ['exec', 'python3', '-I', '-B', str(self.entry), '$@', 'check-backend'])
        self.assertNotIn('PYTHONPATH', self.checker)
        for name, source in [('worker-perf-profile.json', self.perf), ('worker-resume-program.json', self.resume)]:
            self.assertEqual((self.runtime / 'python/reverie' / name).read_bytes(), (source / name).read_bytes())
        value = json.loads(result.stdout)
        for name, filename in [('service', 'worker_service.py'), ('transport', 'worker_service_transport_upgrade.py'),
                               ('perf', 'worker_perf.py')]:
            self.assertEqual(value[name], str(self.runtime / 'python/reverie' / filename))
        selected = {'rootlessDocker': {'enabled': True, 'seccompProfile': self.manifest['profile'],
                    'seccompSha256': self.manifest['profileSHA256']}, '_taskPerfPolicy': 'task-v1'}
        self.assertEqual(value['policyDigest'], hashlib.sha256(json.dumps(selected, sort_keys=True).encode()).hexdigest())

    def test_missing_generated_perf_sidecar_remains_a_refusal(self):
        (self.runtime / 'python/reverie/worker-perf-profile.json').unlink()
        result = self.probe()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('FileNotFoundError', result.stderr)
        self.assertIn('worker-perf-profile.json', result.stderr)

    def test_generated_profile_digest_mismatch_remains_a_refusal(self):
        Path(self.manifest['profile']).write_text('{}')
        result = self.probe()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Task perf profile differs from the fixed derivative', result.stderr)


if __name__ == '__main__':
    unittest.main()
