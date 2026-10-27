#!/usr/bin/env python3
"""reverie-prune: nightly cleanup of registered rebuildable roots (prune-spec r4, lease contract r9, proposal r32).
Leases are Bev's lease.py (the one implementation), loaded from the configured lease_lib path.

Dry-run is the default. Deleting needs both --live and live_enabled = true in the config. Every candidate must pass
every check (spec §4); any doubt means SKIP. Stdlib only. Run with python3 -I.
"""
import argparse
import contextlib
import fcntl
import fnmatch
import json
import os
import importlib.util
import random
import shutil
import stat
import string
import subprocess
import sys
import time
import tomllib

EXIT_OK, EXIT_CONFIG, EXIT_LIVE_REFUSED, EXIT_PARTIAL, EXIT_BUSY = 0, 2, 3, 4, 5
DAY = 86400
CLOCK_SKEW = 60  # seconds of clock skew tolerated on reservation timestamps (lease contract r8+ §T)
DEFAULTS = {
    "live_enabled": False,
    "b_mount": "/mnt/scratch",
    "laptops_root": "laptops/employees",  # host layout is configuration; no user names built in
    "high_water_pct": 70,
    "low_water_pct": 50,
    "idle_days": 3,
    "recent_write_hours": 6,
    "max_delete_bytes": 200 << 30,
    "max_delete_seconds": 1800,
    "registry_dir": "/etc/reverie/prune-registry",
    "checkout_roots": [],
    "checkout_max_depth": 6,
    "log_dir": "/var/log/reverie-prune",
    "lock_path": "/run/reverie-prune.lock",
    # Lease contract (T7a). {laptop} is the laptop's folder on B, {home} its persistent home on A.
    "laptop_home_root": "",
    "lease_dir_template": "{home}/.local/state/reverie/leases",
    "host_lease_dirs": ["/var/lib/reverie/leases"],
    "lease_report_days": 3,
    "lease_lib": "/usr/lib/reverie/lease.py",  # Bev's lease.py: the one lease implementation
    # A command printing JSON [{"id":..., "init_pid":...}] for running laptops (host runtime specific).
    "laptops_cmd": [],
}
CANDIDATE_KINDS = ("build", "cache", "downloads")
NEVER_DELETE_NAMES = {"sccache"}  # inside cache candidates; sccache has its own cap
REASON_ORDER = ("proc_unreadable", "lease_unknown", "lease_held", "reserved", "barrier_busy", "open_file", "cwd",
                "recent_write", "tool_lock", "keep", "mount", "symlink_path", "walk_error", "git_unsafe", "registry_invalid",
                "not_idle")


class ConfigError(Exception):
    pass


def utc(ts):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts)) if ts else None


# ---------------------------------------------------------------------------------------------------------- config
def load_config(path, test_root):
    try:
        with open(path, "rb") as f:
            raw = tomllib.load(f)
    except (OSError, tomllib.TOMLDecodeError) as e:
        raise ConfigError(f"config: {e}")
    unknown = set(raw) - set(DEFAULTS) - {"test_mode"}
    if unknown:
        raise ConfigError(f"config: unknown keys {sorted(unknown)}")
    cfg = dict(DEFAULTS)
    cfg.update(raw)
    if raw.get("test_mode") and not test_root:
        raise ConfigError("config: test_mode requires --test-root")
    if test_root:
        root = os.path.realpath(test_root)
        if "lock_path" not in raw:
            cfg["lock_path"] = os.path.join(root, ".reverie-prune.lock")
        if "host_lease_dirs" not in raw:
            cfg["host_lease_dirs"] = []
        for key in ("b_mount", "registry_dir", "log_dir", "lock_path", "laptop_home_root"):  # lease_lib is code
            if cfg[key]:
                cfg[key] = under(root, cfg[key])
        cfg["checkout_roots"] = [under(root, p) for p in cfg["checkout_roots"]]
        cfg["host_lease_dirs"] = [under(root, p) for p in cfg["host_lease_dirs"]]
    if not (0 <= cfg["low_water_pct"] <= cfg["high_water_pct"] <= 100):
        raise ConfigError("config: need 0 <= low_water_pct <= high_water_pct <= 100")
    return cfg


def under(root, p):
    """In test mode every configured path must already lie inside --test-root (relative ones are taken from it)."""
    full = os.path.realpath(os.path.join(root, p))
    if os.path.commonpath([root, full]) != root:
        raise ConfigError(f"config: {p} is outside --test-root")
    return full


