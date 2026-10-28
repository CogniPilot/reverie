"""Owner-selected GPU grants, separate from worker-controlled execution requests.

CDI performs driver/device injection in the host engine. This module deliberately
does not accept raw paths, runtime flags, an all-devices selector or driver mounts.
Device access is shared access: it does not impose a VRAM quota.
"""
from __future__ import annotations

import re
from pathlib import Path

SESSION = re.compile(r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}")
DEVICE = re.compile(r"nvidia\.com/gpu=GPU-[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}")


def validate_gpu_grants(grants):
    """Fail closed; stable physical UUIDs only, at most 32 explicit laptops."""
    if not isinstance(grants, dict) or len(grants) > 32:
        raise ValueError("GPU grants must map explicit sessions to NVIDIA CDI UUIDs")
    for session, device in grants.items():
        if not isinstance(session, str) or not SESSION.fullmatch(session):
            raise ValueError("GPU grants require an explicit session UUID")
        if not isinstance(device, str) or not DEVICE.fullmatch(device):
            raise ValueError("GPU grants require one physical NVIDIA CDI GPU UUID")
    return grants


def validate_gpu_config(config):
    """Both maps are owner configuration, never employee execution requests."""
    legacy = validate_gpu_grants(config.get('gpuGrants', {}))
    try:
        employees = validate_gpu_grants(config.get('employeeGpuGrants', {}))
    except ValueError:
        raise ValueError('Employee GPU grants require explicit employee UUIDs and physical NVIDIA CDI UUIDs') from None
    if len(legacy) + len(employees) > 32:
        raise ValueError('GPU grants exceed the bounded owner selection')
    return legacy, employees


def _storage_module():
    if __package__:
        from . import worker_storage
        return worker_storage
    # The flat acceptance bundle uses the same fixed sibling, not caller paths.
    import importlib.util
    import sys
    name = __name__ + '_storage'
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name('worker_storage.py'))
        module = importlib.util.module_from_spec(spec); sys.modules[name] = module
        try: spec.loader.exec_module(module)
        except BaseException: sys.modules.pop(name, None); raise
    return sys.modules[name]


def current_employee(config, session):
    """Resolve current registry identity; historical storage is not a grant.

    This returns no execution permission: existing OFF/vacation/start gates are
    independent. Grants must not change a stopped laptop's policy merely because
    the owner toggles its desired-running setting.
    """
    storage = _storage_module()
    paths = storage.storage_paths(config, session)
    if paths.kind != 'employee':
        return None
    def selected():
        company = storage.read_metadata(config['companyFile'], config['uid'])
        rows = company.get('employees') if type(company) is dict else None
        if type(rows) is not list:
            raise ValueError('Current GPU employee registry unavailable')
        matches = [row for row in rows if type(row) is dict and row.get('id') == paths.identity
                   and row.get('sessionId') == session and row.get('owner') == paths.owner]
        if not matches:
            return None
        if len(matches) != 1 or type(matches[0].get('sessionGeneration')) is not int or matches[0]['sessionGeneration'] < 1:
            raise ValueError('Current GPU employee generation unavailable')
        row = matches[0]
        return {name: row.get(name) for name in ('id', 'sessionId', 'sessionGeneration', 'owner')}
    first = selected()
    if storage.storage_paths(config, session) != paths or selected() != first:
        raise ValueError('GPU employee binding changed during resolution')
    return first


def projected_gpu_grants(config, session):
    """Legacy bytes stay exact; only a selected employee gets an added grant."""
    legacy, employees = validate_gpu_config(config)
    result = dict(legacy) if 'gpuGrants' in config else None
    if not employees or session in legacy:
        return result
    employee = current_employee(config, session)
    if employee is not None and employee['id'] in employees:
        result = dict(legacy)
        result[session] = employees[employee['id']]
    return result


def gpu_create_args(config, session):
    grants = projected_gpu_grants(config, session) or {}
    return ["--device", grants[session]] if session in grants else []
