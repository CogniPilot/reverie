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

from reverie.cleanup import lease, reverie_prune


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
            (reverie_prune, "eee8b1608e1e87117d00b955b6cf6271cea809ab5e0cfd3f77696a05007eb3fb"),
            (lease, "3458407ef3e2bb71047528d0acebcb2a1266193dd3181ad7fc384b056a72315b"),
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


if __name__ == "__main__":
    unittest.main()
