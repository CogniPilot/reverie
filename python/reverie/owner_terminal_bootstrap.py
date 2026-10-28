"""Candidate fixed startup helper. No CLI, authority data or configurable command.

A Nix-generated immutable entrypoint supplies literal node/argv at composition.
Call before application initialization; no broker/PTY/provider operation here.
"""
import os
import socket
import stat
import time

PATH = '/run/reverie-owner-terminal/bootstrap.sock'
SETUP_SECONDS = 120


def exec_backend(node, argv):
    # Only immutable installed code calls this; never derive these from HTTP,
    # request JSON, runtime metadata, env or user-selected shell commands.
    from pathlib import Path
    program = Path(node)
    if (not str(program).startswith('/nix/store/') or program.resolve(strict=True) != program
            or type(argv) is not tuple or not argv or argv[0] != node):
        raise ValueError('Fixed immutable backend required')
    info = program.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o222:
        raise ValueError('Fixed immutable backend required')
    # New fixed launcher must reject injection controls rather than forwarding
    # them into the Node startup window. Full engine Config remains host-pinned.
    if any(name in os.environ for name in ('NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_AUDIT', 'PYTHONPATH', 'PYTHONHOME')):
        raise ValueError('Backend startup injection controls refused')
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        deadline = time.monotonic() + SETUP_SECONDS
        def remaining():
            value = deadline - time.monotonic()
            if value <= 0:
                raise TimeoutError('Protected bootstrap setup expired')
            return value
        connection.settimeout(remaining())
        if os.get_inheritable(connection.fileno()):
            raise ValueError('Bootstrap descriptor custody unavailable')
        connection.connect(PATH)
        reply = bytearray()
        while len(reply) < 5:
            connection.settimeout(remaining())
            chunk = connection.recv(5 - len(reply))
            if not chunk:
                raise ValueError('Protected bootstrap unavailable')
            reply.extend(chunk)
        if bytes(reply) != b'EXEC\n':
            raise ValueError('Protected bootstrap refused')
        remaining()
        # CLOEXEC intentionally closes this connection. Node opens a fresh one.
        os.execv(node, argv)
