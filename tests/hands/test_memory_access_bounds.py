"""Only temporary configs/stores and synthetic worker processes; no office/model calls."""
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch
import memory_access as access
from config_location import configuration_path
import test_memory_access as fixtures
from test_memory_access import SESSION, ROOM
from reverie.memory import MemoryStore

class MemoryBoundsTests(unittest.TestCase):
    def test_relocated_config_is_exact_launcher_choice_and_never_stale_default(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)/'home'; relocated = Path(directory)/'selected'
            env = {'REVERIE_MUX': '1', 'REVERIE_SESSION_ID': SESSION, 'HOME':str(home),
                   'REVERIE_AGENT_HOME':str(home), 'REVERIE_DATA_DIR':str(relocated)}
            selected = configuration_path(env)
            stale = home/'.reverie/hands'/SESSION/'agent.json'
            for p, tag in [(selected,'selected'), (stale,'stale')]:
                p.parent.mkdir(parents=True); p.write_text(json.dumps({'self_session_id':SESSION,'memory_instance':'/synthetic/'+tag}));p.chmod(0o600)
            self.assertEqual(access.configuration(env)['memory_instance'], '/synthetic/selected')
            selected.unlink()
            with self.assertRaises(FileNotFoundError): access.configuration(env)
            self.assertTrue(stale.exists())

    def test_scoped_task_keeps_launcher_data_root_and_rejects_competing_config(self):
        import coding_chat
        with tempfile.TemporaryDirectory() as directory:
            env={'REVERIE_SESSION_ID':SESSION,'REVERIE_DATA_DIR':str(Path(directory)/'selected'),
                 'REVERIE_AGENT_HOME':str(Path(directory)/'home'),'HOME':directory,
                 'REVERIE_API_URL':'http://127.0.0.1:12345'}
            selected=configuration_path(env)
            cfg={'self_session_id':SESSION,'_config_path':str(selected),'coding':{'tasks':{'fixture':{'office_access':True}}}}
            with patch.dict(os.environ,env,clear=True):
                scoped=coding_chat.office_environment(cfg,'fixture')
                self.assertEqual(scoped['REVERIE_DATA_DIR'],env['REVERIE_DATA_DIR'])
                self.assertEqual(scoped['REVERIE_AGENT_HOME'],env['REVERIE_AGENT_HOME'])
                cfg['_config_path']=str(Path(directory)/'.reverie/hands'/SESSION/'agent.json')
                with self.assertRaises(ValueError): coding_chat.office_environment(cfg,'fixture')

    def test_config_alias_and_other_session_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            env={'REVERIE_DATA_DIR':directory,'REVERIE_SESSION_ID':SESSION}
            with self.assertRaises(ValueError): configuration_path(env, ROOM)
            alias=Path(directory)/'alias'; alias.symlink_to(directory, target_is_directory=True)
            with self.assertRaises(ValueError): configuration_path({**env,'REVERIE_DATA_DIR':str(alias)})

    def run_worker(self, code, cap=100, timeout=0.5):
        original=access.ManualMemoryProcess
        workers=[]
        def synthetic(_argv, body, wall, limit):
            worker=original([sys.executable,'-I','-B','-c',code],body,wall,limit)
            workers.append(worker);return worker
        started=time.monotonic()
        with patch.object(access,'ManualMemoryProcess',side_effect=synthetic):
            with self.assertRaises(ValueError): access.bounded_recall({},ROOM,'synthetic',cap,timeout)
        self.assertLess(time.monotonic()-started, 3)
        self.assertTrue(workers[0].done)
        self.assertIsNotNone(workers[0].process.poll())
        return workers[0]

    def test_slow_or_blocked_worker_is_killed_with_one_complete_operation_deadline(self):
        worker=self.run_worker('import time;time.sleep(20)')
        self.assertEqual(worker.error,'timeout')

    def test_transport_overflow_refuses_without_buffering_unbounded_result(self):
        worker=self.run_worker('import sys;sys.stdout.write("x"*300000);sys.stdout.flush()',timeout=2)
        self.assertEqual(worker.error,'output_limit')
        self.assertLessEqual(len(worker.output),131072)

    def test_oversized_store_allocation_and_oversized_semantic_result_refuse(self):
        self.run_worker('import resource;resource.setrlimit(resource.RLIMIT_AS,(64*1024*1024,)*2);x=bytearray(128*1024*1024)',timeout=2)
        self.run_worker('import json;print(json.dumps({"text":"x"*101}))',cap=100,timeout=2)

    def test_oversized_request_refuses_before_worker_launch(self):
        with patch.object(access,'ManualMemoryProcess') as worker:
            with self.assertRaises(ValueError): access.bounded_recall({},'x'*40000,'synthetic')
            worker.assert_not_called()

    def test_actual_worker_includes_relocated_configuration_and_synthetic_store_recall(self):
        with tempfile.TemporaryDirectory() as directory:
            cfg, room, _ = fixtures.MemoryAccessTests().fixture(directory)
            cli=Path(directory)/'synthetic_cli.py'
            cli.write_text('import json;print('+repr(json.dumps([room]))+')')
            cfg['cli']=[sys.executable,str(cli)]
            env={'REVERIE_MUX':'1','REVERIE_SESSION_ID':SESSION,'REVERIE_DATA_DIR':str(Path(directory)/'relocated')}
            path=configuration_path(env);path.parent.mkdir(parents=True)
            path.write_text(json.dumps(cfg));path.chmod(0o600)
            result=access.bounded_recall(env,ROOM,'compiler baseline',timeout=3)
            self.assertIn('Historical',result['notice'])
            self.assertEqual(result['sourceMessageIds'],[fixtures.SOURCE])

    def test_actual_sqlite_lock_is_inside_the_worker_deadline(self):
        import sqlite3
        with tempfile.TemporaryDirectory() as directory:
            cfg, room, _ = fixtures.MemoryAccessTests().fixture(directory)
            cli=Path(directory)/'synthetic_cli.py';cli.write_text('import json;print('+repr(json.dumps([room]))+')')
            cfg['cli']=[sys.executable,str(cli)]
            env={'REVERIE_MUX':'1','REVERIE_SESSION_ID':SESSION,'REVERIE_DATA_DIR':str(Path(directory)/'selected')}
            path=configuration_path(env);path.parent.mkdir(parents=True);path.write_text(json.dumps(cfg));path.chmod(0o600)
            database=next(Path(directory).rglob('memory.sqlite'))
            connection=sqlite3.connect(database);connection.execute('BEGIN EXCLUSIVE')
            try:
                start=time.monotonic()
                with self.assertRaises(ValueError): access.bounded_recall(env,ROOM,'compiler',timeout=.5)
                self.assertLess(time.monotonic()-start,3)
            finally:connection.rollback();connection.close()

    def test_flat_addon_worker_uses_own_package_and_ignores_inherited_pythonpath(self):
        import shutil
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cfg, room, _ = fixtures.MemoryAccessTests().fixture(directory)
            cli = root/'synthetic_cli.py'
            cli.write_text('import json;print('+repr(json.dumps([room]))+')')
            cfg['cli'] = [sys.executable, str(cli)]
            env = {'REVERIE_MUX':'1', 'REVERIE_SESSION_ID':SESSION,
                   'REVERIE_DATA_DIR':str(root/'selected')}
            path = configuration_path(env)
            path.parent.mkdir(parents=True)
            path.write_text(json.dumps(cfg));path.chmod(0o600)
            addon = root/'flat-addon';addon.mkdir()
            for source in Path(access.__file__).parent.glob('*.py'):
                shutil.copyfile(source, addon/source.name)
            poison = root/'untrusted';poison.mkdir()
            marker = root/'untrusted-code-ran'
            (poison/'reverie.py').write_text('from pathlib import Path;Path('+repr(str(marker))+').touch();raise RuntimeError("untrusted")')
            (poison/'agent_memory.py').write_text('raise RuntimeError("untrusted helper")')
            with patch.object(access, '__file__', str(addon/'memory_access.py')), \
                    patch.dict(os.environ, {'PYTHONPATH':str(poison)}):
                result = access.bounded_recall(env, ROOM, 'compiler baseline', timeout=3)
            self.assertEqual(result['sourceMessageIds'], [fixtures.SOURCE])
            self.assertFalse(marker.exists())

    def test_large_ranking_worker_is_killed_without_limiting_office_cli_virtual_memory(self):
        worker=self.run_worker('import time;x=bytearray(300*1024*1024);time.sleep(10)',timeout=2)
        self.assertEqual(worker.error,'memory_limit')

    def test_actual_ranking_rechecks_revoked_membership_before_return(self):
        with tempfile.TemporaryDirectory() as directory:
            cfg, room, chat = fixtures.MemoryAccessTests().fixture(directory)
            retrieve=MemoryStore.retrieve
            def revoke(store,*args,**kwargs):
                result=retrieve(store,*args,**kwargs)
                chat.member_rooms.return_value=[]
                return result
            with patch.object(MemoryStore,'retrieve',revoke):
                with self.assertRaises(PermissionError): access.recall(cfg,ROOM,'compiler',chat=chat)


