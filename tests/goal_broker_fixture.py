"""Synthetic actual OfficeAPI handler, with supervisor/socket/upstream fully mocked.

JSON stdin/stdout is only a local test bridge, never an installed command or key
reader. Inputs and signing material are synthetic test values. Explicit --component-proof
exercises only the proof component; it is NOT an available Broker.office adapter.
"""
import tests  # noqa: F401
import io
import json
from email.message import Message
from pathlib import Path
import tempfile
from unittest.mock import MagicMock, patch

from reverie.worker import OfficeAPI
from reverie.goal_assertion import GoalRequestSigner, goal_forward_headers

SID = '11111111-2222-3333-4444-555555555555'
TEST_KEY = b'not-a-deployment-key-synthetic-01!'


def forward(request):
    """Exercise real nested Handler.request without any socket, host file or thread."""
    captured = {}
    # Local synthetic test bridge only: this is the fixed office connection, not a forwarded identity header.
    session_id = request.get('sessionId', SID)
    raw = request.get('body', '{}').encode()
    headers = Message()
    headers['Content-Length'] = str(len(raw))
    headers['Content-Type'] = 'application/json'
    for key, value in request.get('headers', {}).items():
        headers[key] = value

    def server(instance, _path, handler):
        Path(_path).touch(mode=0o600)
        instance.socket = MagicMock()
        captured['handler'] = handler

    upstream = MagicMock()
    response = upstream.getresponse.return_value
    response.status = 200
    response.getheaders.return_value = []
    response.read1.return_value = b''
    with tempfile.TemporaryDirectory(prefix='goal-broker-fixture-') as temporary:
        with patch('reverie.worker.socketserver.UnixStreamServer.__init__', lambda self, path, handler: server(self, path, handler)), \
             patch('reverie.worker.threading.Thread'), patch('pathlib.Path.chmod'), \
             patch('pathlib.Path.read_text', return_value='REVERIE_PASSWORD=synthetic-unused-basic') as read, \
             patch('reverie.worker.http.client.HTTPConnection', return_value=upstream):
            # Avoid inheriting real server shutdown state from the mocked constructor.
            OfficeAPI(Path(temporary)/'office', session_id, 'not-contacted.invalid', Path(temporary))
            handler = captured['handler'].__new__(captured['handler'])
            handler.connection = MagicMock()
            handler.command, handler.path = request.get('method', 'POST'), request.get('target', '/api/goals')
            handler.headers, handler.rfile, handler.wfile = headers, io.BytesIO(raw), io.BytesIO()
            handler.send_error, handler.send_response = MagicMock(), MagicMock()
            handler.send_header, handler.end_headers = MagicMock(), MagicMock()
            handler.request()
            if handler.send_error.called:
                return {'refused': handler.send_error.call_args.args[0], 'upstream': upstream.request.called, 'environmentReads': read.call_count}
            method, target = upstream.request.call_args.args
            kwargs = upstream.request.call_args.kwargs
            return {'method': method, 'target': target, 'body': kwargs['body'].decode(), 'headers': kwargs['headers']}


def component_proof(request):
    sid = request.get('sessionId', SID)
    method, target, body = request.get('method', 'POST'), request.get('target', '/api/goals'), request.get('body', '{}')
    raw = body.encode()
    signer = None if request.get('unavailable') else GoalRequestSigner(
        key=TEST_KEY, issuer=request.get('issuer', 'test-broker'), epoch=request.get('epoch', 'test-epoch'),
        binding=lambda session: request.get('generation', 7) if session == sid else None,
        now=lambda: request.get('now', 100_000), nonce=lambda: request.get('nonce', 'a'*32)).bind(sid)
    # Fixed synthetic transport context, not production OfficeAPI normalization.
    headers = {key: value for key, value in request.get('headers', {}).items()
               if key.lower() not in ('cookie', 'authorization', 'x-reverie-parent-session', 'x-reverie-service-token')}
    headers.update({'X-Reverie-Parent-Session': sid, 'Authorization': 'Basic c3ludGhldGlj',
                    'Content-Type': 'application/json'})
    try:
        headers = goal_forward_headers(sid, method, target, raw, headers, signer)
    except ValueError:
        return {'refused': 403, 'upstream': False, 'environmentReads': 0}
    return {'method': method, 'target': target, 'body': body, 'headers': headers}


if __name__ == '__main__':
    import sys
    if sys.argv[1:] == ['--component-proof']:
        result = component_proof(json.load(sys.stdin))
    elif not sys.argv[1:]:
        result = forward(json.load(sys.stdin))
    else:
        raise ValueError('Unknown offline fixture mode')
    print(json.dumps(result, sort_keys=True))
