"""Opt-in employee laptop soft RAM thresholds and finite swap allowances.

Owner configuration and normal recreation only; no laptop/browser live writer.
Legacy six-field resource profiles and unrelated zero-swap scopes stay unchanged.
"""
import copy
import errno
import os
from pathlib import Path
import re

MIB = 1048576
UUID = re.compile(r'^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$')


class SoftLimitAuthorityRefused(RuntimeError):
    """The host gives this broker no write authority over the new laptop's memory.high."""
    code = 'LAPTOP_SOFT_LIMIT_WRITE_AUTHORITY'

    def __init__(self):
        super().__init__(self.code + ': laptop soft memory threshold needs host cgroup write authority; '
                         'use a swap-only policy until it is provided')


def validate(config):
    policies = config.get('employeeMemoryPolicies', {})
    pool = config.get('laptopSwapPoolMiB', 0)
    if (type(policies) is not dict or len(policies) > 256 or
            type(pool) is not int or not 0 <= pool <= 1048576):
        raise ValueError('Invalid employee memory policy map or swap pool')
    for eid, policy in policies.items():
        if (type(eid) is not str or not UUID.fullmatch(eid) or type(policy) is not dict or
                set(policy) not in ({'swapMiB'}, {'memoryHighMiB', 'swapMiB'}) or
                ('memoryHighMiB' in policy and (type(policy['memoryHighMiB']) is not int or
                                               not 512 <= policy['memoryHighMiB'] <= 1048576)) or
                type(policy['swapMiB']) is not int or not 0 <= policy['swapMiB'] <= pool):
            raise ValueError('Invalid employee memory policy')


def project(config, sid, resources):
    """Select by the trusted employee storage binding, never a request-supplied EID."""
    validate(config)
    if not config.get('employeeMemoryPolicies'):
        return resources
    if __package__:
        from .worker_storage import storage_paths
    else:
        import importlib.util
        spec = importlib.util.spec_from_file_location(__name__ + '_storage', Path(__file__).with_name('worker_storage.py'))
        module = importlib.util.module_from_spec(spec)
        import sys
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        storage_paths = module.storage_paths
    paths = storage_paths(config, sid)
    policy = config['employeeMemoryPolicies'].get(paths.identity) if paths.kind == 'employee' else None
    if policy is None:
        return resources
    if 'memoryHighMiB' in policy and not policy['memoryHighMiB'] < resources['memoryMiB']:
        raise ValueError('Laptop soft memory threshold requires a higher finite RAM ceiling')
    result = dict(resources)
    result['laptopMemoryPolicy'] = dict(copy.deepcopy(policy), swapPoolMiB=config.get('laptopSwapPoolMiB', 0))
    return result


def swap_bytes(resources):
    return resources.get('laptopMemoryPolicy', {}).get('swapMiB', 0) * MIB


def check_swap_budget(config, rows, candidate=None, proc=Path('/proc')):
    """Finite declared swap commitments; allocation is not a disk reservation."""
    budget = config.get('laptopSwapPoolMiB', 0) * MIB
    committed = 0
    for row in rows:
        labels = row.get('Config', {}).get('Labels') or {}
        if not row.get('State', {}).get('Running') or not any(
                key in labels for key in ('reverie.worker', 'reverie.nix-prepare')):
            continue
        host = row.get('HostConfig', {})
        memory, total = host.get('Memory'), host.get('MemorySwap')
        if type(memory) is not int or memory <= 0 or type(total) is not int or total < memory:
            raise RuntimeError('Finite laptop RAM and swap declarations required')
        committed += total - memory
    committed += 0 if candidate is None else swap_bytes(candidate)
    if committed > budget:
        raise RuntimeError('Laptop swap admission is full')
    if budget:
        values = []
        for line in (proc / 'meminfo').read_text().splitlines():
            if line.startswith('SwapTotal:'):
                fields = line.split()
                if len(fields) != 3 or fields[2] != 'kB' or not fields[1].isascii() or not fields[1].isdecimal():
                    raise RuntimeError('Host swap capacity is unavailable')
                values.append(int(fields[1]) * 1024)
        if len(values) != 1 or budget > values[0]:
            raise RuntimeError('Laptop swap pool exceeds actual host swap capacity')


class SoftLimitHelperRefused(RuntimeError):
    """The root helper refused or could not confirm; the laptop must not start its agent."""

    def __init__(self, code):
        self.code = code if type(code) is str and re.fullmatch('[A-Z_]{1,40}', code) else 'EFFECT_UNCONFIRMED'
        super().__init__('LAPTOP_SOFT_LIMIT_HELPER: ' + self.code)


