"""Fresh isolated file/package loader with an owned socket and fixed fake engine.

No Broker constructor, engine/service, account, worker CLI or instance is used.
"""
import importlib.util
import json
import os
from pathlib import Path
import runpy
import socket
import subprocess
import sys
import threading
from types import SimpleNamespace

path, mode, action, config = Path(sys.argv[1]), sys.argv[2], sys.argv[3], Path(sys.argv[4])
if mode == 'package':
    sys.path.insert(0, str(path.parents[1]))
    import reverie.worker as worker
elif mode == 'spec':
    spec = importlib.util.spec_from_file_location('worker_file_alias', path)
    worker = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = worker
    spec.loader.exec_module(worker)
else:
    worker = SimpleNamespace(**runpy.run_path(str(path), run_name='worker_file_fixture'))

broker = worker.Broker.__new__(worker.Broker)
broker.config = worker.load_config(config)
broker.config_file = str(config)
broker.lock = threading.RLock()
broker.laptops = {}
broker.stopping = worker.StopBudget()
broker.cleanup_uncertain = set()
broker.handlers = {}
broker.connections = threading.BoundedSemaphore(1)
calls = []

def engine(args, *, optional=False, deadline=None):
    assert args[:2] == ['inspect', '--format'] and len(args) == 4
    assert optional is True and deadline is not None
    calls.append(args[:2])
    return subprocess.CompletedProcess(args, 1, '', 'synthetic absent provider')

broker.run_engine = engine
registered = []
broker.host_resume = SimpleNamespace(register=lambda connection, peer: registered.append(peer[1]),
                                     accept_owner=lambda connection, peer: {'fixtureOwnerUID': peer[1]})
if mode == 'cli':
    endpoint = config.with_suffix('.sock')
    errors = []
    with socket.socket(socket.AF_UNIX) as listener:
        listener.bind(str(endpoint)); endpoint.chmod(0o600); listener.listen(1); listener.settimeout(3)
        def accept():
            try:
                connection, _ = listener.accept()
                assert broker.connections.acquire(blocking=False)
                broker.handle(connection)
            except Exception as error:
                errors.append(type(error).__name__)
        thread = threading.Thread(target=accept, daemon=True); thread.start()
        result = subprocess.run([sys.executable, '-I', '-B', str(path), 'client', '--control', action],
                                env={**os.environ, 'REVERIE_WORKER_SOCKET': str(endpoint)},
                                capture_output=True, text=True, timeout=5)
        thread.join(3)
        assert not thread.is_alive() and not errors
    endpoint.unlink()
    print(json.dumps({'kind': 'J' if result.returncode == 0 else 'E',
                      'body': json.loads(result.stdout) if result.returncode == 0 else result.stderr,
                      'engineCalls': calls, 'package': worker.__package__,
                      'actualClientReturncode': result.returncode}))
    raise SystemExit(0)
payload = {'action': action}
kind = b'C'
if action == 'register':
    kind, payload = b'Y', {'version': 1, 'purpose': 'host-worker-resume-v1', 'kind': 'register'}
elif action == 'provider-health-with-selector':
    payload = {'action': 'provider-health', 'sessionId': 'not-accepted'}
elif action == 'foreign-status':
    payload = {'action': 'status'}
    broker.config['uid'] += 1

server, client = socket.socketpair()
client.settimeout(3)
try:
    assert broker.connections.acquire(blocking=False)
    worker.send_frame(client, kind, json.dumps(payload).encode())
    broker.handle(server)
    if action == 'register':
        result = {'registered': registered, 'eof': client.recv(1) == b''}
    else:
        response, body = worker.receive_frame(client)
        result = {'kind': response.decode(), 'body': json.loads(body) if response == b'J' else body.decode()}
    print(json.dumps({**result, 'engineCalls': calls, 'package': worker.__package__}))
finally:
    client.close()
    server.close()
