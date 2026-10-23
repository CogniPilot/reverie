"""Exercise real worker terminals, reaping and kernel limits using synthetic data.

Run in nix develop with --image IMMUTABLE_IMAGE_ID. Add --pool-config to verify
the activated NixOS parent slice too. No personal mounts or provider calls.
"""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request
import uuid

from reverie import worker


def engine(*args):
    result = subprocess.run(['docker', *args], capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise RuntimeError('Synthetic worker engine operation failed: ' + args[0])
    return result.stdout.strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True)
    parser.add_argument('--pool-config')
    args = parser.parse_args()
    image = engine('image', 'inspect', args.image, '--format', '{{.Id}}')
    deployment = 'stability-test-' + uuid.uuid4().hex[:8]
    server_name = deployment + '-server'
    sockets = []
    threads = []
    original_create = worker.create_args
    scratch = (Path.home()/'scratch/reverie/tmp').resolve()
    scratch.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='w-', dir=scratch) as temporary:
        root = Path(temporary)
        (root/'workspace').mkdir()
        (root/'company.json').write_text('{"employees": []}')
        (root/'company/console').mkdir(parents=True)
        (root/'company/console/.env').write_text('REVERIE_USERNAME=synthetic\nREVERIE_PASSWORD=synthetic\n')
        (root/'company/console/hook-secret').write_text('synthetic')
        config = dict(version=1, deployment=deployment, image=image, serverContainer=server_name,
            socket=str(root/'broker.sock'), stateRoot=str(root/'workers'), companyFile=str(root/'company.json'),
            companyRoot=str(root/'company'), scratchRoot=str(root/'scratch'), apiSocketRoot=str(root/'office'), budgetMode='pool' if args.pool_config else 'admission',
            uid=os.getuid(), gid=os.getgid(), memoryMiB=512, poolMemoryMiB=4096, poolTasksMax=1024,
            cgroupParent='reverie-workers.slice', pidsLimit=64, cpus=0, maxWorkers=4, maintenanceSessions=[],
            mounts=[dict(source=str(root/'workspace'), destination='/workspace', readOnly=False)])
        if args.pool_config:
            owner = worker.load_config(args.pool_config)
            for key in ['poolMemoryMiB', 'poolTasksMax']:
                config[key] = owner[key]
        broker = worker.Broker(config)

        def launch(sid, command):
            connection, peer = socket.socketpair()
            connection.settimeout(20)
            broker.connections.acquire()
            thread = threading.Thread(target=broker.handle, args=(peer,))
            thread.start()
            sockets.append(connection); threads.append(thread)
            request = dict(sessionId=sid, cwd='/workspace', command=command, env={'TERM': 'xterm-256color'}, cols=80, rows=24)
            worker.send_frame(connection, b'J', json.dumps(request).encode())
            return connection, thread

        def until(connection, marker=None):
            output = b''
            while True:
                kind, data = worker.receive_frame(connection)
                if kind == b'O':
                    output += data
                    if marker and marker in output:
                        return output
                elif kind == b'X':
                    if marker:
                        raise AssertionError('Worker exited before the expected terminal output')
                    return json.loads(data), output
                elif kind == b'E':
                    raise AssertionError(data.decode())

        def healthy():
            address = json.loads(engine('inspect', server_name))[0]['NetworkSettings']['Networks']['bridge']['IPAddress']
            assert urllib.request.urlopen('http://' + address + ':3000', timeout=3).status == 200

        try:
            engine('run', '--detach', '--init', '--name', server_name, '--label', 'reverie.smoke='+deployment,
                '--memory', '128m', '--pids-limit', '64', '--entrypoint', '/bin/python3', image, '-m', 'http.server', '3000')
            deadline = time.monotonic()+10
            while True:
                try:
                    healthy(); break
                except OSError:
                    if time.monotonic() > deadline: raise
                    time.sleep(0.1)
            sid1, sid2, sid3 = [str(uuid.uuid4()) for _ in range(3)]
            connection, thread = launch(sid1, "printf TERMINAL_READY; stty size; read -r value; printf 'INPUT=%s\\n' \"$value\"; stty size; printf shared > /workspace/proof; printf durable > /home/agent/proof")
            output = until(connection, b'24 80')
            worker.send_frame(connection, b'R', json.dumps([100, 35]).encode())
            time.sleep(0.2)
            worker.send_frame(connection, b'I', b'hello-worker\n')
            code, output = until(connection)
            assert code == 0 and b'INPUT=hello-worker' in output and b'35 100' in output, (code, output)
            thread.join(10); assert not thread.is_alive()
            connection, thread = launch(sid2, 'cat /workspace/proof; test ! -e /home/agent/proof')
            code, output = until(connection); assert code == 0 and b'shared' in output
            thread.join(10)
            connection, thread = launch(sid1, 'cat /home/agent/proof; (sleep 0.1 &) ; sleep 0.4; test "$(ps -eo stat | awk \'/^Z/ {n++} END {print n+0}\')" = 0; printf REAPED')
            code, output = until(connection); assert code == 0 and b'durable' in output and b'REAPED' in output
            thread.join(10)
            connection, thread = launch(sid2, "curl --retry 10 --retry-connrefused --retry-delay 1 --silent --output /dev/null --write-out '%{http_code}' http://127.0.0.1:8093/api/company; test ! -e /instances/default/console/.env; test ! -e /var/run/docker.sock; test ! -e /run/reverie-workers/broker.sock")
            code, output = until(connection); assert code == 0 and b'404' in output, (code, output)
            thread.join(10)
            print('PASS office API connection without console credentials, broker or engine mounts', flush=True)
            connection, thread = launch(sid2, "printf 'UTF8_PROOF=─│┌┐😀\\n'; read -r done")
            until(connection, 'UTF8_PROOF=─│┌┐😀'.encode())
            clients = engine('exec', deployment+'-agent-'+sid2, 'tmux', '-L', 'reverie-laptop', 'list-clients', '-F', '#{client_utf8}')
            assert clients == '1', clients
            worker.send_frame(connection, b'I', b'finished\n')
            code, _ = until(connection); assert code == 0
            thread.join(10)
            print('PASS Unicode borders, non-ASCII text and UTF-8 terminal attach', flush=True)
            print('PASS terminal input, output, resize, shared project files, private homes, persistence and orphan reaping', flush=True)

            full = "import threading,time,sys\ntry:\n for _ in range(200): threading.Thread(target=lambda:time.sleep(30),daemon=True).start()\nexcept RuntimeError:\n print('TASK_LIMIT_REACHED',flush=True)\nsys.stdin.readline()"
            connection, thread = launch(sid1, 'python3 -c ' + "'" + full.replace("'", "'\\''") + "'")
            until(connection, b'TASK_LIMIT_REACHED')
            healthy()
            other, other_thread = launch(sid2, 'printf OTHER_AGENT_HEALTHY')
            code, output = until(other); assert code == 0 and b'OTHER_AGENT_HEALTHY' in output
            other_thread.join(10)
            worker.send_frame(connection, b'I', b'\n')
            code, _ = until(connection); assert code == 0
            thread.join(10)
            print('PASS exhausted worker task limit while another agent and the server remained responsive', flush=True)

            connection, thread = launch(sid3, "python3 -c 'a=[bytearray(32*1024*1024) for _ in range(24)]'")
            code, _ = until(connection)
            assert code == 137, code
            thread.join(10)
            healthy()
            other, other_thread = launch(sid2, 'printf SURVIVED_WORKER_OOM')
            code, output = until(other); assert code == 0 and b'SURVIVED_WORKER_OOM' in output
            other_thread.join(10)
            print('PASS worker OOM while another agent and the server remained responsive', flush=True)

            connection, thread = launch(sid1, "printf PERSISTENT_READY; (while :; do date +%s%N > /workspace/ticking; sleep 0.2; done) & read -r done; printf RESUMED_SAME_LAPTOP")
            until(connection, b'PERSISTENT_READY')
            connection.close()
            thread.join(12); assert not thread.is_alive()
            name = deployment+'-agent-'+sid1
            assert json.loads(engine('inspect', name))[0]['State']['Running'] is True
            engine('stop', '--time', '1', server_name)
            before = (root/'workspace/ticking').read_text()
            time.sleep(1)
            assert (root/'workspace/ticking').read_text() != before
            engine('start', server_name)
            connection, thread = launch(sid1, 'printf WRONG_RESTART')
            until(connection, b'PERSISTENT_READY')
            clients = engine('exec', name, 'tmux', '-L', 'reverie-laptop', 'list-clients', '-F', '#{client_utf8}')
            assert clients == '1', ('Reconnect must replace stale terminal viewers', clients)
            worker.send_frame(connection, b'I', b'finish\n')
            code, output = until(connection)
            assert code == 0 and b'RESUMED_SAME_LAPTOP' in output and b'WRONG_RESTART' not in output, (code, output)
            thread.join(10)
            print('PASS laptop continued working with the website stopped and reattached without restarting its program', flush=True)

            connection, thread = launch(sid1, 'printf WATCHDOG_READY; sleep 60')
            until(connection, b'WATCHDOG_READY')
            connection.close(); thread.join(12)
            engine('stop', '--time', '1', server_name)
            worker.OFFLINE_GRACE_SECONDS = 3  # Test clock only; production remains ten minutes.
            supervisor = threading.Thread(target=broker.supervise, daemon=True)
            supervisor.start()
            deadline = time.monotonic()+12
            while json.loads(engine('inspect', name))[0]['State']['Running']:
                if time.monotonic() > deadline: raise AssertionError('Offline watchdog did not stop the laptop')
                time.sleep(.2)
            broker.stopping.set(); supervisor.join(5)
            engine('start', server_name)
            print('PASS host watchdog stopped detached laptops after the offline grace period', flush=True)
            broker.stopping.clear()
            connection, thread = launch(sid1, 'printf STOP_ALL_READY; sleep 60')
            until(connection, b'STOP_ALL_READY')
            connection.close(); thread.join(12)
            broker.control('stop-laptops')
            assert not json.loads(engine('inspect', name))[0]['State']['Running']
            healthy()
            print('PASS explicit stop-all stops detached work and leaves the website available', flush=True)
            print('Parent slice verified: '+str(bool(args.pool_config)), flush=True)
        finally:
            for connection in sockets:
                connection.close()
            for thread in threads:
                thread.join(12)
            for name in engine('ps', '-a', '--filter', 'label=reverie.worker='+deployment, '--format', '{{.Names}}').splitlines():
                engine('rm', '--force', name)
            engine('rm', '--force', server_name)
            broker.stopping.set()
            for office in list(broker.offices.values()): office.close()
            worker.create_args = original_create


if __name__ == '__main__':
    main()