# ---------------------------------------------------------------------------------------------------------- laptops
def discover_laptops(cfg, args):
    """Running laptops: [{'id', 'folder' (on B), 'home' (on A or None), 'init_pid' (or None)}]."""
    base = os.path.join(cfg["b_mount"], cfg["laptops_root"])
    if args.test_laptops:
        with open(args.test_laptops) as f:
            rows = json.load(f)
    elif args.test_root:
        rows = [{"id": n, "init_pid": None} for n in sorted(os.listdir(base))] if os.path.isdir(base) else []
    else:
        if not cfg["laptops_cmd"]:
            raise ConfigError("cannot enumerate running laptops: laptops_cmd is not configured")
        out = subprocess.run(cfg["laptops_cmd"], capture_output=True, text=True, timeout=60)
        if out.returncode != 0:
            raise ConfigError(f"laptops_cmd failed: exit {out.returncode}")
        rows = json.loads(out.stdout)
    laptops = []
    for r in rows:
        lid = str(r["id"])
        if "/" in lid or lid in ("", ".", ".."):
            raise ConfigError(f"bad laptop id {lid!r}")
        home = os.path.join(cfg["laptop_home_root"], lid, "home") if cfg["laptop_home_root"] else None
        pid = r.get("init_pid")
        if not args.test_root:
            if pid is None:
                raise ConfigError(f"laptop {lid} has no init_pid: PID view can't be verified")
            if not os.path.isdir(f"/proc/{pid}") or not os.access(f"/proc/{pid}/mountinfo", os.R_OK):
                raise ConfigError(f"PID view does not cover laptop {lid} (init pid {pid})")
        laptops.append({"id": lid, "folder": os.path.join(base, lid), "home": home, "init_pid": pid})
    return laptops


# ---------------------------------------------------------------------------------------------------------- /proc
def pid_state(base):
    """The state letter from /proc/<pid>/stat (after the last ')'), or None if it's gone."""
    try:
        with open(f"{base}/stat") as f:
            return f.read().rsplit(")", 1)[1].split()[0]
    except (FileNotFoundError, ProcessLookupError, IndexError):
        return None


def maps_inodes(base):
    """(st_dev, ino) of every file mapped into the process (/proc/<pid>/maps: 'major:minor' in hex, then inode)."""
    out = set()
    with open(f"{base}/maps") as f:
        for line in f:
            parts = line.split(None, 5)
            if len(parts) < 5 or parts[4] == "0":
                continue
            major, minor = parts[3].split(":")
            out.add((os.makedev(int(major, 16), int(minor, 16)), int(parts[4])))
    return out


def proc_scan(test_mode):
    """(dev, ino) of everything a process uses: fd targets (files and dirs), mapped files and the executable; and
    every cwd and root. Fail closed: any live pid we can't read makes the scan 'unreadable'. Zombies (Z, X) hold
    nothing and are skipped (Rex P4). In test mode, pids of other users are ignored (an unprivileged sandbox can't
    read them)."""
    me, uid, root = os.getpid(), os.getuid(), os.geteuid() == 0
    opened, dirs, unreadable = set(), set(), False
    for name in os.listdir("/proc"):
        if not name.isdigit() or int(name) == me:
            continue
        base = f"/proc/{name}"
        try:
            if test_mode and not root and os.stat(base).st_uid != uid:
                continue  # unprivileged sandbox only; as root (phase-3 host tests) every pid counts
            state = pid_state(base)
            if state is None or state in ("Z", "X"):
                continue
            for fd in os.listdir(f"{base}/fd"):
                try:
                    st = os.stat(f"{base}/fd/{fd}")
                    opened.add((st.st_dev, st.st_ino))
                except FileNotFoundError:
                    pass  # fd closed meanwhile, or a target that no longer exists
            opened |= maps_inodes(base)
            for link, into in (("exe", opened), ("cwd", dirs), ("root", dirs)):
                try:
                    st = os.stat(f"{base}/{link}")
                    into.add((st.st_dev, st.st_ino))
                except FileNotFoundError:
                    pass  # kernel threads have no exe
        except (FileNotFoundError, ProcessLookupError):
            if os.path.isdir(base) and pid_state(base) not in (None, "Z", "X"):
                unreadable = True  # still alive but part of it vanished: don't trust this scan
            continue
        except (PermissionError, ValueError):
            if pid_state(base) in (None, "Z", "X"):
                continue  # exited or became a zombie meanwhile
            unreadable = True
    return opened, dirs, unreadable


