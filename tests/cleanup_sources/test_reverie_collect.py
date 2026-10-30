"""Tests for reverie_collect.py r2. Run from a /tmp copy: python3 -I -B -X dev test_reverie_collect.py"""
import fcntl, importlib.util, json, os, shutil, tempfile, unittest
from unittest import mock

HERE = os.path.dirname(os.path.realpath(__file__))
spec = importlib.util.spec_from_file_location("rc", os.path.join(HERE, "reverie_collect.py"))
rc = importlib.util.module_from_spec(spec); spec.loader.exec_module(rc)

T0 = 1792940400  # an hour boundary (2026-10-25T13:00:00Z)


def put(path, text):
    with open(path, "w") as f:
        f.write(text)


class Env:
    def __init__(self):
        self.root = tempfile.mkdtemp(prefix="rc-test-")
        self.proc = os.path.join(self.root, "proc"); os.makedirs(self.proc)
        self.sys = os.path.join(self.root, "sys"); os.makedirs(self.sys)
        self.out = os.path.join(self.root, "out")
        self.d1 = os.path.join(self.root, "drive1"); os.makedirs(self.d1)
        self.logs = os.path.join(self.root, "prune-logs"); os.makedirs(self.logs)
        self.set_cpu(1000, 900); self.set_mem(8 << 20, 6 << 20)
        put(os.path.join(self.proc, "loadavg"), "0.50 0.40 0.30 1/100 42\n")

    def set_cpu(self, total, idle):
        put(os.path.join(self.proc, "stat"),
            f"cpu  {total - idle} 0 0 {idle} 0 0 0 0 0 0\ncpu0 1 0 0 1 0 0 0 0 0 0\ncpu1 1 0 0 1 0 0 0 0 0 0\n")

    def set_mem(self, total_kib, avail_kib):
        put(os.path.join(self.proc, "meminfo"), f"MemTotal: {total_kib} kB\nMemAvailable: {avail_kib} kB\n")

    def cfg(self, **over):
        c = dict(rc.DEFAULTS, out_dir=self.out, drives={"scratch": self.d1, "missing": os.path.join(self.root, "nope")},
                 prune_log_dir=self.logs, proc_root=self.proc, sys_root=self.sys, nvidia_smi="no-such-nvidia-smi")
        c.update(over)
        return c

    def seed_state(self, total=0, idle=0):
        os.makedirs(self.out, exist_ok=True)
        put(os.path.join(self.out, "state.json"), json.dumps({"cpu": [total, idle]}))

    def summary(self, rid, mode="dry", exit=0, nbytes=1024, **extra):
        body = {"run_id": rid, "mode": mode, "exit": exit, "passes": ["high-water"], "deleted_or_would_bytes": nbytes,
                "by_decision": {"WOULD_DELETE" if mode == "dry" else "DELETED": 1}, "ceiling_hit": False, **extra}
        put(os.path.join(self.logs, f"{rid}.summary.json"), json.dumps(body))

    def lines(self, name):
        return rc.read_lines(os.path.join(self.out, name), self.cfg())

    def rollups(self, prefix):
        return [r for f in sorted(os.listdir(self.out)) if f.startswith(prefix) for r in self.lines(f)]

    def close(self):
        shutil.rmtree(self.root)


