"""Root soft-limit helper: owned fixture trees only; no host cgroup, engine or root effect."""
import copy
import functools
import json
import os
from pathlib import Path
import socket
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import patch

from reverie import worker_memory_authority as A
from reverie import soft_limit_helper as H
from reverie import worker_memory as M

SID = '11111111-1111-4111-8111-111111111111'
EID = '22222222-2222-4222-8222-222222222222'
CID = 'a' * 64
MIB = A.MIB


def request(**change):
    body = {'v': 1, 'sessionId': SID, 'containerId': CID, **change}
    return (json.dumps(body) + '\n').encode()


class Tree:
    """A fake /proc, cgroup root and state root under one temporary directory."""

    def __init__(self, test, max_mib=4096, high=None):
        tmp = tempfile.TemporaryDirectory()
        test.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.proc, self.cgroup, self.state = self.root / 'proc', self.root / 'cg', self.root / 'state'
        (self.proc / '4242').mkdir(parents=True)
        (self.proc / '4242/stat').write_text('4242 (sleep) ' + ' '.join(['S'] + [str(i) for i in range(1, 30)]))
        (self.proc / '4242/cgroup').write_text('0::/system.slice/laptop\n')
        (self.proc / 'sys/kernel').mkdir(parents=True)
        (self.proc / 'sys/kernel/osrelease').write_text('6.18.39\n')
        (self.proc / 'self').mkdir()
        (self.proc / 'self/mountinfo').write_text(f'30 1 0:26 / {self.cgroup} rw - cgroup2 cgroup2 rw\n')
        self.leaf = self.cgroup / 'system.slice/laptop'
        self.leaf.mkdir(parents=True)
        (self.leaf / 'memory.max').write_text(f'{max_mib * MIB}\n')
        (self.leaf / 'memory.high').write_text('max\n')
        self.home = self.state / 'employees' / EID / 'home'
        self.home.mkdir(parents=True)
        self.policy = {'v': 1, 'deployment': 'reverie', 'stateRoot': str(self.state),
                       'qualifiedKernel': {'osrelease': '6.18.39'},
                       'entries': [{'employeeId': EID, 'home': str(self.home), 'memoryMaxMiB': max_mib,
                                    'memoryHighMiB': high or 1024}]}
        self.row = {'Id': CID, 'Name': f'/reverie-agent-{SID}',
                    'Config': {'Labels': {'reverie.worker': 'reverie', 'reverie.session': SID}},
                    'State': {'Running': True, 'Pid': 4242},
                    'Mounts': [{'Type': 'bind', 'Source': str(self.home), 'Destination': '/home/agent'}],
                    'HostConfig': {'Memory': max_mib * MIB}}

    def high(self):
        return (self.leaf / 'memory.high').read_text().strip()

    def write_policy(self, policy=None, mode=0o644):
        etc = self.root / 'etc'
        etc.mkdir(mode=0o755, exist_ok=True)
        path = etc / 'policy.json'
        path.write_text(json.dumps(self.policy if policy is None else policy))
        path.chmod(mode)
        return path

    def loader(self):
        return functools.partial(A.load_policy, trusted_uid=os.getuid(), anchor=self.root)


