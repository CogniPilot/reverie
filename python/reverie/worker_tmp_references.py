"""Bounded reference observations for non-destructive TMP retention only.

Unavailable metadata is reported, never treated as absence. Definite holders
are collected even when an earlier process is inaccessible. Strict destructive
clear keeps its existing complete inode/reference oracle.
"""
import os
from pathlib import Path
import stat

from .worker_cold_tmp import need, read_mount_table, _mount_location, _mount_path

MAX_PIDS = 16384
MAX_FDS_PER_PID = 8192
MAX_FDS_TOTAL = 262144
MAX_MAP_BYTES = 4 << 20
MAX_MAP_TOTAL = 256 << 20
MAX_UNIX_TOTAL = 64 << 20


def _bounded(path, limit):
    with path.open('rb') as stream:
        value = stream.read(limit + 1)
    need(len(value) <= limit, 'Temporary reference metadata bound exhausted')
    return value


def _fd_mount_id(path):
    # Kernel fdinfo may contain a very large epoll/inotify listing. Only its
    # fixed leading identity header is relevant; never read the event listing.
    selected = {}
    with path.open('rb') as stream:
        for _ in range(16):
            line = stream.readline(4097)
            need(len(line) <= 4096, 'FD identity header bound exhausted')
            if not line:
                break
            key, _, value = line.partition(b':')
            if key in (b'mnt_id', b'ino'):
                need(key not in selected and value.strip().isdigit(), 'FD identity header malformed')
                selected[key] = int(value.strip())
                if len(selected) == 2:
                    return selected[b'mnt_id']
    return None


def _pid_identity(base):
    fields = (base / 'stat').read_text().rsplit(')', 1)[1].split()
    need(len(fields) > 19 and fields[19].isdigit(), 'Process identity unavailable')
    return fields[0], fields[19]


def _index_table(rows):
    by_id, by_point = {}, {}
    for row in rows:
        by_id.setdefault(row['id'], []).append(row)
        by_point.setdefault(row['point'], []).append(row)
    return by_id, by_point


def _coordinate(path, table, mount_id=None):
    if table is None:
        return None
    by_id, by_point = table
    if mount_id is not None:
        rows = by_id.get(mount_id, ())
    else:
        parent = path
        while True:
            rows = by_point.get(parent, ())
            if rows:
                break
            if parent.parent == parent:
                return None
            parent = parent.parent
    if not rows:
        return None
    need(len(rows) == 1, 'Process reference mount coordinates are ambiguous')
    row = rows[0]
    if row['root'] is None or not path.is_relative_to(row['point']):
        return None
    return row['device'], row['root'] / path.relative_to(row['point'])


