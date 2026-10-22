"""Publish the host GPUs' numbers for the console's GPU chip, ON THE HOST.

    reverie-gpu-publisher              one write
    reverie-gpu-publisher --loop 30    write every 30 s until stopped

The container has no GPU device and no nvidia-smi, so the console reads what this writes. Contract
(apps/console/docs/host-gpu.md): {"updatedAt": <epoch ms>, "gpus": [{"name", "utilization",
"memoryUsedMb", "memoryTotalMb"}]}, atomic, heartbeat 30 s, the reader treats more than 60 s as stale.

Where it writes, and why only there: ONLY under ~/.local/state/reverie/ (default published/gpu.json),
a host directory that is never bind-mounted into the container read-write; the container sees it
read-only at /host-published. An ownership check cannot tell a safe directory from an agent-writable
one: the container runs with --userns=keep-id, so files agents create in bind mounts are owned by this
same host user. So the boundary is the location. The path is walked from that base one component at a
time with O_NOFOLLOW (no symlink anywhere is followed), the temp file is created with O_EXCL|O_NOFOLLOW
and written, chmodded and synced through its descriptor, and it replaces gpu.json with renameat on the
pinned directory, which never follows a link at the destination and fails on a directory there.

Display only: nothing may decide anything from this file (the night cycle's gate is gpu-idle-check).
On any nvidia-smi problem nothing is written: the file goes stale and the chip hides.

Standard library only (runs from the verified host build, or python3 -I).
"""
from __future__ import annotations
import argparse
import json
import os
import re
import secrets
import signal
import subprocess
import sys
import time
from pathlib import Path

DEFAULT_RELATIVE = "published/gpu.json"
PART = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
QUERY = ["--query-gpu=name,utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"]
SMI_CANDIDATES = ("/run/current-system/sw/bin/nvidia-smi", "/usr/bin/nvidia-smi")
SMI_TIMEOUT = 5


class Refused(Exception):
    """A configuration or filesystem state the publisher will not write into."""


def state_base(home=None):
    return Path(home or os.path.expanduser("~")) / ".local" / "state" / "reverie"


def parse(output):
    """GPU entries from nvidia-smi CSV, or None when any line is unreadable (fail closed: write nothing)."""
    gpus = []
    for line in output.splitlines():
        if not line.strip(): continue
        fields = line.rsplit(",", 3)                       # the name may contain commas; the numbers never do
        if len(fields) != 4: return None
        name, util, used, total = (f.strip() for f in fields)
        if not (re.fullmatch(r"\d{1,3}", util) and re.fullmatch(r"\d{1,7}", used) and re.fullmatch(r"[1-9]\d{0,6}", total)):
            return None
        util, used, total = int(util), int(used), int(total)
        if util > 100 or used > total: return None
        name = " ".join(re.sub(r"[^A-Za-z0-9 ._-]", " ", name).split())[:60]
        gpus.append({"name": name, "utilization": util, "memoryUsedMb": used, "memoryTotalMb": total})
    return gpus or None


def query(smi, timeout=SMI_TIMEOUT):
    """nvidia-smi output, or None on any failure. A hung driver is abandoned after `timeout`, not waited for."""
    try:
        proc = subprocess.Popen([smi, *QUERY], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                env={"PATH": "/run/current-system/sw/bin:/usr/bin:/bin", "LC_ALL": "C"})
    except OSError:
        return None
    try:
        out, _ = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        try: proc.wait(2)                                  # a process in D state may never die; do not hang on it
        except subprocess.TimeoutExpired: pass
        proc.stdout.close()
        return None
    return out.decode("utf-8", "replace") if proc.returncode == 0 else None


