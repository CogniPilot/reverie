"""Opt-in cold-only owned tmp clearing; never periodic pruning or reattachment.

The ordinary broker supplies its exclusive storage lease and fresh engine census.
Kernel build leases bar cooperating launchers through deletion. Root/operator
access remains the existing trusted host boundary; foreign-UID /proc visibility
is neither required nor claimed. Unknown same-UID references refuse.
"""
from contextlib import ExitStack
import inspect
import json
import os
import re
from pathlib import Path
import stat
import time
import uuid

MAX_ENTRIES = 4096
MAX_BYTES = 2 << 30
SECONDS = 10
PENDING = 'cold-tmp-cleanup.pending.json'


def need(ok, message='Cold temporary storage proof is unavailable'):
    if not ok:
        raise RuntimeError(message)


def policy(config):
    value = config.get('coldTemporaryCleanup')
    if value is None:
        return None
    if (type(value) is not dict or set(value) - {'strategy'} != {'version', 'enabled', 'hostLeaseDirectories'} or
            type(value['version']) is not int or value['version'] != 1 or value['enabled'] is not True or
            type(value['hostLeaseDirectories']) is not list or len(value['hostLeaseDirectories']) > 16 or
            value.get('strategy', 'clear') not in ('clear', 'retain-and-replace')):
        raise ValueError('Invalid cold temporary cleanup policy')
    result = []
    for name in value['hostLeaseDirectories']:
        if (type(name) is not str or '\0' in name or not Path(name).is_absolute() or
                str(Path(name)) != name or Path(name).resolve() != Path(name)):
            raise ValueError('Canonical host lease directories required')
        candidate = Path(name)
        protected = [Path(config[key]) for key in ('stateRoot', 'scratchRoot')]
        protected += [Path(m['source']).resolve() for m in config.get('mounts', [])]
        if any(candidate == base or candidate.is_relative_to(base) or base.is_relative_to(candidate) for base in protected):
            raise ValueError('Host lease directory overlaps a laptop grant')
        if name in result:
            raise ValueError('Duplicate host lease directory')
        result.append(name)
    return tuple(result)


def strategy(config):
    hosts = policy(config)
    return None if hosts is None else config['coldTemporaryCleanup'].get('strategy', 'clear')


def require_no_pending(paths):
    need(not os.path.lexists(Path(paths.root) / PENDING),
         'Prior cold temporary cleanup requires explicit reconciliation')


def _directory(path, uid):
    path = Path(path)
    need(path.resolve() == path)
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        value = os.fstat(fd)
        need(stat.S_ISDIR(value.st_mode) and value.st_uid == uid and not value.st_mode & 0o077)
        return fd
    except BaseException:
        os.close(fd)
        raise


def initialize_leases(config, paths, *, fresh_home):
    """Provision only a genuinely newly created home; never repair missing leases."""
    if policy(config) is None or not fresh_home:
        return
    fd = _directory(paths.home, config['uid'])
    try:
        for part in ('.local', 'state', 'reverie', 'leases'):
            try:
                os.mkdir(part, 0o700, dir_fd=fd)
                os.fsync(fd)
            except FileExistsError:
                pass
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            try:
                st = os.fstat(child)
                need(st.st_uid == config['uid'] and not st.st_mode & 0o077)
            except BaseException:
                os.close(child)
                raise
            os.close(fd)
            fd = child
    finally:
        os.close(fd)


def _mount_id(fd):
    # Same-device bind mounts are still separate mounts. O_PATH metadata plus
    # fdinfo detects these without following symlinks or reading file contents.
    raw = Path('/proc/self/fdinfo', str(fd)).read_text()
    rows = [row.split(':', 1)[1].strip() for row in raw.splitlines() if row.startswith('mnt_id:')]
    need(len(rows) == 1 and rows[0].isdigit(), 'Temporary mount identity is unknown')
    return int(rows[0])


