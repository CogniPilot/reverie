#!/usr/bin/env python3
"""reverie-collect (roadmap H1): a generic host resource collector. One sample per run; drive it with a timer.

  python3 -I reverie_collect.py --config /etc/reverie/collect.toml once

r2 (Kit's H1-1..3): committed output is the source of truth, so a failed checkpoint never duplicates anything; dry-run
estimates and live deletions are separate counters; every joined input is size-bounded and schema-checked, and each
reading fails on its own into an explicit error instead of aborting the sample or inventing a value.

Files in out_dir (append-only JSONL, strict JSON, one record per line):
  samples-YYYY-MM-DD.jsonl   one line per run (UTC day). A superset of the interim status feed
                             {t, cpu_pct, mem_pct, gpu_pct, drives{name:{used_pct, free}}}, plus v, label, interval_s,
                             cpu{...}, mem{...}, gpu{status ok|unavailable|error, source, devices}, drives.<n>{total, used}
                             or {status: error}, prune [the prune-runs records first committed by this sample], prune_errors [...],
                             errors {component: reason} for any reading that failed (its value is then null).
  prune-runs.jsonl           one line per reverie-prune run, keyed by run_id, the AUTHORITATIVE join:
                             {run_id, committed_t, mode dry|live, status ok|partial|failed, exit, passes,
                              would_delete_bytes (dry runs), deleted_bytes (live runs), by_decision, ceiling_hit}
                             A dry run never contributes deleted_bytes; a live run never contributes would_delete_bytes.
  rollup-hour-YYYY-MM.jsonl, rollup-day-YYYY.jsonl
                             one line per CLOSED period, written only if that period's start isn't already in the file.
Recovery: a truncated last line (crash mid-write) is ended with a newline before the next append and is skipped by
readers (counted as malformed). state.json is only a cache of cursors (CPU counters, rollup cursor); losing it never
duplicates output, because prune runs and periods are checked against the files themselves.
Exit: 0 sampled; 2 config error; 5 another run holds the lock."""
import argparse
import calendar
import fcntl
import json
import math
import os
import re
import select
import shutil
import signal
import stat
import subprocess
import sys
import time
import tomllib

DEFAULTS = {
    "out_dir": "/var/lib/reverie/collect",
    "label": None,
    "interval_s": 300,
    "retention_days": 30,
    "rollup_retention_days": 400,
    "drives": {},
    "prune_log_dir": "",
    "gpu": "auto",
    "nvidia_smi": "nvidia-smi",
    "max_input_bytes": 1 << 20,          # any one joined summary, /proc file or subprocess output
    "max_prune_join": 50,                # new prune runs joined per sample; the rest wait for the next sample
    "max_file_bytes": 64 << 20,          # any one history file read back for rollups or dedup
    "proc_root": "/proc",
    "sys_root": "/sys",
}
SAMPLE_RE = re.compile(r"^samples-(\d{4})-(\d{2})-(\d{2})\.jsonl$")
ROLLUP_RE = re.compile(r"^rollup-(hour-(\d{4})-(\d{2})|day-(\d{4}))\.jsonl$")
RUN_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
NVIDIA_UUID_RE = re.compile(r"GPU-[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\Z")
EXIT_OK, EXIT_CONFIG, EXIT_BUSY = 0, 2, 5


class ConfigError(Exception):
    pass


class InputError(Exception):
    pass


def load_config(path):
    try:
        with open(path, "rb") as f:
            raw = tomllib.load(f)
    except (OSError, tomllib.TOMLDecodeError) as e:
        raise ConfigError(f"config: {e}")
    unknown = set(raw) - set(DEFAULTS)
    if unknown:
        raise ConfigError(f"config: unknown keys {sorted(unknown)}")
    cfg = {**DEFAULTS, **raw}
    if not isinstance(cfg["drives"], dict) or not all(isinstance(v, str) for v in cfg["drives"].values()):
        raise ConfigError("config: drives must be a table of name = path")
    for k in ("interval_s", "retention_days", "rollup_retention_days", "max_input_bytes", "max_prune_join",
              "max_file_bytes"):
        if not isinstance(cfg[k], int) or isinstance(cfg[k], bool) or cfg[k] <= 0:
            raise ConfigError(f"config: {k} must be a positive integer")
    if cfg["gpu"] not in ("auto", "off"):
        raise ConfigError("config: gpu must be auto or off")
    return cfg