def open_dir(base, parts):
    """A descriptor for base/parts[0]/.../parts[-1], following no symlink below base; the base must be a real
    directory owned by this user and not writable by group or others."""
    fd = os.open(base, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if info.st_uid != os.getuid() or info.st_mode & 0o022:
            raise Refused("%s must be owned by this user and not group/world writable" % base)
        for part in parts:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd); fd = child
            info = os.fstat(fd)
            if info.st_uid != os.getuid() or info.st_mode & 0o022:
                raise Refused("%s must be owned by this user and not group/world writable" % part)
        return fd
    except BaseException:
        os.close(fd); raise


def write(base, relative, data):
    """Atomically replace base/relative with `data` through a pinned directory descriptor."""
    parts = relative.split("/")
    if not all(PART.fullmatch(p) for p in parts):
        raise Refused("the destination must be a plain relative path under %s" % base)
    fd = open_dir(base, parts[:-1])
    name, tmp = parts[-1], ".%s.%s" % (parts[-1], secrets.token_hex(8))
    try:
        tfd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        try:
            os.write(tfd, data)
            os.fchmod(tfd, 0o644)
            os.fsync(tfd)
        finally:
            os.close(tfd)
        os.rename(tmp, name, src_dir_fd=fd, dst_dir_fd=fd)   # renameat: replaces a link, refuses a directory
        tmp = None
    finally:
        if tmp:
            try: os.unlink(tmp, dir_fd=fd)
            except OSError: pass
        os.close(fd)


def sweep(base, relative, older=60, now=None):
    """Remove our own temp files left by a kill (names .gpu.json.<hex>); unlink never follows a link."""
    parts = relative.split("/")
    try: fd = open_dir(base, parts[:-1])
    except (OSError, Refused): return
    try:
        pattern = re.compile(r"\.%s\.[0-9a-f]{16}" % re.escape(parts[-1]))
        for entry in os.listdir(fd):
            if not pattern.fullmatch(entry): continue
            try:
                if (now or time.time()) - os.stat(entry, dir_fd=fd, follow_symlinks=False).st_mtime > older:
                    os.unlink(entry, dir_fd=fd)
            except OSError:
                pass
    finally:
        os.close(fd)


def publish_once(base, relative, smi, now_ms=None, timeout=SMI_TIMEOUT, out=sys.stderr):
    """One round: query, validate, write. Returns True when a file was written."""
    output = query(smi, timeout) if smi else None
    gpus = parse(output) if output is not None else None
    if gpus is None:
        print("gpu-publisher: no usable nvidia-smi reading; nothing written", file=out); return False
    body = json.dumps({"updatedAt": int(now_ms if now_ms is not None else time.time() * 1000), "gpus": gpus},
                      separators=(",", ":")) + "\n"
    write(base, relative, body.encode())
    return True


def find_smi(explicit=None):
    if explicit: return explicit if os.access(explicit, os.X_OK) else None
    return next((c for c in SMI_CANDIDATES if os.access(c, os.X_OK)), None)


def main(argv=None, out=sys.stderr):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--loop", type=int, metavar="SECONDS", help="write every SECONDS (1-30) until stopped")
    parser.add_argument("--relative", default=os.environ.get("GPU_STATS_RELATIVE", DEFAULT_RELATIVE),
                        help="path under ~/.local/state/reverie/ (default %(default)s)")
    args = parser.parse_args(argv)
    if args.loop is not None and not 1 <= args.loop <= 30: parser.error("--loop takes 1 to 30 seconds")
    base = state_base()
    smi = find_smi(os.environ.get("NVIDIA_SMI"))
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))  # unwind through the finally blocks: no temp left behind
    sweep(base, args.relative)
    while True:
        try:
            publish_once(base, args.relative, smi, out=out)
        except Refused as error:
            print("gpu-publisher: refused: %s" % error, file=out); return 2
        except OSError as error:
            print("gpu-publisher: write failed: %s" % error.strerror, file=out)
            if args.loop is None: return 1
        if args.loop is None: return 0
        time.sleep(args.loop)


if __name__ == "__main__": raise SystemExit(main())
