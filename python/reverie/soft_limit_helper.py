"""Per-connection root helper: apply one laptop's owner-authorized memory.high.

Started by an Accept=yes socket with the connection on stdin/stdout. All authority comes from
root-owned pins (argv set by the unit) and the root policy file; the request names only a session
and container. One request per connection, then exit.
"""
import argparse
import json
import os
from pathlib import Path
import select
import socket
import struct
import subprocess
import sys
import time

from reverie import worker_memory_authority as A

READ_SECONDS = 1.0
INSPECT_SECONDS = 3.0
TOTAL_SECONDS = 8.0
INSPECT_FORMAT = ('{"Id":{{json .Id}},"Name":{{json .Name}},"Config":{"Labels":{{json .Config.Labels}}},'
                  '"State":{"Running":{{json .State.Running}},"Pid":{{json .State.Pid}}},'
                  '"Mounts":{{json .Mounts}},"HostConfig":{"Memory":{{json .HostConfig.Memory}}}}')


def peer_uid(conn):
    raw = conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i'))
    return struct.unpack('3i', raw)[1]


def read_request(conn, deadline):
    data = b''
    while not data.endswith(b'\n'):
        remaining = min(deadline, time.monotonic() + READ_SECONDS) - time.monotonic()
        A.need(remaining > 0 and select.select([conn], [], [], remaining)[0], 'REQUEST_INVALID')
        chunk = conn.recv(A.REQUEST_MAX + 1 - len(data))
        A.need(chunk and len(data) + len(chunk) <= A.REQUEST_MAX, 'REQUEST_INVALID')
        data += chunk
    return data


def inspect(engine, endpoint, name, deadline):
    timeout = min(INSPECT_SECONDS, deadline - time.monotonic())
    A.need(timeout > 0, 'DEADLINE')
    try:
        result = subprocess.run([engine, 'inspect', '--format', INSPECT_FORMAT, name],
                                env={'DOCKER_HOST': endpoint, 'PATH': '/var/empty', 'HOME': '/var/empty',
                                     'DOCKER_CONFIG': '/var/empty', 'LC_ALL': 'C'},
                                capture_output=True, timeout=timeout, check=False, stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        raise A.Refused('DEADLINE') from None
    A.need(result.returncode == 0 and len(result.stdout) <= 65536, 'IDENTITY_MISMATCH')
    try:
        row = json.loads(result.stdout)
    except ValueError:
        raise A.Refused('IDENTITY_MISMATCH') from None
    A.need(isinstance(row, dict), 'IDENTITY_MISMATCH')
    return row


def serve(conn, pins, *, cgroup=Path('/sys/fs/cgroup'), proc=Path('/proc'), inspector=inspect, host_root=A.check_host_root):
    deadline = time.monotonic() + TOTAL_SECONDS
    try:
        A.need(peer_uid(conn) == pins.broker_uid, 'PEER_REFUSED')
        session_id, container_id = A.parse_request(read_request(conn, deadline))
        policy = A.load_policy(pins.policy)
        A.need(policy['deployment'] == pins.deployment and policy['stateRoot'] == pins.state_root, 'POLICY_INVALID')
        A.check_kernel(policy, proc)
        host_root(proc, cgroup)
        name = f'{pins.deployment}-agent-{session_id}'
        row = inspector(pins.engine, pins.endpoint, name, deadline)
        entry = A.select_entry(policy, row, session_id, container_id)

        def still_same():
            again = inspector(pins.engine, pins.endpoint, name, deadline)
            return A.select_entry(policy, again, session_id, container_id) == entry and again['State'] == row['State']

        applied = A.apply_high(entry, row['State']['Pid'], cgroup, proc, still_same)
        reply = {'ok': True, 'memoryHighBytes': applied}
    except (A.Refused, A.EffectUnconfirmed) as error:
        reply = {'ok': False, 'code': error.code}
    except Exception:  # Unknown failures stay unconfirmed: a write may already have happened.
        reply = {'ok': False, 'code': 'EFFECT_UNCONFIRMED'}
    try:
        conn.sendall((json.dumps(reply, separators=(',', ':')) + '\n').encode())
    except OSError:
        pass
    return reply


def main(argv=None):
    parser = argparse.ArgumentParser(prog='reverie-soft-limit-helper')
    for flag in ('--broker-uid', '--deployment', '--engine', '--endpoint', '--policy', '--state-root'):
        parser.add_argument(flag, required=True)
    pins = parser.parse_args(argv)
    pins.broker_uid = int(pins.broker_uid)
    conn = socket.socket(fileno=os.dup(0))
    try:
        serve(conn, pins)
    finally:
        conn.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
