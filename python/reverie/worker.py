"""Host-owned, bounded agent containers and a terminal-only Unix socket client.

The server may request execution inside a worker, never engine arguments or host
mounts. The owner configures all grants on the host. Workers never mount this
socket, the engine socket, or the host control directory.
"""
from __future__ import annotations

import sys
# Exact packaged helper operations only. Mixed/unknown flags still enter the
# ordinary parser and refuse; this branch never loads broker configuration.
if (__name__ == '__main__' and __package__ and sys.argv[1:] in
        (['client', '--goal-custody'], ['client', '--goal-custody-stream'])):
    from .goal_custody_client import main as _goal_custody_main
    raise SystemExit(_goal_custody_main(stream=sys.argv[-1] == '--goal-custody-stream'))

import argparse
from contextlib import nullcontext
import fcntl
import hashlib
import http.client
import http.server
import ipaddress
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
import math
import tty
import uuid
from urllib.parse import unquote, urlsplit

if __package__:
    from .worker_gpu import gpu_create_args, validate_gpu_grants, validate_gpu_config
    from .worker_resources import effective_config, policy_digest, validate_session_resources, validate_resource_reload
    from .worker_nix import prepare_store, store_guard
    from .worker_tmp import prepare_temporary, temporary_environment, write_storage_instructions, workspace_alias, home_workspace_alias
    from .worker_cold_tmp import policy as cold_tmp_policy, require_no_pending as cold_require_no_pending, initialize_leases as cold_initialize_leases, clear_cold_temporary, strategy as cold_tmp_strategy, read_mount_table, refuse_mount_aliases, refuse_host_mount_aliases
    from .worker_retained_tmp import prepare_retained, finish_retained, retired_root
    from .worker_cold_tmp import _mount_location as _retained_mount_location
    from .worker_storage import storage_paths, storage_guard, prepare_storage, private_directory, storage_start_allowed, record_storage_binding, validate_storage, read_metadata
    from .worker_docker import enabled as rootless_docker_enabled, require_image as require_docker_image, security_args as docker_security_args, runtime_args as docker_runtime_args, require_account_mounts as require_docker_account_mounts
    from .worker_storage_labels import hostname as employee_hostname
    from .goal_assertion import goal_forward_headers
    from .goal_bootstrap import GoalBrokerBootstrap
    from .worker_cleanup import CleanupUnconfirmed, StopBudget, remaining, reap_viewer, run_client, settle_owned_clients, wait_poll
else:
    # Host migration tools also load this file with spec_from_file_location;
    # their sys.path need not contain the sibling module's directory.
    import importlib.util
    _package_root = str(Path(__file__).resolve().parents[1])
    if _package_root not in sys.path:
        sys.path.insert(0, _package_root)
    from reverie.worker_storage import storage_paths, storage_guard, prepare_storage, private_directory, storage_start_allowed, record_storage_binding, validate_storage, read_metadata
    from reverie.worker_docker import enabled as rootless_docker_enabled, require_image as require_docker_image, security_args as docker_security_args, runtime_args as docker_runtime_args, require_account_mounts as require_docker_account_mounts
    from reverie.worker_storage_labels import hostname as employee_hostname
    _gpu_spec = importlib.util.spec_from_file_location('reverie_worker_gpu', Path(__file__).with_name('worker_gpu.py'))
    _gpu_module = importlib.util.module_from_spec(_gpu_spec)
    _gpu_spec.loader.exec_module(_gpu_module)
    gpu_create_args = _gpu_module.gpu_create_args
    validate_gpu_grants = _gpu_module.validate_gpu_grants
    validate_gpu_config = _gpu_module.validate_gpu_config
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
    from reverie.worker_cold_tmp import policy as cold_tmp_policy, require_no_pending as cold_require_no_pending, initialize_leases as cold_initialize_leases, clear_cold_temporary, strategy as cold_tmp_strategy, read_mount_table, refuse_mount_aliases, refuse_host_mount_aliases
    from reverie.worker_retained_tmp import prepare_retained, finish_retained, retired_root
    from reverie.worker_cold_tmp import _mount_location as _retained_mount_location
    prepare_temporary = _tmp_module.prepare_temporary
    temporary_environment = _tmp_module.temporary_environment
    write_storage_instructions = _tmp_module.write_storage_instructions
    workspace_alias = _tmp_module.workspace_alias
    home_workspace_alias = _tmp_module.home_workspace_alias
    _package_root = str(Path(__file__).resolve().parents[1])
    if _package_root not in sys.path:
        sys.path.insert(0, _package_root)
    from reverie.goal_assertion import goal_forward_headers
    from reverie.goal_bootstrap import GoalBrokerBootstrap
    from reverie.worker_cleanup import CleanupUnconfirmed, StopBudget, remaining, reap_viewer, run_client, settle_owned_clients, wait_poll

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
    return validate_config(json.loads(path.read_text()))


def validate_config(config):
    """Validate a captured policy without reopening its configuration path."""
    required = {'version', 'deployment', 'image', 'serverContainer', 'socket', 'stateRoot', 'companyFile', 'companyRoot', 'scratchRoot', 'apiSocketRoot', 'budgetMode', 'uid', 'gid', 'memoryMiB', 'poolMemoryMiB', 'poolTasksMax', 'cgroupParent', 'pidsLimit', 'cpus', 'maxWorkers', 'mounts', 'maintenanceSessions'}
    if not isinstance(config, dict) or set(config) - {'gpuGrants','employeeGpuGrants','employeePerfPolicies','sessionResources','employeeResources','rootlessDocker','goalPrivateConfig','opsConfig','leaseAcceptance','commandTelemetry','coldTemporaryCleanup','resourceReservations','browserJobPolicy','resourceActorConfig'} != required or config['version'] != 1:
        raise ValueError("Unsupported worker configuration")
    from reverie.worker_resource_reservations import option as reservation_option
    reservation_option(config)
    if 'opsConfig' in config:
        if not isinstance(config['opsConfig'], str) or not Path(config['opsConfig']).is_absolute() or Path(config['opsConfig']).anchor != '/' or str(Path(config['opsConfig'])) != config['opsConfig'] or any(ord(c)<32 or ord(c)==127 for c in config['opsConfig']):
            raise ValueError('Invalid private OPS binding')
        try:
            from reverie.ops_service import broker_binding_custody
            broker_binding_custody(config)
        except Exception:
            raise ValueError('Invalid private OPS binding') from None
    if 'browserJobPolicy' in config:
        value=config['browserJobPolicy']
        if not isinstance(value,str) or not Path(value).is_absolute() or Path(value).resolve()!=Path(value):
            raise ValueError('Invalid private fixed-browser-job binding')
    if 'resourceActorConfig' in config:
        value=config['resourceActorConfig']
        if not isinstance(value,str) or not Path(value).is_absolute() or Path(value).resolve()!=Path(value):
            raise ValueError('Invalid private resource-purpose binding')
    from reverie.worker_command_telemetry import configuration
    configuration(config)
    validate_gpu_config(config)
    perf = config.get('employeePerfPolicies', {})
    if type(perf) is not dict:
        raise ValueError('Perf policy requires a bounded employee map')
    if perf:
        from reverie.worker_perf import validate as validate_perf
        validate_perf(config)
    validate_session_resources(config)
    rootless_docker_enabled(config)
    if 'goalPrivateConfig' in config:
        from reverie.goal_private import absolute
        absolute(config['goalPrivateConfig'])
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
    if config.get('leaseAcceptance') is not None:
        _lease_peer_module().validate_option(config)
    cold_tmp_policy(config)
    return config


