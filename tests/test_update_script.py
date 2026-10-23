import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
FAKE = r'''
import json, os, sys
from pathlib import Path
name = Path(sys.argv[0]).name
args = sys.argv[1:]
root = Path(os.environ['UPDATE_TEST_ROOT'])
with (root/'calls').open('a') as out: out.write(json.dumps([name, *args])+'\n')
state = json.loads((root/'state').read_text())
if name == 'nix':
    if os.environ.get('STOP_DURING_BUILD'): state['reverie']['running'] = False
    (root/'state').write_text(json.dumps(state))
    sys.exit(int(os.environ.get('BUILD_FAIL', '0')))
if name == 'curl': print('401'); sys.exit(0)
if args[0] == 'inspect':
    target = args[-1]
    if '--format' in args: print(str(state.get(target, {}).get('running', False)).lower())
    else:
        print(json.dumps([{'Image': 'old-image', 'Config': {'User': '1001:100', 'WorkingDir': '/workspace/task', 'Labels': ({} if os.environ.get('NO_SIGNATURE') else {'reverie.deployment': 'a'*64}), 'Env': ['REVERIE_VERSION=old', 'CUSTOM_INSTANCE=kept']}, 'HostConfig': {'Memory': 8589934592, 'MemorySwap': 8589934592, 'PidsLimit': 512}, 'Mounts': [
            {'Type':'volume','Name':'instance-data','Destination':'/instances','RW':True},
            {'Type':'volume','Name':'private-home','Destination':'/home/agent','RW':True},
            {'Type':'bind','Source':str(root/'source'),'Destination':'/workspace','RW':True},
            {'Type':'bind','Source':str(root/'second disk'),'Destination':'/scratch2','RW':True},
            {'Type':'bind','Source':str(root/'passwd'),'Destination':'/etc/passwd','RW':False}]}]))
elif args[:2] == ['image', 'inspect']: print(json.dumps(['REVERIE_VERSION=old']))
elif args[0] == 'stop': state[args[-1]]['running'] = False
elif args[0] == 'rename': state[args[2]] = state.pop(args[1])
elif args[0] == 'run':
    if os.environ.get('RUN_FAIL'): sys.exit(8)
    state[args[args.index('--name')+1]] = {'running': True, 'image': 'new'}
elif args[0] == 'rm': state.pop(args[-1], None)
elif args[0] == 'start': state[args[-1]]['running'] = True
elif args[0] not in ['load', 'tag']: sys.exit('unexpected '+repr(args))
(root/'state').write_text(json.dumps(state))
'''