# ---------------------------------------------------------------------------------------------------------- tree walk
class Walk:
    """One lstat walk of a candidate: bytes, newest mtime, inode sets, markers. Never follows symlinks."""

    def __init__(self, root, exclude_top=()):
        self.root = root
        self.bytes = 0
        self.newest = 0.0
        self.files, self.dirs = set(), set()
        self.keep = False
        self.mount = False
        self.cargo_locks = []
        self.error = None
        try:
            top = os.lstat(root)
        except OSError as e:
            self.error = str(e)
            return
        if not stat.S_ISDIR(top.st_mode):
            self.error = "not a directory"
            return
        self.dev = top.st_dev
        self.root_id = (top.st_dev, top.st_ino)
        self._visit(root, top, exclude_top, depth=0)

    def _visit(self, path, st, exclude_top, depth):
        self.dirs.add((st.st_dev, st.st_ino))
        self.newest = max(self.newest, st.st_mtime)
        try:
            entries = list(os.scandir(path))
        except OSError as e:
            self.error = f"scandir {path}: {e.__class__.__name__}"
            return
        for e in entries:
            if depth == 0 and e.name in exclude_top:
                continue
            try:
                est = e.stat(follow_symlinks=False)
            except OSError as err:
                self.error = f"lstat {e.path}: {err.__class__.__name__}"
                continue
            self.bytes += est.st_blocks * 512
            if e.name == ".keep":
                self.keep = True
            if stat.S_ISDIR(est.st_mode):
                if est.st_dev != self.dev:
                    self.mount = True
                    continue
                self._visit(e.path, est, (), depth + 1)
            else:
                self.newest = max(self.newest, est.st_mtime)
                if stat.S_ISREG(est.st_mode):
                    self.files.add((est.st_dev, est.st_ino))
                    if e.name == ".cargo-lock":
                        self.cargo_locks.append(e.path)


def symlink_in_path(path, stop):
    """True if any component of path below stop (inclusive of path) is a symlink."""
    path, stop = os.path.normpath(path), os.path.normpath(stop)
    cur = path
    while True:
        try:
            if stat.S_ISLNK(os.lstat(cur).st_mode):
                return True
        except FileNotFoundError:
            return True
        if cur == stop or os.path.dirname(cur) == cur:
            return False
        cur = os.path.dirname(cur)


def ancestors(path, stop):
    """Directories from path's parent up to and including stop."""
    out, cur = [], os.path.dirname(os.path.normpath(path))
    stop = os.path.normpath(stop)
    while True:
        out.append(cur)
        if cur == stop or os.path.dirname(cur) == cur:
            return out
        cur = os.path.dirname(cur)


# ---------------------------------------------------------------------------------------------------------- leases
def long_held(dirs, days):
    """Lock files held now and older than `days` (lock file mtime). Each dir is probed only while holding its
    barrier EX|NB (contract r9 N1); a busy barrier is reported as such, never as free."""
    out = []
    for d in dirs:
        if not d or not os.path.isdir(d):
            continue
        bfile = os.path.join(d, "barrier.lock")
        if not os.path.exists(bfile):
            out += _long_held_in(d, days)  # no barrier yet: no holder has ever registered here
            continue
        fd = os.open(bfile, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                out.append(os.path.join(d, "barrier.lock (busy, not probed)"))
                continue
            out += _long_held_in(d, days)
        finally:
            os.close(fd)
    return out


def _long_held_in(d, days):
    out = []
    for n in os.listdir(d):
        if not n.endswith(".lock") or n == "barrier.lock":
            continue
        p = os.path.join(d, n)
        try:
            if time.time() - os.lstat(p).st_mtime < days * DAY:
                continue
            fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW)
        except OSError:
            continue
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            out.append(p)
        finally:
            os.close(fd)
    return out


# ---------------------------------------------------------------------------------------------------------- leases
def load_lease_lib(path, test_mode):
    """The ONE lease implementation (Bev's lease.py, contract r9). Root must only import a root-owned file that
    nobody else can write."""
    if not test_mode:
        # Rex m2: the whole path, not just the file: no symlink anywhere, and every directory from / down plus the
        # file itself root-owned and not group/world-writable, so no user can swap lease.py under root.
        if not os.path.isabs(path) or os.path.realpath(path) != os.path.normpath(path):
            raise ConfigError(f"lease_lib {path} must be an absolute path with no symlinks")
        cur = path
        while True:
            st = os.lstat(cur)
            if st.st_uid != 0 or st.st_mode & 0o022:
                raise ConfigError(f"lease_lib: {cur} must be root-owned and not group/world-writable")
            if cur == "/":
                break
            cur = os.path.dirname(cur)
    spec = importlib.util.spec_from_file_location("reverie_lease", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    for name in ("janitor", "LeaseError", "Busy", "IN_USE"):
        if not hasattr(mod, name):
            raise ConfigError(f"lease_lib {path} lacks {name}")
    return mod


def lease_reasons(lib, error):
    """Map a janitor() refusal to a log reason."""
    if isinstance(error, lib.Busy):
        return ["barrier_busy"]
    if isinstance(error, lib.LeaseError) and getattr(error, "code", None) == lib.IN_USE:
        return ["reserved"] if str(error).startswith("reserved") else ["lease_held"]
    return ["lease_unknown"]


# ---------------------------------------------------------------------------------------------------------- checks
def tool_locked(paths):
    for p in paths:
        try:
            fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW)
        except OSError:
            continue
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        finally:
            os.close(fd)
    return False


