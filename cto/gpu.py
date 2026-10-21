"""GPU scheduling: one flock at ~/.cache/gpu.lock shared by every GPU user on the host.

Command line, for tenants that are not Python::

    python3 -m cto.gpu hold <chat|review|train|dream> [--timeout S] [--min-idle S] [--preempt] -- <command...>
    python3 -m cto.gpu status

Roles and priorities: ``chat`` (highest) > ``review`` > ``train`` > ``dream``. The holder writes
its role and pid into the lock file. A higher-priority requester that finds the lock
taken asks the holder to give it up by writing ``~/.cache/gpu.yield``; cooperative
holders (the trainer, between steps) check :meth:`GpuLock.should_yield`, checkpoint
and release. Chat never blocks on the lock for long: it asks, waits briefly, and
proceeds regardless, because the user's reply comes first.

Training may only start after the GPU has been idle for ``min_idle`` seconds, where
idle means no chat or review acquisition recorded in ``~/.cache/gpu.activity``.
"""
from __future__ import annotations

import fcntl
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from cto import env_names

PRIORITY = {"chat": 0, "review": 1, "train": 2, "dream": 3}
CACHE = Path(env_names.lookup("REVERIE_HOME", Path.home())) / ".cache"
LOCK_PATH = Path(env_names.lookup("REVERIE_GPU_LOCK", CACHE / "gpu.lock"))
YIELD_PATH = Path(env_names.lookup("REVERIE_GPU_YIELD", CACHE / "gpu.yield"))
ACTIVITY_PATH = Path(env_names.lookup("REVERIE_GPU_ACTIVITY", CACHE / "gpu.activity"))
TRAIN_MIN_IDLE = 1800
YIELD_MAX_AGE = 300        # a yield request older than this is stale (its requester gave up or died)


def _read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


class GpuLock:
    def __init__(self, role: str, lock_path: Path = LOCK_PATH, yield_path: Path = YIELD_PATH,
                 activity_path: Path = ACTIVITY_PATH):
        if role not in PRIORITY:
            raise ValueError(f"unknown role {role!r}")
        self.role = role
        self.lock_path = Path(lock_path)
        self.yield_path = Path(yield_path)
        self.activity_path = Path(activity_path)
        self._fd: int | None = None

    # ---- state ---------------------------------------------------------
    def holder(self) -> dict:
        """Who holds the lock now ({} when free)."""
        try:
            fd = os.open(self.lock_path, os.O_RDWR | os.O_CREAT, 0o644)
        except OSError:
            return {}
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                return _read_json(self.lock_path) or {"role": "unknown"}
            fcntl.flock(fd, fcntl.LOCK_UN)
            return {}
        finally:
            os.close(fd)

    def should_yield(self, now: float | None = None) -> bool:
        """True when a higher-priority role has recently asked the current holder to release."""
        req = _read_json(self.yield_path)
        if not req:
            return False
        now = time.time() if now is None else now
        if now - float(req.get("at", 0.0)) > YIELD_MAX_AGE:
            return False
        return PRIORITY.get(req.get("role", "train"), 99) < PRIORITY[self.role]

    def _clear_yield(self) -> None:
        try:
            self.yield_path.unlink()
        except OSError:
            pass

    def last_activity(self) -> float:
        return float(_read_json(self.activity_path).get("at", 0.0))

    def idle_seconds(self, now: float | None = None) -> float:
        now = time.time() if now is None else now
        return now - self.last_activity()

    def _record_activity(self, now: float) -> None:
        if self.role == "train":
            return
        self.activity_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.activity_path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"role": self.role, "at": now}), encoding="utf-8")
        tmp.replace(self.activity_path)

    # ---- acquire / release ---------------------------------------------
    def acquire(self, timeout: float | None = None, min_idle: float = 0.0, poll: float = 1.0) -> bool:
        """Take the lock. Returns False on timeout (or, for train, if the GPU is not idle enough)."""
        if self.role == "train" and self.idle_seconds() < min_idle:
            return False
        self.lock_path.parent.mkdir(parents=True, exist_ok=True)
        deadline = None if timeout is None else time.time() + timeout
        asked = False
        while True:
            fd = os.open(self.lock_path, os.O_RDWR | os.O_CREAT, 0o644)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                os.close(fd)
                holder = _read_json(self.lock_path)
                # an unreadable holder (mid-write race) is treated as an equal, never asked to yield
                holder_prio = PRIORITY.get(holder.get("role", ""), PRIORITY[self.role])
                if not asked and holder_prio > PRIORITY[self.role]:
                    self.yield_path.write_text(json.dumps({"role": self.role, "pid": os.getpid(), "at": time.time()}))
                    asked = True
                if deadline is not None and time.time() >= deadline:
                    if asked:
                        self._clear_yield()
                    return False
                time.sleep(poll)
                continue
            now = time.time()
            os.ftruncate(fd, 0)
            os.write(fd, json.dumps({"role": self.role, "pid": os.getpid(), "since": now}).encode())
            self._fd = fd
            if asked:
                self._clear_yield()
            self._record_activity(now)
            return True

    def release(self) -> None:
        if self._fd is None:
            return
        try:
            os.ftruncate(self._fd, 0)
            fcntl.flock(self._fd, fcntl.LOCK_UN)
        finally:
            os.close(self._fd)
            self._fd = None
        self._record_activity(time.time())

    def __enter__(self) -> "GpuLock":
        self.acquire()
        return self

    def __exit__(self, *exc) -> None:
        self.release()


