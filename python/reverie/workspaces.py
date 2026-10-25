"""Owned disposable task workspaces, leases and cleanup after a saved handoff.

Lease adapter r4 (r4 = W4 publication: durable "running" marker before spawn, finish/run admit only verified terminal
states; r3 = W3 stop protection before spawn + terminal state published while held, and W4 cleanup
uncertainty refuses completion; r2 = W1 signal forwarding + W2 renew-all): disk protection uses the ONE lease implementation (lease.py, T7b), so the
prune, the /tmp wipe and LAUNCH all see the same state:
- create() RESERVEs the workspace (<= 24 h, renewed by every later operation) so an allocated or awaiting-handoff workspace
  is protected while no process runs;
- run() HOLDS a lease on the workspace for the command's life, runs it in its own session, and kills and reaps that session
  before releasing (contract §4: never rely on fd inheritance; never release before the session is gone);
- finish() records the handoff and drops the reservation; clean() deletes only inside lease.janitor(), which refuses while
  any lease or live reservation covers the workspace.
Separately, each workspace keeps an exclusive OPERATION lock (.ops/<name>.lock) so two operations on one workspace never
interleave; that is a local mutex, not a lease. Default root /tmp/reverie/tasks (disposable drive), configurable."""
from __future__ import annotations
import argparse
from contextlib import contextmanager
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import time

DEFAULT_ROOT = Path(os.environ.get("REVERIE_TASKS_ROOT", "/tmp/reverie/tasks"))
RESERVE_FOR = "24h"


