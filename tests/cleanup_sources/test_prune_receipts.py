"""Synthetic tests for prune_receipts.py. Run: python3 -I test_prune_receipts.py"""

import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(HERE, "prune_receipts.py")
DRY = "20261025T160000Z-aaaa"
LIVE = "20261025T170000Z-bbbb"


def summary(run_id, mode="dry", exit_code=0, **over):
    s = {"run_id": run_id, "mode": mode, "passes": ["high-water", "checkouts"],
         "df_before": [{"path": "/mnt/scratch", "total": 1000, "free": 400, "used_pct": 60.0}],
         "df_after": [{"path": "/mnt/scratch", "total": 1000, "free": 400, "used_pct": 60.0}],
         "deleted_or_would_bytes": 5 << 30, "by_decision": {"WOULD_DELETE": 2, "SKIP": 1}, "by_laptop": {"L1": {}},
         "ceiling_bytes": 200 << 30, "ceiling_hit": False, "exit": exit_code}
    s.update(over)
    return s


class Receipts(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.logs = os.path.join(self.dir.name, "logs")
        os.mkdir(self.logs)
        self.out = os.path.join(self.dir.name, "receipts.jsonl")
        self.write(DRY, summary(DRY))

    def tearDown(self):
        self.dir.cleanup()

    def write(self, run_id, body, name=None):
        with open(os.path.join(self.logs, name or run_id + ".summary.json"), "w") as handle:
            json.dump(body, handle)

    def run_tool(self, *extra, expect=0):
        proc = subprocess.run([sys.executable, "-I", TOOL, "--log-dir", self.logs, "--out", self.out] + list(extra),
                              capture_output=True, text=True)
        self.assertEqual(proc.returncode, expect, proc.stdout + proc.stderr)
        return json.loads(proc.stdout)

    def records(self):
        with open(self.out) as handle:
            return [json.loads(l) for l in handle if l.strip()]

    def context(self, **body):
        path = os.path.join(self.dir.name, "context-%d.json" % len(os.listdir(self.dir.name)))
        with open(path, "w") as handle:
            json.dump(body, handle)
        return path

    def test_positive_dry_is_observation_with_unavailable_identity(self):
        result = self.run_tool()
        self.assertEqual((result["status"], result["written"]), ("COMMITTED", 1))
        (r,) = self.records()
        self.assertEqual((r["event_kind"], r["result_class"], r["code"], r["codes"]),
                         ("PRUNE_OBSERVATION", "OK", "RUN_OK", ["WOULD_DELETE"]))
        self.assertEqual(r["utc"], "2026-10-25T16:00:00Z")
        self.assertEqual(r["actor_ref"], "UNAVAILABLE")
        self.assertEqual(r["effect"], {"idempotency_key": "UNAVAILABLE", "lease_id": "UNAVAILABLE"})
        self.assertEqual(r["evidence_level"], "PRODUCER_OUTPUT_UNAUTHENTICATED")
        self.assertEqual((r["metrics"]["would_delete_bytes"], r["metrics"]["reported_deleted_bytes"]), (5 << 30, 0))
        self.assertEqual(r["source"]["by_decision"], {"WOULD_DELETE": 2, "SKIP": 1})
        self.assertNotIn("/", json.dumps(r))  # no paths survive (df keeps position only)

    def test_duplicate_and_conflicting_identity(self):
        self.run_tool()
        again = self.run_tool()
        self.assertEqual((again["written"], again["duplicates"]), (0, 1))
        self.write(DRY, summary(DRY, deleted_or_would_bytes=6 << 30))  # same run_id, different bytes
        conflict = self.run_tool(expect=1)
        self.assertEqual(conflict["refused"], {"CONFLICT": 1})
        self.assertEqual(len(self.records()), 1)  # never written

    def test_live_without_and_with_admission(self):
        self.write(LIVE, summary(LIVE, mode="live", by_decision={"DELETED": 1}))
        self.run_tool()
        live = [r for r in self.records() if r["run_id"] == LIVE][0]
        self.assertEqual(live["event_kind"], "PRUNE_OBSERVATION")  # no admission context: never TERMINAL
        self.assertEqual((live["metrics"]["reported_deleted_bytes"], live["codes"]), (5 << 30, ["REPORTED_DELETED"]))
        os.remove(self.out)
        ctx = self.context(actor_ref="ext-operator", host_key="host-a", producer_source_sha256="e" * 64,
                           admissions={LIVE: {"idempotency_key": "eff-1", "lease_id": "lease-9"}})
        self.run_tool("--context", ctx)
        live = [r for r in self.records() if r["run_id"] == LIVE][0]
        dry = [r for r in self.records() if r["run_id"] == DRY][0]
        self.assertEqual(live["event_kind"], "PRUNE_TERMINAL")
        self.assertEqual(live["effect"], {"idempotency_key": "eff-1", "lease_id": "lease-9"})
        self.assertEqual(dry["event_kind"], "PRUNE_OBSERVATION")  # a dry run is never an effect, binding or not
        self.assertEqual((live["actor_ref"], live["producer"]["source_sha256"], live["producer"]["config_sha256"]),
                         ("ext-operator", "e" * 64, "UNAVAILABLE"))

    def test_private_strings_missing_identity_oversize(self):
        ctx = self.context(actor_ref="someone@example.com", host_key="/home/someone",
                           config_sha256="not-a-sha")
        self.write("x", {"mode": "dry", "exit": 0}, name="20261025T180000Z-cccc.summary.json")   # no run_id
        self.write("y", summary("../../etc/passwd"), name="20261025T190000Z-dddd.summary.json")  # path as id
        self.write("20261025T200000Z-eeee", summary("20261025T200000Z-eeee", by_decision={"WOULD_DELETE": -1}))
        self.write("20261025T210000Z-ffff", summary("20261025T210000Z-ffff", pad="x" * 5000))
        result = self.run_tool("--context", ctx, "--max-input-bytes", "4096", expect=1)
        self.assertEqual(result["context_fields_rejected"], ["actor_ref", "config_sha256", "host_key"])
        self.assertEqual(result["refused"], {"MISSING_IDENTITY": 1, "PRIVATE_OR_INVALID_STRING": 1,
                                             "FIELD_OUT_OF_BOUNDS": 1, "INPUT_OVERSIZE": 1})
        (r,) = self.records()
        self.assertEqual((r["run_id"], r["actor_ref"], r["host_key"]), (DRY, "UNAVAILABLE", "UNAVAILABLE"))
        with open(self.out) as handle:
            self.assertNotIn("someone", handle.read())

    def test_a1_report_counts_only(self):
        a1 = os.path.join(self.dir.name, "a1.json")
        with open(a1, "w") as handle:
            json.dump({"tool": "prune_exceptions", "window": {"since": "2026-10-25T00:00:00Z", "until": None},
                       "generated_utc": "2026-10-25T16:05:00Z",
                       "gate": {"runs": 3, "runs_with_problems": 1, "partial_rows": 0, "unknown_rows": 2,
                                "safety_refused_rows": 1, "note": "facts"},
                       "run_problems": [{"run_id": DRY, "problems": ["exit 2"]}, {"run_id": "/bad path"}],
                       "leases_held": [{"path": "/b/L1/x"}], "not_registered": [{"repo": "o/r", "checkouts": ["/h"]}]},
                      handle)
        self.run_tool("--a1", a1)
        r = [x for x in self.records() if x["event_kind"] == "A1_EXCEPTIONS"][0]
        self.assertEqual((r["code"], r["metrics"]["unknown_rows"], r["metrics"]["leases_held_count"],
                          r["metrics"]["not_registered_count"]), ("EXCEPTIONS_PRESENT", 2, 1, 1))
        self.assertEqual(r["problem_run_ids"], [DRY, "UNAVAILABLE"])
        self.assertNotIn("/b/L1", json.dumps(r))
        self.assertNotIn("o/r", json.dumps(r))

    def test_prune_exit_codes_partial_and_busy(self):
        # reverie-prune r10: EXIT_OK, EXIT_CONFIG, EXIT_LIVE_REFUSED, EXIT_PARTIAL, EXIT_BUSY = 0, 2, 3, 4, 5; it writes a
        # summary (Run.summary's exact field set, as in summary()) only for 0 and 4.
        partial = "20261025T180000Z-pppp"
        self.write(partial, summary(partial, mode="live", exit_code=4, by_decision={"DELETED": 1, "PARTIAL": 1}))
        busy = "20261025T190000Z-qqqq"
        self.write(busy, summary(busy, exit_code=5))
        self.run_tool()
        by_run = {r["run_id"]: r for r in self.records()}
        self.assertEqual((by_run[partial]["result_class"], by_run[partial]["code"]), ("PARTIAL", "RUN_PARTIAL"))
        self.assertEqual((by_run[busy]["result_class"], by_run[busy]["code"]), ("REFUSED", "RUN_BUSY"))
        self.assertEqual((by_run[DRY]["result_class"], by_run[DRY]["code"]), ("OK", "RUN_OK"))
        # exit 1 is not a reverie-prune code: never mapped to PARTIAL
        odd = "20261025T200000Z-rrrr"
        self.write(odd, summary(odd, exit_code=1))
        self.run_tool()
        self.assertEqual([r for r in self.records() if r["run_id"] == odd][0]["result_class"], "FAILED")

    def test_retention_drops_are_reported(self):
        for i in range(5):
            rid = "20261025T16%02d00Z-r%d" % (i, i)
            self.write(rid, summary(rid))
        result = self.run_tool("--max-entries", "3")
        self.assertEqual(result["retention_dropped"], 3)  # 6 written, 3 kept, then the drop record
        records = self.records()
        self.assertEqual(len(records), 4)
        self.assertEqual((records[-1]["event_kind"], records[-1]["metrics"]), ("RETENTION_DROP", {"dropped": 3}))


if __name__ == "__main__":
    unittest.main(verbosity=2)