@unittest.skipUnless(shutil.which('jq') and shutil.which('flock'), 'host updater requires jq and flock')
class UpdateScriptTests(unittest.TestCase):
    def setUp(self):
        # The updater checks that host Nix build users can traverse every
        # ancestor. Nix's own /build is private, so these host-path fixtures
        # belong in the sandbox's public temporary directory instead.
        self.tmp = tempfile.TemporaryDirectory(dir='/tmp' if os.environ.get('NIX_BUILD_TOP') else None)
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.root.chmod(0o755)
        self.bin = self.root/'bin'; self.bin.mkdir()
        self.repo = self.root/'source'; self.repo.mkdir(); (self.repo/'flake.nix').touch()
        (self.root/'state').write_text(json.dumps({'reverie': {'running': True, 'image': 'old'}}))
        for command in ['docker', 'nix', 'curl']:
            script = self.bin/command
            script.write_text('#!'+sys.executable+'\n'+FAKE)
            script.chmod(0o700)
        if os.environ.get('NIX_BUILD_TOP'):
            # A Nix sandbox may also make / private to its build group. Model
            # the host root as traversable; retain real permission checks on
            # every fixture directory, including the deliberately private one.
            stat = self.bin/'stat'
            stat.write_text('#!'+sys.executable+'\nimport os, sys\n'
                'if sys.argv[1:] == ["-c", "%a", "/"]: print("755")\n'
                f'else: os.execv({shutil.which("stat")!r}, [{shutil.which("stat")!r}, *sys.argv[1:]])\n')
            stat.chmod(0o700)
        self.env = {**os.environ, 'PATH': str(self.bin)+os.pathsep+os.environ['PATH'],
            'UPDATE_TEST_ROOT': str(self.root), 'REVERIE_REPO': str(self.repo),
            'REVERIE_CONTROL_DIR': str(self.root/'control'), 'REVERIE_UPDATE_BUILD_DIR': str(self.root/'build'),
            'REVERIE_UPDATE_STATE_DIR': str(self.root/'host-state'),
            'REVERIE_NIX_BUILD_DIR': str(self.root/'nix-build')}

    def run_update(self, **extra):
        return subprocess.run(['bash', str(ROOT/'scripts/reverie-update')], env={**self.env, **extra}, capture_output=True, text=True)

    def calls(self):
        return [json.loads(line) for line in (self.root/'calls').read_text().splitlines()]

    def test_success_reuses_named_volumes_extra_mounts_and_only_environment_overrides(self):
        result = self.run_update()
        self.assertEqual(result.returncode, 0, result.stderr)
        run = next(call for call in self.calls() if call[:2] == ['docker', 'run'])
        self.assertIn('--init', run)
        self.assertIn('type=volume,src=instance-data,dst=/instances', run)
        self.assertIn('type=volume,src=private-home,dst=/home/agent', run)
        self.assertIn(f'type=bind,src={self.root}/second disk,dst=/scratch2', run)
        self.assertIn('CUSTOM_INSTANCE=kept', run)
        self.assertNotIn('REVERIE_VERSION=old', run)
        self.assertIn('unless-stopped', run)
        self.assertIn('reverie.deployment='+'a'*64, run)
        for flag, value in [('--user', '1001:100'), ('--workdir', '/workspace/task'),
                            ('--memory', '8589934592'), ('--memory-swap', '8589934592'), ('--pids-limit', '512')]:
            self.assertEqual(run[run.index(flag)+1], value)
        self.assertIn(f'type=bind,src={self.root}/passwd,dst=/etc/passwd,readonly', run)
        self.assertFalse(any('--volumes' in call for call in self.calls()))
        self.assertEqual(json.loads((self.root/'state').read_text()), {'reverie': {'running': True, 'image': 'new'}})

    def test_owner_adopts_unlabelled_deployment_and_adds_readonly_gpu_directory(self):
        gpu = self.root/'gpu'; gpu.mkdir()
        result = self.run_update(NO_SIGNATURE='1', REVERIE_DEPLOYMENT_SIGNATURE='b'*64, REVERIE_GPU_PUBLISHED_DIR=str(gpu))
        self.assertEqual(result.returncode, 0, result.stderr)
        run = next(call for call in self.calls() if call[:2] == ['docker', 'run'])
        self.assertIn('reverie.deployment='+'b'*64, run)
        self.assertIn(f'type=bind,src={gpu},dst=/host-published,readonly', run)

    def test_build_scratch_is_traversable_but_metadata_remains_private(self):
        result = self.run_update()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root/'nix-build').stat().st_mode & 0o777, 0o755)
        self.assertEqual((self.root/'build').stat().st_mode & 0o777, 0o700)
        call = next(call for call in self.calls() if call[0] == 'nix')
        self.assertEqual(call[call.index('build-dir')+1], str((self.root/'nix-build').resolve()))

    def test_inaccessible_build_scratch_fails_before_stopping_live_container(self):
        private = self.root/'private'; private.mkdir(mode=0o700)
        result = self.run_update(REVERIE_NIX_BUILD_DIR=str(private/'nix-build'))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('not traversable', result.stderr)
        self.assertFalse(any(call[:2] == ['docker', 'stop'] for call in self.calls()))

    def test_failed_build_never_stops_current_container(self):
        self.assertNotEqual(self.run_update(BUILD_FAIL='9').returncode, 0)
        self.assertFalse(any(call[:2] == ['docker', 'stop'] for call in self.calls()))

    def test_replacement_failure_restores_original_container(self):
        self.assertNotEqual(self.run_update(RUN_FAIL='1').returncode, 0)
        self.assertEqual(json.loads((self.root/'state').read_text()), {'reverie': {'running': True, 'image': 'old'}})

    def test_stop_during_build_is_not_resurrected(self):
        self.assertNotEqual(self.run_update(STOP_DURING_BUILD='1').returncode, 0)
        self.assertFalse(any(call[:2] in (['docker', 'stop'], ['docker', 'run'], ['docker', 'start']) for call in self.calls()))

    def test_request_helper_only_touches_the_fixed_request_file_and_rejects_payloads(self):
        control = self.root/'control'; control.mkdir()
        helper = ROOT/'scripts/reverie-request-update'
        result = subprocess.run(['bash', str(helper)], env=self.env, capture_output=True)
        self.assertEqual(result.returncode, 0)
        self.assertEqual([p.name for p in control.iterdir()], ['update.request'])
        self.assertNotEqual(subprocess.run(['bash', str(helper), 'arbitrary command'], env=self.env, capture_output=True).returncode, 0)
