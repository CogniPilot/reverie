"""Gated builds in the shared container: pinned toolchain, admission, disk, one build per target dir.

    python3 -m reverie.buildenv --project rumoca --repo /scratch/repos/rumoca \\
        --expect 2.5G --disk 6G -- cargo build -p rumoca

Before starting it requires memory admission (reverie.admission), task (pids) headroom for
--jobs in the cgroup, free disk above a reserve,
the repo's pinned rust-toolchain already installed in the shared cache (rustup may not
auto-install), and an exclusive lock on the project's target dir. While the build runs, a
watchdog stops its process group when the cgroup nears its limit, so the kernel OOM
killer never has to choose an agent session. Every run appends its measured peak RSS to a
ledger so later estimates come from data rather than guesses.

The cgroup's pids.max counts threads, not processes, and is shared with every session: on
2026-10-15 rustc died with "failed to spawn work thread: EAGAIN" while other sessions'
vitest workers held the container near its 512-task limit. The build is admitted only when
pids.max - pids.current leaves room for its estimated threads plus a reserve for the rest of
the reverie; --wait queues instead of refusing.
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
import sys
import threading
import time
from pathlib import Path

from reverie.admission import MiB, admit, parse_size, usage

GiB = 1024 * MiB
SCRATCH = Path("/scratch")
RUST_CACHE = SCRATCH / "cache" / "rust"
DEFAULT_JOBS = 2                 # rustc workers can each take >1 GiB on large crates
DEFAULT_DISK_RESERVE = 20 * GiB  # the reverie's free-space action threshold
DEFAULT_KILL_HEADROOM = 256 * MiB
EX_TEMPFAIL = 75
# Tasks (threads) a build may hold at once. Measured 2026-10-15: each rustc ~7 threads on small
# crates, more with LLVM codegen workers on large ones; cargo, build scripts and the linker
# (lld/mold use one thread per CPU) make up the base. Rounded up; peak_pids_delta in the ledger
# records the real figure.
THREADS_BASE = 32
THREADS_PER_JOB = 16
DEFAULT_PIDS_RESERVE = 64        # for other sessions to keep spawning while the build runs
# --expect-files: a vitest filter that matches fewer files (or none) still exits 0, so a named-test
# "PASS" can be hollow. The wrapper then tees the child's output and checks vitest's summary line.
EX_FEWER_FILES = 4
TAIL_BYTES = 64 * 1024           # per stream; the summary is printed last
TEST_FILE = re.compile(r"\.(test|spec)\.[cm]?[jt]sx?$")
ANSI = re.compile(rb"\x1b\[[0-9;?]*[ -/]*[@-~]")
SUMMARY = re.compile(r"^\s*Test Files\s.*\((\d+)\)\s*$", re.M)   # " Test Files  1 failed | 2 passed (3)"
VITEST_ENTRY = ("vitest", "vitest.mjs", "vitest.js")
VITEST_VALUE_OPTIONS = {"-c", "--config", "-r", "--root", "--dir", "--project", "--reporter", "--outputFile",
                        "--pool", "--environment", "-t", "--testNamePattern", "--exclude", "--shard", "--mode",
                        "--workspace"}


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


def pids_usage(cgroup=Path("/sys/fs/cgroup")):
    """(current, limit) tasks in the cgroup; limit is None when unlimited or unreadable."""
    try:
        limit = (cgroup / "pids.max").read_text().strip()
        current = int((cgroup / "pids.current").read_text())
        return current, None if limit == "max" else int(limit)
    except (OSError, ValueError):
        return None, None


def pids_needed(jobs, per_job=THREADS_PER_JOB, base=THREADS_BASE):
    return base + jobs * per_job


def admit_pids(jobs, cgroup=Path("/sys/fs/cgroup"), per_job=THREADS_PER_JOB, reserve=DEFAULT_PIDS_RESERVE):
    current, limit = pids_usage(cgroup)
    if limit is None:
        return {"admitted": True, "reason": "no cgroup pids limit"}
    need = pids_needed(jobs, per_job)
    available = limit - reserve - current
    result = {"admitted": need <= available, "current": current, "limit": limit, "reserve": reserve,
              "needed": need, "available": available, "satisfiable": need + reserve <= limit}
    if not result["satisfiable"]:
        result["reason"] = ("need ~%d tasks for --jobs %d plus %d reserved, but the cgroup allows only %d; "
                            "waiting cannot help: lower --jobs or ask the owner to raise the container's --pids-limit"
                            % (need, jobs, reserve, limit))
    elif not result["admitted"]:
        result["reason"] = ("need ~%d tasks for --jobs %d, %d of %d in use and %d reserved for other sessions; "
                            "retry later (--wait), lower --jobs, or ask the owner to raise the container's --pids-limit"
                            % (need, jobs, current, limit, reserve))
    return result


def preflight(project, repo, expect, disk, scratch=SCRATCH, rust_cache=None, cgroup=Path("/sys/fs/cgroup"),
              reserve=None, disk_reserve=DEFAULT_DISK_RESERVE, jobs=DEFAULT_JOBS, pids_reserve=DEFAULT_PIDS_RESERVE):
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
    tasks = admit_pids(jobs, cgroup, reserve=pids_reserve)
    if not tasks["admitted"]: problems.append(("pids: " if tasks["satisfiable"] else "pids-limit: ") + tasks["reason"])
    free = shutil.disk_usage(scratch).free
    if free - disk < disk_reserve:
        problems.append("disk: need %.1f GiB, %.1f GiB free, %.0f GiB reserve" % (disk / GiB, free / GiB, disk_reserve / GiB))
    return problems


def group_rss(pgid, proc=Path("/proc"), page_size=None):
    """Bytes resident across every process in process group `pgid` (the build and all its children)."""
    page_size = page_size or os.sysconf("SC_PAGE_SIZE")
    total = 0
    for entry in proc.iterdir():
        if not entry.name.isdigit(): continue
        try:
            fields = (entry / "stat").read_text().rsplit(")", 1)[1].split()   # state ppid pgrp ...
            if int(fields[2]) != pgid: continue
            total += int((entry / "statm").read_text().split()[1]) * page_size
        except (OSError, IndexError, ValueError):
            continue    # the process exited between listing and reading
    return total


class Watchdog(threading.Thread):
    """Stop the build's process group when the cgroup has less than `headroom` left, and sample
    its memory: the whole process tree (ru_maxrss only sees the largest single process, so parallel
    rustc jobs were understated) and the cgroup's growth over its level when the build started."""
    def __init__(self, process, cgroup, headroom, interval=0.5, proc=Path("/proc")):
        super().__init__(daemon=True)
        self.process, self.cgroup, self.headroom, self.interval, self.proc = process, cgroup, headroom, interval, proc
        self.fired = None; self.stopped = threading.Event()
        self.baseline = usage(cgroup)[0]
        # None when the baseline cannot be read: an unknown delta is recorded as null, never as 0.
        self.peak_tree = 0; self.peak_cgroup_delta = None if self.baseline is None else 0
        self.pids_baseline = pids_usage(cgroup)[0]
        self.peak_pids_delta = None if self.pids_baseline is None else 0

    def sample(self):
        self.peak_tree = max(self.peak_tree, group_rss(self.process.pid, self.proc))
        used = usage(self.cgroup)[0]
        if used is not None and self.peak_cgroup_delta is not None:
            self.peak_cgroup_delta = max(self.peak_cgroup_delta, used - self.baseline)
        tasks = pids_usage(self.cgroup)[0]
        if tasks is not None and self.peak_pids_delta is not None:
            self.peak_pids_delta = max(self.peak_pids_delta, tasks - self.pids_baseline)

    def run(self):
        self.sample()
        while not self.stopped.wait(self.interval):
            self.sample()
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


