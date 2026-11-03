"""Deterministic owned-client cleanup controls. All engine/process signals mocked."""
import tests  # noqa: F401
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from reverie.worker import Broker, OfficeAPI
from reverie.worker_cleanup import CleanupUnconfirmed, StopBudget, remaining, wait_poll, reap_viewer, run_client, settle_owned_clients
from tests import test_owner_goal_broker as owner_fixture


class Clock:
    def __init__(self): self.now = 0.
    def sleep(self, seconds):
        assert 0 <= seconds <= 34
        self.now += seconds
    def __enter__(self):
        self.time = patch('reverie.worker_cleanup.time.monotonic', side_effect=lambda: self.now)
        self.sleeping = patch('reverie.worker_cleanup.time.sleep', side_effect=self.sleep)
        self.time.start(); self.sleeping.start(); return self
    def __exit__(self, *args): self.sleeping.stop(); self.time.stop()


class Child:
    def __init__(self, stdout=b'', stderr=b'', code=0, reap_on_kill=True):
        self.returncode = code
        self.pid = 123456789  # Never signaled: all signal sites are mocked.
        self.reap_on_kill = reap_on_kill
        self.kills = self.terminates = 0
        self.stdout = self.pipe(stdout)
        self.stderr = self.pipe(stderr)
    @staticmethod
    def pipe(value):
        read, write = os.pipe()
        try: os.write(write, value)
        finally: os.close(write)
        return os.fdopen(read, 'rb', buffering=0)
    def poll(self): return self.returncode
    def kill(self):
        self.kills += 1
        if self.reap_on_kill: self.returncode = -9
    def terminate(self):
        self.terminates += 1
    def wait(self, *args, **kwargs): raise AssertionError('BLOCKING_WAIT_FORBIDDEN')
    def communicate(self, *args, **kwargs): raise AssertionError('COMMUNICATE_FORBIDDEN')
    def __enter__(self): raise AssertionError('POPEN_CONTEXT_FORBIDDEN')
    def __exit__(self, *args): raise AssertionError('POPEN_CONTEXT_FORBIDDEN')
    def close(self): self.stdout.close(); self.stderr.close()


