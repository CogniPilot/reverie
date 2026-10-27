"""Private durable RAM claims and effect-intent journal, without native effects.

Only a fixed service may supply the scope guard and capacity observer. Digests,
UUIDs, a private directory and the returned handles do not grant host authority.
The capacity observer must share the future host admission serialization; repeated
observations here are checks, not a replacement for that native transaction.

Every claimed positive delta remains charged, including after process restart,
cancellation or recorded verification. This component has NO release, completion,
deletion, host-config, broker, launch, recovery actor or public HTTP endpoint.
Protected native settlement and any credit require a separately reviewed slice.
"""
import copy
import fcntl
import hashlib
import json
import os
import re
import secrets
import stat
import threading
import uuid
from pathlib import Path

SCHEMA = 'reverie-laptop-resource-operations-v1'
MAX_BYTES = 524288
MAX_OPERATIONS = 256
MAX_VERSION = 9007199254740991
MAX_UINT64 = '18446744073709551615'
MIB = 1048576
STATES = frozenset(('RESERVED', 'PREPARING', 'PREPARED', 'STARTING',
                    'STARTED', 'VERIFYING', 'VERIFY_RECORDED', 'RECOVERY_REQUIRED'))
EFFECTS = {'prepare': ('RESERVED', 'PREPARING', 'PREPARED'),
           'start': ('PREPARED', 'STARTING', 'STARTED'),
           'verify': ('STARTED', 'VERIFYING', 'VERIFY_RECORDED')}


class OperationRefusal(ValueError):
    pass


class OperationCommitUncertain(OperationRefusal):
    """A rename was attempted, or a later response/cleanup check failed.

    Keep all claims and inspect; never infer rollback or retry permission.
    """


def need(condition, code):
    if not condition:
        raise OperationRefusal(code)


def exact(value, keys):
    need(type(value) is dict and set(value) == set(keys), 'CLOSED_SCHEMA')


def canonical_uuid(value):
    need(type(value) is str and len(value) == 36, 'UUID')
    try:
        parsed = uuid.UUID(value)
    except (ValueError, AttributeError) as error:
        raise OperationRefusal('UUID') from error
    need(str(parsed) == value and parsed.int != 0, 'UUID')


def digest(value):
    need(type(value) is str and re.fullmatch('[0-9a-f]{64}', value), 'DIGEST')


def version(value, positive=False):
    need(type(value) is int and int(positive) <= value <= MAX_VERSION, 'VERSION')


def wide(value, positive=False):
    need(type(value) is str and 1 <= len(value) <= 20
         and re.fullmatch('0|[1-9][0-9]*', value), 'UINT64')
    need(len(value) < 20 or value <= MAX_UINT64, 'UINT64')
    result = int(value)
    need(not positive or result > 0, 'POSITIVE_MEMORY')
    return result


