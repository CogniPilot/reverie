"""Purpose-separated Goal request proofs. No configuration, key or state readers.

Only the host composition may supply a signer and a current binding callback to
OfficeAPI. Defaults are unavailable. This authenticates a request, not a Goal
permission, private custody, or authority to wake a laptop.
"""
import base64
import hashlib
import hmac
import json
import re
import secrets
import time

HEADER = 'X-Reverie-Goal-Assertion'
MAX_BODY = 64 * 1024
MAX_LIFETIME_MS = 10_000
_ID = re.compile(r'[A-Za-z0-9_.:-]{1,64}\Z', re.ASCII)
_SESSION = re.compile(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\Z', re.ASCII)
_NONCE = re.compile(r'[0-9a-f]{32}\Z', re.ASCII)
# Canonical r3 Goal/grant/proof/metadata IDs; issuer/epoch retain _ID's 64 bound.
_GOAL_ID = r'[A-Za-z0-9_.:-]{1,100}'
_ROUTES = {
    'GET': re.compile(rf'/api/(?:goals(?:/{_GOAL_ID})?|goal-metadata/{_GOAL_ID}(?:\?grantId={_GOAL_ID})?)\Z', re.ASCII),
    'POST': re.compile(rf'/api/(?:goals(?:/{_GOAL_ID}/(?:transitions|adopt|unblock-proofs))?|goal-grants(?:/{_GOAL_ID}/revoke)?|goal-unblock-proofs/{_GOAL_ID}/revoke)\Z', re.ASCII),
}


def is_goal_request(method, target):
    return isinstance(target, str) and method in _ROUTES and bool(_ROUTES[method].fullmatch(target))


def is_goal_path(target):
    """Also fence malformed/unsupported requests in the reserved namespace."""
    path = target.split('?', 1)[0]
    return any(path == '/api/'+name or path.startswith('/api/'+name+'/')
               for name in ('goals', 'goal-grants', 'goal-unblock-proofs', 'goal-metadata'))


class GoalRequestSigner:
    """An injected host-only signer; binding(session) must fail on stale/migrating sessions."""
    def __init__(self, *, key, issuer, epoch, binding, now=None, nonce=None):
        if not isinstance(key, bytes) or len(key) < 32 or not _ID.fullmatch(issuer) or not _ID.fullmatch(epoch):
            raise ValueError('Invalid Goal issuer configuration')
        self._key, self._issuer, self._epoch, self._binding = bytes(key), issuer, epoch, binding
        self._now = now or (lambda: int(time.time()*1000))
        self._nonce = nonce or (lambda: secrets.token_hex(16))

    def bind(self, session_id):
        """Pin this office's generation once; a current binding cannot silently adopt it."""
        if not _SESSION.fullmatch(session_id):
            raise ValueError('Goal office binding refused')
        generation = self._binding(session_id)
        if type(generation) is not int or not 1 <= generation <= 2**53-1:
            raise ValueError('Current Goal binding unavailable')
        return _BoundGoalSigner(self, session_id, generation)

    def _sign(self, session_id, generation, method, target, body):
        if not _SESSION.fullmatch(session_id) or not is_goal_request(method, target):
            raise ValueError('Goal request refused')
        if not isinstance(body, bytes) or len(body) > MAX_BODY or (method == 'GET' and body):
            raise ValueError('Goal body refused')
        current = self._binding(session_id)
        if type(current) is not int or current != generation:
            raise ValueError('Current Goal binding unavailable')
        now, nonce = self._now(), self._nonce()
        if type(now) is not int or not 0 <= now <= 2**53-1-MAX_LIFETIME_MS or not _NONCE.fullmatch(nonce):
            raise ValueError('Goal clock or nonce unavailable')
        fields = [1, 'goal-request', self._issuer, self._epoch, session_id, generation,
                  method, target, hashlib.sha256(body).hexdigest(), now, now+MAX_LIFETIME_MS, nonce]
        encoded = base64.urlsafe_b64encode(json.dumps(fields, separators=(',', ':'), ensure_ascii=True).encode()).rstrip(b'=')
        signature = hmac.new(self._key, b'reverie-goal-request-v1\n'+encoded, hashlib.sha256).hexdigest()
        return encoded.decode()+'.'+signature


class _BoundGoalSigner:
    def __init__(self, signer, session_id, generation):
        self._signer, self._session_id, self._generation = signer, session_id, generation

    def sign(self, session_id, method, target, body):
        if session_id != self._session_id:
            raise ValueError('Goal office binding refused')
        return self._signer._sign(session_id, self._generation, method, target, body)


def goal_forward_headers(session_id, method, target, body, headers, signer=None):
    """Always strip worker assertions; reserved Goal paths require explicit host trust."""
    clean = {key: value for key, value in headers.items() if not key.lower().startswith('x-reverie-goal-')}
    if is_goal_path(target):
        if signer is None:
            raise ValueError('Goal authentication adapter unavailable')
        clean[HEADER] = signer.sign(session_id, method, target, body)
    return clean