def evaluate(cand, stop, walk, proc, cfg, now):
    """Every spec §4 check except leases (those are the lease library's job, under its barrier). Returns
    (reasons, checks)."""
    reasons, checks = [], {}
    opened, dirs, unreadable = proc
    if unreadable:
        reasons.append("proc_unreadable")
    if walk.error:
        reasons.append("walk_error")
    keep = walk.keep or any(os.path.lexists(os.path.join(a, ".keep")) for a in ancestors(cand, stop))
    checks["keep"] = keep
    if keep:
        reasons.append("keep")
    n_open = len((walk.files | walk.dirs) & opened)
    n_cwd = len(walk.dirs & dirs)
    checks["open_files"], checks["cwd"] = n_open, n_cwd
    if n_open:
        reasons.append("open_file")
    if n_cwd:
        reasons.append("cwd")
    recent = walk.newest > now - cfg["recent_write_hours"] * 3600
    checks["recent_write"] = recent
    if recent:
        reasons.append("recent_write")
    tl = tool_locked(walk.cargo_locks)
    checks["tool_lock"] = tl
    if tl:
        reasons.append("tool_lock")
    mount = walk.mount
    try:
        mount = mount or os.lstat(cand).st_dev != os.lstat(os.path.dirname(cand)).st_dev
    except OSError:
        mount = True
    checks["mount"] = mount
    if mount:
        reasons.append("mount")
    if symlink_in_path(cand, stop):
        reasons.append("symlink_path")
    return sorted(set(reasons), key=REASON_ORDER.index), checks


# ---------------------------------------------------------------------------------------------------------- delete
class DeleteError(Exception):
    pass


def chain_inodes(trusted, cand):
    """The path components from a trusted base down to the candidate, with each one's (dev, ino) by lstat.
    Every component must be a real directory (no symlink)."""
    rel = os.path.relpath(os.path.normpath(cand), os.path.normpath(trusted))
    parts = rel.split(os.sep)
    if rel == "." or ".." in parts:
        raise DeleteError("candidate is not below its trusted base")
    cur, out = trusted, []
    for part in parts:
        cur = os.path.join(cur, part)
        st = os.lstat(cur)
        if not stat.S_ISDIR(st.st_mode):
            raise DeleteError("path component is not a directory")
        out.append((st.st_dev, st.st_ino))
    return parts, out


def delete_tree(trusted, root_dev, parts, expected, exclude_top=(), deadline=None):
    """Delete trusted/parts... (Rex P1). Opened from the trusted base one component at a time with O_NOFOLLOW, each
    fstat-matched to the inode seen under the barrier and pinned to root_dev, so a component swapped for a symlink
    after the checks makes this fail instead of deleting elsewhere. Never crosses a filesystem. Returns bytes."""
    fd = os.open(trusted, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        if os.fstat(fd).st_dev != root_dev:
            raise DeleteError("trusted base is not on the configured filesystem")
        for part, exp in zip(parts[:-1], expected[:-1]):
            nfd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            fst = os.fstat(nfd)
            os.close(fd)
            fd = nfd
            if (fst.st_dev, fst.st_ino) != exp or fst.st_dev != root_dev:
                raise DeleteError("path component changed since the checks")
        st = os.lstat(parts[-1], dir_fd=fd)
        if not stat.S_ISDIR(st.st_mode) or (st.st_dev, st.st_ino) != expected[-1] or st.st_dev != root_dev:
            raise DeleteError("candidate changed since the checks")
        freed = [0]
        _rm_dir(fd, parts[-1], st, root_dev, exclude_top, freed, deadline, top=True)
        return freed[0]
    finally:
        os.close(fd)


def _rm_dir(pfd, name, st, dev, exclude_top, freed, deadline, top=False):
    if st.st_dev != dev:
        raise DeleteError("filesystem boundary")
    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=pfd)
    try:
        fst = os.fstat(fd)
        if (fst.st_dev, fst.st_ino) != (st.st_dev, st.st_ino):
            raise DeleteError("directory replaced during deletion")
        kept = False
        with os.scandir(fd) as it:
            entries = list(it)
        for e in entries:
            if deadline and time.monotonic() > deadline:
                raise DeleteError("max_delete_seconds reached")
            if top and e.name in exclude_top:
                kept = True
                continue
            est = os.lstat(e.name, dir_fd=fd)
            if stat.S_ISDIR(est.st_mode):
                if est.st_dev != dev:
                    raise DeleteError("filesystem boundary")
                _rm_dir(fd, e.name, est, dev, (), freed, deadline)
            else:
                os.unlink(e.name, dir_fd=fd)
                freed[0] += est.st_blocks * 512
    finally:
        os.close(fd)
    if not kept:
        os.rmdir(name, dir_fd=pfd)
        freed[0] += st.st_blocks * 512


# ---------------------------------------------------------------------------------------------------------- git
GIT = shutil.which("git") or "git"


