"""Qualify the actual Nix resource client against an inert, owned socket.

Set NIX_REVERIE_TEST_RESOURCE_CLIENT_MANIFEST and NIX_REVERIE_TEST_WORKER_EXEC to the
built Nix outputs. No production broker, container engine or owner data is used.
"""
import hashlib
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import tempfile
import time
import unittest
import uuid


MANIFEST = os.environ.get('NIX_REVERIE_TEST_RESOURCE_CLIENT_MANIFEST')
LAUNCHER = os.environ.get('NIX_REVERIE_TEST_WORKER_EXEC')


@unittest.skipUnless(MANIFEST and LAUNCHER, 'Requires the actual Nix client outputs')
class ResourceClientPackageTests(unittest.TestCase):
    def setUp(self):
        self.manifest = json.loads(Path(MANIFEST).read_text())
        self.prefix = self.manifest['argvPrefix']
        self.launcher = str(Path(LAUNCHER))
        self.temp = tempfile.TemporaryDirectory(prefix='rv-client-', dir='/tmp')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.poison = self.root / 'hostile'
        (self.poison / 'reverie').mkdir(parents=True)
        self.marker = self.root / 'ambient-imported'
        (self.poison / 'reverie/__init__.py').write_text(
            'from pathlib import Path\n'
            f'Path({str(self.marker)!r}).write_text("unexpected")\n'
            'raise RuntimeError("ambient package must not load")\n')
        self.socket_path = self.root / 'broker.sock'
        self.env = {
            'HOME': str(self.root), 'TMPDIR': str(self.root), 'PATH': '/unavailable',
            'PYTHONPATH': str(self.poison), 'PYTHONHOME': str(self.poison),
            'REVERIE_WORKER_SOCKET': str(self.socket_path),
        }

    def test_manifest_pins_real_immutable_interpreter_and_entry(self):
        value = self.manifest
        self.assertEqual(set(value), {
            'version', 'purpose', 'pythonInvocation', 'pythonExecutable',
            'entry', 'entrySHA256', 'argvPrefix',
        })
        self.assertEqual(value['version'], 1)
        self.assertEqual(value['purpose'], 'resource-replacement-client-v1')
        executable, entry = Path(value['pythonExecutable']), Path(value['entry'])
        for path in (executable, entry):
            self.assertEqual(path.resolve(strict=True), path)
            self.assertTrue(str(path).startswith('/nix/store/'))
            self.assertFalse(path.stat().st_mode & 0o222)
        self.assertEqual(Path(value['pythonInvocation']).resolve(strict=True), executable)
        with executable.open('rb') as stream:
            self.assertEqual(stream.read(4), b'\x7fELF')
        self.assertEqual(hashlib.sha256(entry.read_bytes()).hexdigest(), value['entrySHA256'])
        self.assertEqual(self.prefix, [value['pythonInvocation'], '-I', '-B', str(entry), 'client'])

    def test_standalone_help_ignores_ambient_cwd_and_python_settings(self):
        result = subprocess.run(self.prefix + ['--help'], cwd=self.poison, env=self.env,
                                capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertIn(b'--session-id', result.stdout)
        self.assertFalse(self.marker.exists())
        self.assertFalse(self.socket_path.exists())

    @staticmethod
    def receive(connection):
        def exact(count):
            value = bytearray()
            while len(value) < count:
                part = connection.recv(count - len(value))
                if not part:
                    raise EOFError('Qualification client ended before its frame')
                value.extend(part)
            return bytes(value)
        header = exact(5)
        length = struct.unpack('!I', header[1:])[0]
        if length > 65536:
            raise ValueError('Qualification frame bound exceeded')
        return header[:1], exact(length)

    def test_private_launcher_has_exact_actual_elf_argv_and_resource_frame(self):
        reference, sid = str(uuid.uuid4()), str(uuid.uuid4())
        command = 'resource-package-qualification-never-executed'
        arguments = ['--resource-ref', reference, '--session-id', sid,
                     '--cwd', str(self.root), '--command', command]
        with socket.socket(socket.AF_UNIX) as listener:
            listener.bind(str(self.socket_path))
            self.socket_path.chmod(0o600)
            listener.listen(1)
            listener.settimeout(0.1)
            child = subprocess.Popen([self.launcher, *arguments], cwd=self.poison,
                                     env=self.env, stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                deadline = time.monotonic() + 10
                while True:
                    try:
                        connection, _ = listener.accept()
                        break
                    except socket.timeout:
                        if child.poll() is not None:
                            _, stderr = child.communicate(timeout=2)
                            self.fail(f'Client exited {child.returncode} before connecting: '
                                      + stderr.decode(errors='replace')[-4096:])
                        if time.monotonic() >= deadline:
                            self.fail('Client did not connect to the owned qualification socket')
                with connection:
                    connection.settimeout(5)
                    pid, uid, gid = struct.unpack('3i', connection.getsockopt(
                        socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i')))
                    self.assertEqual((pid, uid, gid), (child.pid, os.getuid(), os.getgid()))
                    proc = Path('/proc') / str(pid)
                    self.assertEqual(str((proc / 'exe').resolve(strict=True)),
                                     self.manifest['pythonExecutable'])
                    actual = (proc / 'cmdline').read_bytes().split(b'\0')
                    self.assertEqual([value.decode() for value in actual if value],
                                     self.prefix + arguments)
                    kind, payload = self.receive(connection)
                    self.assertEqual(kind, b'L')
                    frame = json.loads(payload)
                    self.assertEqual(set(frame), {'reference', 'request'})
                    self.assertEqual(frame['reference'], reference)
                    request = frame['request']
                    self.assertEqual(set(request), {'sessionId', 'cwd', 'command', 'env', 'cols', 'rows'})
                    self.assertEqual({key: request[key] for key in ('sessionId', 'cwd', 'command', 'env')},
                                     {'sessionId': sid, 'cwd': str(self.root), 'command': command, 'env': {}})
                    for key in ('cols', 'rows'):
                        self.assertIs(type(request[key]), int)
                        self.assertTrue(1 <= request[key] <= 1000)
                    refusal = b'controlled packaging receiver refusal'
                    connection.sendall(b'E' + struct.pack('!I', len(refusal)) + refusal)
                _, stderr = child.communicate(timeout=10)
                self.assertNotEqual(child.returncode, 0)
                self.assertLess(len(stderr), 16384)
                self.assertFalse(self.marker.exists())
            finally:
                if child.poll() is None:
                    child.terminate()
                    try:
                        child.communicate(timeout=5)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.communicate(timeout=5)

    def test_malformed_private_requests_refuse_before_a_socket_connection(self):
        valid = str(uuid.uuid4())
        with socket.socket(socket.AF_UNIX) as listener:
            listener.bind(str(self.socket_path))
            self.socket_path.chmod(0o600)
            listener.listen(8)
            listener.settimeout(0.05)
            for arguments in (
                ['--resource-ref'],
                ['--resource-ref', 'not-a-uuid'],
                ['--resource-ref', valid, '--control', 'status'],
                ['--resource-ref', valid, '--goal-custody'],
                ['--resource-ref', valid, '--attach-only'],
            ):
                with self.subTest(arguments=arguments):
                    result = subprocess.run([self.launcher, *arguments], cwd=self.poison,
                                            env=self.env, capture_output=True, timeout=10)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertFalse(self.marker.exists())
                    with self.assertRaises(socket.timeout):
                        listener.accept()


if __name__ == '__main__':
    unittest.main()