def request_soft_limit(path, sid, cid, timeout=10.0):
    """One identity-only request to the root helper; any missing or odd reply refuses the launch."""
    import json
    import socket
    payload = (json.dumps({'v': 1, 'sessionId': sid, 'containerId': cid}, separators=(',', ':')) + '\n').encode()
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
            conn.settimeout(timeout)
            conn.connect(path)
            conn.sendall(payload)
            raw = b''
            while not raw.endswith(b'\n') and len(raw) <= 512:
                chunk = conn.recv(513 - len(raw))
                if not chunk:
                    break
                raw += chunk
    except OSError:
        raise SoftLimitHelperRefused('HELPER_UNAVAILABLE') from None
    try:
        reply = json.loads(raw.decode('utf-8', 'strict'))
    except (ValueError, UnicodeDecodeError):
        raise SoftLimitHelperRefused('EFFECT_UNCONFIRMED') from None
    if reply == {'ok': True, 'memoryHighBytes': reply.get('memoryHighBytes')} and type(reply['memoryHighBytes']) is int:
        return reply['memoryHighBytes']
    raise SoftLimitHelperRefused(reply.get('code') if isinstance(reply, dict) and reply.get('ok') is False else 'EFFECT_UNCONFIRMED')


def configure_started(broker, name, sid, expected_id=None):
    """Only the newly started sleep container, before any worker child is exec'd."""
    from . import worker_resource_reservations as R
    from .worker_resources import effective_config, policy_digest
    resources = effective_config(broker.config, sid)
    policy = resources.get('laptopMemoryPolicy')
    if policy is None:
        return
    observer = R.NativeObserver(broker)
    observer.host_root()  # Refuse namespaced subroots and unsupported hosts.
    row = broker.inspect_container(name)
    labels = row.get('Config', {}).get('Labels') or {}
    pid = row.get('State', {}).get('Pid')
    cid = row.get('Id')
    if (row.get('Name') != '/' + name or name != broker.config['deployment'] + '-agent-' + sid or
            row.get('State', {}).get('Running') is not True or type(pid) is not int or pid <= 0 or
            type(cid) is not str or not re.fullmatch('[0-9a-f]{64}', cid) or cid != expected_id or
            labels.get('reverie.worker') != broker.config['deployment'] or labels.get('reverie.session') != sid or
            labels.get('reverie.worker-policy') != policy_digest(broker.config, sid)):
        raise RuntimeError('New laptop memory target identity changed')
    start = R._pid(pid)
    groups = R._read(R.PROC / str(pid) / 'cgroup').splitlines()
    if len(groups) != 1 or not groups[0].startswith('0::/'):
        raise RuntimeError('Unified laptop cgroup required')
    relative = Path(groups[0][4:])
    if relative.is_absolute() or '..' in relative.parts or str(relative) == '.':
        raise RuntimeError('Invalid laptop cgroup')
    fd = os.open(R.CGROUP, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        for part in relative.parts:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            os.close(fd)
            fd = child
        if (R._pid(pid) != start or R._read(R.PROC / str(pid) / 'cgroup').splitlines() != groups or
                broker.inspect_container(name) != row or
                (os.fstat(fd).st_dev, os.fstat(fd).st_ino) !=
                (os.stat(R.CGROUP / relative, follow_symlinks=False).st_dev,
                 os.stat(R.CGROUP / relative, follow_symlinks=False).st_ino)):
            raise RuntimeError('New laptop memory target identity changed')
        if 'memoryHighMiB' in policy and broker.config.get('softLimitHelperSocket'):
            # The root helper applies only its own root-authorized value; readback below stays independent.
            request_soft_limit(broker.config['softLimitHelperSocket'], sid, cid)
        elif 'memoryHighMiB' in policy:  # Swap-only policies need no broker cgroup write.
            try:
                high = os.open('memory.high', os.O_WRONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            except OSError as error:
                if error.errno in (errno.EACCES, errno.EPERM, errno.EROFS):
                    raise SoftLimitAuthorityRefused() from None
                raise
            try:
                raw = (str(policy['memoryHighMiB'] * MIB) + '\n').encode()
                if os.write(high, raw) != len(raw):
                    raise RuntimeError('Laptop soft memory write unconfirmed')
            finally:
                os.close(high)
        observer.limits(row)  # Kernel high, RAM, swap and ancestor readback.
        if (R._pid(pid) != start or R._read(R.PROC / str(pid) / 'cgroup').splitlines() != groups or
                broker.inspect_container(name) != row or
                (os.fstat(fd).st_dev, os.fstat(fd).st_ino) !=
                (os.stat(R.CGROUP / relative, follow_symlinks=False).st_dev,
                 os.stat(R.CGROUP / relative, follow_symlinks=False).st_ino)):
            raise RuntimeError('Laptop memory readback identity changed')
    finally:
        os.close(fd)


def verify_running(broker, sid, row):
    from .worker_resources import effective_config, policy_digest
    resources = effective_config(broker.config, sid)
    if resources.get('laptopMemoryPolicy') is not None:
        labels = row.get('Config', {}).get('Labels') or {}
        if (labels.get('reverie.worker') != broker.config['deployment'] or
                labels.get('reverie.session') != sid or
                labels.get('reverie.worker-policy') != policy_digest(broker.config, sid)):
            raise RuntimeError('Running laptop memory target identity changed')
        from .worker_resource_reservations import NativeObserver
        observer = NativeObserver(broker)
        observer.host_root()
        observer.limits(row)
