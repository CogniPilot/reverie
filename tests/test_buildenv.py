import tests  # noqa: F401  isolates REVERIE_* before reverie is imported
import fcntl
import io
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

import reverie.buildenv
from reverie.buildenv import (EX_FEWER_FILES, EX_TEMPFAIL, admit_pids, build_env, count_test_files, group_rss, ledger_estimate,
                          main, pids_needed, pids_usage, pinned_toolchain, preflight, run, vitest_file_count)

MiB = 1 << 20
CHANNEL = "nightly-2026-02-27"
# A stand-in for `vitest run`: runs the named files that exist (a typo or excluded file is silently
# skipped, as vitest's filter does), prints 100 KiB of log first (past the 64 KiB tail) and exits 0
# with "No test files found" when nothing matched (as with passWithNoTests).
FAKE_VITEST = r"""
import os, sys
args = sys.argv[1:]
if args[:1] == ["run"]: args = args[1:]
files, skip = [], False
for arg in args:
    if skip: skip = False; continue
    if arg.startswith("-"): skip = arg in ("--config", "-t"); continue
    if os.path.isfile(arg): files.append(arg)
sys.stderr.write("vitest stderr line\n")
sys.stdout.write(("x" * 99 + "\n") * 1024)
if not files: print("No test files found, exiting with code 0"); sys.exit(0)
print("\x1b[2m Test Files \x1b[22m \x1b[1m\x1b[32m%d passed\x1b[39m\x1b[22m\x1b[90m (%d)\x1b[39m" % (len(files), len(files)))
print("\x1b[2m      Tests \x1b[22m %d passed (%d)" % (len(files), len(files)))
"""
LEDGER_FIELDS = {"ts", "project", "repo", "command", "expect_mib", "jobs", "waited_s", "exit", "seconds", "peak_mib",
                 "peak_rss_mib", "peak_cgroup_delta_mib", "peak_pids_delta", "status"}


class BuildEnvTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.scratch = root / "scratch"; (self.scratch / "tmp").mkdir(parents=True)
        self.cache = self.scratch / "cache" / "rust"
        (self.cache / "rustup" / "toolchains" / (CHANNEL + "-x86_64-unknown-linux-gnu")).mkdir(parents=True)
        self.repo = root / "repo"; self.repo.mkdir()
        (self.repo / "rust-toolchain.toml").write_text('[toolchain]\nchannel = "%s"\n' % CHANNEL)
        self.cgroup = root / "cgroup"; self.cgroup.mkdir(); self.memory(used=1 << 30)

    def memory(self, used, limit=4 << 30):
        (self.cgroup / "memory.max").write_text(str(limit)); (self.cgroup / "memory.current").write_text(str(used))
        (self.cgroup / "memory.stat").write_text("inactive_file 0\n")

    def tasks(self, current, limit=512):
        (self.cgroup / "pids.max").write_text("%s\n" % limit); (self.cgroup / "pids.current").write_text("%d\n" % current)

    def run_build(self, command, expect=100 * MiB, **kw):
        kw.setdefault("disk_reserve", 0)
        return run("demo", self.repo, command, expect, 1 * MiB, scratch=self.scratch, rust_cache=self.cache,
                   cgroup=self.cgroup, ledger=self.scratch / "ledger.jsonl", **kw)

    def test_env_pins_cache_target_dir_jobs_and_disables_auto_install(self):
        env = build_env("demo", self.scratch, self.cache, jobs=3, base={"PATH": "/usr/bin"})
        self.assertEqual(env["CARGO_TARGET_DIR"], str(self.scratch / "build" / "demo" / "cargo"))
        self.assertEqual((env["RUSTUP_AUTO_INSTALL"], env["CARGO_BUILD_JOBS"]), ("0", "3"))
        self.assertEqual(env["RUSTUP_HOME"], str(self.cache / "rustup"))
        self.assertTrue(env["PATH"].startswith(str(self.cache / "cargo" / "bin")))
        self.assertEqual(env["TMPDIR"], str(self.scratch / "tmp"))
        self.assertEqual(pinned_toolchain(self.repo), CHANNEL)

    def test_refuses_missing_toolchain_memory_disk_and_bad_project(self):
        (self.repo / "rust-toolchain.toml").write_text('[toolchain]\nchannel = "nightly-2099-01-01"\n')
        self.memory(used=3400 * MiB)
        problems = preflight("demo", self.repo, 1100 * MiB, 1 << 60, self.scratch, self.cache, self.cgroup)
        self.assertEqual([p.split()[0] for p in problems], ["pinned", "memory:", "disk:"])
        self.assertEqual(preflight("../etc", self.repo, 1, 1, self.scratch, self.cache, self.cgroup),
                         ["project must be a plain name"])
        result = self.run_build([sys.executable, "-c", "open('ran','w')"], expect=1100 * MiB)
        self.assertEqual(result["status"], "refused")
        self.assertFalse((self.repo / "ran").exists())

    def test_runs_in_repo_and_records_measured_peak_in_ledger(self):
        result = self.run_build([sys.executable, "-c", "import os; b = bytearray(80 << 20); open('ran','w').write(os.environ['CARGO_TARGET_DIR'])"],
                                expect=20 * MiB)
        self.assertEqual((result["status"], result["exit"]), ("ok", 0))
        self.assertEqual((self.repo / "ran").read_text(), str(self.scratch / "build" / "demo" / "cargo"))
        self.assertGreaterEqual(result["peak_rss_mib"], 80)
        self.assertIn("raise --expect", result["warning"])
        ledger = [json.loads(line) for line in (self.scratch / "ledger.jsonl").read_text().splitlines()]
        self.assertEqual(ledger[-1]["peak_rss_mib"], result["peak_rss_mib"])
        self.assertGreaterEqual(result["peak_mib"], result["peak_rss_mib"])

    def test_one_build_per_target_dir(self):
        target = self.scratch / "build" / "demo"; target.mkdir(parents=True)
        with (target / ".build.lock").open("a") as held:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = self.run_build([sys.executable, "-c", "open('ran','w')"])
        self.assertEqual(result["problems"], ["another build owns " + str(target)])
        self.assertFalse((self.repo / "ran").exists())

    def test_watchdog_stops_the_build_before_the_cgroup_limit(self):
        squeeze = ("import pathlib, time; pathlib.Path(%r).write_text(str((4 << 30) - (100 << 20))); time.sleep(30)"
                   % str(self.cgroup / "memory.current"))
        started = time.monotonic()
        result = self.run_build([sys.executable, "-c", squeeze], interval=0.05)
        self.assertEqual(result["status"], "aborted_memory")
        self.assertLess(time.monotonic() - started, 10)
        self.assertLess(result["watchdog"]["limit"] - result["watchdog"]["used"], 256 * MiB)

    def test_group_rss_sums_only_the_build_process_group(self):
        proc = self.scratch / "proc"
        def fake(pid, pgrp, resident_pages, comm="cc1 (x)"):
            (proc / str(pid)).mkdir(parents=True)
            (proc / str(pid) / "stat").write_text("%d (%s) S 1 %d 0 0" % (pid, comm, pgrp))
            (proc / str(pid) / "statm").write_text("999 %d 0 0 0 0 0" % resident_pages)
        fake(10, 10, 100); fake(11, 10, 200); fake(12, 10, 300, comm="rustc) (odd")
        fake(20, 20, 5000)                                    # another group: not this build
        (proc / "self").mkdir(); (proc / "13").mkdir()        # junk and a process that vanished
        self.assertEqual(group_rss(10, proc, page_size=4096), 600 * 4096)

    def test_whole_tree_peak_counts_parallel_children(self):
        # Three children hold 40 MiB each at the same time: the largest single process is ~40 MiB,
        # the build as a whole ~120 MiB. The ledger and the warning must use the whole tree.
        script = ("import subprocess,sys; "
                  "kids=[subprocess.Popen([sys.executable,'-c','import time; b=bytearray(40<<20); b[::4096]=b\"x\"*len(b[::4096]); time.sleep(1.5)']) for _ in range(3)]; "
                  "[k.wait() for k in kids]")
        result = self.run_build([sys.executable, "-c", script], expect=60 * MiB, interval=0.1)
        self.assertEqual(result["status"], "ok", result)
        self.assertLess(result["peak_rss_mib"], 100)
        self.assertGreaterEqual(result["peak_mib"], 110)
        self.assertIn("raise --expect", result["warning"])            # 40 < 60 < whole tree
        ledger = [json.loads(line) for line in (self.scratch / "ledger.jsonl").read_text().splitlines()]
        self.assertEqual(ledger[-1]["peak_mib"], result["peak_mib"])

    def test_cgroup_growth_is_recorded(self):
        grow = ("import pathlib,time; pathlib.Path(%r).write_text(str((1 << 30) + (300 << 20))); time.sleep(1)"
                % str(self.cgroup / "memory.current"))
        result = self.run_build([sys.executable, "-c", grow], expect=900 * MiB, interval=0.1)
        self.assertEqual(result["peak_cgroup_delta_mib"], 300)

    def test_expect_auto_uses_only_comparable_successful_runs(self):
        ledger = self.scratch / "ledger.jsonl"
        build = ["cargo", "build"]
        self.assertIsNone(ledger_estimate(ledger, "demo", build, 2))
        ledger.write_text("\n".join(json.dumps(r) for r in [
            {"project": "demo", "command": build, "jobs": 2, "status": "ok", "peak_mib": 800},
            {"project": "demo", "command": build, "jobs": 2, "status": "ok", "peak_mib": 1200},
            {"project": "demo", "command": build, "jobs": 2, "status": "aborted_memory", "peak_mib": 3900},
            {"project": "demo", "command": ["cargo", "test"], "jobs": 2, "status": "ok", "peak_mib": 2600},
            {"project": "demo", "command": build, "jobs": 1, "status": "ok", "peak_mib": 700},
            {"project": "demo", "command": build, "jobs": 8, "status": "ok", "peak_mib": 400},
            {"project": "other", "command": build, "jobs": 2, "status": "ok", "peak_mib": 9000},
            {"project": "demo", "command": build, "jobs": 2, "status": "ok", "peak_rss_mib": 5000}]) + "\nnot json\n")
        self.assertEqual(ledger_estimate(ledger, "demo", build, 2), 1500 * MiB)       # same jobs, ok only
        self.assertEqual(ledger_estimate(ledger, "demo", build, 4), 3500 * MiB)       # 700 @1 job scaled x4, never 400 @8
        self.assertIsNone(ledger_estimate(ledger, "demo", ["make"], 2))               # another command: no history
        self.assertIsNone(ledger_estimate(ledger, "fresh", build, 2))                  # another project: no history
        only_more = self.scratch / "only-more-jobs.jsonl"
        only_more.write_text(json.dumps({"project": "demo", "command": build, "jobs": 8, "status": "ok", "peak_mib": 4000}) + "\n")
        self.assertIsNone(ledger_estimate(only_more, "demo", build, 4))               # never scaled down from more jobs
        ledger.write_text(json.dumps({"project": "tiny", "command": build, "jobs": 1, "status": "ok", "peak_mib": 0}) + "\n")
        self.assertEqual(ledger_estimate(ledger, "tiny", build, 1), 256 * MiB)        # a peak of 0 never admits 0
        with self.assertRaises(SystemExit):
            main(["--project", "fresh", "--repo", str(self.repo), "--expect", "auto", "--disk", "1M",
                  "--ledger", str(ledger), "--", "true"])

    def test_unreadable_cgroup_baseline_records_null_delta(self):
        for name in ("memory.max", "memory.current", "memory.stat"): (self.cgroup / name).unlink()
        result = self.run_build([sys.executable, "-c", "pass"], expect=100 * MiB, interval=0.1)
        self.assertEqual(result["status"], "ok", result)
        self.assertIsNone(result["peak_cgroup_delta_mib"])

    def test_pids_admission_scales_with_jobs(self):
        self.assertEqual(pids_usage(self.cgroup), (None, None))                        # no pids controller
        self.assertTrue(admit_pids(8, self.cgroup)["admitted"])
        self.tasks(current=221)
        self.assertEqual(pids_usage(self.cgroup), (221, 512))
        self.assertGreater(pids_needed(8), pids_needed(2))
        self.assertTrue(admit_pids(2, self.cgroup)["admitted"])                        # 512-221-64 = 227 >= 64
        self.tasks(current=400)                                                         # vitest runs elsewhere
        self.assertTrue(admit_pids(1, self.cgroup)["admitted"])                        # 48 <= 48
        refused = admit_pids(2, self.cgroup)
        self.assertFalse(refused["admitted"])
        self.assertIn("--jobs 2", refused["reason"]); self.assertIn("400 of 512", refused["reason"])
        self.assertIn("--pids-limit", refused["reason"])
        self.tasks(current=0, limit=128)
        self.assertTrue(admit_pids(2, self.cgroup)["satisfiable"])                     # 64 + 64 = 128: fits exactly
        self.assertFalse(admit_pids(3, self.cgroup)["satisfiable"])
        self.tasks(current=400, limit="max")
        self.assertTrue(admit_pids(8, self.cgroup)["admitted"])
        (self.cgroup / "pids.current").write_text("garbage")
        self.assertTrue(admit_pids(8, self.cgroup)["admitted"])                        # unreadable: not a limit

    def test_refuses_build_without_task_headroom(self):
        self.tasks(current=480)
        problems = preflight("demo", self.repo, 1, 1, self.scratch, self.cache, self.cgroup, disk_reserve=0, jobs=2)
        self.assertEqual([p.split()[0] for p in problems], ["pids:"])
        result = self.run_build([sys.executable, "-c", "open('ran','w')"])
        self.assertEqual(result["status"], "refused")
        self.assertFalse((self.repo / "ran").exists())

    def test_wait_queues_until_tasks_free_up(self):
        self.tasks(current=480)
        free = threading.Timer(0.3, lambda: self.tasks(current=100)); free.start(); self.addCleanup(free.cancel)
        result = self.run_build([sys.executable, "-c", "open('ran','w')"], wait=5, poll=0.1)
        self.assertEqual(result["status"], "ok", result)
        self.assertTrue((self.repo / "ran").exists())
        self.assertLess(result["waited_s"], 5)
        self.tasks(current=480)
        started = time.monotonic()
        result = self.run_build([sys.executable, "-c", "pass"], wait=0.3, poll=0.1)
        self.assertEqual(result["status"], "refused")
        self.assertGreaterEqual(result["waited_s"], 0.3)
        self.assertLess(time.monotonic() - started, 3)
        # A wait shorter than the poll interval still rechecks once at the deadline.
        free = threading.Timer(0.2, lambda: self.tasks(current=100)); free.start(); self.addCleanup(free.cancel)
        started = time.monotonic()
        result = self.run_build([sys.executable, "-c", "pass"], wait=0.5, poll=10)
        self.assertEqual(result["status"], "ok", result)
        self.assertLess(time.monotonic() - started, 3)                                # slept to the deadline, not a full poll
        self.tasks(current=0, limit=100)                                                # 64 reserve + 64 for --jobs 2 > 100
        started = time.monotonic()
        result = self.run_build([sys.executable, "-c", "pass"], wait=30, poll=0.1)   # can never be admitted
        self.assertEqual([p.split()[0] for p in result["problems"]], ["pids-limit:"])
        self.assertIn("waiting cannot help", result["problems"][0])
        self.assertLess(time.monotonic() - started, 3)
        (self.repo / "rust-toolchain.toml").write_text('[toolchain]\nchannel = "nightly-2099-01-01"\n')
        started = time.monotonic()
        result = self.run_build([sys.executable, "-c", "pass"], wait=30, poll=0.1)   # cannot clear by waiting
        self.assertEqual(result["status"], "refused")
        self.assertLess(time.monotonic() - started, 3)

    def test_task_growth_is_recorded(self):
        self.tasks(current=100)
        grow = "import pathlib,time; pathlib.Path(%r).write_text('137'); time.sleep(1)" % str(self.cgroup / "pids.current")
        result = self.run_build([sys.executable, "-c", grow], interval=0.1)
        self.assertEqual(result["peak_pids_delta"], 37)
        for name in ("pids.max", "pids.current"): (self.cgroup / name).unlink()
        self.assertIsNone(self.run_build([sys.executable, "-c", "pass"], interval=0.1)["peak_pids_delta"])

    def vitest_repo(self):
        entry = self.repo / "node_modules" / "vitest" / "vitest.mjs"; entry.parent.mkdir(parents=True)
        entry.write_text(FAKE_VITEST)
        (self.repo / "config").mkdir(); (self.repo / "config" / "vitest.ci.config.ts").write_text("")
        (self.repo / "test").mkdir()
        for name in ("a.test.ts", "b.test.ts", "helper.ts"): (self.repo / "test" / name).write_text("")
        return [sys.executable, "node_modules/vitest/vitest.mjs", "run", "--config", "config/vitest.ci.config.ts"]

    def cli(self, *argv):
        """main() against this test's scratch/cgroup; returns (exit code, stdout bytes, stderr bytes, ledger)."""
        real, ledger = run, self.scratch / "cli-ledger.jsonl"
        isolated = lambda *a, **kw: real(*a, **dict(kw, scratch=self.scratch, rust_cache=self.cache, cgroup=self.cgroup,
                                                    disk_reserve=0))
        out, err = io.TextIOWrapper(io.BytesIO()), io.TextIOWrapper(io.BytesIO())
        with mock.patch.object(reverie.buildenv, "run", isolated), redirect_stdout(out), redirect_stderr(err):
            code = main(["--project", "demo", "--repo", str(self.repo), "--expect", "100M", "--disk", "1M",
                         "--ledger", str(ledger)] + list(argv))
        out.flush(); err.flush()
        return code, out.buffer.getvalue(), err.buffer.getvalue(), json.loads(ledger.read_text().splitlines()[-1])

    def test_expect_files_fails_when_vitest_runs_fewer_files(self):
        vitest = self.vitest_repo()
        code, out, err, entry = self.cli("--expect-files", "2", "--", *vitest, "test/a.test.ts", "test/typo.test.ts")
        self.assertEqual(code, EX_FEWER_FILES)
        self.assertEqual(err.decode().splitlines()[-1], "buildenv: expected 2 test files, vitest ran 1")
        self.assertEqual((entry["status"], entry["exit"], entry["expected_files"], entry["ran_files"]),
                         ("fewer-files", 0, 2, 1))
        self.assertEqual(json.loads(out.decode().splitlines()[-1]), entry)          # the JSON line stays last
        self.assertIn(b"Test Files", out); self.assertIn(b"vitest stderr line", err)  # child output still streams
        self.assertEqual(out.count(b"x" * 99 + b"\n"), 1024)                        # all of it, not just the tail

    def test_expect_files_met_keeps_the_childs_result(self):
        vitest = self.vitest_repo()
        code, out, _, entry = self.cli("--expect-files", "2", "--", *vitest, "test/a.test.ts", "test/b.test.ts")
        self.assertEqual((code, entry["status"], entry["expected_files"], entry["ran_files"]), (0, "ok", 2, 2))
        code, _, _, entry = self.cli("--expect-files", "1", "--", *vitest, "test/a.test.ts", "test/b.test.ts")
        self.assertEqual((code, entry["status"], entry["ran_files"]), (0, "ok", 2))   # more than expected is fine
        code, _, _, entry = self.cli("--expect-files", "1", "--", sys.executable, "-c",
                                     "print(' Test Files  1 failed (1)'); raise SystemExit(3)")
        self.assertEqual((code, entry["status"], entry["exit"], entry["ran_files"]), (3, "failed", 3, 1))

    def test_expect_files_fails_without_a_summary_line(self):
        vitest = self.vitest_repo()
        code, out, err, entry = self.cli("--expect-files", "1", "--", *vitest, "test/gone.test.ts")
        self.assertIn(b"No test files found", out)
        self.assertEqual(code, EX_FEWER_FILES)
        self.assertEqual(err.decode().splitlines()[-1],
                         "buildenv: expected 1 test files, vitest ran none (no 'Test Files' summary line)")
        self.assertEqual((entry["status"], entry["exit"], entry["ran_files"]), ("fewer-files", 0, None))
        with self.assertRaises(SystemExit), redirect_stderr(io.StringIO()):
            self.cli("--expect-files", "some", "--", "true")
        with self.assertRaises(SystemExit), redirect_stderr(io.StringIO()):
            self.cli("--expect-files", "0", "--", "true")

    def test_expect_files_auto_counts_test_file_arguments(self):
        vitest = self.vitest_repo()
        named = ["test/a.test.ts",         # exists, test suffix
                 "test/missing.test.ts",   # missing, test suffix: still expected
                 "test/helper.ts",         # exists: expected
                 "test/typo.tset.ts",      # neither: a filter auto cannot count (give N)
                 "-t", "some name", "--reporter=dot", "--silent"]
        self.assertEqual(count_test_files(vitest + named, self.repo), 3)              # entry and --config value skipped
        self.assertEqual(count_test_files(["npx", "vitest", "run", "x.spec.ts", "src/y.test.mjs"], self.repo), 2)
        self.assertEqual(count_test_files(["npx", "vitest", "run", "chat"], self.repo), 0)
        code, _, err, entry = self.cli("--expect-files", "auto", "--", *vitest, "test/a.test.ts", "test/missing.test.ts")
        self.assertEqual((code, entry["expected_files"], entry["ran_files"]), (EX_FEWER_FILES, 2, 1))
        self.assertIn(b"expected 2 test files, vitest ran 1", err)
        with self.assertRaises(SystemExit), redirect_stderr(io.StringIO()):
            self.cli("--expect-files", "auto", "--", *vitest, "chat")                  # nothing countable: give N

    def test_vitest_summary_parsing(self):
        self.assertEqual(vitest_file_count(b" Test Files  1 failed | 2 passed (3)\n      Tests  9 passed (9)\n"), 3)
        self.assertEqual(vitest_file_count(b"\x1b[2m Test Files \x1b[22m \x1b[1m\x1b[32m4 passed\x1b[39m\x1b[22m"
                                           b"\x1b[90m (4)\x1b[39m\r\n"), 4)
        self.assertEqual(vitest_file_count(b" Test Files  1 passed (1)\n...\n Test Files  5 passed | 1 skipped (6)\n"), 6)
        self.assertIsNone(vitest_file_count(b"No test files found, exiting with code 0\n"))
        self.assertIsNone(vitest_file_count(b"      Tests  9 passed (9)\n"))

    def test_tee_keeps_only_a_bounded_tail(self):
        read, write = os.pipe()
        sink = io.TextIOWrapper(io.BytesIO())
        tee = reverie.buildenv.Tee(os.fdopen(read, "rb"), sink); tee.start()
        with os.fdopen(write, "wb") as pipe: pipe.write(b"y" * (200 << 10) + b"\n Test Files  2 passed (2)\n")
        tee.join(5)
        self.assertEqual(len(tee.tail), reverie.buildenv.TAIL_BYTES)
        self.assertEqual(len(sink.buffer.getvalue()), (200 << 10) + 27)               # everything passed through
        self.assertEqual(vitest_file_count(tee.tail), 2)

    def test_without_expect_files_output_and_ledger_are_unchanged(self):
        probe = "import os; s = os.fstat(1); open('fd1', 'w').write('%d %d' % (s.st_dev, s.st_ino))"
        mine = os.fstat(1)
        result = self.run_build([sys.executable, "-c", probe])
        self.assertEqual(set(result), LEDGER_FIELDS)                                  # no new fields
        self.assertEqual((self.repo / "fd1").read_text(), "%d %d" % (mine.st_dev, mine.st_ino))  # inherited, not piped
        out = io.TextIOWrapper(io.BytesIO())
        with redirect_stdout(out):
            result = self.run_build([sys.executable, "-c", probe], expect_files=1)
        self.assertNotEqual((self.repo / "fd1").read_text(), "%d %d" % (mine.st_dev, mine.st_ino))  # teed
        self.assertEqual(set(result), LEDGER_FIELDS | {"expected_files", "ran_files"})
        code, out, err, entry = self.cli("--", sys.executable, "-c", "print(' Test Files  0 passed (0)'); raise SystemExit(5)")
        self.assertEqual((code, entry["status"], set(entry)), (5, "failed", LEDGER_FIELDS))
        self.assertEqual(err, b"")

    def runner_cli(self, scratch, command):
        # Exercise real preflight, child process, watchdog and ledger; only the
        # cgroup/filesystem reserve are isolated from the developer's laptop.
        def isolated(*args, **kw):
            return run(*args, **dict(kw, cgroup=self.cgroup, disk_reserve=0))
        with mock.patch.object(reverie.buildenv, "run", isolated), redirect_stdout(io.StringIO()):
            return main(["--project", "runner", "--repo", str(self.repo),
                         "--scratch", str(scratch), "--expect", "100M", "--disk", "1M",
                         "--jobs", "1", "--", *command])

    def test_cli_runner_scratch_executes_child_and_keeps_all_paths_in_selected_root(self):
        (self.repo / "rust-toolchain.toml").unlink()
        scratch = Path(self.temp.name) / "runner-temp" / "fresh-build"
        self.assertFalse(scratch.exists())
        probe = "import json,os,tempfile; f=tempfile.NamedTemporaryFile(); open('env.json','w').write(json.dumps(dict(os.environ), sort_keys=True)); open('temp-path','w').write(f.name)"
        with mock.patch.object(reverie.buildenv, "SCRATCH", Path("/missing-laptop-only-scratch")):
            code = self.runner_cli(scratch, [sys.executable, "-c", probe])
        self.assertEqual(code, 0)
        env = json.loads((self.repo / "env.json").read_text())
        for name in ("CARGO_TARGET_DIR", "CARGO_HOME", "RUSTUP_HOME", "TMPDIR"):
            self.assertTrue(Path(env[name]).is_relative_to(scratch), (name, env[name]))
        self.assertTrue(Path((self.repo / "temp-path").read_text()).is_relative_to(scratch / "tmp"))
        ledger = json.loads((scratch / "profiles" / "build-ledger.jsonl").read_text())
        self.assertEqual((ledger["status"], ledger["exit"]), ("ok", 0))
        self.assertTrue((scratch / "build" / "runner" / ".build.lock").exists())

    def test_cli_runner_scratch_does_not_bypass_memory_admission(self):
        (self.repo / "rust-toolchain.toml").unlink()
        self.memory(used=3500 * MiB)
        scratch = Path(self.temp.name) / "runner-refused"
        code = self.runner_cli(scratch, [sys.executable, "-c", "open('ran','w')"])
        self.assertEqual(code, EX_TEMPFAIL)
        self.assertFalse((self.repo / "ran").exists())

    def test_cli_bad_scratch_refuses_before_starting_child(self):
        scratch = Path(self.temp.name) / "not-a-directory"
        scratch.write_text("file")
        with self.assertRaises(SystemExit) as caught, redirect_stderr(io.StringIO()):
            self.runner_cli(scratch, [sys.executable, "-c", "open('ran','w')"])
        self.assertEqual(caught.exception.code, 2)
        self.assertFalse((self.repo / "ran").exists())

    def test_cli_requires_estimates_and_exits_tempfail_when_refused(self):
        with self.assertRaises(SystemExit): main(["--project", "demo", "--", "true"])        # no --expect/--disk
        isolated = lambda *a, **kw: run(*a, **dict(kw, scratch=self.scratch, rust_cache=self.cache, cgroup=self.cgroup))
        with mock.patch("reverie.buildenv.run", side_effect=isolated):
            code = main(["--project", "demo", "--repo", str(self.repo), "--expect", "1G", "--disk", "1000000G",
                         "--ledger", str(self.scratch / "l.jsonl"), "--", "true"])
        self.assertEqual(code, EX_TEMPFAIL)


if __name__ == "__main__": unittest.main()
