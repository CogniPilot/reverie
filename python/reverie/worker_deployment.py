"""Join the ordinary deployment company directory to native mounted data."""
import os
from pathlib import Path
import stat

from .worker_resource_reservations import need


def company_file(config, deployment, reason):
    """Validate the producer layout; callers anchor/recheck its directory parents.

    reverie-start mounts <descriptor companyRoot>/data at /instances/default.
    isolate uses that mounted data directory as the native companyRoot.
    This joins host paths only; it does not attest a live guest mount.
    """
    need(type(deployment) is dict and type(deployment.get('version')) is int and
         deployment['version'] == 1 and deployment.get('containerName') == config['serverContainer'] and
         type(deployment.get('companyRoot')) is str, reason)
    root = Path(deployment['companyRoot'])
    need(root.is_absolute() and str(root) == deployment['companyRoot'] and
         root.resolve(strict=True) == root, reason)
    data = root / 'data'
    selected = data / 'console/company.json'
    need(config['companyRoot'] == str(data) and config['companyFile'] == str(selected), reason)
    for path in (root, data, selected.parent):
        need(path.resolve(strict=True) == path, reason)
        fd = os.open(path, os.O_PATH | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            info = os.fstat(fd)
            need(stat.S_ISDIR(info.st_mode) and info.st_uid == config['uid'] and
                 not info.st_mode & 0o022, reason)
        finally:
            os.close(fd)
    return selected