class Tee(threading.Thread):
    """Copy a child's stream through to `sink` as it arrives, keeping only the last `cap` bytes."""
    def __init__(self, source, sink, cap=TAIL_BYTES):
        super().__init__(daemon=True)
        self.source, self.sink, self.cap, self.tail = source, sink, cap, bytearray()

    def run(self):
        out = getattr(self.sink, "buffer", None)
        while chunk := os.read(self.source.fileno(), 65536):
            try:
                if out is not None: out.write(chunk); out.flush()
                else: self.sink.write(chunk.decode("utf-8", "replace")); self.sink.flush()
            except (OSError, ValueError):
                pass            # our own output is gone: keep draining so the child never blocks
            self.tail += chunk; del self.tail[:-self.cap]
        self.source.close()


def vitest_file_count(output):
    """Total test files in vitest's last summary line ('Test Files  1 failed | 2 passed (3)' -> 3), or None."""
    found = SUMMARY.findall(ANSI.sub(b"", bytes(output)).decode("utf-8", "replace"))
    return int(found[-1]) if found else None


def count_test_files(command, repo):
    """--expect-files auto: the vitest filters after the entry (and `run`) that name a test file,
    by suffix or because the file exists under `repo`. Options and their values are skipped."""
    args = list(command[1:])
    entry = next((i for i, arg in enumerate(args) if Path(arg).name in VITEST_ENTRY), -1)
    args = args[entry + 1:]
    if args[:1] == ["run"]: args = args[1:]
    count, skip = 0, False
    for arg in args:
        if skip: skip = False; continue
        if arg.startswith("-"): skip = arg in VITEST_VALUE_OPTIONS; continue
        if TEST_FILE.search(arg) or (Path(repo) / arg).is_file(): count += 1
    return count


