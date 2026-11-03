"""Host-issued, purpose-bound office recovery requests; never a grant or owner login.

The owner explicitly provisions a private key/nonce namespace. OfficeAPI pins its
own canonical session generation; caller-supplied assertions are always stripped.
Missing, changed or exposed provisioning fails closed, without creating trust at
runtime. No Goal signer, provider start, delivery acknowledgement or restart here.
"""
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import time
import uuid

from .goal_private import private_entry, private_json, assert_unexposed
from .worker_storage import company_records

HEADER = 'X-Reverie-Recovery-Assertion'
PREFIX = 'x-reverie-recovery-'
MAX_BODY = 64 * 1024
MAX_LIFETIME_MS = 10_000
DOMAIN = b'reverie-worker-recovery-request-v1\n'
UUID = r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}'
SESSION = re.compile(UUID + r'\Z', re.ASCII)
ID = re.compile(r'[A-Za-z0-9_.:-]{1,64}\Z', re.ASCII)
ROUTE = re.compile(rf'(?:/api/company/employees/{UUID}/reconnect(?:/status)?|/api/plans/moves/(?:force|[A-Za-z0-9_-]{{1,100}}/status))\Z', re.ASCII)


def is_recovery_request(method, target):
    return method == 'POST' and isinstance(target, str) and bool(ROUTE.fullmatch(target))


def paths(config):
    root = Path(config['companyRoot']) / 'console'
    return root, root / 'worker-recovery-auth.json', root / 'recovery-nonces.json'


def document(path):
    value, digest, identity = private_json(str(path))
    if (set(value) != {'version', 'issuer', 'epoch', 'key', 'storeId'} or
            type(value['version']) is not int or value['version'] != 1 or
            any(not isinstance(value[k], str) or not ID.fullmatch(value[k]) for k in ('issuer', 'epoch')) or
            not isinstance(value['key'], str) or not re.fullmatch('[0-9a-f]{64}', value['key']) or
            not isinstance(value['storeId'], str) or not SESSION.fullmatch(value['storeId'])):
        raise ValueError('Private recovery authentication unavailable')
    return value, digest, identity


def unexposed(config, run_engine):
    """Reject configured and actual worker aliases before accessing key bytes."""
    _, auth, nonce = paths(config)
    protected = [str(auth), str(nonce), str(nonce) + '.lock', str(nonce) + '.pending']
    sources = [m['source'] for m in config['mounts']]
    sources += [config['scratchRoot'], config['apiSocketRoot'], Path(config['stateRoot']) / 'employees']
    assert_unexposed(protected, [str(p) for p in sources])
    listing = run_engine(['ps', '--all', '--no-trunc', '--filter', 'label=reverie.worker', '--format', '{{.ID}}'])
    ids = listing.stdout.splitlines()
    if len(ids) > 64 or len(ids) != len(set(ids)) or any(not re.fullmatch('[a-f0-9]{64}', item) for item in ids):
        raise ValueError('Recovery custody inventory unavailable')
    rows = json.loads(run_engine(['inspect', *ids]).stdout) if ids else []
    if (not isinstance(rows, list) or len(rows) != len(ids) or
            any(not isinstance(row, dict) or not isinstance(row.get('Mounts'), list) for row in rows)):
        raise ValueError('Recovery custody inventory unavailable')
    if ids and ({row.get('Id') for row in rows} != set(ids)):
        # The listing uses full immutable IDs; aliases cannot satisfy custody.
        raise ValueError('Recovery custody inventory changed')
    for row in rows:
        if not isinstance(row.get('Mounts'), list):
            raise ValueError('Recovery custody inventory unavailable')
        actual = []
        for mount in row['Mounts']:
            if not isinstance(mount, dict):
                raise ValueError('Recovery custody inventory unavailable')
            if mount.get('Type') == 'tmpfs':
                continue
            if mount.get('Type') not in ('bind', 'volume') or not isinstance(mount.get('Source'), str) or not mount['Source']:
                raise ValueError('Recovery custody inventory unavailable')
            actual.append(mount['Source'])
        if actual:
            assert_unexposed(protected, actual)


