"""Opt-in employee laptop soft RAM thresholds and finite swap allowances.

Owner configuration and normal recreation only; no laptop/browser live writer.
Legacy six-field resource profiles and unrelated zero-swap scopes stay unchanged.
"""
import copy
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
        self.code = code
        super().__init__('LAPTOP_SOFT_LIMIT_HELPER: ' + code)


def request_soft_limit(path, sid, cid, expected_bytes, timeout=10.0):
    """One identity-only request within one absolute deadline; only an exact, matching reply is accepted."""
    import json
    import socket
    import time
    from . import worker_memory_authority as A
    end = time.monotonic() + timeout
    remaining = lambda: max(end - time.monotonic(), 0.0)  # noqa: E731
    payload = (json.dumps({'v': 1, 'sessionId': sid, 'containerId': cid}, separators=(',', ':')) + '\n').encode()
    conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        try:
            conn.settimeout(remaining() or 1e-6)
            conn.connect(path)
        except OSError:
            raise SoftLimitHelperRefused('HELPER_UNAVAILABLE') from None
        raw = b''
        try:
            conn.settimeout(remaining() or 1e-6)
            conn.sendall(payload)
            while not raw.endswith(b'\n') and len(raw) <= A.REQUEST_MAX:
                left = remaining()
                if not left:
                    raise TimeoutError('reply deadline')
                conn.settimeout(left)
                chunk = conn.recv(A.REQUEST_MAX + 1 - len(raw))
                if not chunk:
                    break
                raw += chunk
        except OSError:
            raise SoftLimitHelperRefused('EFFECT_UNCONFIRMED') from None
    finally:
        conn.close()
    try:
        return A.parse_reply(raw, expected_bytes)
    except A.Refused as refused:
        raise SoftLimitHelperRefused(refused.code) from None
    except A.EffectUnconfirmed:
        raise SoftLimitHelperRefused('EFFECT_UNCONFIRMED') from None


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
    from . import worker_memory_authority as A
    try:
        target = A.LaptopTarget(pid, R.CGROUP, R.PROC)
    except A.Refused as refused:
        raise RuntimeError('New laptop memory target identity changed: ' + refused.code) from None
    same = lambda: broker.inspect_container(name) == row  # noqa: E731
    try:
        if not (target.fences() and same()):
            raise RuntimeError('New laptop memory target identity changed')
        if 'memoryHighMiB' in policy and broker.config.get('softLimitHelperSocket'):
            # The root helper applies only its own root-authorized value; readback below stays independent.
            request_soft_limit(broker.config['softLimitHelperSocket'], sid, cid, policy['memoryHighMiB'] * MIB)
        elif 'memoryHighMiB' in policy:  # Swap-only policies need no cgroup write at all.
            entry = {'memoryMaxMiB': resources['memoryMiB'], 'memoryHighMiB': policy['memoryHighMiB']}
            try:
                A.apply_high(entry, pid, R.CGROUP, R.PROC, same)
            except A.Refused as refused:
                if refused.code == 'WRITE_REFUSED':
                    raise SoftLimitAuthorityRefused() from None
                raise RuntimeError('New laptop memory target identity changed: ' + refused.code) from None
            except A.EffectUnconfirmed:
                raise RuntimeError('Laptop soft memory write unconfirmed') from None
        observer.limits(row)  # Kernel high, RAM, swap and ancestor readback.
        if not (target.fences() and same()):
            raise RuntimeError('Laptop memory readback identity changed')
    finally:
        try:
            target.close()
        except OSError:
            raise RuntimeError('Laptop memory target close unconfirmed') from None


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