def _lease_peer_module():
    if __package__:
        from .cleanup import peer_port
        return peer_port
    import importlib.util
    spec = importlib.util.spec_from_file_location('_reverie_lease_peer', Path(__file__).with_name('cleanup') / 'peer_port.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def create_args(config, session_id, home, *, scratch=None, storage=None):
    config = effective_config(config, session_id)
    name = config['deployment'] + '-agent-' + session_id
    digest = hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest()
    policy = hashlib.sha256(json.dumps({k: v for k, v in config.items() if k not in ['image', 'maintenanceSessions', 'opsConfig']}, sort_keys=True).encode()).hexdigest()
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
    require_docker_account_mounts(config,list(mounts))
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

    def __init__(self, directory, session_id, address, company_root, host_actions=None, ops=None, command_telemetry=None, browser_jobs=None):
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
        self.closing = threading.Event()
        self.requests = {}
        self.upstreams = {}
        self.request_threads = {}
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def request(self):
                upstream = None
                try:
                    if api.closing.is_set():
                        self.close_connection = True; return
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
                    browser_path = parsed.path == '/api/browser-jobs' or parsed.path.startswith('/api/browser-jobs/')
                    if browser_path:
                        if parsed.path!='/api/browser-jobs' or self.command!='POST' or parsed.query or length>1024 or len(self.headers.get_all('Content-Length',[]))!=1 or self.headers.get('Content-Type')!='application/json':
                            self.send_error(400);return
                        if browser_jobs is None:
                            self.send_error(503);return
                        from reverie.browser_job_requests import decode_command as browser_command, BrowserJobRefused, BrowserJobUnconfirmed
                        try:
                            value=browser_command(self.rfile.read(length))
                            result=browser_jobs(session_id,value)
                            raw=json.dumps({'success':True,'data':result},separators=(',',':')).encode()
                            if len(raw)>16384:raise BrowserJobUnconfirmed('response bound')
                            status=200
                        except BrowserJobRefused:
                            status=403;raw=b'{"success":false,"errorCode":"BROWSER_JOB_REFUSED"}'
                        except (BrowserJobUnconfirmed,OSError,ValueError,RuntimeError):
                            status=502;raw=b'{"success":false,"errorCode":"BROWSER_JOB_UNCONFIRMED_INSPECT_BEFORE_RETRY"}'
                        self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw);return
                    ops_path = parsed.path == '/api/ops' or parsed.path.startswith('/api/ops/')
                    if ops_path:
                        if parsed.path != '/api/ops' or self.command != 'POST' or parsed.query or length > 16*1024 or len(self.headers.get_all('Content-Length', [])) > 1:
                            self.send_error(400); return
                        if ops is None:
                            # Settle the admitted bounded HTTP body before closing
                            # with 503; otherwise a separate client body write can
                            # race that known refusal and raise BrokenPipeError.
                            deadline = time.monotonic() + 15
                            remaining = length
                            while remaining:
                                left = deadline - time.monotonic()
                                if left <= 0: raise TimeoutError('Office request body deadline')
                                self.connection.settimeout(min(15, left))
                                part = self.rfile.read1(min(remaining, 4096))
                                if not part:
                                    self.send_error(400); return
                                remaining -= len(part)
                            if time.monotonic() >= deadline: raise TimeoutError('Office request body deadline')
                            self.send_error(503); return
                        try:
                            from reverie.ops_common import command as ops_command, strict_json
                            result = ops(session_id, ops_command(strict_json(self.rfile.read(length))))
                            raw = json.dumps(result, separators=(',', ':')).encode()
                            if len(raw) > 64*1024: self.send_error(502); return
                        except Exception:
                            raw = b'{"success":false,"reason":"adapter-unavailable"}'
                        self.send_response(200); self.send_header('Content-Type', 'application/json')
                        self.send_header('Content-Length', str(len(raw))); self.end_headers(); self.wfile.write(raw)
                        return
                    telemetry_path = parsed.path == '/api/command-telemetry/hands'
                    if telemetry_path and (self.command != 'POST' or parsed.query or length > 512 or len(self.headers.get_all('Content-Length', [])) != 1):
                        self.send_error(400); return
                    host_path = parsed.path == '/api/host-actions' or parsed.path.startswith('/api/host-actions/')
                    if host_path and (length > 16*1024 or parsed.query or len(self.headers.get_all('Content-Length',[]))>1):
                        self.send_error(400); return
                    if PLAN_DECISION.fullmatch(parsed.path) and length > 64*1024:
                        self.send_error(413); return
                    body = self.rfile.read(length)
                    if telemetry_path:
                        accepted = command_telemetry is not None and command_telemetry.observe(session_id, body)
                        self.send_response(204 if accepted else 503)
                        self.send_header('Content-Length', '0'); self.end_headers(); return
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
                    # This owner-only release NEVER obtains a worker signer.
                    # Strip supplied proofs and refuse the reserved Goal purpose,
                    # rather than forwarding Basic/parent headers as authority.
                    try:
                        forwarded = goal_forward_headers(session_id, self.command, self.path, body,
                                                         dict(self.headers.items()), None)
                    except ValueError:
                        self.send_error(403); return
                    env = dict(line.split('=', 1) for line in (company_root/'console/.env').read_text().splitlines() if '=' in line)
                    import base64
                    credentials = base64.b64encode((env.get('REVERIE_USERNAME', 'admin')+':'+env['REVERIE_PASSWORD']).encode()).decode()
                    banned = {'authorization', 'cookie', 'x-reverie-service-token', 'x-reverie-parent-session', 'x-reverie-hook-secret', 'host', 'origin', 'connection', 'upgrade', 'transfer-encoding', 'content-length'}
                    headers = {k: v for k, v in forwarded.items() if k.lower() not in banned}
                    headers.update(Host='localhost:3000', Authorization='Basic '+credentials, **{'X-Reverie-Parent-Session': session_id, 'Content-Length': str(len(body))})
                    if hooks: headers['X-Reverie-Hook-Secret'] = (company_root/'console/hook-secret').read_text().strip()
                    upstream = http.client.HTTPConnection(address() if callable(address) else address, 3000, timeout=310)
                    api.upstreams[self.connection] = upstream
                    if api.closing.is_set():
                        self.close_connection = True; return
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
                    api.upstreams.pop(self.connection, None)
                    if upstream: upstream.close()
            do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_HEAD = request
        class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
            daemon_threads = True
            block_on_close = False
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
                api.request_threads[request] = threading.current_thread()
                try:
                    super().process_request_thread(request, address)
                finally:
                    api.slots.release(); self.local_slots.release()
                    api.request_threads.pop(request, None)
            def get_request(self):
                connection, address = super().get_request()
                connection.settimeout(15)
                api.requests[connection] = None
                return connection, address
            def shutdown_request(self, request):
                try:
                    super().shutdown_request(request)
                finally:
                    api.requests.pop(request, None)
        self.server = Server(str(path), Handler)
        self.socket_path = path
        self.socket_identity = None
        try:
            info = path.lstat()
            self.socket_identity = (info.st_dev, info.st_ino)
            path.chmod(0o600)
            self.server.timeout = .05
            self.server.socket.settimeout(.05)
            self.thread = threading.Thread(target=self._serve, daemon=True)
            self.thread.start()
        except BaseException:
            # shutdown() waits for serve_forever: it deadlocks if start failed.
            self.server.server_close()
            self._unlink_socket()
            raise

    def _unlink_socket(self):
        try:
            info = self.socket_path.lstat()
            if stat.S_ISSOCK(info.st_mode) and (info.st_dev, info.st_ino) == self.socket_identity:
                self.socket_path.unlink()
        except FileNotFoundError:
            pass

    def _serve(self):
        while not self.closing.is_set():
            try:
                self.server.handle_request()
            except OSError:
                if not self.closing.is_set():
                    raise

    def request_close(self):
        self.closing.set()
        # Interrupt only these Office sockets. A blocked callback/connection
        # attempt may remain outstanding and is not declared completed.
        for connection in tuple(self.requests):
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        for upstream in tuple(self.upstreams.values()):
            if upstream.sock is not None:
                try:
                    upstream.sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass

    def close(self, deadline=None):
        deadline = time.monotonic() + 2 if deadline is None else deadline
        self.request_close()
        # ThreadingMixIn must never implicitly join request handlers here.
        self.server.server_close()
        self.thread.join(min(2., remaining(deadline)))
        self._unlink_socket()
        return not self.thread.is_alive() and not self.requests and not self.upstreams and not self.request_threads


