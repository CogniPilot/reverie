#!/usr/bin/env python3
"""Build leases for disposable directories: roadmap T7b, to Ada's lease contract r10 (r4 behaviour + §T timestamps,
§5 several lease dirs, §C configuration, §G generic, r9 N1 probes and N2 unreadable walks, r10 §2M metadata). Names no team, repo or tool.

Lease dir (persistent, outside every pruned root): ~/.local/state/reverie/leases, or REVERIE_LEASE_DIR
(e.g. /var/lib/reverie/leases for host jobs). A leased directory D has:
  <st_dev>-<st_ino>.lock          kernel flock: holders LOCK_SH, the janitor LOCK_EX|LOCK_NB
  <st_dev>-<st_ino>.path.json     §2M: exactly one per lock {version 1, path, first_seen_utc}, written by the first
                                  holder or reserver; gc removes it with the lock (keys can't be reversed to paths)
  <st_dev>-<st_ino>.<pid>.json    §2M: one per LIVE holder, for people and receipts; deleted by its holder before release
  <st_dev>-<st_ino>.reserve.json  RESERVE: {version 1, path, created_utc, until_utc (epoch seconds, as Ada's
                                  reference model), owner, compute_lease_id?}; each window <= 24 h; renew rewrites it
and the lease dir has one barrier.lock. Every acquisition takes it SHARED for milliseconds; the janitor takes it
EXCLUSIVE from scan to delete, so no new lease can appear between the janitor's scan and its delete.
Liveness is only the kernel lock or a reservation's until_utc, never pid, heartbeat or metadata.
Exit codes: run = the command's code; check 0 free / 1 in use / 2 unknown; hold/run 3 busy barrier or replaced dir;
other lease errors 2.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager, ExitStack
import fcntl
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import time

FREE, IN_USE, UNKNOWN, BUSY = 0, 1, 2, 3
MAX_RESERVE = 24 * 3600
SH_RETRY_S = 0.5   # r9 N1: a probe may hold EX for an instant; retry, then refuse (exit 3)


class LeaseError(Exception):
    code = UNKNOWN


class Busy(LeaseError):
    code = BUSY


def leases_dir() -> Path:
    """This holder's own lease dir (§C: a default, set by configuration): REVERIE_LEASE_DIR, else
    ~/.local/state/reverie/leases. Holders may create their own; the janitor never creates any (see _scan_base)."""
    path = Path(os.environ.get("REVERIE_LEASE_DIR") or Path.home() / ".local/state/reverie/leases")
    if path.is_symlink():
        raise LeaseError(f"leases dir must not be a symlink: {path}")
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    return path


def _scan_base(path) -> Path:
    """A lease dir the janitor must check. Missing, symlinked or unreadable = UNKNOWN (fail closed): if a missing DIR
    counted as empty, a holder could create it and lease between the janitor's scan and its delete, and a root janitor
    creating the dir would leave it owned by root. So the platform pre-creates every laptop's lease dir (owned by that
    laptop's user) at provisioning. A missing barrier.lock inside an existing dir is fine (see _barrier)."""
    path = Path(path)
    if path.is_symlink() or not path.is_dir() or not os.access(path, os.R_OK | os.X_OK):
        raise LeaseError(f"lease dir missing, symlinked or unreadable: {path}")
    return path


def key_of(directory) -> str:
    """'<st_dev>-<st_ino>' of DIRECTORY by lstat. Refuses symlinks and non-directories."""
    st = os.lstat(directory)
    if not stat.S_ISDIR(st.st_mode):
        raise LeaseError(f"lease target must be a real directory: {directory}")
    return f"{st.st_dev}-{st.st_ino}"


def _open(path: Path, flags=os.O_RDWR | os.O_CREAT) -> int:
    return os.open(path, flags | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)


def _names_fd(path: Path, fd: int) -> bool:
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return False
    held = os.fstat(fd)
    return (st.st_dev, st.st_ino) == (held.st_dev, held.st_ino)


