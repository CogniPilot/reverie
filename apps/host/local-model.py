"""Nix-managed host inference. Only a private Unix socket crosses the container boundary."""
import argparse
import csv
import json
import os
from pathlib import Path
import re
import secrets
import socket
import stat
import subprocess
import sys


def sampling_args(profile):
    if profile == 'server-default':
        return []
    if profile != 'qwen3.8-thinking':
        raise ValueError('Unknown model sampling profile')
    # https://huggingface.co/Qwen/Qwen3.8-27B#best-practices
    return ['--jinja', '--reasoning', 'on', '--temp', '1.0', '--top-p', '0.95', '--top-k', '20',
            '--min-p', '0.0', '--presence-penalty', '0.0', '--repeat-penalty', '1.0',
            '--chat-template-kwargs', json.dumps({'reasoning_effort': 'xhigh', 'preserve_thinking': True})]


def prepare_socket(path):
    """Recover an owned abandoned socket without replacing a listener or file."""
    try:
        previous = path.lstat()
    except FileNotFoundError:
        return
    if not stat.S_ISSOCK(previous.st_mode) or previous.st_uid != os.getuid() or previous.st_mode & 0o077:
        raise ValueError('Model socket must be an owned private socket')
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
        probe.settimeout(1)
        try:
            probe.connect(str(path))
        except ConnectionRefusedError:
            current = path.lstat()
            if (previous.st_dev, previous.st_ino) != (current.st_dev, current.st_ino):
                raise ValueError('Model socket changed during startup')
            path.unlink()
        else:
            raise ValueError('The local model socket already has a listener')


def run(argv, **kwargs):
    return subprocess.run(argv, check=True, text=True, **kwargs)


def gpu_capability(gpu):
    if gpu == 'cpu':
        return ''
    if not re.fullmatch(r'[0-9]+', gpu):
        raise ValueError('--gpu is an NVIDIA device index, or cpu')
    result = run(['nvidia-smi', '--query-gpu=index,compute_cap', '--format=csv,noheader'], capture_output=True)
    for index, capability in csv.reader(result.stdout.splitlines(), skipinitialspace=True):
        if index.strip() == gpu and re.fullmatch(r'[0-9]+\.[0-9]+', capability.strip()):
            return capability.strip()
    raise ValueError('Selected GPU was not found or its compute capability is unknown')


def container_control(name):
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]*', name):
        raise ValueError('Invalid container name')
    result = json.loads(run(['docker', 'inspect', name], capture_output=True).stdout)[0]
    mounts = [m for m in result['Mounts'] if m['Destination'] == '/run/reverie-control' and m['Type'] == 'bind' and m['RW']]
    if len(mounts) != 1:
        raise ValueError('The container needs the owner-selected /run/reverie-control bind from reverie-start')
    return Path(mounts[0]['Source'])


def private_key(path):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if not path.exists():
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as stream:
            stream.write(secrets.token_hex(32) + '\n')
    info = path.lstat()
    if not path.is_file() or path.is_symlink() or info.st_mode & 0o077 or info.st_uid != os.getuid():
        raise ValueError('Model API key must be an owned private regular file (mode 0600)')


def unit_quote(value):
    if any(char in value for char in '\n\r\x00'):
        raise ValueError('Invalid service path')
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%').replace('$', '$$') + '"'


