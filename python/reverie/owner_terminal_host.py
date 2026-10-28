"""Opt-in ordinary-owner host H service; no worker J or shell-selection API.

Run only through the immutable optional launcher after explicit installation.
The single thread owns both authority-channel reads and every ledger/H call.
No background reader, automatic reconnect, retry or restoration of capabilities.
"""
import hashlib
import json
import os
from pathlib import Path
import select
import signal
import socket
import stat
import sys
import time

from .owner_terminal_channel import Handoff, need, read_proc, digest
from .owner_terminal_ledger_service import LedgerService
from .owner_terminal_native import Installation, ProtectedWebsitePeer, private_bytes
from .owner_terminal_pty import HumanTerminal


def exclusive(path, raw):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        with os.fdopen(fd, 'wb', closefd=False) as stream:
            stream.write(raw); stream.flush(); os.fsync(fd)
    finally:
        os.close(fd)
    parent = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        os.fsync(parent)
    finally:
        os.close(parent)


def publish(installation, available=True):
    root = installation.roots['bootstrapRoot']
    targets = {}
    if available:
        for employee in installation.value['entitlements']:
            # OFF/vacation/moving employees are unavailable, not authority to
            # stop a healthy unrelated terminal. Its own recheck still refuses.
            try:
                targets[employee] = installation.observe(employee)
            except ValueError:
                pass
    value = {'version': 1, 'available': available, 'atEpochMs': int(time.time() * 1000),
             'externalOrigin': installation.value['externalOrigin'],
             'ingressPeers': installation.value['ingressPeers'], 'targets': targets}
    raw = json.dumps(value, separators=(',', ':'), allow_nan=False).encode()
    need(len(raw) <= 131072, 'PROJECTION_BOUND')
    temporary = root / 'current.pending'
    exclusive(temporary, raw)
    temporary.replace(root / 'current.json')
    parent = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        os.fsync(parent)
    finally:
        os.close(parent)


def serve(policy_path):
    os.umask(0o077)
    path = Path(policy_path)
    expected = hashlib.sha256(private_bytes(path)[0]).hexdigest()
    installation = Installation(path, expected)
    process = read_proc(os.getpid())
    # This file is the durable, exclusive process-start attempt. A crash,
    # changed website or incomplete handoff requires explicit new installation
    # namespace/owner review, not systemd Restart=always or a socket reconnect.
    exclusive(installation.roots['controlRoot'] / 'START-ATTEMPT.json',
              json.dumps({'policySHA256': expected, 'pid': os.getpid(), 'at': time.time()}).encode())
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM | socket.SOCK_CLOEXEC)
    filename = installation.roots['bootstrapRoot'] / 'bootstrap.sock'
    need(not os.path.lexists(filename), 'PRIOR_BOOTSTRAP_NO_REPLAY')
    listener.bind(str(filename)); os.chmod(filename, 0o600); listener.listen(2); listener.settimeout(120)
    initial_socket = filename.lstat()
    handoff = service = terminal = bootstrap = None
    stop = [False]
    def stopping(_number, _frame):
        stop[0] = True
    previous = {sig: signal.signal(sig, stopping) for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)}
    try:
        bootstrap = listener.accept()[0]
        runtime = installation.bind_website_once()
        exclusive(installation.roots['controlRoot'] / 'WEBSITE-BINDING.json',
                  json.dumps({'containerId': runtime['containerId'], 'initPid': runtime['initPid'],
                              'initStart': runtime['initStart'], 'policySHA256': expected}).encode())
        peer = ProtectedWebsitePeer(installation)
        handoff = Handoff(peer, timeout=120)
        handoff.bootstrap(bootstrap)
        handoff.accept_node(listener.accept()[0], acknowledge=False)
        # Retire the only listener by exact owned inode, never a path guessed
        # after an error or a shared socket from a different operation.
        listener.close()
        current = filename.lstat()
        need(stat.S_ISSOCK(current.st_mode) and (current.st_dev, current.st_ino) ==
             (initial_socket.st_dev, initial_socket.st_ino), 'BOOTSTRAP_SOCKET_REBOUND')
        filename.unlink()
        terminal = HumanTerminal(installation, installation.value['engineProgram'], handoff)
        service = LedgerService(handoff, installation.roots['ledgerRoot'], native_target=installation,
                                consumer_verifier=terminal, terminal=terminal)
        publish(installation)
        # Publish projection/native services before READY, but do not attest
        # connection success until the final protected peer check and send
        # have completed. A parked Node is not an acknowledged application.
        handoff.acknowledge_node()
        exclusive(installation.roots['controlRoot'] / 'HOST-CONNECTED.json',
                  json.dumps({'schema':'reverie-owner-terminal-connected-v1','policySHA256':expected,
                    'process':process,'websiteBindingDigest':digest(runtime),
                    'nodeProcess':read_proc(handoff.credentials[0])}).encode())
        # The first projection/native service is ready BEFORE the Node wrapper
        # is released to import application code and read that projection.
        while not stop[0]:
            if select.select([handoff.node, handoff.pidfd], [], [], 0.25)[0]:
                need(not select.select([handoff.pidfd], [], [], 0)[0], 'WEBSITE_ENDED')
                service.serve_once()
            publish(installation)
    finally:
        original_error = sys.exception()
        # Shutdown blocks new authorities before attempting physical cleanup.
        # Unknown shell intents and private ledger records are retained.
        try:
            publish(installation, False)
        except BaseException:
            pass
        settled = True
        if service is not None:
            settled = service.close()
        elif terminal is not None:
            settled = terminal.close()
        if handoff is not None:
            handoff.close()
        listener.close()
        if bootstrap is not None:
            bootstrap.close()
        installation.close()
        for sig, handler in previous.items():
            signal.signal(sig, handler)
        if not settled:
            original = sys.exception()
            if original is None:
                raise RuntimeError('H_PHYSICAL_CLEANUP_UNKNOWN_RETAIN_PRIVATE_LEDGER')
            original.add_note('H_PHYSICAL_CLEANUP_UNKNOWN_RETAIN_PRIVATE_LEDGER')
        elif original_error is None or str(original_error) in ('INSTALLATION_BYTES_CHANGED','WORKER_POLICY_CHANGED'):
            # This is canonical history, not authority. The lifecycle helper
            # independently proves current unit/cgroup/PID and guest absence.
            exclusive(installation.roots['controlRoot'] / 'HOST-DRAINED.json',
                      json.dumps({'schema':'reverie-owner-terminal-drained-v1','policySHA256':expected,
                        'process':process,'websiteBindingDigest':digest(installation.runtime_website),
                        'shutdown':'REQUESTED' if original_error is None else 'POLICY_INVALIDATED',
                        'settlements':terminal.settlements if terminal is not None else {}}).encode())