@contextmanager
def _barrier(base: Path, mode: int, wait: float):
    """Hold BASE/barrier.lock in MODE (LOCK_SH or LOCK_EX). wait=0 means non-blocking; raises Busy past WAIT.
    Creating it is race-free: it is never unlinked, and everyone opens it with O_CREAT (no O_EXCL), so a janitor and a
    concurrent holder always get the same inode. A root janitor hands a file it creates to the lease dir's owner, so
    the laptop user can still open it."""
    fd = _open(base / "barrier.lock")
    if os.geteuid() == 0:
        owner = os.stat(base)
        held = os.fstat(fd)
        if (held.st_uid, held.st_gid) != (owner.st_uid, owner.st_gid):
            os.fchown(fd, owner.st_uid, owner.st_gid)
    try:
        deadline = time.monotonic() + wait
        while True:
            try:
                fcntl.flock(fd, mode | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise Busy("lease barrier busy (a cleanup is deleting); try again")
                time.sleep(0.05)
        yield
    finally:
        os.close(fd)


def _now() -> float:
    return time.time()


def _pid_start(pid: int):
    try:
        return int(Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[19])
    except (OSError, IndexError, ValueError):
        return None


def _write_json(base: Path, name: str, value: dict) -> None:
    temp = base / f".{name}.tmp"
    fd = _open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC)
    try:
        os.write(fd, json.dumps(value).encode() + b"\n")
    finally:
        os.close(fd)
    os.replace(temp, base / name)


def _holder_files(base: Path, key: str) -> list[Path]:
    return [f for f in base.glob(f"{key}.*.json") if not f.name.endswith((".reserve.json", ".path.json"))]


def _ensure_path_record(base: Path, key: str, directory: str) -> None:
    """§2M: write <key>.path.json once (atomically), under the caller's barrier SH. Later holders leave it alone."""
    if not (base / f"{key}.path.json").exists():
        _write_json(base, f"{key}.path.json", {"version": 1, "path": directory, "first_seen_utc": time.time()})


def _path_record(base: Path, key: str):
    """(path or None, malformed?) from <key>.path.json."""
    try:
        value = json.loads((base / f"{key}.path.json").read_text())
    except FileNotFoundError:
        return None, False
    except (OSError, ValueError):
        return None, True
    if not isinstance(value, dict) or value.get("version") != 1 or not isinstance(value.get("path"), str):
        return None, True
    return value["path"], False


def _metadata(base: Path, key: str):
    """Live-holder records of KEY: (list of parsed dicts, malformed?). The path record counts as malformed too."""
    out, malformed = [], _path_record(base, key)[1]
    for path in _holder_files(base, key):
        try:
            out.append(json.loads(path.read_text()))
        except (OSError, ValueError):
            malformed = True
    return out, malformed


@contextmanager
def hold(directories, argv0: str = "", wait: float = 60.0, extra: dict | None = None):
    """Acquire shared leases on one or more DIRECTORIES in the contract r4 §3 order, then hold them all:
    stat every D -> barrier SH -> per D in sorted key order: open/create lock, LOCK_SH, fstat==stat (retry <= 5),
    re-stat D -> write metadata -> release the barrier. Lock files are never unlinked at release."""
    if isinstance(directories, (str, os.PathLike)):
        directories = [directories]
    base = leases_dir()
    keyed = []
    for d in directories:
        d = os.path.abspath(d)
        try:
            keyed.append((key_of(d), d))
        except FileNotFoundError:
            raise Busy(f"directory is missing: {d}")
    keyed.sort()
    fds = []
    try:
        with _barrier(base, fcntl.LOCK_SH, wait):
            for key, directory in keyed:
                lock = base / f"{key}.lock"
                for _attempt in range(5):
                    fd = _open(lock)
                    deadline = time.monotonic() + SH_RETRY_S
                    while True:
                        try:
                            fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
                            break
                        except BlockingIOError:   # only a non-conforming probe can hold EX outside the barrier
                            if time.monotonic() >= deadline:
                                os.close(fd)
                                raise Busy(f"lease held exclusively outside the barrier: {directory}")
                            time.sleep(0.01)
                    if _names_fd(lock, fd):
                        break
                    os.close(fd)                                # split inode left by gc: retry
                else:
                    raise Busy(f"lock file kept changing under us: {directory}")
                fds.append(fd)
                try:
                    replaced = key_of(directory) != key
                except (FileNotFoundError, LeaseError):
                    replaced = True
                if replaced:
                    raise Busy(f"directory was removed or replaced: {directory}")
            for key, directory in keyed:
                _ensure_path_record(base, key, directory)
                me = {"version": 1, "path": directory, "pid": os.getpid(), "start": _pid_start(os.getpid()),
                      "argv0": os.path.basename(argv0), "utc": time.time(), "session": os.getsid(0), **(extra or {})}
                _write_json(base, f"{key}.{os.getpid()}.json", me)
        yield [key for key, _d in keyed]
    finally:
        for key, _d in keyed[:len(fds)]:          # §2M: delete our own record while still locked
            try:
                (base / f"{key}.{os.getpid()}.json").unlink()
            except FileNotFoundError:
                pass
        for fd in fds:
            os.close(fd)


