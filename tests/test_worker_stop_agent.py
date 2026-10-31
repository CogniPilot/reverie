"""Owner stop of one laptop's agent: kill only the inner pane's process group, write no exit receipt, leave a dead pane."""
import tests  # noqa: F401
import json, shutil, socket, stat, subprocess, time, unittest
from pathlib import Path
from tests import test_worker as F
from reverie.worker import Broker, StopNotDispatched, create_args, send_frame, receive_frame

SID = F.SID


class StopAgentTests(unittest.TestCase):
    def setUp(self):
        F.WorkerTests.setUp(self)
        self.tmux = shutil.which('tmux')
        self.assertIsNotNone(self.tmux, 'Declared flake tmux is required')
        # The laptop runs the stop scripts with its own /bin/bash; here they run on the host, from PATH (a nix build
        # sandbox has no /bin/bash). The exec the broker asks for still names /bin/bash, as asserted below.
        self.bash = shutil.which('bash')
        self.assertIsNotNone(self.bash, 'Declared flake bash is required')
        self.socket = self.root / 'inner.sock'
        self.addCleanup(lambda: subprocess.run([self.tmux, '-S', str(self.socket), 'kill-server'], capture_output=True))
        self.receipt = self.root / 'receipt'
        self.name = 'test-agent-' + SID
        self.broker = Broker(self.config)
        self.broker.laptops[SID] = self.name
        self.assertEqual(self.broker.stop_fence_dir, '/home/agent/.reverie-stop')  # the laptop user's own home
        self.broker.stop_fence_dir = str(self.root / 'home' / '.reverie-stop')  # created on first use, as in the laptop
        self.calls = []
        def engine(args, optional=False, **_kw):
            self.calls.append(args)
            self.assertEqual(args[0], 'exec')
            if '/bin/tmux' in args:
                at = args.index('/bin/tmux')
                self.assertEqual(args[at - 1], self.name)
                self.assertEqual(args[at + 1:at + 4], ['-u', '-L', 'reverie-laptop'])
                return subprocess.run([self.tmux, '-S', str(self.socket), *args[at + 4:]], capture_output=True, text=True, timeout=5)
            self.assertEqual(args[1:4], [self.name, '/bin/bash', '-c'])  # no --user/--privileged: the container user
            return subprocess.run([self.bash, '-c', *args[4:]], capture_output=True, text=True, timeout=5, check=not optional)
        self.broker.run_engine = self.engine = engine

    def start_inner(self):
        # The production shape: wrapper -> provider (exec'd) plus a background relay in the same group; receipt on
        # any exit of the provider; remain-on-exit set in the same tmux command that creates the session.
        wrapper = f"/bin/sh -c 'sleep 301 & exec sleep 302'; printf %s $? > {self.receipt}; exec sleep infinity"
        subprocess.run([self.tmux, '-S', str(self.socket), '-f', '/dev/null', 'new-session', '-d', '-s', 'office', wrapper,
                        ';', 'set-option', '-g', 'remain-on-exit', 'on'], check=True, capture_output=True)
        time.sleep(0.3)
        return int(self.query('#{pane_pid}'))

    def query(self, value):
        return subprocess.check_output([self.tmux, '-S', str(self.socket), 'display-message', '-p', '-t', 'office', value],
                                       text=True, timeout=2).strip()

    def group(self, pid):
        # The live members of process group pid, read from /proc (the build sandbox has no ps). A zombie is dead and can
        # signal nothing; it stays listed until something reaps it, and the sandbox's PID 1 (the builder) may never do so.
        members = []
        for entry in Path('/proc').iterdir():
            if entry.name.isdigit():
                try:
                    line = (entry / 'stat').read_text()
                except OSError:
                    continue  # exited while listing
                state, _ppid, pgrp = line[line.rindex(')') + 2:].split()[:3]  # after "pid (comm)"
                if int(pgrp) == pid and state not in ('Z', 'X'):
                    members.append(entry.name)
        return sorted(members, key=int)

    def assertGroupGone(self, pid, within=5.0):
        # SIGKILL is sent at once but each member exits on its own time; a path that does not wait for the dead pane
        # (a failed answer after the signal, say) can look before the last one has gone.
        deadline = time.monotonic() + within
        while self.group(pid) and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertEqual(self.group(pid), [])

    def test_stop_kills_the_whole_pane_group_without_a_receipt_and_leaves_a_dead_pane(self):
        pid = self.start_inner()
        self.assertEqual(len(self.group(pid)), 3)  # wrapper, provider, relay
        self.assertEqual(self.broker.stop_agent(SID), {'action': 'stop-agent', 'success': True, 'stopped': True, 'paneDead': True})
        self.assertGroupGone(pid)
        self.assertFalse(self.receipt.exists())  # a receipt would make the broker stop the whole laptop
        self.assertEqual(self.query('#{pane_dead} #{pane_pid}'), f'1 {pid}')
        self.assertEqual(self.broker.laptops, {SID: self.name})  # the laptop itself is untouched

    def test_already_dead_pane_is_not_signalled_again(self):
        pid = self.start_inner()
        subprocess.run(['kill', '-KILL', '--', f'-{pid}'], check=True)
        time.sleep(0.3)
        self.calls.clear()
        self.assertEqual(self.broker.stop_agent(SID)['stopped'], False)
        self.assertFalse([c for c in self.calls if '/bin/bash' in c])

    def test_refuses_unknown_or_invalid_sessions_and_unavailable_pane_state(self):
        with self.assertRaises(ValueError):
            self.broker.stop_agent('../' + SID)
        self.broker.laptops.clear()
        with self.assertRaisesRegex(RuntimeError, 'no running laptop'):
            self.broker.stop_agent(SID)
        self.broker.laptops[SID] = self.name  # no tmux server: state unavailable, nothing signalled
        with self.assertRaisesRegex(RuntimeError, 'state is unavailable; nothing was stopped'):
            self.broker.stop_agent(SID)
        self.assertFalse([c for c in self.calls if '/bin/bash' in c])

    def send_control(self, control):
        client, server = socket.socketpair()
        client.settimeout(5)
        try:
            self.broker.connections.acquire()
            send_frame(client, b'C', json.dumps(control).encode())
            self.broker.handle(server)
            return receive_frame(client)
        finally:
            client.close(); server.close()

    def test_control_frame_takes_exactly_one_session_and_no_maintenance_caller(self):
        self.start_inner()
        for bad in ({'action': 'stop-agent'}, {'action': 'stop-agent', 'sessionId': SID, 'caller': SID},
                    {'action': 'stop-agent', 'sessionId': SID, 'extra': 1}):
            kind, _ = self.send_control(bad)
            self.assertEqual(kind, b'E', bad)
        self.assertEqual(self.query('#{pane_dead}'), '0')
        kind, body = self.send_control({'action': 'stop-agent', 'sessionId': SID})
        self.assertEqual((kind, json.loads(body)['stopped']), (b'J', True))
        self.assertEqual(self.query('#{pane_dead}'), '1')

    def test_an_expired_deadline_refuses_before_any_signal(self):
        pid = self.start_inner()
        with self.assertRaisesRegex(StopNotDispatched, 'expired before the signal; nothing was stopped'):
            self.broker.stop_agent(SID, int(time.time() * 1000) - 1)
        self.assertFalse([c for c in self.calls if '/bin/bash' in c])
        self.assertEqual(len(self.group(pid)), 3)
        self.assertEqual(self.broker.stop_agent(SID, int(time.time() * 1000) + 10_000)['stopped'], True)
        for bad in (0, -5, 1.5, '1', True):
            with self.assertRaises(ValueError):
                self.broker.stop_agent(SID, bad)

    def test_refusals_before_the_signal_are_definitive_and_failures_after_it_are_not(self):
        self.broker.laptops.clear()
        with self.assertRaises(StopNotDispatched):
            self.broker.stop_agent(SID)
        self.broker.laptops[SID] = self.name
        pid = self.start_inner()
        engine = self.broker.run_engine
        signalled = []
        def after_signal(args, optional=False, **kw):
            if '/bin/bash' in args: signalled.append(args); return engine(args, optional, **kw)
            if signalled: return subprocess.CompletedProcess(args, 1, '', 'gone')  # pane state lost after the kill
            return engine(args, optional, **kw)
        self.broker.run_engine = after_signal
        with self.assertRaisesRegex(RuntimeError, 'after the stop signal; its outcome is unknown') as raised:
            self.broker.stop_agent(SID)
        self.assertNotIsInstance(raised.exception, StopNotDispatched)
        self.assertEqual(len(signalled), 1)
        self.assertGroupGone(pid)

    def test_control_frame_carries_the_deadline_and_reports_a_refusal_as_not_dispatched(self):
        self.start_inner()
        kind, body = self.send_control({'action': 'stop-agent', 'sessionId': SID, 'notAfter': int(time.time() * 1000) - 1})
        self.assertEqual(kind, b'J')
        self.assertEqual(json.loads(body), {'action': 'stop-agent', 'success': False, 'dispatched': False,
                                            'error': 'The stop request expired before the signal; nothing was stopped'})
        self.assertEqual(self.query('#{pane_dead}'), '0')
        kind, _ = self.send_control({'action': 'stop-agent', 'sessionId': SID, 'notAfter': 'later'})
        self.assertEqual(kind, b'E')
        kind, body = self.send_control({'action': 'stop-agent', 'sessionId': SID, 'notAfter': int(time.time() * 1000) + 10_000})
        self.assertEqual((kind, json.loads(body)['stopped']), (b'J', True))

    def accepted_late(self, settle=True):
        """An engine whose stop exec was accepted but answers nothing in time: the client times out (as run_client
        raises) while the exec itself stays able to run later. Settles run at once unless settle is False."""
        engine, late = self.engine, []
        def deferred(args, optional=False, **kw):
            if '/bin/bash' in args and args[5] == 'stop-agent':
                late.append(lambda: engine(args, True, **kw))
                raise subprocess.TimeoutExpired(args, 20)
            if '/bin/bash' in args and args[5] == 'settle-stop' and not settle:
                raise subprocess.TimeoutExpired(args, 20)
            return engine(args, optional, **kw)
        self.broker.run_engine = deferred
        return late

    def test_a_late_accepted_signal_never_lands_once_its_stop_is_fenced(self):
        pid = self.start_inner()
        late = self.accepted_late()
        fence = 'a' * 32
        with self.assertRaisesRegex(StopNotDispatched, 'now fenced; nothing was stopped'):
            self.broker.stop_agent(SID, int(time.time() * 1000) + 60_000, fence)
        self.assertEqual(late[0]().returncode, 4)  # the accepted exec runs after all, inside its deadline
        self.assertEqual(len(self.group(pid)), 3)
        self.assertEqual(self.query('#{pane_dead}'), '0')
        self.assertEqual(self.broker.settle_stop(SID, fence)['signalled'], False)  # settling again keeps the answer

    def test_a_late_signal_after_its_deadline_is_refused_where_it_would_be_sent(self):
        pid = self.start_inner()
        self.broker.stop_settle_retry = 0.05
        late = self.accepted_late(settle=False)
        fence = 'b' * 32
        with self.assertRaisesRegex(RuntimeError, 'outcome is unknown') as raised:
            self.broker.stop_agent(SID, int(time.time() * 1000) + 300, fence)
        self.assertNotIsInstance(raised.exception, StopNotDispatched)
        time.sleep(0.4)
        self.assertEqual(late[0]().returncode, 3)
        self.assertEqual(len(self.group(pid)), 3)
        self.broker.run_engine = self.engine  # the laptop answers again
        self.assertEqual(self.broker.settle_stop(SID, fence)['signalled'], False)
        self.assertEqual(len(self.group(pid)), 3)

    def test_the_broker_keeps_settling_an_unknown_stop_until_it_is_fenced(self):
        pid = self.start_inner()
        self.broker.stop_settle_retry = 0.05
        late = self.accepted_late(settle=False)
        with self.assertRaisesRegex(RuntimeError, 'outcome is unknown'):
            self.broker.stop_agent(SID, int(time.time() * 1000) + 60_000, '9' * 32)
        self.broker.run_engine = self.engine  # the laptop answers again; no caller asks to settle
        fence = Path(self.broker.stop_fence_dir, 'reverie-stop-' + '9' * 32)
        for _ in range(100):
            if fence.exists(): break
            time.sleep(0.05)
        self.assertEqual(fence.read_text(), 'fenced\n')
        self.assertEqual(late[0]().returncode, 4)  # inside its deadline, and still it cannot signal
        self.assertEqual(len(self.group(pid)), 3)

    def test_the_fence_lives_in_a_private_directory_the_laptop_user_creates(self):
        pid = self.start_inner()
        self.assertEqual(self.broker.stop_agent(SID, int(time.time() * 1000) + 60_000, '8' * 32)['stopped'], True)
        self.assertGroupGone(pid)
        fences = Path(self.broker.stop_fence_dir)
        self.assertEqual(stat.S_IMODE(fences.stat().st_mode), 0o700)
        self.assertEqual((fences / ('reverie-stop-' + '8' * 32)).read_text(), f'signal {pid}\n')  # bound to its target

    def test_the_production_fence_root_is_inside_the_laptop_users_writable_home_bind(self):
        # The laptop's root filesystem is read-only and its /run is a root-owned tmpfs; only the home bind is the user's.
        args = create_args(self.config, SID, self.root / 'home')[2]
        self.assertIn('--read-only', args)
        mounts = [args[i + 1] for i, value in enumerate(args[:-1]) if value == '--mount']
        homes = [m for m in mounts if 'dst=/home/agent' in m.split(',')]
        self.assertEqual(len(homes), 1)
        self.assertTrue(homes[0].startswith('type=bind,') and 'readonly' not in homes[0])
        self.assertIn(f"--user", args); self.assertEqual(args[args.index('--user') + 1], f"{self.config['uid']}:{self.config['gid']}")
        fences = Broker.stop_fence_dir
        self.assertTrue(fences.startswith('/home/agent/'))
        covered = [args[i + 1].split(':')[0] for i, value in enumerate(args[:-1]) if value == '--tmpfs']
        covered += [part[4:] for m in mounts for part in m.split(',') if part.startswith('dst=') and part != 'dst=/home/agent']
        self.assertFalse([dst for dst in covered if fences == dst or fences.startswith(dst.rstrip('/') + '/')], covered)

    def test_a_fence_that_cannot_be_created_refuses_before_any_signal(self):
        pid = self.start_inner()
        locked = self.root / 'locked'
        locked.mkdir(mode=0o500)  # like a root-owned /run: the laptop user cannot create anything in it
        self.addCleanup(locked.chmod, 0o700)
        self.broker.stop_fence_dir = str(locked / 'fences')
        with self.assertRaisesRegex(StopNotDispatched, 'cannot record the stop; nothing was stopped'):
            self.broker.stop_agent(SID, int(time.time() * 1000) + 60_000, '7' * 32)
        self.assertEqual(len(self.group(pid)), 3)
        with self.assertRaisesRegex(RuntimeError, 'outcome is unknown'):  # and a settle there stays unknown, never "fenced"
            self.broker.settle_stop(SID, '7' * 32)

    def test_a_claimed_stop_is_signalled_only_once_its_exec_has_exited(self):
        # The pane may already read dead, or hold a new process, while the exec that claimed the fence still runs: until
        # that exec exits it could still signal, so the stop is not settled however the pane looks.
        self.start_inner()
        fences = Path(self.broker.stop_fence_dir); fences.mkdir(parents=True, exist_ok=True)
        fence = fences / ('reverie-stop-' + '6' * 32)
        fence.write_text('signal 999999\n')
        claimed = subprocess.Popen([self.bash, '-c', 'sleep 30; true', 'stop-agent', '999999', '', str(fence)])
        self.addCleanup(lambda: (claimed.poll() is None and claimed.kill(), claimed.wait()))
        time.sleep(0.2)
        with self.assertRaisesRegex(RuntimeError, 'not settled yet'):
            self.broker.settle_stop(SID, '6' * 32)
        other = subprocess.Popen([self.bash, '-c', 'sleep 30; true', 'stop-agent', '1', '', str(fence) + '-other'])  # another stop
        self.addCleanup(lambda: (other.poll() is None and other.kill(), other.wait()))
        claimed.kill(); claimed.wait()
        self.assertEqual(self.broker.settle_stop(SID, '6' * 32)['signalled'], True)
        self.assertEqual(fence.read_text(), 'signal 999999\n')  # settling never rewrites a claimed fence

    def test_a_signal_whose_answer_was_lost_settles_as_signalled_and_confirms_the_exit(self):
        pid = self.start_inner()
        engine = self.broker.run_engine
        def lost(args, optional=False, **kw):
            result = engine(args, optional, **kw)
            if '/bin/bash' in args and args[5] == 'stop-agent':
                raise subprocess.TimeoutExpired(args, 20)
            return result
        self.broker.run_engine = lost
        self.assertEqual(self.broker.stop_agent(SID, int(time.time() * 1000) + 60_000, 'c' * 32)['stopped'], True)
        self.assertGroupGone(pid)
        self.assertEqual(self.broker.settle_stop(SID, 'c' * 32)['signalled'], True)

    def test_settle_is_unknown_while_its_answer_is_missing_and_never_signals(self):
        pid = self.start_inner()
        self.accepted_late(settle=False)
        with self.assertRaises(RuntimeError) as raised:
            self.broker.settle_stop(SID, 'd' * 32)
        self.assertNotIsInstance(raised.exception, StopNotDispatched)
        Path(self.broker.stop_fence_dir).mkdir(parents=True, exist_ok=True); Path(self.broker.stop_fence_dir, 'reverie-stop-' + 'e' * 32).touch()  # claimed by a signal that has not written it yet
        self.broker.run_engine = self.engine
        with self.assertRaisesRegex(RuntimeError, 'not settled yet'):
            self.broker.settle_stop(SID, 'e' * 32)
        for bad in ('A' * 32, 'a' * 31, None, 7):
            with self.assertRaises(ValueError):
                self.broker.settle_stop(SID, bad)
            with self.assertRaises(ValueError):
                self.broker.stop_agent(SID, int(time.time() * 1000) + 60_000, bad if bad is not None else 'x')
        self.assertEqual(len(self.group(pid)), 3)

    def test_control_frames_carry_the_fence_and_settle_it(self):
        pid = self.start_inner()
        late = self.accepted_late()
        future = int(time.time() * 1000) + 60_000
        for bad in ({'action': 'settle-stop', 'sessionId': SID}, {'action': 'settle-stop', 'sessionId': SID, 'fence': 'f' * 32, 'notAfter': future},
                    {'action': 'stop-agent', 'sessionId': SID, 'fence': 'f' * 32}):
            kind, _ = self.send_control(bad)
            self.assertEqual(kind, b'E', bad)
        kind, body = self.send_control({'action': 'stop-agent', 'sessionId': SID, 'notAfter': future, 'fence': 'f' * 32})
        self.assertEqual((kind, json.loads(body)['dispatched']), (b'J', False))
        kind, body = self.send_control({'action': 'settle-stop', 'sessionId': SID, 'fence': 'f' * 32})
        self.assertEqual((kind, json.loads(body)), (b'J', {'action': 'settle-stop', 'success': True, 'signalled': False}))
        self.assertEqual(late[0]().returncode, 4)
        self.assertEqual(len(self.group(pid)), 3)


if __name__ == '__main__':
    unittest.main()
