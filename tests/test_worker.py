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

import signal

from reverie.worker import (RESIZE_CONFIRM_SECONDS, RESIZE_GONE, RESIZE_OBSERVE_INTERVAL, RESIZE_QUERY_FLOOR, ViewerResize,
                            resize_marker_env)
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

    def test_noncanonical_absolute_mount_destinations_are_rejected_before_policy_checks(self):
        for destination in [
            '//reverie_workspace',
            '//reverie_workspace/attachments/private-room',
        ]:
            changed = deepcopy(self.config)
            changed['mounts'][0]['destination'] = destination
            with self.subTest(destination=destination), self.assertRaisesRegex(ValueError, 'destination must be canonical'):
                self.load(changed)

    def test_shared_attachment_store_is_overlaid_after_the_workspace_bind(self):
        workspace = self.root / 'shared-workspace'
        marker = workspace / 'attachments' / 'synthetic-room' / 'synthetic-nonmember.txt'
        marker.parent.mkdir(parents=True)
        marker.write_text('synthetic only')
        config = deepcopy(self.config)
        config['mounts'] = [dict(source=str(workspace), destination='/reverie_workspace', readOnly=False)]

        loaded = self.load(config)
        _, _, args = create_args(loaded, SID, self.root/'home')
        mounts = [args[i + 1] for i, value in enumerate(args[:-1]) if value == '--mount']
        workspace_bind = 'type=bind,src=' + str(workspace) + ',dst=/reverie_workspace'
        attachment_mask = 'type=tmpfs,dst=/reverie_workspace/attachments,tmpfs-mode=0555,tmpfs-size=1048576,readonly'
        self.assertTrue(marker.is_file())
        self.assertIn(workspace_bind, mounts)
        self.assertIn(attachment_mask, mounts)
        self.assertLess(mounts.index(workspace_bind), mounts.index(attachment_mask))
        self.assertFalse(any('src=' + str(workspace / 'attachments') in value for value in mounts))
        worker_path = Path('/reverie_workspace/attachments/synthetic-room/synthetic-nonmember.txt')
        visible = [
            spec for spec in mounts
            if worker_path.is_relative_to(Path(spec.split('dst=', 1)[1].split(',', 1)[0]))
        ]
        self.assertEqual(max(visible, key=lambda spec: len(Path(spec.split('dst=', 1)[1].split(',', 1)[0]).parts)), attachment_mask)

    def test_worker_mounts_cannot_reexpose_shared_attachments_by_path_alias(self):
        workspace = self.root / 'shared-workspace'
        attachments = workspace / 'attachments'
        (attachments / 'room').mkdir(parents=True)
        base = deepcopy(self.config)
        base['mounts'] = [dict(source=str(workspace), destination='/reverie_workspace', readOnly=False)]

        for source, destination in [
            (str(attachments), '/attachments-copy'),
            (str(attachments / 'room'), '/room-copy'),
            (str(workspace), '/workspace-alias'),
            (str(self.root), '/broad-parent'),
        ]:
            changed = deepcopy(base)
            changed['mounts'].append(dict(source=source, destination=destination, readOnly=True))
            with self.subTest(source=source, destination=destination), self.assertRaisesRegex(ValueError, 'shared attachment storage'):
                self.load(changed)

        alias = self.root / 'attachments-alias'
        alias.symlink_to(attachments / 'room', target_is_directory=True)
        changed = deepcopy(base)
        changed['mounts'].append(dict(source=str(alias), destination='/room-symlink-alias', readOnly=True))
        with self.assertRaisesRegex(ValueError, 'shared attachment storage'):
            self.load(changed)

        outside = self.root / 'outside-room-data'
        outside.mkdir()
        (attachments / 'room-link').symlink_to(outside, target_is_directory=True)
        changed = deepcopy(base)
        changed['mounts'].append(dict(source=str(attachments / 'room-link'), destination='/room-link-alias', readOnly=True))
        with self.assertRaisesRegex(ValueError, 'shared attachment storage'):
            self.load(changed)

        changed = deepcopy(base)
        changed['mounts'].append(dict(source=str(self.root / 'work'), destination='/reverie_workspace/attachments/room', readOnly=True))
        with self.assertRaisesRegex(ValueError, 'shared attachment storage'):
            self.load(changed)

    def test_workspace_attachment_root_must_exist_as_a_real_directory(self):
        workspace = self.root / 'workspace-without-attachments'
        workspace.mkdir()
        config = deepcopy(self.config)
        config['mounts'] = [dict(source=str(workspace), destination='/reverie_workspace', readOnly=False)]
        with self.assertRaisesRegex(ValueError, 'existing directory'):
            self.load(config)

        outside = self.root / 'outside-attachments'
        outside.mkdir()
        (workspace / 'attachments').symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'real directory'):
            self.load(config)

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

    def test_plan_move_journal_stops_only_the_retired_or_failed_laptop(self):
        broker = Broker(self.config)
        other = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
        company = self.root/'company.json'
        journal = self.root/'plan-moves.json'
        company.write_text(json.dumps({'employees': [{'sessionId': other, 'desiredRunning': True}]}))
        for phase, allowed in [('waiting', True), ('creating', True), ('starting', True), ('checking', True),
                               ('stopping', False), ('completed', False), ('failed', True), ('recovery-required', True)]:
            with self.subTest(phase=phase):
                journal.write_text(json.dumps([{'oldSession': SID, 'newSession': other, 'phase': phase}]))
                self.assertEqual(broker.allowed(SID), allowed)
                self.assertTrue(broker.allowed(other))
        # A supervisor can miss the transient stopping phase. The durable stop
        # request survives startup, readiness and recovery failures, but is not
        # authority to stop the currently bound employee or an unrelated laptop.
        for phase in ('starting', 'checking', 'recovery-required'):
            journal.write_text(json.dumps([{'oldSession': SID, 'newSession': other,
                                           'phase': phase, 'sourceStopRequested': True}]))
            self.assertFalse(broker.allowed(SID))
            self.assertTrue(broker.allowed(other))
            self.assertTrue(broker.allowed('ffffffff-1111-2222-3333-444444444444'))
        journal.write_text(json.dumps([{'oldSession': SID, 'newSession': other,
                                       'phase': 'creating', 'sourceStopRequested': 'true'}]))
        self.assertTrue(broker.allowed(SID))
        journal.write_text(json.dumps([{'oldSession': other, 'newSession': SID, 'phase': 'failed'}]))
        self.assertFalse(broker.allowed(SID))
        # An explicit owner rebind is newer authority than an old failed record.
        company.write_text(json.dumps({'employees': [{'sessionId': SID, 'desiredRunning': True}]}))
        self.assertTrue(broker.allowed(SID))
        self.assertTrue(broker.allowed('ffffffff-1111-2222-3333-444444444444'))

    def test_plan_move_stop_request_requires_unaliased_owner_metadata(self):
        broker = Broker(self.config)
        (self.root/'company.json').write_text(json.dumps({'employees': []}))
        journal = self.root/'plan-moves.json'
        journal.write_text(json.dumps([{'oldSession': SID, 'phase': 'starting', 'sourceStopRequested': True}]))
        journal.chmod(0o666)
        with self.assertRaisesRegex(RuntimeError, 'Plan move state'):
            broker.allowed(SID)
        journal.chmod(0o600)
        self.assertFalse(broker.allowed(SID))
        alias = self.root/'journal-alias'
        os.link(journal, alias)
        with self.assertRaisesRegex(RuntimeError, 'Plan move state'):
            broker.allowed(SID)
        alias.unlink()
        journal.rename(alias)
        journal.symlink_to(alias)
        with self.assertRaisesRegex(RuntimeError, 'Plan move state'):
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
            def __init__(self, *args, **kwargs): self.sock = None
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

    def test_attach_only_validates_protocol_and_never_creates_a_missing_laptop(self):
        self.assertTrue(validate_request(dict(self.request, attachOnly=True), self.config)['attachOnly'])
        with self.assertRaises(ValueError):
            validate_request(dict(self.request, attachOnly='yes'), self.config)
        broker = Broker({**self.config, 'uid': os.getuid()})
        broker.check_pool = lambda: None
        calls = []
        def engine(args, optional=False):
            calls.append(args)
            return subprocess.CompletedProcess(args, 1, '', '')
        broker.run_engine = engine
        server, client = socket.socketpair()
        self.addCleanup(client.close)
        broker.connections.acquire()
        thread = threading.Thread(target=broker.handle, args=(server,))
        thread.start()
        send_frame(client, b'J', json.dumps(dict(self.request, attachOnly=True)).encode())
        kind, result = receive_frame(client)
        self.assertEqual(kind, b'E')
        self.assertIn(b'never starts a replacement', result)
        thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertEqual([call[0] for call in calls], ['inspect'])
        self.assertFalse(broker.active)

    def test_reconnect_inventory_requires_live_owned_laptop_and_current_running_intent(self):
        employee='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
        (self.root/'company.json').write_text(json.dumps({'employees':[{'id':employee,'sessionId':SID,'desiredRunning':True}]}))
        broker = Broker(self.config)
        broker.laptops[SID] = 'test-agent-' + SID
        home = Path(self.config['stateRoot']) / 'employees' / employee / 'home'
        home.mkdir(parents=True)
        (home / '.reverie-launch').mkdir()
        runtime=Path(self.config['stateRoot'])/SID;runtime.mkdir(mode=0o700)
        (runtime / 'runtime.json').write_text(json.dumps({'exit': 'current.exit'}))
        item = {'Config': {'Labels': {'reverie.worker': 'test', 'reverie.session': SID}}, 'State': {'Running': True}}
        dead = False
        def engine(args, optional=False):
            return subprocess.CompletedProcess(args, 0, json.dumps([item]) if args[0] == 'inspect' else ('1' if dead else '0'), '')
        broker.run_engine = engine
        self.assertEqual(broker.control('status')['runningSessionIds'], [SID])
        dead = True
        self.assertEqual(broker.control('status')['runningSessionIds'], [])
        dead = False
        item['Config']['Labels']['reverie.session'] = 'foreign'
        self.assertEqual(broker.control('status')['runningSessionIds'], [])
        item['Config']['Labels']['reverie.session'] = SID
        (self.root / 'company.json').write_text(json.dumps({'employees': [{'id':employee,'sessionId': SID, 'desiredRunning': False}]}))
        self.assertEqual(broker.control('status')['runningSessionIds'], [])
        (self.root / 'company.json').write_text(json.dumps({'employees': [{'id':employee,'sessionId': SID, 'desiredRunning': True}]}))
        (home / '.reverie-launch/current.exit').write_text('0')
        self.assertEqual(broker.control('status')['runningSessionIds'], [])

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


