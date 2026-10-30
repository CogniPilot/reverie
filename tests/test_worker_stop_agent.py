"""Owner stop of one laptop's agent: kill only the inner pane's process group, write no exit receipt, leave a dead pane."""
import tests  # noqa: F401
import json, shutil, socket, subprocess, time, unittest
from pathlib import Path
from tests import test_worker as F
from reverie.worker import Broker, send_frame, receive_frame

SID = F.SID


class StopAgentTests(unittest.TestCase):
    def setUp(self):
        F.WorkerTests.setUp(self)
        self.tmux = shutil.which('tmux')
        self.assertIsNotNone(self.tmux, 'Declared flake tmux is required')
        self.socket = self.root / 'inner.sock'
        self.addCleanup(lambda: subprocess.run([self.tmux, '-S', str(self.socket), 'kill-server'], capture_output=True))
        self.receipt = self.root / 'receipt'
        self.name = 'test-agent-' + SID
        self.broker = Broker(self.config)
        self.broker.laptops[SID] = self.name
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
            return subprocess.run(['/bin/bash', '-c', *args[4:]], capture_output=True, text=True, timeout=5, check=True)
        self.broker.run_engine = engine

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
        return subprocess.run(['ps', '-o', 'pid=', '-g', str(pid)], capture_output=True, text=True).stdout.split()

    def test_stop_kills_the_whole_pane_group_without_a_receipt_and_leaves_a_dead_pane(self):
        pid = self.start_inner()
        self.assertEqual(len(self.group(pid)), 3)  # wrapper, provider, relay
        self.assertEqual(self.broker.stop_agent(SID), {'action': 'stop-agent', 'success': True, 'stopped': True, 'paneDead': True})
        self.assertEqual(self.group(pid), [])
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


if __name__ == '__main__':
    unittest.main()