def vram_used_mib() -> int | None:
    """Used VRAM from nvidia-smi, or None when unavailable."""
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=10,
        ).stdout.strip().splitlines()
        return int(out[0]) if out else None
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def status(lock_path: Path = LOCK_PATH, yield_path: Path = YIELD_PATH, activity_path: Path = ACTIVITY_PATH) -> dict:
    probe = GpuLock("train", lock_path, yield_path, activity_path)
    return {
        "holder": probe.holder(),
        "yield_request": _read_json(yield_path),
        "idle_seconds": round(probe.idle_seconds()),
        "train_may_start": probe.idle_seconds() >= TRAIN_MIN_IDLE and not probe.holder(),
        "vram_used_mib": vram_used_mib(),
    }


def hold(role: str, command: list[str], timeout: float | None = None, min_idle: float | None = None,
         preempt: bool = False, poll: float = 1.0) -> int:
    """Acquire the lock as ``role``, run ``command``, release; returns the command's exit code.

    With ``preempt`` the child gets SIGTERM when a higher-priority role asks for the GPU
    (the lock is released once the child exits). Without it the lock is simply held until
    the command finishes; a waiting chat proceeds on its own after its short wait.
    Exit codes: 75 when the lock could not be taken in time, 143 when preempted.
    """
    lock = GpuLock(role)
    if min_idle is None:
        min_idle = TRAIN_MIN_IDLE if role == "train" else 0.0
    if not lock.acquire(timeout=timeout, min_idle=min_idle, poll=poll):
        print(f"gpu lock: not acquired as {role} (holder: {lock.holder() or 'none'}, idle {round(lock.idle_seconds())}s)", file=sys.stderr)
        return 75
    preempted = False
    try:
        proc = subprocess.Popen(command)
        while True:
            try:
                code = proc.wait(timeout=poll)
                break
            except subprocess.TimeoutExpired:
                if preempt and not preempted and lock.should_yield():
                    preempted = True
                    proc.send_signal(signal.SIGTERM)
        return 143 if preempted else code
    finally:
        lock.release()


def main(argv: list[str] | None = None) -> int:
    import argparse

    p = argparse.ArgumentParser(prog="python3 -m cto.gpu", description="Shared GPU lock with chat > review > train priorities.")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status", help="holder, pending yield request, idle time, VRAM")
    h = sub.add_parser("hold", help="acquire the lock as ROLE, run COMMAND, release")
    h.add_argument("role", choices=sorted(PRIORITY, key=PRIORITY.get))
    h.add_argument("--timeout", type=float, default=None, help="seconds to wait for the lock (default: forever)")
    h.add_argument("--min-idle", type=float, default=None, help="required idle seconds (default: 1800 for train, 0 otherwise)")
    h.add_argument("--preempt", action="store_true", help="SIGTERM the command when a higher-priority role asks")
    h.usage = "python3 -m cto.gpu hold {chat,review,train,dream} [--timeout S] [--min-idle S] [--preempt] -- COMMAND..."
    argv = list(sys.argv[1:] if argv is None else argv)
    command: list[str] = []
    if "--" in argv:
        i = argv.index("--")
        argv, command = argv[:i], argv[i + 1:]
    args = p.parse_args(argv)
    if args.cmd == "status":
        print(json.dumps(status(), indent=2))
        return 0
    if not command:
        p.error("hold needs a command after --")
    return hold(args.role, command, args.timeout, args.min_idle, args.preempt)


if __name__ == "__main__":
    sys.exit(main())