# ------------------------------------------------------------------------------------------------ bounded input
def read_small(path, limit):
    """Read a regular file (no symlink) of at most LIMIT bytes, or raise InputError."""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise InputError("not a regular file")
        chunks, total = [], 0
        while True:
            b = os.read(fd, min(1 << 20, limit + 1 - total))
            if not b:
                break
            chunks.append(b); total += len(b)
            if total > limit:
                raise InputError(f"over {limit} bytes")
    finally:
        os.close(fd)
    return b"".join(chunks).decode("utf-8", errors="replace")


def run_capped(argv, limit, timeout=10):
    """stdout of ARGV, at most LIMIT bytes, within ONE monotonic deadline covering both reading and exit (Kit R2-1).
    On timeout, oversize or error the child's whole session is killed and reaped; stderr is discarded."""
    deadline = time.monotonic() + timeout
    p = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
    fd, chunks, total, ok = p.stdout.fileno(), [], 0, False
    try:
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                raise InputError(f"no result within {timeout} s")
            ready, _, _ = select.select([fd], [], [], left)
            if not ready:
                continue                                    # loop re-checks the deadline
            b = os.read(fd, 65536)
            if not b:
                break                                       # EOF: stdout closed
            chunks.append(b); total += len(b)
            if total > limit:
                raise InputError(f"output over {limit} bytes")
        left = deadline - time.monotonic()
        try:
            rc = p.wait(timeout=max(left, 0.001))
        except subprocess.TimeoutExpired:
            raise InputError(f"no exit within {timeout} s")
        if rc != 0:
            raise InputError(f"exit {rc}")
        ok = True
        return b"".join(chunks).decode("utf-8", errors="replace")
    finally:
        if not ok or p.poll() is None:
            try:
                os.killpg(p.pid, signal.SIGKILL)            # the session, including descendants holding the pipe
            except (ProcessLookupError, PermissionError):
                pass
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
        p.stdout.close()


def finite(x, lo=None, hi=None):
    if isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x):
        return False
    return (lo is None or x >= lo) and (hi is None or x <= hi)


# ------------------------------------------------------------------------------------------------ readings
def cpu_times(cfg):
    text = read_small(os.path.join(cfg["proc_root"], "stat"), cfg["max_input_bytes"])
    first = text.split("\n", 1)[0].split()
    if not first or first[0] != "cpu" or len(first) < 5:
        raise InputError("unexpected /proc/stat")
    vals = [int(x) for x in first[1:]]
    cores = sum(1 for line in text.splitlines() if re.match(r"cpu\d+ ", line))
    return (sum(vals[:8]), vals[3] + (vals[4] if len(vals) > 4 else 0)), cores


def cpu_pct(prev, cur):
    total, idle = cur[0] - prev[0], cur[1] - prev[1]
    return round(100.0 * (total - idle) / total, 2) if total > 0 and 0 <= idle <= total else None


def loadavg(cfg):
    parts = read_small(os.path.join(cfg["proc_root"], "loadavg"), cfg["max_input_bytes"]).split()
    l1, l5, l15 = (float(x) for x in parts[:3])
    if not all(finite(v, 0) for v in (l1, l5, l15)):
        raise InputError("bad loadavg")
    return {"load1": l1, "load5": l5, "load15": l15}


def memory(cfg):
    info = {}
    for line in read_small(os.path.join(cfg["proc_root"], "meminfo"), cfg["max_input_bytes"]).splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            if v.split() and v.split()[0].isdigit():
                info[k] = int(v.split()[0]) * 1024
    total, avail = info.get("MemTotal"), info.get("MemAvailable", info.get("MemFree"))
    if not total or avail is None or not 0 <= avail <= total:
        raise InputError("bad meminfo")
    return round(100.0 * (total - avail) / total, 2), {"total": total, "available": avail}