class RequestAndPolicyTests(unittest.TestCase):
    def test_request_is_one_strict_identity_line(self):
        self.assertEqual(A.parse_request(request()), (SID, CID))
        bad = [request(extra=1), request(v=True), request(v=2), request(sessionId='ABCDEF01-1111-4111-8111-111111111111'),
               request(containerId='A' * 64), request()[:-1], request() + request(),
               b'{"v":1,"v":1,"sessionId":"%s","containerId":"%s"}\n' % (SID.encode(), CID.encode()),
               b'\xff\n', b' ' * 600 + b'\n', b'{"v":1,"sessionId":NaN}\n']
        for raw in bad:
            with self.subTest(raw=raw[:40]), self.assertRaises(A.Refused) as caught:
                A.parse_request(raw)
            self.assertEqual(caught.exception.code, 'REQUEST_INVALID')

    def test_policy_envelope_binds_exact_home_and_bounded_pair(self):
        tree = Tree(self)
        A.validate_policy(copy.deepcopy(tree.policy))
        for change in [{'home': str(tree.state / 'elsewhere')}, {'memoryHighMiB': 4096}, {'memoryHighMiB': 511},
                       {'memoryMaxMiB': True}, {'employeeId': 'ABCDEF01-2222-4222-8222-222222222222'}, {'extra': 1}]:
            policy = copy.deepcopy(tree.policy)
            policy['entries'][0].update(change)
            with self.subTest(change=change), self.assertRaises(A.Refused):
                A.validate_policy(policy)
        twice = copy.deepcopy(tree.policy)
        twice['entries'].append(dict(twice['entries'][0]))
        with self.assertRaises(A.Refused):
            A.validate_policy(twice)

    def test_protected_policy_file_controls_reach_each_branch(self):
        tree = Tree(self)
        load = tree.loader()
        path = tree.write_policy()
        self.assertEqual(load(path)['entries'][0]['employeeId'], EID)  # A valid protected regular file.
        for label, mode in [('group-writable file', 0o664), ('other-writable file', 0o646)]:
            tree.write_policy(mode=mode)  # Each mode applied immediately before its own assertion.
            self.assertEqual(path.stat().st_mode & 0o777, mode)
            with self.subTest(label), self.assertRaises(A.Refused) as caught:
                load(path)
            self.assertEqual(caught.exception.code, 'POLICY_UNTRUSTED')
        tree.write_policy()
        cases = {'symlinked file': tree.root / 'etc/link.json', 'fifo': tree.root / 'etc/fifo', 'outside anchor': Path('/etc/hostname'),
                 'missing': tree.root / 'etc/missing.json'}
        cases['symlinked file'].symlink_to(path)
        os.mkfifo(cases['fifo'])
        for label, candidate in cases.items():
            with self.subTest(label), self.assertRaises(A.Refused) as caught:
                load(candidate)
            self.assertEqual(caught.exception.code, 'POLICY_UNTRUSTED')
        (tree.root / 'etc').chmod(0o775)  # A writable parent.
        with self.assertRaises(A.Refused):
            load(path)
        (tree.root / 'etc').chmod(0o755)
        real_fstat = os.fstat
        def foreign_owner(fd):
            st = real_fstat(fd)
            return os.stat_result((st.st_mode, st.st_ino, st.st_dev, st.st_nlink, os.getuid() + 1) + tuple(st)[5:])
        with patch.object(A.os, 'fstat', foreign_owner), self.assertRaises(A.Refused):
            load(path)  # A file owned by neither root nor the trusted uid.
        real_read = os.read
        def changed_during_read(fd, n):
            raw = real_read(fd, n)
            path.write_text(json.dumps(tree.policy) + ' ')
            return raw
        with patch.object(A.os, 'read', changed_during_read), self.assertRaises(A.Refused) as caught:
            load(path)
        self.assertEqual(caught.exception.code, 'POLICY_UNTRUSTED')
        path.write_text('{"v":1,"v":1}')
        with self.assertRaises(A.Refused) as caught:
            load(path)
        self.assertEqual(caught.exception.code, 'POLICY_INVALID')
        path.write_text(' ' * (A.POLICY_MAX + 1))
        with self.assertRaises(A.Refused) as caught:
            load(path)
        self.assertEqual(caught.exception.code, 'POLICY_UNTRUSTED')

    def test_kernel_release_must_equal_owner_qualified_release(self):
        tree = Tree(self)
        A.check_kernel(tree.policy, tree.proc)
        (tree.proc / 'sys/kernel/osrelease').write_text('6.12.0\n')
        with self.assertRaises(A.Refused) as caught:
            A.check_kernel(tree.policy, tree.proc)
        self.assertEqual(caught.exception.code, 'KERNEL_UNQUALIFIED')

    def test_host_hierarchy_must_be_full_cgroup2_root(self):
        tree = Tree(self)
        A.check_host_root(tree.proc, tree.cgroup)
        for line in [f'30 1 0:26 /sub {tree.cgroup} rw - cgroup2 cgroup2 rw', f'30 1 0:26 / {tree.cgroup} rw - tmpfs t rw', '']:
            (tree.proc / 'self/mountinfo').write_text(line + '\n')
            with self.subTest(line=line), self.assertRaises(A.Refused):
                A.check_host_root(tree.proc, tree.cgroup)