class Broker:
    def __init__(self, config, engine='docker', config_file=None, host_actions=None):
        self.config, self.engine = config, engine
        self.host_actions = host_actions
        self.lease_peer = None
        self.lease_peer_error = None
        self.ops = None
        if config.get('opsConfig') is not None:
            def ops_call(session, command):
                from reverie.ops_service import phone_client
                return phone_client(config['opsConfig']).call(session, command)
            self.ops = ops_call

        # Custody-only host service. office/recover/new launch deliberately never
        # call signer(), launch_binding() or any runtime-pin writer.
        self.goals = GoalBrokerBootstrap(self)
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
        self.stopping = StopBudget()
        self.cleanup_uncertain = set()
        self.owned_clients = {}
        self.viewers = {}
        self.handlers = {}
        self.cleanup_offices = {}
        self.nix_prepare_lock = threading.Lock()
        self.storage_lease_lock = threading.RLock()
        self.storage_leases = {}
        self.connections = threading.BoundedSemaphore(config['maxWorkers'] + 4)
        from reverie.worker_chat_images import WorkerChatImages
        self.chat_images = WorkerChatImages(self)
        from reverie.worker_command_telemetry import CommandTelemetry
        self.command_telemetry = CommandTelemetry(config, self.run_engine)
        from reverie.worker_resource_reservations import ReservationGate, configured
        self.resource_reservations = ReservationGate(self) if configured(config) else None
        self.resource_actor = None
        if config.get('resourceActorConfig') is not None:
            from reverie.worker_resource_actor import ResourceActorService
            self.resource_actor = ResourceActorService(self)
        self.host_resume = None
        resume_program = Path(__file__).resolve().with_name('worker-resume-program.json')
        if resume_program.exists():
            from reverie.worker_resume import HostWorkerResume
            self.host_resume = HostWorkerResume(self, resume_program)
        self.browser_jobs = None
        if config.get('browserJobPolicy') is not None:
            from reverie.browser_job_requests import BrowserJobRequests
            self.browser_jobs = BrowserJobRequests(self,config['browserJobPolicy'])

    def resource_admission(self, sid=None, *, protected_start=None, deadline=None):
        if self.resource_reservations is None:
            if protected_start is not None:
                raise ValueError('Protected resource admission is unavailable')
            # A removed configuration option must not hide a durable prior fence.
            from reverie.worker_resource_reservations import configured
            if configured(self.config):
                raise ValueError('Resource reservation control requires reconciliation')
            return nullcontext()
        if deadline is not None:
            return self.resource_reservations.admission(sid,protected_start=protected_start,deadline=deadline)
        return self.resource_reservations.admission(sid,protected_start=protected_start)

    def _release_resource_admission(self, guard):
        try:
            guard.__exit__(None, None, None)
        except Exception as error:
            # A program may already be running. Never classify this as a
            # known pre-effect refusal, retry, or successful reservation release.
            self.cleanup_uncertain.add('RESOURCE_ADMISSION_RELEASE_UNCONFIRMED')
            raise RuntimeError('Resource admission release unconfirmed') from error

    def run_engine(self, args, optional=False, *, deadline=None):
        if self.stopping.is_set() and (args[0] in ('create', 'start', 'exec') or args[:2] == ['network', 'create']):
            raise RuntimeError('Laptop launch cancelled while broker is stopping')
        timeout = 20
        if deadline is not None:
            if type(deadline) not in (int, float) or not math.isfinite(deadline):
                raise ValueError('Finite engine observation deadline required')
            timeout = min(timeout, deadline - time.monotonic())
            if timeout <= 0:
                raise RuntimeError('Engine observation deadline exhausted')
        result = run_client([self.engine, *args], timeout=timeout, owner=self)
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

    def stop(self, name, *, retain_storage=False, expected_id=None, expected_process=None):
        gate = getattr(self, 'resource_reservations', None)
        if gate is None:
            from reverie.worker_resource_reservations import configured
            if configured(self.config):
                raise ValueError('Resource reservation control requires reconciliation')
            return Broker._stop_observed(self, name, retain_storage=retain_storage,
                                         expected_id=expected_id, expected_process=expected_process)
        if getattr(gate._local, 'depth', 0):
            gate.check_stop(name, expected_id, expected_process)
            return Broker._stop_observed(self, name, retain_storage=retain_storage,
                                         expected_id=expected_id, expected_process=expected_process)
        with gate.admission():
            gate.check_stop(name, expected_id, expected_process)
            return Broker._stop_observed(self, name, retain_storage=retain_storage,
                                         expected_id=expected_id, expected_process=expected_process)

    def _stop_observed(self, name, *, retain_storage=False, expected_id=None, expected_process=None):
        # Optional private resource-actor path: address the captured immutable
        # CID, never an owner-replaced container which recycled its name.
        target=name
        if expected_process is not None and expected_id is None:
            raise ValueError('Exact source process needs an immutable container identity')
        if expected_id is not None:
            if (not isinstance(expected_id,str) or not re.fullmatch('[0-9a-f]{64}',expected_id) or
                    not name.startswith(self.config['deployment']+'-agent-') or
                    not SESSION.fullmatch(name.removeprefix(self.config['deployment']+'-agent-'))):
                raise ValueError('Exact owned laptop identity required')
            before=self.run_engine(['inspect',name])
            rows=json.loads(before.stdout)
            sid=name.removeprefix(self.config['deployment']+'-agent-')
            if (not isinstance(rows,list) or len(rows)!=1 or rows[0].get('Id')!=expected_id or
                    rows[0].get('Name')!='/'+name or
                    (rows[0].get('Config',{}).get('Labels') or {}).get('reverie.worker')!=self.config['deployment'] or
                    (rows[0]['Config']['Labels'] or {}).get('reverie.session')!=sid or
                    (rows[0]['Config']['Labels'] or {}).get('reverie.worker-policy')!=policy_digest(self.config,sid)):
                raise ValueError('Exact owned laptop identity changed')
            status=rows[0].get('State',{})
            if (type(status.get('Running')) is not bool or type(status.get('Pid')) is not int or
                    (status['Pid']<=0 if status['Running'] else status['Pid']!=0)):
                raise ValueError('Exact owned laptop state is unavailable')
            if expected_process is not None:
                from reverie.worker_resource_reservations import _pid
                if (type(expected_process) is not dict or set(expected_process)!={'pid','start'} or
                        type(expected_process['pid']) is not int or expected_process['pid']<=0 or
                        type(expected_process['start']) is not str or not expected_process['start'].isascii() or
                        not expected_process['start'].isdecimal() or status['Pid']!=expected_process['pid'] or
                        _pid(expected_process['pid'])!=expected_process['start']):
                    raise ValueError('Exact source process incarnation changed')
            target=expected_id
            from reverie.worker_resource_reservations import _pid
            original_pid=status['Pid']
            original_start=_pid(original_pid) if status['Running'] else None
            if expected_process is not None and original_start!=expected_process['start']:
                raise ValueError('Exact source process incarnation changed')
            metadata={key:rows[0].get(key) for key in ('Id','Name','Image','Config','HostConfig','Mounts')}
            def protected_record(result):
                records=json.loads(result.stdout) if result.returncode==0 else []
                if (not isinstance(records,list) or len(records)!=1 or
                        {key:records[0].get(key) for key in metadata}!=metadata):
                    raise RuntimeError('Exact source laptop metadata changed')
                observed=records[0].get('State',{})
                if (type(observed.get('Running')) is not bool or type(observed.get('Pid')) is not int or
                        (observed['Pid']<=0 if observed['Running'] else observed['Pid']!=0)):
                    raise RuntimeError('Exact source laptop state is unavailable')
                return observed
            released=status
            if status['Running']:
                self.run_engine(['stop', '--time', '2', target], optional=True)
                state=self.run_engine(['inspect',target],optional=True)
                released=protected_record(state)
                if released['Running']:
                    # Inspect is the last blocking native operation before the
                    # final original-process check and a possible signal.
                    if released['Pid']!=original_pid or _pid(original_pid)!=original_start:
                        raise RuntimeError('Exact source process incarnation changed before kill')
                    self.run_engine(['kill',target])
                    released=protected_record(self.run_engine(['inspect',target]))
            if released.get('Running') is not False or type(released.get('Pid')) is not int or released['Pid']!=0:
                raise RuntimeError('Exact source laptop release is unconfirmed')
        else:
            self.run_engine(['stop', '--time', '2', target], optional=True)
            state = self.run_engine(['inspect', target], optional=True)
            if state.returncode == 0 and json.loads(state.stdout)[0]['State']['Running']:
                self.run_engine(['kill', target])
                state = self.run_engine(['inspect', target])
                if json.loads(state.stdout)[0]['State']['Running']:
                    raise RuntimeError('Laptop did not stop')
        sid = name.removeprefix(self.config['deployment']+'-agent-')
        if SESSION.fullmatch(sid) and not retain_storage:
            self.release_storage(sid)
        if expected_id is not None:
            # Retain the unused source network. A replacement sharing its name
            # must never be disconnected/deleted by a stale operation.
            return {'containerId':expected_id,'running':False,'networkRetained':True}
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

    def _launch_wait_binding(self, session_id):
        """Current host-selected identity/recipe, never a caller's replacement intent."""
        company=read_metadata(Path(self.config['companyFile']),self.config['uid'])
        employees=company.get('employees')
        if not isinstance(employees,list) or any(not isinstance(row,dict) for row in employees):
            raise ValueError('Current employee launch binding is unavailable')
        rows=[row for row in employees if row.get('sessionId')==session_id]
        if len(rows)>1:
            raise ValueError('Current employee launch binding is ambiguous')
        fields=('id','owner','sessionId','sessionGeneration','desiredRunning','onVacation',
                'bindingMigration','runtimeRecipe','permissions')
        return json.dumps({key:rows[0].get(key) for key in fields},sort_keys=True) if rows else None

    def admit_cold_temporary(self, paths, temporary_keys):
        """Fresh complete engine census; callers already hold this EID lease.

        No provider/engine changes occur here. Successful inspect plus matching
        inventories must establish that the old named laptop is absent and no
        running/paused/restarting bind can read OR write this owned tmp tree.
        """
        if (self.stopping.is_set() or self.draining.is_set() or
                storage_paths(self.config, paths.session) != paths or
                not storage_start_allowed(self.config, paths)):
            raise RuntimeError('Cold temporary binding or running intent changed')
        with self.storage_lease_lock:
            claim = self.storage_leases.get(paths.session)
            if claim is None or claim[1] != paths:
                raise RuntimeError('Cold temporary cleanup requires the employee storage lease')
        listed = self.run_engine(['ps', '--all', '--quiet', '--no-trunc']).stdout.split()
        if len(listed) > 512 or len(set(listed)) != len(listed) or any(not re.fullmatch('[a-f0-9]{64}', item) for item in listed):
            raise RuntimeError('Cold temporary engine inventory is unknown')
        try:
            items = json.loads(self.run_engine(['inspect', *listed]).stdout) if listed else []
        except (ValueError, TypeError):
            raise RuntimeError('Cold temporary engine inspection is unknown') from None
        if (not isinstance(items, list) or len(items) != len(listed) or
                any(not isinstance(item, dict) or not isinstance(item.get('Id'), str) for item in items) or
                {item.get('Id') for item in items} != set(listed)):
            raise RuntimeError('Cold temporary engine inventory changed')
        target = Path(paths.scratch) / 'tmp'
        protected = set(temporary_keys)
        for directory in (target, *target.parents):
            info = directory.stat(); protected.add((info.st_dev, info.st_ino))
            if directory == Path(self.config['scratchRoot']): break
        name = '/' + self.config['deployment'] + '-agent-' + paths.session
        host_table = read_mount_table()
        retained = retired_root(self.config, paths) if cold_tmp_strategy(self.config) == 'retain-and-replace' else None
        # The finalization marker must remain outside future configured grants,
        # as well as current writable namespace aliases. These are host control
        # files; normal private home/Nix mounts are supplied separately.
        for declared in self.config['mounts']:
            refuse_host_mount_aliases(Path(paths.root), Path(declared['source']).resolve(strict=True), host_table)
            if retained is not None:
                refuse_host_mount_aliases(retained, Path(declared['source']).resolve(strict=True), host_table)
        for item in items:
            state = item.get('State', {})
            if (type(state.get('Running')) is not bool or type(state.get('Pid')) is not int or
                    type(state.get('Paused')) is not bool or type(state.get('Restarting')) is not bool or
                    not isinstance(item.get('Mounts'), list)):
                raise RuntimeError('Cold temporary container state is unknown')
            if item.get('Name') == name:
                raise RuntimeError('Prior named laptop must be absent before cold temporary cleanup')
            active = state['Running'] or state['Paused'] or state['Restarting'] or state['Pid'] != 0
            if not active: continue
            binds = [m for m in item['Mounts'] if isinstance(m, dict) and m.get('Type') == 'bind']
            container_table = None
            if binds:
                if host_table is None: host_table = read_mount_table()
                container_table = read_mount_table(state['Pid'])
            for mount in item['Mounts']:
                if not isinstance(mount, dict):
                    raise RuntimeError('Cold temporary mount metadata is unknown')
                if mount.get('Type') != 'bind': continue
                source = mount.get('Source')
                if not isinstance(source, str) or not Path(source).is_absolute():
                    raise RuntimeError('Cold temporary bind inventory is unknown')
                lexical = Path(source); real = lexical.resolve(strict=True); info = real.stat()
                if ((info.st_dev, info.st_ino) in protected or
                        any(p == target or p.is_relative_to(target) or target.is_relative_to(p) for p in (lexical, real))):
                    raise RuntimeError('A live container can access this temporary storage')
                destination = mount.get('Destination')
                if not isinstance(destination, str) or not Path(destination).is_absolute() or str(Path(destination)) != destination:
                    raise RuntimeError('Cold temporary bind destination is unknown')
                refuse_mount_aliases(target, real, Path(destination), host_table, container_table)
                if retained is not None:
                    refuse_mount_aliases(retained, real, Path(destination), host_table, container_table)
                if type(mount.get('RW')) is not bool:
                    raise RuntimeError('Cold temporary bind writability is unknown')
                if mount['RW']:
                    refuse_mount_aliases(Path(paths.root), real, Path(destination), host_table, container_table)
        # Bracket relevant namespace reads with a fresh exact engine binding.
        # A PID restart or changed grant within a stable container ID is drift.
        def projection(rows):
            return sorted([{'id': x['Id'], 'name': x.get('Name'),
                            'state': {k: x.get('State', {}).get(k) for k in ('Running','Paused','Restarting','Dead','Pid','StartedAt')},
                            'mounts': sorted(x.get('Mounts', []), key=lambda m: json.dumps(m, sort_keys=True))}
                           for x in rows], key=lambda x: x['id'])
        try:
            verified = json.loads(self.run_engine(['inspect', *listed]).stdout) if listed else []
            after = self.run_engine(['ps', '--all', '--quiet', '--no-trunc']).stdout.split()
            if (len(after) != len(listed) or set(after) != set(listed) or projection(items) != projection(verified)):
                raise RuntimeError('Cold temporary native binding changed')
        except (ValueError, TypeError, KeyError, AttributeError):
            raise RuntimeError('Cold temporary native reinspection is unknown') from None
        if self.stopping.is_set() or self.draining.is_set() or not storage_start_allowed(self.config, paths):
            raise RuntimeError('Cold temporary admission changed')

    def confirm_retained_temporary(self, paths, ready, created_id):
        """Actual new sleeping laptop binding, before any CLI can consume TMP."""
        if (self.stopping.is_set() or self.draining.is_set() or
                storage_paths(self.config, paths.session) != paths or
                not storage_start_allowed(self.config, paths) or
                cold_tmp_strategy(self.config) != 'retain-and-replace'):
            raise RuntimeError('Retained TMP launch binding changed')
        with self.storage_lease_lock:
            lease = self.storage_leases.get(paths.session)
            if lease is None or lease[1] != paths:
                raise RuntimeError('Retained TMP storage lease is unavailable')
        if not isinstance(created_id, str) or not re.fullmatch('[a-f0-9]{64}', created_id):
            raise RuntimeError('Retained TMP requires the actual created container ID')
        def inspect_created():
            value = json.loads(self.run_engine(['inspect', created_id]).stdout)
            if not isinstance(value, list) or len(value) != 1 or value[0].get('Id') != created_id:
                raise RuntimeError('Retained TMP container identity is unavailable')
            return value[0]
        item = inspect_created(); state = item.get('State', {}); labels = item.get('Config', {}).get('Labels') or {}
        if (item.get('Image') != self.config['image'] or
                item.get('Name') != '/' + self.config['deployment'] + '-agent-' + paths.session or
                labels.get('reverie.worker') != self.config['deployment'] or labels.get('reverie.session') != paths.session or
                (paths.kind == 'employee' and labels.get('reverie.employee') != paths.identity) or
                item.get('Config', {}).get('User') != str(self.config['uid']) + ':' + str(self.config['gid']) or
                item.get('Config', {}).get('Entrypoint') != ['/bin/sleep'] or
                item.get('Config', {}).get('Cmd') != ['infinity'] or
                state.get('Running') is not True or state.get('Paused') is not False or
                state.get('Restarting') is not False or type(state.get('Pid')) is not int or state['Pid'] <= 0):
            raise RuntimeError('Retained TMP canonical container binding differs')
        pid = state['Pid']; proc = Path('/proc') / str(pid)
        before = (proc/'stat').read_text().rsplit(')', 1)[1].split()[19]
        target = Path(paths.scratch)/'tmp'; actual = target.stat()
        if (actual.st_dev, actual.st_ino) != ready.new_key or actual.st_uid != self.config['uid'] or stat.S_IMODE(actual.st_mode) != 0o700:
            raise RuntimeError('Retained TMP fresh inode changed before startup')
        mounts = item.get('Mounts')
        if not isinstance(mounts, list):
            raise RuntimeError('Retained TMP mount inventory is unavailable')
        selected = [m for m in mounts if m.get('Destination') == '/tmp']
        if len(selected) != 1 or selected[0].get('Type') != 'bind' or selected[0].get('Source') != str(target) or selected[0].get('RW') is not True:
            raise RuntimeError('Retained TMP startup mount differs')
        host_table, container_table = read_mount_table(), read_mount_table(pid)
        device, inside = _retained_mount_location(target, host_table)
        actual_tmp = [row for row in container_table if row['point'] == Path('/tmp')]
        if len(actual_tmp) != 1 or actual_tmp[0]['device'] != device or actual_tmp[0]['root'] != inside:
            raise RuntimeError('Retained TMP actual namespace differs')
        for mount in mounts:
            if mount.get('Type') == 'bind':
                refuse_mount_aliases(retired_root(self.config, paths), Path(mount['Source']).resolve(strict=True),
                                     Path(mount['Destination']), host_table, container_table)
        def projection(value):
            return {'id': value.get('Id'), 'image': value.get('Image'), 'name': value.get('Name'),
                    'state': {key: value.get('State', {}).get(key) for key in ('Running','Paused','Restarting','Pid','StartedAt')},
                    'mounts': sorted(value.get('Mounts', []), key=lambda m: json.dumps(m, sort_keys=True)),
                    'labels': value.get('Config', {}).get('Labels'), 'user': value.get('Config', {}).get('User')}
        if (projection(item) != projection(inspect_created()) or before != (proc/'stat').read_text().rsplit(')', 1)[1].split()[19]):
            raise RuntimeError('Retained TMP native container drifted')
        if self.stopping.is_set() or self.draining.is_set() or not storage_start_allowed(self.config, paths):
            raise RuntimeError('Retained TMP current intent changed')
        return {'containerId': created_id, 'image': self.config['image'], 'pid': pid, 'startTick': before}

    def release_storage(self, session_id):
        """Release an exact session's employee data lease. While the broker is stopping, the lock wait is bounded by the
        shared stop budget (Goal composition): not acquired in time -> the lease is retained, STORAGE_LOCK_UNAVAILABLE is
        recorded and False is returned. True when released or when nothing was held."""
        deadline=self.stopping.deadline
        acquired=self.storage_lease_lock.acquire() if deadline is None else self.storage_lease_lock.acquire(timeout=remaining(deadline))
        if not acquired:
            self.cleanup_uncertain.add('STORAGE_LOCK_UNAVAILABLE');return False
        try:
            previous=self.storage_leases.pop(session_id,None)
            if previous:previous[0].__exit__(None,None,None)
            return True
        finally:
            self.storage_lease_lock.release()

    def inspect_container(self, name):
        """A transient or malformed engine reply is unknown, never stopped."""
        result = self.run_engine(['inspect', name], optional=True)
        if result.returncode:
            missing = {
                'Error: No such object: ' + name,
                'Error: no such object: "' + name + '"',
                'Error: inspecting object: no such object: "' + name + '"',
            }
            if (result.returncode not in (1, 125) or result.stderr.strip() not in missing or
                    result.stdout.strip() not in ('', '[]')):
                raise RuntimeError('Worker container state is unavailable')
            # Generic inspect can search several object types. Confirm absence
            # with a successful container inventory, including stopped laptops.
            inventory = self.run_engine(['ps', '--all', '--format', '{{.Names}}'])
            names = inventory.stdout.splitlines()
            if (inventory.returncode or len(names) != len(set(names)) or
                    any(not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]*', value) for value in names) or
                    name in names):
                raise RuntimeError('Worker container state is unavailable')
            return {'State': {'Running': False}}
        try:
            items = json.loads(result.stdout)
            if not isinstance(items, list) or len(items) != 1 or not isinstance(items[0], dict):
                raise ValueError
            item = items[0]
            if not isinstance(item.get('State'), dict) or type(item['State'].get('Running')) is not bool:
                raise ValueError
        except (ValueError, TypeError):
            raise RuntimeError('Worker container state is unavailable') from None
        return item

    def address(self):
        with self.address_lock:
            if self.address_cache and time.monotonic()-self.address_updated < 2:
                return self.address_cache
            server = self.inspect_container(self.config['serverContainer'])
            try:
                address = server['NetworkSettings']['Networks']['bridge']['IPAddress']
                if not server['State']['Running'] or not isinstance(address, str):
                    raise ValueError
                ipaddress.ip_address(address)
            except (KeyError, TypeError, ValueError):
                raise RuntimeError('Office API is unavailable') from None
            self.address_cache, self.address_updated = address, time.monotonic()
            return address

    def office_options(self):
        """OfficeAPI keywords for a new or recovered Office. Command telemetry is passed only when enabled, so the default
        keeps the legacy constructor contract."""
        options = {'host_actions': self.host_actions}
        if self.ops is not None:
            options['ops'] = self.ops
        if self.browser_jobs is not None:
            options['browser_jobs'] = self.browser_jobs.dispatch
        if self.command_telemetry.enabled:
            options['command_telemetry'] = self.command_telemetry
        return options

    def office(self, session_id):
        if self.stopping.is_set():
            raise RuntimeError('Worker broker is stopping')
        if session_id not in self.offices:
            self.offices[session_id] = OfficeAPI(Path(self.config['apiSocketRoot'])/session_id, session_id, self.address, Path(self.config['companyRoot']),**self.office_options())
            self.cleanup_offices[id(self.offices[session_id])] = self.offices[session_id]
        if self.stopping.is_set():
            self._close_office(self.offices[session_id])
            raise RuntimeError('Worker broker is stopping')
        return self.offices[session_id]

    def _close_office(self, office):
        deadline = self.stopping.deadline
        try:
            result = office.close() if deadline is None else office.close(deadline=deadline)
        except (OSError, RuntimeError):
            self.cleanup_uncertain.add('OFFICE_CLOSE_FAILED')
            if deadline is None: raise
            return False
        if result is False:
            self.cleanup_uncertain.add('OFFICE_HANDLER_ACTIVE')
        else:
            self.cleanup_offices.pop(id(office), None)
        return result is not False

    def _reap_viewer(self, token):
        entry = self.viewers.get(token)
        if entry is None:
            return
        child, guard = entry
        if child is None:
            self.cleanup_uncertain.add('VIEWER_START_PENDING')
            return
        deadline = self.stopping.deadline
        deadline = time.monotonic() + 5.1 if deadline is None else deadline
        if not guard.acquire(timeout=remaining(deadline)):
            self.cleanup_uncertain.add('VIEWER_UNREAPED'); return
        try:
            if reap_viewer(child, self.stopping, self.cleanup_uncertain):
                self.viewers.pop(token, None)
        finally:
            guard.release()

    def recover(self):
        with self.resource_admission():
            if self.resource_reservations is not None:
                self.resource_reservations.check_recovery()
            return self._recover_laptops()

    def _recover_laptops(self):
        result = self.run_engine(['ps', '--filter', 'label=reverie.worker=' + self.config['deployment'], '--format', '{{.Names}}'])
        names=result.stdout.splitlines()
        if len(names)!=len(set(names)):raise RuntimeError('Duplicate laptop recovery inventory')
        selected={name.removeprefix(self.config['deployment']+'-agent-'):name for name in names
                  if SESSION.fullmatch(name.removeprefix(self.config['deployment']+'-agent-'))}
        if self.resource_reservations is not None:
            for sid in selected:
                self.resource_reservations.check_launch(sid)
        # Goal: recovery extends the known set and commits nothing on failure.
        recovered=dict(self.laptops);recovered.update(selected)
        if len(recovered)>self.config['maxWorkers'] or (self.config['budgetMode']=='admission' and
             sum(effective_config(self.config,s)['memoryMiB'] for s in recovered
                 if effective_config(self.config,s)['budgetMode']=='admission')>self.config['poolMemoryMiB']):
            raise RuntimeError('Running laptops exceed the configured admission budget')
        leases=[];created={}
        try:
            # 3be: complete writer/lease validation before opening any public phone.
            for sid in selected:
                paths,claimed=self.claim_storage(sid)
                if claimed:leases.append(sid)
                if paths.kind=='employee':validate_storage(self.config,paths)
            for sid in recovered:
                if self.stopping.is_set():
                    raise RuntimeError('Office recovery cancelled while broker is stopping')
                if sid not in self.offices:
                    created[sid]=OfficeAPI(Path(self.config['apiSocketRoot'])/sid, sid, self.address, Path(self.config['companyRoot']),**self.office_options())
                    self.cleanup_offices[id(created[sid])]=created[sid]
        except BaseException:
            # Goal composition: every owned resource gets its own cleanup attempt; one failure records
            # uncertainty and never prevents the remaining Office closes or lease releases. Recovered laptops are not stopped.
            for office in created.values():
                try:self._close_office(office)
                except Exception:self.cleanup_uncertain.add('OFFICE_CLOSE_FAILED')
            for sid in leases:
                try:self.release_storage(sid)
                except Exception:self.cleanup_uncertain.add('STORAGE_RELEASE_UNCONFIRMED')
            raise
        # No engine stop/kill or partial population is committed on failure.
        self.offices.update(created)
        self.laptops=recovered

    def stop_laptops(self):
        # Same admission -> broker -> journal ordering as launch/reload. Never
        # acquire the global allocation lock while holding the broker mutex.
        with self.resource_admission():
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
                self._close_office(office)
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
        gate = getattr(self, 'resource_reservations', None)
        if gate is not None or 'resourceReservations' in self.config:
            if gate is None:
                raise RuntimeError('Resource reservation control requires reconciliation')
            # The fixed gate shares the explicit host policy and qualifies held
            # source deltas under the already-held admission lock. No legacy
            # margin or candidate credit is substituted after explicit refusal.
            gate.check_creation(session_id, resources)
            return
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
        from reverie.worker_capacity_policy import legacy_headroom_fits
        if not legacy_headroom_fits(pool+outside,total_kib*1024):
            raise RuntimeError('Pool plus actual peer ceilings exceed host headroom')

    def reload_resources(self):
        with self.resource_admission():
            return self._reload_resources()

    def _reload_resources(self):
        if not self.config_file:
            raise ValueError('Resource reload requires an owner configuration file')
        with self.lock:
            updated = load_config(self.config_file)
            validate_resource_reload(self.config,updated)
            if self.resource_reservations is not None:
                self.resource_reservations.check_reload(updated)
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
        if action == 'restart-website' and self.config.get('opsConfig') is not None:
            raise ValueError('Use the structured OPS restart with current authority, artifact and generation fences')
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
            previous_maintenance = self.last_maintenance
            self.last_maintenance = time.monotonic()
            def website():
                try:
                    time.sleep(1)  # Let the HTTP acknowledgement reach the owner.
                    self.run_engine(['stop' if action == 'shutdown' else 'restart', '--time', '20', self.config['serverContainer']], optional=True)
                finally:
                    self.maintenance_lock.release()
            try:
                threading.Thread(target=website, daemon=True).start()
            except (RuntimeError, MemoryError, OSError):
                self.last_maintenance = previous_maintenance
                self.maintenance_lock.release()
                raise
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
            except (OSError, ValueError, RuntimeError, KeyError, TypeError, IndexError, AttributeError,
                    http.client.HTTPException, subprocess.SubprocessError):
                pass
            try:
                if healthy:
                    if offline.exists():
                        print('Office API recovered; laptop outage timer cleared.', file=sys.stderr, flush=True)
                    offline.unlink(missing_ok=True)
                else:
                    if not offline.exists():
                        offline.write_text(str(time.time()))
                        print('Office API unavailable; laptops will stop after 10 minutes without recovery.', file=sys.stderr, flush=True)
                    if time.time()-float(offline.read_text()) >= OFFLINE_GRACE_SECONDS:
                        self.stop_laptops()
            except (OSError, ValueError, RuntimeError, KeyError, TypeError, IndexError, AttributeError, subprocess.SubprocessError):
                pass  # Retry next tick, but still sweep detached laptops below.
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
                    state = self.inspect_container(name)
                    if not state['State']['Running']:
                        self.release_storage(sid)
                        with self.lock:
                            self.laptops.pop(sid, None)
                        office = self.offices.pop(sid, None)
                        if office: self._close_office(office)
                except (OSError, ValueError, RuntimeError, KeyError, TypeError, IndexError, AttributeError, subprocess.SubprocessError):
                    pass

    def handle(self, connection, *, _resource_launch=None):
        self.handlers[connection] = threading.current_thread()
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
        dead_inner = None
        viewer_container_id = None
        exit_file = None
        nix_guard = None
        storage_claimed = False
        retention_ready = None
        retention_container_id = None
        viewer_token = None
        resource_guard = None
        resource_cleanup_failure = None
        try:
            if self.stopping.is_set():
                raise RuntimeError('Worker broker is stopping')
            connection.settimeout(10)
            peer = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            if peer[1] != self.config['uid']:
                raise ValueError('Worker peer identity is not authorized')
            kind, raw = receive_frame(connection)
            if kind == b'M':
                result = self.chat_images.dispatch(raw)
                send_frame(connection, b'J', json.dumps(result, allow_nan=False).encode())
                return
            if kind == b'Y':
                from reverie.human_terminal_protocol import decode
                if decode(raw) != {'version':1,'purpose':'host-worker-resume-v1','kind':'register'} or self.host_resume is None:
                    raise ValueError('Native host recovery registration is unavailable')
                self.host_resume.register(connection,peer)
                return
            if kind == b'Q':
                from reverie.worker_resource_actor import ResourceActorService
                if json.loads(raw)!={'purpose':'resource-replacement-v1','version':1} or type(self.resource_actor) is not ResourceActorService:
                    raise ValueError('Protected resource purpose is unavailable')
                self.resource_actor.accept(connection,peer)
                return
            if kind == b'G':
                projection = json.loads(raw)
                if not isinstance(projection, dict) or projection != {'action': 'goal-custody'}:
                    raise ValueError('Closed Goal custody operation refused')
                # Shared schema recognizes both modes, but this restricted
                # broker release supports ONLY owner-only custody. It never
                # implicitly upgrades existing/new offices to employee signing.
                if self.goals.config()[0]['mode'] != 'owner-only':
                    raise ValueError('This broker supports owner-only Goal custody')
                result = self.goals.project(projection, peer)
                send_frame(connection, b'J', json.dumps(result).encode())
                return
            if kind == b'C':
                control = json.loads(raw)
                from reverie.worker_resume import ACTIONS as resume_actions
                if isinstance(control,dict) and control.get('action')=='worker-resume-channel':
                    from reverie.human_terminal_protocol import decode
                    if self.host_resume is None:raise ValueError('Native host recovery is unavailable')
                    if decode(raw)!={'action':'worker-resume-channel'}:raise ValueError('Closed native host channel required')
                    result=self.host_resume.accept_owner(connection,peer)
                    send_frame(connection,b'J',json.dumps(result,allow_nan=False).encode())
                    return
                if isinstance(control,dict) and control.get('action') in resume_actions:
                    raise ValueError('Native host recovery requires its fixed owner channel')
                if isinstance(control, dict) and control.get('action') in ('perf-policy-status','perf-policy-request','perf-policy-preview','perf-policy-apply'):
                    # Distinct actual host kernel peer; never an OfficeAPI or
                    # browser owner identity, employee flag, or GPU approval.
                    from reverie.worker_resume_peer import host_peer
                    host_peer(peer, self.config['uid'])
                    from reverie.worker_perf_access import dispatch as perf_dispatch, decode as perf_decode
                    result = perf_dispatch(self, perf_decode(raw))
                    send_frame(connection, b'J', json.dumps(result, allow_nan=False).encode())
                    return
                if isinstance(control, dict) and control.get('action') in ('gpu-access-status', 'gpu-access-request'):
                    # C is owner-local only; OfficeAPI never forwards these verbs.
                    # No UID/title/owner flag supplied in JSON is an approval.
                    from reverie.worker_gpu_access import dispatch as gpu_dispatch, decode_control as gpu_decode
                    result = gpu_dispatch(self, gpu_decode(raw))
                    send_frame(connection, b'J', json.dumps(result, allow_nan=False).encode())
                    return
                if not isinstance(control, dict) or set(control) - {'action', 'caller'}:
                    raise ValueError('Invalid office power request')
                result = self.control(control['action'], control.get('caller'))
                send_frame(connection, b'J', json.dumps(result).encode())
                return
            if kind == b'L':
                from reverie.worker_resource_actor import ResourceActorService
                private=json.loads(raw)
                if type(self.resource_actor) is not ResourceActorService or type(private) is not dict or set(private)!={'reference','request'}:
                    raise ValueError('Protected resource launch is unavailable')
                request=validate_request(private['request'],self.config)
                _resource_launch=self.resource_actor.resolve_launch(private['reference'],request,peer)
            elif kind == b'J':
                request = validate_request(json.loads(raw), self.config)
            else:
                raise ValueError('Expected worker launch request')
            protected_start = None
            if _resource_launch is not None:
                # Fixed private actor joins this same canonical producer. A
                # public frame cannot create or select the process-local join.
                from reverie.worker_resource_native import request_for_launch
                protected_start = request_for_launch(self, _resource_launch, request)
            if self.config_file:
                updated = load_config(self.config_file)
                with self.lock:
                    if {**self.config, 'image': updated['image']} != updated:
                        raise RuntimeError('Restart the host broker after changing worker policy')
                    self.config = updated
            session_id = request['sessionId']
            # Queued owner GPU intent can be applied only to an already stopped
            # current seat, before canonical creation admission/preparation.
            if protected_start is None and self.resource_reservations is not None and not request.get('attachOnly'):
                from reverie.worker_gpu_access import cold_boundary as gpu_cold_boundary
                gpu_cold_boundary(self, session_id)
            pending_guard = (self.resource_admission(session_id) if protected_start is None else
                             self.resource_admission(session_id, protected_start=protected_start))
            pending_guard.__enter__()
            resource_guard = pending_guard
            generation = self.generation
            wait_binding = self._launch_wait_binding(session_id) if protected_start is None else None
            wait_config = json.dumps(self.config,sort_keys=True) if protected_start is None else None
            waited = False
            def wait_current():
                current=load_config(self.config_file) if self.config_file else self.config
                if (generation!=self.generation or self.stopping.is_set() or self.draining.is_set() or
                        json.dumps(self.config,sort_keys=True)!=wait_config or
                        json.dumps(current,sort_keys=True)!=wait_config or
                        self._launch_wait_binding(session_id)!=wait_binding):
                    raise RuntimeError('Laptop launch changed while waiting for previous data')
            # Never wait for the old EID lease while retaining common resource
            # admission: its canonical supervisor stop needs that same lock.
            # Failed claims own no storage, so release admission, let stop settle,
            # then reacquire and revalidate before claiming/creation admission.
            storage_deadline=time.monotonic()+10
            while True:
                if self.stopping.is_set() or not self.allowed(session_id):
                    raise ValueError('This expert is stopped or on vacation')
                if waited:wait_current()
                try:
                    paths,storage_claimed=self.claim_storage(session_id);break
                except BlockingIOError:
                    if protected_start is None:
                        guard=resource_guard;resource_guard=None
                        self._release_resource_admission(guard)
                    if time.monotonic()>=storage_deadline:raise RuntimeError('Previous employee laptop has not released its data')
                    self.stopping.wait(.1)
                    if protected_start is None:
                        if time.monotonic()>=storage_deadline:raise RuntimeError('Previous employee laptop has not released its data')
                        waited=True;wait_current()
                        pending_guard=self.resource_admission(session_id,deadline=storage_deadline)
                        pending_guard.__enter__();resource_guard=pending_guard
            with self.lock:
                if waited:wait_current()
                if generation != self.generation or self.stopping.is_set() or self.draining.is_set() or session_id in self.active:
                    raise ValueError('A worker for this session is already attached')
                if not self.allowed(session_id):
                    raise ValueError('This expert is stopped or on vacation')
                self.active[session_id] = connection
                self.laptops[session_id] = self.config['deployment']+'-agent-'+session_id
                claimed = True
                cold_require_no_pending(paths)
                fresh_home = not os.path.lexists(paths.home)
                prepare_storage(self.config,paths)
                cold_initialize_leases(self.config, paths, fresh_home=fresh_home)
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
                    candidate_id = old.get('Id')
                    if isinstance(candidate_id,str) and re.fullmatch('[0-9a-f]{64}',candidate_id):
                        viewer_container_id = candidate_id
                    if old['State']['Running']:
                        existing_running = True
                        policy = args[args.index('reverie.worker-config='+digest)+2].split('=', 1)[1]
                        if labels.get('reverie.worker-policy') != policy:
                            raise ValueError('Running laptop policy differs; explicitly stop it before changing its grants')
                        metadata = json.loads(metadata_path.read_text())
                        exit_file = home/'.reverie-launch'/metadata['exit']
                        if not exit_file.exists():
                            # A wrapper can die before publishing its exit file.
                            # Reattach a live pane; canonical J alone replaces
                            # a confirmed dead one under storage/admission locks.
                            pane = self.run_engine(tmux_exec_args(name, 'display-message', '-p', '-t', 'office', '#{pane_dead}'), optional=True)
                            if pane.returncode or pane.stdout.strip() not in ('0', '1'):
                                raise RuntimeError('Existing laptop pane state is unavailable; no replacement was started')
                            reuse = pane.stdout.strip() == '0'
                            if not reuse:
                                from reverie.worker_resource_reservations import _pid
                                pid = old['State']['Pid']
                                if type(pid) is not int or pid <= 0:
                                    raise RuntimeError('Existing laptop process identity is unavailable')
                                dead_inner = {'id': old['Id'], 'pid': pid, 'start': _pid(pid)}
                if request.get('attachOnly') and not reuse:
                    raise ValueError('The existing laptop is unavailable; reconnect never starts a replacement')
                if request.get('attachOnly'):
                    pane = self.run_engine(tmux_exec_args(name, 'display-message', '-p', '-t', 'office', '#{pane_dead}'), optional=True)
                    if pane.returncode or pane.stdout.strip() != '0':
                        raise ValueError('The existing laptop process has exited')
                # A running container whose original command has completed is
                # still a full kernel commitment until canonical stop settles.
                # Do not subtract it or reserve a second copy of the same seat.
                replacing_running = protected_start is None and existing_running and not reuse
                replacement_source = dead_inner
                if replacing_running and replacement_source is None:
                    from reverie.worker_resource_reservations import _pid
                    pid=old['State']['Pid'];identity=old.get('Id')
                    if type(pid) is not int or pid<=0 or type(identity) is not str or not re.fullmatch('[a-f0-9]{64}',identity):
                        raise RuntimeError('Existing laptop process identity is unavailable')
                    replacement_source={'id':identity,'pid':pid,'start':_pid(pid)}
                resources=effective_config(self.config,session_id)
                if reuse and resources['budgetMode']=='pool':
                    self.check_pool(config=resources,require_headroom=False)
                if not reuse:
                    if not storage_start_allowed(self.config,paths):
                        raise ValueError('Only the current employee session may start its laptop')
                    resources=effective_config(self.config,session_id)
                    if 'sessionResources' in self.config or 'employeeResources' in self.config:
                        self.check_pool(config=resources)
                    else:
                        self.check_pool()
                    if not replacing_running:
                        self.check_creation_budget(session_id,resources)
                admitted = not replacing_running
                if previous.returncode==0 and not reuse:
                    if dead_inner is not None:
                        pane = self.run_engine(tmux_exec_args(dead_inner['id'], 'display-message', '-p', '-t', 'office', '#{pane_dead}'), optional=True)
                        if pane.returncode or pane.stdout.strip() != '1':
                            raise RuntimeError('Existing laptop pane changed; reconnect before restarting')
                        if replacing_running:wait_current()
                        self.stop(name,retain_storage=paths.kind=='employee',expected_id=dead_inner['id'],
                                  expected_process={'pid':dead_inner['pid'],'start':dead_inner['start']})
                    elif replacing_running:
                        wait_current()
                        self.stop(name,retain_storage=paths.kind=='employee',expected_id=replacement_source['id'],
                                  expected_process={'pid':replacement_source['pid'],'start':replacement_source['start']})
                    elif paths.kind=='employee':self.stop(name,retain_storage=True)
                    else:self.stop(name)
                if replacing_running:
                    # Same admission and EID lease span stop and this fresh
                    # budget check. No capacity is credited before real stop.
                    wait_current()
                    if storage_paths(self.config,session_id)!=paths or not storage_start_allowed(self.config,paths):
                        raise RuntimeError('Employee storage or running intent changed during replacement')
                    if effective_config(self.config,session_id)!=resources:
                        raise RuntimeError('Laptop policy changed during replacement')
                    self.check_creation_budget(session_id,resources)
                    admitted=True
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
                if not reuse and cold_tmp_strategy(self.config) == 'retain-and-replace':
                    prepare_temporary(self.config, scratch)
                    retention_ready = prepare_retained(self.config, paths, lambda keys: self.admit_cold_temporary(paths, keys))
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
                    if retention_ready is None:
                        clear_cold_temporary(self.config, paths, lambda keys: self.admit_cold_temporary(paths, keys))
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
                    self.command_telemetry.check_create_args(args)
                    viewer_container_id = None
                    creation = self.run_engine(args)
                    candidate_id = creation.stdout.strip()
                    if re.fullmatch('[0-9a-f]{64}',candidate_id):
                        viewer_container_id = candidate_id
                    if _resource_launch is not None:
                        from reverie.worker_resource_native import record_created
                        record_created(self, _resource_launch, creation)
                    if retention_ready is not None:
                        retention_container_id = creation.stdout.strip()
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
                    if retention_ready is not None:
                        finish_retained(self.config, paths, retention_ready,
                                        lambda: self.confirm_retained_temporary(paths, retention_ready, retention_container_id))
                    wrapper = '/bin/reverie-worker-child "$1"; result=$?; printf "%s" "$result" > "$2.tmp"; mv "$2.tmp" "$2"; exec /bin/sleep infinity'
                    self.run_engine(tmux_exec_args(name, '-f', '/dev/null', 'new-session', '-d', '-x', str(request['cols']), '-y', str(request['rows']), '-s', 'office', '/bin/bash', '-c', wrapper, 'laptop', '/home/agent/.reverie-launch/'+launch.name, '/home/agent/.reverie-launch/'+exit_file.name))
                    self.run_engine(tmux_exec_args(name, 'set-option', '-g', 'status', 'off'))
                    if _resource_launch is not None:
                        from reverie.worker_resource_native import record_cli_started
                        record_cli_started(self, _resource_launch)
                    nix_guard.__exit__(None, None, None)
                    nix_guard = None
                started = True
            pending_guard = resource_guard
            resource_guard = None
            self._release_resource_admission(pending_guard)
            if _resource_launch is not None:
                from reverie.worker_resource_native import record_canonical_released
                record_canonical_released(self,_resource_launch)
            master, slave = pty.openpty()
            tty.setraw(slave)
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', request['rows'], request['cols'], 0, 0))
            # Docker exec clients can outlive a lost transport. Replace only the
            # old terminal viewer; the office program and tmux pane keep running.
            if self.stopping.is_set():
                raise RuntimeError('Worker broker is stopping')
            viewer_token = object()
            viewer_guard = threading.Lock()
            self.viewers[viewer_token] = (None, viewer_guard)
            child = subprocess.Popen([self.engine, *tmux_exec_args(name, 'attach-session', '-d', '-t', 'office', attach=True)], stdin=slave, stdout=slave, stderr=slave, start_new_session=True, close_fds=True)
            self.viewers[viewer_token] = (child, viewer_guard)
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
                        if not completed and viewer_container_id is not None:
                            # A remain-on-exit inner pane keeps its attach client
                            # alive even when the wrapper died before its receipt.
                            # End only this viewer on POSITIVE dead evidence; the
                            # current laptop and its data lease remain for an
                            # explicit owner recovery through normal J.
                            try:
                                pane = self.run_engine(tmux_exec_args(viewer_container_id, 'display-message', '-p', '-t', 'office', '#{pane_dead}'),
                                    optional=True, deadline=time.monotonic()+2)
                            except (OSError,RuntimeError,subprocess.TimeoutExpired):
                                pane = None
                            if pane is not None and pane.returncode==0 and pane.stdout.strip()=='1':
                                # The native query can block while the normal
                                # wrapper publishes its completion. Preserve the
                                # existing receipt/X path when it appeared.
                                if exit_file is None or not exit_file.is_file():
                                    raise RuntimeError('Laptop terminal pane exited without a completion receipt; use owner Restart to recover')
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
            if _resource_launch is not None:
                from reverie.worker_resource_native import record_canonical_closed
                record_canonical_closed(self,_resource_launch)
            if resource_guard is not None:
                try:
                    self._release_resource_admission(resource_guard)
                except Exception as error:
                    resource_cleanup_failure = error
                    self.cleanup_uncertain.add('RESOURCE_ADMISSION_RELEASE_UNCONFIRMED')
            if nix_guard is not None:
                nix_guard.__exit__(None, None, None)
            try:
                completed = exit_file is not None and exit_file.is_file()
                if _resource_launch is None and admitted and name and owned and ((not started and not existing_running) or completed):
                    try:
                        self.stop(name)
                    except (OSError, RuntimeError, subprocess.TimeoutExpired):
                        if self.stopping.is_set():
                            self.cleanup_uncertain.add('PROVIDER_CLEANUP_UNCONFIRMED')
                if child:
                    self._reap_viewer(viewer_token)
                elif viewer_token is not None:
                    self.viewers.pop(viewer_token, None)
            finally:
                try:
                    for fd in [master, slave]:
                        if fd is not None:
                            try: os.close(fd)
                            except OSError: pass
                    if launch and not started and _resource_launch is None:
                        launch.unlink(missing_ok=True)
                    if claimed:
                        deadline = self.stopping.deadline
                        acquired = self.lock.acquire() if deadline is None else self.lock.acquire(timeout=remaining(deadline))
                        if not acquired:
                            self.cleanup_uncertain.add('LOCK_UNAVAILABLE')
                        else:
                            try:
                                self.active.pop(session_id, None)
                                if _resource_launch is None and ((not started and not existing_running) or completed):
                                    self.laptops.pop(session_id, None)
                                    office = self.offices.pop(session_id, None)
                                    if office: self._close_office(office)
                            finally:
                                self.lock.release()
                    if storage_claimed and _resource_launch is None:
                        # 3be: viewer EOF alone does not end a laptop's data lease. Release only after observing that
                        # exact named laptop is no longer live. Merge: bounded like the Goal's provider cleanup.
                        try:
                            state=self.run_engine(['inspect',self.config['deployment']+'-agent-'+session_id],optional=True)
                            if state.returncode or json.loads(state.stdout)[0]['State']['Running'] is False:
                                self.release_storage(session_id)
                        except (OSError, RuntimeError, ValueError, KeyError, IndexError, subprocess.TimeoutExpired):
                            if self.stopping.is_set():
                                self.cleanup_uncertain.add('STORAGE_RELEASE_UNCONFIRMED')
                            else:
                                raise
                finally:
                    try:
                        connection.close()
                    finally:
                        self.connections.release()
                        self.handlers.pop(connection, None)
            if resource_cleanup_failure is not None:
                raise RuntimeError('Resource admission release unconfirmed') from resource_cleanup_failure

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
        supervisor = None
        supervisor_started = False
        socket_identity = None
        try:
            if self.stopping.is_set():
                return
            if self.config.get('leaseAcceptance') is not None:
                try:
                    module = _lease_peer_module()
                    self.lease_peer = module.PeerServer(module.BrokerPeerBackend(self)).start()
                except (ValueError, OSError, RuntimeError, subprocess.SubprocessError):
                    self.lease_peer_error = 'Lease acceptance endpoint unavailable'
                    self.lease_peer = None
            supervisor = threading.Thread(target=self.supervise, daemon=True)
            supervisor.start()
            supervisor_started = True
            with socket.socket(socket.AF_UNIX) as listener:
                listener.bind(str(path))
                info = path.lstat()
                socket_identity = (info.st_dev, info.st_ino)
                path.chmod(0o600)
                listener.listen(8)
                listener.settimeout(0.5)
                while not self.stopping.is_set():
                    try:
                        connection, _ = listener.accept()
                    except TimeoutError:
                        continue
                    if not self.connections.acquire(blocking=False):
                        connection.close()
                        continue
                    try:
                        if self.stopping.is_set():
                            connection.close(); self.connections.release(); continue
                        handler = threading.Thread(target=self.handle, args=(connection,), daemon=True)
                        if self.stopping.is_set():
                            connection.close(); self.connections.release(); continue
                        self.handlers[connection] = handler
                        handler.start()
                    except (RuntimeError, MemoryError, OSError):
                        self.handlers.pop(connection, None)
                        connection.close()
                        self.connections.release()
        finally:
            # Covers supervisor/listener startup failures as well as normal exit.
            self.stopping.set()
            deadline = self.stopping.deadline
            peer_close = None
            if self.lease_peer is not None:
                peer = self.lease_peer
                def close_peer():
                    try:
                        peer.close()
                    except BaseException:
                        self.cleanup_uncertain.add('LEASE_PEER_ACTIVE')
                    finally:
                        if getattr(peer, 'unconfirmed', True):
                            self.cleanup_uncertain.add('LEASE_PEER_ACTIVE')
                try:
                    candidate = threading.Thread(target=close_peer, daemon=True)
                    candidate.start()
                    peer_close = candidate
                except (RuntimeError, MemoryError, OSError):
                    self.cleanup_uncertain.add('LEASE_PEER_ACTIVE')
            offices = dict(self.cleanup_offices)
            offices.update((id(office), office) for office in tuple(self.offices.values()))
            # Stop ALL listeners before sequential bounded joins; never spend
            # one serve_forever shutdown polling interval per Office.
            for office in offices.values():
                try: office.request_close()
                except (OSError, RuntimeError): self.cleanup_uncertain.add('OFFICE_CLOSE_FAILED')
            if self.lock.acquire(timeout=remaining(deadline)):
                try:
                    active = list(self.active.values())
                finally:
                    self.lock.release()
            else:
                active = []
                self.cleanup_uncertain.add('LOCK_UNAVAILABLE')
            for connection in set(active) | set(self.handlers):
                try:
                    connection.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
            drain = min(deadline, time.monotonic() + 25)
            while (self.active or self.handlers) and remaining(drain):
                time.sleep(min(.1, remaining(drain)))
            # A late in-progress constructor is still visible through its
            # handler; sweep published Offices again, without a fresh budget.
            offices.update(self.cleanup_offices)
            for office in offices.values():
                try: office.request_close()
                except (OSError, RuntimeError): self.cleanup_uncertain.add('OFFICE_CLOSE_FAILED')
            for office in offices.values():
                if self._close_office(office):
                    for sid, current in tuple(self.offices.items()):
                        if current is office: self.offices.pop(sid, None)
            for token in tuple(self.viewers):
                self._reap_viewer(token)
            if supervisor_started:
                supervisor.join(min(5., remaining(deadline)))
                if supervisor.is_alive():
                    self.cleanup_uncertain.add('SUPERVISOR_ACTIVE')
            if peer_close is not None:
                peer_close.join(min(1., remaining(deadline)))
                if peer_close.is_alive():
                    self.cleanup_uncertain.add('LEASE_PEER_ACTIVE')
            for handler in tuple(self.handlers.values()):
                if handler is not threading.current_thread():
                    handler.join(remaining(deadline))
            # Constructors and client finalizers publish before the final owned
            # client sweep. Still-active handlers/supervisor remain fatal.
            settle_owned_clients(self, deadline)
            if getattr(self, 'chat_images', None) is not None and not self.chat_images.close(deadline=deadline):
                self.cleanup_uncertain.add('CHAT_IMAGE_CLEANUP_UNCONFIRMED')
            if self.handlers or self.active:
                self.cleanup_uncertain.add('HANDLER_ACTIVE')
            if not remaining(deadline):
                self.cleanup_uncertain.add('DEADLINE_EXHAUSTED')
            if socket_identity is not None:
                try:
                    info = path.lstat()
                    if stat.S_ISSOCK(info.st_mode) and (info.st_dev, info.st_ino) == socket_identity:
                        path.unlink()
                except FileNotFoundError:
                    pass
            if self.cleanup_uncertain:
                raise CleanupUnconfirmed(self.cleanup_uncertain)


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
    resource_ref=getattr(args,'resource_ref',None)
    if resource_ref is not None:
        if (not SESSION.fullmatch(resource_ref) or args.attach_only or args.control or
                args.goal_custody or args.caller_session):
            raise ValueError('Closed resource launch reference required')
    if getattr(args, 'goal_custody', False):
        from reverie.goal_custody_client import project
        return project(args)
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
        send_frame(connection, b'L' if resource_ref is not None else b'J',
                   json.dumps({'reference':resource_ref,'request':request} if resource_ref is not None else request).encode())
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
    # Older brokers put this default in the container environment. Remove only
    # that inherited default; explicit launch and owner-selected targets survive.
    if ('CARGO_TARGET_DIR' not in request['env'] and
            env.get('CARGO_TARGET_DIR') == '/tmp/reverie/build/cargo'):
        env.pop('CARGO_TARGET_DIR')
    # The broker's launch PATH predates image-installed shims. Restore only our
    # packaged tool directory, keeping provider and owner PATH entries in order.
    autoenv = '/opt/reverie/autoenv/bin'
    if Path(autoenv).is_dir():
        paths = [entry for entry in env.get('PATH', '/bin').split(':') if entry != autoenv]
        env['PATH'] = ':'.join([autoenv, *paths])
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
    execute.add_argument('--goal-custody', action='store_true', help='Closed host/server-only custody projection')
    execute.add_argument('--caller-session')
    execute.add_argument('--attach-only', action='store_true')
    execute.add_argument('--resource-ref', help='Server-private registered resource launch reference')
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
        if isinstance(error, CleanupUnconfirmed):
            error.report()
            return 1
        print('Reverie worker unavailable: ' + (str(error) if isinstance(error, ValueError) else type(error).__name__), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
