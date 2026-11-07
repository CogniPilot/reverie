//! The scenarios of `tests/cleanup_sources/test_prune_receipts.py`, plus a
//! byte-for-byte replay of the Python adapter's retention at a fixed clock
//! (`tests/fixtures/receipts-oracle`, captured from the removed Python).
use reverie_contracts::prune_receipts::Limits;
use reverie_observations::receipts::{Options, run};
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);
const NOW: f64 = 1_793_000_000.75;
const DRY: &str = "20261025T160000Z-aaaa";
const LIVE: &str = "20261025T170000Z-bbbb";

struct Dir(PathBuf);

impl Dir {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "receipts-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(root.join("logs")).unwrap();
        Self(root)
    }
    fn logs(&self) -> PathBuf {
        self.0.join("logs")
    }
    fn out(&self) -> PathBuf {
        self.0.join("receipts.jsonl")
    }
    fn write(&self, run_id: &str, body: &Value) {
        self.write_named(&format!("{run_id}.summary.json"), body);
    }
    fn write_named(&self, name: &str, body: &Value) {
        fs::write(self.logs().join(name), body.to_string()).unwrap();
    }
    fn options(&self) -> Options {
        Options {
            log_dir: Some(self.logs()),
            a1: Vec::new(),
            context: None,
            out: self.out(),
            max_input_bytes: 1 << 20,
            limits: Limits {
                entries: 100_000,
                bytes: 64 << 20,
                age_days: 0.0,
            },
        }
    }
    /// One run with its expected exit code; the parsed summary line.
    fn run(&self, options: &Options, expect: i32) -> Value {
        let (code, line) = run(options, NOW).unwrap();
        assert_eq!(code, expect, "{line}");
        serde_json::from_str(&line).unwrap()
    }
    fn records(&self) -> Vec<Value> {
        fs::read_to_string(self.out())
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
    fn context(&self, body: &Value) -> PathBuf {
        let path = self.0.join(format!(
            "context-{}.json",
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::write(&path, body.to_string()).unwrap();
        path
    }
}

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn summary(run_id: &str, mode: &str, exit: i64) -> Value {
    json!({"run_id": run_id, "mode": mode, "passes": ["high-water", "checkouts"],
        "df_before": [{"path": "/mnt/scratch", "total": 1000, "free": 400, "used_pct": 60.0}],
        "df_after": [{"path": "/mnt/scratch", "total": 1000, "free": 400, "used_pct": 60.0}],
        "deleted_or_would_bytes": 5_i64 << 30, "by_decision": {"WOULD_DELETE": 2, "SKIP": 1},
        "by_laptop": {"L1": {}}, "ceiling_bytes": 200_i64 << 30, "ceiling_hit": false, "exit": exit})
}

fn with(mut value: Value, key: &str, replacement: Value) -> Value {
    value[key] = replacement;
    value
}

#[test]
fn positive_dry_is_observation_with_unavailable_identity() {
    let dir = Dir::new();
    dir.write(DRY, &summary(DRY, "dry", 0));
    let result = dir.run(&dir.options(), 0);
    assert_eq!(
        (result["status"].clone(), result["written"].clone()),
        (json!("COMMITTED"), json!(1))
    );
    let records = dir.records();
    let [record] = records.as_slice() else {
        panic!("{records:?}")
    };
    assert_eq!(
        (
            &record["event_kind"],
            &record["result_class"],
            &record["code"],
            &record["codes"]
        ),
        (
            &json!("PRUNE_OBSERVATION"),
            &json!("OK"),
            &json!("RUN_OK"),
            &json!(["WOULD_DELETE"])
        )
    );
    assert_eq!(record["utc"], "2026-10-25T16:00:00Z");
    assert_eq!(record["actor_ref"], "UNAVAILABLE");
    assert_eq!(
        record["effect"],
        json!({"idempotency_key": "UNAVAILABLE", "lease_id": "UNAVAILABLE"})
    );
    assert_eq!(record["evidence_level"], "PRODUCER_OUTPUT_UNAUTHENTICATED");
    assert_eq!(
        record["metrics"],
        json!({"would_delete_bytes": 5_i64 << 30, "reported_deleted_bytes": 0})
    );
    assert_eq!(
        record["source"]["by_decision"],
        json!({"WOULD_DELETE": 2, "SKIP": 1})
    );
    assert!(!record.to_string().contains('/'), "no paths survive");
}

#[test]
fn duplicate_and_conflicting_identity() {
    let dir = Dir::new();
    dir.write(DRY, &summary(DRY, "dry", 0));
    dir.run(&dir.options(), 0);
    let again = dir.run(&dir.options(), 0);
    assert_eq!(
        (again["written"].clone(), again["duplicates"].clone()),
        (json!(0), json!(1))
    );
    dir.write(
        DRY,
        &with(
            summary(DRY, "dry", 0),
            "deleted_or_would_bytes",
            json!(6_i64 << 30),
        ),
    );
    let conflict = dir.run(&dir.options(), 1);
    assert_eq!(conflict["refused"], json!({"CONFLICT": 1}));
    assert_eq!(dir.records().len(), 1, "never written");
}

#[test]
fn live_without_and_with_admission() {
    let dir = Dir::new();
    dir.write(DRY, &summary(DRY, "dry", 0));
    dir.write(
        LIVE,
        &with(
            summary(LIVE, "live", 0),
            "by_decision",
            json!({"DELETED": 1}),
        ),
    );
    dir.run(&dir.options(), 0);
    let find =
        |records: &[Value], run: &str| records.iter().find(|r| r["run_id"] == run).unwrap().clone();
    let live = find(&dir.records(), LIVE);
    assert_eq!(
        live["event_kind"], "PRUNE_OBSERVATION",
        "no admission context: never TERMINAL"
    );
    assert_eq!(
        (&live["metrics"]["reported_deleted_bytes"], &live["codes"]),
        (&json!(5_i64 << 30), &json!(["REPORTED_DELETED"]))
    );
    fs::remove_file(dir.out()).unwrap();
    let context = dir.context(&json!({"actor_ref": "ext-operator", "host_key": "host-a",
        "producer_source_sha256": "e".repeat(64),
        "admissions": {LIVE: {"idempotency_key": "eff-1", "lease_id": "lease-9"}}}));
    dir.run(
        &Options {
            context: Some(context),
            ..dir.options()
        },
        0,
    );
    let records = dir.records();
    let (live, dry) = (find(&records, LIVE), find(&records, DRY));
    assert_eq!(live["event_kind"], "PRUNE_TERMINAL");
    assert_eq!(
        live["effect"],
        json!({"idempotency_key": "eff-1", "lease_id": "lease-9"})
    );
    assert_eq!(
        dry["event_kind"], "PRUNE_OBSERVATION",
        "a dry run is never an effect"
    );
    assert_eq!(
        (
            &live["actor_ref"],
            &live["producer"]["source_sha256"],
            &live["producer"]["config_sha256"]
        ),
        (
            &json!("ext-operator"),
            &json!("e".repeat(64)),
            &json!("UNAVAILABLE")
        )
    );
}

#[test]
fn private_strings_missing_identity_oversize() {
    let dir = Dir::new();
    dir.write(DRY, &summary(DRY, "dry", 0));
    let context = dir.context(
        &json!({"actor_ref": "someone@example.com", "host_key": "/home/someone",
        "config_sha256": "not-a-sha"}),
    );
    dir.write_named(
        "20261025T180000Z-cccc.summary.json",
        &json!({"mode": "dry", "exit": 0}),
    );
    dir.write_named(
        "20261025T190000Z-dddd.summary.json",
        &summary("../../etc/passwd", "dry", 0),
    );
    let negative = "20261025T200000Z-eeee";
    dir.write(
        negative,
        &with(
            summary(negative, "dry", 0),
            "by_decision",
            json!({"WOULD_DELETE": -1}),
        ),
    );
    let padded = "20261025T210000Z-ffff";
    dir.write(
        padded,
        &with(summary(padded, "dry", 0), "pad", json!("x".repeat(5000))),
    );
    let options = Options {
        context: Some(context),
        max_input_bytes: 4096,
        ..dir.options()
    };
    let result = dir.run(&options, 1);
    assert_eq!(
        result["context_fields_rejected"],
        json!(["actor_ref", "config_sha256", "host_key"])
    );
    assert_eq!(
        result["refused"],
        json!({"MISSING_IDENTITY": 1, "PRIVATE_OR_INVALID_STRING": 1,
        "FIELD_OUT_OF_BOUNDS": 1, "INPUT_OVERSIZE": 1})
    );
    let records = dir.records();
    let [record] = records.as_slice() else {
        panic!("{records:?}")
    };
    assert_eq!(
        (&record["run_id"], &record["actor_ref"], &record["host_key"]),
        (&json!(DRY), &json!("UNAVAILABLE"), &json!("UNAVAILABLE"))
    );
    assert!(!fs::read_to_string(dir.out()).unwrap().contains("someone"));
}

#[test]
fn a1_report_counts_only() {
    let dir = Dir::new();
    dir.write(DRY, &summary(DRY, "dry", 0));
    let a1 = dir.0.join("a1.json");
    fs::write(&a1, json!({"tool": "prune_exceptions", "window": {"since": "2026-10-25T00:00:00Z", "until": null},
        "generated_utc": "2026-10-25T16:05:00Z",
        "gate": {"runs": 3, "runs_with_problems": 1, "partial_rows": 0, "unknown_rows": 2,
            "safety_refused_rows": 1, "note": "facts"},
        "run_problems": [{"run_id": DRY, "problems": ["exit 2"]}, {"run_id": "/bad path"}],
        "leases_held": [{"path": "/b/L1/x"}], "not_registered": [{"repo": "o/r", "checkouts": ["/h"]}]})
        .to_string()).unwrap();
    dir.run(
        &Options {
            a1: vec![a1],
            ..dir.options()
        },
        0,
    );
    let records = dir.records();
    let record = records
        .iter()
        .find(|r| r["event_kind"] == "A1_EXCEPTIONS")
        .unwrap();
    assert_eq!(
        (
            &record["code"],
            &record["metrics"]["unknown_rows"],
            &record["metrics"]["leases_held_count"],
            &record["metrics"]["not_registered_count"]
        ),
        (
            &json!("EXCEPTIONS_PRESENT"),
            &json!(2),
            &json!(1),
            &json!(1)
        )
    );
    assert_eq!(record["problem_run_ids"], json!([DRY, "UNAVAILABLE"]));
    let text = record.to_string();
    assert!(!text.contains("/b/L1") && !text.contains("o/r"));
}

#[test]
fn prune_exit_codes_partial_and_busy() {
    let dir = Dir::new();
    dir.write(DRY, &summary(DRY, "dry", 0));
    let partial = "20261025T180000Z-pppp";
    dir.write(
        partial,
        &with(
            summary(partial, "live", 4),
            "by_decision",
            json!({"DELETED": 1, "PARTIAL": 1}),
        ),
    );
    let busy = "20261025T190000Z-qqqq";
    dir.write(busy, &summary(busy, "dry", 5));
    dir.run(&dir.options(), 0);
    let class = |run: &str| {
        let records = dir.records();
        let record = records.iter().find(|r| r["run_id"] == run).unwrap();
        (record["result_class"].clone(), record["code"].clone())
    };
    assert_eq!(class(partial), (json!("PARTIAL"), json!("RUN_PARTIAL")));
    assert_eq!(class(busy), (json!("REFUSED"), json!("RUN_BUSY")));
    assert_eq!(class(DRY), (json!("OK"), json!("RUN_OK")));
    // Exit 1 is not a reverie-prune code: never mapped to PARTIAL.
    let odd = "20261025T200000Z-rrrr";
    dir.write(odd, &summary(odd, "dry", 1));
    dir.run(&dir.options(), 0);
    assert_eq!(class(odd).0, json!("FAILED"));
}

#[test]
fn retention_drops_are_reported() {
    let dir = Dir::new();
    dir.write(DRY, &summary(DRY, "dry", 0));
    for i in 0..5 {
        let run = format!("20261025T16{i:02}00Z-r{i}");
        dir.write(&run, &summary(&run, "dry", 0));
    }
    let options = Options {
        limits: Limits {
            entries: 3,
            ..dir.options().limits
        },
        ..dir.options()
    };
    let result = dir.run(&options, 0);
    assert_eq!(
        result["retention_dropped"], 3,
        "6 written, 3 kept, then the drop record"
    );
    let records = dir.records();
    assert_eq!(records.len(), 4);
    assert_eq!(
        (&records[3]["event_kind"], &records[3]["metrics"]),
        (&json!("RETENTION_DROP"), &json!({"dropped": 3}))
    );
}

fn copy_tree(from: &Path, to: &Path) {
    for entry in fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            fs::create_dir_all(&target).unwrap();
            copy_tree(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), target).unwrap();
        }
    }
}