def drive(path):
    try:
        vf = os.statvfs(path)
    except OSError as e:
        return {"status": "error", "error": e.__class__.__name__}
    used = (vf.f_blocks - vf.f_bfree) * vf.f_frsize
    avail = vf.f_bavail * vf.f_frsize
    denom = used + avail
    return {"used_pct": round(100.0 * used / denom, 2) if denom else None, "free": avail,
            "total": vf.f_blocks * vf.f_frsize, "used": used}


def gpus(cfg):
    if cfg["gpu"] == "off":
        return None, {"status": "unavailable", "source": "off", "devices": []}
    exe = shutil.which(cfg["nvidia_smi"])
    if exe:
        try:
            out = run_capped([exe, "--query-gpu=index,utilization.gpu,memory.used,memory.total,uuid",
                              "--format=csv,noheader,nounits"], cfg["max_input_bytes"])
            devs, identities = [], {}
            rows = out.strip().splitlines()
            for line in rows[:64]:
                fields = [x.strip() for x in line.split(",")]
                if len(fields) not in (4, 5):
                    raise InputError("unexpected GPU reading")
                i, u, mu, mt = fields[:4]
                identity = fields[4] if len(fields) == 5 else ""
                if NVIDIA_UUID_RE.fullmatch(identity):
                    identity = "GPU-" + identity[4:].lower()
                    identities[identity] = identities.get(identity, 0) + 1
                    identity_status = "available"
                else:
                    identity_status = "unavailable" if identity in ("", "N/A", "[Not Supported]") else "invalid"
                    identity = None
                d = {"index": int(i), "util_pct": float(u), "mem_used_mib": float(mu), "mem_total_mib": float(mt),
                     "uuid": identity, "identity_status": identity_status}
                if finite(d["util_pct"], 0, 100) and finite(d["mem_used_mib"], 0) and finite(d["mem_total_mib"], 0):
                    devs.append(d)
            # Never preserve one arbitrary member of a duplicate identity set.
            # A capped listing cannot establish uniqueness across omitted rows.
            for d in devs:
                if len(rows) > 64:
                    d["uuid"], d["identity_status"] = None, "incomplete"
                elif d["uuid"] and identities[d["uuid"]] > 1:
                    d["uuid"], d["identity_status"] = None, "duplicate"
            if devs:
                return round(sum(d["util_pct"] for d in devs) / len(devs), 2), {"status": "ok", "source": "nvidia-smi",
                                                                                 "devices": devs}
        except (OSError, ValueError, InputError, subprocess.SubprocessError):
            pass
    devs = []
    drm = os.path.join(cfg["sys_root"], "class", "drm")
    for card in sorted(os.listdir(drm))[:64] if os.path.isdir(drm) else []:
        p = os.path.join(drm, card, "device", "gpu_busy_percent")
        if re.fullmatch(r"card\d+", card) and os.path.isfile(p):
            try:
                u = float(read_small(p, 64).strip())
                if finite(u, 0, 100):
                    devs.append({"index": int(card[4:]), "util_pct": u,
                                 "uuid": None, "identity_status": "unavailable"})
            except (OSError, ValueError, InputError):
                pass
    if devs:
        return round(sum(d["util_pct"] for d in devs) / len(devs), 2), {"status": "ok", "source": "sysfs", "devices": devs}
    return None, {"status": "unavailable", "source": "none", "devices": []}


