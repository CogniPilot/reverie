"""Real config/custody/signing; engine and exact program observer are synthetic.
No live engine, sockets, host files, credentials or laptop processes are used.
"""
from copy import deepcopy
import contextlib
import io
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

from reverie.worker import Broker, client
from tests.goal_private_fixture import install_synthetic_program_observer

SID = '11111111-2222-3333-4444-555555555555'
SERVER = 'a' * 64
LAPTOP = 'b' * 64


class GoalBootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='goal-bootstrap-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.private = self.root / 'private'; self.private.mkdir(mode=0o700)
        self.public = self.root / 'public'; self.public.mkdir()
        self.runtime = self.root / 'workers' / SID
        self.runtime.mkdir(mode=0o700, parents=True)
        self.runtime.parent.chmod(0o700)
        (self.runtime / 'home').mkdir(mode=0o700)
        self.company = self.private / 'company.json'
        self.employee = dict(id='worker:1', owner='owner-A', sessionId=SID, sessionGeneration=7, desiredRunning=True)
        self.write(self.company, {'employees': [self.employee]})
        self.key = self.private / 'key'; self.key.write_bytes(b'S' * 32); self.key.chmod(0o600)
        self.assertEqual(len(self.key.read_bytes()), 32)
        self.authority = self.private / 'authority'; self.authority.mkdir(mode=0o700)
        nonce_root = self.private / 'nonces'; nonce_root.mkdir(mode=0o700)
        self.nonce = nonce_root / 'nonces.json'
        self.write(self.nonce, dict(version=1, storeId=SID, capacity=32, revision=0, clockFloor=0, entries=[]))
        self.write(Path(str(self.nonce) + '.lock'), {})
        self.goal_config = self.private / 'goals.json'
        self.config = dict(version=1, mode='owner-and-employee', issuer='synthetic-broker', epoch='epoch-1', serverContainerId=SERVER,
            paths={name: dict(host=str(value), server=str(value)) for name, value in dict(
                config=self.goal_config, key=self.key, canonical=self.company, nonce=self.nonce, authority=self.authority).items()},
            nonce=dict(storeId=SID, capacity=32, flockExecutable='/nix/store/synthetic/flock'),
            server=dict(brokerSocket=str(self.root / 'broker.sock'), custodyClient='/nix/store/synthetic/client'))
        self.write(self.goal_config, self.config)
        self.worker_config = self.root / 'worker.json'
        control = self.root / 'control'; control.mkdir(mode=0o700)
        self.config['server']['brokerSocket'] = str(control / 'broker.sock'); self.write(self.goal_config, self.config)
        self.worker = dict(goalPrivateConfig=str(self.goal_config), companyFile=str(self.company), stateRoot=str(self.runtime.parent), socket=str(control / 'broker.sock'),
            mounts=[dict(source=str(self.public), destination='/workspace', readOnly=False)], uid=os.getuid() or 1000,
            gid=os.getgid() or 1000, maxWorkers=4, deployment='synthetic', serverContainer='synthetic-console',
            apiSocketRoot=str(self.root / 'office'), companyRoot=str(self.private))
        self.write(self.worker_config, self.worker)
        self.broker = Broker(self.worker, config_file=str(self.worker_config))
        self.items = [dict(Id=SERVER, Name='/synthetic-console', State=dict(Running=True, Pid=os.getpid()),
            Config=dict(User=f"{self.worker['uid']}:{self.worker['gid']}"),
            HostConfig=dict(Runtime='runc', Privileged=False),
            Mounts=[dict(Type='bind', Source=str(self.root), Destination=str(self.root), RW=True)]),
            dict(Id=LAPTOP, Name='/synthetic-agent-' + SID, State=dict(Running=True, Pid=99999),
            Config=dict(Labels={'reverie.worker': 'synthetic', 'reverie.session': SID}),
            HostConfig=dict(Runtime='runc', Privileged=False),
            Mounts=[dict(Type='bind', Source=str(self.public), Destination='/workspace', RW=True)])]
        self.engine_calls = []
        def engine(arguments):
            self.engine_calls.append(arguments)
            if arguments == ['ps', '--all', '--no-trunc', '--quiet']:
                return '\n'.join(item['Id'] for item in self.items)
            if arguments == ['inspect', *[item['Id'] for item in self.items]]:
                return json.dumps(self.items)
            raise AssertionError('No arbitrary engine command is authorized')
        self.engine = patch.object(self.broker.goals, '_engine', side_effect=engine)
        self.engine.start(); self.addCleanup(self.engine.stop)
        self.pin = dict(version=1, containerId=LAPTOP, employeeId='worker:1', owner='owner-A', sessionId=SID, sessionGeneration=7)
        self.write(self.runtime / 'runtime.json', dict(exit='synthetic.exit', goalBinding=self.pin))
        self.program = install_synthetic_program_observer(self.broker, SID)
        self.peer = (os.getpid(), self.worker['uid'], self.worker['gid'])

    def write(self, file, value):
        file.write_text(json.dumps(value)); file.chmod(0o600)

    def test_projection_uses_actual_pinned_server_and_complete_inventory_without_credentials(self):
        result = self.broker.goals.project({'action': 'goal-custody'}, self.peer)
        self.assertEqual(set(result), {'version', 'configDigest', 'identities'})
        self.assertEqual(len(result['identities']), 14)
        self.assertNotIn(self.key.read_text(), json.dumps(result))
        self.assertEqual(self.engine_calls[0], ['ps', '--all', '--no-trunc', '--quiet'])

    def test_owner_only_retains_complete_custody_but_permanently_refuses_signing_before_key_content(self):
        from reverie.goal_bootstrap import private_entry
        self.config['mode'] = 'owner-only'
        self.write(self.goal_config, self.config)
        with patch('reverie.goal_bootstrap.private_entry', wraps=private_entry) as checked:
            self.assertEqual(len(self.broker.goals.project({'action': 'goal-custody'}, self.peer)['identities']), 14)
            with self.assertRaises(ValueError): self.broker.goals.signer(SID)
            with patch('reverie.worker.OfficeAPI') as office:
                self.broker.office(SID)
                self.assertNotIn('goal_assertions', office.call_args.kwargs)
            self.assertFalse(any(call.kwargs.get('limit') == 32 for call in checked.call_args_list))
        self.items[1]['Mounts'][0] = dict(Type='bind', Source=str(self.private), Destination='/exposed', RW=False)
        with self.assertRaises(ValueError): self.broker.goals.project({'action': 'goal-custody'}, self.peer)

    def test_mode_is_explicit_closed_trust_configuration_not_an_inferred_signing_fallback(self):
        for mode in [None, '', 'owner', 'OWNER-ONLY', True, ['owner-only']]:
            config = {**self.config, 'mode': mode}
            if mode is None: del config['mode']
            self.write(self.goal_config, config)
            broker = Broker(self.worker, config_file=str(self.worker_config))
            with self.subTest(mode=mode), self.assertRaises(ValueError): broker.goals.config()

    def test_projection_rejects_caller_identity_and_arbitrary_request_inputs(self):
        for request in [{'action': 'goal-custody', 'path': str(self.company)}, {'action': 'status'}, {'action': 'goal-custody', 'caller': SID}]:
            with self.subTest(request=request), self.assertRaises(ValueError):
                self.broker.goals.project(request, self.peer)
        self.assertEqual(self.engine_calls, [])
        with self.assertRaises(ValueError):
            self.broker.goals.project({'action': 'goal-custody'}, (os.getpid(), self.worker['uid'] + 1, self.worker['gid']))
        with self.assertRaises((ValueError, OSError)):
            self.broker.goals.project({'action': 'goal-custody'}, (99999999, self.worker['uid'], self.worker['gid']))

    def test_configured_actual_readonly_and_alias_exposures_refuse(self):
        for source in [self.private, self.company]:
            with self.subTest(source=source):
                self.items[1]['Mounts'][0] = dict(Type='bind', Source=str(source), Destination='/exposed', RW=False)
                with self.assertRaises(ValueError):
                    self.broker.goals.project({'action': 'goal-custody'}, self.peer)
        alias = self.public / 'alias'; alias.symlink_to(self.private, target_is_directory=True)
        self.items[1]['Mounts'][0]['Source'] = str(alias)
        with self.assertRaises(ValueError):
            self.broker.goals.project({'action': 'goal-custody'}, self.peer)

    def test_engine_missing_server_ambiguous_mount_and_mapping_drift_refuse(self):
        original = deepcopy(self.items)
        for mutation in [lambda: self.items.pop(0), lambda: self.items[0]['State'].update(Running=False),
                         lambda: self.items[0]['Mounts'][0].update(Source=str(self.public)),
                         lambda: self.items[0]['Mounts'].append(deepcopy(self.items[0]['Mounts'][0])),
                         lambda: self.items[0]['Config'].update(User='999:999')]:
            self.items = deepcopy(original); mutation()
            with self.assertRaises(ValueError):
                self.broker.goals.project({'action': 'goal-custody'}, self.peer)
        with patch.object(self.broker.goals, '_engine', side_effect=subprocess.TimeoutExpired('synthetic', 0.5)):
            with self.assertRaises(subprocess.TimeoutExpired):
                self.broker.goals.project({'action': 'goal-custody'}, self.peer)

    def test_exact_launch_binding_signer_and_current_revocation(self):
        signer = self.broker.goals.signer(SID).bind(SID)
        proof = signer.sign(SID, 'GET', '/api/goals', b'')
        self.assertEqual(len(proof.split('.')), 2)
        for key, value in [('owner', 'owner-B'), ('sessionGeneration', 8), ('desiredRunning', False),
                           ('onVacation', True), ('bindingMigration', {'id': 'migration', 'from': SID, 'to': 'other'})]:
            changed = {**self.employee, key: value}
            self.write(self.company, {'employees': [changed]})
            with self.subTest(key=key), self.assertRaises(ValueError):
                signer.sign(SID, 'GET', '/api/goals', b'')
        self.write(self.company, {'employees': [self.employee]})
        self.assertTrue(signer.sign(SID, 'GET', '/api/goals', b''))
        self.write(self.runtime / 'runtime.json', dict(exit='synthetic.exit', goalBinding={**self.pin, 'sessionGeneration': 8}))
        with self.assertRaises(ValueError):
            signer.sign(SID, 'GET', '/api/goals', b'')

    def test_normal_broker_office_never_installs_component_signer_or_adopts_legacy_recovery(self):
        # The standalone bootstrap component can sign with a synthetic observer;
        # the reviewed restricted Broker never connects it to OfficeAPI.
        self.assertTrue(self.broker.goals.signer(SID).bind(SID).sign(SID, 'GET', '/api/goals', b''))
        with patch('reverie.worker.OfficeAPI') as office, \
             patch.object(self.broker.goals, 'signer', side_effect=AssertionError('SIGNER_MUST_NOT_BE_REQUESTED')):
            self.broker.office(SID)
            self.assertNotIn('goal_assertions', office.call_args.kwargs)
            self.broker.offices.clear()
            self.write(self.runtime / 'runtime.json', {'exit': 'synthetic.exit'})
            self.broker.office(SID)
            self.assertNotIn('goal_assertions', office.call_args.kwargs)

    def test_config_key_inode_and_scope_mode_drift_refuse(self):
        signer = self.broker.goals.signer(SID).bind(SID)
        replacement = self.private / 'replacement'
        replacement.write_bytes(self.key.read_bytes()); replacement.chmod(0o600)
        replacement.replace(self.key)
        with self.assertRaises(ValueError):
            signer.sign(SID, 'GET', '/api/goals', b'')
        self.company.chmod(0o644)
        with self.assertRaises(ValueError):
            self.broker.goals.project({'action': 'goal-custody'}, self.peer)
        self.company.chmod(0o600)
        self.write(self.goal_config, {**self.config, 'epoch': 'revoked'})
        with self.assertRaises(ValueError):
            self.broker.goals.project({'action': 'goal-custody'}, self.peer)

    def test_new_launch_pin_uses_existing_canonical_record_not_maintenance_or_supplied_generation(self):
        self.broker.generation = 999
        self.items[1]['State']['Running'] = False
        self.assertEqual(self.broker.goals.launch_binding(SID, LAPTOP), self.pin)
        with self.assertRaises(ValueError):
            self.broker.goals.launch_binding(SID, SERVER)
        self.broker.goals.persist_launch(self.runtime / 'runtime.json', dict(exit='new.exit', goalBinding=self.pin))
        self.assertEqual(json.loads((self.runtime / 'runtime.json').read_text())['goalBinding'], self.pin)
        self.write(self.company, {'employees': [{**self.employee, 'sessionGeneration': 8}]})
        with self.assertRaises(ValueError):
            self.broker.goals.persist_launch(self.runtime / 'runtime.json', dict(exit='newer.exit', goalBinding=self.pin))
        self.assertEqual(json.loads((self.runtime / 'runtime.json').read_text())['goalBinding'], self.pin)

    def test_generation_revoked_after_temp_sync_preserves_existing_runtime_receipt(self):
        before = (self.runtime / 'runtime.json').read_bytes()
        fsync = os.fsync
        changed = False
        def revoke(fd):
            nonlocal changed
            fsync(fd)
            if not changed:
                changed = True
                self.write(self.company, {'employees': [{**self.employee, 'sessionGeneration': 8}]})
        with patch('reverie.goal_bootstrap.os.fsync', side_effect=revoke):
            with self.assertRaises(ValueError):
                self.broker.goals.persist_launch(self.runtime / 'runtime.json', dict(exit='new.exit', goalBinding=self.pin))
        self.assertEqual((self.runtime / 'runtime.json').read_bytes(), before)
        self.assertEqual(list(self.runtime.glob('.goal-launch-*.tmp')), [])

    def test_same_uid_sibling_namespace_and_finished_or_malformed_program_are_refused(self):
        stat_call = os.stat
        def different_namespace(path, *args, **kwargs):
            if path == '/proc/99999/ns/mnt':
                return SimpleNamespace(st_ino=stat_call(f'/proc/{os.getpid()}/ns/mnt').st_ino + 1)
            return stat_call(path, *args, **kwargs)
        with patch('reverie.goal_bootstrap.os.stat', side_effect=different_namespace):
            with self.assertRaises(ValueError):
                self.broker.goals.project({'action': 'goal-custody'}, (99999, self.worker['uid'], self.worker['gid']))
        for exit_name in ['', '.', '..', '../other.exit', 'ok.exit']:
            self.write(self.runtime / 'runtime.json', dict(exit=exit_name, goalBinding=self.pin))
            if exit_name == 'ok.exit':
                launch = self.runtime / 'home/.reverie-launch'; launch.mkdir(mode=0o700)
                (launch / exit_name).write_text('0')
            with self.subTest(exit_name=exit_name), self.assertRaises(ValueError):
                self.broker.goals.signer(SID)

    def test_closed_helper_client_checks_peer_protocol_bounds_and_accepts_no_identity_inputs(self):
        result = self.broker.goals.project({'action': 'goal-custody'}, self.peer)
        endpoint = str(self.root / 'synthetic.sock')
        info = SimpleNamespace(st_mode=0o140600, st_dev=1, st_ino=2)
        original_lstat = Path.lstat
        def lstat(path, *args, **kwargs):
            return info if str(path) == endpoint else original_lstat(path, *args, **kwargs)
        args = SimpleNamespace(goal_custody=True)
        connection = MagicMock()
        connection.__enter__.return_value = connection
        connection.getsockopt.return_value = struct.pack('3i', os.getpid(), os.getuid(), os.getgid())
        def respond(value, kind=b'J'):
            payload = json.dumps(value).encode()
            incoming = io.BytesIO(kind + struct.pack('!I', len(payload)) + payload)
            connection.recv.side_effect = incoming.read
        with patch.dict(os.environ, {'REVERIE_WORKER_SOCKET': endpoint}), patch.object(Path, 'lstat', lstat), \
             patch('reverie.worker.socket.socket', return_value=connection):
            respond(result)
            with contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(client(args), 0)
            self.assertEqual(json.loads(output.getvalue()), result)
            sent = connection.sendall.call_args.args[0]
            self.assertEqual(sent[0:1], b'G')
            self.assertEqual(json.loads(sent[5:]), {'action': 'goal-custody'})
            for value in [{**result, 'key': 'NEVER_RETURN'}, {**result, 'identities': {}}, {'error': 'x' * 33000}]:
                respond(value)
                with self.assertRaises(ValueError): client(args)
            connection.getsockopt.return_value = struct.pack('3i', os.getpid(), os.getuid() + 1, os.getgid())
            with self.assertRaises(ValueError): client(args)
            for key in ['control', 'caller_session', 'session_id', 'cwd', 'command', 'attach_only']:
                with self.subTest(key=key), self.assertRaises(ValueError):
                    client(SimpleNamespace(goal_custody=True, **{key: 'forbidden'}))

    def test_inspection_subprocess_has_retained_output_and_whole_call_bounds(self):
        # Local Python is the engine-edge fixture only; no actual engine process.
        self.engine.stop()
        self.broker.engine = sys.executable
        self.assertEqual(self.broker.goals._engine(['-c', 'print("closed fixture")']), 'closed fixture\n')
        with self.assertRaises(ValueError):
            self.broker.goals._engine(['-c', 'import sys; sys.stdout.write("x" * (1024 * 1024 + 1))'])
        with self.assertRaises(ValueError):
            self.broker.goals._engine(['-c', 'import time; time.sleep(2)'])

    def test_unsupported_configured_and_actual_injection_refuses_before_key_content(self):
        from reverie.goal_bootstrap import private_entry
        original = deepcopy(self.items)
        hazards = [dict(Runtime='nvidia'), dict(Privileged=True),
                   dict(DeviceRequests=[{'Driver': 'nvidia', 'Capabilities': [['gpu']]}]),
                   dict(Devices=[{'PathOnHost': '/dev/synthetic'}]), dict(DeviceCgroupRules=['c 1:1 rwm']),
                   dict(CDIDevices=['nvidia.com/gpu=all']), dict(Annotations={'cdi.k8s.io/gpu': 'synthetic'}),
                   dict(CapAdd=['SYS_ADMIN']), dict(VolumesFrom=['other']), dict(PidMode='host'),
                   dict(IpcMode='host'), dict(UsernsMode='host'), dict(SecurityOpt=['seccomp=unconfined'])]
        for running in (True, False):
            for hazard in hazards:
                self.items = deepcopy(original)
                self.items[1]['State']['Running'] = running
                self.items[1]['HostConfig'].update(hazard)
                with self.subTest(running=running, hazard=hazard), \
                     patch('reverie.goal_bootstrap.private_entry', wraps=private_entry) as checked:
                    with self.assertRaises(ValueError): self.broker.goals.signer(SID)
                    self.assertFalse(any(call.kwargs.get('limit') == 32 for call in checked.call_args_list))
        self.items = deepcopy(original)
        for running in (True, False):
            self.items[1]['State']['Running'] = running
            self.worker['gpuGrants'] = {SID: 'nvidia.com/gpu=GPU-11111111-2222-3333-4444-555555555555'}
            self.write(self.worker_config, self.worker)
            with self.subTest(configured=True, running=running), \
                 patch('reverie.goal_bootstrap.private_entry', wraps=private_entry) as checked:
                with self.assertRaises(ValueError): self.broker.goals.signer(SID)
                self.assertFalse(any(call.kwargs.get('limit') == 32 for call in checked.call_args_list))

    def test_real_legacy_program_never_gets_signer_before_after_exit_removal_or_broker_restart(self):
        from reverie.goal_bootstrap import private_entry
        self.broker.goals._program_observer = None  # the actual normal Broker default
        receipt = self.runtime / 'home/.reverie-launch/synthetic.exit'
        receipt.parent.mkdir(mode=0o700)
        with patch('reverie.goal_bootstrap.private_entry', wraps=private_entry) as checked:
            with self.assertRaises(ValueError): self.broker.goals.signer(SID)
            receipt.write_text('0')
            with self.assertRaises(ValueError): self.broker.goals.signer(SID)
            self.assertIs(json.loads((self.runtime / 'runtime.json').read_text())['goalProgramClosed'], True)
            receipt.unlink()
            with self.assertRaises(ValueError): self.broker.goals.signer(SID)
            receipt.write_text('replacement')
            with self.assertRaises(ValueError): self.broker.goals.signer(SID)
            receipt.unlink()
            self.assertFalse(any(call.kwargs.get('limit') == 32 for call in checked.call_args_list))
        restarted = Broker(self.worker, config_file=str(self.worker_config))
        self.assertIsNone(restarted.goals._program_observer)
        with patch.object(restarted.goals, '_engine', side_effect=self.broker.goals._engine):
            with self.assertRaises(ValueError): restarted.goals.signer(SID)
        self.assertIs(json.loads((self.runtime / 'runtime.json').read_text())['goalProgramClosed'], True)
        self.broker.offices.clear()
        with patch('reverie.worker.OfficeAPI') as office:
            self.broker.office(SID)
            self.assertNotIn('goal_assertions', office.call_args.kwargs)

    def test_synthetic_program_observer_cannot_ignore_after_blocking_binding_or_record_revocation(self):
        observer = self.program.assert_current
        def revoked(*args):
            observer(*args)
            self.write(self.company, {'employees': [{**self.employee, 'sessionGeneration': 8}]})
        with patch.object(self.program, 'assert_current', side_effect=revoked):
            with self.assertRaises(ValueError): self.broker.goals.signer(SID)

    def test_completion_observed_after_program_probe_is_durably_closed_not_resurrected(self):
        receipt = self.runtime / 'home/.reverie-launch/synthetic.exit'
        receipt.parent.mkdir(mode=0o700)
        original = self.program.assert_current
        def finish(*args):
            original(*args)
            receipt.write_text('0')
        with patch.object(self.program, 'assert_current', side_effect=finish):
            with self.assertRaises(ValueError): self.broker.goals.signer(SID)
        receipt.unlink()
        self.assertIs(json.loads((self.runtime / 'runtime.json').read_text())['goalProgramClosed'], True)
        with self.assertRaises(ValueError): self.broker.goals.signer(SID)

    def test_normal_packaged_client_fast_entry_is_default_unavailable_and_never_adopts_arguments(self):
        env = {'PATH': os.environ['PATH'], 'PYTHONPATH': str(Path(__file__).resolve().parents[1] / 'python'),
               'PYTHONDONTWRITEBYTECODE': '1'}
        result = subprocess.run([sys.executable, '-m', 'reverie.worker', 'client', '--goal-custody-stream'],
                                input=b'G', capture_output=True, env=env, timeout=3)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, b'')
        self.assertNotIn(b'key', result.stderr)
        mixed = subprocess.run([sys.executable, '-m', 'reverie.worker', 'client', '--goal-custody-stream', '--caller-session', SID],
                               input=b'G', capture_output=True, env=env, timeout=3)
        self.assertNotEqual(mixed.returncode, 0)


if __name__ == '__main__':
    unittest.main()
