"""Owned synthetic owner-only broker composition; no real engine/host/private state."""
import tests  # noqa: F401
import http.client
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from reverie.worker import Broker, OfficeAPI, load_config, receive_frame, send_frame
from reverie.goal_private import private_entry

SID = '11111111-2222-3333-4444-555555555555'
SERVER = 'a' * 64
LAPTOP = 'b' * 64


class OwnerGoalBrokerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='ogb-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.private = self.root/'private'; self.private.mkdir(mode=0o700)
        self.public = self.root/'public'; self.public.mkdir()
        self.control = self.root/'control'; self.control.mkdir(mode=0o700)
        self.company = self.private/'company.json'
        self.write(self.company, {'employees': [{'id': 'employee:1', 'sessionId': SID,
                   'sessionGeneration': 7, 'desiredRunning': True}]})
        self.key = self.private/'key'; self.key.write_bytes(b'S' * 32); self.key.chmod(0o600)
        self.authority = self.private/'authority'; self.authority.mkdir(mode=0o700)
        nonces = self.private/'nonces'; nonces.mkdir(mode=0o700)
        self.nonce = nonces/'nonce.json'; self.write(self.nonce, {})
        self.write(Path(str(self.nonce)+'.lock'), {})
        self.goal_config = self.private/'goals.json'
        self.goal = dict(version=1, mode='owner-only', issuer='fixture', epoch='fixture-1', serverContainerId=SERVER,
            paths={name: dict(host=str(value), server=str(value)) for name, value in dict(
                config=self.goal_config, key=self.key, canonical=self.company, nonce=self.nonce,
                authority=self.authority).items()},
            nonce=dict(storeId=SID, capacity=32, flockExecutable='/nix/store/synthetic/flock'),
            server=dict(brokerSocket=str(self.control/'broker.sock'), custodyClient='/nix/store/synthetic/client'))
        self.write(self.goal_config, self.goal)
        self.config = dict(version=1, deployment='test', image='sha256:'+'c'*64,
            serverContainer='test-console', socket=str(self.control/'broker.sock'),
            stateRoot=str(self.root/'workers'), companyFile=str(self.company), companyRoot=str(self.private),
            scratchRoot=str(self.root/'scratch'), apiSocketRoot=str(self.root/'offices'), budgetMode='admission',
            uid=os.getuid(), gid=os.getgid(), memoryMiB=512, poolMemoryMiB=8192, poolTasksMax=1024,
            cgroupParent='reverie-workers.slice', pidsLimit=128, cpus=0, maxWorkers=16, maintenanceSessions=[],
            mounts=[dict(source=str(self.public), destination='/workspace', readOnly=False)],
            goalPrivateConfig=str(self.goal_config))
        self.worker_file = self.root/'worker.json'; self.write(self.worker_file, self.config)
        self.broker = Broker(self.config, config_file=str(self.worker_file))
        self.broker.run_engine = Mock(side_effect=AssertionError('REAL_ENGINE_FORBIDDEN'))
        self.items = [dict(Id=SERVER, Name='/test-console', State=dict(Running=True, Pid=os.getpid()),
            Config=dict(User=f'{os.getuid()}:{os.getgid()}'), HostConfig=dict(Runtime='runc', Privileged=False),
            Mounts=[dict(Type='bind', Source=str(self.root), Destination=str(self.root), RW=True)]),
            dict(Id=LAPTOP, Name='/test-agent-'+SID, State=dict(Running=True, Pid=99999),
            Config=dict(Labels={'reverie.worker': 'test', 'reverie.session': SID}),
            HostConfig=dict(Runtime='runc', Privileged=False),
            Mounts=[dict(Type='bind', Source=str(self.public), Destination='/workspace', RW=True)])]
        self.inventory_calls = []
        def inventory(args):
            self.inventory_calls.append(args)
            ids = [item['Id'] for item in self.items]
            if args == ['ps', '--all', '--no-trunc', '--quiet']: return '\n'.join(ids)
            if args == ['inspect', *ids]: return json.dumps(self.items)
            raise AssertionError('ONLY_SYNTHETIC_INVENTORY')
        self.broker.goals._engine = inventory

    def write(self, path, value):
        path.write_text(json.dumps(value)); path.chmod(0o600)

    def dispatch(self, payload, kind=b'G'):
        server, client = socket.socketpair()
        self.addCleanup(client.close)
        client.settimeout(2)
        send_frame(client, kind, payload if isinstance(payload, bytes) else json.dumps(payload).encode())
        self.broker.connections.acquire()
        self.broker.handle(server)
        return receive_frame(client)

    def test_closed_g_uses_real_owned_peer_and_is_read_only_before_any_office_or_launch(self):
        before = {p: p.read_bytes() for p in (self.worker_file, self.goal_config, self.company, self.key, self.nonce)}
        with patch('reverie.goal_bootstrap.private_entry', wraps=private_entry) as entries, \
                patch.object(self.broker.goals, 'signer', side_effect=AssertionError('SIGNER_FORBIDDEN')), \
                patch('reverie.worker.OfficeAPI', side_effect=AssertionError('OFFICE_FORBIDDEN')):
            kind, raw = self.dispatch({'action': 'goal-custody'})
        self.assertEqual(kind, b'J')
        result = json.loads(raw)
        self.assertEqual(set(result), {'version', 'configDigest', 'identities'})
        self.assertEqual(len(result['identities']), 14)
        self.assertLessEqual(len(raw), 32768)
        self.assertFalse(any(c.kwargs.get('limit') == 32 for c in entries.call_args_list))
        self.assertEqual({p: p.read_bytes() for p in before}, before)
        self.assertFalse(Path(self.config['stateRoot']).exists())
        self.assertEqual((self.broker.active, self.broker.offices, self.broker.laptops), ({}, {}, {}))
        self.broker.run_engine.assert_not_called()
        self.assertEqual(self.broker.generation, 0)

    def test_g_refuses_missing_config_malformed_payload_extra_inputs_and_bad_peer(self):
        for payload in [b'not json', {'action': 'other'}, {'action': 'goal-custody', 'sessionId': SID},
                        {'action': 'goal-custody', 'path': '/private'}, {'action': 'goal-custody', 'command': 'no'}]:
            with self.subTest(payload=payload): self.assertEqual(self.dispatch(payload)[0], b'E')
        self.assertEqual(self.inventory_calls, [])

    def test_missing_private_config_and_bad_peer_refuse_without_inventory(self):
        old = self.config.pop('goalPrivateConfig')
        self.assertEqual(self.dispatch({'action': 'goal-custody'})[0], b'E')
        self.config['goalPrivateConfig'] = old
        self.config['uid'] += 1
        self.assertEqual(self.dispatch({'action': 'goal-custody'})[0], b'E')
        self.assertEqual(self.inventory_calls, [])

    def test_shared_closed_mode_schema_is_exact_and_restricted_broker_never_upgrades(self):
        for mode in [None, '', 'owner', 'OWNER-ONLY', True, ['owner-only']]:
            config = {**self.goal, 'mode': mode}
            if mode is None: del config['mode']
            self.write(self.goal_config, config)
            fresh = Broker(self.config, config_file=str(self.worker_file))
            with self.subTest(mode=mode), self.assertRaises(ValueError): fresh.goals.config()
        self.write(self.goal_config, {**self.goal, 'mode': 'owner-and-employee'})
        self.broker = Broker(self.config, config_file=str(self.worker_file))
        self.assertEqual(self.broker.goals.config()[0]['mode'], 'owner-and-employee')
        self.assertEqual(self.dispatch({'action': 'goal-custody'})[0], b'E')
        self.assertFalse(self.broker.offices)

    def test_mode_change_requires_restart_and_owner_only_signer_never_reads_content(self):
        self.assertEqual(self.dispatch({'action': 'goal-custody'})[0], b'J')
        self.broker.goals._program_observer = Mock()
        with patch('reverie.goal_bootstrap.private_entry', wraps=private_entry) as entries:
            with self.assertRaises(ValueError): self.broker.goals.signer(SID)
            self.broker.goals._program_observer.assert_not_called()
            self.assertFalse(any(c.kwargs.get('limit') == 32 for c in entries.call_args_list))
        self.write(self.goal_config, {**self.goal, 'mode': 'owner-and-employee'})
        self.assertEqual(self.dispatch({'action': 'goal-custody'})[0], b'E')
        with self.assertRaisesRegex(ValueError, 'restart required'): self.broker.goals.config()

    def test_g_sibling_namespace_and_exposure_refuse_without_key_content(self):
        original = os.stat
        def namespace(path, *args, **kwargs):
            info = original(path, *args, **kwargs)
            if str(path) == f'/proc/{os.getpid()}/ns/mnt':
                # Different return on the second comparison side only.
                namespace.count += 1
                if namespace.count % 2 == 0:
                    return Mock(st_ino=info.st_ino + 1)
            return info
        namespace.count = 0
        with patch('reverie.goal_bootstrap.os.stat', side_effect=namespace):
            self.assertEqual(self.dispatch({'action': 'goal-custody'})[0], b'E')
        self.items[1]['Mounts'] = [dict(Type='bind', Source=str(self.private), Destination='/exposed', RW=False)]
        with patch('reverie.goal_bootstrap.private_entry', wraps=private_entry) as entries:
            self.assertEqual(self.dispatch({'action': 'goal-custody'})[0], b'E')
            self.assertFalse(any(c.kwargs.get('limit') == 32 for c in entries.call_args_list))

    def test_real_packaging_invocation_stream_uses_only_closed_g_and_fresh_response(self):
        endpoint = Path(self.config['socket'])
        listener = socket.socket(socket.AF_UNIX); self.addCleanup(listener.close)
        listener.bind(str(endpoint)); endpoint.chmod(0o600); listener.listen(1); listener.settimeout(3)
        errors = []
        def serve():
            try:
                for _ in range(2):
                    connection, _ = listener.accept()
                    self.broker.connections.acquire()
                    self.broker.handle(connection)
            except BaseException as error: errors.append(error)
        thread = threading.Thread(target=serve, daemon=True); thread.start()
        env = {'PATH': os.environ['PATH'], 'PYTHONPATH': str(Path(__file__).resolve().parents[1]/'python'),
               'REVERIE_WORKER_SOCKET': str(endpoint), 'PYTHONDONTWRITEBYTECODE': '1'}
        result = subprocess.run([sys.executable, '-m', 'reverie.worker', 'client', '--goal-custody-stream'],
                                input=b'GG', capture_output=True, env=env, timeout=5)
        thread.join(3)
        self.assertFalse(thread.is_alive()); self.assertEqual(errors, [])
        self.assertEqual(result.returncode, 0, result.stderr)
        data = result.stdout
        for _ in range(2):
            self.assertEqual(data[:1], b'J'); length = struct.unpack('!I', data[1:5])[0]
            self.assertEqual(set(json.loads(data[5:5+length])), {'version', 'configDigest', 'identities'})
            data = data[5+length:]
        self.assertEqual(data, b''); self.assertEqual(len(self.inventory_calls), 4)
        self.assertIn('exec ${memory}/bin/python3 -m reverie.worker client',
                      (Path(__file__).resolve().parents[1]/'nix/package.nix').read_text())

    def test_packaged_helper_mixed_arguments_and_bad_or_oversized_replies_fail_closed(self):
        env = {'PATH': os.environ['PATH'], 'PYTHONPATH': str(Path(__file__).resolve().parents[1]/'python'),
               'PYTHONDONTWRITEBYTECODE': '1'}
        command = [sys.executable, '-m', 'reverie.worker', 'client', '--goal-custody-stream']
        mixed = subprocess.run([*command, '--caller-session', SID], input=b'G', capture_output=True,
                               env=env, timeout=3)
        self.assertNotEqual(mixed.returncode, 0); self.assertEqual(mixed.stdout, b'')
        for label, reply in [('old', b'E'+struct.pack('!I', 0)), ('oversized', b'J'+struct.pack('!I', 32769))]:
            path = self.control/(label+'.sock')
            listener = socket.socket(socket.AF_UNIX); listener.bind(str(path)); path.chmod(0o600)
            listener.listen(1); listener.settimeout(3)
            errors = []
            def answer():
                try:
                    connection, _ = listener.accept()
                    with connection:
                        connection.recv(1024); connection.sendall(reply)
                except BaseException as error: errors.append(error)
            thread = threading.Thread(target=answer, daemon=True); thread.start()
            try:
                result = subprocess.run(command, input=b'G', capture_output=True,
                    env={**env, 'REVERIE_WORKER_SOCKET': str(path)}, timeout=3)
            finally:
                thread.join(3); listener.close()
            self.assertFalse(thread.is_alive()); self.assertEqual(errors, [])
            self.assertNotEqual(result.returncode, 0); self.assertEqual(result.stdout, b'')

    def test_existing_office_upstream_runtime_error_closes_request_without_widening_route(self):
        console = self.private/'console'; console.mkdir(mode=0o700)
        (console/'.env').write_text('REVERIE_USERNAME=synthetic\nREVERIE_PASSWORD=synthetic-only\n')
        original = http.client.HTTPConnection
        class Local(original):
            def connect(local):
                local.sock = socket.socket(socket.AF_UNIX); local.sock.connect(str(path))
        upstream = Mock(); upstream.request.side_effect = RuntimeError('synthetic upstream failure')
        api = OfficeAPI(self.root/'failed-office', SID, 'never-contacted', self.private)
        self.addCleanup(api.close); path = self.root/'failed-office/office.sock'
        with patch('reverie.worker.http.client.HTTPConnection', return_value=upstream):
            client = Local('unused', timeout=2)
            try:
                client.request('GET', '/api/status')
                with self.assertRaises(http.client.RemoteDisconnected): client.getresponse()
            finally: client.close()
        upstream.close.assert_called_once()

    def test_config_loader_accepts_only_existing_explicit_path_and_keeps_resource_limits(self):
        self.assertEqual(load_config(self.worker_file), self.config)
        for value in ['', '/', 'relative', '/a/../b']:
            self.write(self.worker_file, {**self.config, 'goalPrivateConfig': value})
            with self.subTest(value=value), self.assertRaises(ValueError): load_config(self.worker_file)
        self.assertEqual(self.config['maxWorkers'], 16)
        for file in ('flake.nix', 'nix/worker-isolation.nix'):
            text = (Path(__file__).resolve().parents[1]/file).read_text()
            self.assertIn('TasksMax', text); self.assertNotIn('TasksMax=1024', text)

    def test_recover_max_population_preserves_host_actions_and_never_requests_signer_or_generation(self):
        ids = [f'{i:08x}-2222-3333-4444-555555555555' for i in range(16)]
        self.broker.run_engine = Mock(return_value=subprocess.CompletedProcess([], 0,
                                    '\n'.join('test-agent-'+s for s in ids), ''))
        self.broker.host_actions = object()
        with patch('reverie.worker.OfficeAPI') as offices, \
                patch.object(self.broker.goals, 'signer', side_effect=AssertionError('SIGNER_FORBIDDEN')), \
                patch.object(self.broker.goals, 'persist_launch', side_effect=AssertionError('PIN_FORBIDDEN')):
            self.broker.recover()
            self.assertEqual(offices.call_count, 16)
            for call in offices.call_args_list:
                self.assertEqual(set(call.kwargs), {'host_actions'})
                self.assertIs(call.kwargs['host_actions'], self.broker.host_actions)
        self.assertEqual(self.broker.generation, 0)
        self.assertFalse(Path(self.config['stateRoot']).exists())
        self.assertEqual([c.args[0][0] for c in self.broker.run_engine.call_args_list], ['ps'])

    def test_real_local_max_population_offices_close_without_provider_or_runtime_effect(self):
        ids = [f'{i:08x}-2222-3333-4444-555555555555' for i in range(16)]
        self.broker.run_engine = Mock(return_value=subprocess.CompletedProcess([], 0,
                                    '\n'.join('test-agent-'+s for s in ids), ''))
        with patch.object(self.broker.goals, 'signer', side_effect=AssertionError('SIGNER_FORBIDDEN')):
            self.broker.recover()
        offices = list(self.broker.offices.values())
        try:
            self.assertEqual(len(offices), 16)
            self.assertTrue(all(office.thread.is_alive() for office in offices))
        finally:
            for office in offices: office.close()
        self.assertTrue(all(not office.thread.is_alive() for office in offices))
        self.assertTrue(all(not (Path(self.config['apiSocketRoot'])/sid/'office.sock').exists() for sid in ids))
        self.assertEqual([c.args[0][0] for c in self.broker.run_engine.call_args_list], ['ps'])
        self.assertFalse(Path(self.config['stateRoot']).exists())

    def test_failed_recover_closes_real_partial_offices_only(self):
        ids = [f'{i:08x}-2222-3333-4444-555555555555' for i in range(3)]
        self.broker.run_engine = Mock(return_value=subprocess.CompletedProcess([], 0,
                                    '\n'.join('test-agent-'+s for s in ids), ''))
        opened = []
        def allocate(*args, **kwargs):
            if len(opened) == 2: raise RuntimeError('synthetic third office allocation')
            api = OfficeAPI(*args, **kwargs); opened.append(api); return api
        with patch('reverie.worker.OfficeAPI', side_effect=allocate):
            with self.assertRaisesRegex(RuntimeError, 'third office'): self.broker.recover()
        self.assertEqual((self.broker.offices, self.broker.laptops), ({}, {}))
        self.assertTrue(all(not office.thread.is_alive() for office in opened))
        self.assertTrue(all(not office.socket_path.exists() for office in opened))
        self.assertEqual([c.args[0][0] for c in self.broker.run_engine.call_args_list], ['ps'])

    def test_aggregate_teardown_uses_shared_budget_and_reports_unfinished_handlers(self):
        # Original38s defect witness is retained byte-identical in the packet.
        # Here mock Offices honor the explicit shared deadline and all receive
        # stop before joins. No real sleep/signals/engine.
        clock = [0.]
        self.broker.check_pool = Mock()
        self.broker.recover = Mock()
        self.broker.active = {SID: Mock()}
        def spend(seconds): clock[0] += seconds
        requested = []
        def finish(index, deadline):
            self.assertEqual(len(requested), 32)
            spend(min(.5, max(0, deadline-clock[0])))
            return True
        self.broker.offices = {str(i): Mock(request_close=Mock(side_effect=lambda i=i: requested.append(i)),
            close=Mock(side_effect=lambda deadline, i=i: finish(i, deadline))) for i in range(16)}
        supervisor = Mock(join=Mock(side_effect=lambda seconds: spend(seconds)), is_alive=Mock(return_value=False))
        original = socket.socket
        bound = []
        listener = Mock(); listener.__enter__ = Mock(return_value=listener); listener.__exit__ = Mock(return_value=False)
        def bind(path):
            local = original(socket.AF_UNIX); local.bind(path); bound.append(local)
        listener.bind.side_effect = bind
        listener.accept.side_effect = lambda: (self.broker.stopping.set(), (_ for _ in ()).throw(TimeoutError()))[1]
        with patch('reverie.worker.socket.socket', return_value=listener), \
                patch('reverie.worker.threading.Thread', return_value=supervisor), \
                patch('reverie.worker.time.monotonic', side_effect=lambda: clock[0]), \
                patch('reverie.worker.time.sleep', side_effect=spend):
            try:
                with self.assertRaisesRegex(RuntimeError, 'HANDLER_ACTIVE'):
                    self.broker.serve()
            finally:
                for local in bound: local.close()
        self.assertLessEqual(clock[0], 34)
        self.assertLess(clock[0], 35)
        self.broker.run_engine.assert_not_called()
        self.assertEqual(self.broker.generation, 0)

    def test_recovery_retains_mixed_effective_resource_accounting_before_threads(self):
        self.broker.claim_storage = Mock(return_value=(SimpleNamespace(kind='maintenance'), False))  # Goal composition on 3be: storage is not under test here; 3be's recover() claims a lease per laptop
        self.broker.run_engine = Mock(return_value=subprocess.CompletedProcess([], 0, 'test-agent-'+SID, ''))
        self.config['poolMemoryMiB'] = 512
        self.config['sessionResources'] = {SID: dict(budgetMode='pool', memoryMiB=0, pidsLimit=128,
            cpus=0, poolMemoryMiB=1024, poolTasksMax=1024)}
        with patch('reverie.worker.OfficeAPI') as offices:
            self.broker.recover(); offices.assert_called_once()
        self.broker.laptops.clear(); self.broker.offices.clear()
        self.config['sessionResources'][SID].update(budgetMode='admission', memoryMiB=1024)
        with patch('reverie.worker.OfficeAPI') as offices:
            with self.assertRaises(RuntimeError): self.broker.recover()
            offices.assert_not_called()

    def test_office_refuses_all_worker_goal_paths_and_strips_proofs_from_other_routes(self):
        company = self.private/'console'; company.mkdir(mode=0o700)
        (company/'.env').write_text('REVERIE_USERNAME=synthetic\nREVERIE_PASSWORD=synthetic-only\n')
        original = http.client.HTTPConnection
        class Local(original):
            def connect(local):
                local.sock = socket.socket(socket.AF_UNIX); local.sock.connect(str(path))
        response = Mock(status=200)
        response.getheaders.return_value = [('Content-Length', '2')]
        response.read1.side_effect = [b'{}', b'']
        upstream = Mock(); upstream.getresponse.return_value = response
        api = OfficeAPI(self.root/'local-office', SID, 'never-contacted', self.private)
        self.addCleanup(api.close); path = self.root/'local-office/office.sock'
        with patch('reverie.worker.http.client.HTTPConnection', return_value=upstream):
            for method, target in [('GET', '/api/goals'), ('POST', '/api/goals'),
                                   ('GET', '/api/goal-metadata/e'), ('POST', '/api/goals/x/transitions')]:
                client = Local('unused', timeout=2)
                client.request(method, target, headers={'X-Reverie-Goal-Assertion': 'forged'})
                answer = client.getresponse(); self.assertEqual(answer.status, 403); answer.read(); client.close()
            upstream.request.assert_not_called()
            client = Local('unused', timeout=2)
            client.request('GET', '/api/status', headers={'X-Reverie-Goal-Assertion': 'strip-me'})
            answer = client.getresponse(); self.assertEqual(answer.status, 200); answer.read(); client.close()
        headers = upstream.request.call_args.kwargs['headers']
        self.assertFalse(any(k.lower().startswith('x-reverie-goal-') for k in headers))
        self.assertEqual(headers['X-Reverie-Parent-Session'], SID)


if __name__ == '__main__': unittest.main()
