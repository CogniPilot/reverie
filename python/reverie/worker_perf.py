"""Fixed, owner-selected per-task perf syscall policy; no capability grant."""
from __future__ import annotations

import copy
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import stat

POLICY = 'task-v1'
MARKER = '_taskPerfPolicy'
RULE = {'names': ['perf_event_open'], 'action': 'SCMP_ACT_ALLOW', 'args': [
    {'index': 2, 'value': 0xffffffff, 'valueTwo': 0xffffffff, 'op': 'SCMP_CMP_MASKED_EQ'}]}
UUID = re.compile(r'[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}')
SYSTEMS = {'x86_64': 'x86_64-linux', 'aarch64': 'aarch64-linux'}


def validate(config):
    policies = config.get('employeePerfPolicies', {})
    if type(policies) is not dict or len(policies) > 256:
        raise ValueError('Perf policy requires a bounded employee map')
    for employee, policy in policies.items():
        if type(employee) is not str or not UUID.fullmatch(employee) or policy != POLICY or type(policy) is not str:
            raise ValueError('Perf policy requires stable employee UUIDs and task-v1')
    if policies and (type(config.get('rootlessDocker')) is not dict or config['rootlessDocker'].get('enabled') is not True):
        raise ValueError('Task perf requires the existing protected rootless Docker policy')
    return policies


def derivative(base):
    """Retain the whole pinned base; append exactly one signed-int CPU filter.

    Linux declares cpu as int. Masking its low 32 bits recognizes both zero and
    sign extended -1 on native/compat syscall ABIs; every nonnegative CPU fails.
    The kernel still decides pid/credentials/attr/LSM/paranoid permissions.
    """
    if type(base) is not dict or base.get('defaultAction') != 'SCMP_ACT_ERRNO' or type(base.get('syscalls')) is not list:
        raise ValueError('Fixed default-deny base profile required')
    if RULE in base['syscalls']:
        raise ValueError('Task perf derivative must be applied exactly once')
    result = copy.deepcopy(base)
    result['syscalls'].append(copy.deepcopy(RULE))
    return result


def _json(raw):
    def pairs(items):
        value = {}
        for key, item in items:
            if key in value:
                raise ValueError('Duplicate perf artifact field')
            value[key] = item
        return value
    return json.loads(raw, object_pairs_hook=pairs)


def _read(path):
    path = Path(path)
    if not path.is_absolute() or not str(path).startswith('/nix/store/') or path.resolve(strict=True) != path:
        raise ValueError('Fixed canonical Nix perf artifact required')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        before = os.fstat(fd)
        if (not stat.S_ISREG(before.st_mode) or before.st_uid not in (0, os.getuid())
                or before.st_mode & 0o022 or before.st_size > 65536):
            raise ValueError('Unprotected perf artifact')
        raw = bytearray()
        while len(raw) <= 65536:
            part = os.read(fd, min(4096, 65537-len(raw)))
            if not part:
                break
            raw.extend(part)
        stamp = lambda s: (s.st_dev, s.st_ino, s.st_uid, s.st_mode, s.st_nlink, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        if len(raw) != before.st_size or stamp(before) != stamp(os.fstat(fd)) or stamp(before) != stamp(path.lstat()):
            raise ValueError('Perf artifact changed during observation')
        return bytes(raw)
    finally:
        os.close(fd)


def artifact():
    # Installed by the fixed Nix broker derivation. No config/env/caller path.
    manifest = _json(_read(Path(__file__).with_name('worker-perf-profile.json')))
    fields = {'version', 'purpose', 'system', 'baseProfile', 'baseSHA256', 'profile', 'profileSHA256'}
    if (type(manifest) is not dict or set(manifest) != fields or type(manifest['version']) is not int
            or manifest['version'] != 1 or manifest['purpose'] != 'worker-task-perf-profile-v1'
            or platform.system() != 'Linux' or SYSTEMS.get(platform.machine()) != manifest['system']):
        raise ValueError('Unsupported fixed task perf artifact')
    for path_key, hash_key in (('baseProfile', 'baseSHA256'), ('profile', 'profileSHA256')):
        if type(manifest[path_key]) is not str or type(manifest[hash_key]) is not str or not re.fullmatch('[a-f0-9]{64}', manifest[hash_key]):
            raise ValueError('Invalid fixed perf artifact binding')
    base = _read(manifest['baseProfile']); selected = _read(manifest['profile'])
    if (hashlib.sha256(base).hexdigest() != manifest['baseSHA256']
            or hashlib.sha256(selected).hexdigest() != manifest['profileSHA256']
            or _json(selected) != derivative(_json(base))):
        raise ValueError('Task perf profile differs from the fixed derivative')
    return manifest


def project(config, session):
    policies = validate(config)
    result = {k: v for k, v in config.items() if k != 'employeePerfPolicies'}
    if not policies:
        return result
    if __package__:
        from .worker_gpu import current_employee
    else:
        import importlib.util
        spec = importlib.util.spec_from_file_location(__name__+'_gpu', Path(__file__).with_name('worker_gpu.py'))
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        current_employee = module.current_employee
    employee = current_employee(config, session)
    if employee is None or employee['id'] not in policies:
        return result
    fixed = artifact()
    original = config['rootlessDocker']
    if original.get('seccompProfile') != fixed['baseProfile'] or original.get('seccompSha256') != fixed['baseSHA256']:
        raise ValueError('Task perf requires the exact fixed base Docker profile')
    if current_employee(config, session) != employee:
        raise ValueError('Perf employee binding changed during artifact observation')
    result['rootlessDocker'] = dict(original, seccompProfile=fixed['profile'], seccompSha256=fixed['profileSHA256'])
    result[MARKER] = POLICY
    return result


def recognized(config, profile):
    if config.get(MARKER) != POLICY:
        raise ValueError('Task perf profile lacks selected employee policy')
    fixed = artifact()
    actual = config['rootlessDocker']
    if actual['seccompProfile'] != fixed['profile'] or actual['seccompSha256'] != fixed['profileSHA256'] or profile != _json(_read(fixed['profile'])):
        raise ValueError('Unrecognized selected task perf profile')
    return True
