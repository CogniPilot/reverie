"""Host-owned, bounded agent containers and a terminal-only Unix socket client.

The server may request execution inside a worker, never engine arguments or host
mounts. The owner configures all grants on the host. Workers never mount this
socket, the engine socket, or the host control directory.
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import http.client
import http.server
import json
import os
from pathlib import Path
import pty
import re
import selectors
import signal
import socket
import socketserver
import stat
import struct
import subprocess
import sys
import termios
import threading
import time
import tty
import uuid
from urllib.parse import unquote, urlsplit

if __package__:
    from .worker_gpu import gpu_create_args, validate_gpu_grants
    from .worker_resources import effective_config, policy_digest, validate_session_resources, validate_resource_reload
    from .worker_nix import prepare_store, store_guard
    from .worker_tmp import prepare_temporary, temporary_environment, write_storage_instructions, workspace_alias, home_workspace_alias
    from .worker_storage import storage_paths, storage_guard, prepare_storage, private_directory, storage_start_allowed, record_storage_binding, validate_storage, read_metadata
    from .worker_docker import enabled as rootless_docker_enabled, require_image as require_docker_image, security_args as docker_security_args, runtime_args as docker_runtime_args
    from .worker_storage_labels import hostname as employee_hostname
else:
    # Host migration tools also load this file with spec_from_file_location;
    # their sys.path need not contain the sibling module's directory.
    import importlib.util
    _package_root = str(Path(__file__).resolve().parents[1])
    if _package_root not in sys.path:
        sys.path.insert(0, _package_root)
    from reverie.worker_storage import storage_paths, storage_guard, prepare_storage, private_directory, storage_start_allowed, record_storage_binding, validate_storage, read_metadata
    from reverie.worker_docker import enabled as rootless_docker_enabled, require_image as require_docker_image, security_args as docker_security_args, runtime_args as docker_runtime_args
    from reverie.worker_storage_labels import hostname as employee_hostname
    _gpu_spec = importlib.util.spec_from_file_location('reverie_worker_gpu', Path(__file__).with_name('worker_gpu.py'))
    _gpu_module = importlib.util.module_from_spec(_gpu_spec)
    _gpu_spec.loader.exec_module(_gpu_module)
    gpu_create_args = _gpu_module.gpu_create_args
    validate_gpu_grants = _gpu_module.validate_gpu_grants
    _resource_spec = importlib.util.spec_from_file_location('reverie_worker_resources', Path(__file__).with_name('worker_resources.py'))
    _resource_module = importlib.util.module_from_spec(_resource_spec)
    _resource_spec.loader.exec_module(_resource_module)
    effective_config = _resource_module.effective_config
    policy_digest = _resource_module.policy_digest
    validate_session_resources = _resource_module.validate_session_resources
    validate_resource_reload = _resource_module.validate_resource_reload
    _nix_spec = importlib.util.spec_from_file_location('reverie_worker_nix', Path(__file__).with_name('worker_nix.py'))
    _nix_module = importlib.util.module_from_spec(_nix_spec)
    _nix_spec.loader.exec_module(_nix_module)
    prepare_store = _nix_module.prepare_store
    store_guard = _nix_module.store_guard
    _tmp_spec = importlib.util.spec_from_file_location('reverie_worker_tmp', Path(__file__).with_name('worker_tmp.py'))
    _tmp_module = importlib.util.module_from_spec(_tmp_spec)
    _tmp_spec.loader.exec_module(_tmp_module)
    prepare_temporary = _tmp_module.prepare_temporary
    temporary_environment = _tmp_module.temporary_environment
    write_storage_instructions = _tmp_module.write_storage_instructions
    workspace_alias = _tmp_module.workspace_alias
    home_workspace_alias = _tmp_module.home_workspace_alias

MAX_FRAME = 256 * 1024
SHARED_WORKSPACE = Path('/reverie_workspace')
SHARED_ATTACHMENTS = SHARED_WORKSPACE / 'attachments'
OFFLINE_GRACE_SECONDS = 600
SESSION = re.compile(r"^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$")
ENV_KEY = re.compile(r"^(?:LANG|LC_ALL|TERM|COLORTERM|XDG_(?:DATA|CONFIG|CACHE|STATE)_HOME|CLAUDE_[A-Z0-9_]+|CODEX_[A-Z0-9_]+|OPENCODE_[A-Z0-9_]+|OPENAI_[A-Z0-9_]+|ANTHROPIC_[A-Z0-9_]+|GEMINI_[A-Z0-9_]+|GOOGLE_[A-Z0-9_]+|REVERIE_(?:SESSION_ID|MUX|MUX_NAME|PARENT_SESSION_ID|API_URL|HOOK_SECRET_FILE|STATUSLINE_[A-Z0-9_]+|HANDS_[A-Z0-9_]+)|DISABLE_AUTOUPDATER|DISABLE_UPDATES)$")


def send_frame(connection, kind, payload):
    if len(payload) > MAX_FRAME:
        raise ValueError("Worker frame is too large")
    connection.sendall(kind + struct.pack("!I", len(payload)) + payload)


def receive_frame(connection):
    def read(size):
        data = bytearray()
        while len(data) < size:
            chunk = connection.recv(size - len(data))
            if not chunk:
                raise EOFError
            data.extend(chunk)
        return bytes(data)
    header = read(5)
    length = struct.unpack("!I", header[1:])[0]
    if length > MAX_FRAME:
        raise ValueError("Worker frame is too large")
    return header[:1], read(length)


def validate_request(request, config):
    if not isinstance(request, dict) or set(request) - {"attachOnly"} != {"sessionId", "cwd", "command", "env", "cols", "rows"}:
        raise ValueError("Invalid worker request")
    if not isinstance(request['sessionId'], str) or not SESSION.fullmatch(request['sessionId']):
        raise ValueError("Invalid session identifier")
    if "attachOnly" in request and type(request["attachOnly"]) is not bool:
        raise ValueError("Invalid attach-only request")
    cwd = request['cwd']
    if not isinstance(cwd, str) or not cwd.startswith('/') or '\0' in cwd or '..' in Path(cwd).parts:
        raise ValueError("Invalid worker directory")
    writable = [m['destination'] for m in config['mounts'] if not m.get('readOnly')]
    alias = workspace_alias(config)
    if alias is not None and not alias.get('readOnly'):
        writable.append('/workspace')
    if not any(Path(cwd).is_relative_to(destination) for destination in writable):
        raise ValueError("Worker directory is outside the owner grants")
    if not isinstance(request['command'], str) or not request['command'] or len(request['command']) > 128 * 1024 or '\0' in request['command']:
        raise ValueError("Invalid worker command")
    env = request['env']
    if not isinstance(env, dict) or len(env) > 128 or any(not isinstance(k, str) or not ENV_KEY.fullmatch(k) or not isinstance(v, str) or '\0' in v or len(v) > 65536 for k, v in env.items()):
        raise ValueError("Invalid worker environment")
    for key in ['cols', 'rows']:
        if type(request[key]) is not int or not 1 <= request[key] <= 1000:
            raise ValueError("Invalid terminal dimensions")
    return request


def load_config(path):
    path = Path(path)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("Worker configuration must be an owner-only regular file")
    config = json.loads(path.read_text())
    required = {'version', 'deployment', 'image', 'serverContainer', 'socket', 'stateRoot', 'companyFile', 'companyRoot', 'scratchRoot', 'apiSocketRoot', 'budgetMode', 'uid', 'gid', 'memoryMiB', 'poolMemoryMiB', 'poolTasksMax', 'cgroupParent', 'pidsLimit', 'cpus', 'maxWorkers', 'mounts', 'maintenanceSessions'}
    if not isinstance(config, dict) or set(config) - {'gpuGrants','sessionResources','rootlessDocker'} != required or config['version'] != 1:
        raise ValueError("Unsupported worker configuration")
    validate_gpu_grants(config.get('gpuGrants', {}))
    validate_session_resources(config)
    rootless_docker_enabled(config)
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,39}', config['deployment']) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}', config['serverContainer']):
        raise ValueError("Invalid deployment identity")
    if not re.fullmatch(r'sha256:[a-f0-9]{64}', config['image']):
        raise ValueError("Workers require an immutable image ID")
    for name, low, high in [('uid', 1, 2**31-1), ('gid', 1, 2**31-1), ('memoryMiB', 0, 1048576), ('poolMemoryMiB', 512, 1048576), ('poolTasksMax', 128, 32768), ('pidsLimit', 64, 4096), ('maxWorkers', 1, 32)]:
        if type(config[name]) is not int or not low <= config[name] <= high:
            raise ValueError('Invalid worker resource limit: ' + name)
    if type(config['cpus']) not in (float, int) or not (config['cpus'] == 0 or 0.25 <= config['cpus'] <= 64) or config['memoryMiB'] > config['poolMemoryMiB']:
        raise ValueError('Invalid worker resource budget')
    if config['cgroupParent'] != 'reverie-workers.slice':
        raise ValueError('Workers require the owner-managed reverie-workers.slice')
    if config['budgetMode'] not in ['pool', 'admission'] or (config['budgetMode'] == 'admission' and config['memoryMiB'] < 512):
        raise ValueError('Admission mode requires an individual memory ceiling')
    for name in ['socket', 'stateRoot', 'companyFile', 'companyRoot', 'scratchRoot', 'apiSocketRoot']:
        if not isinstance(config[name], str) or not config[name].startswith('/') or '\0' in config[name]:
            raise ValueError('Worker paths must be absolute')
    if not isinstance(config['maintenanceSessions'], list) or any(not isinstance(sid, str) or not SESSION.fullmatch(sid) for sid in config['maintenanceSessions']):
        raise ValueError('Maintenance grants must name explicit sessions')
    if len(config['socket'].encode()) > 100:
        raise ValueError('Worker socket path is too long')
    if not isinstance(config['mounts'], list) or not config['mounts']:
        raise ValueError('Worker mounts must be explicit')
    destinations = set()
    resolved_mounts = []
    for mount in config['mounts']:
        if not isinstance(mount, dict) or set(mount) != {'source', 'destination', 'readOnly'} or type(mount['readOnly']) is not bool:
            raise ValueError('Invalid worker mount')
        for key in ['source', 'destination']:
            value = mount[key]
            if not isinstance(value, str) or not value.startswith('/') or any(c in value for c in ',\r\n\0') or '..' in Path(value).parts:
                raise ValueError('Invalid worker mount path')
        destination = mount['destination']
        destination_path = Path(destination)
        # pathlib preserves exactly two leading slashes, while the Linux
        # mount consumer treats them as the same absolute path as one slash.
        # Reject every noncanonical spelling before policy comparisons so an
        # alias cannot bypass the workspace or protected-subtree checks.
        if destination.startswith('//') or destination_path.as_posix() != destination:
            raise ValueError('Worker mount destination must be canonical')
        if destination_path == SHARED_ATTACHMENTS or destination_path.is_relative_to(SHARED_ATTACHMENTS):
            raise ValueError('Worker mounts cannot target shared attachment storage')
        if destination in destinations or destination in ['/', '/home/agent', '/nix', '/proc', '/sys', '/dev', '/run', '/var/run'] or (destination.startswith(('/run/', '/var/run/')) and destination != '/run/reverie-model'):
            raise ValueError('Worker mount overlaps a reserved location')
        source = Path(mount['source']).resolve(strict=True)
        if source == Path('/') or source.is_relative_to('/run') or source.is_relative_to('/var/run') or source.is_relative_to(Path(config['socket']).parent) or source.is_relative_to(config['stateRoot']):
            raise ValueError('Worker mount exposes host control state')
        destinations.add(destination)
        resolved_mounts.append((source, destination_path, Path(mount['source'])))
    workspace_sources = [(source, lexical) for source, destination, lexical in resolved_mounts if destination == SHARED_WORKSPACE]
    for workspace_source, workspace_lexical in workspace_sources:
        attachment_entry = workspace_source / 'attachments'
        try:
            attachment_info = attachment_entry.lstat()
        except OSError as error:
            raise ValueError('Shared attachment storage must be an existing directory before workers start') from error
        if not stat.S_ISDIR(attachment_info.st_mode):
            raise ValueError('Shared attachment storage must be a real directory, not a symlink')
        attachment_source = attachment_entry.resolve(strict=True)
        attachment_lexical = workspace_lexical / 'attachments'
        for source, destination, lexical in resolved_mounts:
            overlaps_attachment_store = (
                source == attachment_source
                or source.is_relative_to(attachment_source)
                or attachment_source.is_relative_to(source)
                or lexical == attachment_lexical
                or lexical.is_relative_to(attachment_lexical)
                or attachment_lexical.is_relative_to(lexical)
            )
            if overlaps_attachment_store and not (source == workspace_source and destination == SHARED_WORKSPACE):
                raise ValueError('Worker mounts cannot expose shared attachment storage through an alias')
    return config


def create_args(config, session_id, home, *, scratch=None, storage=None):
    config = effective_config(config, session_id)
    name = config['deployment'] + '-agent-' + session_id
    digest = hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest()
    policy = hashlib.sha256(json.dumps({k: v for k, v in config.items() if k not in ['image', 'maintenanceSessions']}, sort_keys=True).encode()).hexdigest()
    args = ['create', '--name', name, '--init', '--restart', 'no', '--read-only', *docker_security_args(config),
            '--label', 'reverie.worker=' + config['deployment'], '--label', 'reverie.session=' + session_id, '--label', 'reverie.worker-config=' + digest, '--label', 'reverie.worker-policy=' + policy,
            '--user', f"{config['uid']}:{config['gid']}", '--cpu-shares', '1024',
            '--pids-limit', str(config['pidsLimit']), '--network', name + '-lan',
            '--tmpfs', '/run:rw,nosuid,nodev,size=16777216',
            '--mount', f'type=bind,src={home},dst=/home/agent', '--env', 'HOME=/home/agent', '--env', 'REVERIE_WORKER=1', '--env', 'REVERIE_INSTALL_CLIS=none']
    args += docker_runtime_args(config)
    # The canonical storage resolver supplies the employee's stable scratch path.
    # Legacy SID fallback exists only for composition with the older caller.
    scratch = Path(config['scratchRoot']) / session_id if scratch is None else Path(scratch)
    args += ['--mount', f'type=bind,src={scratch / "tmp"},dst=/tmp',
             '--mount', f'type=bind,src={scratch},dst=/scratch',
             '--mount', 'type=bind,src=' + str(Path(config['apiSocketRoot']) / session_id) + ',dst=/run/reverie-office,readonly']
    for key, value in temporary_environment().items():
        args += ['--env', key + '=' + value]
    if config['budgetMode'] == 'pool':
        args += ['--cgroup-parent', config['cgroupParent']]
    if config['memoryMiB']:
        args += ['--memory', str(config['memoryMiB']) + 'm', '--memory-swap', str(config['memoryMiB']) + 'm']
    if config['cpus']:
        args += ['--cpus', str(config['cpus'])]
    for mount in config['mounts']:
        args += ['--mount', 'type=bind,src=' + mount['source'] + ',dst=' + mount['destination'] + (',readonly' if mount['readOnly'] else '')]
    alias = workspace_alias(config)
    if alias is not None:
        args += ['--mount', 'type=bind,src=' + alias['source'] + ',dst=/workspace' + (',readonly' if alias['readOnly'] else '')]
    # The console keeps the complete shared drive so its membership-checked API
    # can serve room files. Laptop containers keep the rest of that drive, but a
    # final read-only tmpfs overlays the attachment subtree so host-UID sharing
    # cannot bypass the API's room-membership check.
    if any(Path(mount['destination']) == SHARED_WORKSPACE for mount in config['mounts']):
        args += ['--mount', 'type=tmpfs,dst=/reverie_workspace/attachments,tmpfs-mode=0555,tmpfs-size=1048576,readonly']
        if alias is not None:
            args += ['--mount', 'type=tmpfs,dst=/workspace/attachments,tmpfs-mode=0555,tmpfs-size=1048576,readonly']
    args += gpu_create_args(config, session_id)
    args += ['--entrypoint', '/bin/sleep', config['image'], 'infinity']
    if storage is not None and storage.kind == 'employee':
        args[-4:-4] = ['--label', 'reverie.employee=' + storage.identity,
                      '--label', 'reverie.storage=employee:' + storage.identity,
                      '--hostname',employee_hostname(config,storage)]
    return name, digest, args


def tmux_exec_args(name, *command, attach=False):
    # Docker exec does not inherit the provider shell's locale. Both the tmux
    # server and each attach client need UTF-8; otherwise line drawing becomes
    # VT100 ACS q's and other Unicode is replaced by underscores.
    return ['exec', *(['-it'] if attach else []),
            '--env', 'LANG=C.UTF-8', '--env', 'LC_ALL=C.UTF-8',
            '--env', 'TERM=xterm-256color', '--env', 'COLORTERM=truecolor',
            name, '/bin/tmux', '-u', '-L', 'reverie-laptop', *command]


def account_mounts(config, environment):
    """Only the explicitly selected tool account, never console/owner state."""
    mounts = {}
    for key in ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_DATA_HOME']:
        value = environment.get(key)
        if not value:
            continue
        path = Path(value)
        parts = path.parts
        if not ((path.is_relative_to('/instances/default/accounts') and len(parts) >= 5) or
                (path.is_relative_to('/instances/default/console/accounts') and len(parts) >= 6)) or '..' in parts:
            raise ValueError('Tool account is outside the selected company account storage')
        root = Path(config['companyRoot']).resolve()
        source = (root / path.relative_to('/instances/default')).resolve(strict=True)
        if not source.is_relative_to(root) or not source.is_dir():
            raise ValueError('Selected tool account is unavailable')
        mounts[value] = str(source)
    return [arg for destination, source in mounts.items() for arg in ['--mount', f'type=bind,src={source},dst={destination}']]


PLAN_CREDENTIAL_EXPORT = re.compile(r"^/api/plans/requests/[^/]+/credential/?$")
PLAN_DECISION = re.compile(r"^/api/plans/requests/([a-zA-Z0-9][a-zA-Z0-9_-]{0,99})/(approve|reject)$")


def office_plan_approval(company_root, session_id, path, method, query, body):
    """Attach only this office's one-time credential; never deliver it to a guest.

    The console remains authoritative for binding, expiry, authorization and replay.
    All path components are opened no-follow; refusals contain no path or credential.
    """
    # Retired credential export never reaches upstream or a private lookup.
    if PLAN_CREDENTIAL_EXPORT.fullmatch(unquote(path)):
        raise ValueError('Plan approval credential export is unavailable')
    match = PLAN_DECISION.fullmatch(path)
    if match is None:
        return None
    if method != 'POST' or query or not SESSION.fullmatch(session_id) or len(body) > 64*1024:
        raise ValueError('Plan approval refused')

    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('Plan approval refused')
            result[key] = value
        return result

    payload = json.loads(body.decode('utf-8'), object_pairs_hook=unique)
    request_id, decision = match.groups()
    if not isinstance(payload, dict) or set(payload) != ({'handoff'} if decision == 'approve' else set()):
        raise ValueError('Plan approval refused')
    if decision == 'approve':
        handoff = payload['handoff']
        if not isinstance(handoff, str) or not 1 <= len(handoff.strip()) <= 12000 or re.search(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', handoff):
            raise ValueError('Plan approval refused')
    root = Path(company_root)
    if not root.is_absolute() or '..' in root.parts:
        raise ValueError('Plan approval refused')
    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    directory = os.open('/', directory_flags)
    handle = None
    try:
        # The host configuration chooses company_root, never the request or guest.
        for component in root.parts[1:]:
            child = os.open(component, directory_flags, dir_fd=directory)
            os.close(directory)
            directory = child
        for component in ['console', 'plan-request-capabilities', session_id]:
            child = os.open(component, directory_flags, dir_fd=directory)
            os.close(directory)
            directory = child
            info = os.fstat(directory)
            if info.st_uid != os.getuid() or info.st_mode & 0o077:
                raise ValueError('Plan approval refused')
        handle = os.open(request_id+'.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        info = os.fstat(handle)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > 4096:
            raise ValueError('Plan approval refused')
        raw = os.read(handle, 4097)
        after = os.fstat(handle)
        if len(raw) > 4096 or (info.st_size, info.st_mtime_ns, info.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise ValueError('Plan approval refused')
        value = json.loads(raw.decode('utf-8'), object_pairs_hook=unique)
        if not isinstance(value, dict) or set(value) != {'requestId', 'sessionId', 'nonce'} or value['requestId'] != request_id or value['sessionId'] != session_id or not isinstance(value['nonce'], str) or not re.fullmatch(r'[a-f0-9]{64}', value['nonce']):
            raise ValueError('Plan approval refused')
        payload['nonce'] = value['nonce']
        return json.dumps(payload, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    finally:
        if handle is not None:
            os.close(handle)
        os.close(directory)


class OfficeAPI:
    """A laptop's office phone: fixed identity and upstream, bounded HTTP only."""
    slots = threading.BoundedSemaphore(32)

    def __init__(self, directory, session_id, address, company_root, host_actions=None):
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        if directory.is_symlink():
            raise ValueError('Invalid office connection directory')
        path = directory/'office.sock'
        if path.exists():
            if not path.is_socket(): raise ValueError('Refusing a non-socket office connection')
            path.unlink()
        api = self
        self.tokens, self.updated = 40., time.monotonic()
        self.rate_lock = threading.Lock()
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def request(self):
                upstream = None
                try:
                    with api.rate_lock:
                        now = time.monotonic(); api.tokens = min(40., api.tokens+(now-api.updated)*10); api.updated = now
                        if api.tokens < 1: self.send_error(429); return
                        api.tokens -= 1
                    parsed = urlsplit(self.path)
                    if parsed.scheme or parsed.netloc or not parsed.path.startswith('/api/'):
                        self.send_error(403); return
                    length = int(self.headers.get('Content-Length', '0'))
                    if not 0 <= length <= 8*1024*1024 or self.headers.get('Transfer-Encoding'):
                        self.send_error(413); return
                    host_path = parsed.path == '/api/host-actions' or parsed.path.startswith('/api/host-actions/')
                    if host_path and (length > 16*1024 or parsed.query or len(self.headers.get_all('Content-Length',[]))>1):
                        self.send_error(400); return
                    if PLAN_DECISION.fullmatch(parsed.path) and length > 64*1024:
                        self.send_error(413); return
                    body = self.rfile.read(length)
                    try:
                        approval = office_plan_approval(company_root, session_id, parsed.path, self.command, parsed.query, body)
                    except (OSError, ValueError, UnicodeError):
                        self.send_error(403, 'Plan approval unavailable; check request and owner authorization'); return
                    if approval is not None:
                        body = approval
                    if host_path:
                        if host_actions is None:
                            self.send_error(503); return
                        if parsed.path == '/api/host-actions' and self.command == 'GET' and not body:
                            method,params='list',{}
                        elif parsed.path == '/api/host-actions' and self.command == 'POST':
                            payload=json.loads(body)
                            if not isinstance(payload,dict) or set(payload)!={'operation'}:
                                self.send_error(400); return
                            method,params='request',payload
                        elif self.command == 'GET' and SESSION.fullmatch(parsed.path.removeprefix('/api/host-actions/')) and not body:
                            method,params='get',{'id':parsed.path.removeprefix('/api/host-actions/')}
                        else:
                            self.send_error(403); return
                        # Session comes from this host-owned office socket, never
                        # headers, JSON identity claims or laptop credentials.
                        from .host_action_http import HostActionRefused, HostActionUnconfirmed
                        try:
                            data=host_actions(session_id,method,params)
                        except (HostActionRefused, HostActionUnconfirmed) as error:
                            status=error.status if isinstance(error,HostActionRefused) else 502
                            raw=json.dumps({'success':False,'error':
                                'Host request refused; refresh its status' if isinstance(error,HostActionRefused)
                                else 'Host response unconfirmed; refresh its status before another request'}).encode()
                            self.send_response(status);self.send_header('Content-Type','application/json')
                            self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
                            return
                        raw=json.dumps({'success':True,'data':data}).encode()
                        if len(raw)>64*1024:
                            self.send_error(413); return
                        self.send_response(200); self.send_header('Content-Type','application/json')
                        self.send_header('Content-Length',str(len(raw))); self.end_headers(); self.wfile.write(raw)
                        return
                    hooks = parsed.path in ['/api/hook-event', '/api/status-telemetry']
                    if hooks and json.loads(body).get('sessionId') != session_id:
                        self.send_error(403); return
                    env = dict(line.split('=', 1) for line in (company_root/'console/.env').read_text().splitlines() if '=' in line)
                    import base64
                    credentials = base64.b64encode((env.get('REVERIE_USERNAME', 'admin')+':'+env['REVERIE_PASSWORD']).encode()).decode()
                    banned = {'authorization', 'cookie', 'x-reverie-service-token', 'x-reverie-parent-session', 'x-reverie-hook-secret', 'host', 'origin', 'connection', 'upgrade', 'transfer-encoding', 'content-length'}
                    headers = {k: v for k, v in self.headers.items() if k.lower() not in banned}
                    headers.update(Host='localhost:3000', Authorization='Basic '+credentials, **{'X-Reverie-Parent-Session': session_id, 'Content-Length': str(len(body))})
                    if hooks: headers['X-Reverie-Hook-Secret'] = (company_root/'console/hook-secret').read_text().strip()
                    upstream = http.client.HTTPConnection(address() if callable(address) else address, 3000, timeout=310)
                    upstream.request(self.command, self.path, body=body, headers=headers)
                    response = upstream.getresponse()
                    self.send_response(response.status)
                    for key, value in response.getheaders():
                        if key.lower() not in ['set-cookie', 'connection', 'transfer-encoding']:
                            self.send_header(key, value)
                    self.send_header('Connection', 'close'); self.end_headers()
                    remaining = 32*1024*1024
                    while remaining > 0:
                        chunk = response.read1(min(65536, remaining))
                        if not chunk: break
                        self.wfile.write(chunk); self.wfile.flush(); remaining -= len(chunk)
                except (OSError, ValueError, KeyError, RuntimeError, http.client.HTTPException):
                    self.close_connection = True
                finally:
                    if upstream: upstream.close()
            do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_HEAD = request
        class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
            daemon_threads = True
            request_queue_size = 4
            local_slots = threading.BoundedSemaphore(4)
            def process_request(self, request, address):
                if not self.local_slots.acquire(blocking=False):
                    self.shutdown_request(request); return
                if not api.slots.acquire(blocking=False):
                    self.local_slots.release(); self.shutdown_request(request); return
                try:
                    super().process_request(request, address)
                except BaseException:
                    api.slots.release(); self.local_slots.release(); raise
            def process_request_thread(self, request, address):
                try:
                    super().process_request_thread(request, address)
                finally:
                    api.slots.release(); self.local_slots.release()
            def get_request(self):
                connection, address = super().get_request(); connection.settimeout(15); return connection, address
        self.server = Server(str(path), Handler)
        path.chmod(0o600)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(2)