def _load_lease():
    """The packaged lease module, or REVERIE_LEASE_LIB (an absolute path) where it is installed separately."""
    path = os.environ.get("REVERIE_LEASE_LIB")
    if path:
        spec = importlib.util.spec_from_file_location("reverie_lease", path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod
    from . import lease  # type: ignore  # packaged next to this module
    return lease


CLEANUP_UNKNOWN_EXIT = 124  # r3 (W4): run() exit code when the session could not be verified gone
# r4 (W4 publication): finish() admits ONLY these statuses. "allocated" is evidence that no run() effect happened, because
# run() publishes "running" under the hold BEFORE Popen and refuses to spawn if that write fails. "running" (a run whose terminal
# publication failed or never happened), "cleanup_unknown" and any other value keep their protection.
FINISHABLE = ("allocated", "awaiting_handoff", "failed")


def _kill_session(pgid, grace=10.0):
    """TERM the command's whole session/group, wait up to `grace`, then KILL and wait again. Returns True ONLY once the group is
    verified gone (ProcessLookupError); False if it is still reported present after both waits (r3, W4: never success by
    deadline alone)."""
    for sig, wait in ((signal.SIGTERM, grace), (signal.SIGKILL, 5.0)):
        try:
            os.killpg(pgid, sig)
        except ProcessLookupError:
            return True
        end = time.monotonic() + wait
        while time.monotonic() < end:
            try:
                os.killpg(pgid, 0)
            except ProcessLookupError:
                return True
            time.sleep(0.05)
    return False


class Workspaces:
    def __init__(self, root: Path = DEFAULT_ROOT):
        self.root = root.expanduser().resolve()
        marker = self.root / ".reverie-owned"
        if not marker.exists() and self.root.exists() and any(self.root.iterdir()):
            raise ValueError("refusing an existing unowned workspace root")
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        marker.touch(mode=0o600, exist_ok=True)
        (self.root / ".ops").mkdir(exist_ok=True, mode=0o700)
        self.lease = _load_lease()

    def path(self, name):
        if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}", name):
            raise ValueError("invalid workspace identifier")
        path = self.root / name
        if path.is_symlink():
            raise ValueError("workspace must not be a symlink")
        return path

    @contextmanager
    def operation(self, name):
        """Exclusive per-workspace operation mutex (refuses a concurrent operation at once). Not a lease."""
        self.path(name)
        with (self.root / ".ops" / (name + ".lock")).open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            yield

    def _reserve(self, path, renew):
        self.lease.reserve(str(path), RESERVE_FOR, owner=os.environ.get("USER", ""), renew=renew)

    def create(self, name):
        with self.operation(name):
            path = self.path(name)
            path.mkdir(mode=0o700)
            self.write(path, {"id": name, "status": "allocated", "created_at": time.time()})
            self._reserve(path, renew=False)
            return path

    def write(self, path, value):
        temp = path / ".reverie-task.json.tmp"
        with temp.open("w") as f:  # r4: durable before it counts (fsync file, rename, fsync directory)
            f.write(json.dumps(value) + "\n"); f.flush(); os.fsync(f.fileno())
        temp.replace(path / ".reverie-task.json")
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def finish(self, name, handoff):
        if not handoff.strip():
            raise ValueError("save a handoff receipt before cleanup")
        with self.operation(name):
            path = self.path(name)
            value = json.loads((path / ".reverie-task.json").read_text())
            if value.get("status") not in FINISHABLE:  # r4 (W4): only a positively published terminal state unreserves
                raise ValueError(f"workspace is {value.get('status')!r}, not a verified terminal state; resolve it before finishing")
            value.update(status="completed", handoff=handoff, completed_at=time.time())
            self.write(path, value)
            self.lease.unreserve(str(path))

    def clean(self, name, apply=False):
        with self.operation(name):
            path = self.path(name)
            value = json.loads((path / ".reverie-task.json").read_text())
            if value.get("id") != name or value.get("status") != "completed" or not value.get("handoff"):
                raise ValueError("workspace has no completed handoff")
            for current, dirs, files in os.walk(path, followlinks=False):
                if ".git" in dirs or ".git" in files:
                    raise ValueError("source checkout found; preserve it for review")
            if apply:
                # The ONE lease implementation decides: refuses (LeaseError) while any lease or live reservation covers it.
                with self.lease.janitor(str(path), str(self.root)):
                    shutil.rmtree(path)  # fd-safe on supported platforms; never follows links inside the tree.
            return {"workspace": name, "removed": apply}

    def renew_all(self):
        """r2 (W2): renew the reservation of every workspace that is not completed (allocated, running, failed,
        awaiting_handoff), so unsaved work stays protected past 24 h. Run it from the same timer as the prune (well inside
        24 h). Completed workspaces are left alone. Returns {name: "renewed" | "reserved" | "skipped: <why>"}."""
        out = {}
        for entry in sorted(self.root.iterdir()):
            name = entry.name
            if name.startswith(".") or entry.is_symlink() or not entry.is_dir():
                continue
            try:
                with self.operation(name):
                    value = json.loads((entry / ".reverie-task.json").read_text())
                    if value.get("status") == "completed":
                        out[name] = "skipped: completed"; continue
                    try:
                        self._reserve(entry, renew=True); out[name] = "renewed"
                    except self.lease.LeaseError:
                        self._reserve(entry, renew=False); out[name] = "reserved"
            except BlockingIOError:
                out[name] = "skipped: operation in progress (run() renews its own)"
            except (OSError, ValueError) as e:
                out[name] = f"skipped: {e.__class__.__name__}"
        return out

    def run(self, name, command):
        with self.operation(name):
            path = self.path(name)
            metadata = path / ".reverie-task.json"
            value = json.loads(metadata.read_text())
            if value.get("status") not in FINISHABLE:  # r4: also refuses "running" (unresolved earlier run) and unknown values
                raise ValueError(f"workspace is {value.get('status')}; it cannot start new work")
            self._reserve(path, renew=True)
            env = dict(os.environ)
            for key, directory in (("TMPDIR", "tmp"), ("CARGO_TARGET_DIR", "build")):
                target = path / directory; target.mkdir(exist_ok=True); env[key] = str(target)
            # r3 (W3): stop protection is installed BEFORE the first spawn. A stop that arrives before the child exists is
            # remembered and forwarded as soon as its group does; handlers are restored in an unconditional finally.
            child = {"pgid": None}; pending = []
            def forward(signum, _frame):
                if child["pgid"] is None:
                    pending.append(signum); return
                try:
                    os.killpg(child["pgid"], signum)
                except ProcessLookupError:
                    pass
            previous = {sig: signal.signal(sig, forward) for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)}
            try:
                with self.lease.hold([str(path)], command[0]):
                    # r4 (W4): the conservative in-progress marker is durable BEFORE the child can exist. If this write
                    # raises, nothing has been spawned and the exception propagates. If the terminal write below fails,
                    # "running" stays: finish, clean and run refuse it and renew-all keeps renewing the reservation.
                    self.write(path, {**value, "status": "running", "started_at": time.time()})
                    process = subprocess.Popen(command, cwd=path, env=env, start_new_session=True)
                    child["pgid"] = process.pid
                    for signum in pending:
                        forward(signum, None)
                    cleaned, code, error = False, None, None
                    try:
                        code = process.wait()
                    finally:
                        try:
                            cleaned = _kill_session(process.pid) is True  # the session goes BEFORE the lease is released
                        except BaseException as e:  # noqa: BLE001 - recorded below, then re-raised
                            error = e
                        # Terminal state and reservation are published while STILL held (r3, W3).
                        if cleaned and error is None:
                            status = "awaiting_handoff" if code == 0 else "failed"
                        else:
                            status = "cleanup_unknown"  # W4: protection retained; finish/clean refuse
                        try:
                            self.write(path, {**value, "status": status, "exit_code": code})
                        finally:
                            self._reserve(path, renew=True)  # r4: renewed even when the terminal write fails
                    if error is not None:
                        raise error
            finally:
                for sig, handler in previous.items():
                    signal.signal(sig, handler)
            return code if cleaned else CLEANUP_UNKNOWN_EXIT

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    sub = parser.add_subparsers(dest="action", required=True)
    sub.add_parser("create").add_argument("name")
    run = sub.add_parser("run"); run.add_argument("name"); run.add_argument("command", nargs=argparse.REMAINDER)
    finish = sub.add_parser("finish"); finish.add_argument("name"); finish.add_argument("--handoff", required=True)
    clean = sub.add_parser("clean"); clean.add_argument("name"); clean.add_argument("--apply", action="store_true")
    sub.add_parser("renew-all")
    args = parser.parse_args(argv); manager = Workspaces(args.root)
    if args.action == "create": print(manager.create(args.name))
    elif args.action == "finish": manager.finish(args.name, args.handoff)
    elif args.action == "clean": print(json.dumps(manager.clean(args.name, args.apply)))
    elif args.action == "renew-all": print(json.dumps(manager.renew_all()))
    else:
        command = args.command[1:] if args.command[:1] == ["--"] else args.command
        if not command: parser.error("run requires a command")
        return manager.run(args.name, command)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