class SelectAndApplyTests(unittest.TestCase):
    def test_bind_source_selects_exactly_one_authorized_pair(self):
        tree = Tree(self)
        self.assertEqual(A.select_entry(tree.policy, tree.row, SID, CID)['memoryHighMiB'], 1024)
        cases = {
            'IDENTITY_MISMATCH': [('Id', 'b' * 64), ('Name', '/other'), ('State', {'Running': False, 'Pid': 4242})],
            'POLICY_NO_MATCH': [('Mounts', []), ('Mounts', [{'Type': 'bind', 'Source': str(tree.state), 'Destination': '/home/agent'}])],
            'HARD_LIMIT_MISMATCH': [('HostConfig', {'Memory': 8192 * MIB})],
        }
        for code, changes in cases.items():
            for key, value in changes:
                row = copy.deepcopy(tree.row)
                row[key] = value
                with self.subTest(key=key), self.assertRaises(A.Refused) as caught:
                    A.select_entry(tree.policy, row, SID, CID)
                self.assertEqual(caught.exception.code, code)

    def test_symlinked_home_component_never_matches(self):
        tree = Tree(self)
        real = tree.root / 'real-home'
        real.mkdir()
        (tree.state / 'employees' / EID / 'home').rmdir()
        (tree.state / 'employees' / EID / 'home').symlink_to(real)
        with self.assertRaises(A.Refused) as caught:
            A.select_entry(tree.policy, tree.row, SID, CID)
        self.assertEqual(caught.exception.code, 'POLICY_NO_MATCH')

    def test_hard_limit_checked_before_any_write(self):
        tree = Tree(self)
        entry = tree.policy['entries'][0]
        (tree.leaf / 'memory.max').write_text('max\n')
        with self.assertRaises(A.Refused) as caught:
            A.apply_high(entry, 4242, tree.cgroup, tree.proc)
        self.assertEqual(caught.exception.code, 'HARD_LIMIT_MISMATCH')
        self.assertEqual(tree.high(), 'max')

    def test_write_confirmed_by_readback(self):
        tree = Tree(self)
        self.assertEqual(A.apply_high(tree.policy['entries'][0], 4242, tree.cgroup, tree.proc), 1024 * MIB)
        self.assertEqual(tree.high(), str(1024 * MIB))

    def test_post_write_fence_failure_is_unconfirmed_never_refused(self):
        tree = Tree(self)
        calls = []
        def recheck():
            calls.append(1)
            return len(calls) == 1  # Pre-write fence passes; post-write fence fails.
        with self.assertRaises(A.EffectUnconfirmed):
            A.apply_high(tree.policy['entries'][0], 4242, tree.cgroup, tree.proc, recheck)

    def test_changes_during_the_slow_engine_recheck_never_reach_the_writer(self):
        for change, code in [('max', 'HARD_LIMIT_MISMATCH'), ('cgroup', 'IDENTITY_MISMATCH'), ('pid', 'IDENTITY_MISMATCH')]:
            tree = Tree(self)
            def recheck():
                if change == 'max':
                    (tree.leaf / 'memory.max').write_text(f'{8192 * MIB}\n')
                elif change == 'cgroup':
                    (tree.proc / '4242/cgroup').write_text('0::/system.slice/other\n')
                else:
                    (tree.proc / '4242/stat').write_text('4242 (sleep) ' + ' '.join(['S'] + ['9'] * 29))
                return True  # The engine metadata itself looks unchanged.
            with self.subTest(change=change), self.assertRaises(A.Refused) as caught:
                A.apply_high(tree.policy['entries'][0], 4242, tree.cgroup, tree.proc, recheck)
            self.assertEqual((caught.exception.code, tree.high()), (code, 'max'))

    def test_any_failure_once_the_write_is_attempted_is_unconfirmed(self):
        tree = Tree(self)
        writers = []
        real_open, real_close = os.open, os.close
        def opener(path, flags, *args, **kwargs):
            fd = real_open(path, flags, *args, **kwargs)
            if path == 'memory.high' and flags & os.O_WRONLY:
                writers.append(fd)
            return fd
        def closer(fd):
            real_close(fd)
            if fd in writers:
                raise OSError(5, 'close failed after write')
        with patch.object(A.os, 'open', opener), patch.object(A.os, 'close', closer), self.assertRaises(A.EffectUnconfirmed):
            A.apply_high(tree.policy['entries'][0], 4242, tree.cgroup, tree.proc)
        tree = Tree(self)
        def failing_write(fd, raw):
            raise OSError(11, 'write failed')
        with patch.object(A.os, 'write', failing_write), self.assertRaises(A.EffectUnconfirmed):
            A.apply_high(tree.policy['entries'][0], 4242, tree.cgroup, tree.proc)

    @staticmethod
    def open_fds():
        return len(os.listdir('/proc/self/fd'))

    def test_target_walk_never_leaks_its_fd_on_a_failed_open_or_fstat(self):
        tree = Tree(self)
        before = self.open_fds()
        real_open, real_fstat = os.open, os.fstat
        def failing_child(path, flags, *args, **kwargs):
            if path == 'laptop':
                raise OSError(13, 'denied')
            return real_open(path, flags, *args, **kwargs)
        with patch.object(A.os, 'open', failing_child), self.assertRaises(A.Refused):
            A.LaptopTarget(4242, tree.cgroup, tree.proc)
        with patch.object(A.os, 'fstat', lambda fd: (_ for _ in ()).throw(OSError(5, 'io'))), self.assertRaises(A.Refused):
            A.LaptopTarget(4242, tree.cgroup, tree.proc)
        self.assertEqual(self.open_fds(), before)
        target = A.LaptopTarget(4242, tree.cgroup, tree.proc)
        target.close()
        self.assertEqual(self.open_fds(), before)

    def test_leaf_close_failure_after_a_write_is_unconfirmed_and_success_releases_the_fd(self):
        tree = Tree(self)
        before = self.open_fds()
        self.assertEqual(A.apply_high(tree.policy['entries'][0], 4242, tree.cgroup, tree.proc), 1024 * MIB)
        self.assertEqual(self.open_fds(), before)
        tree = Tree(self)
        real_close = os.close
        leaf_fds = []
        real_init = A.LaptopTarget.__init__
        def tracking_init(target, *args, **kwargs):
            real_init(target, *args, **kwargs)
            leaf_fds.append(target.fd)
        def closer(fd):
            real_close(fd)
            if fd in leaf_fds:
                raise OSError(5, 'leaf close failed')
        with patch.object(A.LaptopTarget, '__init__', tracking_init), patch.object(A.os, 'close', closer), \
                self.assertRaises(A.EffectUnconfirmed):
            A.apply_high(tree.policy['entries'][0], 4242, tree.cgroup, tree.proc)
        self.assertEqual(tree.high(), str(1024 * MIB))  # The write happened; only the outcome is uncertain.

    def test_request_deadline_crossed_by_the_slow_recheck_refuses_with_zero_writes(self):
        tree = Tree(self)
        clock = [100.0]
        def slow_recheck():
            clock[0] += 9.0  # The engine reinspection crosses the 8-second request deadline.
            return True
        with patch.object(A.time, 'monotonic', lambda: clock[0]), self.assertRaises(A.Refused) as caught:
            A.apply_high(tree.policy['entries'][0], 4242, tree.cgroup, tree.proc, slow_recheck, deadline=108.0)
        self.assertEqual((caught.exception.code, tree.high()), ('DEADLINE', 'max'))

    def test_symlinked_leaf_is_not_followed(self):
        tree = Tree(self)
        other = tree.root / 'other'
        other.mkdir()
        (other / 'memory.max').write_text(f'{4096 * MIB}\n')
        (other / 'memory.high').write_text('max\n')
        for name in ('memory.max', 'memory.high'):
            (tree.leaf / name).unlink()
        tree.leaf.rmdir()
        tree.leaf.symlink_to(other)
        with self.assertRaises(A.Refused):
            A.apply_high(tree.policy['entries'][0], 4242, tree.cgroup, tree.proc)
        self.assertEqual((other / 'memory.high').read_text(), 'max\n')


