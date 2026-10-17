"""Gated builds in the shared container: pinned toolchain, admission, disk, one build per target dir.

    python3 -m cto.buildenv --project example --repo /scratch/repos/example \\
        --expect 2.5G --disk 6G -- cargo build -p example

Before starting it requires memory admission (cto.admission), free disk above a reserve,
the repo's pinned rust-toolchain already installed in the shared cache (rustup may not
auto-install), and an exclusive lock on the project's target dir. While the build runs, a
watchdog stops its process group when the cgroup nears its limit, so the kernel OOM
killer never has to choose an agent session. Every run appends its measured peak RSS to a
ledger so later estimates come from data rather than guesses.
"""
from __future__ import annotations
import argparse
import fcntl
import json
import os
import re
import shutil
import signal
import subprocess
import threading
import time
from pathlib import Path

from cto.admission import MiB, admit, parse_size, usage

GiB = 1024 * MiB
SCRATCH = Path("/scratch")
RUST_CACHE = SCRATCH / "cache" / "rust"
DEFAULT_JOBS = 2                 # rustc workers can each take >1 GiB on large crates
DEFAULT_DISK_RESERVE = 20 * GiB  # the fleet's free-space action threshold
DEFAULT_KILL_HEADROOM = 256 * MiB
EX_TEMPFAIL = 75


def pinned_toolchain(repo):
    """The channel named by the repo's rust-toolchain(.toml), or None when it pins none."""
    for name in ("rust-toolchain.toml", "rust-toolchain"):
        path = Path(repo) / name
        if path.is_file():
            text = path.read_text()
            match = re.search(r'^\s*channel\s*=\s*"([^"]+)"', text, re.M)
            return match.group(1) if match else (text.strip().splitlines() or [None])[0]
    return None


def build_env(project, scratch=SCRATCH, rust_cache=None, jobs=DEFAULT_JOBS, base=None):
    rust_cache = Path(rust_cache or scratch / "cache" / "rust")
    env = dict(os.environ if base is None else base)
    env.update(RUSTUP_HOME=str(rust_cache / "rustup"), CARGO_HOME=str(rust_cache / "cargo"),
               RUSTUP_AUTO_INSTALL="0", TMPDIR=str(scratch / "tmp"),
               CARGO_TARGET_DIR=str(scratch / "build" / project / "cargo"), CARGO_BUILD_JOBS=str(jobs))
    env["PATH"] = str(rust_cache / "cargo" / "bin") + os.pathsep + env.get("PATH", "")
    return env


def preflight(project, repo, expect, disk, scratch=SCRATCH, rust_cache=None, cgroup=Path("/sys/fs/cgroup"),
              reserve=None, disk_reserve=DEFAULT_DISK_RESERVE):
    """Refusal reasons (empty when the build may start)."""
    if not re.fullmatch(r"[A-Za-z0-9._-]+", project): return ["project must be a plain name"]
    problems = []
    rust_cache = Path(rust_cache or scratch / "cache" / "rust")
    channel = pinned_toolchain(repo)
    if channel:
        installed = [p.name for p in (rust_cache / "rustup" / "toolchains").glob(channel + "-*")]
        if not installed:
            problems.append("pinned toolchain %s is not installed in %s; install it deliberately" % (channel, rust_cache))
    memory = admit(expect, cgroup=cgroup) if reserve is None else admit(expect, reserve, cgroup)
    if not memory["admitted"]: problems.append("memory: " + memory["reason"])
    free = shutil.disk_usage(scratch).free
    if free - disk < disk_reserve:
        problems.append("disk: need %.1f GiB, %.1f GiB free, %.0f GiB reserve" % (disk / GiB, free / GiB, disk_reserve / GiB))
    return problems


class Watchdog(threading.Thread):
    """Stop the build's process group when the cgroup has less than `headroom` left."""
    def __init__(self, process, cgroup, headroom, interval=0.5):
        super().__init__(daemon=True)
        self.process, self.cgroup, self.headroom, self.interval = process, cgroup, headroom, interval
        self.fired = None; self.stopped = threading.Event()

    def run(self):
        while not self.stopped.wait(self.interval):
            used, limit = usage(self.cgroup)
            if limit is not None and limit - used < self.headroom:
                self.fired = {"used": used, "limit": limit}
                try:
                    os.killpg(self.process.pid, signal.SIGTERM)
                    if self.stopped.wait(5) is False and self.process.poll() is None:
                        os.killpg(self.process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                return


def run(project, repo, command, expect, disk, jobs=DEFAULT_JOBS, scratch=SCRATCH, rust_cache=None,
        cgroup=Path("/sys/fs/cgroup"), headroom=DEFAULT_KILL_HEADROOM, disk_reserve=DEFAULT_DISK_RESERVE,
        ledger=None, interval=0.5):
    problems = preflight(project, repo, expect, disk, scratch, rust_cache, cgroup, disk_reserve=disk_reserve)
    record = {"ts": time.time(), "project": project, "repo": str(repo), "command": command,
              "expect_mib": expect // MiB, "jobs": jobs}
    if problems:
        return dict(record, status="refused", problems=problems)
    target = scratch / "build" / project
    target.mkdir(parents=True, exist_ok=True)
    with (target / ".build.lock").open("a") as lock:
        try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return dict(record, status="refused", problems=["another build owns " + str(target)])
        started = time.monotonic()
        process = subprocess.Popen(command, cwd=repo, env=build_env(project, scratch, rust_cache, jobs),
                                   start_new_session=True)
        watchdog = Watchdog(process, cgroup, headroom, interval); watchdog.start()
        # wait4 reports this build's own peak (largest of it and its reaped descendants, e.g. rustc).
        _, status, rusage = os.wait4(process.pid, 0)
        process.returncode = code = os.waitstatus_to_exitcode(status)
        watchdog.stopped.set(); watchdog.join()
        record.update(exit=code, seconds=round(time.monotonic() - started, 1), peak_rss_mib=rusage.ru_maxrss // 1024,
                      status="aborted_memory" if watchdog.fired else ("ok" if code == 0 else "failed"))
        if watchdog.fired: record["watchdog"] = watchdog.fired
        if record["peak_rss_mib"] and record["peak_rss_mib"] > record["expect_mib"]:
            record["warning"] = "peak RSS exceeded the estimate; raise --expect for this command"
    if ledger:
        ledger = Path(ledger); ledger.parent.mkdir(parents=True, exist_ok=True)
        with ledger.open("a") as file: file.write(json.dumps(record) + "\n")
    return record


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--project", required=True, help="names /scratch/build/<project>/cargo")
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    parser.add_argument("--expect", required=True, type=parse_size, help="expected peak memory (from the ledger)")
    parser.add_argument("--disk", required=True, type=parse_size, help="expected new disk use")
    parser.add_argument("--jobs", type=int, default=DEFAULT_JOBS)
    parser.add_argument("--ledger", type=Path, default=SCRATCH / "profiles" / "build-ledger.jsonl")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command: parser.error("give the build command after --")
    if not 1 <= args.jobs <= 8: parser.error("--jobs must be between 1 and 8")
    record = run(args.project, args.repo.resolve(), command, args.expect, args.disk, args.jobs, ledger=args.ledger)
    print(json.dumps(record), flush=True)
    if record["status"] == "refused" or record["status"] == "aborted_memory": return EX_TEMPFAIL
    return record.get("exit", 1)


if __name__ == "__main__": raise SystemExit(main())
