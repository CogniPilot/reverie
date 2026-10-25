"""Bounded, optional failure metadata; never shell input/output or action authority.

Only the already-authenticated execution owner constructs this sink. There is
no environment/JSON identity loader, public ingestion route or shell trap.
"""
from dataclasses import dataclass
from pathlib import Path
import contextlib
import math
import os
import re
import sqlite3
import stat
import time
import uuid


@dataclass(frozen=True)
class Principal:
    """Trusted in-process binding supplied by the existing authenticated runtime.

    Structural validity is NOT proof of authentication; startup integration must
    obtain this binding from its existing authority, never event/command text.
    """
    employee_id: str
    harness: str


@dataclass(frozen=True)
class Limits:
    entries: int = 2048
    retention_seconds: int = 7 * 86400
    pages: int = 256
    catalog_entries: int = 256


_ID = re.compile(r'^[A-Za-z0-9_.:-]{1,100}$')
_KEY = re.compile(r'^[a-z][a-z0-9_.-]{0,47}$')
_CATEGORIES = frozenset(('COMMAND_NOT_FOUND', 'SIGNAL', 'NONZERO'))
_MAX_COUNTER = 2 ** 31 - 1


class _PinnedDatabase(os.PathLike):
    """SQLite no-create URI anchored to a held file, with its configured label.

    SQLite resolves /proc/self/fd on Linux. Renamed/unlinked stores are refused
    before SQL writes. This is not a custom VFS or a hostile same-uid ABA proof.
    """
    def __init__(self, path, fd):
        self.path, self.fd = path, fd

    def __str__(self):
        return str(self.path)

    def __fspath__(self):
        return 'file:/proc/self/fd/' + str(self.fd) + '?mode=rw'


def _counter(value):
    return min(value, _MAX_COUNTER) if type(value) is int and value >= 0 else 0