class HelperServeTests(unittest.TestCase):
    def serve(self, tree, raw=None, uid=None, inspector=None):
        server, client = socket.socketpair()
        self.addCleanup(server.close)
        self.addCleanup(client.close)
        client.sendall(raw if raw is not None else request())
        pins = types.SimpleNamespace(broker_uid=os.getuid() if uid is None else uid, deployment='reverie',
                                     engine='/nix/store/x-docker/bin/docker', endpoint='unix:///run/docker.sock',
                                     policy='/etc/reverie/soft-limit-policy.json', state_root=str(tree.state))
        pins.policy = str(tree.write_policy())
        reply = H.serve(server, pins, cgroup=tree.cgroup, proc=tree.proc, load_policy=tree.loader(),
                        inspector=inspector or (lambda *_: copy.deepcopy(tree.row)))
        self.assertEqual(json.loads(client.recv(1024)), reply)
        return reply

    def test_authorized_request_applies_only_policy_value(self):
        tree = Tree(self, high=2048)
        self.assertEqual(self.serve(tree), {'ok': True, 'memoryHighBytes': 2048 * MIB})
        self.assertEqual(tree.high(), str(2048 * MIB))

    def test_wrong_peer_uid_is_refused_before_reading(self):
        tree = Tree(self)
        self.assertEqual(self.serve(tree, uid=os.getuid() + 1), {'ok': False, 'code': 'PEER_REFUSED'})
        self.assertEqual(tree.high(), 'max')

    def test_unqualified_kernel_refuses_with_zero_writes_even_if_open_would_succeed(self):
        tree = Tree(self)
        (tree.proc / 'sys/kernel/osrelease').write_text('6.12.0\n')
        opened = []
        real_open = os.open
        def watch(path, flags, *args, **kwargs):
            if path == 'memory.high' and flags & os.O_WRONLY:
                opened.append(path)
            return real_open(path, flags, *args, **kwargs)
        with patch.object(A.os, 'open', watch):
            self.assertEqual(self.serve(tree), {'ok': False, 'code': 'KERNEL_UNQUALIFIED'})
        self.assertEqual((opened, tree.high()), ([], 'max'))

    def test_identity_change_before_write_refuses_and_after_write_is_unconfirmed(self):
        moved_row = lambda tree: {**copy.deepcopy(tree.row), 'State': {'Running': True, 'Pid': 4343}}
        tree = Tree(self)  # Initial inspection, then a changed pre-write fence: refused, nothing written.
        rows = [copy.deepcopy(tree.row)]
        reply = self.serve(tree, inspector=lambda *_: rows.pop(0) if rows else moved_row(tree))
        self.assertEqual((reply, tree.high()), ({'ok': False, 'code': 'IDENTITY_MISMATCH'}, 'max'))
        tree = Tree(self)  # Initial and pre-write match; the post-write fence changes: unconfirmed.
        rows = [copy.deepcopy(tree.row), copy.deepcopy(tree.row)]
        reply = self.serve(tree, inspector=lambda *_: rows.pop(0) if rows else moved_row(tree))
        self.assertEqual(reply, {'ok': False, 'code': 'EFFECT_UNCONFIRMED'})

    def test_fragmented_request_cannot_extend_the_fixed_read_deadline(self):
        server, client = socket.socketpair()
        self.addCleanup(server.close)
        self.addCleanup(client.close)
        def dribble():
            for _ in range(8):
                time.sleep(0.3)
                try:
                    client.sendall(b' ')
                except OSError:
                    return
        threading.Thread(target=dribble, daemon=True).start()
        began = time.monotonic()
        with self.assertRaises(A.Refused):
            H.read_request(server, time.monotonic() + H.TOTAL_SECONDS)
        self.assertLess(time.monotonic() - began, H.READ_SECONDS + 0.5)

    def test_malformed_request_and_second_request_are_refused(self):
        tree = Tree(self)
        self.assertEqual(self.serve(tree, raw=request(extra=1)), {'ok': False, 'code': 'REQUEST_INVALID'})
        self.assertEqual(self.serve(tree, raw=request() + request()), {'ok': False, 'code': 'REQUEST_INVALID'})
        self.assertEqual(tree.high(), 'max')