RESIZE_TEST_MARKER = 'f' * 32


class ResizeClock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


class ResizeChild:
    def __init__(self):
        self.pid = 424242
        self.exit = None

    def poll(self):
        return self.exit


class ResizeStopping:
    def __init__(self):
        self.stopped = False
        self.deadline = None

    def is_set(self):
        return self.stopped


class ResizeBroker:
    """The broker surface ViewerResize uses, with a scripted engine."""

    def __init__(self, test):
        self.test = test
        self.viewers = {}
        self.owned_clients = {}
        self.stopping = ResizeStopping()
        self.calls = []
        self.answers = []

    def run_engine(self, args, optional=False, *, deadline=None):
        self.test.assertTrue(optional)
        self.test.assertIsNotNone(deadline)
        self.calls.append((args, deadline))
        answer = self.answers.pop(0)
        if callable(answer):
            answer = answer(args)
        if isinstance(answer, BaseException):
            raise answer
        return subprocess.CompletedProcess(args, 0, answer, '')


def resize_rows(*rows):
    return ''.join('%d %d %d\n' % row for row in rows)


def resize_unconfirmed(size, reason, observed='none'):
    return 'Reverie worker: terminal resize to %s unconfirmed (%s); last observed %s' % (size, reason, observed)


def resize_environ(marker=RESIZE_TEST_MARKER, extra=('TERM=xterm-256color',)):
    return '\0'.join([*extra, resize_marker_env(marker)]) + '\0'