class FailureLog:
    """Dedicated durable telemetry DB, not CompanyStore, memory or effect ledger.

    Catalog keys/aliases are reviewed configuration. They are not sanitizers for
    arbitrary names. Unknown executable text is never persisted or fingerprinted.
    SQLite max_page_count bounds the DB; rollback-journal/temporary overhead is
    additional and belongs to the installed scheduler's whole-output budget.
    """
    def __init__(self, directory, principal, catalog, *, limits=Limits(), clock=time.time):
        if not isinstance(principal, Principal) or not _ID.fullmatch(principal.employee_id):
            raise ValueError('TELEMETRY_CONFIG_REFUSED')
        if principal.harness not in ('hands', 'codex', 'opencode', 'claude', 'pi'):
            raise ValueError('TELEMETRY_CONFIG_REFUSED')
        if (not isinstance(limits, Limits) or type(limits.entries) is not int or
                not 1 <= limits.entries <= 10000 or type(limits.retention_seconds) is not int or
                not 60 <= limits.retention_seconds <= 366 * 86400 or type(limits.pages) is not int or
                not 32 <= limits.pages <= 4096 or type(limits.catalog_entries) is not int or
                not 1 <= limits.catalog_entries <= 1024):
            raise ValueError('TELEMETRY_CONFIG_REFUSED')
        if not isinstance(catalog, dict) or len(catalog) > limits.catalog_entries:
            raise ValueError('TELEMETRY_CONFIG_REFUSED')
        aliases = {}
        for key, names in catalog.items():
            if (not isinstance(key, str) or not _KEY.fullmatch(key) or
                    not isinstance(names, (list, tuple)) or not 1 <= len(names) <= 16):
                raise ValueError('TELEMETRY_CONFIG_REFUSED')
            for name in names:
                if (not isinstance(name, str) or not 1 <= len(name) <= 256 or
                        any(c in name for c in '\x00\r\n') or name in aliases):
                    raise ValueError('TELEMETRY_CONFIG_REFUSED')
                aliases[name] = key
        directory = Path(directory)
        if not directory.is_absolute() or directory.resolve() != directory:
            raise ValueError('TELEMETRY_CONFIG_REFUSED')
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        info = directory.lstat()
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077):
            raise ValueError('TELEMETRY_CONFIG_REFUSED')
        self.path = directory / 'command-failures.sqlite'
        with contextlib.ExitStack() as held:
            directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            held.callback(os.close, directory_fd)
            current = os.fstat(directory_fd)
            if (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino):
                raise ValueError('TELEMETRY_CONFIG_REFUSED')
            self.directory_identity = (current.st_dev, current.st_ino)
            fd = os.open(self.path.name, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=directory_fd)
            held.callback(os.close, fd)
            st = os.fstat(fd)
            if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_uid != os.getuid() or st.st_mode & 0o077:
                raise ValueError('TELEMETRY_CONFIG_REFUSED')
            self.identity = (st.st_dev, st.st_ino)
        self.principal, self.aliases, self.limits, self.clock = principal, aliases, limits, clock
        self.tools = frozenset(catalog) | {'UNKNOWN_COMMAND'}
        self.dropped = 0  # fixed numeric local diagnostic; no raw error text
        with self._connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS failures (execution TEXT PRIMARY KEY, t INTEGER NOT NULL, employee TEXT NOT NULL, harness TEXT NOT NULL, tool TEXT NOT NULL, exit INTEGER NOT NULL, category TEXT NOT NULL)')
            db.execute('CREATE TABLE IF NOT EXISTS binding (id INTEGER PRIMARY KEY CHECK(id=1), employee TEXT NOT NULL, harness TEXT NOT NULL)')
            db.execute('INSERT OR IGNORE INTO binding VALUES (1,?,?)', (principal.employee_id, principal.harness))
            if db.execute('SELECT employee,harness FROM binding WHERE id=1').fetchone() != (principal.employee_id, principal.harness):
                raise ValueError('TELEMETRY_CONFIG_REFUSED')
            db.execute('CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, n INTEGER NOT NULL)')
            db.execute("INSERT OR IGNORE INTO counters VALUES ('evicted',0)")
            db.execute("INSERT OR IGNORE INTO counters VALUES ('expired',0)")

    def _check_directory(self, current):
        if ((current.st_dev, current.st_ino) != self.directory_identity or
                not stat.S_ISDIR(current.st_mode) or current.st_uid != os.getuid() or
                current.st_mode & 0o077):
            raise ValueError('TELEMETRY_STORE_REFUSED')

    def _check_file(self, current):
        if ((current.st_dev, current.st_ino) != self.identity or
                not stat.S_ISREG(current.st_mode) or current.st_nlink != 1 or
                current.st_uid != os.getuid() or current.st_mode & 0o077):
            raise ValueError('TELEMETRY_STORE_REFUSED')

    @contextlib.contextmanager
    def _connect(self):
        # No SQLite pathname create: pin a no-follow open in the bound directory,
        # request mode=rw through its descriptor, then refuse renamed names before
        # pragmas or transactions. /proc/self/fd is required; no path fallback.
        with contextlib.ExitStack() as held:
            directory_fd = os.open(self.path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            held.callback(os.close, directory_fd)
            self._check_directory(os.fstat(directory_fd))
            fd = os.open(self.path.name, os.O_RDWR | os.O_NOFOLLOW, dir_fd=directory_fd)
            held.callback(os.close, fd)
            self._check_file(os.fstat(fd))
            db = sqlite3.connect(_PinnedDatabase(self.path, fd), uri=True, timeout=0.05)
            held.callback(db.close)
            self._check_directory(self.path.parent.lstat())
            self._check_file(os.stat(self.path.name, dir_fd=directory_fd, follow_symlinks=False))
            # SQLite canonicalizes descriptor names. Check its resolved main name
            # as well; no SQL capable of writing precedes these identity checks.
            main = db.execute('PRAGMA database_list').fetchone()
            if main is None or main[1] != 'main':
                raise ValueError('TELEMETRY_STORE_REFUSED')
            actual_fd = os.open(main[2], os.O_RDONLY | os.O_NOFOLLOW)
            held.callback(os.close, actual_fd)
            self._check_file(os.fstat(actual_fd))
            db.execute('PRAGMA journal_mode=DELETE')
            db.execute('PRAGMA synchronous=FULL')
            db.execute('PRAGMA secure_delete=ON')
            maximum = db.execute('PRAGMA max_page_count=' + str(self.limits.pages)).fetchone()[0]
            if maximum > self.limits.pages:
                raise ValueError('TELEMETRY_STORE_REFUSED')
            with db:
                yield db

    def _expire(self, db, now):
        cutoff = now - self.limits.retention_seconds
        count = db.execute('SELECT count(*) FROM failures WHERE t<?', (cutoff,)).fetchone()[0]
        db.execute('DELETE FROM failures WHERE t<?', (cutoff,))
        db.execute("UPDATE counters SET n=n+? WHERE name='expired'", (count,))
        return cutoff

    def observe(self, executable, exit_code, execution_id):
        """One trusted OUTERMOST execution id; nested shell details never inspected.

        Unknowns aggregate under fixed UNKNOWN_COMMAND; unknown raw names and
        their hashes never enter storage. Identical root IDs dedupe nested reports.
        Caller cannot supply employee/harness/time/category/output fields.
        """
        try:
            if type(exit_code) is not int or not -255 <= exit_code <= 255 or exit_code == 0:
                return False
            if not isinstance(execution_id, str) or str(uuid.UUID(execution_id)) != execution_id:
                return False
            now = self.clock()
            if type(now) not in (int, float) or not math.isfinite(now) or not 0 <= now <= 2 ** 53:
                return False
            tool = self.aliases.get(executable, 'UNKNOWN_COMMAND') if isinstance(executable, str) and len(executable) <= 256 else 'UNKNOWN_COMMAND'
            category = 'COMMAND_NOT_FOUND' if exit_code == 127 else 'SIGNAL' if exit_code < 0 else 'NONZERO'
            row = (execution_id, int(now), self.principal.employee_id, self.principal.harness, tool, exit_code, category)
            with self._connect() as db:
                db.execute('BEGIN IMMEDIATE')
                self._expire(db, int(now))
                old = db.execute('SELECT employee,harness,tool,exit,category FROM failures WHERE execution=?', (execution_id,)).fetchone()
                if old is not None:
                    return old == row[2:]
                size = db.execute('SELECT count(*) FROM failures').fetchone()[0]
                remove = max(0, size-self.limits.entries+1)
                if remove:
                    db.execute('DELETE FROM failures WHERE execution IN (SELECT execution FROM failures ORDER BY t,execution LIMIT ?)', (remove,))
                    db.execute("UPDATE counters SET n=n+? WHERE name='evicted'", (remove,))
                db.execute('INSERT INTO failures VALUES (?,?,?,?,?,?,?)', row)
            return True
        except Exception:
            self.dropped = min(2 ** 31-1, self.dropped + 1)
            return False  # never echo input/error, retry a command or recurse

    def report(self):
        """Publish only the closed schema, including when stored data is malformed."""
        now = self.clock()
        if type(now) not in (int, float) or not math.isfinite(now) or not 0 <= now <= 2 ** 53:
            raise ValueError('TELEMETRY_STORE_REFUSED')
        with self._connect() as db:
            db.execute('BEGIN IMMEDIATE')
            cutoff = self._expire(db, int(now))
            rows = db.execute('SELECT tool,category,exit,count(*) FROM failures WHERE t>=? AND employee=? AND harness=? GROUP BY tool,category,exit ORDER BY tool,category,exit LIMIT ?', (cutoff,self.principal.employee_id,self.principal.harness,self.limits.entries)).fetchall()
            counters = dict(db.execute("SELECT name,n FROM counters WHERE name IN ('evicted','expired')"))
        counts = []
        for tool, category, exit_code, count in rows:
            if (type(tool) is not str or tool not in self.tools or
                    type(category) is not str or category not in _CATEGORIES or
                    type(exit_code) is not int or not -255 <= exit_code <= 255 or exit_code == 0 or
                    category != ('COMMAND_NOT_FOUND' if exit_code == 127 else 'SIGNAL' if exit_code < 0 else 'NONZERO') or
                    type(count) is not int or count < 1):
                continue  # fixed omission, never echo malformed values or errors
            counts.append({'tool': tool, 'category': category, 'exit': exit_code,
                           'count': min(count, self.limits.entries)})
        return {'v': 1, 'employee_id': self.principal.employee_id, 'harness': self.principal.harness, 'counts': counts,
                'evicted': _counter(counters.get('evicted')), 'expired': _counter(counters.get('expired')),
                'dropped': _counter(self.dropped)}



@contextlib.contextmanager
def execution_observer(log):
    """Bind one outer invocation in trusted code, never from model/tool JSON."""
    execution_id = str(uuid.uuid4())
    def report(executable, exit_code):
        if log is not None:
            try:
                log.observe(executable, exit_code, execution_id)
            except Exception:
                pass
    yield report