UNITS = {"s": 1, "m": 60, "h": 3600, "d": 86400}


def _parse_duration(text: str) -> int:
    match = re.fullmatch(r"(\d+)([smhd])", text)
    if not match:
        raise LeaseError(f"duration must look like 90m, 6h or 1d: {text}")
    seconds = int(match[1]) * UNITS[match[2]]
    if not 0 < seconds <= MAX_RESERVE:
        raise LeaseError("a reservation lasts more than 0 and at most 24 h")
    return seconds


def reserve(directory, duration: str, owner: str = "", compute_lease_id: str | None = None,
            wait: float = 60.0, renew: bool = False) -> str:
    """RESERVE (contract §2): a time-bound reservation for staged inputs, written under the barrier SH."""
    directory = os.path.abspath(directory)
    length = _parse_duration(duration)
    base = leases_dir()
    with _barrier(base, fcntl.LOCK_SH, wait):
        try:
            key = key_of(directory)           # D must still be a plain dir; never recreated
        except FileNotFoundError:
            raise Busy(f"directory is missing: {directory}")
        path = base / f"{key}.reserve.json"
        if renew:
            current = _read_reservation(path)
            if not current or current.get("path") != directory:
                raise LeaseError(f"no reservation to renew: {directory}")
        now = _now()   # renew rewrites the window: created = now, so each window is <= 24 h (Ada's model)
        value = {"version": 1, "path": directory, "created_utc": now, "until_utc": now + length,
                 "owner": owner or os.environ.get("USER", "")}
        if compute_lease_id:
            value["compute_lease_id"] = compute_lease_id
        _ensure_path_record(base, key, directory)
        _write_json(base, f"{key}.reserve.json", value)
        return key


def unreserve(directory, wait: float = 60.0) -> None:
    base = leases_dir()
    with _barrier(base, fcntl.LOCK_SH, wait):
        try:
            key = key_of(os.path.abspath(directory))
        except FileNotFoundError:
            raise Busy(f"directory is missing: {directory}")
        (base / f"{key}.reserve.json").unlink(missing_ok=True)


def _read_reservation(path: Path):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return None
    except (OSError, ValueError):
        return {"malformed": True}


def _reservation_state(base: Path, key: str) -> int:
    value = _read_reservation(base / f"{key}.reserve.json")
    if value is None:
        return FREE
    now = _now()
    try:
        created, until = value["created_utc"], value["until_utc"]
        # §T: JSON numbers only (bool is excluded: type(True) is bool), and P5's three bounds.
        ok = (value.get("version") == 1 and not value.get("malformed")
              and all(type(x) in (int, float) for x in (created, until))
              and 0 < until - created <= MAX_RESERVE and created <= now + 60 and until - now <= MAX_RESERVE)
    except (KeyError, TypeError, AttributeError):
        ok = False
    if not ok:                                          # an explicit test, never `assert` (stripped under -O; Rex A1)
        return UNKNOWN                                  # skip and report; never "live" and never "expired"
    return IN_USE if until > now else FREE              # expired: only a stale candidate; other checks still apply


def _keys_for(candidate: str, root: str | None):
    """Keys that protect CANDIDATE: itself and its descendants (walk, no symlinks), and its ancestors up to ROOT."""
    candidate = os.path.abspath(candidate)
    def unreadable(error):   # r9 N2: an unlistable or vanished subtree may hide a lease, so the answer is UNKNOWN
        raise LeaseError(f"cannot read part of the tree: {error}")
    try:
        keys = [key_of(current) for current, _dirs, _files in os.walk(candidate, followlinks=False, onerror=unreadable)]
        ancestors = []
        stop = os.path.abspath(root) if root else "/"
        parent = os.path.dirname(candidate)
        while True:
            ancestors.append(key_of(parent))
            if parent == stop or os.path.dirname(parent) == parent:
                break
            parent = os.path.dirname(parent)
    except OSError as error:
        raise LeaseError(f"cannot stat part of the tree: {error}")
    return keys, ancestors


