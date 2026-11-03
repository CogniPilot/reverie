"""Synthetic storage/container observations only; no engine, laptop or host operation."""
import copy
import json
import os
from pathlib import Path
import socket
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from reverie.chat_image_paths import ImagePathRefused
from reverie.worker_chat_images import WorkerChatImages, attachment_masks, decode, namespace_temporary, PURPOSE, CACHE_NAME

SID = '11111111-1111-4111-8111-111111111111'
EID = '22222222-2222-4222-8222-222222222222'
RID = '33333333-3333-4333-8333-333333333333'
MID = '44444444-4444-4444-8444-444444444444'
FID = '55555555-5555-4555-8555-555555555555'


class WorkerChatImageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='worker-chat-images-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        workspace = self.root / 'workspace'
        (workspace / 'attachments').mkdir(parents=True)
        self.config = {'mounts': [{'source': str(workspace), 'destination': '/reverie_workspace'}],
                       'deployment': 'fixture', 'uid': os.getuid(), 'gid': os.getgid(), 'apiSocketRoot': str(self.root / 'offices')}
        self.scratch = self.root / 'scratch'
        (self.scratch / 'tmp').mkdir(parents=True, mode=0o700)
        office = self.root / 'offices' / SID
        office.mkdir(parents=True)
        self.sock = socket.socket(socket.AF_UNIX)
        self.addCleanup(self.sock.close)
        self.sock.bind(str(office / 'office.sock'))
        (office / 'office.sock').chmod(0o600)
        (self.root / 'employee').mkdir(mode=0o700)
        self.paths = SimpleNamespace(root=self.root / 'employee', kind='employee', identity=EID, scratch=self.scratch, owner='fixture-owner')
        self.mounts = [{'Type': 'bind', 'Source': str(workspace), 'Destination': '/reverie_workspace', 'RW': True},
                       {'Type': 'tmpfs', 'Source': '', 'Destination': '/reverie_workspace/attachments', 'RW': False},
                       {'Type': 'bind', 'Source': str(self.scratch / 'tmp'), 'Destination': '/tmp', 'RW': True}]
        self.item = {'Id': 'a' * 64, 'Name': '/fixture-agent-' + SID, 'Image': 'sha256:' + 'b' * 64,
                     'State': {'Running': True, 'Paused': False, 'Restarting': False, 'Dead': False, 'Pid': 123, 'StartedAt': 'fixture-start'},
                     'Config': {'User': f'{os.getuid()}:{os.getgid()}', 'Labels': {
                         'reverie.worker': 'fixture', 'reverie.session': SID, 'reverie.employee': EID}}, 'Mounts': self.mounts}
        self.broker = SimpleNamespace(stopping=threading.Event(), draining=threading.Event(), generation=1,
            allowed=lambda sid: sid == SID, config=self.config,
            inspect_container=lambda name: copy.deepcopy(self.item),
            offices={SID: SimpleNamespace(closing=threading.Event())})
        self.controller = WorkerChatImages(self.broker)
        self.addCleanup(self.controller.close)
        self.patches = [patch('reverie.worker_chat_images.storage_paths', return_value=self.paths),
                        patch('reverie.worker_chat_images.storage_start_allowed', return_value=True),
                        patch('reverie.worker_chat_images.namespace_temporary', side_effect=lambda pid, tmp, cache: ('12345', tmp.stat()))]
        for patcher in self.patches:
            patcher.start()
            self.addCleanup(patcher.stop)

    def binding(self):
        return self.controller.dispatch(json.dumps({'purpose': PURPOSE, 'action': 'binding', 'sessionId': SID}).encode())

    def test_closed_wire_purpose_rejects_arbitrary_paths_commands_and_duplicate_keys(self):
        good = {'purpose': PURPOSE, 'action': 'binding', 'sessionId': SID}
        self.assertEqual(decode(json.dumps(good).encode()), good)
        for extra in ({'command': 'anything'}, {'path': '/tmp/file'}, {'url': 'https://example.invalid'}):
            with self.assertRaises(ImagePathRefused):
                decode(json.dumps({**good, **extra}).encode())
        with self.assertRaises(ImagePathRefused):
            decode(b'{"purpose":"chat-image-paths-v1","action":"binding","sessionId":"x","sessionId":"y"}')

    def test_actual_mask_sources_and_nonstandard_aliases_are_required(self):
        attachment_masks(self.config, self.mounts)
        source = self.config['mounts'][0]['source']
        alias = self.mounts + [{'Type': 'bind', 'Source': source, 'Destination': '/workspace', 'RW': True}]
        with self.assertRaises(ImagePathRefused):
            attachment_masks(self.config, alias)
        attachment_masks(self.config, alias + [{'Type': 'tmpfs', 'Destination': '/workspace/attachments', 'RW': False}])
        for changed in ([*self.mounts, {'Type': 'bind', 'Source': source, 'Destination': '/drive', 'RW': False}],
                        [*self.mounts, {'Type': 'bind', 'Source': source + '/attachments', 'Destination': '/leak', 'RW': False}],
                        [*self.mounts, {'Type': 'tmpfs', 'Destination': '/reverie_workspace/attachments/child', 'RW': False}],
                        [item for item in self.mounts if item['Type'] != 'tmpfs']):
            with self.subTest(changed=changed), self.assertRaises(ImagePathRefused):
                attachment_masks(self.config, changed)

    def test_custody_root_or_ledger_bind_is_refused_before_materialization(self):
        ledger = self.paths.root / '.chat-image-custody.json'
        ledger.write_text('{}')
        ledger.chmod(0o600)
        for source in (self.paths.root, ledger):
            self.mounts.append({'Type': 'bind', 'Source': str(source), 'Destination': '/exposed', 'RW': True})
            try:
                with self.assertRaisesRegex(ImagePathRefused, 'custody_exposed'):
                    self.binding()
            finally:
                self.mounts.pop()

    def test_binding_changes_with_container_image_init_and_mounts(self):
        first = self.binding()['generation']
        for key, value in [('Id', 'c' * 64), ('Image', 'sha256:' + 'd' * 64)]:
            before = self.item[key]
            self.item[key] = value
            self.assertNotEqual(self.binding()['generation'], first)
            self.item[key] = before
        self.item['State']['StartedAt'] = 'different'
        self.assertNotEqual(self.binding()['generation'], first)

    def test_stopped_fenced_wrong_employee_or_socket_cannot_bind(self):
        for section, field, value in [('State', 'Running', False), ('State', 'Paused', True), ('Config', 'User', 'another')]:
            before = self.item[section][field]
            self.item[section][field] = value
            with self.assertRaises(ImagePathRefused): self.binding()
            self.item[section][field] = before
        self.broker.draining.set()
        with self.assertRaises(ImagePathRefused): self.binding()
        self.broker.draining.clear()
        self.item['Config']['Labels']['reverie.employee'] = SID
        with self.assertRaises(ImagePathRefused): self.binding()

    def test_materialization_writes_only_owned_scratch_and_refuses_a_replaced_generation(self):
        generation = self.binding()['generation']
        scope = {'version': 1, 'sessionId': SID, 'roomId': RID, 'messageId': MID, 'generation': generation, 'fileIds': [FID]}
        request = {'purpose': PURPOSE, 'action': 'materialize', 'sessionId': SID, 'request': scope}
        payload = b'\x89PNG\r\n\x1a\nfixture'
        with patch('reverie.worker_chat_images.OfficeImageReader') as reader:
            reader.return_value.fetch.return_value = payload
            result = self.controller.dispatch(json.dumps(request).encode())
            reader.return_value.fetch.assert_called_once()
        local = self.scratch / 'tmp' / CACHE_NAME / Path(result['files'][0]['path']).name
        self.assertEqual(local.read_bytes(), payload)
        self.assertTrue(result['files'][0]['path'].startswith('/tmp/' + CACHE_NAME + '/'))
        self.item['Id'] = 'c' * 64
        with self.assertRaises(ImagePathRefused):
            self.controller.dispatch(json.dumps(request).encode())
        self.assertTrue(self.controller.close())
        self.assertFalse(local.exists())

    def test_replacement_generation_reauthorizes_and_reconciles_same_cache(self):
        scope = {'version': 1, 'sessionId': SID, 'roomId': RID, 'messageId': MID,
                 'generation': self.binding()['generation'], 'fileIds': [FID]}
        value = {'purpose': PURPOSE, 'action': 'materialize', 'sessionId': SID, 'request': scope}
        with patch('reverie.worker_chat_images.OfficeImageReader') as reader:
            reader.return_value.fetch.return_value = bytes.fromhex('89504e470d0a1a0a') + b'fixture'
            first = self.controller.dispatch(json.dumps(value).encode())
            old = self.scratch / 'tmp' / CACHE_NAME / Path(first['files'][0]['path']).name
            self.item['Id'] = 'c' * 64
            scope['generation'] = self.binding()['generation']
            second = self.controller.dispatch(json.dumps(value).encode())
        self.assertFalse(old.exists())
        self.assertNotEqual(first['files'][0]['path'], second['files'][0]['path'])
        self.assertEqual(reader.return_value.fetch.call_count, 2)

    def test_recreated_scratch_retires_old_owner_without_deleting_retained_files(self):
        scope = {'version': 1, 'sessionId': SID, 'roomId': RID, 'messageId': MID,
                 'generation': self.binding()['generation'], 'fileIds': [FID]}
        value = {'purpose': PURPOSE, 'action': 'materialize', 'sessionId': SID, 'request': scope}
        payload = bytes.fromhex('89504e470d0a1a0a') + b'fixture'
        with patch('reverie.worker_chat_images.OfficeImageReader') as reader:
            reader.return_value.fetch.return_value = payload
            first = self.controller.dispatch(json.dumps(value).encode())
            retained = self.scratch / 'retained-tmp'
            (self.scratch / 'tmp').rename(retained)
            (self.scratch / 'tmp').mkdir(mode=0o700)
            self.item['Id'] = 'c' * 64
            scope['generation'] = self.binding()['generation']
            second = self.controller.dispatch(json.dumps(value).encode())
        self.assertEqual((retained / CACHE_NAME / Path(first['files'][0]['path']).name).read_bytes(), payload)
        self.assertEqual((self.scratch / 'tmp' / CACHE_NAME / Path(second['files'][0]['path']).name).read_bytes(), payload)
        self.assertEqual(len(list(self.paths.root.glob('.chat-image-custody-retained-*.json'))), 1)

    def test_fixed_wire_purpose_uses_peer_authenticated_broker_handler_without_lifecycle_action(self):
        from reverie.worker import Broker, receive_frame, send_frame
        broker = Broker.__new__(Broker)
        broker.stopping = threading.Event()
        broker.handlers = {}
        broker.config = {'uid': os.getuid()}
        broker.connections = threading.BoundedSemaphore(1)
        broker.chat_images = self.controller
        broker.run_engine = lambda *args, **kwargs: self.fail('Unexpected engine action')
        client, server = socket.socketpair()
        client.settimeout(2)
        try:
            broker.connections.acquire()
            send_frame(client, b'M', json.dumps({'purpose': PURPOSE, 'action': 'binding', 'sessionId': SID}).encode())
            broker.handle(server)
            kind, payload = receive_frame(client)
            self.assertEqual(kind, b'J')
            self.assertEqual(json.loads(payload)['status'], 'bound')
            self.assertEqual(broker.handlers, {})
        finally:
            client.close()
            server.close()

    def test_controller_admission_refuses_excess_concurrent_observations(self):
        self.controller.admission.acquire()
        self.controller.admission.acquire()
        try:
            with self.assertRaisesRegex(ImagePathRefused, 'busy'):
                self.binding()
        finally:
            self.controller.admission.release()
            self.controller.admission.release()
        self.assertEqual(self.binding()['status'], 'bound')

    def test_namespace_observer_refuses_a_declared_tmp_that_is_not_the_process_tmp(self):
        # This independent helper sees only the test's own /proc identity.
        with self.assertRaises(ImagePathRefused):
            namespace_temporary(os.getpid(), self.scratch / 'tmp', False)


if __name__ == '__main__':
    unittest.main()
