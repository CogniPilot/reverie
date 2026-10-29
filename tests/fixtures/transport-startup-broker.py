"""Public inert owned-socket fixture; never imports Broker or an engine client."""
import json
import os
from pathlib import Path
import socket
import sys

assert len(sys.argv) == 4 and sys.argv[1:3] == ['broker', '--config']
value = json.loads(Path(sys.argv[3]).read_bytes())
assert type(value) is dict and set(value) == {'socket'}
with socket.socket(socket.AF_UNIX) as listener:
    listener.bind(value['socket'])
    os.chmod(value['socket'], 0o600)
    listener.listen(2)
    print('TRANSPORT_STARTUP_READY', flush=True)
    with listener.accept()[0]:
        pass
    sys.stdin.buffer.read(1)