@contextmanager
def janitor(candidate, root: str | None = None, bases=None):
    """For the prune (T7c): hold everything that makes deleting CANDIDATE safe, or raise.
    §5 several lease dirs: take every applicable barrier EX|NB in sorted path order (busy = Busy, so skip;
    missing or unreadable = UNKNOWN). Then walk (candidate, ancestors, descendants); in every lease dir, skip on
    a live reservation, treat malformed metadata or reservations as UNKNOWN, and LOCK_EX|NB every EXISTING lock
    in sorted key order, held through the with-block. The barriers stop a new lease from appearing after the
    scan, so no lock files are created. Delete inside the block (no-follow, st_dev checks per proposal §6)."""
    if os.path.islink(candidate) or not os.path.isdir(candidate):
        raise LeaseError(f"candidate must be a real directory: {candidate}")
    bases = sorted((_scan_base(b) for b in (bases or [leases_dir()])), key=str)
    with ExitStack() as stack:
        for base in bases:
            stack.enter_context(_barrier(base, fcntl.LOCK_EX, 0))
        own, ancestors = _keys_for(candidate, root)
        keys = sorted(set(own) | set(ancestors))
        for base in bases:
            for key in keys:
                state = _reservation_state(base, key)
                if state == UNKNOWN:
                    raise LeaseError(f"malformed or out-of-bounds reservation: {base}/{key}")
                if state == IN_USE:
                    err = LeaseError(f"reserved: {base}/{key}"); err.code = IN_USE; raise err
        for base in bases:
            for key in keys:
                path = base / f"{key}.lock"
                if not path.exists():
                    continue
                if _metadata(base, key)[1]:
                    raise LeaseError(f"malformed lease metadata: {base}/{key}")
                fd = _open(path, os.O_RDWR)
                stack.callback(os.close, fd)
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    err = LeaseError(f"leased: {base}/{key}"); err.code = IN_USE; raise err
        yield own


def check(candidate, root: str | None = None, bases=None) -> tuple[int, str]:
    """`lease check`: exactly the janitor's test, without deleting. Returns (0 free | 1 in use | 2 unknown, why)."""
    try:
        if os.path.islink(candidate):
            return UNKNOWN, "candidate is a symlink"
        with janitor(candidate, root, bases):
            return FREE, "free"
    except Busy as error:
        return IN_USE, str(error)   # a busy barrier means SKIP this pass, as in Ada's reference model
    except LeaseError as error:
        return (IN_USE if error.code == IN_USE else UNKNOWN), str(error)
    except OSError as error:
        return UNKNOWN, str(error)


def _kill_session(pgid: int, grace: float = 10.0) -> None:
    for sig, wait in ((signal.SIGTERM, grace), (signal.SIGKILL, 5.0)):
        try:
            os.killpg(pgid, sig)
        except ProcessLookupError:
            return
        deadline = time.monotonic() + wait
        while time.monotonic() < deadline:
            try:
                os.killpg(pgid, 0)
            except ProcessLookupError:
                return
            time.sleep(0.05)


def run(directories, command: list[str], wait: float = 60.0) -> int:
    """`lease run`: hold DIRECTORIES for the command's life, then kill and reap its session, then release."""
    if not command:
        raise LeaseError("run needs a command")
    with hold(directories, command[0], wait):
        process = subprocess.Popen(command, start_new_session=True)
        def forward(signum, _frame):
            try:
                os.killpg(process.pid, signum)
            except ProcessLookupError:
                pass
        previous = {sig: signal.signal(sig, forward) for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)}
        try:
            code = process.wait()
        finally:
            _kill_session(process.pid)
            for sig, handler in previous.items():
                signal.signal(sig, handler)
        return code


def hold_until_term(directory, wait: float = 60.0) -> int:
    """`lease hold`: for supervisors that reap their own children. Holds until SIGTERM or SIGINT."""
    stop = []
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda signum, _frame: stop.append(signum))
    with hold(directory, "lease-hold", wait) as keys:
        print(f"LEASED {keys[0]}", flush=True)
        while not stop:
            signal.pause()
    return 0


