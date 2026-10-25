"""Internal resume-attempt persistence. No authentication or effect adapter.

Call only after trusted target binding and authorization. A stored receipt is
evidence, never permission to send. No daemon/CLI/runtime imports this module.
"""
from contextlib import contextmanager
from dataclasses import asdict, dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import uuid
from urllib.parse import quote

_MAX_ATTEMPTS = 3
_WINDOW_MS = 30 * 60 * 1000
_MAX_ROWS = 4096
_MAX_EVENTS = 16384
_MAX_ACTIVE = 128
_CANONICAL_ID = re.compile(r"[A-Za-z0-9_.:-]{1,100}\Z")
_OPERATION_KEY = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,95}\Z")
_HEX32 = re.compile(r"[0-9a-f]{32}\Z")
_HEX64 = re.compile(r"[0-9a-f]{64}\Z")
_SEMANTIC_REFUSALS = frozenset({
    "IDEMPOTENCY_CONFLICT", "UNRESOLVED_ATTEMPT", "QUEUE_FULL", "STORE_FULL",
    "BINDING_CHANGED", "CAS_STALE", "ATTEMPT_UNKNOWN",
})
_OPEN = ("QUEUED", "SUBMITTED", "TURN_STARTED", "UNCERTAIN")
_NEXT = {
    "QUEUED": {"SUBMITTED", "REFUSED", "FAILED", "UNCERTAIN"},
    "SUBMITTED": {"TURN_STARTED", "REFUSED", "FAILED", "UNCERTAIN"},
    "TURN_STARTED": {"PROGRESS_OBSERVED", "FAILED", "UNCERTAIN"},
}
_REASONS = {
    "QUEUED": {"QUEUED"},
    "SUBMITTED": {"SUBMISSION_CONFIRMED"},
    "TURN_STARTED": {"TURN_CONFIRMED"},
    "PROGRESS_OBSERVED": {"PROGRESS_CONFIRMED"},
    "REFUSED": {"POLICY_REFUSED"},
    "FAILED": {"SUBMISSION_FAILED", "TURN_FAILED"},
    "UNCERTAIN": {"SEND_UNCERTAIN", "PROCESS_RESTART"},
}


class LedgerError(ValueError):
    """Only fixed codes; never include file, SQLite, or rejected-input text."""
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def _id(value, pattern=_CANONICAL_ID):
    if type(value) is not str or not pattern.fullmatch(value):
        raise LedgerError("INPUT_INVALID")


def _integer(value, minimum=0):
    if type(value) is not int or not minimum <= value <= 2**53 - 1:
        raise LedgerError("INPUT_INVALID")


def _json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _digest(value):
    return hashlib.sha256(_json(value).encode("ascii")).hexdigest()


@dataclass(frozen=True)
class Binding:
    employee_id: str
    goal_id: str
    goal_generation: int
    session_id: str
    session_generation: int
    transition_sequence: int

    def validate(self):
        for value in (self.employee_id, self.goal_id, self.session_id):
            _id(value)
        for value in (self.goal_generation, self.session_generation):
            _integer(value, 1)
        _integer(self.transition_sequence)