def run(project, repo, command, expect, disk, jobs=DEFAULT_JOBS, scratch=SCRATCH, rust_cache=None,
        cgroup=Path("/sys/fs/cgroup"), headroom=DEFAULT_KILL_HEADROOM, disk_reserve=DEFAULT_DISK_RESERVE,
        ledger=None, interval=0.5, proc=Path("/proc"), pids_reserve=DEFAULT_PIDS_RESERVE, wait=0, poll=10,
        expect_files=None):
    """Run the build once preflight passes. With `wait` seconds, a refusal that can clear (memory,
    pids, disk) is retried every `poll` seconds and once more at the deadline (a queue, not a busy loop).
    With `expect_files`, the child's output is teed and vitest must report at least that many test files."""
    queued = time.monotonic(); deadline = queued + wait
    while True:
        problems = preflight(project, repo, expect, disk, scratch, rust_cache, cgroup, disk_reserve=disk_reserve,
                             jobs=jobs, pids_reserve=pids_reserve)
        transient = all(p.startswith(("memory:", "pids:", "disk:")) for p in problems)
        remaining = deadline - time.monotonic()
        if not problems or not transient or remaining <= 0: break
        time.sleep(min(poll, remaining))
    record = {"ts": time.time(), "project": project, "repo": str(repo), "command": command,
              "expect_mib": expect // MiB, "jobs": jobs, "waited_s": round(time.monotonic() - queued, 1)}
    if problems:
        return dict(record, status="refused", problems=problems)
    target = scratch / "build" / project
    target.mkdir(parents=True, exist_ok=True)
    with (target / ".build.lock").open("a") as lock:
        try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return dict(record, status="refused", problems=["another build owns " + str(target)])
        started = time.monotonic()
        pipes = {} if expect_files is None else {"stdout": subprocess.PIPE, "stderr": subprocess.PIPE}
        process = subprocess.Popen(command, cwd=repo, env=build_env(project, scratch, rust_cache, jobs),
                                   start_new_session=True, **pipes)
        tees = [Tee(process.stdout, sys.stdout), Tee(process.stderr, sys.stderr)] if pipes else []
        for tee in tees: tee.start()
        watchdog = Watchdog(process, cgroup, headroom, interval, proc); watchdog.start()
        # wait4 reports this build's own peak (largest of it and its reaped descendants, e.g. rustc).
        _, status, rusage = os.wait4(process.pid, 0)
        process.returncode = code = os.waitstatus_to_exitcode(status)
        watchdog.stopped.set(); watchdog.join()
        for tee in tees: tee.join(10)       # a leftover grandchild holding the pipe must not hang us
        largest = rusage.ru_maxrss // 1024
        record.update(exit=code, seconds=round(time.monotonic() - started, 1),
                      # The figure to estimate from: the sampled whole-tree peak, never below the largest
                      # single process (a spike shorter than the sampling interval is still counted there).
                      peak_mib=max(watchdog.peak_tree // MiB, largest),
                      peak_rss_mib=largest, peak_cgroup_delta_mib=None if watchdog.peak_cgroup_delta is None else watchdog.peak_cgroup_delta // MiB,
                      peak_pids_delta=watchdog.peak_pids_delta,
                      status="aborted_memory" if watchdog.fired else ("ok" if code == 0 else "failed"))
        if watchdog.fired: record["watchdog"] = watchdog.fired
        if pipes:
            counts = [vitest_file_count(tee.tail) for tee in tees]
            ran = next((n for n in counts if n is not None), None)
            record.update(expected_files=expect_files, ran_files=ran)
            if not watchdog.fired and (ran is None or ran < expect_files): record["status"] = "fewer-files"
        if record["peak_mib"] > record["expect_mib"]:
            record["warning"] = "peak memory exceeded the estimate; raise --expect for this command"
    if ledger:
        ledger = Path(ledger); ledger.parent.mkdir(parents=True, exist_ok=True)
        with ledger.open("a") as file: file.write(json.dumps(record) + "\n")
    return record


ESTIMATE_FLOOR = 256 * MiB


def ledger_estimate(ledger, project, command, jobs, margin=1.25, floor=ESTIMATE_FLOOR):
    """An --expect from measured history, or None when there is none to trust.

    Only successful runs of the same project and the same command count. Runs with the same
    --jobs are used as measured. Without those, runs at fewer jobs are scaled up linearly to
    this --jobs; runs at more jobs are never scaled down. The result is the largest whole-tree
    peak plus a margin, and never below `floor`, so a recorded peak of 0 can never admit 0."""
    same_jobs, scaled = [], []
    try:
        lines = Path(ledger).read_text().splitlines()
    except OSError:
        return None
    for line in lines:
        try: entry = json.loads(line)
        except ValueError: continue
        if not (isinstance(entry, dict) and entry.get("project") == project and entry.get("status") == "ok"
                and entry.get("command") == list(command) and isinstance(entry.get("peak_mib"), (int, float))):
            continue
        ran_jobs = entry.get("jobs")
        if ran_jobs == jobs:
            same_jobs.append(entry["peak_mib"])
        elif isinstance(ran_jobs, int) and 0 < ran_jobs < jobs:
            scaled.append(entry["peak_mib"] * jobs / ran_jobs)
    peaks = same_jobs or scaled
    if not peaks: return None
    return max(int(max(peaks) * margin * MiB), floor)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--project", required=True, help="names /scratch/build/<project>/cargo")
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    parser.add_argument("--expect", required=True,
                        help="expected peak memory (e.g. 2.5G), or 'auto': the ledger's largest whole-tree peak of this command, + 25%%, at least 256M")
    parser.add_argument("--disk", required=True, type=parse_size, help="expected new disk use")
    parser.add_argument("--jobs", type=int, default=DEFAULT_JOBS)
    parser.add_argument("--ledger", type=Path, default=SCRATCH / "profiles" / "build-ledger.jsonl")
    parser.add_argument("--wait", type=int, default=0, metavar="SECONDS",
                        help="queue: retry a refused preflight (memory, pids, disk) every 10 s for up to SECONDS")
    parser.add_argument("--expect-files", metavar="N|auto",
                        help="fail (exit 4) unless vitest's 'Test Files' summary counts at least N files; "
                             "'auto' counts the test-file arguments after --")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command: parser.error("give the build command after --")
    if not 1 <= args.jobs <= 8: parser.error("--jobs must be between 1 and 8")
    if args.expect == "auto":
        args.expect = ledger_estimate(args.ledger, args.project, command, args.jobs)
        if args.expect is None:
            parser.error("--expect auto needs a successful measured run of this command at this --jobs (or fewer) in the ledger")
    else:
        args.expect = parse_size(args.expect)
    if args.wait < 0: parser.error("--wait must not be negative")
    run_kw = {}
    if args.expect_files is not None:
        if args.expect_files == "auto": files = count_test_files(command, args.repo.resolve())
        elif args.expect_files.isdigit(): files = int(args.expect_files)
        else: parser.error("--expect-files takes a count or 'auto'")
        if files < 1: parser.error("--expect-files needs at least one test file (auto found none: give N)")
        run_kw["expect_files"] = files
    record = run(args.project, args.repo.resolve(), command, args.expect, args.disk, args.jobs, ledger=args.ledger,
                 wait=args.wait, **run_kw)
    if record["status"] == "fewer-files":
        ran = record["ran_files"]
        print("buildenv: expected %d test files, vitest ran %s" % (record["expected_files"],
              "none (no 'Test Files' summary line)" if ran is None else ran), file=sys.stderr, flush=True)
    print(json.dumps(record), flush=True)
    if record["status"] == "fewer-files": return EX_FEWER_FILES
    if record["status"] == "refused" or record["status"] == "aborted_memory": return EX_TEMPFAIL
    return record.get("exit", 1)


if __name__ == "__main__": raise SystemExit(main())
