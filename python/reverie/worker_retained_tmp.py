"""Explicit non-destructive cold TMP retirement; no old-tree walk or deletion.

Known holders still refuse. Permission-unknown observations are retained as
UNKNOWN and all old bytes stay under permanent preservation. Namespace intent
remains fenced until the canonical broker confirms its new container before CLI.
"""
from contextlib import ExitStack
import ctypes
from dataclasses import dataclass
import hashlib
import inspect
import json
import os
from pathlib import Path
import stat
import time
import uuid

from .cleanup import lease
from .worker_cold_tmp import (PENDING, _directory, _stamp, _mount_id, _mount_location,
                              need, policy, strategy, require_no_pending, read_mount_table)
from .worker_tmp import prepare_temporary, IDENTITY
from .worker_tmp_references import collect

SECONDS = 30
MARKERS = ('.keep', '.reverie-task.json', '.git', '.hg', '.svn')


def retired_root(config, paths):
    need(paths.kind in ('employee', 'session') and IDENTITY.fullmatch(paths.identity))
    return Path(config['scratchRoot']) / '.reverie-retained-tmp' / (paths.kind + '-' + paths.identity)


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def _sync_guard(callback, *args):
    value = callback(*args)
    if inspect.iscoroutine(value):
        value.close()
    need(value is None, 'Synchronous retained TMP native admission required')


def _private_child(parentfd, name, uid):
    try:
        os.mkdir(name, 0o700, dir_fd=parentfd)
        os.fsync(parentfd)
    except FileExistsError:
        pass
    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parentfd)
    try:
        value = os.fstat(fd)
        need(value.st_uid == uid and stat.S_IMODE(value.st_mode) == 0o700)
        return fd
    except BaseException:
        os.close(fd)
        raise


def _lease_path_candidates(config, paths, recorded, key):
    """Translate only known canonical laptop mounts, then verify inode keys.

    Guest metadata may name /tmp or /home/agent after its old laptop stops.
    Namespace-aware symlink resolution never interprets a guest absolute link
    as a host root. No new mount/path authority is granted by these records.
    """
    mappings = [(Path('/tmp'), Path(paths.scratch)/'tmp'),
                (Path('/scratch'), Path(paths.scratch)),
                (Path('/home/agent'), Path(paths.home)),
                (Path('/nix'), Path(paths.root)/'nix')]
    mappings += [(Path(m['destination']), Path(m['source']).resolve(strict=True)) for m in config.get('mounts', [])]
    if not any(destination == Path('/workspace') for destination, _source in mappings):
        shared = [source for destination, source in mappings if destination == Path('/reverie_workspace')]
        if len(shared) == 1:
            mappings.append((Path('/workspace'), shared[0]))
    candidates = []
    try:
        candidates.append(recorded.resolve(strict=True))
    except OSError:
        pass
    guest = recorded
    links = 0
    try:
        while True:
            matches = [(destination, source) for destination, source in mappings if guest.is_relative_to(destination)]
            if not matches:
                break
            depth = max(len(destination.parts) for destination, _source in matches)
            matches = [(destination, source) for destination, source in matches if len(destination.parts) == depth]
            need(len(matches) == 1, 'Ambiguous canonical lease mount translation')
            destination, source = matches[0]
            relative = guest.relative_to(destination).parts
            need(len(relative) <= 256, 'Lease namespace path bound exhausted')
            current, logical = source, destination
            restarted = False
            for index, part in enumerate(relative):
                current, logical = current/part, logical/part
                value = current.lstat()
                if stat.S_ISLNK(value.st_mode):
                    links += 1
                    need(links <= 40, 'Lease namespace symlink bound exhausted')
                    target = Path(os.readlink(current))
                    next_path = target if target.is_absolute() else logical.parent/target
                    normalized = []
                    for component in next_path.parts[1:]:
                        if component == '..':
                            need(bool(normalized), 'Lease namespace path escaped root')
                            normalized.pop()
                        elif component != '.':
                            normalized.append(component)
                    guest = Path('/').joinpath(*normalized, *relative[index+1:])
                    restarted = True
                    break
            if restarted:
                continue
            candidates.append(current.resolve(strict=True))
            break
    except (FileNotFoundError, NotADirectoryError, PermissionError):
        pass
    found = []
    for candidate in candidates:
        try:
            if candidate not in found and lease.key_of(candidate) == key:
                found.append(candidate)
        except (OSError, lease.LeaseError):
            pass
    return tuple(found)


