"""Canonical broker pipeline, real stores/leases/files, controlled native ports.

No engine, provider, server or native process is created by this fixture.
"""
from contextlib import nullcontext
import copy
import json
from pathlib import Path
import socket
import subprocess
import unittest
from unittest.mock import patch

from reverie.worker import Broker, send_frame, receive_frame
from reverie import worker_resource_native as N
from reverie import worker_resource_reservations as R
from tests import test_worker_resource_native as T
from tests import test_worker_resource_reservations as F


class CanonicalResourceLaunch(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.object(Broker, 'run_engine', side_effect=AssertionError('REAL_ENGINE_FORBIDDEN')))
        self.native = T.NativeStart(); self.native.setUp(); self.addCleanup(self.native.doCleanups)
        self.f = self.native.f; self.owner = self.native.owner
        # Earlier observer-only fixtures create these synthetic ancestors with
        # mkdir(parents=True). The canonical producer requires the real private
        # storage layout, including every selected root's parent.
        for root in [Path(self.f.config['stateRoot'])/'employees',
                     Path(self.f.config['stateRoot'])/'employees'/F.EID,
                     Path(self.f.config['scratchRoot']), Path(self.f.config['scratchRoot'])/'employees']:
            root.chmod(0o700)
        self.permit = self.native.stopped()
        f = self.f
        self.broker = Broker(f.native.config, config_file=f.native.config_file)
        self.broker.resource_reservations = f.gate
        f.gate.broker = self.broker; f.gate.native.broker = self.broker
        self.owner.broker = self.broker
        self.broker.rows = f.native.rows
        self.events = []; original_engine = f.native.run_engine
        name = self.broker.config['deployment'] + '-agent-' + F.APPROVED_TARGET
        self.request = {'sessionId': F.APPROVED_TARGET, 'cwd': '/workspace',
                        'command': 'printf controlled-command', 'env': {}, 'cols': 80, 'rows': 24}
        def engine(args, optional=False, *, deadline=None):
            if args[:2] == ['inspect', name]:
                selected = [r for r in self.broker.rows if r['Name'] == '/' + name]
                return subprocess.CompletedProcess(args, 0 if selected else 1, json.dumps(selected), '')
            if args[0] == 'create':
                self.events.append('create')
                self.assertEqual(self.native.case.raw()['operations'][self.permit.operation_id]['state'], 'STARTING')
                self.assertTrue((f.control/'operations'/('launch-attempt-'+self.permit.operation_id+'.json')).exists())
                row = self.native.model_created(self.permit)
                self.owner._current(self.native.key).pop('created_id')
                row['State'] = {'Running': False, 'Pid': 0}
                return subprocess.CompletedProcess(args, 0, row['Id'] + '\n', '')
            if args[0] == 'start':
                self.events.append('start-sleeping-container')
                self.broker.rows[-1]['State'] = {'Running': True, 'Pid': 125}
                return subprocess.CompletedProcess(args, 0, '', '')
            if args[:2] == ['network', 'inspect']:
                return subprocess.CompletedProcess(args, 1, '', '')
            if args[:2] == ['network', 'create']:
                self.events.append('network-create'); return subprocess.CompletedProcess(args, 0, '', '')
            if args[0] == 'exec':
                self.events.append('cli-start' if 'new-session' in args else 'cli-options')
                self.assertIn('created_id', self.owner._current(self.native.key))
                return subprocess.CompletedProcess(args, 0, '', '')
            return original_engine(args, optional)
        self.broker.run_engine = engine
        self.broker.office = lambda _sid: None  # No HTTP listener in this source fixture.
        self.broker.check_storage_writers = lambda *_args: None
        self.enterContext(patch('reverie.worker.store_guard', return_value=nullcontext()))
        self.enterContext(patch('reverie.worker.prepare_store', side_effect=lambda *_: self.events.append('prepare-store')))
        self.enterContext(patch('reverie.worker.pty.openpty', side_effect=RuntimeError('controlled terminal viewer boundary')))
        self.addCleanup(lambda: [self.broker.release_storage(sid) for sid in list(self.broker.storage_leases)])
        self.launch = N.bind_launch(self.owner, self.native.key, self.request)

    def run_request(self, request=None, launch=None):
        client, server = socket.socketpair(); client.settimeout(2)
        try:
            self.broker.connections.acquire()
            send_frame(client, b'J', json.dumps(request or self.request).encode())
            self.broker.handle(server, _resource_launch=launch or self.launch)
            return receive_frame(client)
        finally: client.close(); server.close()

    def test_same_canonical_pipeline_creates_actual_result_cid_then_starts_cli(self):
        kind, body = self.run_request()
        self.assertEqual(kind, b'E'); self.assertIn(b'controlled terminal viewer boundary', body)
        self.assertEqual(self.events, ['prepare-store', 'network-create', 'create',
                                      'start-sleeping-container', 'cli-start', 'cli-options'])
        claim = self.owner._current(self.native.key)
        self.assertEqual(claim['created_id'], '3' * 64)
        self.assertEqual(claim['canonical_cli_started']['container']['containerId'], '3' * 64)
        receipt = json.loads((self.f.control/'operations'/('cli-started-'+self.permit.operation_id+'.json')).read_text())
        self.assertEqual(receipt['state'], 'CANONICAL_CLI_STARTED_READINESS_NOT_VERIFIED')
        self.assertEqual(self.native.case.raw()['operations'][self.permit.operation_id]['state'], 'STARTING')
        self.assertIn(F.APPROVED_TARGET, self.broker.storage_leases)

    def test_modified_command_refuses_before_storage_preparation_or_native_effect(self):
        kind, body = self.run_request(dict(self.request, command='printf changed'))
        self.assertEqual(kind, b'E'); self.assertIn(b'PRIVATE_REQUEST_CHANGED', body)
        self.assertEqual(self.events, [])

    def test_copied_join_refuses_even_with_identical_metadata(self):
        from dataclasses import replace
        kind, body = self.run_request(launch=replace(self.launch))
        self.assertEqual(kind, b'E'); self.assertIn(b'PRIVATE_REQUEST_CHANGED', body)
        self.assertEqual(self.events, [])
