"""Actual owned Nix Python/ELF/argv, never a host service or website entry."""
import hashlib
import os
from pathlib import Path
import selectors
import shutil
import subprocess
import unittest
from unittest.mock import patch

from reverie import owner_terminal_native as N
from reverie import owner_terminal_channel as C


PROBE = "import sys;print('H_ABI_READY',flush=True);sys.stdin.buffer.read(1)"


class PythonABI(unittest.TestCase):
    def setUp(self):
        self.invocation = Path(shutil.which('python3'))
        self.bare = Path('/proc/self/exe').resolve(strict=True)
        self.children = []
        self.addCleanup(self.settle)
        # Only the two fixed immutable Python inputs have Nix's unmapped store
        # owner modeled. Process/private-file metadata and every other input stay real.
        self.selected = {self.invocation.resolve(strict=True), self.bare}
        if os.environ.get('NIX_BUILD_TOP') and Path('/').stat().st_uid == Path('/nix/store').stat().st_uid == 65534:
            from types import SimpleNamespace
            original = Path.stat
            def mapped(path, *args, **kwargs):
                value = original(path, *args, **kwargs)
                if path in self.selected and value.st_uid == 65534:
                    return SimpleNamespace(**{**{k:getattr(value,k) for k in dir(value) if k.startswith('st_')}, 'st_uid':0})
                return value
            self.enterContext(patch.object(Path, 'stat', mapped))

    def settle(self):
        for child in self.children:
            if child.poll() is None: child.kill()
            child.wait(timeout=3)
            for stream in (child.stdin, child.stdout, child.stderr):
                if stream is not None and not stream.closed: stream.close()

    def child(self, flags=('-I','-B')):
        argv = [str(self.invocation), *flags, '-c', PROBE]
        child = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 env={'LANG':'C.UTF-8'})
        self.children.append(child)
        with selectors.DefaultSelector() as ready:
            ready.register(child.stdout, selectors.EVENT_READ)
            self.assertTrue(ready.select(3), 'Owned inert Python READY required')
            self.assertEqual(child.stdout.readline(), b'H_ABI_READY\n')
        self.assertIsNone(child.poll())
        return child, tuple(argv)

    def test_declared_environment_qualifies_actual_bare_interpreter(self):
        N.qualify_python(str(self.invocation), str(self.bare))
        child, argv = self.child()
        C.Program(str(self.bare), argv).matches(C.read_proc(child.pid))

    def test_original_resolved_wrapper_is_not_the_kernel_executable(self):
        self.assertNotEqual(self.invocation.resolve(strict=True), self.bare,
                            'This control requires the declared flake withPackages environment')
        child, argv = self.child()
        with self.assertRaisesRegex(ValueError, 'PROGRAM_CHANGED'):
            C.Program(str(self.invocation.resolve(strict=True)), argv).matches(C.read_proc(child.pid))
        C.Program(str(self.bare), argv).matches(C.read_proc(child.pid))

    def test_wrong_expected_interpreter_refuses_after_real_probe(self):
        # Another genuine immutable Python input is neither written nor executed.
        with self.assertRaisesRegex(ValueError, 'H_PYTHON_INTERPRETER_CHANGED'):
            N.qualify_python(str(self.bare), str(self.invocation.resolve(strict=True)))

    def test_unlisted_writable_source_is_not_immutable_interpreter_authority(self):
        with self.assertRaisesRegex(ValueError, 'IMMUTABLE_H_PROGRAM_REQUIRED'):
            N.qualify_python(str(self.invocation), str(Path(__file__).resolve()))

    def test_extra_or_reordered_actual_flags_cannot_match_fixed_program(self):
        child, actual = self.child(('-B','-I'))
        expected = (str(self.invocation), '-I', '-B', '-c', PROBE)
        with self.assertRaisesRegex(ValueError, 'PROGRAM_CHANGED'):
            C.Program(str(self.bare), expected).matches(C.read_proc(child.pid))
        self.assertEqual(C.read_proc(child.pid)['argv'], hashlib.sha256(b'\0'.join(v.encode() for v in actual)+b'\0').hexdigest())