def install_service(config):
    directory = Path.home() / '.config/reverie'
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    config_path = directory / 'local-model.json'
    fd = os.open(config_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(config, stream, indent=2)
    units = Path.home() / '.config/systemd/user'
    units.mkdir(parents=True, exist_ok=True)
    launcher = os.environ['REVERIE_MODEL_LAUNCHER']
    (units / 'reverie-local-model.service').write_text(
        '[Unit]\nDescription=Reverie local model (Nix)\n'
        '[Service]\nType=simple\nUMask=0077\n'
        f'ExecStart={unit_quote(launcher)} --config {unit_quote(str(config_path))}\n'
        'Restart=on-failure\nRestartSec=5\nTimeoutStopSec=30\n'
        '[Install]\nWantedBy=default.target\n')
    run(['systemctl', '--user', 'daemon-reload'])
    run(['systemctl', '--user', 'enable', '--now', 'reverie-local-model.service'])
    print('Local model service enabled. View logs: journalctl --user -u reverie-local-model -f', flush=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', help='Existing GGUF weights; never rewritten or downloaded implicitly')
    parser.add_argument('--alias', default='local-model')
    parser.add_argument('--mmproj', help='Existing matching vision projector GGUF; never downloaded implicitly')
    parser.add_argument('--image-max-tokens', type=int, default=2048, help='Bound dynamic-resolution image tokens')
    parser.add_argument('--gpu', default='0', help='NVIDIA device index, or cpu')
    parser.add_argument('--context', type=int, default=32768)
    parser.add_argument('--sampling-profile', choices=['server-default', 'qwen3.8-thinking'],
                        default='server-default', help='Explicit model-vendor sampling defaults')
    parser.add_argument('--container', help='Reverie container; inference is reachable through its private control mount')
    parser.add_argument('--port', type=int, default=8080, help='Native-only loopback port')
    parser.add_argument('--install-service', action='store_true')
    parser.add_argument('--config', help='Saved operator configuration')
    args = parser.parse_args(argv)
    if args.config:
        config = json.loads(Path(args.config).read_text())
        args = parser.parse_args([part for key, value in config.items() for part in ['--' + key, str(value)]])
    if not args.model:
        parser.error('--model is required')
    model = Path(args.model).expanduser().resolve(strict=True)
    if not model.is_file() or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}', args.alias):
        raise ValueError('Choose a regular GGUF model and a simple model alias')
    if not 512 <= args.context <= 262144 or not 1 <= args.port <= 65535:
        raise ValueError('Invalid context size or port')
    projector = Path(args.mmproj).expanduser().resolve(strict=True) if args.mmproj else None
    if projector is not None and not projector.is_file():
        raise ValueError('Choose a regular vision projector GGUF')
    if not 128 <= args.image_max_tokens <= 8192:
        raise ValueError('Invalid image token budget')
    capability = gpu_capability(args.gpu)
    scratch = Path(os.environ.get('REVERIE_MODEL_SCRATCH', str(Path.home() / 'scratch/reverie/models'))).resolve()
    scratch.mkdir(parents=True, exist_ok=True)
    build_dir = scratch / 'nix-build'
    build_dir.mkdir(exist_ok=True, mode=0o755)
    build_dir.chmod(0o755)
    for directory in ['cache', 'tmp']:
        (scratch / directory).mkdir(exist_ok=True)
    os.environ.update(TMPDIR=str(scratch / 'tmp'), LLAMA_CACHE=str(scratch / 'cache'))
    os.environ['NIX_BUILD_CORES'] = os.environ.get('NIX_BUILD_CORES', '4')
    if capability:
        os.environ['CUDA_VISIBLE_DEVICES'] = args.gpu
    # NixOS keeps the real host driver outside the immutable CUDA toolkit closure.
    driver = Path('/run/opengl-driver/lib')
    if driver.is_dir():
        os.environ['LD_LIBRARY_PATH'] = str(driver) + (':' + os.environ['LD_LIBRARY_PATH'] if os.environ.get('LD_LIBRARY_PATH') else '')
    runtime_root = Path.home() / '.local/state/reverie/local-model-runtime'
    runtime_root.parent.mkdir(parents=True, exist_ok=True)
    command = ['nix', 'build', '--out-link', str(runtime_root), '--print-out-paths', '--file', os.environ['REVERIE_MODEL_BUILD_EXPR'],
               '--argstr', 'nixpkgs', os.environ['REVERIE_MODEL_NIXPKGS'], '--argstr', 'system', os.environ['REVERIE_MODEL_SYSTEM'],
               '--argstr', 'capability', capability, '--option', 'build-dir', str(build_dir)]
    print(f'Preparing Nix llama.cpp for {"CUDA " + capability if capability else "CPU"}; first build may take time.', flush=True)
    runtime = Path(run(command, stdout=subprocess.PIPE).stdout.strip())
    control = container_control(args.container) if args.container else Path.home() / '.local/share/reverie/local-model'
    private = control / 'models'
    private.mkdir(parents=True, exist_ok=True, mode=0o700)
    private.chmod(0o700)
    key = private / 'api-key'
    private_key(key)
    address = str(private / 'default.sock') if args.container else '127.0.0.1'
    if args.container:
        if len(os.fsencode(address)) > 100:
            raise ValueError('Control mount path is too long for a Unix socket')
        (private / 'enabled').touch(mode=0o600)
        print('Container endpoint: http://127.0.0.1:8092 (API key stays in the private models/api-key file).', flush=True)
    else:
        print(f'Native endpoint: http://127.0.0.1:{args.port}; API key file: {key}', flush=True)
    if args.install_service:
        config = {'model': str(model), 'alias': args.alias, 'gpu': args.gpu, 'context': args.context, 'port': args.port}
        if projector is not None:
            config.update(mmproj=str(projector), **{'image-max-tokens': args.image_max_tokens})
        if args.sampling_profile != 'server-default':
            config['sampling-profile'] = args.sampling_profile
        if args.container:
            config['container'] = args.container
        install_service(config)
        return 0
    os.umask(0o077)
    if args.container:
        prepare_socket(Path(address))
    os.execv(str(runtime / 'bin/llama-server'), ['llama-server', '--model', str(model), '--alias', args.alias,
        '--host', address, '--port', str(args.port), '--ctx-size', str(args.context), '--parallel', '1',
        '--threads', '8', '--gpu-layers', 'all' if capability else '0', '--flash-attn', 'on',
        '--cache-type-k', 'q8_0', '--cache-type-v', 'q8_0', '--api-key-file', str(key)] + sampling_args(args.sampling_profile) + (['--mmproj', str(projector), '--image-max-tokens', str(args.image_max_tokens)] if projector else []))


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print('reverie-local-model:', error, file=sys.stderr)
        sys.exit(1)