class Broker:
    def __init__(self, config, engine='docker', config_file=None, host_actions=None):
        self.config, self.engine = config, engine
        self.host_actions = host_actions
        self.config_file = config_file
        self.lock = threading.RLock()
        self.active = {}
        self.laptops = {}
        self.offices = {}
        self.draining = threading.Event()
        self.address_lock = threading.Lock()
        self.address_cache = None
        self.address_updated = 0.
        self.generation = 0
        self.maintenance_lock = threading.Lock()
        self.last_maintenance = 0.
        self.stopping = threading.Event()
        self.nix_prepare_lock = threading.Lock()
        self.storage_lease_lock = threading.RLock()
        self.storage_leases = {}
        self.connections = threading.BoundedSemaphore(config['maxWorkers'] + 4)

    def run_engine(self, args, optional=False):
        result = subprocess.run([self.engine, *args], capture_output=True, text=True, timeout=20)
        if result.returncode and not optional:
            # Engine diagnostics can contain credentials or owner-selected paths.
            raise RuntimeError('Worker engine operation failed: ' + args[0])
        return result

    def check_pool(self, root=Path('/sys/fs/cgroup/reverie.slice/reverie-workers.slice'), config=None, require_headroom=True):
        config = self.config if config is None else config
        if config['budgetMode'] == 'admission':
            if config['memoryMiB'] < 512:
                raise RuntimeError('An individual memory ceiling is required before admitting workers')
            return
        try:
            memory = (root / 'memory.max').read_text().strip()
            tasks = (root / 'pids.max').read_text().strip()
            current = int((root / 'pids.current').read_text())
            if memory == 'max' or int(memory) > config['poolMemoryMiB'] * 1024 * 1024 or tasks == 'max' or int(tasks) > config['poolTasksMax']:
                raise ValueError
        except (OSError, ValueError):
            raise RuntimeError('Activate the owner-managed worker slice with its memory and task ceilings before starting isolated agents')
        if require_headroom and int(tasks) - current < 64:
            raise RuntimeError('Worker pool has insufficient task headroom')

    def allowed(self, session_id):
        try:
            employees = json.loads(Path(self.config['companyFile']).read_text())['employees']
        except (OSError, ValueError, KeyError):
            raise RuntimeError('Company state is unavailable; refusing worker execution')
        employee = next((e for e in employees if e.get('sessionId') == session_id), None)
        if employee is not None:
            return not employee.get('onVacation') and employee.get('desiredRunning') is not False
        # Detaching a terminal intentionally leaves its laptop running through
        # website restarts. A finished/rolled-back plan move is different: its
        # durable transaction identifies exactly which detached laptop to stop.
        journal = Path(self.config['companyFile']).with_name('plan-moves.json')
        try:
            moves = read_metadata(journal, self.config['uid'], limit=1024*1024)
            if not isinstance(moves, list):
                raise ValueError('invalid plan journal')
            for move in moves:
                if (move.get('oldSession') == session_id and
                        (move.get('sourceStopRequested') is True or move.get('phase') in ('stopping', 'completed')) or
                        move.get('newSession') == session_id and move.get('phase') == 'failed'):
                    return False
        except FileNotFoundError:
            pass
        except (OSError, ValueError, AttributeError):
            raise RuntimeError('Plan move state is unavailable; refusing detached worker execution')
        return True

    def stop(self, name, *, retain_storage=False):
        self.run_engine(['stop', '--time', '2', name], optional=True)
        state = self.run_engine(['inspect', name], optional=True)
        if state.returncode == 0 and json.loads(state.stdout)[0]['State']['Running']:
            self.run_engine(['kill', name])
            state = self.run_engine(['inspect', name])
            if json.loads(state.stdout)[0]['State']['Running']:
                raise RuntimeError('Laptop did not stop')
        sid = name.removeprefix(self.config['deployment']+'-agent-')
        if SESSION.fullmatch(sid) and not retain_storage:
            self.release_storage(sid)
        network = name+'-lan'
        result = self.run_engine(['network', 'inspect', network], optional=True)
        if result.returncode == 0:
            labels = json.loads(result.stdout)[0].get('Labels', {}) or {}
            if labels.get('reverie.worker') == self.config['deployment'] and labels.get('reverie.session') == name.removeprefix(self.config['deployment']+'-agent-'):
                self.run_engine(['network', 'disconnect', '--force', network, name], optional=True)
                self.run_engine(['network', 'rm', network], optional=True)

    def check_storage_writers(self, paths, session_id):
        """Actual engine mount inventory closes the broker-restart lock gap."""
        listed=self.run_engine(['ps','--quiet','--no-trunc']).stdout.split()
        if len(listed)>128 or len(listed)!=len(set(listed)) or any(not re.fullmatch('[0-9a-f]{64}', value) for value in listed):
            raise RuntimeError('Cannot establish employee storage writer inventory')
        if not listed:return
        items=json.loads(self.run_engine(['inspect',*listed]).stdout)
        if not isinstance(items,list) or {item.get('Id') for item in items}!=set(listed):
            raise RuntimeError('Employee storage writer inventory changed')
        for item in items:
            if item.get('State',{}).get('Running') is not True:
                raise RuntimeError('Employee storage writer state changed')
            labels=item.get('Config',{}).get('Labels') or {}
            named=item.get('Name')=='/'+self.config['deployment']+'-agent-'+session_id
            own=(named and labels.get('reverie.worker')==self.config['deployment'] and
                 labels.get('reverie.session')==session_id and labels.get('reverie.employee')==paths.identity)
            required={(str(paths.home),'/home/agent'),(str(paths.nix),'/nix')}
            found={(mount.get('Source'),mount.get('Destination')) for mount in item.get('Mounts',[])
                   if mount.get('Type')=='bind' and mount.get('RW') is True}
            if named and (not own or not required<=found):
                raise RuntimeError('Employee laptop requires explicit canonical-storage recreation')
            for mount in item.get('Mounts',[]):
                if mount.get('Type')!='bind' or mount.get('RW') is not True:continue
                source=Path(mount['Source']).resolve()
                overlaps=any(source==root or source.is_relative_to(root) or root.is_relative_to(source)
                             for root in (paths.home,paths.nix))
                exact_own=own and (str(source),mount.get('Destination')) in required
                if overlaps and not exact_own:
                    raise RuntimeError('Another running container owns employee home or Nix data')

    def claim_storage(self, session_id):
        paths=storage_paths(self.config,session_id)
        if paths.kind!='employee':return paths,False
        with self.storage_lease_lock:
            previous=self.storage_leases.get(session_id)
            if previous:
                if previous[1]!=paths:raise RuntimeError('Employee laptop binding changed')
                self.check_storage_writers(paths,session_id)
                return paths,False
            if any(value[1].key==paths.key for value in self.storage_leases.values()):
                raise BlockingIOError('The previous employee laptop still owns its data')
            guard=storage_guard(self.config,session_id);paths=guard.__enter__()
            try:self.check_storage_writers(paths,session_id)
            except BaseException:
                guard.__exit__(None,None,None);raise
            self.storage_leases[session_id]=(guard,paths)
            return paths,True

    def release_storage(self, session_id):
        with self.storage_lease_lock:
            previous=self.storage_leases.pop(session_id,None)
            if previous:previous[0].__exit__(None,None,None)

    def address(self):
        with self.address_lock:
            if self.address_cache and time.monotonic()-self.address_updated < 2:
                return self.address_cache
            server = json.loads(self.run_engine(['inspect', self.config['serverContainer']]).stdout)[0]
            address = server['NetworkSettings']['Networks'].get('bridge', {}).get('IPAddress')
            if not server['State']['Running'] or not address:
                raise RuntimeError('Office API is unavailable')
            self.address_cache, self.address_updated = address, time.monotonic()
            return address

    def office(self, session_id):
        if session_id not in self.offices:
            self.offices[session_id] = OfficeAPI(Path(self.config['apiSocketRoot'])/session_id, session_id, self.address, Path(self.config['companyRoot']),host_actions=self.host_actions)
        return self.offices[session_id]

    def recover(self):
        result = self.run_engine(['ps', '--filter', 'label=reverie.worker=' + self.config['deployment'], '--format', '{{.Names}}'])
        names=result.stdout.splitlines()
        if len(names)!=len(set(names)):raise RuntimeError('Duplicate laptop recovery inventory')
        selected={name.removeprefix(self.config['deployment']+'-agent-'):name for name in names
                  if SESSION.fullmatch(name.removeprefix(self.config['deployment']+'-agent-'))}
        leases=[];offices=[]
        try:
            if len(selected)>self.config['maxWorkers'] or (self.config['budgetMode']=='admission' and
                 sum(effective_config(self.config,s)['memoryMiB'] for s in selected
                     if effective_config(self.config,s)['budgetMode']=='admission')>self.config['poolMemoryMiB']):
                raise RuntimeError('Running laptops exceed the configured admission budget')
            # Complete writer/lease validation before opening any public phone.
            for sid in selected:
                paths,created=self.claim_storage(sid)
                if created:leases.append(sid)
                if paths.kind=='employee':validate_storage(self.config,paths)
            for sid in selected:
                existing=sid in self.offices;self.office(sid)
                if not existing:offices.append(sid)
            self.laptops.update(selected)
        except BaseException:
            for sid in offices:
                office=self.offices.pop(sid,None)
                if office:office.close()
            for sid in leases:self.release_storage(sid)
            raise

    def stop_laptops(self):
        with self.lock:
            self._stop_laptops_locked()

    def _stop_laptops_locked(self):
        self.draining.set()
        self.generation += 1
        try:
            # Include detached laptops and anything recovered after a broker restart.
            names = self.run_engine(['ps', '--filter', 'label=reverie.worker='+self.config['deployment'], '--format', '{{.Names}}']).stdout.splitlines()
            for name in names:
                if SESSION.fullmatch(name.removeprefix(self.config['deployment']+'-agent-')):
                    self.stop(name)
            remaining = self.run_engine(['ps', '--filter', 'label=reverie.worker='+self.config['deployment'], '--format', '{{.Names}}']).stdout.strip()
            if remaining:
                raise RuntimeError('Some laptops could not be stopped; the website is being kept online')
            with self.lock:
                self.laptops.clear()
                offices = list(self.offices.values())
                self.offices.clear()
            for office in offices:
                office.close()
        finally:
            self.draining.clear()

    def check_creation_budget(self, session_id, resources, pool_root=Path('/sys/fs/cgroup/reverie.slice/reverie-workers.slice'), proc_root=Path('/proc')):
        # Every create/recreate replaces only this target's reservation. Actual
        # running peer ceilings, not requested configs or tracking membership,
        # determine how much of the owner budget is already reserved.
        listed=set(self.run_engine(['ps','--filter','label=reverie.worker='+self.config['deployment'],'--format','{{.Names}}']).stdout.splitlines())
        names=listed|set(self.laptops.values())
        peers=0
        outside=0
        has_pool=resources['budgetMode']=='pool'
        for name in names:
            sid=name.removeprefix(self.config['deployment']+'-agent-')
            if not SESSION.fullmatch(sid):
                raise RuntimeError('Unknown laptop in resource admission')
            if sid==session_id:
                continue
            result=self.run_engine(['inspect',name],optional=True)
            if result.returncode:
                if name in listed:
                    raise RuntimeError('Cannot inspect a running peer for resource admission')
                continue
            records=json.loads(result.stdout)
            if not isinstance(records,list) or len(records)!=1:
                raise RuntimeError('Cannot identify a peer for resource admission')
            item=records[0]
            labels=item['Config']['Labels'] or {}
            if (type(item['State']['Running']) is not bool or labels.get('reverie.worker')!=self.config['deployment'] or
                labels.get('reverie.session')!=sid):
                raise RuntimeError('Laptop resource ownership mismatch')
            if item['State']['Running'] is False:
                continue
            peers+=1
            pid=item['State']['Pid']
            if type(pid) is not int or pid<=0:
                raise RuntimeError('Unknown peer process during resource admission')
            groups=(proc_root/str(pid)/'cgroup').read_text().splitlines()
            if len(groups)!=1 or not groups[0].startswith('0::/'):
                raise RuntimeError('Unified peer cgroup identity required')
            if groups[0][3:].startswith('/reverie.slice/reverie-workers.slice/'):
                has_pool=True
                continue
            memory=item['HostConfig']['Memory']
            swap=item['HostConfig']['MemorySwap']
            if type(memory) is not int or memory<=0 or swap!=memory:
                raise RuntimeError('Outside-pool peer requires finite RAM and zero swap')
            outside+=memory
        if peers+1>self.config['maxWorkers']:
            raise RuntimeError('Worker capacity is full')
        if resources['budgetMode']=='admission':
            outside+=resources['memoryMiB']*1024*1024
            if outside>self.config['poolMemoryMiB']*1024*1024:
                raise RuntimeError('Worker memory admission is full; actual peer ceilings reserve the budget')
        if not has_pool:
            return
        pool=0
        if has_pool:
            pool=int((pool_root/'memory.max').read_text())
            tasks=int((pool_root/'pids.max').read_text())
            if pool<=0 or tasks<=0:
                raise RuntimeError('Finite positive shared pool limits required')
        total_kib=int(next(line.split()[1] for line in (proc_root/'meminfo').read_text().splitlines() if line.startswith('MemTotal:')))
        if pool+outside+8192*1024*1024>total_kib*1024*.9:
            raise RuntimeError('Pool plus actual peer ceilings exceed host headroom')

    def reload_resources(self):
        if not self.config_file:
            raise ValueError('Resource reload requires an owner configuration file')
        with self.lock:
            updated = load_config(self.config_file)
            validate_resource_reload(self.config,updated)
            # Serialize with launch, and refuse a new policy for any live program.
            for sid,name in self.laptops.items():
                previous=self.run_engine(['inspect',name],optional=True)
                if previous.returncode:
                    raise ValueError('Cannot verify an existing laptop during resource reload')
                item=json.loads(previous.stdout)[0]
                if item['State']['Running']:
                    labels=item['Config']['Labels'] or {}
                    if (labels.get('reverie.worker')!=self.config['deployment'] or
                        labels.get('reverie.session')!=sid or
                        labels.get('reverie.worker-policy')!=policy_digest(updated,sid)):
                        raise ValueError('Stop only the selected idle laptop before changing its resource policy')
            self.config=updated
        return {'action':'reload-resources','success':True}

    def running_sessions(self):
        # Owner-only broker inventory, never inferred from website tmux metadata.
        running = []
        for sid, name in list(self.laptops.items()):
            result = self.run_engine(['inspect', name], optional=True)
            if result.returncode:
                continue
            item = json.loads(result.stdout)[0]
            labels = item['Config']['Labels'] or {}
            if (not item['State']['Running'] or labels.get('reverie.worker') != self.config['deployment'] or
                    labels.get('reverie.session') != sid or not self.allowed(sid)):
                continue
            home = storage_paths(self.config,sid).home
            try:
                metadata = json.loads((Path(self.config['stateRoot'])/sid/'runtime.json').read_text())
                if (home / '.reverie-launch' / metadata['exit']).exists():
                    continue
            except (OSError, ValueError, KeyError):
                continue
            pane = self.run_engine(tmux_exec_args(name, 'display-message', '-p', '-t', 'office', '#{pane_dead}'), optional=True)
            if pane.returncode == 0 and pane.stdout.strip() == '0':
                running.append(sid)
        return sorted(running)

    def control(self, action, caller=None):
        if caller is not None and (action != 'restart-website' or caller not in self.config['maintenanceSessions']):
            raise ValueError('This laptop has no owner-granted website maintenance permission')
        if action == 'reload-resources':
            return self.reload_resources()
        if action == 'status':
            with self.lock:
                return {'runningLaptops': len(self.laptops), 'runningSessionIds': self.running_sessions(), 'offlineGraceSeconds': OFFLINE_GRACE_SECONDS}
        if action not in ['stop-laptops', 'shutdown', 'restart-website']:
            raise ValueError('Unknown office power action')
        if action in ['stop-laptops', 'shutdown']:
            self.stop_laptops()
        if action in ['shutdown', 'restart-website']:
            if not self.maintenance_lock.acquire(blocking=False):
                raise RuntimeError('Website maintenance is already running')
            if action == 'restart-website' and time.monotonic()-self.last_maintenance < 60:
                self.maintenance_lock.release()
                raise RuntimeError('Wait one minute between website restarts')
            self.last_maintenance = time.monotonic()
            def website():
                try:
                    time.sleep(1)  # Let the HTTP acknowledgement reach the owner.
                    self.run_engine(['stop' if action == 'shutdown' else 'restart', '--time', '20', self.config['serverContainer']], optional=True)
                finally:
                    self.maintenance_lock.release()
            threading.Thread(target=website, daemon=True).start()
        return {'action': action, 'success': True}

    def supervise(self):
        offline = Path(self.config['stateRoot'])/'office-offline-since'
        while not self.stopping.wait(2):
            healthy = False
            try:
                upstream = http.client.HTTPConnection(self.address(), 3000, timeout=2)
                try:
                    upstream.request('GET', '/api/status', headers={'Host': 'localhost:3000'})
                    healthy = upstream.getresponse().status in [200, 401, 403]
                finally:
                    upstream.close()
            except (OSError, ValueError, RuntimeError, http.client.HTTPException, subprocess.SubprocessError):
                pass
            if healthy:
                if offline.exists():
                    print('Office API recovered; laptop outage timer cleared.', file=sys.stderr, flush=True)
                offline.unlink(missing_ok=True)
            else:
                if not offline.exists():
                    offline.write_text(str(time.time()))
                    print('Office API unavailable; laptops will stop after 10 minutes without recovery.', file=sys.stderr, flush=True)
                try:
                    if time.time()-float(offline.read_text()) >= OFFLINE_GRACE_SECONDS:
                        self.stop_laptops()
                except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
                    pass  # Retry next tick, never declare a failed stop complete.
            with self.lock:
                laptops = list(self.laptops.items())
                attached = set(self.active)
            for sid, name in laptops:
                if sid in attached:
                    continue
                try:
                    record = Path(self.config['stateRoot'])/sid/'runtime.json'
                    completed = False
                    if record.is_file():
                        metadata = json.loads(record.read_text())
                        completed = (storage_paths(self.config,sid).home/'.reverie-launch'/metadata['exit']).is_file()
                    if completed or not self.allowed(sid):
                        self.stop(name)
                    state = self.run_engine(['inspect', name], optional=True)
                    running = state.returncode == 0 and json.loads(state.stdout)[0]['State']['Running']
                    if not running:
                        self.release_storage(sid)
                        with self.lock:
                            self.laptops.pop(sid, None)
                        office = self.offices.pop(sid, None)
                        if office: office.close()
                except (OSError, ValueError, RuntimeError, KeyError, subprocess.SubprocessError):
                    pass

    def handle(self, connection):
        name = None
        child = None
        master = slave = None
        launch = None
        session_id = None
        claimed = False
        owned = False
        admitted = False
        started = False
        existing_running = False
        exit_file = None
        nix_guard = None
        storage_claimed = False
        try:
            connection.settimeout(10)
            peer = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            if peer[1] != self.config['uid']:
                raise ValueError('Worker peer identity is not authorized')
            kind, raw = receive_frame(connection)
            if kind == b'C':
                control = json.loads(raw)
                if not isinstance(control, dict) or set(control) - {'action', 'caller'}:
                    raise ValueError('Invalid office power request')
                result = self.control(control['action'], control.get('caller'))
                send_frame(connection, b'J', json.dumps(result).encode())
                return
            if kind != b'J':
                raise ValueError('Expected worker launch request')
            request = validate_request(json.loads(raw), self.config)
            if self.config_file:
                updated = load_config(self.config_file)
                with self.lock:
                    if {**self.config, 'image': updated['image']} != updated:
                        raise RuntimeError('Restart the host broker after changing worker policy')
                    self.config = updated
            session_id = request['sessionId']
            generation = self.generation
            # Wait outside the broker mutex: a source plan-move laptop must
            # finish stopping before its successor can acquire the same home.
            storage_deadline=time.monotonic()+10
            while True:
                if self.stopping.is_set() or not self.allowed(session_id):
                    raise ValueError('This expert is stopped or on vacation')
                try:
                    paths,storage_claimed=self.claim_storage(session_id);break
                except BlockingIOError:
                    if time.monotonic()>=storage_deadline:raise RuntimeError('Previous employee laptop has not released its data')
                    self.stopping.wait(.1)
            with self.lock:
                if generation != self.generation or self.stopping.is_set() or self.draining.is_set() or session_id in self.active:
                    raise ValueError('A worker for this session is already attached')
                if not self.allowed(session_id):
                    raise ValueError('This expert is stopped or on vacation')
                self.active[session_id] = connection
                self.laptops[session_id] = self.config['deployment']+'-agent-'+session_id
                claimed = True
                prepare_storage(self.config,paths)
                home=paths.home
                runtime_directory=Path(self.config['stateRoot'])/session_id
                private_directory(runtime_directory,self.config['uid'],create=True)
                if home.is_symlink() or home.resolve() != home:
                    raise ValueError('Invalid worker home')
                scratch=paths.scratch
                name, digest, args = create_args(self.config, session_id, home, scratch=scratch,storage=paths)
                previous = self.run_engine(['inspect', name], optional=True)
                reuse = False
                metadata_path = runtime_directory/'runtime.json'
                if previous.returncode == 0:
                    old = json.loads(previous.stdout)[0]
                    labels = old['Config']['Labels']
                    if labels.get('reverie.worker') != self.config['deployment'] or labels.get('reverie.session') != session_id:
                        raise ValueError('Existing container is not owned by this deployment')
                    owned = True
                    if old['State']['Running']:
                        existing_running = True
                        policy = args[args.index('reverie.worker-config='+digest)+2].split('=', 1)[1]
                        if labels.get('reverie.worker-policy') != policy:
                            raise ValueError('Running laptop policy differs; explicitly stop it before changing its grants')
                        metadata = json.loads(metadata_path.read_text())
                        exit_file = home/'.reverie-launch'/metadata['exit']
                        if not exit_file.exists():
                            reuse = True
                if request.get('attachOnly') and not reuse:
                    raise ValueError('The existing laptop is unavailable; reconnect never starts a replacement')
                if request.get('attachOnly'):
                    pane = self.run_engine(tmux_exec_args(name, 'display-message', '-p', '-t', 'office', '#{pane_dead}'), optional=True)
                    if pane.returncode or pane.stdout.strip() != '0':
                        raise ValueError('The existing laptop process has exited')
                resources=effective_config(self.config,session_id)
                if reuse and resources['budgetMode']=='pool':
                    self.check_pool(config=resources,require_headroom=False)
                if not reuse:
                    if not storage_start_allowed(self.config,paths):
                        raise ValueError('Only the current employee session may start its laptop')
                    resources=effective_config(self.config,session_id)
                    if 'sessionResources' in self.config:
                        self.check_pool(config=resources)
                    else:
                        self.check_pool()
                    self.check_creation_budget(session_id,resources)
                admitted = True
                if previous.returncode==0 and not reuse:
                    if paths.kind=='employee':self.stop(name,retain_storage=True)
                    else:self.stop(name)
                if not reuse:
                    record_storage_binding(self.config,paths)
                    nix_guard = store_guard(self.config, session_id)
                    nix_guard.__enter__()
                    # Store copies may take time. Keep existing office phones,
                    # control actions and terminal attachments responsive.
                    prepared_config = effective_config(self.config, session_id)
                    if rootless_docker_enabled(prepared_config):
                        image = json.loads(self.run_engine(['image', 'inspect', prepared_config['image']]).stdout)
                        if not isinstance(image, list) or len(image) != 1 or image[0].get('Id') != prepared_config['image']:
                            raise RuntimeError('Rootless Docker image identity is unconfirmed')
                        require_docker_image(prepared_config, image[0])
                    self.lock.release()
                    try:
                        nix_store = prepare_store(self, prepared_config, session_id)
                    finally:
                        self.lock.acquire()
                    if generation != self.generation or self.stopping.is_set() or self.draining.is_set() or not self.allowed(session_id):
                        raise RuntimeError('Laptop launch cancelled during Nix preparation')
                    if effective_config(self.config, session_id) != prepared_config:
                        raise RuntimeError('Laptop policy changed during Nix preparation; retry with the current policy')
                    if storage_paths(self.config,session_id)!=paths:
                        raise RuntimeError('Employee storage binding changed during preparation')
                    if not storage_start_allowed(self.config,paths):
                        raise RuntimeError('Current employee running intent changed during preparation')
                    if paths.kind=='employee':self.check_storage_writers(paths,session_id)
                    self.check_creation_budget(session_id, prepared_config)
                    if nix_store is not None:
                        # Private durable store and database; build caches retain
                        # the existing scratch grant.
                        args[-4:-4] = ['--mount', f'type=bind,src={nix_store},dst=/nix']
                    if previous.returncode == 0:
                        self.run_engine(['rm', name])
                self.office(session_id)
                if not reuse:
                    network = name+'-lan'
                    network_state = self.run_engine(['network', 'inspect', network], optional=True)
                    if network_state.returncode:
                        self.run_engine(['network', 'create', '--label', 'reverie.worker='+self.config['deployment'], '--label', 'reverie.session='+session_id, '--opt', 'com.docker.network.bridge.enable_icc=false', network])
                    else:
                        labels = json.loads(network_state.stdout)[0].get('Labels', {}) or {}
                        if labels.get('reverie.session') != session_id or labels.get('reverie.worker') != self.config['deployment']:
                            raise ValueError('The worker network is not owned by this session')
                    prepare_temporary(self.config, scratch)
                    for directory in ['build', 'cache', 'downloads', 'tasks']:
                        (scratch/directory).mkdir(mode=0o700, exist_ok=True)
                    home_workspace_alias(self.config, home)
                    write_storage_instructions(home)
                    label = scratch/'.reverie-drive.json'
                    if not label.exists():
                        descriptive=({'ownerEmployeeId':paths.identity} if paths.kind=='employee' else {'ownerSessionId':session_id})
                        label.write_text(json.dumps({**descriptive, 'purpose': 'Laptop scratch; release leased tasks with a handoff before pruning', 'createdAt': time.time()}))
                    args[-4:-4] = account_mounts(self.config, request['env'])
                    if not storage_start_allowed(self.config,paths):
                        raise RuntimeError('Current employee running intent changed before creation')
                    self.run_engine(args)
                    owned = True
                    request['env'].update(
                        REVERIE_SESSION_ID=session_id, REVERIE_API_URL='http://127.0.0.1:8093',
                        PATH='/home/agent/.nix-profile/bin:/home/agent/.local/bin:/home/agent/.local/state/nix/profiles/profile/bin:/bin:' + request['env'].get('PATH', '/bin'),
                        NIX_REMOTE='local', NIX_PATH='nixpkgs=flake:nixpkgs')
                    launch_dir = home / '.reverie-launch'
                    launch_dir.mkdir(mode=0o700, exist_ok=True)
                    if launch_dir.is_symlink():
                        raise ValueError('Invalid worker launch directory')
                    nonce = str(uuid.uuid4())
                    launch = launch_dir / (nonce + '.json')
                    exit_file = launch_dir/(nonce+'.exit')
                    fd = os.open(launch, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                    with os.fdopen(fd, 'w') as out:
                        json.dump(request, out)
                    metadata_path.write_text(json.dumps({'exit': exit_file.name}))
                    if not storage_start_allowed(self.config,paths):
                        raise RuntimeError('Current employee running intent changed before startup')
                    self.run_engine(['start', name])
                    wrapper = '/bin/reverie-worker-child "$1"; result=$?; printf "%s" "$result" > "$2.tmp"; mv "$2.tmp" "$2"; exec /bin/sleep infinity'
                    self.run_engine(tmux_exec_args(name, '-f', '/dev/null', 'new-session', '-d', '-x', str(request['cols']), '-y', str(request['rows']), '-s', 'office', '/bin/bash', '-c', wrapper, 'laptop', '/home/agent/.reverie-launch/'+launch.name, '/home/agent/.reverie-launch/'+exit_file.name))
                    self.run_engine(tmux_exec_args(name, 'set-option', '-g', 'status', 'off'))
                    nix_guard.__exit__(None, None, None)
                    nix_guard = None
                started = True
            master, slave = pty.openpty()
            tty.setraw(slave)
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', request['rows'], request['cols'], 0, 0))
            # Docker exec clients can outlive a lost transport. Replace only the
            # old terminal viewer; the office program and tmux pane keep running.
            child = subprocess.Popen([self.engine, *tmux_exec_args(name, 'attach-session', '-d', '-t', 'office', attach=True)], stdin=slave, stdout=slave, stderr=slave, start_new_session=True, close_fds=True)
            os.close(slave)
            slave = None
            attached_at = time.monotonic()
            last_check = time.monotonic()
            with selectors.DefaultSelector() as poller:
                poller.register(connection, selectors.EVENT_READ)
                poller.register(master, selectors.EVENT_READ)
                while not self.stopping.is_set():
                    for key, _ in poller.select(0.25):
                        if key.fileobj is connection:
                            kind, payload = receive_frame(connection)
                            if kind == b'I':
                                view = memoryview(payload)
                                while view:
                                    view = view[os.write(master, view):]
                            elif kind == b'R':
                                cols, rows = json.loads(payload)
                                if type(cols) is not int or type(rows) is not int or not 1 <= cols <= 1000 or not 1 <= rows <= 1000:
                                    raise ValueError('Invalid resize')
                                fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
                                os.kill(child.pid, signal.SIGWINCH)
                            else:
                                raise ValueError('Invalid terminal frame')
                        else:
                            try:
                                output = os.read(master, 65536)
                            except OSError:
                                output = b''
                            if output:
                                send_frame(connection, b'O', output)
                            else:
                                poller.unregister(master)
                    completed = exit_file is not None and exit_file.is_file()
                    result = int(exit_file.read_text()) if completed else child.poll()
                    if result is not None and (not completed or time.monotonic()-attached_at >= .5):
                        # Drain bytes already queued in the PTY before reporting exit.
                        os.set_blocking(master, False)
                        while True:
                            try:
                                output = os.read(master, 65536)
                                if not output:
                                    break
                                send_frame(connection, b'O', output)
                            except (OSError, BlockingIOError):
                                break
                        send_frame(connection, b'X', json.dumps(result).encode())
                        break
                    if time.monotonic() - last_check >= 2:
                        if not self.allowed(session_id):
                            break
                        last_check = time.monotonic()
        except (EOFError, BrokenPipeError, ConnectionError):
            pass
        except Exception as error:
            try:
                message = str(error) if isinstance(error, (ValueError, RuntimeError)) else 'Worker transport failed'
                send_frame(connection, b'E', message.encode()[:1000])
            except OSError:
                pass
        finally:
            if nix_guard is not None:
                nix_guard.__exit__(None, None, None)
            completed = exit_file is not None and exit_file.is_file()
            if admitted and name and owned and ((not started and not existing_running) or completed):
                try:
                    self.stop(name)
                except (OSError, RuntimeError, subprocess.TimeoutExpired):
                    pass
            if child:
                if child.poll() is None:
                    child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait()
            for fd in [master, slave]:
                if fd is not None:
                    os.close(fd)
            if launch and not started:
                launch.unlink(missing_ok=True)
            if claimed:
                with self.lock:
                    self.active.pop(session_id, None)
                    if (not started and not existing_running) or completed:
                        self.laptops.pop(session_id, None)
                        office = self.offices.pop(session_id, None)
                        if office: office.close()
            if storage_claimed:
                # Viewer EOF alone does not end a laptop's data lease. Release
                # only after observing that exact named laptop is no longer live.
                state=self.run_engine(['inspect',self.config['deployment']+'-agent-'+session_id],optional=True)
                if state.returncode or json.loads(state.stdout)[0]['State']['Running'] is False:
                    self.release_storage(session_id)
            connection.close()
            self.connections.release()

    def serve(self):
        self.check_pool()
        path = Path(self.config['socket'])
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if path.parent.is_symlink() or path.parent.stat().st_uid != os.getuid() or path.parent.stat().st_mode & 0o077:
            raise ValueError('Worker socket directory must be owner-only')
        if path.exists() or path.is_symlink():
            if not stat.S_ISSOCK(path.lstat().st_mode):
                raise ValueError('Refusing to replace a non-socket')
            with socket.socket(socket.AF_UNIX) as probe:
                try:
                    probe.connect(str(path))
                except ConnectionRefusedError:
                    path.unlink()
                else:
                    raise ValueError('Another worker broker is already listening')
        self.recover()
        supervisor = threading.Thread(target=self.supervise, daemon=True)
        supervisor.start()
        with socket.socket(socket.AF_UNIX) as listener:
            listener.bind(str(path))
            path.chmod(0o600)
            listener.listen(8)
            listener.settimeout(0.5)
            try:
                while not self.stopping.is_set():
                    try:
                        connection, _ = listener.accept()
                    except TimeoutError:
                        continue
                    if not self.connections.acquire(blocking=False):
                        connection.close()
                        continue
                    threading.Thread(target=self.handle, args=(connection,), daemon=True).start()
            finally:
                self.stopping.set()
                with self.lock:
                    active = list(self.active.values())
                for connection in active:
                    try:
                        connection.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass
                deadline = time.monotonic() + 25
                while self.active and time.monotonic() < deadline:
                    time.sleep(0.1)
                for office in list(self.offices.values()):
                    office.close()
                supervisor.join(5)
                path.unlink(missing_ok=True)


def terminal_size():
    try:
        dimensions = os.get_terminal_size(0)
        return dimensions.columns, dimensions.lines
    except OSError:
        return 120, 40


def client(args):
    path = os.environ.get('REVERIE_WORKER_SOCKET')
    if not path:
        raise ValueError('Worker execution is not configured')
    info = Path(path).lstat()
    if not stat.S_ISSOCK(info.st_mode) or info.st_mode & 0o077:
        raise ValueError('Worker socket is unavailable or not private')
    if args.control:
        with socket.socket(socket.AF_UNIX) as connection:
            connection.settimeout(120)
            connection.connect(path)
            send_frame(connection, b'C', json.dumps({'action': args.control, **({'caller': args.caller_session} if args.caller_session else {})}).encode())
            kind, payload = receive_frame(connection)
            if kind != b'J':
                raise RuntimeError(payload.decode() if kind == b'E' else 'Office power request failed')
            print(payload.decode())
        return 0
    if not all([args.session_id, args.cwd, args.command]):
        raise ValueError('A laptop launch requires session, directory and command')
    cols, rows = terminal_size()
    env = {k: v for k, v in os.environ.items() if ENV_KEY.fullmatch(k)}
    request = dict(sessionId=args.session_id, cwd=args.cwd, command=args.command, env=env, cols=cols, rows=rows)
    if args.attach_only:
        request['attachOnly'] = True
    previous = termios.tcgetattr(0) if os.isatty(0) else None
    resized = threading.Event()
    signal.signal(signal.SIGWINCH, lambda *_: resized.set())
    with socket.socket(socket.AF_UNIX) as connection:
        connection.connect(path)
        send_frame(connection, b'J', json.dumps(request).encode())
        if previous:
            tty.setraw(0)
        try:
            with selectors.DefaultSelector() as poller:
                poller.register(connection, selectors.EVENT_READ)
                poller.register(0, selectors.EVENT_READ)
                while True:
                    if resized.is_set():
                        send_frame(connection, b'R', json.dumps(terminal_size()).encode())
                        resized.clear()
                    for key, _ in poller.select(0.25):
                        if key.fileobj == 0:
                            data = os.read(0, 65536)
                            if not data:
                                return 1
                            send_frame(connection, b'I', data)
                        else:
                            kind, payload = receive_frame(connection)
                            if kind == b'O':
                                view = memoryview(payload)
                                while view:
                                    view = view[os.write(1, view):]
                            elif kind == b'X':
                                return json.loads(payload)
                            elif kind == b'E':
                                print('Reverie worker: ' + payload.decode(), file=sys.stderr)
                                return 1
                            else:
                                raise ValueError('Invalid worker response')
        finally:
            if previous:
                termios.tcsetattr(0, termios.TCSADRAIN, previous)


def child(path):
    path = Path(path)
    info = path.lstat()
    if path.parent != Path('/home/agent/.reverie-launch') or not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('Invalid private launch record')
    request = json.loads(path.read_text())
    path.unlink()
    # Never pass the host broker endpoint or installer authority into a worker.
    env = {**os.environ, **request['env'], 'REVERIE_WORKER': '1', 'REVERIE_INSTALL_CLIS': 'none',
           **temporary_environment(request['cwd'])}
    env.pop('REVERIE_WORKER_SOCKET', None)
    if Path('/run/reverie-model/default.sock').is_socket():
        subprocess.Popen(['/bin/reverie-model-relay'], env={**env, 'REVERIE_MODEL_SOCKET': '/run/reverie-model/default.sock'}, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.Popen(['/bin/reverie-office-relay'], env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    os.chdir(request['cwd'])
    os.execve('/bin/bash', ['bash', '-c', request['command']], env)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='action', required=True)
    serve = commands.add_parser('broker')
    serve.add_argument('--config', required=True)
    execute = commands.add_parser('client')
    execute.add_argument('--control', choices=['status', 'stop-laptops', 'shutdown', 'restart-website', 'reload-resources'])
    execute.add_argument('--caller-session')
    execute.add_argument('--attach-only', action='store_true')
    execute.add_argument('--session-id')
    execute.add_argument('--cwd')
    execute.add_argument('--command')
    launch = commands.add_parser('child')
    launch.add_argument('record')
    args = parser.parse_args()
    os.umask(0o077)
    try:
        if args.action == 'broker':
            broker = Broker(load_config(args.config), config_file=args.config)
            for sig in [signal.SIGTERM, signal.SIGINT]:
                signal.signal(sig, lambda *_: broker.stopping.set())
            broker.serve()
        elif args.action == 'client':
            return client(args)
        else:
            child(args.record)
    except (OSError, ValueError, EOFError, RuntimeError) as error:
        print('Reverie worker unavailable: ' + (str(error) if isinstance(error, ValueError) else type(error).__name__), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