class BrokerClientTests(unittest.TestCase):
    def helper(self, reply):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = os.path.join(tmp.name, 'helper.sock')
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(path)
        listener.listen(1)
        self.addCleanup(listener.close)
        seen = []
        def run():
            conn, _ = listener.accept()
            with conn:
                seen.append(conn.recv(1024))
                conn.sendall(reply)
        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 5)
        return path, seen

    def test_broker_sends_identities_only_and_accepts_exact_success(self):
        path, seen = self.helper(b'{"ok":true,"memoryHighBytes":1073741824}\n')
        self.assertEqual(M.request_soft_limit(path, SID, CID, 1024 * MIB, timeout=5), 1024 * MIB)
        self.assertEqual(json.loads(seen[0]), {'v': 1, 'sessionId': SID, 'containerId': CID})

    def test_only_an_exact_framed_matching_reply_is_accepted(self):
        good = b'{"ok":true,"memoryHighBytes":1073741824}\n'
        self.assertEqual(A.parse_reply(good, 1024 * MIB), 1024 * MIB)
        unconfirmed = [b'{"ok":true,"memoryHighBytes":2147483648}\n', b'{"ok":1,"memoryHighBytes":1073741824}\n',
                       b'{"ok":true,"memoryHighBytes":true}\n', b'{"ok":true,"ok":true,"memoryHighBytes":1073741824}\n',
                       b'{"ok":true,"memoryHighBytes":1073741824,"x":1}\n', good[:-1], good + good, b'[]\n', b'null\n',
                       b' ' * 600 + good, b'{"ok":false,"code":"EFFECT_UNCONFIRMED"}\n', b'{"ok":false,"code":"bad code"}\n',
                       b'{"ok":false,"code":"KERNEL_UNQUALIFIED","x":1}\n', b'\xff\n']
        for raw in unconfirmed:
            with self.subTest(raw=raw[:50]), self.assertRaises(A.EffectUnconfirmed):
                A.parse_reply(raw, 1024 * MIB)
        with self.assertRaises(A.Refused) as caught:
            A.parse_reply(b'{"ok":false,"code":"KERNEL_UNQUALIFIED"}\n', 1024 * MIB)
        self.assertEqual(caught.exception.code, 'KERNEL_UNQUALIFIED')

    def test_refusal_odd_or_missing_reply_refuses_launch(self):
        for reply, code in [(b'{"ok":false,"code":"KERNEL_UNQUALIFIED"}\n', 'KERNEL_UNQUALIFIED'),
                            (b'{"ok":true}\n', 'EFFECT_UNCONFIRMED'), (b'not json\n', 'EFFECT_UNCONFIRMED'),
                            (b'{"ok":true,"memoryHighBytes":1}\n', 'EFFECT_UNCONFIRMED')]:
            path, _ = self.helper(reply)
            with self.subTest(reply=reply), self.assertRaises(M.SoftLimitHelperRefused) as caught:
                M.request_soft_limit(path, SID, CID, 1024 * MIB, timeout=5)
            self.assertEqual(caught.exception.code, code)
        with self.assertRaises(M.SoftLimitHelperRefused) as caught:
            M.request_soft_limit('/nonexistent/helper.sock', SID, CID, 1024 * MIB, timeout=1)
        self.assertEqual(caught.exception.code, 'HELPER_UNAVAILABLE')

    def test_fragmented_reply_cannot_extend_the_absolute_client_deadline(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = os.path.join(tmp.name, 'slow.sock')
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(path)
        listener.listen(1)
        self.addCleanup(listener.close)
        def run():
            conn, _ = listener.accept()
            with conn:
                conn.recv(1024)
                for byte in b'{"ok":true,"memoryHighBytes":1073741824}':
                    time.sleep(0.3)
                    try:
                        conn.sendall(bytes([byte]))
                    except OSError:
                        return
        threading.Thread(target=run, daemon=True).start()
        began = time.monotonic()
        with self.assertRaises(M.SoftLimitHelperRefused) as caught:
            M.request_soft_limit(path, SID, CID, 1024 * MIB, timeout=1)
        self.assertEqual(caught.exception.code, 'EFFECT_UNCONFIRMED')
        self.assertLess(time.monotonic() - began, 1.6)


if __name__ == '__main__':
    unittest.main()