def gc(base: Path | None = None) -> dict:
    """`lease gc` (§2M), under barrier EX. For every lock it can take EX: drop leftover records of dead holders; if
    its dir is gone (path record's path missing, or its dev-ino differs from the key), remove the lock, the path
    record and any reservation. A lock with no path record (legacy) is kept and reported, never guessed at."""
    base = base or leases_dir()
    removed, legacy = [], []
    with _barrier(base, fcntl.LOCK_EX, 60.0):
        for lock in sorted(base.glob("*.lock")):
            key = lock.name[:-5]
            if key == "barrier":
                continue
            fd = _open(lock, os.O_RDWR)
            try:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    continue                                    # held: never touched
                for stale in _holder_files(base, key):          # free lock: every holder is dead
                    stale.unlink(missing_ok=True)
                path, malformed = _path_record(base, key)
                if path is None:
                    legacy.append(key + (" (malformed path record)" if malformed else ""))
                    continue
                try:
                    gone = key_of(path) != key
                except (FileNotFoundError, LeaseError):
                    gone = True
                if gone:
                    for name in (f"{key}.reserve.json", f"{key}.path.json"):
                        (base / name).unlink(missing_ok=True)
                    lock.unlink(missing_ok=True)
                    removed.append(key)
            finally:
                os.close(fd)
    return {"removed": removed, "keptNoPathRecord": legacy}


def ls(base: Path | None = None):
    """`lease ls`: held leases and live reservations, with their metadata. r9 N1: it takes the barrier EX|NB first,
    like the janitor, and reports "busy" (never "free") when an acquisition or cleanup is in progress."""
    base = base or leases_dir()
    try:
        with _barrier(base, fcntl.LOCK_EX, 0):
            return _ls_locked(base)
    except Busy:
        return {"busy": True}


def _ls_locked(base: Path) -> list[dict]:
    out = []
    for lock in sorted(base.glob("*.lock")):
        key = lock.name[:-5]
        if key == "barrier":
            continue
        fd = _open(lock, os.O_RDONLY)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB); held = False
        except BlockingIOError:
            held = True
        finally:
            os.close(fd)
        reserved = _reservation_state(base, key) == IN_USE
        if held or reserved:
            records, malformed = _metadata(base, key)
            out.append({"key": key, "held": held, "reserved": reserved, "malformedMetadata": malformed,
                        "path": _path_record(base, key)[0], "holders": records})
    return out


def main(argv=None) -> int:
    if sys.flags.optimize:
        print("lease: refusing to run under python -O (it would strip safety checks)", file=sys.stderr)
        return UNKNOWN
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--wait", type=float, default=60.0, help="seconds to wait at a busy barrier (default 60)")
    parser.add_argument("--leases-dir", action="append", default=[],
                        help="lease dir (configuration, §C). Holders use the first; `check` checks every one given. "
                             "Default: $REVERIE_LEASE_DIR or ~/.local/state/reverie/leases")
    sub = parser.add_subparsers(dest="action", required=True)
    r = sub.add_parser("run"); r.add_argument("rest", nargs=argparse.REMAINDER, help="DIR [DIR...] -- CMD...")
    sub.add_parser("hold").add_argument("dir")
    for name in ("reserve", "renew"):
        p = sub.add_parser(name); p.add_argument("dir"); p.add_argument("--for", dest="duration", required=True)
        p.add_argument("--compute-lease-id")
    sub.add_parser("unreserve").add_argument("dir")
    c = sub.add_parser("check"); c.add_argument("dir"); c.add_argument("--root", help="highest ancestor to check")
    sub.add_parser("gc"); sub.add_parser("ls")
    args = parser.parse_args(argv)
    if args.leases_dir:
        os.environ["REVERIE_LEASE_DIR"] = args.leases_dir[0]
    try:
        if args.action == "run":
            if "--" not in args.rest or args.rest.index("--") == 0:
                raise LeaseError("usage: lease run DIR [DIR...] -- CMD...")
            cut = args.rest.index("--")
            return run(args.rest[:cut], args.rest[cut + 1:], args.wait)
        if args.action == "hold":
            return hold_until_term(args.dir, args.wait)
        if args.action in ("reserve", "renew"):
            print(reserve(args.dir, args.duration, compute_lease_id=args.compute_lease_id, wait=args.wait,
                          renew=args.action == "renew")); return 0
        if args.action == "unreserve":
            unreserve(args.dir, args.wait); return 0
        if args.action == "check":
            code, why = check(args.dir, args.root, args.leases_dir or None)
            print(json.dumps({"path": os.path.abspath(args.dir), "state": ["free", "in use", "unknown"][code], "why": why}))
            return code
        if args.action == "gc":
            print(json.dumps(gc())); return 0
        print(json.dumps(ls(), indent=1)); return 0
    except LeaseError as error:
        print(f"lease: {error}", file=sys.stderr)
        return error.code
    except OSError as error:
        print(f"lease: {error}", file=sys.stderr)
        return UNKNOWN


if __name__ == "__main__":
    raise SystemExit(main())