def _record(directoryfd, name, value):
    raw = json.dumps(value, sort_keys=True).encode()
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=directoryfd)
    try:
        view = memoryview(raw)
        while view:
            count = os.write(fd, view)
            need(count > 0)
            view = view[count:]
        os.fsync(fd)
        result = os.fstat(fd)
    finally:
        os.close(fd)
    os.fsync(directoryfd)
    return result, hashlib.sha256(raw).hexdigest()


def _rename_noreplace(sourcefd, source, destinationfd, destination):
    """Fixed ordinary Linux no-replace rename; no shell or privileged port."""
    library = ctypes.CDLL(None, use_errno=True)
    function = getattr(library, 'renameat2', None)
    need(function is not None, 'Atomic no-replace rename is unavailable')
    function.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint)
    function.restype = ctypes.c_int
    if function(sourcefd, os.fsencode(source), destinationfd, os.fsencode(destination), 1) != 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))


def _key(value):
    return value.st_dev, value.st_ino


@dataclass(frozen=True)
class RetentionReady:
    epoch: str
    identity: str
    session: str
    owner: str | None
    envelope: Path
    data: Path
    old_key: tuple[int, int]
    new_key: tuple[int, int]
    control_stamp: tuple
    envelope_stamp: tuple
    retired_stamp: tuple
    keep_stamp: tuple
    pending_stamp: tuple
    config_digest: str
    prepared_digest: str
    reservation_until: float


