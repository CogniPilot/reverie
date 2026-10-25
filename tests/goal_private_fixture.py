"""Owned offline bridge through current restricted Broker protocol/office.

Engine inspection, kernel peer lookup, network/listener edges are fixture
substitutes. Private paths, config, canonical identity, G framing and custody use
production implementations. Current OfficeAPI never signs employee Goal calls.
SyntheticTrustedProgramObserver below is ONLY for standalone bootstrap-component
unit tests; installing it cannot change current Broker.office behavior.
This file is not packaged as an entry point.
"""
import io
import json
import os
from pathlib import Path
import struct
import sys
import socket
from email.message import Message
from unittest.mock import MagicMock, patch

from reverie.goal_private import private_json
from reverie.worker import Broker


class SyntheticTrustedProgramObserver:
    """EXPLICIT missing-host-edge substitute, never a production attestation.
    The actual Broker has no observer and cannot sign for ordinary legacy workers.
    This fixture binds an exact synthetic launch tuple, not an always-true grant.
    """
    def __init__(self, session_id, pin, metadata):
        self.session_id, self.pin, self.metadata = session_id, pin, metadata
        self.completed = False

    def assert_current(self, session_id, pin, metadata):
        if self.completed or (session_id, pin, metadata) != (self.session_id, self.pin, self.metadata):
            raise ValueError('Synthetic original program no longer current')


def install_synthetic_program_observer(broker, session_id):
    metadata = private_json(str(Path(broker.config['stateRoot']) / session_id / 'runtime.json'))[0]
    observer = SyntheticTrustedProgramObserver(session_id, metadata.get('goalBinding'), metadata)
    broker.goals._program_observer = observer
    return observer


def run(request, broker=None):
    root = Path(request['root'])
    config = private_json(str(root / 'worker.json'))[0]
    broker = broker or Broker(config, config_file=str(root / 'worker.json'))
    def engine(args):
        inventory = json.loads((root / 'inventory.json').read_text())
        ids = [item['Id'] for item in inventory]
        if args == ['ps', '--all', '--no-trunc', '--quiet']:
            return '\n'.join(ids)
        if args == ['inspect', *ids]:
            return json.dumps(inventory)
        raise AssertionError('Fixture never authorizes engine commands')
    with patch.object(broker.goals, '_engine', side_effect=engine):
        if request['operation'] == 'project':
            payload = b'{"action":"goal-custody"}'
            connection = MagicMock()
            connection.getsockopt.return_value = struct.pack('3i', request['peerPid'], os.getuid(), os.getgid())
            chunks = io.BytesIO(b'G' + struct.pack('!I', len(payload)) + payload)
            connection.recv.side_effect = chunks.read
            output = bytearray()
            connection.sendall.side_effect = output.extend
            broker.connections.acquire()
            broker.handle(connection)
            if output[:1] != b'J':
                raise ValueError('Actual broker protocol refused private projection')
            return json.loads(output[5:])
        if request['operation'] != 'forward':
            raise ValueError('Unknown fixture operation')
        # Current restricted Broker.office never installs an employee signer.
        # Synthetic program observers used by component tests cannot change that.
        captured = {}
        def server(instance, _path, handler):
            instance.socket = MagicMock()
            captured['handler'] = handler
            # Stand-in inode for the mocked listener constructor, never a socket.
            Path(_path).touch(mode=0o600)
        raw = request.get('body', '').encode()
        headers = Message()
        headers['Content-Length'] = str(len(raw))
        headers['Content-Type'] = 'application/json'
        upstream = MagicMock()
        upstream.getresponse.return_value.status = 200
        upstream.getresponse.return_value.getheaders.return_value = []
        upstream.getresponse.return_value.read1.return_value = b''
        with patch('reverie.worker.socketserver.UnixStreamServer.__init__', lambda self, path, handler: server(self, path, handler)), \
             patch('reverie.worker.threading.Thread'), \
             patch.object(broker, 'address', return_value='not-contacted.invalid'), \
             patch('reverie.worker.http.client.HTTPConnection', return_value=upstream):
            broker.office(request['sessionId'])
            handler = captured['handler'].__new__(captured['handler'])
            handler.connection = MagicMock()
            handler.command, handler.path = request['method'], request['target']
            handler.headers, handler.rfile, handler.wfile = headers, io.BytesIO(raw), io.BytesIO()
            handler.send_error, handler.send_response = MagicMock(), MagicMock()
            handler.send_header, handler.end_headers = MagicMock(), MagicMock()
            handler.request()
            (Path(config['apiSocketRoot']) / request['sessionId'] / 'office.sock').unlink(missing_ok=True)
            if handler.send_error.called:
                return {'refused': handler.send_error.call_args.args[0], 'upstream': upstream.request.called}
            method, target = upstream.request.call_args.args
            kwargs = upstream.request.call_args.kwargs
            return {'method': method, 'target': target, 'body': kwargs['body'].decode(), 'headers': kwargs['headers']}


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--owned-socket':
        root = Path(sys.argv[2])
        config = private_json(str(root / 'worker.json'))[0]
        broker = Broker(config, config_file=str(root / 'worker.json'))
        def engine(args):
            inventory = json.loads((root / 'inventory.json').read_text())
            ids = [item['Id'] for item in inventory]
            if args == ['ps', '--all', '--no-trunc', '--quiet']: return '\n'.join(ids)
            if args == ['inspect', *ids]: return json.dumps(inventory)
            raise AssertionError('No engine command in owned custody fixture')
        broker.goals._engine = engine
        endpoint = Path(config['socket'])
        try:
            with socket.socket(socket.AF_UNIX) as listener:
                listener.bind(str(endpoint)); endpoint.chmod(0o600); listener.listen(8)
                print('READY', flush=True)
                while True:
                    connection, _ = listener.accept()
                    connection.settimeout(2)
                    # This test listener only admits G; no power/launch/proxy API.
                    try: kind = connection.recv(1, socket.MSG_PEEK)
                    except socket.timeout: connection.close(); continue
                    if kind != b'G':
                        connection.close(); continue
                    broker.connections.acquire()
                    broker.handle(connection)  # actual SO_PEERCRED and framed operation
        finally:
            endpoint.unlink(missing_ok=True)
    elif sys.argv[1:] == ['--persistent']:
        broker = None
        for line in sys.stdin:
            try:
                request = json.loads(line)
                if request['operation'] != 'project':
                    raise ValueError('Persistent fixture only projects closed custody')
                if broker is None:
                    root = Path(request['root'])
                    broker = Broker(private_json(str(root / 'worker.json'))[0], config_file=str(root / 'worker.json'))
                result = run(request, broker)
            except Exception:
                result = {'fixtureError': 'Closed custody projection refused'}
            print(json.dumps(result, sort_keys=True), flush=True)
    else:
        print(json.dumps(run(json.load(sys.stdin)), sort_keys=True))