def _mount_path(raw):
    escapes = {'040': ' ', '011': '\t', '012': '\n', '134': '\\'}
    need(not re.search(r'\\(?!040|011|012|134)', raw), 'Mount path encoding is unknown')
    value = re.sub(r'\\(040|011|012|134)', lambda m: escapes[m.group(1)], raw)
    path = Path(value)
    need(path.is_absolute() and not value.startswith('//') and '\0' not in value and str(path) == value and '..' not in path.parts)
    return path


def read_mount_table(pid='self'):
    """Bounded kernel namespace metadata; no directory or file-content walk."""
    need(pid == 'self' or type(pid) is int and pid > 0)
    base = Path('/proc') / str(pid)
    try:
        before = (base / 'stat').read_text().rsplit(')', 1)[1].split()[19]
        with (base / 'mountinfo').open('rb') as stream:
            raw = stream.read((1 << 20) + 1)
        need(len(raw) <= 1 << 20, 'Mount namespace inventory exceeds bound')
        result = []
        for row in raw.decode(errors='surrogateescape').splitlines():
            need(len(result) < 8192 and len(row) <= 16384, 'Mount namespace inventory exceeds bound')
            fields = row.split(); split = fields.index('-')
            need(split >= 6 and len(fields) >= split + 4)
            major, minor = fields[2].split(':')
            need(fields[0].isdigit() and major.isdigit() and minor.isdigit())
            result.append({'id': int(fields[0]), 'device': (int(major), int(minor)),
                           # nsfs and other pseudo-files may have an opaque non-path
                           # root. Retain it, never invent filesystem coordinates.
                           'root': _mount_path(fields[3]) if fields[3].startswith('/') else None,
                           'point': _mount_path(fields[4])})
        need(len({row['id'] for row in result}) == len(result))
        after = (base / 'stat').read_text().rsplit(')', 1)[1].split()[19]
        need(before == after, 'Mount namespace process binding changed')
        return result
    except (OSError, ValueError, IndexError):
        raise RuntimeError('Relevant mount namespace inventory is unavailable') from None


