"""Durable owner-approved host action state machine.

This module is transport independent. Authentication, host target resolution and
fixed operation handlers are injected by the office/host adapters. It exposes no
shell, executable path, environment, credential or general engine operation.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import stat
import re
import sqlite3
import time
import uuid
from collections.abc import Callable
from contextlib import contextmanager
from dataclasses import dataclass

SESSION = re.compile(r'^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$')
ACTIONS = frozenset({'stop-laptop', 'verify-runtime-pool', 'apply-runtime-pool'})


@dataclass(frozen=True)
class Principal:
    """Created by authenticated server adapters, never deserialized from a request."""
    subject: str
    owner: bool = False

    def __post_init__(self):
        if (type(self.owner) is not bool or not isinstance(self.subject,str) or
            not re.fullmatch(r'[A-Za-z0-9:_@.-]{1,128}',self.subject)):
            raise ValueError('Invalid authenticated principal')


def validate_operation(operation):
    if not isinstance(operation, dict) or not isinstance(operation.get('action'),str) or operation['action'] not in ACTIONS:
        raise ValueError('Unsupported host action')
    fields = {'action', 'sessionId'} if operation['action'] == 'stop-laptop' else {'action'}
    if set(operation) != fields:
        raise ValueError('Unexpected host action fields')
    if 'sessionId' in fields and (not isinstance(operation['sessionId'], str) or not SESSION.fullmatch(operation['sessionId'])):
        raise ValueError('Invalid session identifier')
    return dict(operation)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)


class ApprovalExpired(ValueError):
    pass


@dataclass
class ExecutionPermit:
    """Internal host deadline, carried through every blocking preflight.

    Fixed handlers call begin immediately before an effect. Nested helpers must
    carry the same deadline and check it at their own effect boundary as well.
    """
    deadline: float
    clock: Callable
    started: bool = False

    def check(self):
        if self.clock() >= self.deadline:
            raise ApprovalExpired('Host action approval expired')

    def begin(self):
        self.check()
        self.started = True


class ActionQueue:
    """Single host-owned database; adapters keep it outside all shared mounts.

    resolve returns a bounded, nonsecret, JSON host-generated target snapshot
    (container ID, policy digest or managed-unit digest). execute dispatches only
    fixed reviewed handlers. Neither callback accepts arbitrary command strings.
    All calls must use independently authenticated principals.
    """
    def __init__(self, database, resolve: Callable, execute: Callable, clock=time.time):
        path = Path(database).absolute()
        parent = path.parent.lstat()
        if (not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.getuid() or
            parent.st_mode & 0o077 or path.parent.resolve() != path.parent):
            raise ValueError('Host action directory must be private and owned')
        try:
            fd = os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        except FileExistsError:
            info=path.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
                raise ValueError('Host action database must be private and owned')
        else:
            os.close(fd)
        self.database = str(path)
        self.resolve = resolve
        self.execute = execute
        self.clock = clock
        with self.connect() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS actions (
                    id TEXT PRIMARY KEY, requester TEXT NOT NULL,
                    payload TEXT NOT NULL, preview TEXT NOT NULL,
                    digest TEXT NOT NULL, expires REAL NOT NULL,
                    state TEXT NOT NULL, approver TEXT, result TEXT
                );
                CREATE TABLE IF NOT EXISTS audit (
                    sequence INTEGER PRIMARY KEY, action_id TEXT NOT NULL,
                    at REAL NOT NULL, actor TEXT NOT NULL, event TEXT NOT NULL
                );
            ''')

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.database, timeout=5, isolation_level='IMMEDIATE')
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def event(self, db, action_id, actor, event):
        db.execute('INSERT INTO audit(action_id,at,actor,event) VALUES(?,?,?,?)',
                   (action_id, self.clock(), actor, event))

    def request(self, principal, operation):
        if not principal.subject:
            raise PermissionError('Authenticated requester required')
        operation = validate_operation(operation)
        # Snapshot originates at the host; request JSON cannot supply target IDs,
        # policy limits, unit contents, file paths, arguments or approval fields.
        preview = canonical(self.resolve(operation))
        if len(preview.encode()) > 4096:
            raise ValueError('Host preview exceeds limit')
        payload = canonical(operation)
        digest = hashlib.sha256((payload + '\n' + preview).encode()).hexdigest()
        identity = str(uuid.uuid4())
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            count = db.execute("SELECT count(*) FROM actions WHERE requester=? AND state='pending' AND expires>?",
                               (principal.subject,self.clock())).fetchone()[0]
            if count >= 16:
                raise ValueError('Pending host action limit reached')
            db.execute('INSERT INTO actions VALUES(?,?,?,?,?,?,?,NULL,NULL)',
                       (identity,principal.subject,payload,preview,digest,self.clock()+300,'pending'))
            self.event(db,identity,principal.subject,'requested')
        return self.get(principal,identity)

    def get(self, principal, identity):
        with self.connect() as db:
            row = db.execute('SELECT * FROM actions WHERE id=?',(identity,)).fetchone()
        if row is None or (not principal.owner and row['requester'] != principal.subject):
            raise PermissionError('Host action unavailable')
        return dict(row)

    def decide(self, principal, identity, digest, approve):
        if not principal.owner:
            raise PermissionError('Owner approval required')
        if type(approve) is not bool:
            raise ValueError('Explicit approval decision required')
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT * FROM actions WHERE id=?',(identity,)).fetchone()
            if row is None or row['state'] != 'pending' or row['digest'] != digest:
                raise ValueError('Host action changed or already decided')
            if row['expires'] <= self.clock():
                raise ValueError('Host action expired')
            state = 'approved' if approve else 'denied'
            db.execute('UPDATE actions SET state=?,approver=? WHERE id=?',(state,principal.subject,identity))
            self.event(db,identity,principal.subject,state)
        return self.get(principal,identity)

    def run(self, identity):
        # Host service only: the public office API must not expose run().
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT * FROM actions WHERE id=?',(identity,)).fetchone()
            if row is None or row['state'] != 'approved' or row['expires'] <= self.clock():
                raise ValueError('No current owner approval')
            db.execute("UPDATE actions SET state='executing' WHERE id=?",(identity,))
            self.event(db,identity,'host-service','executing')
        # Durable claim precedes any side effect. No blind retry after a crash.
        permit = ExecutionPermit(row['expires'], self.clock)
        try:
            operation = validate_operation(json.loads(row['payload']))
            if canonical(self.resolve(operation)) != row['preview']:
                raise ValueError('Approved host target changed')
            permit.check()
        except ApprovalExpired:
            self.finish(identity,'failed','approval-expired-before-effect')
            return 'failed'
        except Exception:
            self.finish(identity,'failed','target-preflight-failed')
            return 'failed'
        try:
            # Do not store exceptions, raw subprocess output or secrets in receipts.
            self.execute(operation,json.loads(row['preview']),permit)
        except ApprovalExpired:
            state = 'unconfirmed' if permit.started else 'failed'
            self.finish(identity,state,'execution-needs-verification' if permit.started else 'approval-expired-before-effect')
            return state
        except Exception:
            # A timeout/connection error may follow an actual successful side effect.
            self.finish(identity,'unconfirmed','execution-needs-verification')
            return 'unconfirmed'
        self.finish(identity,'succeeded','handler-verified-success')
        return 'succeeded'

    def finish(self, identity, state, result):
        with self.connect() as db:
            db.execute('UPDATE actions SET state=?,result=? WHERE id=? AND state=\'executing\'',(state,result,identity))
            self.event(db,identity,'host-service',state)

    def recover(self):
        """Call once at exclusive service startup, never concurrently with run()."""
        with self.connect() as db:
            rows = db.execute("SELECT id FROM actions WHERE state='executing'").fetchall()
            for row in rows:
                db.execute("UPDATE actions SET state='unconfirmed',result='host-interrupted' WHERE id=?",(row['id'],))
                self.event(db,row['id'],'host-service','unconfirmed')
        return len(rows)
