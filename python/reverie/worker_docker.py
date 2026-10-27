"""Owner-selected rootless Docker policy; no engine socket or privileged access."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import pwd
import re
import stat

FEATURE_LABEL = 'org.reverie.worker.rootless-docker'
UID_LABEL = 'org.reverie.worker.uid'
GID_LABEL = 'org.reverie.worker.gid'
LAYOUT_LABEL = 'org.reverie.worker.rootless-docker.mount-layout'


def canonical_target(value):
    if not isinstance(value, str):
        raise ValueError('Explicit canonical worker mount destination required')
    target = PurePosixPath(value)
    if target.anchor != '/' or str(target) != value or '..' in target.parts:
        raise ValueError('Canonical worker mount destination required')
    return target


def require_disjoint(targets):
    for index, target in enumerate(targets):
        if any(target.is_relative_to(other) or other.is_relative_to(target) for other in targets[:index]):
            raise ValueError('Rootless Docker bind destinations must not overlap')


def require_account_mounts(config, destinations):
    """Call on the final selected account destination keys before engine create."""
    if not enabled(config):
        return
    targets = [canonical_target(mount['destination']) for mount in config.get('mounts', [])]
    roots = (PurePosixPath('/instances/default/accounts'), PurePosixPath('/instances/default/console/accounts'))
    for value in destinations:
        target = canonical_target(value)
        if not any(target != root and target.is_relative_to(root) for root in roots):
            raise ValueError('Rootless Docker account destination is outside the plain account namespace')
        targets.append(target)
    require_disjoint(targets)


def require_immutable_mounts(config):
    protected = [PurePosixPath(value) for value in (
        '/opt/reverie-idmap', '/opt/idmap', '/bin/newuidmap', '/bin/newgidmap',
        '/etc/passwd', '/etc/group', '/etc/subuid', '/etc/subgid',
        '/etc/nsswitch.conf', '/etc/ld.so.preload', '/etc/ld.so.cache')]
    readonly = {'/host-published', '/instances/default/tools',
                '/instances/default/console/statusline-exporter.sh', '/run/reverie-model'}
    drives = {'/workspace', '/reverie_workspace', '/projects'}
    targets = []
    for mount in config.get('mounts', []):
        target = canonical_target(mount.get('destination'))
        if any(target.is_relative_to(path) or path.is_relative_to(target) for path in protected):
            raise ValueError('Worker mount masks immutable Docker identity or helper files')
        # Lexical exclusions alone do not contain symlinks inside an earlier
        # mount or image symlinks leading into writable /nix. Only image-factory
        # namespaces verified plain/empty before mounting are eligible.
        value = str(target)
        project = target.parent == PurePosixPath('/projects') and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,99}', target.name)
        if value not in drives and value not in readonly and not project:
            raise ValueError('Rootless Docker requires a plain approved mount destination')
        if value in readonly and mount.get('readOnly') is not True:
            raise ValueError('Rootless Docker tool, publication and model mounts must be read-only')
        targets.append(target)
    require_disjoint(targets)


def enabled(config):
    value = config.get('rootlessDocker')
    if value is None:
        return False
    if not isinstance(value, dict) or set(value) != {'enabled', 'seccompProfile', 'seccompSha256'} or type(value['enabled']) is not bool:
        raise ValueError('Unsupported rootless Docker policy')
    if not value['enabled']:
        return False
    if any(type(config.get(key)) is not int or not 0 < config[key] < 2147483648 for key in ('uid', 'gid')):
        raise ValueError('Non-root numeric laptop identity required')
    require_immutable_mounts(config)
    if not isinstance(value['seccompProfile'], str):
        raise ValueError('Nix seccomp profile path required')
    path = Path(value['seccompProfile'])
    if not path.is_absolute() or not str(path).startswith('/nix/store/') or path.resolve(strict=True) != path:
        raise ValueError('Rootless Docker needs the immutable Nix seccomp profile')
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid not in (0, os.getuid()) or info.st_mode & 0o022 or info.st_size > 65536:
        raise ValueError('Unprotected rootless Docker profile')
    expected = value['seccompSha256']
    data = path.read_bytes()
    if not isinstance(expected, str) or not re.fullmatch('[0-9a-f]{64}', expected) or hashlib.sha256(data).hexdigest() != expected:
        raise ValueError('Rootless Docker profile changed')
    profile = json.loads(data)
    if profile.get('defaultAction') != 'SCMP_ACT_ERRNO':
        raise ValueError('Rootless Docker profile must retain default syscall denials')
    caps = {'CAP_SETUID', 'CAP_SETGID'}
    for rule in profile['syscalls']:
        guarded = set(rule.get('includes', {}).get('caps', []))
        excluded = set(rule.get('excludes', {}).get('caps', []))
        applies = (not guarded or bool(guarded & caps)) and not bool(excluded & caps)
        if applies and rule['action'] == 'SCMP_ACT_ALLOW' and set(rule['names']) & {'keyctl', 'add_key', 'request_key', 'bpf', 'perf_event_open'}:
            raise ValueError('Rootless Docker must not expose host keyrings or tracing')
    return True


def require_image(config, image):
    if not enabled(config):
        return
    selected = image['Config']
    labels = selected.get('Labels') or {}
    if (selected.get('User') != f"{config['uid']}:{config['gid']}" or labels.get(FEATURE_LABEL) != '1'
            or labels.get(UID_LABEL) != str(config['uid']) or labels.get(GID_LABEL) != str(config['gid'])
            or labels.get(LAYOUT_LABEL) != '1'):
        raise ValueError('Rootless Docker requires the reviewed capability image for this UID/GID')
    if config['uid'] != os.getuid():
        raise ValueError('Rootless Docker must use the normal broker owner identity')
    try:
        start_uid = int(labels['org.reverie.worker.subuid-start'])
        start_gid = int(labels['org.reverie.worker.subgid-start'])
        count = int(labels['org.reverie.worker.subid-count'])
    except (KeyError, ValueError, TypeError):
        raise ValueError('Missing immutable subordinate-ID metadata') from None
    if count < 65536 or not granted(host_grants('/etc/subuid', config['uid']), start_uid, count) or not granted(host_grants('/etc/subgid', config['uid']), start_gid, count):
        raise ValueError('Image mappings exceed existing normal host subordinate-ID grants')


def granted(ranges, start, count):
    return start > 0 and count >= 65536 and any(low <= start and start + count <= low + length for low, length in ranges)


def host_grants(path, uid):
    try:
        target = Path(path).resolve(strict=True)
        name = pwd.getpwuid(uid).pw_name
    except (FileNotFoundError, KeyError):
        raise ValueError('Docker capability unavailable: existing normal host subordinate-ID grants required') from None
    info = target.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 or info.st_size > 1048576:
        raise ValueError('Protected normal host ID grants required')
    ranges = []
    for line in target.read_text().splitlines():
        fields = line.split(':')
        if len(fields) == 3 and fields[0] in (name, str(uid)) and fields[1].isdigit() and fields[2].isdigit():
            ranges.append((int(fields[1]), int(fields[2])))
    return ranges


def security_args(config):
    if not enabled(config):
        return ['--cap-drop', 'ALL', '--security-opt', 'no-new-privileges']
    return ['--cap-drop', 'ALL', '--cap-add', 'SETUID', '--cap-add', 'SETGID',
            '--security-opt', 'seccomp=' + config['rootlessDocker']['seccompProfile'],
            '--security-opt', 'systempaths=unconfined', '--device', '/dev/net/tun:/dev/net/tun:rw']


def runtime_args(config):
    if not enabled(config):
        return []
    uid, gid = config['uid'], config['gid']
    if type(uid) is not int or type(gid) is not int or uid <= 0 or gid <= 0:
        raise ValueError('Non-root numeric laptop identity required')
    return ['--tmpfs', f'/run/reverie-docker:rw,nosuid,nodev,noexec,size=33554432,mode=0700,uid={uid},gid={gid}',
            '--env', 'XDG_RUNTIME_DIR=/run/reverie-docker', '--env', 'DOCKER_HOST=unix:///run/reverie-docker/docker.sock']
