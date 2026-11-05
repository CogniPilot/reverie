"""Root-authorized laptop soft memory threshold: pure checks shared by broker and helper.

The helper trusts only root-owned inputs: its unit pins and the policy envelope, which maps an
employee home path to one owner-authorized (memory.max, memory.high) pair. A request carries
identities, never values or paths. Nothing here reads broker-writable configuration.
"""
import errno
import json
import os
from pathlib import Path
import re
import stat

MIB = 1048576
REQUEST_MAX = 512
POLICY_MAX = 65536
UUID = re.compile(r'^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$')
CONTAINER = re.compile(r'^[0-9a-f]{64}$')
DEPLOYMENT = re.compile(r'^[a-z0-9][a-z0-9-]{0,39}$')
RELEASE = re.compile(r'^[0-9A-Za-z._+-]{1,64}$')


class Refused(Exception):
    """No write was attempted."""
    def __init__(self, code):
        super().__init__(code)
        self.code = code


class EffectUnconfirmed(Exception):
    """The write was attempted; a later fence failed. Never retry or roll back elsewhere."""
    code = 'EFFECT_UNCONFIRMED'


def need(value, code):
    if not value:
        raise Refused(code)


def _strict_object(pairs):
    keys = [key for key, _ in pairs]
    if len(keys) != len(set(keys)):
        raise ValueError('duplicate key')
    return dict(pairs)


def _strict_json(raw):
    return json.loads(raw.decode('utf-8', 'strict'), object_pairs_hook=_strict_object,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError('constant')))


def parse_request(raw):
    """One bounded line: exactly {"v":1,"sessionId":uuid,"containerId":64 hex}."""
    try:
        need(type(raw) is bytes and 0 < len(raw) <= REQUEST_MAX and raw.endswith(b'\n') and
             raw.count(b'\n') == 1, 'REQUEST_INVALID')
        value = _strict_json(raw[:-1])
    except (ValueError, UnicodeDecodeError):
        raise Refused('REQUEST_INVALID') from None
    need(type(value) is dict and set(value) == {'v', 'sessionId', 'containerId'} and
         type(value['v']) is int and value['v'] == 1 and
         type(value['sessionId']) is str and UUID.fullmatch(value['sessionId']) and
         type(value['containerId']) is str and CONTAINER.fullmatch(value['containerId']), 'REQUEST_INVALID')
    return value['sessionId'], value['containerId']


def _root_only(st):
    return st.st_uid == 0 and not st.st_mode & (stat.S_IWGRP | stat.S_IWOTH)


def load_policy(path):
    """Root-owned regular file with root-owned, non-writable parents; unchanged while read."""
    path = Path(path)
    need(path.is_absolute() and '..' not in path.parts, 'POLICY_UNTRUSTED')
    for parent in reversed(path.parents):
        try:
            st = os.lstat(parent)
        except OSError:
            raise Refused('POLICY_UNTRUSTED') from None
        need(stat.S_ISDIR(st.st_mode) and _root_only(st), 'POLICY_UNTRUSTED')
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError:
        raise Refused('POLICY_UNTRUSTED') from None
    try:
        before = os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and _root_only(before) and before.st_size <= POLICY_MAX, 'POLICY_UNTRUSTED')
        raw = os.read(fd, POLICY_MAX + 1)
        after = os.fstat(fd)
        need(len(raw) == before.st_size and
             (after.st_ino, after.st_size, after.st_mtime_ns) == (before.st_ino, before.st_size, before.st_mtime_ns),
             'POLICY_UNTRUSTED')
    finally:
        os.close(fd)
    try:
        policy = _strict_json(raw)
    except (ValueError, UnicodeDecodeError):
        raise Refused('POLICY_INVALID') from None
    return validate_policy(policy)


def validate_policy(policy):
    need(type(policy) is dict and set(policy) == {'v', 'deployment', 'stateRoot', 'qualifiedKernel', 'entries'} and
         type(policy['v']) is int and policy['v'] == 1, 'POLICY_INVALID')
    need(type(policy['deployment']) is str and DEPLOYMENT.fullmatch(policy['deployment']), 'POLICY_INVALID')
    root = policy['stateRoot']
    need(type(root) is str and Path(root).is_absolute() and str(Path(root)) == root and '..' not in Path(root).parts,
         'POLICY_INVALID')
    kernel = policy['qualifiedKernel']
    need(type(kernel) is dict and set(kernel) == {'osrelease'} and type(kernel['osrelease']) is str and
         RELEASE.fullmatch(kernel['osrelease']), 'POLICY_INVALID')
    entries = policy['entries']
    need(type(entries) is list and len(entries) <= 256, 'POLICY_INVALID')
    homes = set()
    for entry in entries:
        need(type(entry) is dict and set(entry) == {'employeeId', 'home', 'memoryMaxMiB', 'memoryHighMiB'} and
             type(entry['employeeId']) is str and UUID.fullmatch(entry['employeeId']) and
             entry['home'] == str(Path(root) / 'employees' / entry['employeeId'] / 'home') and
             type(entry['memoryMaxMiB']) is int and type(entry['memoryHighMiB']) is int and
             512 <= entry['memoryHighMiB'] < entry['memoryMaxMiB'] <= 1048576 and entry['home'] not in homes,
             'POLICY_INVALID')
        homes.add(entry['home'])
    return policy