def run_git(co, args):
    """Run git for a checkout as the checkout's owner, never as root (Rex P2), with repo-controlled command hooks
    disabled. Returns CompletedProcess, or None when the checkout's ownership makes that unsafe."""
    try:
        st_co, st_git = os.lstat(co), os.lstat(os.path.join(co, ".git"))
    except OSError:
        return None
    as_root = os.geteuid() == 0
    if st_co.st_uid != st_git.st_uid or (as_root and st_co.st_uid == 0):
        return None
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": "/nonexistent", "LC_ALL": "C",
           "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull, "GIT_OPTIONAL_LOCKS": "0",
           "GIT_TERMINAL_PROMPT": "0"}

    def drop():
        if as_root:
            os.setgroups([])
            os.setgid(st_co.st_gid)
            os.setuid(st_co.st_uid)
    cmd = [GIT, "-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null", "-C", co] + args
    try:
        return subprocess.run(cmd, capture_output=True, text=True, env=env, preexec_fn=drop, timeout=120)
    except (OSError, subprocess.SubprocessError):
        return None


# ---------------------------------------------------------------------------------------------------------- disk
def disk_pct(path, override=None, removed=0):
    vf = os.statvfs(path)
    total = (vf.f_blocks - vf.f_bfree + vf.f_bavail) * vf.f_frsize
    if override is not None:
        return override - 100.0 * removed / total if total else override
    used = (vf.f_blocks - vf.f_bfree) * vf.f_frsize - removed
    return 100.0 * used / total if total else 0.0


def df_row(path):
    vf = os.statvfs(path)
    return {"path": path, "total": vf.f_blocks * vf.f_frsize, "free": vf.f_bavail * vf.f_frsize,
            "used_pct": round(disk_pct(path), 2)}