def collect(target, *, ignored_fds=(), proc=Path('/proc'), check=lambda: None,
            table_reader=read_mount_table):
    """Return known holders and explicit UNKNOWN records, without walking TMP.

    Bounds/credential corruption/identity drift refuse. Permission gaps are
    reportable ONLY for the caller's explicitly non-destructive strategy.
    This does not prove absence of undiscovered hardlink/path relationships.
    No process name or organizational role grants an exemption.
    """
    target = Path(target)
    value = target.stat()
    root_key = value.st_dev, value.st_ino
    target_coordinate = _mount_location(target, table_reader())
    names = [name for name in os.listdir(proc) if name.isdigit()]
    need(len(names) <= MAX_PIDS, 'Temporary process inventory bound exhausted')
    known, unknown, counts = [], [], {'known': 0, 'unknown': 0, 'ownedProcesses': 0, 'fds': 0, 'mapBytes': 0, 'unixBytes': 0}
    me, uid = os.getpid(), os.getuid()

    def record(bucket, pid, kind):
        counts[bucket] += 1
        examples = known if bucket == 'known' else unknown
        if len(examples) < 32:
            identity = 'observerPid' if kind == 'UNIX_SOCKET_REFERENCE_IN_NAMESPACE' else 'pid'
            examples.append({identity: pid, 'kind': kind})

    def matches(st, link, table, mount_id=None):
        if st is not None and (st.st_dev, st.st_ino) == root_key:
            return True
        if st is not None and st.st_dev != value.st_dev:
            return False
        if not link or not link.startswith('/'):
            return False
        raw = link.removesuffix(' (deleted)')
        try:
            path = _mount_path(raw)
        except (ValueError, RuntimeError):
            return False
        if table is not None and mount_id is not None and mount_id not in table[0]:
            # An inherited FD can retain a detached mount not represented in
            # this process's current mount namespace. Preserve it as UNKNOWN;
            # still visit every later reference and reject definite holders.
            record('unknown', pid, 'FD_MOUNT_NOT_IN_CURRENT_NAMESPACE')
            return False
        coordinate = _coordinate(path, table, mount_id)
        if coordinate is None:
            record('unknown', pid, 'REFERENCE_COORDINATES_UNAVAILABLE')
        if coordinate is not None and st is not None:
            need(coordinate[0] == (os.major(st.st_dev), os.minor(st.st_dev)),
                 'Process reference mount identity changed')
        return (coordinate is not None and coordinate[0] == target_coordinate[0] and
                coordinate[1].is_relative_to(target_coordinate[1]))

    for name in sorted(names, key=int):
        check()
        base, pid = proc / name, int(name)
        before = None
        try:
            raw = _bounded(base / 'status', 65536)
            rows = [line.split()[1:] for line in raw.splitlines() if line.startswith(b'Uid:')]
            need(len(rows) == 1 and len(rows[0]) == 4 and all(x.isdigit() for x in rows[0]),
                 'Process credentials unavailable')
            if uid not in {int(x) for x in rows[0]}:
                continue
            before = _pid_identity(base)
            if before[0] in ('Z', 'X'):
                continue
            counts['ownedProcesses'] += 1
            try:
                table = _index_table(table_reader(pid))
            except PermissionError:
                table = None
                record('unknown', pid, 'MOUNT_METADATA_UNAVAILABLE')
            except RuntimeError as error:
                if isinstance(error.__context__, PermissionError):
                    table = None
                    record('unknown', pid, 'MOUNT_METADATA_UNAVAILABLE')
                elif isinstance(error.__context__, (FileNotFoundError, ProcessLookupError)):
                    raise error.__context__
                else:
                    raise
            socket_inodes = set()
            try:
                descriptors = os.listdir(base / 'fd')
            except PermissionError:
                descriptors = []
                record('unknown', pid, 'FD_INVENTORY_UNAVAILABLE')
            need(len(descriptors) <= MAX_FDS_PER_PID, 'Process FD inventory bound exhausted')
            for descriptor in descriptors:
                check()
                need(descriptor.isdigit(), 'Process FD inventory malformed')
                counts['fds'] += 1
                need(counts['fds'] <= MAX_FDS_TOTAL, 'Total FD inventory bound exhausted')
                if pid == me and int(descriptor) in ignored_fds:
                    continue
                node = base / 'fd' / descriptor
                held, link, mount_id = None, None, None
                try:
                    held = node.stat()
                except FileNotFoundError:
                    continue
                except PermissionError:
                    record('unknown', pid, 'FD_IDENTITY_UNAVAILABLE')
                try:
                    link = os.readlink(node)
                except FileNotFoundError:
                    continue
                except PermissionError:
                    record('unknown', pid, 'FD_PATH_UNAVAILABLE')
                try:
                    mount_id = _fd_mount_id(base / 'fdinfo' / descriptor)
                    if mount_id is None:
                        record('unknown', pid, 'FD_MOUNT_METADATA_UNAVAILABLE')
                except FileNotFoundError:
                    continue
                except PermissionError:
                    record('unknown', pid, 'FD_MOUNT_METADATA_UNAVAILABLE')
                if held is not None and stat.S_ISSOCK(held.st_mode):
                    socket_inodes.add(held.st_ino)
                if matches(held, link, table, mount_id):
                    record('known', pid, 'FD_REFERENCE')
            try:
                raw_unix = _bounded(base / 'net/unix', MAX_MAP_BYTES)
                counts['unixBytes'] += len(raw_unix)
                need(counts['unixBytes'] <= MAX_UNIX_TOTAL, 'Unix socket inventory bound exhausted')
                unix_paths = {}
                for row in raw_unix.splitlines()[1:]:
                    fields = row.split(None, 7)
                    need(len(fields) >= 7 and fields[6].isdigit(), 'Unix socket metadata malformed')
                    if len(fields) == 8:
                        unix_paths.setdefault(int(fields[6]), []).append(fields[7].decode(errors='surrogateescape'))
                # Read after this PID's FD observation, without reusing another
                # PID's older network-table snapshot. No socket payload is read.
                for paths in unix_paths.values():
                    for path in paths:
                        if not path.startswith(('/', '@')):
                            record('unknown', pid, 'RELATIVE_UNIX_PATH_UNCLASSIFIED')
                        if matches(None, path, table):
                            record('known', pid, 'UNIX_SOCKET_REFERENCE_IN_NAMESPACE')
                for inode in socket_inodes:
                    paths = unix_paths.get(inode, [])
                    if any(matches(None, path, table) for path in paths):
                        record('known', pid, 'SOCKET_REFERENCE')
                    elif not paths:
                        record('unknown', pid, 'SOCKET_NAMESPACE_UNCLASSIFIED')
            except PermissionError:
                record('unknown', pid, 'SOCKET_METADATA_UNAVAILABLE')
            for kind in ('cwd', 'root', 'exe'):
                check()
                held, link = None, None
                try:
                    held = (base / kind).stat()
                    link = os.readlink(base / kind)
                except FileNotFoundError:
                    continue
                except PermissionError:
                    record('unknown', pid, kind.upper() + '_UNAVAILABLE')
                if matches(held, link, table):
                    record('known', pid, kind.upper() + '_REFERENCE')
            try:
                maps = _bounded(base / 'maps', MAX_MAP_BYTES)
                counts['mapBytes'] += len(maps)
                need(counts['mapBytes'] <= MAX_MAP_TOTAL, 'Process map inventory bound exhausted')
                for line in maps.splitlines():
                    check()
                    fields = line.split(None, 5)
                    need(len(fields) >= 5, 'Process map metadata malformed')
                    major, minor = fields[3].split(b':')
                    device, inode = os.makedev(int(major, 16), int(minor, 16)), int(fields[4])
                    if not inode:
                        continue
                    link = fields[5].decode(errors='surrogateescape') if len(fields) == 6 else None
                    if device == value.st_dev and link is None:
                        record('unknown', pid, 'MAP_PATH_UNAVAILABLE')
                    if (device, inode) == root_key or (device == value.st_dev and matches(None, link, table)):
                        record('known', pid, 'MAPPED_REFERENCE')
            except PermissionError:
                record('unknown', pid, 'MAP_INVENTORY_UNAVAILABLE')
            need(before[1] == _pid_identity(base)[1], 'Owned process identity changed during reference scan')
        except (FileNotFoundError, ProcessLookupError):
            if base.exists():
                try:
                    after = _pid_identity(base)
                except (FileNotFoundError, ProcessLookupError):
                    need(not base.exists(), 'Owned process inventory is incomplete')
                else:
                    need(after[0] in ('Z', 'X') and (before is None or before[1] == after[1]),
                         'Owned process inventory is incomplete')
        except (ValueError, IndexError, OSError):
            raise RuntimeError('Owned process metadata cannot be classified') from None
    check()
    current = target.stat()
    need((current.st_dev, current.st_ino) == root_key, 'Temporary root changed during reference scan')
    return {'knownReferences': known, 'unknownReferences': unknown, 'counts': counts,
            'allInitiallyEnumeratedProcessesVisited': True,
            'absenceOfReferencesProven': False,
            'treeWalkPerformed': False}