class ShutdownTests(unittest.TestCase):
    def owner(self):
        return SimpleNamespace(stopping=StopBudget(), owned_clients={}, cleanup_uncertain=set())

    def child(self, **kwargs):
        child = Child(**kwargs); self.addCleanup(child.close); return child

    def test_first_stop_budget_is_shared_and_never_refreshed(self):
        with Clock() as clock:
            stop = StopBudget(); stop.set()
            clock.sleep(30); stop.set(); stop.set()
            self.assertEqual(stop.deadline, 34)
            self.assertEqual(remaining(100, stop), 4)
            clock.sleep(4)
            self.assertEqual(remaining(100, stop), 0)

    def test_poll_unreapable_is_bounded_without_wait(self):
        with Clock() as clock:
            child = self.child(code=None, reap_on_kill=False)
            self.assertFalse(wait_poll(child, .1))
            self.assertLessEqual(clock.now, .1)

    def test_real_popen_poll_contract_uses_only_mocked_wnohang(self):
        # No process is created. Exercise the actual stdlib poll implementation.
        child=subprocess.Popen.__new__(subprocess.Popen)
        child._child_created=False;child.pid=123456789;child.returncode=None
        child._waitpid_lock=__import__('threading').Lock()
        with Clock() as clock, patch.object(subprocess._del_safe,'waitpid',return_value=(0,0)) as waitpid:
            self.assertFalse(wait_poll(child,.03))
            self.assertLessEqual(clock.now,.03)
        self.assertTrue(waitpid.call_count)
        self.assertTrue(all(call.args==(child.pid,os.WNOHANG) for call in waitpid.call_args_list))

    def test_registered_signal_handlers_share_first_stop_without_real_signal(self):
        from reverie.worker import main
        with Clock() as clock:
            broker=Broker({'maxWorkers':16})
            callbacks={}
            def serve():
                callbacks[__import__('signal').SIGTERM](None,None)
                clock.sleep(7)
                callbacks[__import__('signal').SIGINT](None,None)
                self.assertEqual(broker.stopping.deadline,34)
            broker.serve=serve
            with patch('reverie.worker.load_config',return_value={'maxWorkers':16}), \
                    patch('reverie.worker.Broker',return_value=broker), \
                    patch('reverie.worker.signal.signal',side_effect=lambda kind,callback:callbacks.update({kind:callback})), \
                    patch('sys.argv',['worker','broker','--config','/not-read-synthetic']):
                self.assertEqual(main(),0)

    def test_viewer_unreapable_uses_only_owned_group_and_retains_uncertainty(self):
        with Clock() as clock, patch('reverie.worker_cleanup.os.killpg') as kill:
            child = self.child(code=None, reap_on_kill=False)
            owner = self.owner(); owner.stopping.set(); clock.sleep(33.99)
            self.assertFalse(reap_viewer(child, owner.stopping, owner.cleanup_uncertain))
            self.assertLessEqual(clock.now, 34)
            kill.assert_called_once_with(child.pid, __import__('signal').SIGKILL)
            self.assertEqual(owner.cleanup_uncertain, {'VIEWER_UNREAPED'})

    def test_viewer_already_reaped_never_signals(self):
        with patch('reverie.worker_cleanup.os.killpg') as kill:
            child = self.child(code=0)
            self.assertTrue(reap_viewer(child, StopBudget(), set()))
            self.assertEqual(child.terminates, 0); kill.assert_not_called()

    def test_viewer_kill_race_rechecks_without_wait(self):
        with Clock(), patch('reverie.worker_cleanup.os.killpg') as kill:
            child = self.child(code=None)
            def exited(*_):
                child.returncode = 0; raise ProcessLookupError
            kill.side_effect = exited
            self.assertTrue(reap_viewer(child, StopBudget(), set()))

    def test_engine_exact_argv_success_and_no_context_or_wait(self):
        child = self.child(stdout=b'fixture\n', stderr=b'diagnostic')
        owner = self.owner()
        with patch('reverie.worker_cleanup.subprocess.Popen', return_value=child) as spawn:
            result = run_client(['fixture-engine', 'inspect', 'owned'], timeout=20, owner=owner)
        self.assertEqual(result.stdout, 'fixture\n'); self.assertEqual(result.stderr, 'diagnostic')
        self.assertEqual(spawn.call_args.args, (['fixture-engine', 'inspect', 'owned'],))
        self.assertEqual(owner.owned_clients, {}); self.assertEqual(child.kills, 0)

    def test_engine_timeout_retains_unreapable_evidence_and_original_timeout(self):
        owner = self.owner(); child = self.child(code=None, reap_on_kill=False)
        with Clock() as clock, patch('reverie.worker_cleanup.subprocess.Popen', return_value=child):
            with self.assertRaises(subprocess.TimeoutExpired) as error:
                run_client(['fixture-engine', 'stop', '--time', '2', 'owned'], timeout=20, owner=owner)
            self.assertEqual(error.exception.timeout, 20)
            self.assertLessEqual(clock.now, 20)
        self.assertEqual(child.kills, 1)
        self.assertEqual(list(owner.owned_clients.values()), [child])
        self.assertEqual(owner.cleanup_uncertain, {'ENGINE_CLIENT_UNREAPED'})

    def test_engine_own_timeout_does_not_reset_stop_deadline(self):
        with Clock() as clock:
            owner = self.owner(); owner.stopping.set(); clock.sleep(33.95)
            child = self.child(code=None, reap_on_kill=False)
            with patch('reverie.worker_cleanup.subprocess.Popen', return_value=child):
                with self.assertRaises(subprocess.TimeoutExpired):
                    run_client(['fixture-engine', 'inspect', 'owned'], timeout=20, owner=owner)
            self.assertLessEqual(clock.now, 34)

    def test_engine_output_is_independently_bounded_and_killed_on_overflow(self):
        owner = self.owner(); child = self.child(stdout=b'12345', code=None)
        with patch('reverie.worker_cleanup.subprocess.Popen', return_value=child):
            with self.assertRaisesRegex(RuntimeError, 'output exceeds bound'):
                run_client(['fixture-engine', 'inspect'], timeout=20, owner=owner, limit=4)
        self.assertEqual(child.kills, 1); self.assertEqual(owner.owned_clients, {})

    def test_engine_spawn_failure_removes_only_its_placeholder(self):
        owner = self.owner(); token = object(); owner.owned_clients[token] = None
        with patch('reverie.worker_cleanup.subprocess.Popen', side_effect=OSError('fixture allocation')):
            with self.assertRaises(OSError): run_client(['fixture-engine'], timeout=20, owner=owner)
        self.assertEqual(owner.owned_clients, {token: None})

    def test_selector_allocation_failure_closes_both_pipes_and_preserves_first_reason(self):
        owner=self.owner();child=self.child();reason=OSError('fixture selector allocation')
        with patch('reverie.worker_cleanup.subprocess.Popen',return_value=child), \
                patch('reverie.worker_cleanup.selectors.DefaultSelector',side_effect=reason):
            with self.assertRaises(OSError) as error:run_client(['fixture-engine'],timeout=20,owner=owner)
        self.assertIs(error.exception,reason)
        self.assertTrue(child.stdout.closed);self.assertTrue(child.stderr.closed)
        self.assertEqual(owner.owned_clients,{})
        self.assertEqual(owner.cleanup_uncertain,set())

    def test_first_registration_failure_closes_both_pipes(self):
        owner=self.owner();child=self.child();reason=OSError('fixture selector registration')
        selector=Mock();selector.__enter__=Mock(return_value=selector);selector.__exit__=Mock(return_value=False)
        selector.register.side_effect=reason
        with patch('reverie.worker_cleanup.subprocess.Popen',return_value=child), \
                patch('reverie.worker_cleanup.selectors.DefaultSelector',return_value=selector):
            with self.assertRaises(OSError) as error:run_client(['fixture-engine'],timeout=20,owner=owner)
        self.assertIs(error.exception,reason)
        self.assertTrue(child.stdout.closed);self.assertTrue(child.stderr.closed)

    def test_selector_failure_retains_unreaped_ownership_and_deadline_without_hiding_reason(self):
        owner=self.owner();child=self.child(code=None,reap_on_kill=False)
        reason=OSError('fixture selector allocation')
        with Clock() as clock, patch('reverie.worker_cleanup.subprocess.Popen',return_value=child), \
                patch('reverie.worker_cleanup.selectors.DefaultSelector',side_effect=reason):
            with self.assertRaises(OSError) as error:run_client(['fixture-engine'],timeout=20,owner=owner)
            self.assertLessEqual(clock.now,20)
        self.assertIs(error.exception,reason)
        self.assertTrue(child.stdout.closed);self.assertTrue(child.stderr.closed)
        self.assertEqual(list(owner.owned_clients.values()),[child])
        self.assertEqual(owner.cleanup_uncertain,{'ENGINE_CLIENT_UNREAPED'})

    def test_close_failure_records_uncertainty_and_still_closes_other_pipe(self):
        owner=self.owner();child=self.child();reason=OSError('fixture selector allocation')
        with patch('reverie.worker_cleanup.subprocess.Popen',return_value=child), \
                patch('reverie.worker_cleanup.selectors.DefaultSelector',side_effect=reason), \
                patch.object(child.stdout,'close',side_effect=OSError('fixture close failure')) as close:
            with self.assertRaises(OSError) as error:run_client(['fixture-engine'],timeout=20,owner=owner)
            close.assert_called_once_with()
        self.assertIs(error.exception,reason)
        self.assertTrue(child.stderr.closed)
        self.assertEqual(owner.cleanup_uncertain,{'CLEANUP_ERROR'})

    def test_spawn_returning_after_stop_deadline_is_not_success(self):
        with Clock() as clock:
            owner = self.owner(); child = self.child(code=None, reap_on_kill=False)
            def spawn(*args, **kwargs):
                owner.stopping.set(); clock.sleep(34); return child
            with patch('reverie.worker_cleanup.subprocess.Popen', side_effect=spawn):
                with self.assertRaises(subprocess.TimeoutExpired):
                    run_client(['fixture-engine'], timeout=20, owner=owner)
            self.assertIn(child, owner.owned_clients.values())

    def test_office_close_never_calls_unbounded_shutdown_or_request_join(self):
        office = OfficeAPI.__new__(OfficeAPI)
        office.closing = __import__('threading').Event()
        connection = Mock(); upstream_socket = Mock()
        office.requests = {connection: None}
        office.upstreams = {connection: SimpleNamespace(sock=upstream_socket)}
        office.request_threads = {connection: Mock()}
        office.server = Mock(shutdown=Mock(side_effect=AssertionError('UNBOUNDED_SHUTDOWN')))
        office.thread = Mock(is_alive=Mock(return_value=True))
        office._unlink_socket = Mock()
        with Clock() as clock:
            clock.sleep(33.99)
            office.thread.join.side_effect = clock.sleep
            self.assertFalse(office.close(deadline=34))
            self.assertLessEqual(clock.now, 34)
        connection.shutdown.assert_called_once_with(socket.SHUT_RDWR)
        upstream_socket.shutdown.assert_called_once_with(socket.SHUT_RDWR)
        office.server.shutdown.assert_not_called()
        office.server.server_close.assert_called_once_with()

    def test_shutdown_refuses_new_launch_office_and_goal_work_without_spawn(self):
        broker = Broker({'maxWorkers':16})
        broker.stopping.set()
        with patch('reverie.worker_cleanup.subprocess.Popen', side_effect=AssertionError('SPAWN_FORBIDDEN')):
            for args in (['create','owned'], ['start','owned'], ['exec','owned'], ['network','create','owned']):
                with self.assertRaisesRegex(RuntimeError, 'cancelled'): broker.run_engine(args)
            with self.assertRaisesRegex(RuntimeError, 'stopping'): broker.office('fixture')
            with self.assertRaisesRegex(ValueError, 'unavailable'): broker.goals._engine(['inspect','owned'])

    def test_goal_inspection_preserves_exact_half_second_and_one_mib_bound(self):
        broker = Broker({'maxWorkers':16})
        with patch('reverie.goal_bootstrap.run_client', return_value=subprocess.CompletedProcess([],0,'[]','')) as run:
            self.assertEqual(broker.goals._engine(['ps','--all','--no-trunc','--quiet']), '[]')
        self.assertEqual(run.call_args.args, (['docker','ps','--all','--no-trunc','--quiet'],))
        self.assertEqual(run.call_args.kwargs, dict(timeout=.5, owner=broker, limit=1024*1024, stderr=False))

    def serve_fixture(self, broker, *, supervisor=None):
        broker.check_pool = Mock(); broker.recover = Mock()
        supervisor = supervisor or Mock(is_alive=Mock(return_value=False))
        original = socket.socket
        listener = Mock();listener.__enter__=Mock(return_value=listener);listener.__exit__=Mock(return_value=False)
        bound=[]
        def bind(path):
            sock=original(socket.AF_UNIX);sock.bind(path);bound.append(sock)
        listener.bind.side_effect=bind
        def stopped(): broker.stopping.set();raise TimeoutError
        listener.accept.side_effect=stopped
        with patch('reverie.worker.socket.socket',return_value=listener), \
                patch('reverie.worker.threading.Thread',return_value=supervisor):
            try: broker.serve()
            finally:
                for sock in bound:sock.close()

    def test_all_sixteen_offices_stop_before_any_join_and_within_unit_margin(self):
        with tempfile.TemporaryDirectory(prefix='broker-deadline-') as directory, Clock() as clock:
            broker=Broker({'maxWorkers':16,'socket':directory+'/broker.sock'})
            order=[]
            def finish(index,deadline):
                self.assertEqual(len([x for x in order if x[0]=='stop']),32)
                order.append(('join',index));clock.sleep(min(.5,remaining(deadline)));return True
            for i in range(16):
                office=Mock(request_close=Mock(side_effect=lambda i=i:order.append(('stop',i))),
                    close=Mock(side_effect=lambda deadline,i=i:finish(i,deadline)))
                broker.offices[str(i)]=office
            supervisor=Mock(is_alive=Mock(return_value=False),join=Mock(side_effect=lambda seconds:clock.sleep(seconds)))
            self.serve_fixture(broker,supervisor=supervisor)
            self.assertLessEqual(clock.now,13)
            self.assertEqual(broker.offices,{})
            self.assertEqual(broker.cleanup_uncertain,set())

    def test_sixteen_real_owned_office_listeners_stop_together_without_engine(self):
        import time
        with tempfile.TemporaryDirectory(prefix='office-close-') as directory:
            offices=[]
            try:
                for index in range(16):
                    offices.append(OfficeAPI(Path(directory)/str(index),'fixture','not-connected',Path(directory)))
                deadline=time.monotonic()+1
                for office in offices:office.request_close()
                for office in offices:self.assertTrue(office.close(deadline=deadline))
                self.assertLess(time.monotonic(),deadline)
                self.assertTrue(all(not office.thread.is_alive() for office in offices))
            finally:
                for office in offices:office.close()

    def test_shutdown_lock_unavailable_never_waits_past_shared_deadline(self):
        with tempfile.TemporaryDirectory(prefix='broker-deadline-') as directory, Clock() as clock:
            broker=Broker({'maxWorkers':16,'socket':directory+'/broker.sock'})
            office=Mock(close=Mock(return_value=False))
            broker.offices['fixture']=office
            def blocked(*,timeout):clock.sleep(timeout);return False
            broker.lock=Mock(acquire=Mock(side_effect=blocked))
            with self.assertRaises(CleanupUnconfirmed): self.serve_fixture(broker)
            self.assertLessEqual(clock.now,34)
            self.assertIn('LOCK_UNAVAILABLE',broker.cleanup_uncertain)
            self.assertIn('OFFICE_HANDLER_ACTIVE',broker.cleanup_uncertain)
            self.assertEqual(broker.offices,{'fixture':office})
            office.request_close.assert_called()

    def test_pre_session_handler_is_shutdown_joined_and_never_declared_complete(self):
        with tempfile.TemporaryDirectory(prefix='broker-deadline-') as directory, Clock() as clock:
            broker=Broker({'maxWorkers':16,'socket':directory+'/broker.sock'})
            connection=Mock();handler=Mock(join=Mock(side_effect=lambda seconds:clock.sleep(seconds)))
            broker.handlers[connection]=handler
            with self.assertRaises(CleanupUnconfirmed):self.serve_fixture(broker)
            connection.shutdown.assert_called_once_with(socket.SHUT_RDWR)
            self.assertIn(connection,broker.handlers)
            self.assertIn('HANDLER_ACTIVE',broker.cleanup_uncertain)
            self.assertLessEqual(clock.now,34)

    def test_handler_registry_exists_before_first_receive_and_slots_release(self):
        broker=Broker({'maxWorkers':16,'uid':os.getuid()})
        connection=Mock();connection.getsockopt.return_value=__import__('struct').pack('3i',1,os.getuid(),os.getgid())
        def receive(_):
            self.assertIn(connection,broker.handlers)
            self.assertEqual(broker.active,{})
            raise EOFError
        self.assertTrue(broker.connections.acquire(blocking=False))
        with patch('reverie.worker.receive_frame',side_effect=receive):broker.handle(connection)
        self.assertEqual(broker.handlers,{})
        for _ in range(20):self.assertTrue(broker.connections.acquire(blocking=False))
        self.assertFalse(broker.connections.acquire(blocking=False))

    def test_recovery_stopping_during_constructor_closes_new_office_and_no_more(self):
        broker=Broker({'maxWorkers':16,'deployment':'fixture','budgetMode':'pool',
            'apiSocketRoot':'/owned-fixture','companyRoot':'/owned-fixture'})
        broker.claim_storage=Mock(return_value=(SimpleNamespace(kind='maintenance'), False))  # Goal composition on 3be: storage is not under test here; 3be's recover() claims a lease per laptop
        first='11111111-2222-3333-4444-555555555555';second='22222222-2222-3333-4444-555555555555'
        broker.run_engine=Mock(return_value=subprocess.CompletedProcess([],0,'fixture-agent-'+first+'\nfixture-agent-'+second,''))
        office=Mock(close=Mock(return_value=True))
        def created(*args,**kwargs):broker.stopping.set();return office
        with patch('reverie.worker.OfficeAPI',side_effect=created) as create:
            with self.assertRaisesRegex(RuntimeError,'cancelled'):broker.recover()
        self.assertEqual(create.call_count,1)
        office.close.assert_called_once_with(deadline=broker.stopping.deadline)
        self.assertEqual(broker.offices,{})
        self.assertEqual([call.args[0][0] for call in broker.run_engine.call_args_list],['ps'])

    def test_diagnostic_is_closed_bounded_and_never_blocks_on_full_pipe(self):
        error=CleanupUnconfirmed({'VIEWER_UNREAPED','private/path-secret'})
        with patch('reverie.worker_cleanup.os.get_blocking',return_value=True), \
                patch('reverie.worker_cleanup.os.set_blocking') as flags, \
                patch('reverie.worker_cleanup.os.write',side_effect=BlockingIOError) as write:
            error.report()
        self.assertEqual(error.codes,('VIEWER_UNREAPED',))
        self.assertLess(len(write.call_args.args[1]),1024)
        self.assertEqual([c.args for c in flags.call_args_list],[(2,False),(2,True)])


    def test_resource_release_failure_stays_fatal_and_reports_its_fixed_code(self):
        with tempfile.TemporaryDirectory(prefix='broker-admission-cleanup-') as directory:
            broker = Broker({'maxWorkers': 1, 'socket': directory + '/broker.sock'})
            class FailedGuard:
                def __exit__(self, *_args):
                    raise OSError('synthetic private path/credential withheld')
            guard = FailedGuard()
            with self.assertRaisesRegex(RuntimeError, '^Resource admission release unconfirmed$'):
                broker._release_resource_admission(guard)
            broker.stop = Mock(side_effect=AssertionError('never stop a laptop in this control'))
            with self.assertRaises(CleanupUnconfirmed) as caught:
                self.serve_fixture(broker)
            self.assertEqual(caught.exception.codes, ('RESOURCE_ADMISSION_RELEASE_UNCONFIRMED',))
            self.assertEqual(str(caught.exception), 'Broker cleanup unconfirmed: RESOURCE_ADMISSION_RELEASE_UNCONFIRMED')
            self.assertIn('RESOURCE_ADMISSION_RELEASE_UNCONFIRMED', broker.cleanup_uncertain)
            broker.stop.assert_not_called()
            with patch('reverie.worker_cleanup.os.get_blocking', return_value=True), \
                    patch('reverie.worker_cleanup.os.set_blocking'), patch('reverie.worker_cleanup.os.write') as write:
                caught.exception.report()
            self.assertEqual(write.call_args.args[1], b'Broker cleanup unconfirmed: RESOURCE_ADMISSION_RELEASE_UNCONFIRMED\n')

    def test_unknown_or_empty_failure_reason_is_redacted_but_never_empty(self):
        for values in (set(), {'/synthetic/private/credential-body'}):
            with self.subTest(values=values):
                error = CleanupUnconfirmed(values)
                self.assertEqual(error.codes, ('CLEANUP_ERROR',))
                self.assertEqual(str(error), 'Broker cleanup unconfirmed: CLEANUP_ERROR')
                self.assertNotIn('credential', str(error))

    def test_all_fixed_broker_cleanup_producers_have_diagnostic_codes(self):
        import ast
        import reverie.worker as worker
        from reverie.worker_cleanup import CLEANUP_CODES
        tree = ast.parse(Path(worker.__file__).read_bytes())
        produced = {node.args[0].value for node in ast.walk(tree)
                    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                    and node.func.attr == 'add' and isinstance(node.func.value, ast.Attribute)
                    and node.func.value.attr == 'cleanup_uncertain' and len(node.args) == 1
                    and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str)}
        self.assertIn('RESOURCE_ADMISSION_RELEASE_UNCONFIRMED', produced)
        self.assertEqual(produced - CLEANUP_CODES, set())


    def test_real_owned_timeout_can_settle_client_fact_without_replaying_command(self):
        import sys, time
        owner = self.owner()
        with self.assertRaises(subprocess.TimeoutExpired):
            run_client([sys.executable, '-I', '-B', '-c', 'import time; time.sleep(30)'],
                       timeout=.05, owner=owner)
        owner.stopping.set()
        settle_owned_clients(owner, min(owner.stopping.deadline, time.monotonic()+1))
        self.assertEqual(owner.owned_clients, {})
        self.assertNotIn('ENGINE_CLIENT_UNREAPED', owner.cleanup_uncertain)

    def test_exact_late_reap_settles_only_owned_client_marker(self):
        owner = self.owner(); child = self.child(code=None, reap_on_kill=False)
        with Clock(), patch('reverie.worker_cleanup.subprocess.Popen', return_value=child):
            with self.assertRaises(subprocess.TimeoutExpired):
                run_client(['fixture-engine'], timeout=.05, owner=owner)
            self.assertEqual(owner.cleanup_uncertain, {'ENGINE_CLIENT_UNREAPED'})
            child.returncode = -9  # Exact original owned Popen, not a PID lookup.
            owner.stopping.set()
            settle_owned_clients(owner, owner.stopping.deadline)
        self.assertEqual(owner.owned_clients, {})
        self.assertEqual(owner.cleanup_uncertain, set())

    def test_genuinely_unreapable_client_remains_fatal_with_original_budget(self):
        owner = self.owner(); child = self.child(code=None, reap_on_kill=False)
        with Clock() as clock, patch('reverie.worker_cleanup.subprocess.Popen', return_value=child):
            owner.stopping.set()
            with self.assertRaises(subprocess.TimeoutExpired):
                run_client(['fixture-engine'], timeout=20, owner=owner)
            settle_owned_clients(owner, owner.stopping.deadline)
            self.assertLessEqual(clock.now, 34)
        self.assertEqual(list(owner.owned_clients.values()), [child])
        self.assertEqual(owner.cleanup_uncertain, {'ENGINE_CLIENT_UNREAPED'})

    def test_opaque_prior_client_and_other_uncertainty_never_cleared(self):
        owner = self.owner(); child = self.child(code=None, reap_on_kill=False)
        owner.cleanup_uncertain.update({'ENGINE_CLIENT_UNREAPED', 'RESOURCE_ADMISSION_RELEASE_UNCONFIRMED'})
        with Clock(), patch('reverie.worker_cleanup.subprocess.Popen', return_value=child):
            with self.assertRaises(subprocess.TimeoutExpired):
                run_client(['fixture-engine'], timeout=.05, owner=owner)
            child.returncode = -9; owner.stopping.set()
            settle_owned_clients(owner, owner.stopping.deadline)
        self.assertEqual(owner.owned_clients, {})
        self.assertEqual(owner.cleanup_uncertain, {'ENGINE_CLIENT_UNREAPED', 'RESOURCE_ADMISSION_RELEASE_UNCONFIRMED'})

    def test_pending_constructor_publication_is_waited_within_same_budget(self):
        owner = self.owner(); token = object(); child = self.child(code=0)
        owner.owned_clients[token] = None
        with Clock() as clock:
            owner.stopping.set()
            def published(seconds):
                clock.sleep(seconds); owner.owned_clients[token] = child
            with patch('reverie.worker_cleanup.time.sleep', side_effect=published):
                settle_owned_clients(owner, owner.stopping.deadline)
            self.assertLessEqual(clock.now, .01)
        self.assertEqual(owner.owned_clients, {})
        self.assertEqual(owner.cleanup_uncertain, set())

    def test_pending_constructor_after_deadline_remains_owned_and_fatal(self):
        owner = self.owner(); token = object(); owner.owned_clients[token] = None
        with Clock() as clock:
            owner.stopping.set(); clock.sleep(33.99)
            settle_owned_clients(owner, owner.stopping.deadline)
            self.assertLessEqual(clock.now, 34)
        self.assertEqual(owner.owned_clients, {token: None})
        self.assertEqual(owner.cleanup_uncertain, {'ENGINE_CLIENT_UNREAPED'})

    def test_supervisor_constructor_finalizer_precedes_terminal_client_sweep(self):
        with tempfile.TemporaryDirectory(prefix='broker-client-') as directory, Clock():
            broker = Broker({'maxWorkers': 1, 'socket': directory+'/broker.sock'})
            token = object(); child = self.child(code=0)
            broker.owned_clients[token] = None
            def finished(_seconds): broker.owned_clients[token] = child
            supervisor = Mock(is_alive=Mock(return_value=False), join=Mock(side_effect=finished))
            self.serve_fixture(broker, supervisor=supervisor)
            self.assertEqual(broker.owned_clients, {})
            self.assertEqual(broker.cleanup_uncertain, set())


    def test_expired_final_bookkeeping_mutex_never_waits(self):
        import threading, time
        from reverie import worker_cleanup as cleanup
        owner = self.owner(); done = threading.Event(); failures = []
        def settle():
            try: settle_owned_clients(owner, time.monotonic()-1)
            except BaseException as error: failures.append(type(error).__name__)
            finally: done.set()
        cleanup._CLIENT_STATE_LOCK.acquire()
        thread = threading.Thread(target=settle)
        try:
            thread.start()
            self.assertTrue(done.wait(.1), 'expired cleanup blocked on bookkeeping mutex')
            self.assertEqual(owner.cleanup_uncertain, {'ENGINE_CLIENT_UNREAPED', 'LOCK_UNAVAILABLE'})
        finally:
            cleanup._CLIENT_STATE_LOCK.release(); thread.join(1)
        self.assertFalse(thread.is_alive()); self.assertEqual(failures, [])

    def test_future_final_bookkeeping_mutex_uses_original_deadline(self):
        import threading, time
        from reverie import worker_cleanup as cleanup
        owner = self.owner(); done = threading.Event(); elapsed = []
        def settle():
            start = time.monotonic()
            try: settle_owned_clients(owner, start+.03)
            finally: elapsed.append(time.monotonic()-start); done.set()
        cleanup._CLIENT_STATE_LOCK.acquire(); thread = threading.Thread(target=settle)
        try:
            thread.start(); self.assertTrue(done.wait(.2))
            self.assertLess(elapsed[0], .2)
            self.assertIn('LOCK_UNAVAILABLE', owner.cleanup_uncertain)
        finally:
            cleanup._CLIENT_STATE_LOCK.release(); thread.join(1)
        self.assertFalse(thread.is_alive())

    def test_owned_run_client_timeout_does_not_wait_on_held_bookkeeping_mutex(self):
        import sys, threading, time
        from reverie import worker_cleanup as cleanup
        owner = self.owner(); owner.stopping.set(); done = threading.Event(); outcomes = []
        def command():
            try:
                run_client([sys.executable, '-I', '-B', '-c', 'import time; time.sleep(30)'],
                           timeout=.03, owner=owner)
            except subprocess.TimeoutExpired: outcomes.append('original-timeout')
            except BaseException as error: outcomes.append(type(error).__name__)
            finally: done.set()
        cleanup._CLIENT_STATE_LOCK.acquire(); thread = threading.Thread(target=command)
        try:
            thread.start(); self.assertTrue(done.wait(.2))
            self.assertEqual(outcomes, ['original-timeout'])
            self.assertEqual(owner.cleanup_uncertain, {'ENGINE_CLIENT_UNREAPED', 'LOCK_UNAVAILABLE'})
        finally:
            cleanup._CLIENT_STATE_LOCK.release(); thread.join(1)
            settle_owned_clients(owner, min(owner.stopping.deadline, time.monotonic()+1))
        self.assertFalse(thread.is_alive()); self.assertEqual(owner.owned_clients, {})
        self.assertEqual(owner.cleanup_uncertain, {'ENGINE_CLIENT_UNREAPED', 'LOCK_UNAVAILABLE'})

    def test_unreaped_record_mutex_uses_original_command_deadline(self):
        import threading, time
        from reverie import worker_cleanup as cleanup
        owner = self.owner(); child = self.child(code=None, reap_on_kill=False)
        token = object(); owner.owned_clients[token] = child; done = threading.Event()
        def mark():
            try: cleanup._client_unreaped(owner, token, child, time.monotonic()+.03)
            finally: done.set()
        cleanup._CLIENT_STATE_LOCK.acquire(); thread = threading.Thread(target=mark)
        try:
            thread.start(); self.assertTrue(done.wait(.2))
            self.assertEqual(owner.owned_clients, {token: child})
            self.assertEqual(owner.cleanup_uncertain, {'ENGINE_CLIENT_UNREAPED', 'LOCK_UNAVAILABLE'})
        finally:
            cleanup._CLIENT_STATE_LOCK.release(); thread.join(1)
        child.returncode = -9; owner.stopping.set()
        settle_owned_clients(owner, owner.stopping.deadline)
        self.assertEqual(owner.owned_clients, {})
        self.assertEqual(owner.cleanup_uncertain, {'ENGINE_CLIENT_UNREAPED', 'LOCK_UNAVAILABLE'})

    def test_late_opaque_mutex_failure_cannot_lose_marker_during_owned_clear(self):
        import time
        from reverie import worker_cleanup as cleanup
        owner = self.owner(); child = self.child(code=None, reap_on_kill=False)
        with Clock(), patch('reverie.worker_cleanup.subprocess.Popen', return_value=child):
            with self.assertRaises(subprocess.TimeoutExpired):run_client(['fixture-engine'], timeout=.01, owner=owner)
        child.returncode = -9; late = self.child(code=0); late_token = object()
        class LateOpaque(set):
            def discard(self, code):
                owner.owned_clients[late_token] = late
                cleanup._client_unreaped(owner, late_token, late, time.monotonic()-1)
                super().discard(code)
        owner.cleanup_uncertain = LateOpaque(owner.cleanup_uncertain); owner.stopping.set()
        settle_owned_clients(owner, owner.stopping.deadline)
        self.assertEqual(owner.cleanup_uncertain, {'ENGINE_CLIENT_UNREAPED', 'LOCK_UNAVAILABLE'})
        settle_owned_clients(owner, owner.stopping.deadline)
        self.assertEqual(owner.owned_clients, {})
        self.assertEqual(owner.cleanup_uncertain, {'ENGINE_CLIENT_UNREAPED', 'LOCK_UNAVAILABLE'})