class PartialConstructionTests(unittest.TestCase):
    def fault(self, operation, cleanup_failure=None):
        import coding_process
        import subprocess
        streams = [tempfile.TemporaryFile() for _ in range(3)]
        for stream in streams: self.addCleanup(stream.close)
        child = Mock(pid=777777, stdin=streams[0], stdout=streams[1], stderr=streams[2])
        selector = Mock()
        original = OSError('synthetic setup failure')
        if operation == 'registration': selector.register.side_effect = original
        if cleanup_failure == 'wait': child.wait.side_effect = subprocess.TimeoutExpired('synthetic', 1)
        if cleanup_failure == 'selector': selector.close.side_effect = OSError('synthetic close failure')
        with patch.object(coding_process.selectors, 'DefaultSelector', return_value=selector), \
             patch.object(coding_process.subprocess, 'Popen', return_value=child), \
             patch.object(coding_process.os, 'set_blocking', side_effect=original if operation == 'blocking' else None), \
             patch.object(access.os, 'killpg') as kill:
            with self.assertRaises(OSError) as raised:
                access.ManualMemoryProcess(['synthetic'], b'{}', 10, 131072)
        self.assertIs(raised.exception, original)
        self.assertTrue(all(stream.closed for stream in streams))
        selector.close.assert_called_once()
        child.wait.assert_called_once_with(timeout=1)
        kill.assert_called_once_with(child.pid, access.signal.SIGKILL)
        return original

    def test_first_stream_setup_failure_cleans_every_owned_stream(self):
        self.fault('blocking')

    def test_failed_setup_preserves_original_error_and_reports_unreaped_child(self):
        original = self.fault('registration', 'wait')
        self.assertEqual(original.__notes__, ['Manual-memory worker cleanup uncertain: cleanup_timeout'])

    def test_failed_selector_close_still_closes_pipes_reaps_child_and_reports_uncertainty(self):
        original = self.fault('registration', 'selector')
        self.assertEqual(original.__notes__, ['Manual-memory worker cleanup uncertain: cleanup_failed'])

    def test_finish_preserves_original_timeout_and_is_idempotent_on_uncertain_reap(self):
        import io
        import subprocess
        worker = object.__new__(access.ManualMemoryProcess)
        worker.done = False; worker.error = 'timeout'; worker.selector = Mock()
        worker.process = Mock(pid=777777, stdin=io.BytesIO(), stdout=io.BytesIO(), stderr=io.BytesIO())
        worker.process.wait.side_effect = subprocess.TimeoutExpired('synthetic', 1)
        with patch.object(access.os, 'killpg') as kill:
            worker.finish(); worker.finish()
        self.assertEqual(worker.error, 'timeout')
        self.assertEqual(worker.cleanup_error, 'cleanup_timeout')
        worker.process.wait.assert_called_once_with(timeout=1)
        kill.assert_called_once_with(worker.process.pid, access.signal.SIGKILL)

    def test_partial_child_cleanup_failure_does_not_skip_pipes_selector_or_reap(self):
        import io
        worker = object.__new__(access.ManualMemoryProcess)
        worker.done = False; worker.error = None; worker.selector = Mock()
        worker.process = Mock(pid=777777, stdin=io.BytesIO(), stdout=io.BytesIO(), stderr=io.BytesIO())
        with patch.object(access.os, 'killpg', side_effect=PermissionError('synthetic kill failure')):
            worker.finish()
        self.assertEqual(worker.error, 'cleanup_failed')
        self.assertTrue(all(stream.closed for stream in (worker.process.stdin, worker.process.stdout, worker.process.stderr)))
        worker.selector.close.assert_called_once()
        worker.process.wait.assert_called_once_with(timeout=1)