def validate_summary(s, name):
    """A reverie-prune summary -> a prune-runs record (without committed_t), or raise InputError."""
    if not isinstance(s, dict):
        raise InputError("not an object")
    rid = s.get("run_id") if s.get("run_id") is not None else name
    if not isinstance(rid, str) or not RUN_ID_RE.match(rid):
        raise InputError("bad run_id")
    mode = s.get("mode")
    if mode not in ("dry", "live"):
        raise InputError("bad mode")
    ex = s.get("exit")
    if isinstance(ex, bool) or not isinstance(ex, int):
        raise InputError("bad exit")
    nbytes = s.get("deleted_or_would_bytes", 0)
    if not finite(nbytes, 0) or nbytes != int(nbytes):
        raise InputError("bad byte count")
    bd = s.get("by_decision", {})
    if not isinstance(bd, dict) or len(bd) > 64 or not all(
            isinstance(k, str) and len(k) <= 64 and finite(v, 0) and v == int(v) for k, v in bd.items()):
        raise InputError("bad by_decision")
    passes = s.get("passes", [])
    if not isinstance(passes, list) or len(passes) > 8 or not all(isinstance(p, str) and len(p) <= 32 for p in passes):
        raise InputError("bad passes")
    ceiling = s.get("ceiling_hit", False)
    if not isinstance(ceiling, bool):
        raise InputError("bad ceiling_hit")
    status = "ok" if ex == 0 else "partial" if ex == 4 else "failed"
    return {"run_id": rid, "mode": mode, "status": status, "exit": ex, "passes": passes,
            "would_delete_bytes": int(nbytes) if mode == "dry" else 0,     # an estimate, never reclaimed space
            "deleted_bytes": int(nbytes) if mode == "live" else 0,         # what a live run reports it freed
            "by_decision": {k: int(v) for k, v in bd.items()}, "ceiling_hit": ceiling}


def new_prune_runs(cfg, committed):
    """(records, errors, backlog): summaries in prune_log_dir whose run id is not yet committed, at most max_prune_join."""
    log_dir = cfg["prune_log_dir"]
    if not log_dir or not os.path.isdir(log_dir):
        return [], [], 0
    recs, errs, backlog = [], [], 0
    for n in sorted(os.listdir(log_dir)):
        if not n.endswith(".summary.json"):
            continue
        stem = n[:-len(".summary.json")]
        if stem in committed:
            continue
        try:
            rec = validate_summary(json.loads(read_small(os.path.join(log_dir, n), cfg["max_input_bytes"])), stem)
        except (OSError, ValueError, InputError) as e:
            if len(errs) < 20:
                errs.append({"file": n[:200], "reason": str(e)[:120] or e.__class__.__name__})
            continue
        if rec["run_id"] in committed or any(r["run_id"] == rec["run_id"] for r in recs):
            continue
        if len(recs) >= cfg["max_prune_join"]:
            backlog += 1
            continue
        recs.append(rec)
    return recs, errs, backlog


# ------------------------------------------------------------------------------------------------ files
def dump(obj):
    return json.dumps(obj, separators=(",", ":"), sort_keys=True, allow_nan=False)


def append_line(path, obj):
    """Append one record; if a crash left a truncated last line, end it first so records never run together."""
    line = (dump(obj) + "\n").encode()
    fd = os.open(path, os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o644)
    try:
        size = os.fstat(fd).st_size
        if size and os.pread(fd, 1, size - 1) != b"\n":
            os.write(fd, b"\n")
        os.write(fd, line)
        os.fsync(fd)
    finally:
        os.close(fd)


def read_lines(path, cfg=None):
    """The records of a history file (r1-compatible list); malformed or truncated lines are skipped."""
    return read_lines_counted(path, cfg)[0]


def read_lines_counted(path, cfg=None):
    """(records, malformed): a history file, bounded by max_file_bytes; malformed or truncated lines are skipped."""
    try:
        text = read_small(path, (cfg or DEFAULTS)["max_file_bytes"])
    except FileNotFoundError:
        return [], 0
    except (OSError, InputError):
        return [], 1                                       # a symlink, non-regular or oversize file: unread, counted
    recs, bad = [], 0
    for line in text.splitlines():
        if not line.strip():
            continue
        try:
            r = json.loads(line)
            if isinstance(r, dict):
                recs.append(r); continue
        except ValueError:
            pass
        bad += 1
    return recs, bad


