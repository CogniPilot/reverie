"""Owner-selected GPU grants, separate from worker-controlled execution requests.

CDI performs driver/device injection in the host engine. This module deliberately
does not accept raw paths, runtime flags, an all-devices selector or driver mounts.
Device access is shared access: it does not impose a VRAM quota.
"""
from __future__ import annotations

import re

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


def gpu_create_args(config, session):
    grants = validate_gpu_grants(config.get("gpuGrants", {}))
    return ["--device", grants[session]] if session in grants else []
