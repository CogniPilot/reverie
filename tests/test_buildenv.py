import tests  # noqa: F401  isolates CODEMAN_*/FLEET_* before cto is imported
import fcntl
import json
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

from cto.buildenv import (EX_TEMPFAIL, admit_pids, build_env, group_rss, ledger_estimate, main, pids_needed, pids_usage,
                          pinned_toolchain, preflight, run)

MiB = 1 << 20
CHANNEL = "nightly-2026-02-27"


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

    def test_cli_requires_estimates_and_exits_tempfail_when_refused(self):
        with self.assertRaises(SystemExit): main(["--project", "demo", "--", "true"])        # no --expect/--disk
        code = main(["--project", "demo", "--repo", str(self.repo), "--expect", "1G", "--disk", "1000000G",
                     "--ledger", str(self.scratch / "l.jsonl"), "--", "true"])
        self.assertEqual(code, EX_TEMPFAIL)


if __name__ == "__main__": unittest.main()
