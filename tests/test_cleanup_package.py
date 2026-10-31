"""Bounded checks for the reviewed cleanup sources; no real cleanup or host probes."""
import tests  # noqa: F401  isolates runtime state before importing reverie
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from reverie.cleanup import collector, lease, reverie_prune


class CleanupPackageTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="cleanup-package-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.base = self.root / "persistent-leases"
        self.base.mkdir(mode=0o700)
        self.work = self.root / "disposable"
        self.work.mkdir()
        self.env = patch.dict(os.environ, {"REVERIE_LEASE_DIR": str(self.base)})
        self.env.start()
        self.addCleanup(self.env.stop)

    def test_reviewed_sources_are_byte_identical(self):
        for module, expected in [
            (reverie_prune, "333d8e56f4a7de0347736455df10d06551daac9eef3a491389334a02393df075"),
            (lease, "606cacea83ebb70bb805423e67be44168fec411d3e5c62c5e563c416ab6891aa"),
        ]:
            self.assertEqual(hashlib.sha256(Path(module.__file__).read_bytes()).hexdigest(), expected)

    def test_hold_blocks_janitor_without_unlinking_its_lock_on_release(self):
        child = self.work / "build"
        child.mkdir()
        with lease.hold(child):
            self.assertEqual(lease.check(self.work, str(self.work), [self.base])[0], lease.IN_USE)
            self.assertEqual(lease.check(child, str(self.work), [self.base])[0], lease.IN_USE)
        self.assertEqual(lease.check(child, str(self.work), [self.base])[0], lease.FREE)
        self.assertTrue((self.base / (lease.key_of(child) + ".lock")).is_file())
        self.assertEqual(list(child.iterdir()), [])

    def test_missing_lease_directory_is_unknown_and_is_not_provisioned(self):
        missing = self.root / "unprovisioned-leases"
        self.assertEqual(lease.check(self.work, str(self.work), [missing])[0], lease.UNKNOWN)
        self.assertFalse(missing.exists())

    def test_optimized_interpreter_remains_refused(self):
        result = subprocess.run([sys.executable, "-I", "-B", "-O", lease.__file__, "ls"],
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, lease.UNKNOWN)
        self.assertIn("refusing to run under python -O", result.stderr)

    def test_synthetic_dry_run_reports_but_preserves_candidate_bytes(self):
        scratch = self.root / "scratch"
        laptop = scratch / "laptops/employees/synthetic"
        candidate = laptop / "build"
        candidate.mkdir(parents=True)
        payload = candidate / "owned-fixture.bin"
        payload.write_bytes(b"synthetic rebuildable output\n")
        old = time.time() - 10 * 86400
        os.utime(payload, (old, old))
        os.utime(candidate, (old, old))
        home_root = self.root / "homes"
        lease_dir = home_root / "synthetic/home/.local/state/reverie/leases"
        lease_dir.mkdir(parents=True)
        config = self.root / "prune.toml"
        config.write_text("\n".join([
            "live_enabled = true",  # --dry-run still must not delete anything.
            "b_mount = " + json.dumps(str(scratch)),
            'laptops_root = "laptops/employees"',
            "laptop_home_root = " + json.dumps(str(home_root)),
            "lease_lib = " + json.dumps(str(Path(lease.__file__).resolve())),
            "log_dir = " + json.dumps(str(self.root / "reports")),
            "registry_dir = " + json.dumps(str(self.root / "registry")),
            "high_water_pct = 0", "low_water_pct = 0", "",
        ]))
        result = subprocess.run([sys.executable, "-I", "-B", reverie_prune.__file__,
                                 "--config", str(config), "--test-root", str(self.root),
                                 "--dry-run", "--pass", "high-water", "--test-df-pct", "100",
                                 "--run-id", "synthetic-dry-run"],
                                capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(payload.read_bytes(), b"synthetic rebuildable output\n")
        rows = [json.loads(line) for line in (self.root / "reports/synthetic-dry-run.jsonl").read_text().splitlines()]
        candidates = [row for row in rows if row["host_path"] == str(candidate)]
        self.assertTrue(candidates)
        self.assertTrue(all(row["mode"] == "dry" for row in rows))
        self.assertTrue(all(row["decision"] not in ("DELETED", "PARTIAL") for row in rows))


class GPUIdentityTests(unittest.TestCase):
    UUID_A = "GPU-01234567-89ab-cdef-0123-456789abcdef"
    UUID_B = "GPU-fedcba98-7654-3210-fedc-ba9876543210"

    def read_gpus(self, output):
        cfg = {**collector.DEFAULTS, "sys_root": "/nonexistent-fixture-sys"}
        with patch.object(collector.shutil, "which", return_value="/fixed/nvidia-smi"), \
             patch.object(collector, "run_capped", return_value=output) as run:
            result = collector.gpus(cfg)
        self.assertEqual(run.call_args.args, (["/fixed/nvidia-smi",
            "--query-gpu=index,utilization.gpu,memory.used,memory.total,uuid",
            "--format=csv,noheader,nounits"], cfg["max_input_bytes"]))
        return result

    def test_uuid_tracks_same_devices_across_index_reordering_without_changing_aggregate(self):
        first = self.read_gpus(f"0, 40, 100, 8000, {self.UUID_A}\n1, 60, 200, 16000, {self.UUID_B}\n")
        second = self.read_gpus(f"0, 60, 200, 16000, {self.UUID_B}\n1, 40, 100, 8000, {self.UUID_A}\n")
        self.assertEqual((first[0], second[0]), (50.0, 50.0))
        for result in (first, second):
            self.assertEqual((result[1]["status"], result[1]["source"]), ("ok", "nvidia-smi"))
            self.assertEqual({d["uuid"]: (d["util_pct"], d["mem_total_mib"]) for d in result[1]["devices"]},
                             {self.UUID_A: (40, 8000), self.UUID_B: (60, 16000)})
            self.assertEqual({d["identity_status"] for d in result[1]["devices"]}, {"available"})
        self.assertEqual([d["uuid"] for d in first[1]["devices"]], list(reversed([d["uuid"] for d in second[1]["devices"]])))

    def test_bad_or_duplicate_identity_preserves_metrics_but_never_false_device_attribution(self):
        upper = "GPU-" + self.UUID_A[4:].upper()
        pct, gpu = self.read_gpus(f"0, 10, 1, 2, {self.UUID_A}\n1, 20, 1, 2, {upper}\n"
                                  "2, 30, 1, 2, GPU-not-a-uuid\n3, 40, 1, 2, N/A\n4, 50, 1, 2\n")
        self.assertEqual((pct, gpu["status"]), (30.0, "ok"))
        self.assertEqual([d["uuid"] for d in gpu["devices"]], [None] * 5)
        self.assertEqual([d["identity_status"] for d in gpu["devices"]],
                         ["duplicate", "duplicate", "invalid", "unavailable", "unavailable"])
        self.assertNotIn("GPU-not-a-uuid", json.dumps(gpu))

    def test_sysfs_and_missing_driver_do_not_invent_identity_from_card_index(self):
        with tempfile.TemporaryDirectory(prefix="gpu-identity-") as root:
            cfg = {**collector.DEFAULTS, "sys_root": root}
            with patch.object(collector.shutil, "which", return_value=None), \
                 patch.object(collector, "run_capped") as run:
                self.assertEqual(collector.gpus(cfg), (None, {"status": "unavailable", "source": "none", "devices": []}))
                card = Path(root)/"class/drm/card7/device"
                card.mkdir(parents=True); (card/"gpu_busy_percent").write_text("33\n")
                pct, gpu = collector.gpus(cfg)
                self.assertEqual((pct, gpu["source"]), (33.0, "sysfs"))
                self.assertEqual(gpu["devices"], [{"index": 7, "util_pct": 33.0, "uuid": None, "identity_status": "unavailable"}])
                run.assert_not_called()
                with patch.object(collector.shutil, "which", return_value="/fixed/nvidia-smi"), \
                     patch.object(collector, "run_capped", side_effect=collector.InputError("driver unavailable")):
                    self.assertEqual(collector.gpus(cfg), (pct, gpu))

    def test_capped_listing_marks_identities_incomplete_instead_of_missing_late_duplicates(self):
        rows = [f"{n}, 25, 1, 2, GPU-{n:08x}-0000-0000-0000-000000000000" for n in range(64)]
        rows.append(rows[0])  # the duplicate lies beyond the existing metrics cap
        pct, gpu = self.read_gpus("\n".join(rows))
        self.assertEqual((pct, len(gpu["devices"])), (25.0, 64))
        self.assertTrue(all(d["uuid"] is None and d["identity_status"] == "incomplete" for d in gpu["devices"]))

    def test_invalid_metrics_are_still_excluded_and_cannot_hide_duplicate_identity(self):
        pct, gpu = self.read_gpus(f"0, 40, 1, 2, {self.UUID_A}\n1, nan, 1, 2, {self.UUID_A}\n"
                                  f"2, 101, 1, 2, {self.UUID_B}\n3, 20, -1, 2, {self.UUID_B}\n4, 60, 1, 2, {self.UUID_B}\n")
        self.assertEqual(pct, 50.0)
        self.assertEqual([d["index"] for d in gpu["devices"]], [0, 4])
        self.assertTrue(all(d["uuid"] is None and d["identity_status"] == "duplicate" for d in gpu["devices"]))


if __name__ == "__main__":
    unittest.main()
