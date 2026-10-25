import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import tempfile
import unittest
import uuid

SOURCE = Path(__file__).resolve().parents[2] / 'python/reverie/hands'
def load(name):
    spec = importlib.util.spec_from_file_location(name, SOURCE / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module
logmod = load('command_telemetry')
tools = load('workspace_dispatch')

class FailureTelemetryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='t9-owned-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.actor = '11111111-1111-4111-8111-111111111111'
        self.bash = shutil.which('bash')
        self.clock = [1000]
        self.log = logmod.FailureLog(self.root / 'metadata', logmod.Principal(self.actor, 'hands'),
            {'shell': [self.bash], 'missing_zip': ['t9_missing_zip']}, clock=lambda:self.clock[0])
    def raw(self):
        return b''.join(p.read_bytes() for p in (self.root / 'metadata').iterdir() if p.is_file())
    def run_command(self, argv, log=None):
        request = {'version':1,'name':'run_command','args':{'argv':argv}}
        with logmod.execution_observer(log or self.log) as observer:
            return tools.dispatch_observed(str(self.root), request, observer=observer)
    def test_real_hands_missing_known_command(self):
        r = self.run_command(['t9_missing_zip'])
        self.assertFalse(r['ok'])
        self.assertEqual(self.log.report()['counts'],[{'tool':'missing_zip','category':'COMMAND_NOT_FOUND','exit':127,'count':1}])
    def test_real_hands_nonzero_preserves_stdout_stderr_and_exit(self):
        argv = [self.bash,'-c','printf output; printf error >&2; exit 7']
        ordinary = tools.dispatch(str(self.root), {'version':1,'name':'run_command','args':{'argv':argv}})
        self.assertEqual(ordinary, self.run_command(argv))
        self.assertEqual(self.log.report()['counts'][0]['exit'],7)
    def test_nested_shell_only_reports_outer_execution_once(self):
        self.run_command([self.bash,'-c', 'bash -c "exit 9"'])
        self.assertEqual(sum(r['count'] for r in self.log.report()['counts']),1)
    def test_sensitive_arguments_environment_stderr_and_paths_never_stored(self):
        secret='T9_SENTINEL_CREDENTIAL_ABC123'
        self.run_command([self.bash,'-c','SECRET="$1"; printf "%s\\n" "$SECRET" >&2; exit 3','label',secret])
        self.assertNotIn(secret.encode(),self.raw())
        self.assertNotIn(str(self.root).encode(),self.raw())
    def test_raw_unknown_command_is_aggregated_without_text_or_hash(self):
        import hashlib
        for name in ['SECRET_PASTED_XXX','秘密\ncredential', '/private/SECRET/path']:
            self.log.observe(name,127,str(uuid.uuid4()))
            self.assertNotIn(name.encode(),self.raw())
            self.assertNotIn(hashlib.sha256(name.encode()).hexdigest().encode(),self.raw())
        self.assertEqual(self.log.report()['counts'],[{'tool':'UNKNOWN_COMMAND','category':'COMMAND_NOT_FOUND','exit':127,'count':3}])
    def test_env_identity_cannot_override_bound_principal(self):
        os.environ['REVERIE_EMPLOYEE_ID']='ATTACKER_ID'
        try:self.run_command(['t9_missing_zip'])
        finally:os.environ.pop('REVERIE_EMPLOYEE_ID',None)
        self.assertNotIn(b'ATTACKER_ID',self.raw())
        self.assertIn(self.actor.encode(),self.raw())
    def test_event_has_no_identity_or_output_fields(self):
        with self.assertRaises(TypeError):self.log.observe('x',1,str(uuid.uuid4()),employee='spoof')
    def test_exact_execution_identity_dedupes_and_conflict_refuses(self):
        identity=str(uuid.uuid4())
        self.assertTrue(self.log.observe('t9_missing_zip',127,identity))
        self.assertTrue(self.log.observe('t9_missing_zip',127,identity))
        self.assertFalse(self.log.observe('t9_missing_zip',3,identity))
        self.assertEqual(sum(r['count'] for r in self.log.report()['counts']),1)
    def test_success_not_logged(self):
        self.assertEqual(self.run_command([self.bash,'-c','true'])['exit_code'],0)
        self.assertEqual(self.log.report()['counts'],[])
    def test_logger_failure_does_not_retry_or_change_result(self):
        class Broken:
            calls=0
            def observe(s,*_):s.calls+=1;raise OSError('SECRET_ERROR')
        broken=Broken()
        result=self.run_command([self.bash,'-c','echo once >> counter; exit 2'],broken)
        self.assertEqual(result['exit_code'],2)
        self.assertEqual((self.root/'counter').read_text(),'once\n')
        self.assertEqual(broken.calls,1)
        self.assertNotIn(b'SECRET_ERROR',self.raw())
    def test_existing_err_trap_and_shell_options_unchanged(self):
        script="set -euo pipefail; trap 'printf trapped >&2' ERR; false; echo unreachable"
        argv=[self.bash,'-c',script]
        ordinary=tools.dispatch(str(self.root),{'version':1,'name':'run_command','args':{'argv':argv}})
        self.assertEqual(ordinary,self.run_command(argv))
        self.assertIn('trapped',ordinary['output'])
        self.assertNotIn('unreachable',ordinary['output'])
    def test_retention_and_entry_cap_with_drop_accounting(self):
        log=logmod.FailureLog(self.root/'small',logmod.Principal(self.actor,'hands'),{},limits=logmod.Limits(entries=2,retention_seconds=60),clock=lambda:self.clock[0])
        for _ in range(3):log.observe('unknown',1,str(uuid.uuid4()))
        self.assertEqual(log.report()['evicted'],1)
        self.clock[0]+=61
        log.observe('unknown',1,str(uuid.uuid4()))
        self.assertEqual(log.report()['expired'],2)
        self.assertEqual(sum(r['count'] for r in log.report()['counts']),1)
    def test_symlink_or_swapped_sink_refuses_without_raw_error(self):
        path=self.log.path
        path.rename(path.with_suffix('.old'))
        path.symlink_to(self.root/'never-created')
        self.assertFalse(self.log.observe('x',1,str(uuid.uuid4())))
        self.assertEqual(self.log.dropped,1)
        self.assertFalse((self.root/'never-created').exists())
    def test_malformed_catalog_refuses_fixed_message(self):
        for catalog in [{'secret':[]},{'key':['x','x']},{'bad\nsecret':['x']}]:
            with self.assertRaisesRegex(ValueError,'^TELEMETRY_CONFIG_REFUSED$'):
                logmod.FailureLog(self.root/'bad',logmod.Principal(self.actor,'hands'),catalog)
    def test_oversized_unknown_and_malformed_event_drop_safely(self):
        self.assertTrue(self.log.observe('SECRET'*10000,1,str(uuid.uuid4())))
        self.assertNotIn(b'SECRET',self.raw())
        for value in [True,None,'1',9999]:self.assertFalse(self.log.observe('x',value,str(uuid.uuid4())))
    def _real_hands_laptop_entrypoint(self, argv):
        import subprocess
        taskroot = self.root / 'tasks'
        task = taskroot / 'task1'
        (task / 'work').mkdir(parents=True)
        (task / 'manifest.json').write_text(json.dumps({'version':1,'task_id':'task1'}))
        script = """import sys
sys.path.insert(0, sys.argv[1])
from command_telemetry import FailureLog, Principal, execution_observer
import laptop_tools
log = FailureLog(sys.argv[2], Principal('11111111-1111-4111-8111-111111111111', 'hands'), {'missing_zip':['t9_missing_zip']})
with execution_observer(log) as observer:
    raise SystemExit(laptop_tools.main(['--root', sys.argv[3], '--task-dir', sys.argv[4], '--timeout-s','5','--max-output-bytes','8192','--tool-path','/bin'], command_observer=observer))
"""
        return subprocess.run([sys.executable,'-I','-B','-c',script,str(SOURCE),str(self.root/'metadata'),str(taskroot),str(task)],input=json.dumps({'version':1,'name':'run_command','args':{'argv':argv}}),text=True,capture_output=True,timeout=8,env={'PATH':os.environ['PATH']})

    @unittest.skipUnless(Path('/.dockerenv').is_file(),
        'positive embedding requires an actual supported laptop container; unavailable in native builds')
    def test_real_hands_laptop_entrypoint_optional_embedding(self):
        r = self._real_hands_laptop_entrypoint(['t9_missing_zip'])
        self.assertEqual(r.returncode,0,r.stderr)
        self.assertFalse(json.loads(r.stdout)['ok'])
        self.assertEqual(self.log.report()['counts'][0]['tool'],'missing_zip')

    @unittest.skipIf(Path('/.dockerenv').is_file(),
        'native rejection control requires a host without the container marker')
    def test_native_laptop_entrypoint_refuses_without_execution_or_telemetry(self):
        command = [sys.executable, '-I', '-B', '-c',
                   'from pathlib import Path; Path("native-command-ran").write_text("executed")']
        r = self._real_hands_laptop_entrypoint(command)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout), {
            'version': 1, 'ok': False, 'output': '',
            'error': 'laptop tool runner requires a container',
            'truncated': False, 'exit_code': None})
        self.assertEqual(r.stderr, '')
        self.assertFalse((self.root / 'tasks/task1/work/native-command-ran').exists())
        self.assertEqual(self.log.report()['counts'], [])

    def test_disk_full_error_is_silent_drop_and_original_command_stays_once(self):
        import contextlib
        @contextlib.contextmanager
        def full():
            raise sqlite3.OperationalError('SECRET_DISK_ERROR')
            yield
        self.log._connect=full
        result=self.run_command([self.bash,'-c','echo once >> disk-counter; exit 5'])
        self.assertEqual(result['exit_code'],5)
        self.assertEqual((self.root/'disk-counter').read_text(),'once\n')
        self.assertEqual(self.log.dropped,1)
        self.assertNotIn(b'SECRET_DISK_ERROR',self.raw())
    def test_sink_binding_cannot_be_relabelled_by_another_principal(self):
        self.run_command(['t9_missing_zip'])
        with self.assertRaisesRegex(ValueError,'^TELEMETRY_CONFIG_REFUSED$'):
            logmod.FailureLog(self.root/'metadata',logmod.Principal('22222222-2222-4222-8222-222222222222','hands'),{})
        self.assertEqual(self.log.report()['employee_id'],self.actor)
    def test_report_maintenance_expires_idle_records(self):
        self.run_command(['t9_missing_zip'])
        self.clock[0] += 8*86400
        self.assertEqual(self.log.report()['counts'],[])
        self.assertEqual(self.log.report()['expired'],1)
    def test_existing_oversize_database_refuses_instead_of_silently_raising_cap(self):
        db=sqlite3.connect(str(self.log.path))
        try:
            db.execute('CREATE TABLE bulk (x BLOB)')
            db.execute('INSERT INTO bulk VALUES (zeroblob(256000))')
            db.commit()
        finally:db.close()
        with self.assertRaisesRegex(ValueError,'^TELEMETRY_STORE_REFUSED$'):
            logmod.FailureLog(self.root/'metadata',logmod.Principal(self.actor,'hands'),{},limits=logmod.Limits(pages=32))
    def test_default_dispatch_does_not_enable_telemetry(self):
        tools.dispatch(str(self.root),{'version':1,'name':'run_command','args':{'argv':['t9_missing_zip']}})
        self.assertEqual(self.log.report()['counts'],[])

if __name__=='__main__':unittest.main()