# ---------------------------------------------------------------------------------------------------------- runner
class Run:
    def __init__(self, cfg, args):
        self.cfg, self.args = cfg, args
        self.live = args.live
        self.test = bool(args.test_root)
        self.now = time.time()
        self.run_id = args.run_id or time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + "-" + "".join(
            random.choices(string.ascii_lowercase + string.digits, k=6))
        os.makedirs(cfg["log_dir"], exist_ok=True)
        self.log_path = args.log or os.path.join(cfg["log_dir"], f"{self.run_id}.jsonl")
        self.summary_path = args.summary or os.path.join(cfg["log_dir"], f"{self.run_id}.summary.json")
        self.log = open(self.log_path, "a")
        self.deleted = 0
        self.ceiling = args.max_delete_bytes if args.max_delete_bytes is not None else cfg["max_delete_bytes"]
        self.ceiling_hit = False
        self.partial = False
        self.counts = {}
        self.per_laptop = {}

    def row(self, pass_, path, decision, bytes_=0, last_used=None, reasons=(), checks=None, laptop=None, repo=None):
        r = {"ts": utc(time.time()), "run_id": self.run_id, "mode": "live" if self.live else "dry", "pass": pass_,
             "laptop_id": laptop, "repo": repo, "host_path": path, "bytes": int(bytes_), "last_used": utc(last_used),
             "decision": decision, "reasons": list(reasons), "checks": checks or {}}
        self.log.write(json.dumps(r) + "\n")
        self.log.flush()
        self.counts[decision] = self.counts.get(decision, 0) + 1
        if laptop:
            pl = self.per_laptop.setdefault(laptop, {})
            pl[decision] = pl.get(decision, 0) + int(bytes_)

    def lease_dirs_for(self, laptop):
        if laptop is None:
            return list(self.cfg["host_lease_dirs"])
        tmpl = self.cfg["lease_dir_template"]
        if "{home}" in tmpl and not laptop["home"]:
            return [None] + list(self.cfg["host_lease_dirs"])
        d = tmpl.format(laptop=laptop["folder"], home=laptop["home"] or "")
        return [d] + list(self.cfg["host_lease_dirs"])  # a missing dir is UNKNOWN in the library (fail closed)

    def process(self, pass_, cand, stop, lease_dirs, laptop_id=None, repo=None, exclude_top=(), trusted=None,
                root_dev=None):
        """Evaluate one candidate; in live mode delete it inside the lease library's janitor() (all applicable
        barriers EX, every matching lease EX, held through the delete). Returns bytes (deleted or would-delete).
        `trusted` is a host-controlled base the delete descends from; `root_dev` the filesystem it must stay on."""
        if self.deleted >= self.ceiling:
            self.ceiling_hit = True
            self.row(pass_, cand, "STOPPED_CEILING", laptop=laptop_id, repo=repo)
            return 0
        walk = Walk(cand, exclude_top)
        if self.deleted + walk.bytes > self.ceiling:
            self.ceiling_hit = True
            self.row(pass_, cand, "STOPPED_CEILING", walk.bytes, walk.newest, laptop=laptop_id, repo=repo)
            return 0
        reasons, checks = evaluate(cand, stop, walk, self.proc, self.cfg, self.now)
        if None in lease_dirs:
            reasons = sorted(set(reasons) | {"lease_unknown"}, key=REASON_ORDER.index)
        if reasons:
            self.row(pass_, cand, "SKIP", walk.bytes, walk.newest, reasons, checks, laptop_id, repo)
            return 0
        lib = self.lease
        try:
            with lib.janitor(cand, stop, bases=lease_dirs):
                checks["lease"] = "free"
                if not self.live:
                    self.row(pass_, cand, "WOULD_DELETE", walk.bytes, walk.newest, (), checks, laptop_id, repo)
                    self.deleted += walk.bytes
                    return walk.bytes
                proc = proc_scan(self.test)  # fresh, under the barriers and leases
                walk = Walk(cand, exclude_top)
                reasons, checks = evaluate(cand, stop, walk, proc, self.cfg, time.time())
                checks["lease"] = "free"
                if reasons:
                    self.row(pass_, cand, "SKIP", walk.bytes, walk.newest, reasons, checks, laptop_id, repo)
                    return 0
                try:
                    parts, expected = chain_inodes(trusted, cand)
                    if expected[-1] != getattr(walk, "root_id", None):
                        raise DeleteError("candidate is not the tree that was checked")
                except (OSError, DeleteError):
                    self.row(pass_, cand, "SKIP", walk.bytes, walk.newest, ["symlink_path"], checks, laptop_id, repo)
                    return 0
                deadline = time.monotonic() + self.cfg["max_delete_seconds"]
                try:
                    freed = delete_tree(trusted, root_dev, parts, expected, exclude_top, deadline)
                except (OSError, DeleteError) as e:
                    self.partial = True
                    self.row(pass_, cand, "PARTIAL", walk.bytes, walk.newest, [f"error:{e.__class__.__name__}"],
                             checks, laptop_id, repo)
                    return 0
        except (lib.LeaseError, OSError) as e:
            checks["lease"] = "refused"
            self.row(pass_, cand, "SKIP", walk.bytes, walk.newest, lease_reasons(lib, e), checks, laptop_id, repo)
            return 0
        self.deleted += freed
        self.row(pass_, cand, "DELETED", freed, walk.newest, (), checks, laptop_id, repo)
        return freed

    # ---------------------------------------------------------------- high-water
    def pass_high_water(self, laptops):
        b = self.cfg["b_mount"]
        override = self.args.test_df_pct
        pct = disk_pct(b, override)
        if pct < self.cfg["high_water_pct"]:
            self.row("high-water", b, "REPORT", reasons=[f"below_high_water:{pct:.1f}"])
            return
        cands = []
        for lap in laptops:
            proj = os.path.join(lap["folder"], "tmp", "reverie", "projects")
            for h in sorted(os.listdir(proj)) if os.path.isdir(proj) else []:
                for kind in CANDIDATE_KINDS:
                    p = os.path.join(proj, h, kind)
                    if os.path.lexists(p):
                        cands.append((lap, p, os.path.join(lap["folder"])))
            cb = os.path.join(lap["folder"], "tmp", "reverie", "cargo-build")
            for h in sorted(os.listdir(cb)) if os.path.isdir(cb) else []:
                cands.append((lap, os.path.join(cb, h), lap["folder"]))
            for legacy in ("build", "cache"):
                p = os.path.join(lap["folder"], legacy)
                if os.path.lexists(p):
                    cands.append((lap, p, lap["folder"]))
        scored = []
        for lap, p, stop in cands:
            if os.path.islink(p) or symlink_in_path(p, stop):
                self.row("high-water", p, "SKIP", reasons=["symlink_path"], laptop=lap["id"])
                continue
            scored.append((Walk(p, NEVER_DELETE_NAMES).newest, lap, p, stop))
        scored.sort(key=lambda t: t[0])  # least recently used first
        removed = 0
        b_dev = os.stat(b).st_dev
        for _, lap, p, stop in scored:
            if disk_pct(b, override, removed) < self.cfg["low_water_pct"]:
                break
            removed += self.process("high-water", p, stop, self.lease_dirs_for(lap), lap["id"], exclude_top=NEVER_DELETE_NAMES,
                                    trusted=lap["folder"], root_dev=b_dev)

    # ---------------------------------------------------------------- checkouts
    def find_checkouts(self):
        found = []
        for root in self.cfg["checkout_roots"]:
            stack = [(root, 0)]
            while stack:
                d, depth = stack.pop()
                try:
                    entries = list(os.scandir(d))
                except OSError:
                    continue
                if any(e.name == ".git" for e in entries):
                    found.append((root, d))
                    continue
                if depth < self.cfg["checkout_max_depth"]:
                    stack += [(e.path, depth + 1) for e in entries if e.is_dir(follow_symlinks=False)]
        return sorted(found)

    @staticmethod
    def repo_id(co):
        """owner/repo from origin, None if there is none, False if git can't be run safely for this checkout."""
        r = run_git(co, ["config", "--get", "remote.origin.url"])
        if r is None:
            return False
        url = r.stdout.strip()
        if not url:
            return None
        url = url.rstrip("/")
        if url.endswith(".git"):
            url = url[:-4]
        url = url.replace(":", "/")
        parts = [p for p in url.split("/") if p]
        return "/".join(parts[-2:]) if len(parts) >= 2 else None

    @staticmethod
    def parse_paths(text):
        """Entries of a .prune-paths/registry file, or raise ValueError on any bad entry (whole file rejected)."""
        out = []
        for raw in text.splitlines():
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            segs = line.rstrip("/").split("/")
            if line.startswith("/") or "**" in line or any(s in ("", ".", "..") for s in segs):
                raise ValueError(f"bad entry {line!r}")
            out.append("/".join(segs))
        return out

    def expand(self, co, entry):
        cur = [co]
        for seg in entry.split("/"):
            nxt = []
            for c in cur:
                try:
                    names = sorted(os.listdir(c))
                except OSError:
                    continue
                for n in names:
                    if fnmatch.fnmatchcase(n, seg):
                        nxt.append(os.path.join(c, n))
            cur = nxt
        return cur

    @staticmethod
    def git_valid(co, path):
        rel = os.path.relpath(path, co)
        ign = run_git(co, ["check-ignore", "-q", "--", rel])
        if ign is None or ign.returncode != 0:
            return False
        tracked = run_git(co, ["ls-files", "--", rel])
        return tracked is not None and tracked.returncode == 0 and tracked.stdout.strip() == ""

    def checkout_idle(self, co, outputs):
        limit = self.now - self.cfg["idle_days"] * DAY
        skip = {os.path.normpath(p) for p in outputs} | {os.path.join(co, ".git")}
        for d, dirs, files in os.walk(co):
            dirs[:] = [x for x in dirs if os.path.join(d, x) not in skip]
            for n in files + dirs:
                try:
                    if os.lstat(os.path.join(d, n)).st_mtime > limit:
                        return False
                except OSError:
                    return False
        return True

    def pass_checkouts(self, laptops):
        all_lease_dirs = list(self.cfg["host_lease_dirs"])
        for lap in laptops:
            all_lease_dirs += [d for d in self.lease_dirs_for(lap) if d not in all_lease_dirs]
        for co_root, co in self.find_checkouts():
            repo = self.repo_id(co)
            if repo is False:
                self.row("checkouts", co, "SKIP", reasons=["git_unsafe"])
                continue
            reg = os.path.join(self.cfg["registry_dir"], *(repo or "-/-").split("/")) + ".paths"
            if not repo or not os.path.isfile(reg):
                self.row("checkouts", co, "NOT_REGISTERED", repo=repo)
                continue
            try:
                entries = self.parse_paths(open(reg).read())
            except (ValueError, OSError) as e:
                self.row("checkouts", co, "SKIP", reasons=["registry_invalid"], repo=repo,
                         checks={"error": str(e)[:80]})
                continue
            own = os.path.join(co, ".prune-paths")
            if os.path.lexists(own):
                try:
                    mine = self.parse_paths(open(own).read()) if not os.path.islink(own) else None
                except (ValueError, OSError):
                    mine = None
                if mine is None:
                    self.row("checkouts", co, "SKIP", reasons=["registry_invalid"], repo=repo,
                             checks={"error": "checkout .prune-paths invalid"})
                    continue
                for extra in sorted(set(mine) - set(entries)):
                    self.row("checkouts", os.path.join(co, extra), "WIDEN_REFUSED", repo=repo)
                entries = [e for e in entries if e in mine]
            matched = []
            for e in entries:
                for p in self.expand(co, e):
                    if os.path.islink(p) or symlink_in_path(p, co) or not os.path.isdir(p):
                        self.row("checkouts", p, "SKIP", reasons=["symlink_path"], repo=repo)
                    elif not self.git_valid(co, p):
                        self.row("checkouts", p, "SKIP", reasons=["registry_invalid"], repo=repo)
                    else:
                        matched.append(p)
            if not matched:
                continue
            if not self.checkout_idle(co, matched):
                for p in matched:
                    self.row("checkouts", p, "SKIP", reasons=["not_idle"], repo=repo)
                continue
            root_dev = os.stat(co_root).st_dev
            for p in matched:
                self.process("checkouts", p, co, all_lease_dirs, repo=repo, trusted=co_root, root_dev=root_dev)

    # ---------------------------------------------------------------- retired
    def pass_retired(self, laptops):
        base = os.path.join(self.cfg["b_mount"], self.cfg["laptops_root"])
        parent = os.path.dirname(base)
        running = {os.path.basename(base)}
        mounted_roots, unknown = set(), False
        for lap in laptops:
            if lap["init_pid"] is None:
                continue
            try:
                with open(f"/proc/{lap['init_pid']}/mountinfo") as f:
                    for line in f:
                        mounted_roots.add(line.split()[3])
            except OSError:
                unknown = True
        if not self.test and not os.path.ismount(self.cfg["b_mount"]):
            unknown = True  # mountinfo roots are relative to the filesystem root, which must be b_mount
        if unknown:
            self.row("retired", parent, "REPORT", reasons=["RETIRED_UNKNOWN"])
            return
        for n in sorted(os.listdir(parent)) if os.path.isdir(parent) else []:
            p = os.path.join(parent, n)
            if n in running or os.path.islink(p) or not os.path.isdir(p):
                continue
            rel = "/" + os.path.relpath(p, self.cfg["b_mount"])
            if any(m == rel or m.startswith(rel + "/") for m in mounted_roots):
                continue
            w = Walk(p)
            self.row("retired", p, "REPORT", w.bytes, w.newest, ["retired_candidate"])

    # ---------------------------------------------------------------- long-held leases
    def report_long_held(self, laptops):
        dirs = list(self.cfg["host_lease_dirs"])
        for lap in laptops:
            dirs += [d for d in self.lease_dirs_for(lap) if d]
        for p in long_held(dirs, self.cfg["lease_report_days"]):
            self.row("leases", p, "LEASE_LONG_HELD")

    def summary(self, passes, df_before, exit_code):
        s = {"run_id": self.run_id, "mode": "live" if self.live else "dry", "passes": passes,
             "df_before": df_before, "df_after": [df_row(r["path"]) for r in df_before],
             "deleted_or_would_bytes": self.deleted, "by_decision": self.counts, "by_laptop": self.per_laptop,
             "ceiling_bytes": self.ceiling, "ceiling_hit": self.ceiling_hit, "exit": exit_code}
        with open(self.summary_path, "w") as f:
            json.dump(s, f, indent=1)