class ViewerResizeRules(unittest.TestCase):
    """A viewer's resize is confirmed by its own tmux client within one deadline, or reported as unconfirmed."""
    def setUp(self):
        self.clock = ResizeClock()
        self.broker = ResizeBroker(self)
        self.child = ResizeChild()
        self.guard = threading.Lock()
        self.token = object()
        self.broker.viewers[self.token] = (self.child, self.guard)
        self.reports = []
        self.signals = []
        kill = lambda pid, sig: self.signals.append((pid, sig))
        self.enterContext(patch('reverie.worker.os.kill', side_effect=kill))
        self.resize = ViewerResize(self.broker, 'c' * 64, self.child, self.token, self.guard, RESIZE_TEST_MARKER, clock=self.clock,
                                   report=self.reports.append)

    def observe(self, answers):
        self.broker.answers.extend(answers)
        self.clock.now += RESIZE_OBSERVE_INTERVAL
        self.assertTrue(self.resize.due())
        self.resize.observe()

    def test_an_immediate_match_needs_one_signal_and_one_observation(self):
        self.resize.request(100, 35)
        self.observe([resize_rows((77, 100, 35)), resize_environ()])
        self.assertIsNone(self.resize.pending)
        self.assertEqual(self.signals, [(424242, signal.SIGWINCH)])
        self.assertEqual(self.reports, [])
        listed, read = [args for args, _ in self.broker.calls]
        self.assertEqual(listed[-3:], ['list-clients', '-F', '#{client_pid} #{client_width} #{client_height}'])
        self.assertEqual(read, ['exec', 'c' * 64, '/bin/cat', '/proc/77/environ'])

    def test_an_old_size_is_signalled_again_until_this_client_reports_the_request(self):
        self.resize.request(100, 35)
        self.observe([resize_rows((77, 80, 24)), resize_environ()])
        self.assertEqual(len(self.signals), 2)
        self.observe([resize_rows((77, 100, 35)), resize_environ()])
        self.assertIsNone(self.resize.pending)
        self.assertEqual(len(self.signals), 2)
        self.assertEqual(self.reports, [])

    def test_every_call_shares_the_request_deadline_clamped_by_the_stop_budget(self):
        self.resize.request(100, 35)
        deadline = self.resize.pending.deadline
        self.observe([resize_rows((77, 80, 24)), resize_environ()])
        self.assertEqual({d for _, d in self.broker.calls}, {deadline})
        self.broker.stopping.deadline = deadline - 1
        self.observe([resize_rows((77, 80, 24)), resize_environ()])
        self.assertEqual({d for _, d in self.broker.calls[2:]}, {deadline - 1})

    def test_a_newer_request_replaces_the_older_and_only_it_is_acknowledged(self):
        self.resize.request(100, 35)
        self.resize.request(120, 40)
        self.observe([resize_rows((77, 100, 35)), resize_environ()])
        self.assertEqual((self.resize.pending.cols, self.resize.pending.rows), (120, 40))
        self.observe([resize_rows((77, 120, 40)), resize_environ()])
        self.assertIsNone(self.resize.pending)
        self.assertEqual(self.reports, [])

    def test_an_observation_superseded_while_it_runs_neither_acknowledges_nor_signals(self):
        self.resize.request(100, 35)
        def newer(args):
            self.resize.request(120, 40)
            return resize_environ()
        before = len(self.signals)
        self.observe([resize_rows((77, 100, 35)), newer])
        # Only the newer request's own signal; the stale 100x35 observation is discarded.
        self.assertEqual(len(self.signals), before + 1)
        self.assertEqual((self.resize.pending.cols, self.resize.pending.rows), (120, 40))
        self.assertEqual(self.reports, [])

    def test_a_query_returning_after_the_deadline_cannot_acknowledge_and_reports_once(self):
        self.resize.request(100, 35)
        def late(args):
            self.clock.now += RESIZE_CONFIRM_SECONDS
            return resize_environ()
        signals = len(self.signals)
        self.observe([resize_rows((77, 100, 35)), late])
        self.assertIsNone(self.resize.pending)
        self.assertEqual(len(self.signals), signals)
        self.assertEqual(self.reports, [resize_unconfirmed('100x35', 'EXPIRED')])
        self.assertFalse(self.resize.due())

    def test_nothing_is_dispatched_after_expiry(self):
        self.resize.request(100, 35)
        self.clock.now += RESIZE_CONFIRM_SECONDS
        self.resize.observe()
        self.assertEqual(self.broker.calls, [])
        self.assertEqual(len(self.reports), 1)
        self.assertIn('(EXPIRED)', self.reports[0])

    def test_no_query_is_started_without_its_floor_and_the_request_then_expires_at_its_deadline(self):
        self.resize.request(100, 35)
        self.clock.now = self.resize.pending.deadline - RESIZE_QUERY_FLOOR + 0.01
        self.resize.observe()
        self.assertEqual(self.broker.calls, [])
        self.assertEqual(self.reports, [])
        self.clock.now = self.resize.pending.deadline
        self.resize.observe()
        self.assertEqual(self.broker.calls, [])
        self.assertEqual(self.reports, [resize_unconfirmed('100x35', 'EXPIRED')])

    def test_unsettled_query_ownership_stops_confirmation_and_reports_every_later_request(self):
        self.resize.request(100, 35)
        def retained(args):
            # As run_client does when it cannot reap a killed client: the record stays owned.
            self.broker.owned_clients[object()] = ResizeChild()
            return subprocess.TimeoutExpired(args, 1)
        self.observe([retained])
        self.assertEqual(self.reports, [resize_unconfirmed('100x35', 'CLEANUP_UNCONFIRMED')])
        self.assertFalse(self.resize.due())
        calls = len(self.broker.calls)
        self.resize.request(120, 40)
        self.assertEqual(self.reports[-1], resize_unconfirmed('120x40', 'CLEANUP_UNCONFIRMED'))
        self.assertFalse(self.resize.due())
        self.resize.observe()
        self.assertEqual(len(self.broker.calls), calls)
        self.assertEqual(len(self.broker.owned_clients), 1)

    def test_a_settled_query_failure_or_undecodable_environment_is_only_a_missed_observation(self):
        self.resize.request(100, 35)
        self.observe([RuntimeError('Worker engine operation failed')])
        self.observe([resize_rows((77, 100, 35)), UnicodeDecodeError('utf-8', b'\xff', 0, 1, 'invalid start byte')])
        self.assertIsNotNone(self.resize.pending)
        self.assertIsNone(self.resize.blocked)
        self.observe([resize_rows((77, 100, 35)), resize_environ()])
        self.assertIsNone(self.resize.pending)
        self.assertEqual(self.reports, [])

    def test_a_malformed_inventory_or_nonzero_exit_is_not_a_size(self):
        self.resize.request(100, 35)
        for inventory in ['77 100\n', '77 100 35 x\n', '0 100 35\n', '77 0 35\n', '-77 100 35\n', 'pid 100 35\n']:
            self.observe([inventory])
            self.assertIsNotNone(self.resize.pending, inventory)
        self.broker.answers.append(lambda args: subprocess.CompletedProcess(args, 1, resize_rows((77, 100, 35)), ''))
        self.clock.now += RESIZE_OBSERVE_INTERVAL
        self.resize.observe()
        self.assertIsNotNone(self.resize.pending)
        self.assertEqual(self.reports, [])

    def test_only_the_one_client_carrying_this_marker_can_acknowledge(self):
        self.resize.request(100, 35)
        # Another client already at the requested size, without this viewer's marker.
        self.observe([resize_rows((77, 80, 24), (78, 100, 35)), resize_environ(), resize_environ('0' * 32)])
        self.assertIsNotNone(self.resize.pending)
        # Two clients claiming this marker are ambiguous, not an acknowledgement.
        self.observe([resize_rows((77, 100, 35), (78, 100, 35)), resize_environ(), resize_environ()])
        self.assertIsNotNone(self.resize.pending)
        # An entry that only contains this marker, or extends it, is not this marker.
        for entry in ('X' + resize_marker_env(RESIZE_TEST_MARKER), resize_marker_env(RESIZE_TEST_MARKER) + '0', resize_marker_env(RESIZE_TEST_MARKER)[:-1]):
            self.observe([resize_rows((77, 100, 35)), 'TERM=xterm\0' + entry + '\0'])
            self.assertIsNotNone(self.resize.pending, entry)

    def test_a_replaced_exited_or_stopping_viewer_is_never_signalled_or_reported(self):
        for end in ('replaced', 'exited', 'stopping'):
            with self.subTest(end=end):
                self.setUp()
                self.resize.request(100, 35)
                signals = len(self.signals)
                if end == 'replaced':
                    self.broker.viewers[self.token] = (ResizeChild(), threading.Lock())
                elif end == 'exited':
                    self.child.exit = 0
                elif end == 'stopping':
                    self.broker.stopping.stopped = True
                self.observe([])
                self.assertIsNone(self.resize.pending)
                self.assertEqual(len(self.signals), signals)
                self.assertEqual(self.reports, [])
                self.assertEqual(self.broker.calls, [])

    def test_a_held_reap_guard_defers_the_signal_and_keeps_the_request_pending(self):
        self.assertTrue(self.guard.acquire(blocking=False))
        try:
            self.resize.request(100, 35)
            self.assertEqual(self.signals, [])
            self.assertIsNotNone(self.resize.pending)
            self.observe([resize_rows((77, 80, 24)), resize_environ()])
            self.assertEqual(self.signals, [])
            self.assertIsNotNone(self.resize.pending)
        finally:
            self.guard.release()
        self.observe([resize_rows((77, 80, 24)), resize_environ()])
        self.assertEqual(self.signals, [(424242, signal.SIGWINCH)])
        self.observe([resize_rows((77, 100, 35)), resize_environ()])
        self.assertIsNone(self.resize.pending)
        self.assertEqual(self.reports, [])

    def test_a_viewer_reaped_while_the_guard_is_being_taken_is_not_signalled(self):
        resize, broker, token = self.resize, self.broker, self.token
        class ReapedFirst:
            """A guard whose holder finished reaping the viewer just before this acquire succeeded."""
            def __init__(self):
                self.lock = threading.Lock()
            def acquire(self, blocking=True):
                broker.viewers.pop(token, None)
                return self.lock.acquire(blocking)
            def release(self):
                self.lock.release()
        guard = ReapedFirst()
        broker.viewers[token] = (self.child, guard)
        resize.guard = guard
        resize.request(100, 35)
        self.assertEqual(self.signals, [])
        self.assertIsNone(resize.pending)

    def test_a_superseded_request_is_never_signalled_for(self):
        self.resize.request(100, 35)
        older = self.resize.pending
        self.resize.request(120, 40)
        signals = len(self.signals)
        self.assertEqual(self.resize.signal(older), RESIZE_GONE)
        self.assertEqual(len(self.signals), signals)
        self.assertEqual((self.resize.pending.cols, self.resize.pending.rows), (120, 40))

    def test_a_guard_held_until_the_deadline_reports_the_request_expired(self):
        self.assertTrue(self.guard.acquire(blocking=False))
        self.addCleanup(self.guard.release)
        self.resize.request(100, 35)
        self.clock.now = self.resize.pending.deadline
        self.resize.observe()
        self.assertEqual(self.signals, [])
        self.assertEqual(self.reports, [resize_unconfirmed('100x35', 'EXPIRED')])

    def test_the_first_signal_has_the_stop_check_too(self):
        self.broker.stopping.stopped = True
        self.resize.request(100, 35)
        self.assertEqual(self.signals, [])
        self.assertIsNone(self.resize.pending)
        self.assertEqual(self.reports, [])

    def test_an_unreadable_client_environment_leaves_no_client_provably_the_only_one(self):
        self.resize.request(100, 35)
        for unreadable in (RuntimeError('Worker engine operation failed'),
                           UnicodeDecodeError('utf-8', b'\xff', 0, 1, 'invalid start byte'),
                           lambda args: subprocess.CompletedProcess(args, 1, '', '')):
            self.observe([resize_rows((77, 100, 35), (78, 80, 24)), resize_environ(), unreadable])
            self.assertIsNotNone(self.resize.pending, unreadable)
            self.observe([resize_rows((78, 80, 24), (77, 100, 35)), unreadable, resize_environ()])
            self.assertIsNotNone(self.resize.pending, unreadable)
        self.observe([resize_rows((77, 100, 35), (78, 80, 24)), resize_environ(), resize_environ('0' * 32)])
        self.assertIsNone(self.resize.pending)
        self.assertEqual(self.reports, [])

    def test_a_viewer_replaced_before_its_resize_arrives_is_never_signalled(self):
        self.broker.viewers[self.token] = (ResizeChild(), threading.Lock())
        self.resize.request(100, 35)
        self.assertEqual(self.signals, [])
        self.assertIsNone(self.resize.pending)

    def test_the_request_clock_and_stop_are_checked_under_the_guard_at_the_signal(self):
        for change in ('expire', 'stop'):
            with self.subTest(change=change):
                self.setUp()
                self.resize.request(100, 35)
                signals = len(self.signals)
                clock, broker, guard = self.clock, self.broker, self.guard
                class Changing:
                    """A guard whose acquisition takes until the request expires, or until the broker stops."""
                    def acquire(self, blocking=True):
                        if change == 'expire':
                            clock.now += RESIZE_CONFIRM_SECONDS
                        else:
                            broker.stopping.stopped = True
                        return guard.acquire(blocking)
                    def release(self):
                        guard.release()
                changing = Changing()
                self.broker.viewers[self.token] = (self.child, changing)
                self.resize.guard = changing
                self.resize.signal(self.resize.pending)
                self.assertEqual(len(self.signals), signals)
                self.assertIsNone(self.resize.pending)
                self.assertEqual(self.reports, [resize_unconfirmed('100x35', 'EXPIRED')] if change == 'expire' else [])

    def test_an_acknowledgement_is_bound_to_the_request_clock_at_the_moment_it_is_made(self):
        self.resize.request(100, 35)
        clock = self.clock
        class Expiring(str):
            """An environment whose marker scan takes until the request has expired."""
            def split(self, *args):
                clock.now += RESIZE_CONFIRM_SECONDS
                return str.split(self, *args)
        self.observe([resize_rows((77, 100, 35)), Expiring(resize_environ())])
        self.assertIsNone(self.resize.pending)
        self.assertEqual(self.reports, [resize_unconfirmed('100x35', 'EXPIRED', '100x35')])

    def test_a_blocked_viewer_reports_a_later_request_even_while_its_guard_is_busy(self):
        self.resize.request(100, 35)
        def retained(args):
            self.broker.owned_clients[object()] = ResizeChild()
            return subprocess.TimeoutExpired(args, 1)
        self.observe([retained])
        self.assertTrue(self.guard.acquire(blocking=False))
        self.addCleanup(self.guard.release)
        self.resize.request(120, 40)
        self.assertEqual(self.reports[-1], resize_unconfirmed('120x40', 'CLEANUP_UNCONFIRMED'))
        self.assertIsNone(self.resize.pending)

    def test_an_environment_read_refused_by_the_query_floor_leaves_the_round_unacknowledged(self):
        self.resize.request(100, 35)
        deadline = self.resize.pending.deadline
        def late(args):
            # The inventory returns with less than the floor left, so the environment reads are not dispatched.
            self.clock.now = deadline - RESIZE_QUERY_FLOOR + 0.01
            return resize_rows((77, 100, 35))
        self.observe([late])
        self.assertIsNotNone(self.resize.pending)
        self.assertEqual(len(self.broker.calls), 1)

    def test_an_unknown_container_reports_the_request_unavailable(self):
        self.resize.container_id = None
        self.resize.request(100, 35)
        self.observe([])
        self.assertEqual(self.reports, [resize_unconfirmed('100x35', 'UNAVAILABLE')])


if __name__ == '__main__':
    unittest.main()