/// Each scenario: its inputs, the extra arguments, and the Python adapter's
/// stdout, exit code and output bytes at the same fixed clock.
#[test]
fn retention_matches_the_python_adapter_byte_for_byte() {
    let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/receipts-oracle");
    for scenario in ["entries", "age", "negative", "bytes"] {
        let source = fixtures.join(scenario);
        let dir = Dir::new();
        copy_tree(&source.join("input"), &dir.0);
        let args = fs::read_to_string(source.join("args")).unwrap();
        let args = args.lines().collect::<Vec<_>>();
        let mut options = Options {
            out: dir.0.join("out.jsonl"),
            ..dir.options()
        };
        match args.as_slice() {
            ["--max-entries", value] => options.limits.entries = value.parse().unwrap(),
            ["--max-bytes", value] => options.limits.bytes = value.parse().unwrap(),
            ["--max-age-days", value] => options.limits.age_days = value.parse().unwrap(),
            other => panic!("{other:?}"),
        }
        let expected = |name: &str| fs::read_to_string(source.join("expected").join(name)).unwrap();
        let (code, line) = run(&options, NOW).unwrap();
        assert_eq!(code.to_string(), expected("rc").trim(), "{scenario}");
        assert_eq!(line, expected("stdout"), "{scenario}");
        assert_eq!(
            fs::read_to_string(&options.out).unwrap(),
            expected("out.jsonl"),
            "{scenario}"
        );
    }
}