def check_kernel(policy, proc=Path('/proc')):
    """The running release must be the owner-qualified one, checked before any writer opens."""
    try:
        with open(proc / 'sys/kernel/osrelease', 'rb') as stream:
            raw = stream.read(129)
    except OSError:
        raise Refused('KERNEL_UNQUALIFIED') from None
    need(len(raw) <= 128 and raw.decode('ascii', 'replace').strip() == policy['qualifiedKernel']['osrelease'],
         'KERNEL_UNQUALIFIED')


def check_host_root(proc=Path('/proc'), cgroup=Path('/sys/fs/cgroup')):
    """The full host cgroup2 hierarchy is mounted at the expected point; never a namespaced subroot."""
    try:
        with open(proc / 'self/mountinfo', 'rb') as stream:
            rows = stream.read(1048577).decode('utf-8', 'replace').splitlines()
    except OSError:
        raise Refused('HOST_HIERARCHY_REQUIRED') from None
    found = []
    for row in rows:
        fields = row.split()
        if len(fields) > 6 and fields[4] == str(cgroup) and '-' in fields:
            found.append((fields[3], fields[fields.index('-') + 1]))
    need(found == [('/', 'cgroup2')], 'HOST_HIERARCHY_REQUIRED')


def _no_symlink_components(path):
    current = Path('/')
    for part in Path(path).parts[1:]:
        current = current / part
        try:
            st = os.lstat(current)
        except OSError:
            return False
        if stat.S_ISLNK(st.st_mode):
            return False
    return True


def select_entry(policy, row, session_id, container_id):
    """Exact engine identity, then the /home/agent bind source selects exactly one authorized pair."""
    deployment = policy['deployment']
    labels = (row.get('Config') or {}).get('Labels') or {}
    state = row.get('State') or {}
    need(row.get('Id') == container_id and row.get('Name') == f'/{deployment}-agent-{session_id}' and
         labels.get('reverie.worker') == deployment and labels.get('reverie.session') == session_id and
         state.get('Running') is True and type(state.get('Pid')) is int and state['Pid'] > 0, 'IDENTITY_MISMATCH')
    mounts = [m for m in row.get('Mounts') or [] if isinstance(m, dict) and m.get('Destination') == '/home/agent']
    need(len(mounts) == 1 and mounts[0].get('Type') == 'bind', 'POLICY_NO_MATCH')
    source = mounts[0].get('Source')
    matches = [e for e in policy['entries'] if e['home'] == source]
    need(len(matches) == 1 and _no_symlink_components(source), 'POLICY_NO_MATCH')
    entry = matches[0]
    need((row.get('HostConfig') or {}).get('Memory') == entry['memoryMaxMiB'] * MIB, 'HARD_LIMIT_MISMATCH')
    return entry


def _read_at(fd, name, maximum=128):
    child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
    try:
        raw = os.read(child, maximum + 1)
    finally:
        os.close(child)
    need(len(raw) <= maximum, 'IDENTITY_MISMATCH')
    return raw.decode('ascii', 'replace').strip()


def _pid_start(proc, pid):
    with open(proc / str(pid) / 'stat', 'rb') as stream:
        return stream.read(4096).rsplit(b')', 1)[1].split()[19]


def apply_high(entry, pid, cgroup=Path('/sys/fs/cgroup'), proc=Path('/proc'), recheck=lambda: True):
    """Walk to the laptop leaf without following links, check the hard limit, then write one file.

    Returns the confirmed bytes. Raises Refused before any write, EffectUnconfirmed after one.
    """
    try:
        start = _pid_start(proc, pid)
        with open(proc / str(pid) / 'cgroup', 'rb') as stream:
            groups = stream.read(4096).decode('ascii').splitlines()
    except (OSError, UnicodeDecodeError, IndexError):
        raise Refused('IDENTITY_MISMATCH') from None
    need(len(groups) == 1 and groups[0].startswith('0::/'), 'IDENTITY_MISMATCH')
    relative = Path(groups[0][4:])
    need(str(relative) != '.' and not relative.is_absolute() and '..' not in relative.parts, 'IDENTITY_MISMATCH')
    high = entry['memoryHighMiB'] * MIB
    fd = os.open(cgroup, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        for part in relative.parts:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            os.close(fd)
            fd = child
        leaf = os.fstat(fd)

        def fenced():
            current = os.stat(cgroup / relative, follow_symlinks=False)
            with open(proc / str(pid) / 'cgroup', 'rb') as stream:
                same = stream.read(4096).decode('ascii').splitlines() == groups
            return (same and _pid_start(proc, pid) == start and
                    (current.st_dev, current.st_ino) == (leaf.st_dev, leaf.st_ino) and recheck())

        need(_read_at(fd, 'memory.max') == str(entry['memoryMaxMiB'] * MIB), 'HARD_LIMIT_MISMATCH')
        need(fenced(), 'IDENTITY_MISMATCH')
        try:
            writer = os.open('memory.high', os.O_WRONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=fd)
        except OSError as error:
            raise Refused('WRITE_REFUSED' if error.errno in (errno.EACCES, errno.EPERM, errno.EROFS)
                          else 'IDENTITY_MISMATCH') from None
        try:
            raw = (str(high) + '\n').encode()
            written = os.write(writer, raw)
        except OSError:
            raise EffectUnconfirmed() from None
        finally:
            os.close(writer)
        try:
            confirmed = (written == len(raw) and _read_at(fd, 'memory.high') == str(high) and
                         _read_at(fd, 'memory.max') == str(entry['memoryMaxMiB'] * MIB) and fenced())
        except (OSError, Refused):
            confirmed = False
        if not confirmed:
            raise EffectUnconfirmed()
        return high
    except OSError:
        raise Refused('IDENTITY_MISMATCH') from None
    finally:
        os.close(fd)