def _mount_location(path, table):
    fd = os.open(path, os.O_PATH | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        mount_id = _mount_id(fd); st = os.fstat(fd)
    finally:
        os.close(fd)
    rows = [row for row in table if row['id'] == mount_id]
    need(len(rows) == 1 and path.is_relative_to(rows[0]['point']), 'Native mount binding differs')
    row = rows[0]
    need(row['root'] is not None and row['device'] == (os.major(st.st_dev), os.minor(st.st_dev)))
    return row['device'], row['root'] / path.relative_to(row['point'])


def refuse_host_mount_aliases(target, source, host_table):
    target_device, target_root = _mount_location(target, host_table)
    source_device, source_root = _mount_location(source, host_table)
    overlap = lambda a, b: a == b or a.is_relative_to(b) or b.is_relative_to(a)
    need(not (target_device == source_device and overlap(source_root, target_root)),
         'A live or configured bind aliases protected storage')
    for row in host_table:
        if row['point'].is_relative_to(source) and row['device'] == target_device:
            need(row['root'] is not None and not overlap(row['root'], target_root),
                 'A live or configured bind contains a nested protected mount alias')
    return target_device, target_root, source_device, source_root


def refuse_mount_aliases(target, source, destination, host_table, container_table):
    """Bounded kernel roots cover broad and retained private nested aliases."""
    target_device, target_root, source_device, source_root = refuse_host_mount_aliases(target, source, host_table)
    overlap = lambda a, b: a == b or a.is_relative_to(b) or b.is_relative_to(a)
    base = [row for row in container_table if row['point'] == destination]
    need(len(base) == 1 and base[0]['device'] == source_device and base[0]['root'] == source_root,
         'Actual live bind namespace differs from its source')
    for row in container_table:
        if row['point'].is_relative_to(destination) and row['device'] == target_device:
            need(row['root'] is not None and not overlap(row['root'], target_root),
                 'A live container retains a nested protected mount alias')


def _stamp(st):
    return st.st_dev, st.st_ino, st.st_mode, st.st_uid, st.st_nlink, st.st_size, st.st_mtime_ns, st.st_ctime_ns


def _same_uid_references(keys, *, ignored_fds=(), proc=Path('/proc'), check=lambda: None):
    """No payload reads: only same-UID fd/map/exe/cwd/root inode metadata.

    The kernel's 0700 ownership boundary excludes other unprivileged UIDs. Host
    root is already trusted by the engine boundary. An inaccessible owned PID
    is UNKNOWN, not silently excluded. PID exits are the sole benign race.
    """
    uid, me = os.getuid(), os.getpid()
    for name in os.listdir(proc):
        check()
        if not name.isdigit():
            continue
        base = proc / name
        try:
            # Non-dumpable same-UID processes may have root-owned /proc
            # directories. Kernel credentials, not directory owner, select the
            # owned inventory; unknown credentials cannot silently disappear.
            with (base / 'status').open('rb') as stream:
                status = stream.read(65537)
            need(len(status) <= 65536, 'Process credential inventory exceeds bound')
            rows = [line.split()[1:] for line in status.splitlines() if line.startswith(b'Uid:')]
            need(len(rows) == 1 and len(rows[0]) == 4 and all(x.isdigit() for x in rows[0]))
            if uid not in {int(x) for x in rows[0]}:
                continue
            before = (base / 'stat').read_text().rsplit(')', 1)[1].split()
            if before[0] in ('Z', 'X'):
                continue
            for entry in os.listdir(base / 'fd'):
                if int(name) == me and int(entry) in ignored_fds:
                    continue
                try:
                    st = (base / 'fd' / entry).stat()
                except FileNotFoundError:
                    continue
                need((st.st_dev, st.st_ino) not in keys, 'Temporary storage has a live process reference')
            for link in ('cwd', 'root', 'exe'):
                try:
                    st = (base / link).stat()
                except FileNotFoundError:
                    continue
                need((st.st_dev, st.st_ino) not in keys, 'Temporary storage has a live process reference')
            with (base / 'maps').open('rb') as stream:
                raw = stream.read((4 << 20) + 1)
            need(len(raw) <= 4 << 20, 'Owned process map inventory exceeds bound')
            for line in raw.splitlines():
                fields = line.split(None, 5)
                need(len(fields) >= 5)
                major, minor = fields[3].split(b':')
                key = os.makedev(int(major, 16), int(minor, 16)), int(fields[4])
                need(key not in keys, 'Temporary storage has a live mapped file')
            after = (base / 'stat').read_text().rsplit(')', 1)[1].split()
            need(before[19] == after[19], 'Owned process identity changed during scan')
        except (FileNotFoundError, ProcessLookupError):
            # A disappearing fd is handled above. Disappearing process metadata
            # is benign ONLY when the process itself has exited.
            need(not base.exists(), 'Owned process reference inventory is incomplete')
        except (PermissionError, ValueError, IndexError, OSError):
            raise RuntimeError('Owned process reference inventory is unavailable') from None


def clear_cold_temporary(config, paths, native_guard, *, process_scan=_same_uid_references):
    """Clear this exact owned tmp only after canonical cold native admission.

    This function has no engine/stop/start port. Native guard must synchronously
    confirm lease, binding, stopped/absent prior target and complete bind census.
    A durable pending marker fences every partial/unknown deletion outcome.
    """
    hosts = policy(config)
    require_no_pending(paths)
    if hosts is None:
        return {'state': 'COLD_TMP_CLEANUP_DISABLED'}
    need(strategy(config) == 'clear', 'Non-destructive policy requires the retained TMP lifecycle')
    from .worker_tmp import prepare_temporary, IDENTITY
    from .cleanup import lease
    need(IDENTITY.fullmatch(paths.identity) and paths.kind in ('employee', 'session'))
    relative = ('employees', paths.identity) if paths.kind == 'employee' else (paths.identity,)
    need(Path(paths.scratch) == Path(config['scratchRoot']).joinpath(*relative))
    need(Path(paths.root) == Path(config['stateRoot']).joinpath(*relative) and Path(paths.home) == Path(paths.root) / 'home')
    target = prepare_temporary(config, paths.scratch)
    need(not Path(paths.root).is_relative_to(target))
    with ExitStack() as handles:
        rootfd = _directory(target, config['uid'])
        handles.callback(os.close, rootfd)
        controlfd = _directory(paths.root, config['uid'])
        handles.callback(os.close, controlfd)
        deadline, count, total = time.monotonic() + SECONDS, 0, 0
        original = os.fstat(rootfd)
        need(stat.S_IMODE(original.st_mode) == 0o700, 'Private writable temporary directory required')
        control_identity = os.fstat(controlfd)
        rootkey = original.st_dev, original.st_ino
        entries, keys = [], {rootkey}
        mount_id = _mount_id(rootfd)
        directories = {(): original}
        lease_fds = []

        def check():
            for path, descriptor in lease_fds:
                need(path.resolve() == path and _stamp(path.lstat())[:4] == _stamp(os.fstat(descriptor))[:4],
                     'Temporary lease directory changed')
            need(_stamp(Path(paths.root).lstat())[:4] == _stamp(control_identity)[:4], 'Cold temporary control directory changed')
            need(time.monotonic() < deadline, 'Cold temporary cleanup deadline exhausted')
            need(_stamp(target.lstat())[:4] == _stamp(os.fstat(rootfd))[:4] and target.resolve() == target,
                 'Temporary storage root changed')

        def guard():
            check()
            result = native_guard(frozenset(keys))
            if inspect.iscoroutine(result):
                result.close()
            need(result is None, 'Synchronous native cold admission required')
            check()

        def scan(fd, parts=()):
            nonlocal count, total
            names = []
            with os.scandir(fd) as stream:
                for entry in stream:
                    check()
                    count += 1
                    need(count <= MAX_ENTRIES, 'Cold temporary entry bound exceeded')
                    names.append(entry.name)
            for name in sorted(names):
                check()
                need(name not in ('.keep', '.reverie-task.json', '.git', '.hg', '.svn'),
                     'Temporary storage contains a preservation or task/source marker')
                st = os.stat(name, dir_fd=fd, follow_symlinks=False)
                need(st.st_dev == original.st_dev and st.st_uid == config['uid'])
                metadata_fd = os.open(name, os.O_PATH | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
                try:
                    need(_stamp(os.fstat(metadata_fd)) == _stamp(st) and _mount_id(metadata_fd) == mount_id,
                         'Temporary storage contains a nested or changed mount')
                finally:
                    os.close(metadata_fd)
                need(stat.S_ISDIR(st.st_mode) or stat.S_ISREG(st.st_mode) or stat.S_ISLNK(st.st_mode),
                     'Temporary storage contains live or special state')
                need(not stat.S_ISREG(st.st_mode) or st.st_nlink == 1, 'Temporary file has another hardlink')
                total += st.st_size
                need(total <= MAX_BYTES, 'Cold temporary byte bound exceeded')
                keys.add((st.st_dev, st.st_ino))
                if stat.S_ISDIR(st.st_mode):
                    child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
                    try:
                        need(_stamp(os.fstat(child)) == _stamp(st))
                        directories[parts + (name,)] = st
                        scan(child, parts + (name,))
                    finally:
                        os.close(child)
                entries.append((parts + (name,), st))

        def parent(parts):
            fd = os.dup(rootfd)
            try:
                prefix = ()
                for part in parts:
                    prefix += (part,)
                    held = os.stat(part, dir_fd=fd, follow_symlinks=False)
                    need(_stamp(held)[:4] == _stamp(directories[prefix])[:4], 'Temporary ancestor changed')
                    child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
                    try:
                        need((os.fstat(child).st_dev, os.fstat(child).st_ino) == (held.st_dev, held.st_ino) and _mount_id(child) == mount_id)
                    except BaseException:
                        os.close(child)
                        raise
                    os.close(fd)
                    fd = child
                return fd
            except BaseException:
                os.close(fd)
                raise

        def record(name, value):
            fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=controlfd)
            try:
                raw = json.dumps(value, sort_keys=True).encode()
                while raw:
                    sent = os.write(fd, raw)
                    need(sent > 0)
                    raw = raw[sent:]
                os.fsync(fd)
                identity = os.fstat(fd)
            finally:
                os.close(fd)
            os.fsync(controlfd)
            return identity

        ownbase = Path(paths.home) / '.local/state/reverie/leases'
        bases = [ownbase, *(Path(p) for p in hosts)]
        need(len(set(map(str, bases))) == len(bases), 'Duplicate temporary lease inventory')
        for base in bases:
            fd = _directory(base, config['uid'])
            lease_fds.append((base, fd))
            handles.callback(os.close, fd)
            need(not (base == target or base.is_relative_to(target)), 'Lease directory overlaps disposable tmp')
        guard()
        with lease.janitor(str(target), str(paths.scratch), bases=bases, max_entries=MAX_ENTRIES, deadline=deadline):
            scan(rootfd)
            guard()
            process_scan(frozenset(keys), ignored_fds={rootfd}, check=check)
            check()
            attempt = str(uuid.uuid4())
            pending_identity = record(PENDING, {'version': 1, 'attemptId': attempt, 'state': 'ATTEMPT',
                             'identity': paths.identity, 'sessionId': paths.session,
                             'tmpDevice': rootkey[0], 'tmpInode': rootkey[1]})
            guard()
            for parts, expected in entries:
                check()
                fd = parent(parts[:-1])
                try:
                    current = os.stat(parts[-1], dir_fd=fd, follow_symlinks=False)
                    # Directory metadata changes while its accepted children are
                    # removed; identity/type/owner must remain exact.
                    relevant = lambda s: _stamp(s)[:4] if stat.S_ISDIR(s.st_mode) else _stamp(s)
                    need(relevant(current) == relevant(expected), 'Temporary entry changed before removal')
                    if stat.S_ISDIR(current.st_mode):
                        os.rmdir(parts[-1], dir_fd=fd)
                    else:
                        os.unlink(parts[-1], dir_fd=fd)
                finally:
                    os.close(fd)
            guard()
            process_scan(frozenset(keys), ignored_fds={rootfd}, check=check)
            need(os.listdir(rootfd) == [] and os.fstat(rootfd).st_mode & 0o777 == 0o700)
            os.fsync(rootfd)
            record('cold-tmp-complete-' + attempt + '.json', {'version': 1, 'attemptId': attempt,
                   'state': 'COMPLETE', 'identity': paths.identity, 'sessionId': paths.session,
                   'removedEntries': count, 'tmpDevice': rootkey[0], 'tmpInode': rootkey[1]})
            check()
            need(_stamp(os.stat(PENDING, dir_fd=controlfd, follow_symlinks=False)) == _stamp(pending_identity), 'Cold temporary pending marker changed')
            # Completion and its directory entry are durable while PENDING
            # remains. Lease/descriptor finalizers must also finish before the
            # fence is released; any error still leaves that durable fence.
            result = {'state': 'COLD_TMP_CLEARED', 'removedEntries': count,
                      'tmpDevice': rootkey[0], 'tmpInode': rootkey[1]}
        check()
    # This private control path is outside every laptop grant and remains under
    # the caller's exclusive EID storage custody. All fallible finalizers above
    # have completed. Release is the last syscall: deliberately no fsync or
    # other fallible operation afterward. A crash may conservatively resurrect
    # the already durable fence; it cannot make business completion less durable.
    need(time.monotonic() < deadline, 'Cold temporary cleanup deadline exhausted')
    need(Path(paths.root).resolve() == Path(paths.root) and
         _stamp(Path(paths.root).lstat())[:4] == _stamp(control_identity)[:4],
         'Cold temporary control directory changed before final release')
    need(_stamp((Path(paths.root) / PENDING).lstat()) == _stamp(pending_identity),
         'Cold temporary pending marker changed before final release')
    os.unlink(Path(paths.root) / PENDING)
    return result
