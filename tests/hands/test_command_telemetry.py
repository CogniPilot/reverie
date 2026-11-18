import importlib.util
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
    def test_raw_unknown_command_is_aggregated_without_text_or_hash(self):
        import hashlib
        for name in ['SECRET_PASTED_XXX','秘密\ncredential', '/private/SECRET/path']:
            self.log.observe(name,127,str(uuid.uuid4()))
            self.assertNotIn(name.encode(),self.raw())
            self.assertNotIn(hashlib.sha256(name.encode()).hexdigest().encode(),self.raw())
        self.assertEqual(self.log.report()['counts'],[{'tool':'UNKNOWN_COMMAND','category':'COMMAND_NOT_FOUND','exit':127,'count':3}])
    def test_env_identity_cannot_override_bound_principal(self):
        os.environ['REVERIE_EMPLOYEE_ID']='ATTACKER_ID'
        try:self.log.observe('t9_missing_zip',127,str(uuid.uuid4()))
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
    def test_disk_full_error_is_a_silent_drop(self):
        import contextlib
        @contextlib.contextmanager
        def full():
            raise sqlite3.OperationalError('SECRET_DISK_ERROR')
            yield
        self.log._connect=full
        self.assertFalse(self.log.observe('t9_missing_zip',5,str(uuid.uuid4())))
        self.assertEqual(self.log.dropped,1)
        self.assertNotIn(b'SECRET_DISK_ERROR',self.raw())
    def test_sink_binding_cannot_be_relabelled_by_another_principal(self):
        self.log.observe('t9_missing_zip',127,str(uuid.uuid4()))
        with self.assertRaisesRegex(ValueError,'^TELEMETRY_CONFIG_REFUSED$'):
            logmod.FailureLog(self.root/'metadata',logmod.Principal('22222222-2222-4222-8222-222222222222','hands'),{})
        self.assertEqual(self.log.report()['employee_id'],self.actor)
    def test_report_maintenance_expires_idle_records(self):
        self.log.observe('t9_missing_zip',127,str(uuid.uuid4()))
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
if __name__=='__main__':unittest.main()
