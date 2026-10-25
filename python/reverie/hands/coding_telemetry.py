"""Optional SELF_REPORTED_RESULT relay from the actual Hands execution observer.

Broker OfficeAPI binds identity. Never read identity/env, raw output or errors.
"""
import json
import socket
import time

from command_catalog import ALIASES

PATH = '/api/command-telemetry/hands'
# This is the existing laptop office proxy published by worker.Broker.handle's
# REVERIE_API_URL assignment, not a new service or an env identity source.
OFFICE_RELAY = ('127.0.0.1', 8093)


class ExecutionRelay:
    def __init__(self, *, socket_factory=socket.socket, clock=time.monotonic):
        self.socket_factory, self.clock = socket_factory, clock
        self.dropped = 0

    def observe(self, executable, exit_code, execution_id):
        connection = None
        try:
            if type(exit_code) is not int or not -255 <= exit_code <= 255 or exit_code == 0:
                return False
            tool = ALIASES.get(executable, 'UNKNOWN_COMMAND') if isinstance(executable, str) and len(executable) <= 256 else 'UNKNOWN_COMMAND'
            body = json.dumps({'v': 1, 'execution_id': execution_id, 'tool': tool, 'exit_code': exit_code}, separators=(',', ':')).encode('ascii')
            packet = (b'POST ' + PATH.encode('ascii') + b' HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ' + str(len(body)).encode('ascii') + b'\r\n\r\n' + body)
            deadline = self.clock() + 0.05
            connection = self.socket_factory(socket.AF_INET, socket.SOCK_STREAM)
            def budget():
                remaining = deadline - self.clock()
                if remaining <= 0:
                    raise TimeoutError('TELEMETRY_TIMEOUT')
                connection.settimeout(remaining)
            # Numeric loopback with AF_INET avoids a DNS resolver. Recompute one
            # absolute budget before every socket operation; stages cannot each
            # restart a 50ms timer. Scheduling/kernel stalls remain a live gate.
            budget(); connection.connect(OFFICE_RELAY)
            budget(); connection.sendall(packet)
            response = b''
            while b'\r\n\r\n' not in response and len(response) < 1024:
                budget(); chunk = connection.recv(min(256, 1024-len(response)))
                if not chunk:
                    break
                response += chunk
            budget()
            if response.split(b'\r\n', 1)[0] not in (b'HTTP/1.0 204 No Content', b'HTTP/1.1 204 No Content'):
                raise ValueError('TELEMETRY_REFUSED')
            return True
        except Exception:
            self.dropped = min(2**31-1, self.dropped + 1)
            return False
        finally:
            if connection is not None:
                try:
                    connection.close()
                except Exception:
                    pass
