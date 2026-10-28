"""Owned files and controlled child/kernel ports; never starts a scope or GPU."""
import io,json,os,signal,subprocess,tempfile,time,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch,Mock
from reverie import browser_job_scope as scope
from reverie.browser_job_requests import BrowserJobRefused

class ScopeControls(unittest.TestCase):
    def test_output_count_never_follows_a_cache_symlink_into_foreign_files(self):
        with tempfile.TemporaryDirectory()as tmp:
            root=Path(tmp).resolve();own=root/'own';own.mkdir();outside=root/'other';outside.mkdir();(outside/'payload').write_bytes(b'x'*10000);(own/'cache').symlink_to(outside,target_is_directory=True)
            value=scope.output_inventory(own,1024);self.assertEqual(value['entries'],1);self.assertLess(value['bytes'],1024)
            (own/'capture').write_bytes(b'x'*1025)
            with self.assertRaisesRegex(BrowserJobRefused,'OUTPUT_BOUND'):scope.output_inventory(own,1024)

    def test_second_wait_failure_still_closes_stream_and_retained_pidfd(self):
        child=SimpleNamespace(stdin=io.BytesIO(),stdout=io.BytesIO(),poll=lambda:None,wait=Mock(side_effect=subprocess.TimeoutExpired('own',1)))
        errors=[]
        with patch.object(scope.signal,'pidfd_send_signal')as send,patch.object(scope.os,'close')as close:
            scope.reap_client(child,123,time.monotonic()+10,errors)
        self.assertEqual([x.args[1]for x in send.call_args_list],[signal.SIGTERM,signal.SIGKILL]);close.assert_called_once_with(123);self.assertTrue(child.stdout.closed);self.assertEqual(errors[0]['stage'],'client-cleanup')

    def test_cleanup_waits_only_use_remaining_absolute_deadline(self):
        child=SimpleNamespace(stdin=io.BytesIO(),stdout=io.BytesIO(),poll=lambda:None,wait=Mock(side_effect=subprocess.TimeoutExpired('own',1)))
        errors=[]
        with patch.object(scope.time,'monotonic',side_effect=[9.5,9.9]),patch.object(scope.signal,'pidfd_send_signal'),patch.object(scope.os,'close'):
            scope.reap_client(child,123,10,errors)
        self.assertAlmostEqual(child.wait.call_args_list[0].kwargs['timeout'],.5);self.assertAlmostEqual(child.wait.call_args_list[1].kwargs['timeout'],.1)

    def test_missing_pidfd_is_unknown_never_a_guessed_pid_signal(self):
        child=SimpleNamespace(stdin=io.BytesIO(),stdout=io.BytesIO(),poll=lambda:None)
        errors=[]
        with patch.object(scope.signal,'pidfd_send_signal')as send:scope.reap_client(child,None,time.monotonic()+1,errors)
        send.assert_not_called();self.assertEqual(errors[0]['class'],'BrowserJobRefused');self.assertTrue(child.stdout.closed)

    def test_rebound_scope_is_not_stopped(self):
        binding=SimpleNamespace(spec=SimpleNamespace(unit='own.scope'),invocation_id='first',control_group='/own.scope')
        with patch.object(scope,'_query',return_value=(0,{'InvocationID':'other','ControlGroup':'/own.scope'})),patch.object(scope.subprocess,'run')as stop:
            with self.assertRaisesRegex(BrowserJobRefused,'REBOUND'):scope.stop_owned({},binding,time.monotonic()+2)
        stop.assert_not_called()

    def test_refused_source_never_launches_or_releases_common_fence(self):
        # This exercises the actual outer exception path, preserving a durable
        # UNKNOWN even before a native client can be captured.
        with tempfile.TemporaryDirectory()as tmp:
            task=Path(tmp).resolve()/'capture-owned';task.mkdir();service=SimpleNamespace(policy={'limits':{'outerSeconds':1440}},broker=SimpleNamespace(resource_reservations=Mock()),jobs={})
            with patch.object(scope,'Workspaces',side_effect=OSError('owned finalizer unavailable')),patch.object(scope.subprocess,'Popen')as launch:
                scope.supervise(service,task,{'operationId':'a'*32},object(),object())
            launch.assert_not_called();service.broker.resource_reservations.finish_host_job.assert_not_called();self.assertEqual(json.loads((task/'SUPERVISOR-UNKNOWN.json').read_text())['state'],'UNKNOWN_NO_REPLAY');self.assertEqual(service.jobs['a'*32][2],'UNKNOWN_NO_REPLAY')

if __name__=='__main__':unittest.main()