def memory(value):
    result = wide(value, True)
    need(result % MIB == 0 and result // MIB <= MAX_VERSION, 'REPRESENTABLE_MEMORY')
    return result


def scope(value):
    exact(value, ('owner_scope_digest', 'company_id'))
    digest(value['owner_scope_digest'])
    canonical_uuid(value['company_id'])


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def fingerprint(value):
    return hashlib.sha256(encode(value)).hexdigest()


def request(value):
    exact(value, ('employee_id', 'pool_id', 'source_binding_digest', 'profile_version',
                  'requested_memory_bytes', 'preview_digest', 'observation_digest'))
    canonical_uuid(value['employee_id'])
    canonical_uuid(value['pool_id'])
    for key in ('source_binding_digest', 'preview_digest', 'observation_digest'):
        digest(value[key])
    n = wide(value['profile_version'])
    need(n <= MAX_VERSION, 'PROFILE_VERSION')
    memory(value['requested_memory_bytes'])


def observation(value):
    exact(value, ('pool_id', 'pool_revision_digest', 'budget_bytes', 'committed_bytes',
                  'employee_id', 'current_sid', 'generation', 'source_binding_digest',
                  'profile_version', 'current_memory_bytes'))
    for key in ('pool_id', 'employee_id', 'current_sid'):
        canonical_uuid(value[key])
    for key in ('pool_revision_digest', 'source_binding_digest'):
        digest(value[key])
    need(wide(value['generation'], True) <= MAX_VERSION, 'GENERATION')
    need(wide(value['profile_version']) <= MAX_VERSION, 'PROFILE_VERSION')
    allocated = memory(value['current_memory_bytes'])
    committed = wide(value['committed_bytes'])
    need(allocated <= committed <= wide(value['budget_bytes'], True), 'POOL_CAPACITY')


def operation(value, key):
    exact(value, ('id', 'scope', 'idempotency_key', 'request', 'request_digest',
                  'reservation_id', 'reserved_sid', 'observation', 'delta_bytes',
                  'version', 'state', 'last_receipt_digest', 'reason'))
    canonical_uuid(key)
    need(value['id'] == key, 'OPERATION_ID')
    scope(value['scope'])
    for field in ('idempotency_key', 'reservation_id', 'reserved_sid'):
        canonical_uuid(value[field])
    request(value['request'])
    digest(value['request_digest'])
    need(fingerprint(value['request']) == value['request_digest'], 'REQUEST_DIGEST')
    observation(value['observation'])
    need(len({value['id'], value['reservation_id'], value['reserved_sid']}) == 3
         and value['reserved_sid'] != value['observation']['current_sid'], 'RESERVATION_ROLES')
    source, observed = value['request'], value['observation']
    need(all(source[k] == observed[k] for k in
             ('employee_id', 'pool_id', 'source_binding_digest', 'profile_version')),
         'OBSERVATION_BINDING')
    need(source['observation_digest'] == fingerprint(observed), 'OBSERVATION_DIGEST')
    need(wide(value['delta_bytes']) == max(0, memory(source['requested_memory_bytes'])
                                          - memory(observed['current_memory_bytes'])), 'DELTA')
    version(value['version'], True)
    need(value['state'] in STATES, 'STATE')
    phases = {'RESERVED': 1, 'PREPARING': 2, 'PREPARED': 3, 'STARTING': 4,
              'STARTED': 5, 'VERIFYING': 6, 'VERIFY_RECORDED': 7}
    if value['state'] in phases:
        need(value['version'] == phases[value['state']], 'PHASE_VERSION')
        acknowledged = value['state'] in ('PREPARED', 'STARTED', 'VERIFY_RECORDED')
        need((value['last_receipt_digest'] is not None) == acknowledged, 'PHASE_RECEIPT')
        need(value['reason'] is None, 'PHASE_REASON')
    else:
        need(value['version'] >= 2 and value['reason'] is not None, 'RECOVERY_REASON')
    if value['last_receipt_digest'] is not None:
        digest(value['last_receipt_digest'])
    need(value['reason'] is None or (type(value['reason']) is str
         and re.fullmatch('[A-Z][A-Z0-9_]{0,79}', value['reason'])), 'REASON')


def document(value):
    exact(value, ('schema', 'revision', 'operations'))
    need(value['schema'] == SCHEMA, 'SCHEMA')
    version(value['revision'])
    need(type(value['operations']) is dict and len(value['operations']) <= MAX_OPERATIONS,
         'OPERATION_LIMIT')
    seen, reservations, sids, employees, pools = set(), set(), set(), set(), {}
    for key, op in value['operations'].items():
        operation(op, key)
        unique = (fingerprint(op['scope']), op['idempotency_key'])
        need(unique not in seen, 'DUPLICATE_IDEMPOTENCY_KEY')
        need(op['reservation_id'] not in reservations and op['reserved_sid'] not in sids,
             'DUPLICATE_RESERVATION')
        seen.add(unique)
        employee = (op['scope']['company_id'], op['request']['employee_id'])
        need(employee not in employees, 'EMPLOYEE_HAS_RETAINED_CLAIM')
        employees.add(employee)
        reservations.add(op['reservation_id'])
        sids.add(op['reserved_sid'])
        observed = op['observation']
        pool = (observed['pool_revision_digest'], observed['budget_bytes'], observed['committed_bytes'])
        if observed['pool_id'] in pools:
            prior, held = pools[observed['pool_id']]
            need(pool == prior, 'POOL_RECONCILIATION_REQUIRED')
        else:
            held = 0
        held += wide(op['delta_bytes'])
        need(held + wide(observed['committed_bytes']) <= wide(observed['budget_bytes']),
             'CAPACITY_EXHAUSTED')
        pools[observed['pool_id']] = (pool, held)
    need(len(encode(value)) <= MAX_BYTES, 'STORE_BOUND')


def decode(raw):
    need(len(raw) <= MAX_BYTES, 'STORE_BOUND')
    def pairs(items):
        result = {}
        for key, value in items:
            need(key not in result, 'DUPLICATE_KEY')
            result[key] = value
        return result
    def integer(text):
        need(len(text) <= 16 and text.isascii() and text.isdecimal(), 'DOCUMENT_INTEGER')
        result = int(text)
        version(result)
        return result
    def invalid(_):
        raise OperationRefusal('JSON_NUMBER')
    try:
        result = json.loads(raw, object_pairs_hook=pairs, parse_int=integer,
                            parse_float=invalid, parse_constant=invalid)
        document(result)
        return result
    except OperationRefusal:
        raise
    except (ValueError, TypeError, RecursionError, UnicodeError) as error:
        raise OperationRefusal('INVALID_LEDGER') from error


def private_file(fd):
    value = os.fstat(fd)
    need(stat.S_ISREG(value.st_mode) and stat.S_IMODE(value.st_mode) == 0o600
         and value.st_uid == os.geteuid() and value.st_nlink == 1, 'PRIVATE_FILE')
    return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)


