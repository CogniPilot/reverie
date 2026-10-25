"""Prepare and activate Nix-built worker isolation without changing owner host policy."""
from __future__ import annotations
import argparse
import base64
import fcntl
import importlib.util
import json
import gzip
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import sys
import time
import urllib.request


def run(args, **kwargs):
    result = subprocess.run(args, capture_output=True, text=True, **kwargs)
    if result.returncode:
        log = Path.home()/'scratch/reverie/isolation/command-error.log'
        log.parent.mkdir(parents=True, exist_ok=True)
        log.write_text(result.stderr)
        log.chmod(0o600)
        raise RuntimeError('Command failed: ' + args[0] + ' ' + args[1])
    return result.stdout.strip()


def private_json(path, data):
    temporary = path.with_suffix('.tmp')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as output:
        json.dump(data, output, indent=2)
        output.write('\n')
    temporary.replace(path)


def admin_phone_wake(root, name):
    """Only the owner-selected deployment file enables automatic Admin Harness effects."""
    path = root/'deployment.json'
    if not path.exists():
        return False
    config = json.loads(path.read_text())
    if not isinstance(config, dict) or config.get('containerName') != name:
        raise ValueError('Deployment settings do not select this console')
    value = config.get('adminPhoneWake', False)
    if type(value) is not bool:
        raise ValueError('adminPhoneWake must be a boolean')
    return value


def server_environment(old, old_image, phone_wake):
    """Preserve other explicit settings; refresh phone activation from durable owner selection."""
    environment = [v for v in old['Config']['Env'] if v not in old_image['Config'].get('Env', []) and
                   not v.startswith(('REVERIE_WORKER_SOCKET=', 'REVERIE_ADMIN_PHONE_WAKE='))]
    environment.append('REVERIE_WORKER_SOCKET=/run/reverie-workers/broker.sock')
    if phone_wake:
        environment.append('REVERIE_ADMIN_PHONE_WAKE=enabled')
    return environment


