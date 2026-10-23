"""Office-to-host authenticated envelope for the fixed action queue.

This is not a laptop credential protocol. Both keys stay outside laptop/shared
mounts. Only the office's verified owner route receives the approval signer.
Socket peer checks, key loading, HTTP routes and service packaging are separate.
"""
import hashlib
import hmac
import json
import re
import sqlite3
import time

from .host_actions import Principal, canonical

MAX_BODY = 16 * 1024
HEX64 = re.compile(r'^[0-9a-f]{64}$')
UUID = re.compile(r'^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$')


class OfficeEnvelope:
    """Two fixed keys separate request/read from verified owner decisions.

    Nonces are durable. Authenticate and consume a nonce before dispatching any
    queue operation. No public method can execute an action without the host's
    private worker claiming the stored approval.
    """
    def __init__(self, queue, request_key, owner_key, clock=time.time):
        if (not isinstance(request_key,bytes) or not isinstance(owner_key,bytes) or
            len(request_key)<32 or len(owner_key)<32 or hmac.compare_digest(request_key,owner_key)):
            raise ValueError('Distinct private transport keys required')
        self.queue=queue
        self.keys={'request':request_key,'owner':owner_key}
        self.clock=clock
        with queue.connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS rpc_nonces (nonce TEXT PRIMARY KEY, expires REAL NOT NULL)')

    def dispatch(self, body, key_id, signature):
        if (not isinstance(body,bytes) or len(body)>MAX_BODY or not isinstance(key_id,str) or key_id not in self.keys or
            not isinstance(signature,str) or not HEX64.fullmatch(signature)):
            raise PermissionError('Invalid office envelope')
        expected=hmac.new(self.keys[key_id],body,hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected,signature):
            raise PermissionError('Invalid office signature')
        envelope=json.loads(body)
        if not isinstance(envelope,dict) or set(envelope)!={'version','issuedAt','nonce','method','subject','params'} or type(envelope['version']) is not int or envelope['version']!=1:
            raise ValueError('Invalid office envelope shape')
        # Reject duplicate-key/noncanonical representations instead of allowing
        # different layers to interpret a signed object differently.
        if canonical(envelope).encode()!=body:
            raise ValueError('Noncanonical office envelope')
        if type(envelope['issuedAt']) is not int or abs(envelope['issuedAt']-self.clock())>30:
            raise PermissionError('Expired office envelope')
        if not isinstance(envelope['nonce'],str) or not UUID.fullmatch(envelope['nonce']):
            raise ValueError('Invalid office nonce')
        method=envelope['method']
        if method not in ('request','get','decide','list') or (method=='decide' and key_id!='owner'):
            raise PermissionError('Office operation is not granted')
        principal=Principal(envelope['subject'],owner=key_id=='owner')
        params=envelope['params']
        expected_fields={'operation'} if method=='request' else {'id'} if method=='get' else set() if method=='list' else {'id','digest','approve'}
        if not isinstance(params,dict) or set(params)!=expected_fields:
            raise ValueError('Invalid office parameters')
        if method in ('get','decide') and (not isinstance(params['id'],str) or not UUID.fullmatch(params['id'])):
            raise ValueError('Invalid host action identity')
        if method=='decide' and (not isinstance(params['digest'],str) or not HEX64.fullmatch(params['digest']) or type(params['approve']) is not bool):
            raise ValueError('Invalid owner decision')
        with self.queue.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            db.execute('DELETE FROM rpc_nonces WHERE expires<?',(self.clock(),))
            try:
                db.execute('INSERT INTO rpc_nonces VALUES(?,?)',(envelope['nonce'],self.clock()+61))
            except sqlite3.IntegrityError:
                raise PermissionError('Office envelope already used') from None
        if method=='request':
            return self.queue.request(principal,params['operation'])
        if method=='list':
            return self.queue.list(principal)
        if method=='get':
            return self.queue.get(principal,params['id'])
        return self.queue.decide(principal,params['id'],params['digest'],params['approve'])
