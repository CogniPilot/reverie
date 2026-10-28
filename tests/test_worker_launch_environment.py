"""Synthetic launch-record controls: no engine, credentials, provider, or network."""
import os
from pathlib import Path
import json
import tempfile
import unittest
from unittest.mock import patch
from reverie import worker

expected = Path(os.environ.get('EXPECTED_WORKER', str(Path(__file__).resolve().parents[1]/'python/reverie/worker.py')))
if Path(worker.__file__).resolve() != expected.resolve():
    raise RuntimeError('Controls imported an unexpected worker module: '+str(worker.__file__))
SHIM = '/opt/reverie/autoenv/bin'
BROKER_PATH = '/home/agent/.nix-profile/bin:/home/agent/.local/bin:/home/agent/.local/state/nix/profiles/profile/bin:/bin:/bin'

class ChildEnvironmentTests(unittest.TestCase):
    def run_child(self, inherited=None, requested=None, packaged=True):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            launch = base/'launch'; launch.mkdir(mode=0o700)
            shim = base/'shim'
            if packaged: shim.mkdir()
            record = launch/'request.json'
            request = {'cwd':'/projects/owned','command':'true','env':{'PATH':BROKER_PATH, **(requested or {})}}
            record.write_text(json.dumps(request)); record.chmod(0o600)
            def path(value):
                if str(value) == '/home/agent/.reverie-launch': return launch
                if str(value) == SHIM: return shim
                return Path(value)
            env = {'PATH':SHIM+':/bin','HOME':'/home/agent','REVERIE_WORKER_SOCKET':'/host/broker', **(inherited or {})}
            with patch.object(worker,'Path',side_effect=path), patch.object(worker.os,'chdir'), \
                 patch.object(worker.subprocess,'Popen') as spawn, patch.object(worker.os,'execve') as execute, \
                 patch.dict(os.environ,env,clear=True):
                worker.child(record)
            self.assertFalse(record.exists())
            self.assertEqual(execute.call_args.args[:2],('/bin/bash',['bash','-c','true']))
            return execute.call_args.args[2]

    def test_packaged_shims_survive_actual_old_broker_path_override(self):
        env = self.run_child()
        self.assertEqual(env['PATH'],SHIM+':'+BROKER_PATH)

    def test_old_broker_default_target_is_removed_from_real_child_environment(self):
        env = self.run_child(inherited={'CARGO_TARGET_DIR':'/tmp/reverie/build/cargo'})
        self.assertNotIn('CARGO_TARGET_DIR',env)

    def test_explicit_owner_target_and_provider_config_remain_unchanged(self):
        owner = {'CARGO_TARGET_DIR':'/owner/target','CODEX_HOME':'/selected/codex','CLAUDE_CONFIG_DIR':'/selected/claude','CARGO_BUILD_JOBS':'7'}
        env = self.run_child(inherited=owner)
        for key,value in owner.items(): self.assertEqual(env[key],value)
        self.assertEqual(env['PATH'].split(':')[1:],BROKER_PATH.split(':'))

    def test_explicit_launch_target_is_not_mistaken_for_old_injected_default(self):
        # Real current validator bars this key; preserving it here prevents a future
        # authenticated caller override from being silently clobbered by cleanup.
        env = self.run_child(requested={'CARGO_TARGET_DIR':'/tmp/reverie/build/cargo'})
        self.assertEqual(env['CARGO_TARGET_DIR'],'/tmp/reverie/build/cargo')

    def test_opt_out_and_explicit_jobs_remain_visible_to_real_shim(self):
        env = self.run_child(requested={'REVERIE_NO_AUTOENV':'1','CARGO_BUILD_JOBS':'7'})
        self.assertEqual(env['REVERIE_NO_AUTOENV'],'1'); self.assertEqual(env['CARGO_BUILD_JOBS'],'7')
        self.assertNotIn('REVERIE_WORKER_SOCKET',env)
        self.assertEqual({env[k] for k in ('TMPDIR','TMP','TEMP')},{'/tmp'})

    def test_gpu_container_library_default_preserves_explicit_launch_override(self):
        default = '/usr/local/nvidia/lib64:/usr/local/nvidia/lib'
        inherited = {'LD_LIBRARY_PATH': default, 'CODEX_HOME': '/selected/codex'}
        env = self.run_child(inherited=inherited)
        self.assertEqual(env['LD_LIBRARY_PATH'], default)
        env = self.run_child(inherited=inherited, requested={'LD_LIBRARY_PATH': '/owner/lib'})
        self.assertEqual(env['LD_LIBRARY_PATH'], '/owner/lib')
        self.assertEqual(env['CODEX_HOME'], '/selected/codex')

    def test_no_packaged_shims_does_not_rewrite_existing_path(self):
        env = self.run_child(packaged=False)
        self.assertEqual(env['PATH'],BROKER_PATH)

    def test_packaged_shim_entry_is_deduplicated_without_reordering_other_paths(self):
        env = self.run_child(requested={'PATH':f'/custom:{SHIM}:/bin:{SHIM}:/last'})
        self.assertEqual(env['PATH'],f'{SHIM}:/custom:/bin:/last')

if __name__ == '__main__': unittest.main()