def prepare(args, root, state):
    phone_wake = admin_phone_wake(root, args.name)
    old = json.loads(run(['docker', 'inspect', args.name]))[0]
    if not old['State']['Running']:
        raise ValueError('The console is stopped; preparation will not wake it')
    if old['HostConfig'].get('Privileged') or old['HostConfig'].get('Devices') or old['HostConfig'].get('NetworkMode') != 'bridge':
        raise ValueError('Review the custom engine configuration before migrating this deployment')
    repo = Path(args.repo).resolve()
    scratch = Path.home() / 'scratch/reverie/isolation'
    scratch.mkdir(parents=True, exist_ok=True)
    build = Path.home() / 'scratch/reverie/nix-build'
    build.mkdir(mode=0o755, parents=True, exist_ok=True)
    link = repo / 'apps/web/node_modules'
    previous_link = link.readlink() if link.is_symlink() else None
    if previous_link is not None:
        link.unlink()  # The cache itself stays in its leased scratch workspace.
    try:
        print('Building the server image, worker image and host broker with Nix.', flush=True)
        # Native flake references preserve Git filtering and archive fallback.
        results = json.loads(run(['nix', 'build', '--out-link', str(state/'build'), '--json', '--option', 'build-dir', str(build.resolve()),
            str(repo) + '#dockerImage', str(repo) + '#workerImage', str(repo) + '#workerBroker', str(repo) + '#workerService']))
    finally:
        if previous_link is not None and not link.exists() and not link.is_symlink():
            link.symlink_to(previous_link)
    outputs = [item['outputs']['out'] for item in results]
    archives = [path for path in outputs if Path(path).is_file()]
    broker = next(path for path in outputs if (Path(path)/'bin/reverie-worker-broker').exists())
    unit = next(path for path in outputs if (Path(path)/'share/systemd/user/reverie-worker-broker.service').exists())
    sys.path.insert(0, str(repo/'python'))
    from reverie.workspaces import Workspaces
    scans = Workspaces(scratch/'image-scans')
    # Image scanners report detector names, never credential contents.
    for archive in archives:
        # Python tarfile seeks between layers; decompress once on the scratch
        # drive to avoid repeatedly inflating gigabytes from a compressed tar.
        task = 'scan-'+str(time.time_ns())
        folder = scans.create(task)
        with scans.lease(task):
            unpacked = folder/'image.tar'
            with gzip.open(archive, 'rb') as source, unpacked.open('wb') as destination:
                shutil.copyfileobj(source, destination, length=1024*1024)
            print('Scanning uncompressed image on the scratch drive.', flush=True)
            report = run(['nix', 'develop', str(repo), '--command', 'python3', '-m', 'reverie.image_check', str(unpacked), '--allow', str(repo/'docker/image-check-allow.tsv')], cwd=repo)
            (state/(Path(archive).name+'.scan.json')).write_text(report+'\n')
        scans.finish(task, 'Image validation passed; durable report saved in worker-isolation state.')
        scans.clean(task, apply=True)
        run(['docker', 'load', '--input', archive])
    server_image = run(['docker', 'image', 'inspect', 'reverie:latest', '--format', '{{.Id}}'])
    worker_image = run(['docker', 'image', 'inspect', 'reverie-worker:latest', '--format', '{{.Id}}'])
    grants = []
    company = None
    models = None
    for mount in old['Mounts']:
        dst = mount['Destination']
        if mount['Type'] != 'bind':
            raise ValueError('This migration currently requires explicit bind mounts; existing volumes remain untouched')
        if dst in ['/reverie_workspace', '/workspace', '/etc/passwd', '/etc/group', '/host-published'] or dst.startswith('/projects/'):
            grants.append(dict(source=mount['Source'], destination=dst, readOnly=not mount['RW']))
        if dst == '/instances/default':
            company = Path(mount['Source'])
        if dst == '/run/reverie-control':
            models = Path(mount['Source']) / 'models'
    if company is None:
        raise ValueError('The selected private company data mount is required')
    grants.append(dict(source=str(company/'tools'), destination='/instances/default/tools', readOnly=True))
    exporter = company/'console/statusline-exporter.sh'
    if exporter.is_file():
        grants.append(dict(source=str(exporter), destination='/instances/default/console/statusline-exporter.sh', readOnly=True))
    if models and models.is_dir():
        grants.append(dict(source=str(models), destination='/run/reverie-model', readOnly=True))
    socket_dir = root / 'runtime/worker-control'
    worker_state = root / 'runtime/workers'
    scratch_root = (root/'scratch/laptops').resolve()
    api_root = root/'runtime/worker-office'
    for path in [socket_dir, worker_state, scratch_root, api_root]:
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
    # Idle agents borrow the common pool. The remaining memory belongs to the
    # host, console, inference service and desktop, outside the worker slice.
    total_mib = int(next(line.split()[1] for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemTotal:'))) // 1024
    pool = args.pool_memory_mib or (int(total_mib * 0.7) // 1024 * 1024)
    if pool + 8192 > total_mib * 0.9:
        raise ValueError('The worker pool must leave memory for the console and host')
    config = dict(version=1, deployment='reverie', image=worker_image, serverContainer=args.name,
        socket=str(socket_dir/'broker.sock'), stateRoot=str(worker_state.resolve()), companyFile=str(company/'console/company.json'),
        companyRoot=str(company.resolve()), scratchRoot=str(scratch_root), apiSocketRoot=str(api_root), budgetMode=args.budget_mode,
        uid=os.getuid(), gid=os.getgid(), memoryMiB=4096 if args.budget_mode == 'admission' else 0, poolMemoryMiB=pool, poolTasksMax=8192,
        cgroupParent='reverie-workers.slice', pidsLimit=512, cpus=0, maxWorkers=16, mounts=grants, maintenanceSessions=args.maintainer_session)
    private_json(state/'broker.json', config)
    # Keep an immutable reviewed module next to the private owner configuration.
    shutil.copyfile(repo/'nix/worker-isolation.nix', state/'worker-module.nix')
    def nix(value):
        return json.dumps(str(value)).replace('${', '\\${')
    module = '\n'.join([
        '{ config, lib, pkgs, ... }:',
        'let module = import ./worker-module.nix { inherit config lib pkgs; brokerPackage = ' + broker + '; };',
        'in { imports = [ module ]; services.reverieWorkers = {',
        '  enable = true;', '  user = ' + nix(pwd.getpwuid(os.getuid()).pw_name) + ';',
        '  configFile = ' + nix(state/'broker.json') + ';', '  stateRoot = ' + nix(worker_state) + ';',
        '  socketDirectory = ' + nix(socket_dir) + ';', '  scratchRoot = ' + nix(scratch_root) + ';', '  apiSocketRoot = ' + nix(api_root) + ';', '  poolMemoryMiB = ' + str(pool) + ';', '}; }', ''])
    (state/'nixos.nix').write_text(module)
    private_json(state/'plan.json', dict(containerId=old['Id'], serverImage=server_image, workerImage=worker_image, broker=broker, unit=unit, company=str(company), preparedAt=time.time(), repo=str(repo), adminPhoneWake=phone_wake))
    print('Prepared and scanned both images. Host module: ' + str(state/'nixos.nix'))
    print('Run reverie-isolate activate. Pooled mode first requires ordinary owner activation of the generated NixOS module.')


def activate(args, root, state):
    plan = json.loads((state/'plan.json').read_text())
    phone_wake = admin_phone_wake(root, args.name)
    if phone_wake != plan.get('adminPhoneWake', False):
        raise ValueError('Admin phone startup setting changed; prepare a fresh plan')
    spec = importlib.util.spec_from_file_location('worker_isolation', Path(plan['repo'])/'python/reverie/worker.py')
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)
    config = worker.load_config(state/'broker.json')
    worker.Broker(config).check_pool()
    if config['budgetMode'] == 'admission':
        units = Path.home()/'.config/systemd/user'
        units.mkdir(parents=True, exist_ok=True)
        unit = units/'reverie-worker-broker.service'
        target = Path(plan['unit'])/'share/systemd/user/reverie-worker-broker.service'
        if unit.exists() or unit.is_symlink():
            if not unit.is_symlink():
                previous = unit.with_suffix('.pre-isolation-'+str(int(time.time())))
                unit.rename(previous)
            else:
                unit.unlink()
        unit.symlink_to(target)
        environment = Path.home()/'.config/reverie/worker-broker.env'
        environment.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        environment.write_text('REVERIE_WORKER_CONFIG='+json.dumps(str(state/'broker.json'))+'\n')
        environment.chmod(0o600)
        run(['systemctl', '--user', 'daemon-reload'])
        run(['systemctl', '--user', 'enable', 'reverie-worker-broker.service'])
        run(['systemctl', '--user', 'restart', 'reverie-worker-broker.service'])
        for _ in range(40):
            if Path(config['socket']).is_socket(): break
            time.sleep(.25)
    else:
        run(['systemctl', 'is-active', 'reverie-worker-broker.service'])
    if not Path(config['socket']).is_socket():
        raise ValueError('The owner-managed worker broker is unavailable')
    old = json.loads(run(['docker', 'inspect', args.name]))[0]
    if old['Id'] != plan['containerId'] or not old['State']['Running']:
        raise ValueError('The console changed or stopped after preparation; prepare a fresh plan')
    old_image = json.loads(run(['docker', 'image', 'inspect', old['Image']]))[0]
    environment = server_environment(old, old_image, phone_wake)
    if any('\n' in v or '\r' in v for v in environment):
        raise ValueError('Review multiline environment overrides before migration')
    env_file = state/'server.env'
    env_file.write_text('\n'.join(environment)+'\n')
    env_file.chmod(0o600)
    command = ['docker', 'run', '--detach', '--init', '--name', args.name, '--restart', 'unless-stopped',
        '--user', old['Config']['User'], '--workdir', old['Config']['WorkingDir'], '--memory', '8192m', '--memory-swap', '8192m', '--pids-limit', '512', '--env-file', str(env_file)]
    for key, value in old['Config'].get('Labels', {}).items():
        command += ['--label', key+'='+value]
    for port, bindings in old['HostConfig']['PortBindings'].items():
        for binding in bindings:
            command += ['--publish', binding['HostIp']+':'+binding['HostPort']+':'+port]
    for mount in old['Mounts']:
        if mount['Destination'] == '/scratch':
            Path(mount['Source']).mkdir(parents=True, exist_ok=True)
        if mount['Destination'] == '/run/reverie-workers':
            if mount['Source'] != str(Path(config['socket']).parent) or mount['RW']:
                raise ValueError('The existing worker control mount differs from the owner configuration')
            continue
        command += ['--mount', 'type=bind,src='+mount['Source']+',dst='+mount['Destination']+(',readonly' if not mount['RW'] else '')]
    command += ['--mount', 'type=bind,src='+str(Path(config['socket']).parent)+',dst=/run/reverie-workers,readonly', plan['serverImage']]
    backup_name = args.name+'-before-isolation-'+str(int(time.time()))
    receipts = Path.home()/'scratch/reverie/isolation'
    receipts.mkdir(parents=True, exist_ok=True)
    renamed = False
    new_id = None
    if admin_phone_wake(root, args.name) != phone_wake:
        raise ValueError('Admin phone startup setting changed; prepare a fresh plan')
    run(['docker', 'stop', '--time', '20', args.name])
    try:
        company = Path(plan['company'])
        # Back up state and authorization before the new server reads them.
        run(['tar', '-cf', str(receipts/('private-state-'+str(int(time.time()))+'.tar')),
            '--exclude=data/tools', '--exclude=home/.cache', '--exclude=home/.npm',
            '--exclude=home/.nix-portable/nix/store', '--exclude=home/.local/share/opencode/models',
            '-C', str(company.parent), 'data', 'home'])
        run(['docker', 'rename', args.name, backup_name]); renamed = True
        new_id = run(command)
        ready = False
        for _ in range(60):
            try:
                urllib.request.urlopen('http://127.0.0.1:3000/api/status', timeout=2)
            except urllib.error.HTTPError as error:
                if error.code == 401:
                    ready = True; break
            except OSError:
                pass
            time.sleep(1)
        if not ready:
            raise RuntimeError('The isolated console did not become ready')
        after = json.loads((company/'console/company.json').read_text())
        eligible = [e['id'] for e in after['employees'] if e.get('desiredRunning') is True and not e.get('onVacation')]
        # Use the existing authenticated wake route, preserving all runtime
        # recipes. Vacation/desired-running state is checked again by the server.
        token_name = 'isolation-'+str(int(time.time()))
        token = run(['docker', 'exec', args.name, 'reverie', 'owner', 'service-token', 'issue', token_name])
        try:
            credentials = {}
            for line in (company/'console/.env').read_text().splitlines():
                match = __import__('re').fullmatch(r'(?:export\s+)?(REVERIE_USERNAME|REVERIE_PASSWORD)=(.*)', line.strip())
                if match:
                    credentials[match[1]] = match[2].strip().strip('\"\'')
            basic = base64.b64encode((credentials.get('REVERIE_USERNAME','admin')+':'+credentials['REVERIE_PASSWORD']).encode()).decode()
            for employee in eligible:
                request = urllib.request.Request('http://127.0.0.1:3000/api/company/employees/'+employee+'/wake', data=b'{}', method='POST', headers={'Content-Type': 'application/json', 'x-reverie-service-token': token, 'Authorization': 'Basic '+basic})
                try:
                    with urllib.request.urlopen(request, timeout=60) as response:
                        result = json.load(response)
                except urllib.error.HTTPError as error:
                    raise RuntimeError('Expert wake API returned HTTP '+str(error.code)) from None
                if not result.get('success'):
                    raise RuntimeError('An eligible expert did not wake')
        finally:
            run(['docker', 'exec', args.name, 'reverie', 'owner', 'service-token', 'revoke', token_name])
        private_json(state/'activation.json', dict(serverId=new_id, rollbackContainer=backup_name, activatedAt=time.time(), eligibleCount=len(eligible)))
        print('Isolated console started; recovery requested for eligible experts. Check expert status for any deferred recovery. Previous container retained stopped: '+backup_name)
    except BaseException:
        if new_id:
            subprocess.run(['docker', 'rm', '--force', new_id], capture_output=True)
        if renamed:
            run(['docker', 'rename', backup_name, args.name])
        run(['docker', 'start', args.name])
        raise
    finally:
        env_file.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'activate', 'status'])
    parser.add_argument('--root', default=os.environ.get('REVERIE_ROOT', str(Path.home()/'reverie')))
    parser.add_argument('--repo', default=os.environ.get('REVERIE_REPO', str(Path(__file__).resolve().parents[2])))
    parser.add_argument('--name', default='reverie')
    parser.add_argument('--pool-memory-mib', type=int)
    parser.add_argument('--maintainer-session', action='append', default=[], help='Owner-granted session allowed to restart only the website')
    parser.add_argument('--budget-mode', choices=['admission', 'pool'], default='admission')
    args = parser.parse_args()
    os.umask(0o077)
    root = Path(args.root).resolve()
    state = root/'runtime/worker-isolation'
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        lock_path = root/'runtime/update-state/update.lock'
        lock_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with lock_path.open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if args.action == 'prepare': prepare(args, root, state)
            elif args.action == 'activate': activate(args, root, state)
            else:
                print(json.dumps(json.loads((state/'activation.json').read_text()), indent=2))
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        # Do not expose environment values, engine diagnostics or auth material.
        if isinstance(error, (ValueError, RuntimeError)): print(str(error), file=sys.stderr)
        print('Isolation could not '+args.action+'. Check the owner configuration and host service; the previous deployment is retained.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