def provision(config, run_engine):
    """Explicit owner-host preparation only. Never rotate/reset partial state."""
    if config['uid'] != os.getuid() or os.geteuid() == 0:
        raise ValueError('Recovery authentication requires the ordinary owner')
    root, auth, nonce = paths(config)
    private_entry(str(root), directory=True)
    unexposed(config, run_engine)
    lock = Path(str(nonce) + '.lock')
    if os.path.lexists(str(nonce) + '.pending'):
        raise ValueError('Pending recovery nonce update requires owner review')
    selected = [os.path.lexists(p) for p in (auth, nonce, lock)]
    if any(selected):
        if not all(selected):
            raise ValueError('Partial recovery provisioning requires owner review')
        value, _, _ = document(auth)
        ledger, _, _ = private_json(str(nonce), limit=1024 * 1024)
        private_entry(str(lock), limit=0)
        integer = lambda v: type(v) is int and 0 <= v <= 2**53 - 1
        if (set(ledger) != {'version', 'storeId', 'capacity', 'revision', 'clockFloor', 'entries'} or
                type(ledger['version']) is not int or ledger['version'] != 1 or ledger['storeId'] != value['storeId'] or
                type(ledger['capacity']) is not int or ledger['capacity'] != 4096 or
                not integer(ledger['revision']) or not integer(ledger['clockFloor']) or
                type(ledger['entries']) is not list or len(ledger['entries']) > 4096):
            raise ValueError('Recovery nonce namespace differs')
        keys = set()
        for entry in ledger['entries']:
            if (type(entry) is not dict or set(entry) != {'key', 'claimId', 'expiresAt'} or
                    not isinstance(entry['key'], str) or not re.fullmatch('[0-9a-f]{64}', entry['key']) or
                    not isinstance(entry['claimId'], str) or not SESSION.fullmatch(entry['claimId']) or
                    not integer(entry['expiresAt']) or entry['key'] in keys):
                raise ValueError('Recovery nonce namespace differs')
            keys.add(entry['key'])
        return {'prepared': True, 'created': False}
    for p in (auth, nonce, lock, Path(str(nonce) + '.pending')):
        private_entry(str(p), absent=True)
        if os.path.lexists(p):
            raise ValueError('Recovery namespace already exists')
    value = {'version': 1, 'issuer': str(uuid.uuid4()), 'epoch': str(uuid.uuid4()),
             'key': secrets.token_hex(32), 'storeId': str(uuid.uuid4())}
    ledger = {'version': 1, 'storeId': value['storeId'], 'capacity': 4096,
              'revision': 0, 'clockFloor': 0, 'entries': []}
    # Publish the key last. Any interrupted partial preparation remains refused.
    for p, data in ((lock, b''), (nonce, json.dumps(ledger).encode()), (auth, json.dumps(value).encode())):
        fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        with os.fdopen(fd, 'wb') as output:
            output.write(data); output.flush(); os.fsync(output.fileno())
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    return {'prepared': True, 'created': True}


class RecoveryRequestSigner:
    def __init__(self, config, run_engine, *, now=None, nonce=None):
        self.config, self.run_engine = config, run_engine
        self.now = now or (lambda: int(time.time() * 1000))
        self.nonce = nonce or (lambda: secrets.token_hex(16))
        self.identity = None

    def _value(self):
        unexposed(self.config, self.run_engine)
        value, digest, identity = document(paths(self.config)[1])
        pin = (digest, identity)
        if self.identity is None:
            self.identity = pin
        elif self.identity != pin:
            raise ValueError('Recovery authentication changed; restart required')
        return value

    def _binding(self, sid):
        if not isinstance(sid, str) or not SESSION.fullmatch(sid):
            raise ValueError('Recovery office binding refused')
        rows = [r for r in company_records(self.config) if r.get('sessionId') == sid]
        if len(rows) != 1:
            raise ValueError('Recovery office binding unavailable')
        row = rows[0]
        generation = row.get('sessionGeneration')
        if (type(generation) is not int or not 1 <= generation <= 2**53 - 1 or
                row.get('desiredRunning') is not True or row.get('onVacation') or row.get('bindingMigration')):
            raise ValueError('Recovery office binding unavailable')
        return (row['id'], row.get('owner'), sid, generation)

    def bind(self, sid):
        self._value()
        return BoundRecoverySigner(self, self._binding(sid))


class BoundRecoverySigner:
    def __init__(self, signer, binding):
        self.signer, self.binding = signer, binding

    def sign(self, sid, method, target, body):
        if (not is_recovery_request(method, target) or sid != self.binding[2] or
                not isinstance(body, bytes) or len(body) > MAX_BODY or self.signer._binding(sid) != self.binding):
            raise ValueError('Recovery request refused')
        value = self.signer._value()
        now, nonce = self.signer.now(), self.signer.nonce()
        if (type(now) is not int or not 0 <= now <= 2**53 - 1 - MAX_LIFETIME_MS or
                not isinstance(nonce, str) or not re.fullmatch('[0-9a-f]{32}', nonce)):
            raise ValueError('Recovery clock or nonce unavailable')
        fields = [1, 'worker-recovery-request', value['issuer'], value['epoch'], sid, self.binding[3],
                  method, target, hashlib.sha256(body).hexdigest(), now, now + MAX_LIFETIME_MS, nonce]
        encoded = base64.urlsafe_b64encode(json.dumps(fields, separators=(',', ':')).encode()).rstrip(b'=')
        signature = hmac.new(bytes.fromhex(value['key']), DOMAIN + encoded, hashlib.sha256).hexdigest()
        if self.signer._binding(sid) != self.binding:
            raise ValueError('Recovery office binding changed')
        return encoded.decode() + '.' + signature


def recovery_forward_headers(sid, method, target, body, headers, signer=None):
    clean = {k: v for k, v in headers.items() if not k.lower().startswith(PREFIX)}
    if is_recovery_request(method, target):
        if signer is None:
            raise ValueError('Scoped recovery authentication unavailable')
        clean[HEADER] = signer.sign(sid, method, target, body)
    return clean