class Tests(unittest.TestCase):
    def setUp(self):
        self.e = Env()

    def tearDown(self):
        self.e.close()

    # ---- r1 behaviour kept
    def test_sample_shape_and_superset_of_interim_feed(self):
        self.e.seed_state()
        code, s = rc.sample_once(self.e.cfg(), now=T0 + 10)
        self.assertEqual(code, 0)
        for k in ("t", "cpu_pct", "mem_pct", "gpu_pct", "drives"):
            self.assertIn(k, s)
        self.assertEqual((s["cpu_pct"], s["mem_pct"], s["cpu"]["cores"]), (10.0, 25.0, 2))
        self.assertEqual(s["drives"]["missing"]["status"], "error")
        self.assertIsNone(s["label"])
        self.assertEqual(self.e.lines("samples-2026-10-25.jsonl"), [s])

    def test_cpu_averages_between_samples(self):
        self.e.seed_state()
        rc.sample_once(self.e.cfg(), now=T0)
        self.e.set_cpu(3000, 1900)
        self.assertEqual(rc.sample_once(self.e.cfg(), now=T0 + 300)[1]["cpu_pct"], 50.0)

    def test_gpu_unavailable_is_null_never_zero_and_sources(self):
        self.e.seed_state()
        _, s = rc.sample_once(self.e.cfg(), now=T0)
        self.assertEqual((s["gpu_pct"], s["gpu"]["status"]), (None, "unavailable"))
        fake = os.path.join(self.e.root, "nvidia-smi")
        put(fake, "#!/bin/sh\necho '0, 40, 100, 8000'\necho '1, 60, 200, 8000'\n"); os.chmod(fake, 0o755)
        _, s = rc.sample_once(self.e.cfg(nvidia_smi=fake), now=T0 + 1)
        self.assertEqual((s["gpu"]["source"], s["gpu_pct"]), ("nvidia-smi", 50.0))
        dev = os.path.join(self.e.sys, "class", "drm", "card0", "device"); os.makedirs(dev)
        put(os.path.join(dev, "gpu_busy_percent"), "33\n")
        _, s = rc.sample_once(self.e.cfg(), now=T0 + 2)
        self.assertEqual((s["gpu"]["source"], s["gpu_pct"]), ("sysfs", 33.0))

    def test_retention_deletes_only_own_files(self):
        os.makedirs(self.e.out)
        for n in ("samples-2026-09-01.jsonl", "notes.txt", "rollup-hour-2025-01.jsonl", "samples-2026-10-24.jsonl"):
            put(os.path.join(self.e.out, n), "{}\n")
        os.symlink("/etc/hostname", os.path.join(self.e.out, "samples-2026-01-01.jsonl"))
        self.e.seed_state()
        rc.sample_once(self.e.cfg(), now=T0)
        left = set(os.listdir(self.e.out))
        self.assertFalse({"samples-2026-09-01.jsonl", "rollup-hour-2025-01.jsonl"} & left)
        self.assertTrue({"notes.txt", "samples-2026-10-24.jsonl", "samples-2026-01-01.jsonl"} <= left)

    def test_lock_busy_and_symlinked_out_dir(self):
        os.makedirs(self.e.out)
        fd = os.open(os.path.join(self.e.out, ".lock"), os.O_RDWR | os.O_CREAT)
        fcntl.flock(fd, fcntl.LOCK_EX)
        try:
            self.assertEqual(rc.sample_once(self.e.cfg(), now=T0)[0], rc.EXIT_BUSY)
        finally:
            os.close(fd)
        link = os.path.join(self.e.root, "linked-out"); os.symlink(self.e.out, link)
        with self.assertRaises(rc.ConfigError):
            rc.sample_once(self.e.cfg(out_dir=link), now=T0)

    def test_config_validation_and_cli(self):
        p = os.path.join(self.e.root, "c.toml")
        for body in ('bogus = 1\n', 'interval_s = 0\n', 'gpu = "maybe"\n', 'drives = ["x"]\n', 'max_prune_join = true\n'):
            put(p, body)
            with self.assertRaises(rc.ConfigError, msg=body):
                rc.load_config(p)
        put(p, f'out_dir = "{self.e.out}"\nproc_root = "{self.e.proc}"\nsys_root = "{self.e.sys}"\n'
               f'drives = {{ scratch = "{self.e.d1}" }}\nnvidia_smi = "no-such"\n')
        self.e.seed_state()
        self.assertEqual(rc.main(["--config", p, "once"]), 0)

    # ---- H1-1: checkpoint failure never duplicates committed output
    def test_checkpoint_failure_does_not_duplicate_prune_runs_or_rollups(self):
        self.e.seed_state()
        self.e.summary("r1")
        rc.sample_once(self.e.cfg(), now=T0)
        for i in range(1, 13):
            rc.sample_once(self.e.cfg(), now=T0 + i * 300)            # closes hour T0 at the 13th sample
        before_runs, before_hours = self.e.lines("prune-runs.jsonl"), self.e.rollups("rollup-hour")
        # Fail the checkpoint AFTER the sample, prune and rollup appends, three times in a row, then recover.
        with mock.patch.object(rc, "write_state", side_effect=OSError("disk full")):
            for k in range(3):
                with self.assertRaises(OSError):
                    rc.sample_once(self.e.cfg(), now=T0 + 3600 + 300 * (k + 1))
        rc.sample_once(self.e.cfg(), now=T0 + 3600 + 1500)
        runs = self.e.lines("prune-runs.jsonl")
        self.assertEqual([r["run_id"] for r in runs], ["r1"])           # committed once
        starts = [r["start"] for r in self.e.rollups("rollup-hour")]
        self.assertEqual(len(starts), len(set(starts)))                 # each hour once
        self.assertEqual(len(before_runs), 1)
        self.assertEqual(len(before_hours), 1)

    def test_state_loss_resumes_after_last_committed_period(self):
        self.e.seed_state()
        for i in range(0, 25):                                          # two hours of samples
            rc.sample_once(self.e.cfg(), now=T0 + i * 300)
        os.unlink(os.path.join(self.e.out, "state.json"))               # state lost
        for i in range(25, 37):                                         # a third hour
            rc.sample_once(self.e.cfg(), now=T0 + i * 300)
        starts = [r["start"] for r in self.e.rollups("rollup-hour")]
        self.assertEqual(starts, [T0, T0 + 3600, T0 + 7200][:len(starts)])
        self.assertEqual(len(starts), len(set(starts)))
        self.assertIn(T0 + 3600, starts)                                # not skipped after the state loss

    def test_truncated_last_line_is_repaired_and_skipped(self):
        self.e.seed_state()
        rc.sample_once(self.e.cfg(), now=T0)
        day = os.path.join(self.e.out, "samples-2026-10-25.jsonl")
        with open(day, "a") as f:
            f.write('{"t": 17929')                                       # a crash mid-write
        rc.sample_once(self.e.cfg(), now=T0 + 300)
        recs, bad = rc.read_lines_counted(day, self.e.cfg())
        self.assertEqual(([r["t"] for r in recs], bad), ([T0, T0 + 300], 1))

    # ---- H1-2: dry-run estimates are never reclaimed bytes
    def test_dry_live_partial_failed_are_separate(self):
        self.e.seed_state()
        self.e.summary("d1", "dry", 0, 1000)
        self.e.summary("l1", "live", 0, 700)
        self.e.summary("p1", "live", 4, 50)
        self.e.summary("f1", "dry", 2, 9999)
        for i in range(0, 13):
            rc.sample_once(self.e.cfg(), now=T0 + i * 300)
        runs = {r["run_id"]: r for r in self.e.lines("prune-runs.jsonl")}
        self.assertEqual((runs["d1"]["would_delete_bytes"], runs["d1"]["deleted_bytes"]), (1000, 0))
        self.assertEqual((runs["l1"]["would_delete_bytes"], runs["l1"]["deleted_bytes"]), (0, 700))
        self.assertEqual((runs["p1"]["status"], runs["f1"]["status"]), ("partial", "failed"))
        h = self.e.rollups("rollup-hour")[0]
        self.assertEqual(h["prune_bytes_by_mode"], {"dry_would_delete": 1000 + 9999, "live_deleted": 700 + 50})
        self.assertEqual(h["prune_bytes"], 700 + 50)                   # live deletions only
        self.assertEqual((h["prune_runs_dry"], h["prune_runs_live"], h["prune_runs_partial"], h["prune_runs_failed"]),
                         (2, 2, 1, 1))

    def test_dry_only_rollup_reports_zero_deleted(self):
        self.e.seed_state()
        self.e.summary("d1", "dry", 0, 1024)
        for i in range(0, 13):
            rc.sample_once(self.e.cfg(), now=T0 + i * 300)
        h = self.e.rollups("rollup-hour")[0]
        self.assertEqual((h["prune_bytes_by_mode"]["live_deleted"], h["prune_bytes"]), (0, 0))

    # ---- H1-3: bounded, validated, abort-proof input
    def test_malformed_and_wrong_shape_summaries_never_abort(self):
        self.e.seed_state()
        put(os.path.join(self.e.logs, "list.summary.json"), "[1, 2, 3]")
        put(os.path.join(self.e.logs, "junk.summary.json"), "{not json")
        put(os.path.join(self.e.logs, "neg.summary.json"), json.dumps({"run_id": "neg", "mode": "dry", "exit": 0,
                                                                         "deleted_or_would_bytes": -5}))
        put(os.path.join(self.e.logs, "mode.summary.json"), json.dumps({"run_id": "mode", "mode": "x", "exit": 0}))
        put(os.path.join(self.e.logs, "nan.summary.json"), '{"run_id": "nan", "mode": "dry", "exit": 0, "deleted_or_would_bytes": NaN}')
        put(os.path.join(self.e.logs, "big.summary.json"), json.dumps({"run_id": "big", "mode": "dry", "exit": 0, "pad": "x" * 5000}))
        os.symlink("/etc/passwd", os.path.join(self.e.logs, "evil.summary.json"))
        self.e.summary("good")
        code, s = rc.sample_once(self.e.cfg(max_input_bytes=4096), now=T0)
        self.assertEqual(code, 0)
        self.assertEqual([r["run_id"] for r in s["prune"]], ["good"])
        bad = {e["file"] for e in s["prune_errors"]}
        self.assertEqual(bad, {"list.summary.json", "junk.summary.json", "neg.summary.json", "mode.summary.json",
                               "nan.summary.json", "big.summary.json", "evil.summary.json"})
        self.assertIsNotNone(s["cpu_pct"])                              # other readings kept

    def test_join_is_bounded_with_backlog(self):
        self.e.seed_state()
        for i in range(5):
            self.e.summary(f"r{i}")
        _, s1 = rc.sample_once(self.e.cfg(max_prune_join=2), now=T0)
        _, s2 = rc.sample_once(self.e.cfg(max_prune_join=2), now=T0 + 300)
        self.assertEqual((len(s1["prune"]), s1["prune_backlog"], len(s2["prune"])), (2, 3, 2))

    def test_bad_readings_are_errors_not_values(self):
        self.e.seed_state()
        put(os.path.join(self.e.proc, "meminfo"), "garbage\n")
        put(os.path.join(self.e.proc, "stat"), "nope\n")
        fake = os.path.join(self.e.root, "nvidia-smi")
        put(fake, "#!/bin/sh\necho '0, nan, 1, 2'\n"); os.chmod(fake, 0o755)
        code, s = rc.sample_once(self.e.cfg(nvidia_smi=fake), now=T0)
        self.assertEqual(code, 0)
        self.assertEqual((s["mem_pct"], s["cpu_pct"], s["gpu_pct"]), (None, None, None))
        self.assertIn("mem", s["errors"]); self.assertIn("cpu", s["errors"])
        self.assertEqual(s["gpu"]["status"], "unavailable")             # a NaN device is dropped, not reported

    def test_gpu_output_is_bounded(self):
        self.e.seed_state()
        fake = os.path.join(self.e.root, "nvidia-smi")
        put(fake, "#!/bin/sh\nyes '0, 50, 1, 2' | head -c 3000000\n"); os.chmod(fake, 0o755)
        _, s = rc.sample_once(self.e.cfg(nvidia_smi=fake, max_input_bytes=4096), now=T0)
        self.assertEqual(s["gpu"]["status"], "unavailable")

    def test_output_is_strict_json(self):
        self.e.seed_state()
        rc.sample_once(self.e.cfg(), now=T0)
        with open(os.path.join(self.e.out, "samples-2026-10-25.jsonl")) as f:
            for line in f:
                json.loads(line, parse_constant=lambda c: (_ for _ in ()).throw(ValueError(c)))

    # ---- r2 recheck: R2-1 (one deadline over read and exit) and R2-2 (first checkpoint before any rollup)
    def test_run_capped_deadline_covers_reading(self):
        import sys as _s, time as _t
        py = [_s.executable, "-I", "-B", "-c"]
        t0 = _t.monotonic()
        with self.assertRaises(rc.InputError):                          # silent child
            rc.run_capped(py + ["import time; time.sleep(3)"], limit=1024, timeout=0.2)
        with self.assertRaises(rc.InputError):                          # slow trickle past the deadline
            rc.run_capped(py + ["import sys,time\nfor i in range(30): print(i, flush=True); time.sleep(0.1)"],
                          limit=1 << 20, timeout=0.3)
        with self.assertRaises(rc.InputError):                          # a descendant keeps the pipe open
            rc.run_capped(["sh", "-c", "sleep 3 & echo started"], limit=1024, timeout=0.3)
        self.assertLess(_t.monotonic() - t0, 2.5, "a deadline was not enforced")
        with self.assertRaises(rc.InputError):                          # oversize
            rc.run_capped(py + ["print('x' * 5000)"], limit=1024, timeout=5)
        with self.assertRaises(rc.InputError):                          # non-zero exit
            rc.run_capped(py + ["raise SystemExit(3)"], limit=1024, timeout=5)
        self.assertEqual(rc.run_capped(py + ["print('ok')"], limit=1024, timeout=5).strip(), "ok")

    def test_first_checkpoint_failure_before_any_rollup_keeps_first_hour(self):
        self.e.seed_state()
        with mock.patch.object(rc, "write_state", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                rc.sample_once(self.e.cfg(), now=T0 + 10)               # the sample is durable, the cursor is not
        rc.sample_once(self.e.cfg(), now=T0 + 3601)
        rc.sample_once(self.e.cfg(), now=T0 + 7201)
        starts = [r["start"] for r in self.e.rollups("rollup-hour")]
        self.assertEqual(starts, [T0, T0 + 3600])                       # the first hour is not skipped, each once


    # ---- r3 recheck: R3-1 (an unreadable ledger is unavailable, never an empty committed set)
    def test_oversize_or_unreadable_ledger_skips_prune_accounting(self):
        self.e.seed_state()
        self.e.summary("live1", "live", 0, 700)
        _, s1 = rc.sample_once(self.e.cfg(), now=T0)
        self.assertEqual([r["run_id"] for r in s1["prune"]], ["live1"])
        led = os.path.join(self.e.out, "prune-runs.jsonl")
        size = os.path.getsize(led)
        _, s2 = rc.sample_once(self.e.cfg(max_file_bytes=max(1, size - 1)), now=T0 + 300)   # ledger over its bound
        self.assertEqual(s2["prune"], [])
        self.assertTrue(s2.get("prune_unavailable"))
        self.assertIn("ledger_unavailable", s2["errors"]["prune_runs_file"])
        self.assertIsNotNone(s2["mem_pct"])                            # resource sampling continues
        os.chmod(led, 0);
        try:
            _, s3 = rc.sample_once(self.e.cfg(), now=T0 + 600)         # unreadable ledger
        finally:
            os.chmod(led, 0o644)
        self.assertEqual(s3["prune"], [])
        self.assertTrue(s3.get("prune_unavailable"))
        _, s4 = rc.sample_once(self.e.cfg(), now=T0 + 900)             # readable again: still committed once
        self.assertEqual(s4["prune"], [])
        self.assertEqual([r["run_id"] for r in self.e.lines("prune-runs.jsonl")], ["live1"])

    def test_rollup_during_unavailable_ledger_is_null_not_zero(self):
        self.e.seed_state()
        self.e.summary("live1", "live", 0, 700)
        rc.sample_once(self.e.cfg(), now=T0)
        led = os.path.join(self.e.out, "prune-runs.jsonl")
        for i in range(1, 12):                                          # up to T0+3300: hour T0 still open
            rc.sample_once(self.e.cfg(), now=T0 + i * 300)
        os.chmod(led, 0)
        try:
            rc.sample_once(self.e.cfg(), now=T0 + 3600 + 10)           # closes hour T0 while the ledger is unreadable
        finally:
            os.chmod(led, 0o644)
        h = [r for r in self.e.rollups("rollup-hour") if r["start"] == T0][0]
        self.assertTrue(h.get("prune_unavailable"))
        self.assertIsNone(h["prune_bytes"])                              # never a fabricated 0 or 700

    def test_new_missing_ledger_still_joins(self):
        self.e.seed_state()
        self.e.summary("d1")
        _, s = rc.sample_once(self.e.cfg(), now=T0)
        self.assertEqual([r["run_id"] for r in s["prune"]], ["d1"])
        self.assertFalse(s.get("prune_unavailable", False))



if __name__ == "__main__":
    unittest.main(verbosity=1)