def ledger(path, cfg):
    """(state, records) for prune-runs.jsonl: "missing" (a genuinely new ledger), "ok", or "unavailable" when the file
    exists but can't be read within bounds (symlink, non-regular, oversize, I/O error). Kit R3-1: an unavailable ledger
    is NEVER treated as an empty committed set; the caller then skips the prune join and its accounting."""
    if not os.path.lexists(path):
        return "missing", [], 0
    try:
        text = read_small(path, cfg["max_file_bytes"])
    except (OSError, InputError):
        return "unavailable", [], 0
    recs, bad = [], 0
    for line in text.splitlines():
        if line.strip():
            try:
                r = json.loads(line)
            except ValueError:
                bad += 1
                continue                                   # a crash-truncated record was never committed
            if isinstance(r, dict):
                recs.append(r)
            else:
                bad += 1
    return "ok", recs, bad


def write_state(path, state):
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW | os.O_CLOEXEC, 0o644)
    try:
        os.write(fd, dump(state).encode())
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(tmp, path)
    dfd = os.open(os.path.dirname(path), os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(dfd)
    finally:
        os.close(dfd)


def day_file(out, t):
    return os.path.join(out, time.strftime("samples-%Y-%m-%d.jsonl", time.gmtime(t)))


def agg(vals):
    vals = [v for v in vals if finite(v)]
    return {"min": min(vals), "avg": round(sum(vals) / len(vals), 2), "max": max(vals), "n": len(vals)} if vals else None


def run_bytes(r):
    """(dry would-delete estimate, live deleted bytes) of a prune record; also accepts an r1-shaped summary."""
    mode = r.get("mode")
    raw = r.get("deleted_or_would_bytes", 0)
    would = r.get("would_delete_bytes", raw if mode == "dry" else 0)
    deleted = r.get("deleted_bytes", raw if mode == "live" else 0)
    return (would if mode == "dry" and finite(would, 0) else 0), (deleted if mode == "live" and finite(deleted, 0) else 0)


def rollup(samples, start, length, kind, runs=None, prune_ok=True):
    win = [s for s in samples if finite(s.get("t")) and start <= s["t"] < start + length]
    if not win:
        return None
    drives = {}
    for n in sorted({n for s in win for n in (s.get("drives") or {})}):
        rows = [s["drives"][n] for s in win if finite((s.get("drives") or {}).get(n, {}).get("used_pct"))]
        if rows:
            drives[n] = {"used_pct": agg([r["used_pct"] for r in rows]), "free_last": rows[-1].get("free"),
                         "free_min": min(r.get("free", 0) for r in rows)}
    if runs is None:                                       # derive from the samples' committed records
        runs = [{**r, "committed_t": s["t"]} for s in win for r in (s.get("prune") or []) if isinstance(r, dict)]
    pr = [r for r in runs if finite(r.get("committed_t")) and start <= r["committed_t"] < start + length]
    if not prune_ok:                                       # Kit R3-1: unknown, never a fabricated zero
        return {"v": 2, "kind": kind, "start": start, "end": start + length, "samples": len(win),
                "cpu_pct": agg([s.get("cpu_pct") for s in win]), "mem_pct": agg([s.get("mem_pct") for s in win]),
                "gpu_pct": agg([s.get("gpu_pct") for s in win]), "drives": drives, "prune_unavailable": True,
                "prune_runs_dry": None, "prune_runs_live": None, "prune_runs_partial": None, "prune_runs_failed": None,
                "prune_bytes_by_mode": None, "prune_bytes": None}
    return {"v": 2, "kind": kind, "start": start, "end": start + length, "samples": len(win),
            "cpu_pct": agg([s.get("cpu_pct") for s in win]), "mem_pct": agg([s.get("mem_pct") for s in win]),
            "gpu_pct": agg([s.get("gpu_pct") for s in win]), "drives": drives,
            "prune_runs_dry": sum(1 for r in pr if r.get("mode") == "dry"),
            "prune_runs_live": sum(1 for r in pr if r.get("mode") == "live"),
            "prune_runs_partial": sum(1 for r in pr if r.get("status") == "partial"),
            "prune_runs_failed": sum(1 for r in pr if r.get("status") == "failed"),
            # Never one undifferentiated total: a dry-run estimate is not reclaimed space (Kit H1-2).
            "prune_bytes_by_mode": {"dry_would_delete": sum(run_bytes(r)[0] for r in pr),
                                    "live_deleted": sum(run_bytes(r)[1] for r in pr)},
            "prune_bytes": sum(run_bytes(r)[1] for r in pr)}       # r1 name, now LIVE deletions only (never estimates)


def last_rolled(out, cfg, name, cur, length):
    """Where to resume rolling when there is no usable cursor: after the newest committed period in this or the
    previous rollup file; or, if none was ever committed, at the period holding the EARLIEST retained valid sample
    (Kit R2-2: never silently start history at now while earlier committed samples exist); else CUR."""
    ends = []
    for t in (cur, cur - 32 * 86400 if length == 3600 else cur - 366 * 86400):
        ends += [r.get("end") for r in read_lines(os.path.join(out, time.strftime(name, time.gmtime(t))), cfg)]
    ends = [e for e in ends if finite(e) and e <= cur]
    if ends:
        return int(max(ends))
    for n in sorted(n for n in os.listdir(out) if SAMPLE_RE.match(n)):   # oldest day file first
        ts = [r.get("t") for r in read_lines(os.path.join(out, n), cfg) if finite(r.get("t"))]
        if ts:
            return int(min(min(ts) - min(ts) % length, cur))
    return cur


def roll(out, cfg, state, now, runs, prune_ok=True):
    """Close every complete hour and day since the cursor. A period is appended only if its start isn't in the file."""
    cache = {}                                             # day file -> records, read once per run

    def day_records(path):
        if path not in cache:
            cache[path] = read_lines(path, cfg)
        return cache[path]
    for kind, length, key, name in (("hour", 3600, "last_hour", "rollup-hour-%Y-%m.jsonl"),
                                    ("day", 86400, "last_day", "rollup-day-%Y.jsonl")):
        cur = now - now % length
        start = state.get(key)
        if not finite(start) or start > cur or start < cur - 400 * 86400:
            start = last_rolled(out, cfg, name, cur, length)   # state lost: resume after the last committed period
        start = int(start)
        while start + length <= cur:
            target = os.path.join(out, time.strftime(name, time.gmtime(start)))
            done = {r.get("start") for r in read_lines(target, cfg)}
            if start not in done:
                samples = []
                for f in sorted({day_file(out, t) for t in range(start, start + length, 3600)}):
                    samples += day_records(f)
                r = rollup(samples, start, length, kind, runs, prune_ok)
                if r:
                    append_line(target, r)
            start += length
        state[key] = start


def retention(out, cfg, now):
    removed = []
    for n in os.listdir(out):
        p = os.path.join(out, n)
        if not stat.S_ISREG(os.lstat(p).st_mode):
            continue
        m = SAMPLE_RE.match(n)
        if m:
            end = calendar.timegm((int(m[1]), int(m[2]), int(m[3]), 0, 0, 0)) + 86400
            if now - end > cfg["retention_days"] * 86400:
                os.unlink(p); removed.append(n)
            continue
        m = ROLLUP_RE.match(n)
        if m:
            y, mo = (int(m[2]), int(m[3])) if m[2] else (int(m[4]), 12)
            end = calendar.timegm((y + mo // 12, mo % 12 + 1, 1, 0, 0, 0))
            if now - end > cfg["rollup_retention_days"] * 86400:
                os.unlink(p); removed.append(n)
    return removed


# ------------------------------------------------------------------------------------------------ main
def sample_once(cfg, now=None):
    out = cfg["out_dir"]
    if os.path.islink(out):
        raise ConfigError(f"out_dir {out} must not be a symlink")
    os.makedirs(out, mode=0o755, exist_ok=True)
    lock = os.open(os.path.join(out, ".lock"), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o644)
    try:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return EXIT_BUSY, None
        state_path = os.path.join(out, "state.json")
        try:
            state = json.loads(read_small(state_path, cfg["max_input_bytes"]))
            if not isinstance(state, dict):
                state = {}
        except (OSError, ValueError, InputError):
            state = {}                                        # only cursors: output is never re-derived from it
        errors, s = {}, {"v": 2, "label": cfg["label"], "interval_s": cfg["interval_s"]}
        try:
            cur, cores = cpu_times(cfg)
            prev = state.get("cpu")
            if not (isinstance(prev, list) and len(prev) == 2 and all(finite(x, 0) for x in prev)):
                time.sleep(1)                                 # no usable cursor: measure over one second
                prev, (cur, cores) = cur, cpu_times(cfg)
            s["cpu_pct"] = cpu_pct(prev, cur)
            s["cpu"] = {"cores": cores}
            state["cpu"] = list(cur)
        except (OSError, ValueError, InputError) as e:
            s["cpu_pct"], s["cpu"], errors["cpu"] = None, None, e.__class__.__name__
        if s.get("cpu") is not None:
            try:
                s["cpu"].update(loadavg(cfg))
            except (OSError, ValueError, InputError) as e:
                errors["loadavg"] = e.__class__.__name__
        try:
            s["mem_pct"], s["mem"] = memory(cfg)
        except (OSError, ValueError, InputError) as e:
            s["mem_pct"], s["mem"], errors["mem"] = None, None, e.__class__.__name__
        try:
            s["gpu_pct"], s["gpu"] = gpus(cfg)
        except Exception as e:                               # never let a GPU probe abort the sample
            s["gpu_pct"], s["gpu"] = None, {"status": "error", "source": "none", "devices": []}
            errors["gpu"] = e.__class__.__name__
        s["drives"] = {n: drive(p) for n, p in sorted(cfg["drives"].items())}
        now = int(time.time() if now is None else now)
        s["t"] = now
        # Prune join: the committed run ids come from prune-runs.jsonl itself, never from state.
        runs_path = os.path.join(out, "prune-runs.jsonl")
        lstate, runs, bad = ledger(runs_path, cfg)
        prune_ok = lstate != "unavailable"
        committed = {r.get("run_id") for r in runs}
        recs, perr, backlog = [], [], 0
        if prune_ok:
            try:
                recs, perr, backlog = new_prune_runs(cfg, committed)
            except OSError as e:
                errors["prune"] = e.__class__.__name__
        else:
            errors["prune_runs_file"] = "ledger_unavailable: prune-runs.jsonl exists but can't be read within bounds"
            s["prune_unavailable"] = True
        for r in recs:
            r["committed_t"] = now
            append_line(runs_path, r)
            runs.append(r)
        s["prune"] = recs                                    # records first committed by this sample
        s["prune_errors"] = perr
        if backlog:
            s["prune_backlog"] = backlog
        if bad:
            errors["prune_runs_file"] = f"{bad} malformed line(s) skipped"
        if errors:
            s["errors"] = errors
        append_line(day_file(out, now), s)
        roll(out, cfg, state, now, runs, prune_ok)
        state["removed_last"] = retention(out, cfg, now)
        write_state(state_path, state)
        return EXIT_OK, s
    finally:
        os.close(lock)


def main(argv=None):
    ap = argparse.ArgumentParser(prog="reverie-collect")
    ap.add_argument("--config", default="/etc/reverie/collect.toml")
    ap.add_argument("mode", choices=["once"])
    a = ap.parse_args(argv)
    try:
        cfg = load_config(a.config)
        code, s = sample_once(cfg)
    except ConfigError as e:
        print(f"reverie-collect: {e}", file=sys.stderr)
        return EXIT_CONFIG
    if code == EXIT_BUSY:
        print("reverie-collect: another run holds the lock", file=sys.stderr)
    return code


if __name__ == "__main__":
    sys.exit(main())