def prepare_retained(config, paths, native_guard, *, references=collect):
    """Retire old TMP and publish a fresh directory; KEEP universal fence.

    No engine/CLI or deletion port. A later fixed canonical-broker commit must
    confirm the actual new container before releasing this exact transaction.
    """
    hosts = policy(config)
    require_no_pending(paths)
    need(hosts is not None and strategy(config) == 'retain-and-replace', 'Explicit retained TMP policy required')
    expected = ('employees', paths.identity) if paths.kind == 'employee' else (paths.identity,)
    need(Path(paths.scratch) == Path(config['scratchRoot']).joinpath(*expected))
    need(Path(paths.root) == Path(config['stateRoot']).joinpath(*expected) and Path(paths.home) == Path(paths.root) / 'home')
    target = prepare_temporary(config, paths.scratch)
    epoch = str(uuid.uuid4())
    private_root = retired_root(config, paths)
    envelope = private_root / epoch
    deadline = time.monotonic() + SECONDS
    with ExitStack() as stack:
        parentfd = _directory(paths.scratch, config['uid']); stack.callback(os.close, parentfd)
        oldfd = _directory(target, config['uid']); stack.callback(os.close, oldfd)
        controlfd = _directory(paths.root, config['uid']); stack.callback(os.close, controlfd)
        original, parent, control = os.fstat(oldfd), os.fstat(parentfd), os.fstat(controlfd)
        need(stat.S_IMODE(original.st_mode) == 0o700 and _mount_id(oldfd) == _mount_id(parentfd))
        for name in MARKERS:
            try:
                os.stat(name, dir_fd=oldfd, follow_symlinks=False)
            except FileNotFoundError:
                continue
            raise RuntimeError('Temporary root has a preservation or unfinished-task marker')
        scratchfd = os.open(config['scratchRoot'], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        stack.callback(os.close, scratchfd)
        scratch = os.fstat(scratchfd)
        need(scratch.st_uid == config['uid'] and not scratch.st_mode & 0o022)
        need(_mount_id(scratchfd) == _mount_id(parentfd), 'Retirement parent mount differs from TMP')
        retainedfd = _private_child(scratchfd, '.reverie-retained-tmp', config['uid']); stack.callback(os.close, retainedfd)
        need(_mount_id(retainedfd) == _mount_id(oldfd), 'Retirement root is a different mount')
        storagefd = _private_child(retainedfd, paths.kind + '-' + paths.identity, config['uid']); stack.callback(os.close, storagefd)
        os.mkdir(epoch, 0o700, dir_fd=storagefd); os.fsync(storagefd)
        epochfd = _private_child(storagefd, epoch, config['uid']); stack.callback(os.close, epochfd)
        need(os.fstat(epochfd).st_dev == original.st_dev and _mount_id(epochfd) == _mount_id(oldfd),
             'Retirement must stay on the TMP filesystem and mount')
        keep, _ = _record(epochfd, '.keep', {'purpose': 'Retained old TMP; not disposable; separate reclamation admission required'})
        ownbase = Path(paths.home) / '.local/state/reverie/leases'
        bases = [ownbase, *(Path(p) for p in hosts)]
        need(len(set(map(str, bases))) == len(bases), 'Duplicate retained TMP lease inventory')
        lease_descriptors = []
        for base in bases:
            fd = _directory(base, config['uid']); stack.callback(os.close, fd)
            lease_descriptors.append((base, fd))
        reservation_key = lease.reserve(envelope, '24h', owner='retained-cold-tmp', wait=0, base=ownbase)
        ownfd = _directory(ownbase, config['uid']); stack.callback(os.close, ownfd)
        for suffix in ('.path.json', '.reserve.json'):
            fd = os.open(reservation_key + suffix, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=ownfd)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        os.fsync(ownfd)
        reservation = lease._retirement_record(ownfd, reservation_key + '.reserve.json')
        reservation_until = reservation['until_utc']
        host_table = read_mount_table()
        target_coordinate = _mount_location(target, host_table)
        scope_coordinate = _mount_location(Path(paths.scratch), host_table)
        for row in host_table:
            need(not (row['point'] != target and row['point'].is_relative_to(target)),
                 'Temporary tree contains a known nested mount')
        def related(path):
            device, inside = _mount_location(path.resolve(strict=True), host_table)
            return device == target_coordinate[0] and (inside.is_relative_to(target_coordinate[1]) or
                   (target_coordinate[1].is_relative_to(inside) and inside.is_relative_to(scope_coordinate[1])))
        def check_deadline():
            need(time.monotonic() < deadline, 'Retained TMP publication deadline exhausted')
        def check():
            check_deadline()
            for base, descriptor in lease_descriptors:
                need(base.resolve() == base and _stamp(base.lstat())[:4] == _stamp(os.fstat(descriptor))[:4],
                     'Retained TMP lease directory changed')
            need(_stamp(Path(paths.root).lstat())[:4] == _stamp(control)[:4], 'Retained TMP control custody changed')
            need(_stamp(Path(paths.scratch).lstat())[:4] == _stamp(parent)[:4], 'Retained TMP parent custody changed')
            check_deadline()
        def guard(keys):
            check(); _sync_guard(native_guard, frozenset(keys)); check()
        with lease.retirement(target, Path(paths.scratch), bases, deadline=deadline, related=related,
                              resolve_paths=lambda path, key: _lease_path_candidates(config, paths, path, key)):
            guard({_key(original)})
            # Keep a clock check at every observer entry. Pinned directory FDs,
            # lease barriers and full checks bracket each scan/publication;
            # resolving all anchors per FD/map row adds unrelated filesystem IO.
            check()
            observations = references(target, ignored_fds={oldfd}, check=check_deadline)
            check()
            need(observations['counts']['known'] == 0, 'Known live temporary reference refuses retirement')
            need(observations['allInitiallyEnumeratedProcessesVisited'] is True)
            check()
            need(_key(target.lstat()) == _key(original) and not target.is_symlink(), 'Original TMP changed before retirement')
            intent = {'version': 1, 'strategy': 'retain-and-replace', 'state': 'RETIREMENT_INTENT',
                      'attemptId': epoch, 'identity': paths.identity, 'sessionId': paths.session,
                      'owner': getattr(paths, 'owner', None),
                      'oldDevice': original.st_dev, 'oldInode': original.st_ino,
                      'retainedData': str(envelope / 'data'), 'freshStage': '.cold-fresh-' + epoch,
                      'oldDataDeleted': False, 'deepTreeInspected': False,
                      'referenceObservations': observations, 'configDigest': _digest(config)}
            pending, _ = _record(controlfd, PENDING, intent)
            stage_name = '.cold-fresh-' + epoch
            os.mkdir(stage_name, 0o700, dir_fd=parentfd)
            freshfd = os.open(stage_name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parentfd)
            stack.callback(os.close, freshfd)
            fresh = os.fstat(freshfd)
            need(fresh.st_uid == config['uid'] and stat.S_IMODE(fresh.st_mode) == 0o700 and fresh.st_dev == original.st_dev and _key(fresh) != _key(original))
            probe = os.open('.owned-write-probe', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=freshfd)
            try:
                need(os.write(probe, b'fresh TMP writable') == len(b'fresh TMP writable'))
                os.fsync(probe)
            finally:
                os.close(probe)
            # Only this newly created preparatory probe is removed. No old-tree
            # object is unlinked, read, walked or classified as disposable.
            os.unlink('.owned-write-probe', dir_fd=freshfd)
            os.fsync(freshfd); os.fsync(parentfd)
            guard({_key(original)})
            need(_key(os.stat('tmp', dir_fd=parentfd, follow_symlinks=False)) == _key(original))
            _rename_noreplace(parentfd, 'tmp', epochfd, 'data')
            os.fsync(parentfd); os.fsync(epochfd)
            need(_key(os.stat('data', dir_fd=epochfd, follow_symlinks=False)) == _key(original), 'Retired data custody differs')
            check()
            need(_key(os.stat(stage_name, dir_fd=parentfd, follow_symlinks=False)) == _key(fresh))
            _rename_noreplace(parentfd, stage_name, parentfd, 'tmp')
            os.fsync(parentfd); os.fsync(freshfd)
            need(_key(target.lstat()) == _key(fresh) and not target.is_symlink())
            guard({_key(original), _key(fresh)})
            # Do not stop after an early permission gap: a now-known holder
            # remains a refusal, and the intent fences this partial transition.
            check()
            after_refs = references(envelope / 'data', ignored_fds={oldfd}, check=check_deadline)
            check()
            need(after_refs['counts']['known'] == 0, 'Known retired-tree holder appeared during publication')
            need(after_refs['allInitiallyEnumeratedProcessesVisited'] is True)
            observations = {'before': observations, 'after': after_refs}
            prepared = {'version': 1, 'state': 'OLD_TMP_RETAINED_FRESH_TMP_FENCED', 'attemptId': epoch,
                        'identity': paths.identity, 'sessionId': paths.session, 'owner': getattr(paths, 'owner', None),
                        'oldDevice': original.st_dev, 'oldInode': original.st_ino,
                        'newDevice': fresh.st_dev, 'newInode': fresh.st_ino,
                        'retainedData': str(envelope / 'data'), 'oldDataDeleted': False,
                        'deepTreeInspected': False, 'reservationUntil': reservation_until,
                        'preservationMarker': str(envelope / '.keep'), 'references': observations}
            _, prepared_digest = _record(controlfd, 'cold-tmp-retained-ready-' + epoch + '.json', prepared)
            check()
            need(_stamp(os.stat(PENDING, dir_fd=controlfd, follow_symlinks=False)) == _stamp(pending))
            ready = RetentionReady(epoch, paths.identity, paths.session, getattr(paths, 'owner', None),
                                   envelope, envelope / 'data', _key(original), _key(fresh),
                                   _stamp(control)[:4], _stamp(os.fstat(epochfd))[:4],
                                   _stamp(os.fstat(storagefd))[:4], _stamp(keep), _stamp(pending), _digest(config),
                                   prepared_digest, reservation_until)
        check()
    # All preparation finalizers completed. PENDING intentionally remains until
    # the canonical broker commits an actual new container before any CLI.
    return ready


def finish_retained(config, paths, ready, native_confirmation, *, references=collect):
    """Commit exact prepared namespace to its actual canonical new container.

    Fixed internal broker call only; no guest/API reconciliation or retry port.
    Every fallible finalizer precedes last fence unlink.
    """
    need(type(ready) is RetentionReady and strategy(config) == 'retain-and-replace')
    need(_digest(config) == ready.config_digest, 'Retained TMP policy changed before commit')
    need((paths.identity, paths.session, getattr(paths, 'owner', None)) ==
         (ready.identity, ready.session, ready.owner), 'Retained TMP employee/session/owner binding changed')
    need(ready.envelope.parent == retired_root(config, paths) and ready.data == ready.envelope / 'data')
    target = Path(paths.scratch) / 'tmp'
    def verify():
        need(Path(paths.root).resolve() == Path(paths.root) and _stamp(Path(paths.root).lstat())[:4] == ready.control_stamp)
        need(ready.envelope.resolve() == ready.envelope and _stamp(ready.envelope.lstat())[:4] == ready.envelope_stamp,
             'Retired epoch envelope custody changed')
        need(_stamp(ready.envelope.parent.lstat())[:4] == ready.retired_stamp, 'Retired root custody changed')
        old = ready.data.lstat()
        need(ready.data.resolve() == ready.data and _key(old) == ready.old_key and
             old.st_uid == config['uid'] and stat.S_IMODE(old.st_mode) == 0o700)
        need(target.resolve() == target and _key(target.lstat()) == ready.new_key and stat.S_IMODE(target.stat().st_mode) == 0o700)
        need(_stamp((Path(paths.root) / PENDING).lstat()) == ready.pending_stamp, 'Retained TMP fence changed')
        marker = ready.envelope / '.keep'
        need(_stamp(marker.lstat()) == ready.keep_stamp and marker.is_file() and not marker.is_symlink())
    def confirmed():
        value = native_confirmation()
        if inspect.iscoroutine(value):
            value.close()
        need(type(value) is dict and set(value) == {'containerId', 'image', 'pid', 'startTick'},
             'Closed canonical container confirmation required')
        need(type(value['containerId']) is str and len(value['containerId']) == 64 and all(c in '0123456789abcdef' for c in value['containerId']))
        need(value['image'] == config['image'] and type(value['pid']) is int and value['pid'] > 0 and type(value['startTick']) is str and value['startTick'].isdigit())
        return value
    verify()
    native = confirmed()
    with ExitStack() as stack:
        deadline = time.monotonic() + SECONDS
        ownbase = Path(paths.home) / '.local/state/reverie/leases'
        bases = [ownbase, *(Path(p) for p in policy(config))]
        lease_descriptors = []
        for base in bases:
            descriptor = _directory(base, config['uid']); stack.callback(os.close, descriptor)
            lease_descriptors.append((base, descriptor))
        def check_deadline():
            need(time.monotonic() < deadline, 'Retained TMP commit deadline exhausted')
        def check():
            check_deadline()
            for base, descriptor in lease_descriptors:
                need(base.resolve() == base and _stamp(base.lstat())[:4] == _stamp(os.fstat(descriptor))[:4],
                     'Retained TMP commit lease directory changed')
            verify()
            check_deadline()
        host_table = read_mount_table()
        target_coordinate = _mount_location(target, host_table)
        scope_coordinate = _mount_location(Path(paths.scratch), host_table)
        def related(path):
            device, inside = _mount_location(path.resolve(strict=True), host_table)
            return device == target_coordinate[0] and (inside.is_relative_to(target_coordinate[1]) or
                   (target_coordinate[1].is_relative_to(inside) and inside.is_relative_to(scope_coordinate[1])))
        stack.enter_context(lease.retirement(target, Path(paths.scratch), bases, deadline=deadline, related=related,
                              resolve_paths=lambda path, key: _lease_path_candidates(config, paths, path, key)))
        commit_references = []
        for observed in (ready.data, target):
            check()
            current_refs = references(observed, check=check_deadline)
            check()
            need(current_refs['allInitiallyEnumeratedProcessesVisited'] is True)
            need(current_refs['counts']['known'] == 0, 'Known temporary reference appeared before canonical startup')
            commit_references.append(current_refs)
        controlfd = _directory(paths.root, config['uid']); stack.callback(os.close, controlfd)
        need(_stamp(os.fstat(controlfd))[:4] == ready.control_stamp)
        fd = os.open('cold-tmp-retained-ready-' + ready.epoch + '.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=controlfd)
        try:
            raw = os.read(fd, 262145)
            need(len(raw) <= 262144 and hashlib.sha256(raw).hexdigest() == ready.prepared_digest)
            prepared = json.loads(raw)
            need((prepared['identity'], prepared['sessionId'], prepared['owner']) ==
                 (ready.identity, ready.session, ready.owner))
        finally:
            os.close(fd)
        result = {'version': 1, 'state': 'OLD_TMP_RETAINED_FRESH_TMP_READY', 'attemptId': ready.epoch,
                  'identity': paths.identity, 'sessionId': paths.session, 'owner': ready.owner,
                  'oldDevice': ready.old_key[0], 'oldInode': ready.old_key[1],
                  'newDevice': ready.new_key[0], 'newInode': ready.new_key[1],
                  'retainedData': str(ready.data), 'oldDataDeleted': False, 'deepTreeInspected': False,
                  'reservationUntil': ready.reservation_until, 'permanentKeepMarker': True,
                  'references': prepared['references'], 'commitReferences': commit_references, 'nativeContainer': native}
        durable_outcome = {**result, 'state': 'OLD_TMP_RETAINED_FRESH_TMP_BOUND_PENDING_RELEASE',
                           'requiresAbsentFenceForUse': PENDING}
        _record(controlfd, 'cold-tmp-retained-' + ready.epoch + '.json', durable_outcome)
        verify()
    # No descriptor cleanup, flush or publication follows the last unlink.
    need(time.monotonic() < deadline, 'Retained TMP commit deadline exhausted')
    need(confirmed() == native, 'Canonical container binding changed before fence release')
    need(time.monotonic() < deadline, 'Retained TMP commit deadline exhausted')
    verify()
    os.unlink(Path(paths.root) / PENDING)
    return result
