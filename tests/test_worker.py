import tests  # noqa: F401
from copy import deepcopy
import json
import os
from pathlib import Path
import socket
import http.client
from unittest.mock import patch
import struct
import subprocess
import tempfile
import threading
import unittest

from reverie.worker import OFFLINE_GRACE_SECONDS, Broker, OfficeAPI, MAX_FRAME, create_args, load_config, receive_frame, send_frame, validate_request

SID = '11111111-2222-3333-4444-555555555555'


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        (self.root / 'work').mkdir()
        (self.root / 'company.json').write_text(json.dumps({'employees': []}))
        self.config = dict(version=1, deployment='test', image='sha256:' + 'a'*64, serverContainer='test-console',
            socket=str(self.root / 'control/broker.sock'), stateRoot=str(self.root / 'workers'), companyFile=str(self.root / 'company.json'),
            companyRoot=str(self.root/'company'), scratchRoot=str(self.root/'scratch'), apiSocketRoot=str(self.root/'office'), budgetMode='pool',
            uid=os.getuid() or 1000, gid=os.getgid() or 1000, memoryMiB=0, poolMemoryMiB=4096, poolTasksMax=1024,
            cgroupParent='reverie-workers.slice', pidsLimit=128, cpus=0, maxWorkers=4, maintenanceSessions=[],
            mounts=[dict(source=str(self.root / 'work'), destination='/workspace', readOnly=False)])
        self.request = dict(sessionId=SID, cwd='/workspace/project', command='printf healthy', env={'TERM': 'xterm-256color'}, cols=120, rows=40)

    def load(self, config=None):
        path = self.root / 'config.json'
        path.write_text(json.dumps(self.config if config is None else config))
        path.chmod(0o600)
        return load_config(path)

    def test_owner_config_has_explicit_immutable_image_and_grants(self):
        self.assertEqual(self.load(), self.config)
        for key, value in [('image', 'mutable:latest'), ('pidsLimit', 0), ('cpus', -1), ('maxWorkers', 999), ('cgroupParent', 'system.slice')]:
            changed = {**self.config, key: value}
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.load(changed)
        path = self.root / 'config.json'
        self.load()
        path.chmod(0o644)
        with self.assertRaises(ValueError):
            load_config(path)

    def test_worker_cannot_request_engine_flags_host_mounts_or_server_credentials(self):
        self.assertEqual(validate_request(self.request, self.config), self.request)
        for changed in [dict(self.request, engineArgs=['--privileged']), dict(self.request, cwd='/etc'),
                dict(self.request, cwd='/workspace/../etc'), dict(self.request, sessionId='--privileged'),
                dict(self.request, env={'REVERIE_PASSWORD': 'synthetic-private-value'}),
                dict(self.request, env={'REVERIE_WORKER_SOCKET': '/host.sock'}), dict(self.request, cols=1001)]:
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                validate_request(changed, self.config)

    def test_engine_and_broker_mounts_are_rejected(self):
        for destination in ['/var/run/docker.sock', '/run/reverie-workers', '/', '/proc', '/home/agent']:
            changed = deepcopy(self.config)
            changed['mounts'][0]['destination'] = destination
            with self.subTest(destination=destination), self.assertRaises(ValueError):
                self.load(changed)
        changed = deepcopy(self.config)
        changed['mounts'][0]['source'] = '/'
        with self.assertRaises(ValueError):
            self.load(changed)

    def test_default_workers_borrow_cpu_and_memory_under_enforced_pool(self):
        name, digest, args = create_args(self.config, SID, self.root/'home')
        self.assertEqual(name, 'test-agent-' + SID)
        self.assertEqual(len(digest), 64)
        for flag in ['--init', '--read-only', '--cap-drop', '--security-opt', '--cgroup-parent', '--cpu-shares', '--pids-limit']:
            self.assertIn(flag, args)
        self.assertNotIn('--cpus', args)
        self.assertNotIn('--memory', args)
        self.assertEqual(args[args.index('--restart')+1], 'no')
        self.assertEqual(args[args.index('--cgroup-parent')+1], 'reverie-workers.slice')
        self.assertFalse(any('docker.sock' in value or 'control/broker' in value for value in args))
        limited = {**self.config, 'memoryMiB': 2048, 'cpus': 3}
        _, _, args = create_args(limited, SID, self.root/'home')
        self.assertEqual(args[args.index('--cpus')+1], '3')
        self.assertEqual(args[args.index('--memory')+1], '2048m')

    def test_pool_must_exist_and_have_hard_resource_ceilings(self):
        pool = self.root / 'pool'; pool.mkdir()
        broker = Broker(self.config)
        with self.assertRaises(RuntimeError):
            broker.check_pool(pool)
        for name, value in [('memory.max', str(4096*1024*1024)), ('pids.max', '1024'), ('pids.current', '10')]:
            (pool/name).write_text(value)
        broker.check_pool(pool)
        for name, value in [('memory.max', 'max'), ('pids.max', 'max'), ('pids.current', '1000')]:
            before = (pool/name).read_text(); (pool/name).write_text(value)
            with self.assertRaises(RuntimeError):
                broker.check_pool(pool)
            (pool/name).write_text(before)

    def test_vacations_and_explicit_stops_are_enforced_without_waking_anyone(self):
        broker = Broker(self.config)
        for employee, allowed in [({'sessionId': SID, 'desiredRunning': True}, True),
                ({'sessionId': SID, 'desiredRunning': False}, False),
                ({'sessionId': SID, 'desiredRunning': True, 'onVacation': True}, False)]:
            (self.root/'company.json').write_text(json.dumps({'employees': [employee]}))
            self.assertEqual(broker.allowed(SID), allowed)
        (self.root/'company.json').unlink()
        with self.assertRaises(RuntimeError):
            broker.allowed(SID)

    def test_protocol_preserves_terminal_bytes_and_bounds_allocations(self):
        left, right = socket.socketpair()
        self.addCleanup(left.close); self.addCleanup(right.close)
        send_frame(left, b'O', b'\x00\x1b[2Jterminal\xff')
        self.assertEqual(receive_frame(right), (b'O', b'\x00\x1b[2Jterminal\xff'))
        left.sendall(b'I' + struct.pack('!I', MAX_FRAME + 1))
        with self.assertRaises(ValueError):
            receive_frame(right)

    def test_admission_requires_memory_ceiling_without_cpu_quota(self):
        config = {**self.config, 'budgetMode': 'admission', 'memoryMiB': 2048}
        self.assertEqual(self.load(config), config)
        Broker(config).check_pool(self.root/'missing-slice')
        _, _, args = create_args(config, SID, self.root/'home')
        self.assertNotIn('--cgroup-parent', args)
        self.assertNotIn('--cpus', args)
        self.assertEqual(args[args.index('--memory')+1], '2048m')
        with self.assertRaises(ValueError): self.load({**config, 'memoryMiB': 0})

    def test_office_phone_fixes_identity_and_keeps_owner_credentials_private(self):
        company = self.root/'company'
        (company/'console').mkdir(parents=True)
        (company/'console/.env').write_text('REVERIE_USERNAME=test\nREVERIE_PASSWORD=synthetic\n')
        (company/'console/hook-secret').write_text('fixture-hook')
        calls = []
        class Response:
            status = 200
            def getheaders(self): return [('Set-Cookie', 'private'), ('Content-Length', '2')]
            def read1(self, _):
                if getattr(self, 'done', False): return b''
                self.done = True; return b'{}'
        class Upstream:
            def __init__(self, *args, **kwargs): pass
            def request(self, method, path, body, headers): calls.append((method, path, body, headers))
            def getresponse(self): return Response()
            def close(self): pass
        original = http.client.HTTPConnection
        office = OfficeAPI(self.root/'office', SID, 'fixed-upstream', company)
        self.addCleanup(office.close)
        with patch('reverie.worker.http.client.HTTPConnection', Upstream):
            connection = original('localhost')
            transport = socket.socket(socket.AF_UNIX)
            transport.connect(str(self.root/'office/office.sock'))
            connection.sock = transport
            connection.request('GET', '/api/company', headers={'X-Reverie-Parent-Session': 'forged', 'Cookie': 'reverie_owner=forged', 'Authorization': 'forged'})
            response = connection.getresponse()
            self.assertEqual(response.read(), b'{}')
            self.assertIsNone(response.getheader('Set-Cookie'))
            connection.close()
        headers = calls[0][3]
        self.assertEqual(headers['X-Reverie-Parent-Session'], SID)
        self.assertNotIn('Cookie', headers)
        self.assertNotEqual(headers['Authorization'], 'forged')

    def test_only_owner_selected_maintainers_can_restart_the_website(self):
        broker = Broker({**self.config, 'maintenanceSessions': [SID]})
        for action, caller in [('restart-website', 'other'), ('shutdown', SID), ('stop-laptops', SID), ('status', SID)]:
            with self.subTest(action=action, caller=caller), self.assertRaises(ValueError):
                broker.control(action, caller)
        self.assertEqual(OFFLINE_GRACE_SECONDS, 600)
        self.assertEqual(broker.control('status')['offlineGraceSeconds'], 600)

    def test_foreign_container_is_never_stopped_or_removed(self):
        config = {**self.config, 'uid': os.getuid()}
        broker = Broker(config)
        broker.check_pool = lambda: None
        calls = []
        def engine(args, optional=False):
            calls.append(args)
            return subprocess.CompletedProcess(args, 0, json.dumps([{'Config': {'Labels': {'reverie.worker': 'someone-else', 'reverie.session': SID}}, 'State': {'Running': True}}]), '')
        broker.run_engine = engine
        server, client = socket.socketpair()
        self.addCleanup(client.close)
        broker.connections.acquire()
        thread = threading.Thread(target=broker.handle, args=(server,))
        thread.start()
        send_frame(client, b'J', json.dumps(self.request).encode())
        kind, result = receive_frame(client)
        self.assertEqual(kind, b'E')
        self.assertIn(b'not owned', result)
        thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertEqual([call[0] for call in calls], ['inspect'])
        self.assertFalse(broker.active)


if __name__ == '__main__':
    unittest.main()