class VersionTests(unittest.TestCase):
    def test_actual_g_rejects_all_noncanonical_config_versions(self):
        for version in (True, False, '1', None, 0, 2, 1.0, {}, []):
            fixture = owner_fixture.OwnerGoalBrokerTests(methodName='runTest'); fixture.setUp()
            try:
                fixture.write(fixture.goal_config, {**fixture.goal,'version':version})
                self.assertEqual(fixture.dispatch({'action':'goal-custody'})[0], b'E', version)
            finally: fixture.doCleanups()

    def test_real_g_producer_and_client_numeric_version_remain_compatible(self):
        fixture = owner_fixture.OwnerGoalBrokerTests(methodName='runTest'); fixture.setUp()
        try:
            kind, raw = fixture.dispatch({'action':'goal-custody'})
            result = json.loads(raw)
            self.assertEqual(kind,b'J'); self.assertIs(type(result['version']),int)
            self.assertEqual(result['version'],1); self.assertEqual(len(result['identities']),14)
        finally: fixture.doCleanups()

    def test_reply_client_rejects_boolean_unknown_and_noninteger_versions(self):
        # Exercise actual client parser with a mocked owned AF_UNIX transport;
        # no host socket is opened. Numeric1 uses the same real producer shape.
        from reverie.goal_custody_client import project
        fixture = owner_fixture.OwnerGoalBrokerTests(methodName='runTest'); fixture.setUp()
        try:
            _, raw = fixture.dispatch({'action':'goal-custody'})
            projection = json.loads(raw)
            info = SimpleNamespace(st_mode=__import__('stat').S_IFSOCK|0o600,st_dev=1,st_ino=2)
            for version in (True,False,'1',None,0,2,1.0,1):
                body=json.dumps({**projection,'version':version}).encode()
                response=bytearray(b'J'+__import__('struct').pack('!I',len(body))+body)
                client=Mock(); client.__enter__=Mock(return_value=client);client.__exit__=Mock(return_value=False)
                client.getsockopt.return_value=__import__('struct').pack('3i',1,os.getuid(),os.getgid())
                def read(size): value=bytes(response[:size]);del response[:size];return value
                client.recv.side_effect=read
                with patch.dict(os.environ,REVERIE_WORKER_SOCKET='/owned-fixture/socket'), \
                        patch('reverie.goal_custody_client.Path.lstat',return_value=info), \
                        patch('reverie.goal_custody_client.socket.socket',return_value=client):
                    if type(version) is int and version==1:
                        self.assertEqual(project(emit=False),projection)
                    else:
                        with self.assertRaises(ValueError): project(emit=False)
        finally: fixture.doCleanups()


if __name__ == '__main__': unittest.main()