class ResumeLedger:
    """One private SQLite ledger in a trusted, existing service directory.

    The caller supplies the server clock, never a request timestamp. Custody of
    the directory and ancestors is a deployment prerequisite. There is no
    backup adoption, compaction, automatic repair, or reconciliation override.
    """
    def __init__(self, file):
        self._db = None
        try:
            self._file = Path(file)
            parent = self._file.parent
            if not self._file.is_absolute() or self._file != self._file.resolve():
                raise LedgerError("CUSTODY_INVALID")
            info = parent.stat()
            if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
                    or stat.S_IMODE(info.st_mode) != 0o700):
                raise LedgerError("CUSTODY_INVALID")
            try:
                fd = os.open(self._file, os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_WRONLY, 0o600)
            except FileExistsError:
                fresh = False
            else:
                fresh = True
                os.close(fd)
            info = self._file.lstat()
            if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                    or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600):
                raise LedgerError("CUSTODY_INVALID")
            self._identity = (info.st_dev, info.st_ino)
            uri = "file:" + quote(str(self._file), safe="/") + "?mode=rw"
            self._db = sqlite3.connect(uri, uri=True, timeout=0.25, isolation_level=None)
            self._db.execute("PRAGMA journal_mode=DELETE")
            self._db.execute("PRAGMA synchronous=FULL")
            self._db.execute("PRAGMA max_page_count=4096")
            self._db.execute("PRAGMA trusted_schema=OFF")
            if fresh:
                self._create()
                # SQLite's first commit syncs the file; creation also needs the directory entry.
                fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(fd)
                finally:
                    os.close(fd)
            if self._db.execute("PRAGMA user_version").fetchone()[0] != 1:
                raise LedgerError("STORE_UNAVAILABLE")
            if self._db.execute("SELECT version FROM ledger_meta").fetchall() != [(1,)]:
                raise LedgerError("STORE_UNAVAILABLE")
            self._check_custody()
        except LedgerError:
            self.close()
            raise
        except (OSError, sqlite3.Error, ValueError, TypeError):
            self.close()
            raise LedgerError("STORE_UNAVAILABLE") from None

    def _create(self):
        self._db.executescript("""
          BEGIN IMMEDIATE;
          CREATE TABLE ledger_meta(version INTEGER NOT NULL, clock_floor INTEGER NOT NULL);
          INSERT INTO ledger_meta VALUES(1,0);
          CREATE TABLE attempts(
            id TEXT PRIMARY KEY, employee TEXT NOT NULL, goal TEXT NOT NULL,
            session TEXT NOT NULL, issued INTEGER NOT NULL, binding TEXT NOT NULL,
            key TEXT NOT NULL, fingerprint TEXT NOT NULL, UNIQUE(employee,key));
          CREATE INDEX employee_budget ON attempts(employee,issued);
          CREATE INDEX goal_budget ON attempts(goal,issued);
          CREATE INDEX session_budget ON attempts(session,issued);
          CREATE TABLE events(
            id TEXT PRIMARY KEY, attempt TEXT NOT NULL, sequence INTEGER NOT NULL,
            state TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL,
            body TEXT NOT NULL CHECK(length(body)<=2048),
            UNIQUE(attempt,sequence), UNIQUE(attempt,key));
          CREATE TABLE alerts(
            id TEXT PRIMARY KEY, dimension TEXT NOT NULL, subject TEXT NOT NULL,
            blocked_until INTEGER NOT NULL, body TEXT NOT NULL CHECK(length(body)<=2048),
            UNIQUE(dimension,subject,blocked_until));
          CREATE TRIGGER attempts_no_update BEFORE UPDATE ON attempts
            BEGIN SELECT RAISE(ABORT,'immutable'); END;
          CREATE TRIGGER attempts_no_delete BEFORE DELETE ON attempts
            BEGIN SELECT RAISE(ABORT,'immutable'); END;
          CREATE TRIGGER events_no_update BEFORE UPDATE ON events
            BEGIN SELECT RAISE(ABORT,'immutable'); END;
          CREATE TRIGGER events_no_delete BEFORE DELETE ON events
            BEGIN SELECT RAISE(ABORT,'immutable'); END;
          CREATE TRIGGER alerts_no_update BEFORE UPDATE ON alerts
            BEGIN SELECT RAISE(ABORT,'immutable'); END;
          CREATE TRIGGER alerts_no_delete BEFORE DELETE ON alerts
            BEGIN SELECT RAISE(ABORT,'immutable'); END;
          PRAGMA user_version=1;
          COMMIT;
        """)

    def close(self):
        if self._db is not None:
            self._db.close()
            self._db = None

    def _check_custody(self):
        try:
            info = self._file.lstat()
            parent = self._file.parent.stat()
            if (self._db is None or self._file != self._file.resolve()
                    or (info.st_dev, info.st_ino) != self._identity
                    or not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                    or stat.S_IMODE(info.st_mode) != 0o600 or info.st_uid != os.getuid()
                    or stat.S_IMODE(parent.st_mode) != 0o700 or parent.st_uid != os.getuid()):
                raise LedgerError("CUSTODY_INVALID")
        except OSError:
            raise LedgerError("CUSTODY_INVALID") from None

    @contextmanager
    def _transaction(self, now):
        _integer(now)
        if now > 2**53 - 1 - _WINDOW_MS:
            raise LedgerError("INPUT_INVALID")
        self._check_custody()
        try:
            self._db.execute("BEGIN IMMEDIATE")
            floor = self._validate_store()
            if now < floor:
                raise LedgerError("CLOCK_REVERSED")
            self._db.execute("UPDATE ledger_meta SET clock_floor=?", (now,))
            # Keep the validated locked observation outside operation rollback.
            # A semantic refusal commits ONLY the floor, never a partial attempt.
            self._db.execute("SAVEPOINT operation")
            try:
                yield
            except LedgerError as error:
                if error.code not in _SEMANTIC_REFUSALS:
                    raise
                self._db.execute("ROLLBACK TO operation")
                self._db.execute("RELEASE operation")
                self._check_custody()
                self._db.execute("COMMIT")
                raise
            else:
                self._check_custody()
                self._db.execute("COMMIT")
        except BaseException:
            if self._db.in_transaction:
                self._db.execute("ROLLBACK")
            raise

    def _bound(self, table, limit):
        # table/limit are internal constants, never request-selected.
        if self._db.execute("SELECT count(*) FROM " + table).fetchone()[0] >= limit:
            raise LedgerError("STORE_FULL")

    @staticmethod
    def _stored_json(raw, maximum):
        def closed(pairs):
            result = {}
            for key, value in pairs:
                if key in result:
                    raise ValueError()
                result[key] = value
            return result

        def invalid_constant(_):
            raise ValueError()

        if type(raw) is not str or not raw.isascii() or len(raw) > maximum:
            raise ValueError()
        return json.loads(raw, object_pairs_hook=closed, parse_constant=invalid_constant)

    @staticmethod
    def _stored_binding(value):
        if type(value) is not dict or set(value) != set(Binding.__dataclass_fields__):
            raise ValueError()
        Binding(**value).validate()
        return value

    def _validate_store(self):
        """Validate bounded persisted evidence under the writer lock before use.

        No migration, repair, cached authority or unchecked JSON replay. Keeping
        this inside BEGIN IMMEDIATE also covers corruption after construction.
        """
        try:
            columns = {
                "ledger_meta": ("version", "clock_floor"),
                "attempts": ("id", "employee", "goal", "session", "issued", "binding", "key", "fingerprint"),
                "events": ("id", "attempt", "sequence", "state", "key", "fingerprint", "body"),
                "alerts": ("id", "dimension", "subject", "blocked_until", "body"),
            }
            for table, names in columns.items():
                info = self._db.execute("PRAGMA table_info(" + table + ")").fetchall()
                integer_columns = {"version", "clock_floor", "issued", "sequence", "blocked_until"}
                if (tuple(row[1] for row in info) != names or
                        any(row[2] != ("INTEGER" if row[1] in integer_columns else "TEXT") for row in info)):
                    raise ValueError()
            meta = self._db.execute("SELECT version,clock_floor FROM ledger_meta").fetchall()
            if len(meta) != 1 or type(meta[0][0]) is not int or meta[0][0] != 1:
                raise ValueError()
            if self._db.execute("PRAGMA user_version").fetchone()[0] != 1:
                raise ValueError()
            floor = meta[0][1]
            _integer(floor)
            if floor > 2**53 - 1 - _WINDOW_MS:
                raise ValueError()
            for table, limit in (("attempts", _MAX_ROWS), ("events", _MAX_EVENTS), ("alerts", _MAX_ROWS)):
                if self._db.execute("SELECT count(*) FROM " + table).fetchone()[0] > limit:
                    raise ValueError()
            attempts = {}
            for attempt, employee, goal, session, issued, raw, key, fingerprint in self._db.execute(
                    "SELECT id,employee,goal,session,issued,binding,key,fingerprint FROM attempts"):
                _id(attempt, _HEX32)
                _id(key, _OPERATION_KEY)
                _integer(issued)
                binding = self._stored_binding(self._stored_json(raw, 1024))
                if (attempt in attempts or issued > floor or raw != _json(binding) or
                        (employee, goal, session) != (binding["employee_id"], binding["goal_id"], binding["session_id"]) or
                        fingerprint != _digest(binding)):
                    raise ValueError()
                attempts[attempt] = (binding, issued)
            latest, identifiers = {}, set()
            receipt_keys = {"schema_version", "receiptType", "receiptId", "attemptId", "binding",
                            "sequence", "state", "reason", "createdAtMs", "automaticAction"}
            for rid, attempt, sequence, state, key, fingerprint, raw in self._db.execute(
                    "SELECT id,attempt,sequence,state,key,fingerprint,body FROM events ORDER BY attempt,sequence"):
                _id(rid, _HEX32)
                _id(fingerprint, _HEX64)
                _integer(sequence, 1)
                body = self._stored_json(raw, 2048)
                if type(body) is not dict or set(body) != receipt_keys or attempt not in attempts:
                    raise ValueError()
                binding, issued = attempts[attempt]
                self._stored_binding(body["binding"])
                _integer(body["createdAtMs"])
                _integer(body["sequence"], 1)
                if (type(body["schema_version"]) is not int or body["schema_version"] != 1 or
                        body["receiptType"] != "RESUME_ATTEMPT" or body["automaticAction"] != "NONE" or
                        (body["receiptId"], body["attemptId"], body["sequence"], body["state"], body["binding"]) !=
                        (rid, attempt, sequence, state, binding) or rid in identifiers or
                        type(state) is not str or type(body["reason"]) is not str or
                        body["reason"] not in _REASONS.get(state, ()) or body["createdAtMs"] > floor):
                    raise ValueError()
                previous = latest.get(attempt)
                if previous is None:
                    if (sequence != 1 or state != "QUEUED" or key != "@reserve" or
                            body["createdAtMs"] != issued or fingerprint != _digest(binding)):
                        raise ValueError()
                else:
                    if (sequence != previous["sequence"] + 1 or state not in _NEXT.get(previous["state"], ()) or
                            body["createdAtMs"] < previous["createdAtMs"]):
                        raise ValueError()
                    if key == "@restart":
                        expected = _digest([attempt, previous["sequence"], previous["state"], "PROCESS_RESTART"])
                        if state != "UNCERTAIN" or body["reason"] != "PROCESS_RESTART":
                            raise ValueError()
                    else:
                        if type(key) is not str or not key.startswith("transition:"):
                            raise ValueError()
                        _id(key[len("transition:"):], _OPERATION_KEY)
                        expected = _digest([binding, attempt, previous["sequence"], previous["state"],
                                            state, body["reason"]])
                    if fingerprint != expected:
                        raise ValueError()
                latest[attempt] = body
                identifiers.add(rid)
            if set(latest) != set(attempts):
                raise ValueError()
            alert_keys = {"schema_version", "receiptType", "receiptId", "dimension", "subject",
                          "blockedUntilMs", "createdAtMs", "automaticAction"}
            for rid, dimension, subject, until, raw in self._db.execute(
                    "SELECT id,dimension,subject,blocked_until,body FROM alerts"):
                _id(rid, _HEX32)
                _id(subject)
                _integer(until)
                body = self._stored_json(raw, 2048)
                if type(body) is not dict or set(body) != alert_keys:
                    raise ValueError()
                _integer(body["createdAtMs"])
                _integer(body["blockedUntilMs"])
                if (type(body["schema_version"]) is not int or body["schema_version"] != 1 or
                        body["receiptType"] != "RESUME_BUDGET_REFUSED" or body["automaticAction"] != "NONE" or
                        (body["receiptId"], body["dimension"], body["subject"], body["blockedUntilMs"]) !=
                        (rid, dimension, subject, until) or rid in identifiers or
                        dimension not in ("employee", "goal", "session") or body["createdAtMs"] > floor):
                    raise ValueError()
                issued = sorted(time for binding, time in attempts.values()
                                if binding[dimension + "_id"] == subject and
                                body["createdAtMs"] - _WINDOW_MS < time <= body["createdAtMs"])
                if len(issued) < _MAX_ATTEMPTS or until != issued[-_MAX_ATTEMPTS] + _WINDOW_MS:
                    raise ValueError()
                identifiers.add(rid)
            return floor
        except (LedgerError, ValueError, TypeError, KeyError, OverflowError, RecursionError):
            raise LedgerError("STORE_UNAVAILABLE") from None

    def _latest(self, attempt):
        row = self._db.execute(
            "SELECT body FROM events WHERE attempt=? ORDER BY sequence DESC LIMIT 1", (attempt,)
        ).fetchone()
        if row is None:
            raise LedgerError("ATTEMPT_UNKNOWN")
        return json.loads(row[0])

    def _append(self, attempt, binding, sequence, state, reason, key, fingerprint, now):
        self._bound("events", _MAX_EVENTS)
        receipt = {"schema_version": 1, "receiptType": "RESUME_ATTEMPT",
                   "receiptId": uuid.uuid4().hex, "attemptId": attempt,
                   "binding": binding, "sequence": sequence, "state": state,
                   "reason": reason, "createdAtMs": now, "automaticAction": "NONE"}
        self._db.execute("INSERT INTO events VALUES(?,?,?,?,?,?,?)",
                         (receipt["receiptId"], attempt, sequence, state, key,
                          fingerprint, _json(receipt)))
        return receipt

    def _quota(self, binding, now):
        for column, subject in (("employee", binding.employee_id), ("goal", binding.goal_id),
                                ("session", binding.session_id)):
            rows = self._db.execute(
                "SELECT issued FROM attempts WHERE " + column + "=? AND issued>? ORDER BY issued",
                (subject, now - _WINDOW_MS)).fetchall()
            if len(rows) >= _MAX_ATTEMPTS:
                until = rows[-_MAX_ATTEMPTS][0] + _WINDOW_MS
                row = self._db.execute(
                    "SELECT body FROM alerts WHERE dimension=? AND subject=? AND blocked_until=?",
                    (column, subject, until)).fetchone()
                if row:
                    return json.loads(row[0]), True
                self._bound("alerts", _MAX_ROWS)
                alert = {"schema_version": 1, "receiptType": "RESUME_BUDGET_REFUSED",
                         "receiptId": uuid.uuid4().hex, "dimension": column, "subject": subject,
                         "blockedUntilMs": until, "createdAtMs": now, "automaticAction": "NONE"}
                self._db.execute("INSERT INTO alerts VALUES(?,?,?,?,?)",
                                 (alert["receiptId"], column, subject, until, _json(alert)))
                return alert, False
        return None

    @staticmethod
    def _validated(binding, key):
        if type(binding) is not Binding:
            raise LedgerError("INPUT_INVALID")
        binding.validate()
        _id(key, _OPERATION_KEY)

    def reserve(self, binding, key, now):
        """Append QUEUED before any submission; replay is never a send permit."""
        self._validated(binding, key)
        fingerprint = _digest(asdict(binding))
        try:
            with self._transaction(now):
                row = self._db.execute(
                    "SELECT id,fingerprint FROM attempts WHERE employee=? AND key=?",
                    (binding.employee_id, key)).fetchone()
                if row:
                    if row[1] != fingerprint:
                        raise LedgerError("IDEMPOTENCY_CONFLICT")
                    original = self._db.execute(
                        "SELECT body FROM events WHERE attempt=? AND sequence=1", (row[0],)).fetchone()
                    return {"replayed": True, "receipt": json.loads(original[0])}
                alert = self._quota(binding, now)
                if alert:
                    return {"replayed": alert[1], "receipt": alert[0]}
                open_rows = self._db.execute("""
                  SELECT a.employee,a.goal,a.session,e.state FROM attempts a JOIN events e ON e.attempt=a.id
                  WHERE e.sequence=(SELECT MAX(x.sequence) FROM events x WHERE x.attempt=a.id)
                    AND e.state IN ('QUEUED','SUBMITTED','TURN_STARTED','UNCERTAIN')
                """).fetchall()
                if any(binding.employee_id == e or binding.goal_id == g or binding.session_id == s
                       for e, g, s, _ in open_rows):
                    raise LedgerError("UNRESOLVED_ATTEMPT")
                if len(open_rows) >= _MAX_ACTIVE:
                    raise LedgerError("QUEUE_FULL")
                self._bound("attempts", _MAX_ROWS)
                attempt = uuid.uuid4().hex
                self._db.execute("INSERT INTO attempts VALUES(?,?,?,?,?,?,?,?)",
                                 (attempt, binding.employee_id, binding.goal_id, binding.session_id,
                                  now, _json(asdict(binding)), key, fingerprint))
                receipt = self._append(attempt, asdict(binding), 1, "QUEUED", "QUEUED", "@reserve", fingerprint, now)
                return {"replayed": False, "receipt": receipt}
        except LedgerError:
            raise
        except (sqlite3.Error, ValueError, TypeError):
            raise LedgerError("STORE_UNAVAILABLE") from None

    def advance(self, binding, attempt, expected_sequence, expected_state, state, reason, key, now):
        """Append one CAS transition; no terminal/UNCERTAIN retry or reset path."""
        self._validated(binding, key)
        _id(attempt, _OPERATION_KEY)
        _integer(expected_sequence, 1)
        if (type(expected_state) is not str or type(state) is not str or type(reason) is not str
                or state not in _NEXT.get(expected_state, ()) or reason not in _REASONS.get(state, ())):
            raise LedgerError("TRANSITION_INVALID")
        fingerprint = _digest([asdict(binding), attempt, expected_sequence, expected_state, state, reason])
        try:
            with self._transaction(now):
                row = self._db.execute("SELECT binding FROM attempts WHERE id=?", (attempt,)).fetchone()
                if row is None or row[0] != _json(asdict(binding)):
                    raise LedgerError("BINDING_CHANGED")
                prior = self._db.execute(
                    "SELECT fingerprint,body FROM events WHERE attempt=? AND key=?",
                    (attempt, "transition:" + key)).fetchone()
                if prior:
                    if prior[0] != fingerprint:
                        raise LedgerError("IDEMPOTENCY_CONFLICT")
                    return {"replayed": True, "receipt": json.loads(prior[1])}
                latest = self._latest(attempt)
                if latest["sequence"] != expected_sequence or latest["state"] != expected_state:
                    raise LedgerError("CAS_STALE")
                receipt = self._append(attempt, asdict(binding), expected_sequence + 1,
                                       state, reason, "transition:" + key, fingerprint, now)
                return {"replayed": False, "receipt": receipt}
        except LedgerError:
            raise
        except (sqlite3.Error, ValueError, TypeError):
            raise LedgerError("STORE_UNAVAILABLE") from None

    def reconcile_restart(self, now):
        """Any possibly-started work becomes UNCERTAIN, atomically; never resend."""
        try:
            with self._transaction(now):
                rows = self._db.execute("""
                  SELECT a.id,a.binding,e.sequence,e.state FROM attempts a JOIN events e ON e.attempt=a.id
                  WHERE e.sequence=(SELECT MAX(x.sequence) FROM events x WHERE x.attempt=a.id)
                    AND e.state IN ('QUEUED','SUBMITTED','TURN_STARTED')
                """).fetchall()
                if len(rows) > _MAX_ACTIVE:
                    raise LedgerError("QUEUE_FULL")
                receipts = []
                for attempt, binding, sequence, state in rows:
                    receipts.append(self._append(attempt, json.loads(binding), sequence + 1,
                        "UNCERTAIN", "PROCESS_RESTART", "@restart",
                        _digest([attempt, sequence, state, "PROCESS_RESTART"]), now))
                return receipts
        except LedgerError:
            raise
        except (sqlite3.Error, ValueError, TypeError):
            raise LedgerError("STORE_UNAVAILABLE") from None