def open_directory(path):
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for part in path.parts[1:]:
            other = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                            dir_fd=fd)
            os.close(fd)
            fd = other
        value = os.fstat(fd)
        need(value.st_uid == os.geteuid() and stat.S_IMODE(value.st_mode) == 0o700,
             'PRIVATE_DIRECTORY')
        return fd, (value.st_dev, value.st_ino)
    except BaseException:
        os.close(fd)
        raise


class _Lease:
    __slots__ = ()


class OperationStore:
    """A private journal, not an implementation of the native runtime providers.

    initialize is explicit and only accepts an empty private directory. Missing,
    corrupt or inaccessible journals always refuse; lookup never maps those to
    NOT_FOUND. Every callback must be fixed by trusted service installation.
    """
    def __init__(self, directory, *, scope_guard, capacity_observer=None):
        need(callable(scope_guard), 'MISSING_SCOPE_GUARD')
        need(capacity_observer is None or callable(capacity_observer), 'CAPACITY_OBSERVER')
        self.path = Path(directory)
        need(self.path.is_absolute() and '..' not in self.path.parts, 'STORE_PATH')
        self.fd, self.identity = open_directory(self.path)
        self._scope_guard = scope_guard
        self._capacity_observer = capacity_observer
        self.closed = False
        self._mutex = threading.RLock()
        self._leases = {}

    def close(self):
        with self._mutex:
            if not self.closed:
                self.closed = True
                self._leases.clear()
                os.close(self.fd)

    def _root(self):
        need(not self.closed, 'STORE_CLOSED')
        other, identity = open_directory(self.path)
        try:
            need(identity == self.identity, 'DIRECTORY_REBOUND')
        finally:
            os.close(other)

    def _scope(self, selected):
        scope(selected)
        need(self._scope_guard(copy.deepcopy(selected)) is None, 'SCOPE_GUARD_MUST_RETURN_NONE')

    def _lock_identity(self, fd):
        actual = private_file(fd)
        named = os.stat('operations.lock', dir_fd=self.fd, follow_symlinks=False)
        need((named.st_dev, named.st_ino) == actual[:2], 'LOCK_REBOUND')

    def _read(self):
        fd = os.open('operations.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
                     dir_fd=self.fd)
        try:
            before = private_file(fd)
            raw = bytearray()
            while True:
                part = os.read(fd, min(65536, MAX_BYTES + 1 - len(raw)))
                if not part:
                    break
                raw.extend(part)
                need(len(raw) <= MAX_BYTES, 'STORE_BOUND')
            need(private_file(fd) == before, 'JOURNAL_CHANGED')
            named = os.stat('operations.json', dir_fd=self.fd, follow_symlinks=False)
            need((named.st_dev, named.st_ino) == before[:2], 'JOURNAL_REBOUND')
            return decode(bytes(raw)), before
        finally:
            os.close(fd)

    def _locked(self, selected, fn, initialize=False):
        scope(selected)
        selected = copy.deepcopy(selected)
        with self._mutex:
            lock = None
            context = {'rename_attempted': False, 'expected': None, 'signature': None}
            result, failure = None, None
            try:
                self._root()
                self._scope(selected)
                try:
                    lock = os.open('operations.lock', os.O_RDWR | os.O_CREAT | os.O_EXCL
                                   | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, 0o600,
                                   dir_fd=self.fd)
                    os.fchmod(lock, 0o600)
                except FileExistsError:
                    lock = os.open('operations.lock', os.O_RDWR | os.O_NOFOLLOW
                                   | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=self.fd)
                self._lock_identity(lock)
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                self._root()
                self._lock_identity(lock)
                if initialize:
                    need(set(os.listdir(self.fd)) == {'operations.lock'}, 'NOT_EMPTY_OR_INITIALIZED')
                    current, signature = None, None
                else:
                    current, signature = self._read()
                context.update(expected=current, signature=signature)
                result = fn(current, context, lock)
                self._scope(selected)
                self._root()
                self._lock_identity(lock)
                current, signature = self._read()
                need(current == context['expected'] and signature == context['signature'],
                     'FINAL_JOURNAL_CHANGED')
            except BaseException as error:
                failure = error
            finally:
                if lock is not None:
                    try:
                        os.close(lock)
                    except BaseException as error:
                        if failure is None:
                            failure = error
                        else:
                            failure.add_note('LOCK_CLOSE_FAILED')
            if failure is not None:
                if context['rename_attempted']:
                    self._leases.clear()
                    raise OperationCommitUncertain('COMMIT_OR_RESPONSE_UNCERTAIN_KEEP_ALL_CLAIMS') from failure
                if isinstance(failure, OSError):
                    raise OperationRefusal('LEDGER_UNAVAILABLE') from failure
                raise failure
            return result

    def _commit(self, value, context, lock, selected, fence=None):
        document(value)
        self._scope(selected)
        self._root()
        self._lock_identity(lock)
        if context['expected'] is not None:
            current, signature = self._read()
            need(current == context['expected'] and signature == context['signature'], 'STALE_JOURNAL')
        raw = encode(value)
        name = '.operation-' + secrets.token_hex(16)
        fd, identity, primary = None, None, None
        try:
            fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                         0o600, dir_fd=self.fd)
            os.fchmod(fd, 0o600)
            identity = private_file(fd)[:2]
            offset = 0
            while offset < len(raw):
                count = os.write(fd, raw[offset:])
                need(count > 0, 'SHORT_WRITE')
                offset += count
            os.fsync(fd)
            os.close(fd)
            fd = None
            self._scope(selected)
            self._root()
            self._lock_identity(lock)
            if context['expected'] is not None:
                current, signature = self._read()
                need(current == context['expected'] and signature == context['signature'], 'STALE_JOURNAL')
            if fence is not None:
                fence()
            context['rename_attempted'] = True  # Includes an ACK lost inside rename.
            os.rename(name, 'operations.json', src_dir_fd=self.fd, dst_dir_fd=self.fd)
            os.fsync(self.fd)
            self._root()
            actual, signature = self._read()
            need(actual == value, 'COMMITTED_JOURNAL_CHANGED')
            context.update(expected=value, signature=signature)
            if fence is not None:
                fence()
        except BaseException as error:
            primary = error
        finally:
            try:
                if fd is not None:
                    os.close(fd)
                try:
                    named = os.stat(name, dir_fd=self.fd, follow_symlinks=False)
                except FileNotFoundError:
                    named = None
                if named is not None:
                    need((named.st_dev, named.st_ino) == identity, 'TEMP_REBOUND_KEEP_RAW')
                    os.unlink(name, dir_fd=self.fd)
            except BaseException as error:
                if primary is None:
                    primary = error
                else:
                    primary.add_note('TEMP_CLEANUP_FAILED_RAW_MAY_REMAIN')
        if primary is not None:
            raise primary

    def initialize(self, selected):
        scope(selected)
        selected = copy.deepcopy(selected)
        def create(_, context, lock):
            value = {'schema': SCHEMA, 'revision': 0, 'operations': {}}
            self._commit(value, context, lock, selected)
        return self._locked(selected, create, initialize=True)

    def _view(self, op):
        value = copy.deepcopy(op)
        if op['id'] not in self._leases and op['state'] != 'RECOVERY_REQUIRED':
            value['state'] = 'RECOVERY_REQUIRED'
            value['reason'] = 'ORPHANED_CLAIM_REQUIRES_PROTECTED_RECONCILIATION'
        return {'operation': value, 'verified': False, 'retry_allowed': False,
                'reservation_retained': True}

    def lookup(self, selected, idempotency_key):
        scope(selected)
        selected = copy.deepcopy(selected)
        canonical_uuid(idempotency_key)
        def find(current, _context, _lock):
            for op in current['operations'].values():
                if op['scope'] == selected and op['idempotency_key'] == idempotency_key:
                    return self._view(op)
            return None  # Only an intact, authorized ledger can say absent.
        return self._locked(selected, find)

    def _observe(self, selected, proposed):
        need(self._capacity_observer is not None, 'MISSING_CAPACITY_OBSERVER')
        value = self._capacity_observer(copy.deepcopy(selected), proposed['pool_id'], proposed['employee_id'])
        observation(value)
        value = copy.deepcopy(value)
        need(fingerprint(value) == proposed['observation_digest'], 'STALE_CAPACITY_SNAPSHOT')
        need(all(value[k] == proposed[k] for k in
                 ('employee_id', 'pool_id', 'source_binding_digest', 'profile_version')),
             'OBSERVATION_BINDING')
        return value

    def claim(self, selected, idempotency_key, proposed):
        scope(selected)
        canonical_uuid(idempotency_key)
        request(proposed)
        selected, proposed = copy.deepcopy(selected), copy.deepcopy(proposed)
        def create(current, context, lock):
            for op in current['operations'].values():
                if op['scope'] == selected and op['idempotency_key'] == idempotency_key:
                    need(op['request'] == proposed, 'IDEMPOTENCY_CONFLICT')
                    return self._view(op), None  # No replayed effect handle.
            need(len(current['operations']) < MAX_OPERATIONS, 'OPERATION_LIMIT')
            need(not any(op['scope']['company_id'] == selected['company_id']
                         and op['request']['employee_id'] == proposed['employee_id']
                         for op in current['operations'].values()), 'EMPLOYEE_HAS_RETAINED_CLAIM')
            observed = self._observe(selected, proposed)
            opid = str(uuid.uuid4())
            op = {'id': opid, 'scope': selected, 'idempotency_key': idempotency_key,
                  'request': proposed, 'request_digest': fingerprint(proposed),
                  'reservation_id': str(uuid.uuid4()), 'reserved_sid': str(uuid.uuid4()),
                  'observation': observed,
                  'delta_bytes': str(max(0, memory(proposed['requested_memory_bytes'])
                                        - memory(observed['current_memory_bytes']))),
                  'version': 1, 'state': 'RESERVED', 'last_receipt_digest': None, 'reason': None}
            value = copy.deepcopy(current)
            value['revision'] += 1
            value['operations'][opid] = op
            self._commit(value, context, lock, selected,
                         lambda: need(self._observe(selected, proposed) == observed, 'CAPACITY_CHANGED'))
            self._leases[opid] = _Lease()
            return self._view(op), self._leases[opid]
        return self._locked(selected, create)

    def _change(self, selected, handle, expected_version, change):
        scope(selected)
        selected = copy.deepcopy(selected)
        version(expected_version, True)
        def update(current, context, lock):
            matches = [key for key, lease in self._leases.items() if lease is handle]
            need(len(matches) == 1, 'MISSING_ACTIVE_CLAIM')
            key = matches[0]
            old = current['operations'].get(key)
            need(old is not None and old['scope'] == selected, 'CLAIM_SCOPE')
            need(old['version'] == expected_version, 'STALE_OPERATION_VERSION')
            op = copy.deepcopy(old)
            change(op)
            op['version'] += 1
            value = copy.deepcopy(current)
            value['revision'] += 1
            value['operations'][key] = op
            self._commit(value, context, lock, selected)
            return self._view(op)
        return self._locked(selected, update)

    def begin_effect(self, selected, handle, effect, *, expected_version):
        need(type(effect) is str and effect in EFFECTS, 'EFFECT')
        def start(op):
            before, pending, _ = EFFECTS[effect]
            need(op['state'] == before, 'EFFECT_ALREADY_ATTEMPTED_OR_OUT_OF_ORDER')
            op.update(state=pending, last_receipt_digest=None, reason=None)
        return self._change(selected, handle, expected_version, start)

    def record_ack(self, selected, handle, effect, receipt_digest, *, expected_version):
        need(type(effect) is str and effect in EFFECTS, 'EFFECT')
        digest(receipt_digest)
        def acknowledge(op):
            _, pending, after = EFFECTS[effect]
            need(op['state'] == pending, 'UNEXPECTED_ACK')
            op.update(state=after, last_receipt_digest=receipt_digest, reason=None)
        # An ACK hash is a reference, not native verification or capacity credit.
        return self._change(selected, handle, expected_version, acknowledge)

    def mark_uncertain(self, selected, handle, *, expected_version, reason):
        need(type(reason) is str and re.fullmatch('[A-Z][A-Z0-9_]{0,79}', reason), 'REASON')
        def uncertain(op):
            op.update(state='RECOVERY_REQUIRED', reason=reason)
        with self._mutex:
            keys = [key for key, lease in self._leases.items() if lease is handle]
            try:
                return self._change(selected, handle, expected_version, uncertain)
            finally:
                for key in keys:
                    self._leases.pop(key, None)