def main(argv=None):
    ap = argparse.ArgumentParser(prog="reverie-prune")
    ap.add_argument("--config", default="/etc/reverie/prune.toml")
    ap.add_argument("--pass", dest="passes", default="all", choices=["high-water", "checkouts", "retired", "all"])
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--dry-run", action="store_true")
    g.add_argument("--live", action="store_true")
    ap.add_argument("--max-delete-bytes", type=int)
    ap.add_argument("--run-id")
    ap.add_argument("--log")
    ap.add_argument("--summary")
    ap.add_argument("--test-root")
    ap.add_argument("--test-df-pct", type=float)
    ap.add_argument("--test-laptops")
    args = ap.parse_args(argv)
    if (args.test_df_pct is not None or args.test_laptops) and not args.test_root:
        print("reverie-prune: --test-df-pct and --test-laptops need --test-root", file=sys.stderr)
        return EXIT_CONFIG
    try:
        cfg = load_config(args.config, args.test_root)
    except ConfigError as e:
        print(f"reverie-prune: {e}", file=sys.stderr)
        return EXIT_CONFIG
    if args.live and not cfg["live_enabled"]:
        print("reverie-prune: --live refused: live_enabled is false in the config", file=sys.stderr)
        return EXIT_LIVE_REFUSED
    if not args.test_root and os.geteuid() != 0:
        print("reverie-prune: must run as root on the host (or under --test-root)", file=sys.stderr)
        return EXIT_CONFIG
    if args.passes in ("checkouts", "all"):
        for co_root in cfg["checkout_roots"]:
            if not os.path.isdir(co_root):
                print(f"reverie-prune: checkout root {co_root} missing", file=sys.stderr)
                return EXIT_CONFIG
    try:
        regs = []
        if os.path.isdir(cfg["registry_dir"]):
            for d, _, files in os.walk(cfg["registry_dir"]):
                regs += [os.path.join(d, f) for f in files if f.endswith(".paths")]
    except OSError as e:
        print(f"reverie-prune: registry: {e}", file=sys.stderr)
        return EXIT_CONFIG
    os.makedirs(os.path.dirname(cfg["lock_path"]), exist_ok=True)
    lock_fd = os.open(cfg["lock_path"], os.O_RDWR | os.O_CREAT, 0o644)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("reverie-prune: another prune is running", file=sys.stderr)
        return EXIT_BUSY
    try:
        laptops = discover_laptops(cfg, args)
    except (ConfigError, OSError, ValueError, KeyError, subprocess.SubprocessError) as e:
        print(f"reverie-prune: {e}", file=sys.stderr)
        return EXIT_CONFIG
    try:
        lease_lib = load_lease_lib(cfg["lease_lib"], bool(args.test_root))
    except (ConfigError, OSError, ImportError, SyntaxError) as e:
        print(f"reverie-prune: {e}", file=sys.stderr)
        return EXIT_CONFIG
    run = Run(cfg, args)
    run.lease = lease_lib
    run.proc = proc_scan(run.test)
    passes = ["high-water", "checkouts", "retired"] if args.passes == "all" else [args.passes]
    df_before = [df_row(cfg["b_mount"])]
    if "checkouts" in passes:
        df_before += [df_row(r) for r in cfg["checkout_roots"]]
    for p in passes:
        getattr(run, "pass_" + p.replace("-", "_"))(laptops)
    run.report_long_held(laptops)
    code = EXIT_PARTIAL if run.partial else EXIT_OK
    run.summary(passes, df_before, code)
    run.log.close()
    return code


if __name__ == "__main__":
    sys.exit(main())
