//! The history scenarios of `tests/test_resource_history.py`, on owned
//! synthetic files. Rollup rows are `collector.rollup` outputs recorded once
//! from the Python collector (fixtures/collector-rollups.txt).
use reverie_contracts::resource_history::HistoryRequest;
use reverie_observations::{Owner, query};
use serde_json::{Value, json};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const GPU: &str = "GPU-01234567-89ab-cdef-0123-456789abcdef";
const T: i64 = 1_792_940_400;
static NEXT: AtomicU64 = AtomicU64::new(0);

/// `U.main(['--config', ..., 'init'])`: the default configuration and a
/// private, marked state directory under a private synthetic home.
struct Home {
    home: PathBuf,
    config: PathBuf,
    state: PathBuf,
}

fn private(path: &Path, mode: u32) {
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
}

impl Home {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "observations-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(root.join("reverie/observations/history")).unwrap();
        let home = fs::canonicalize(&root).unwrap();
        private(&home, 0o755);
        private(&home.join("reverie"), 0o700);
        let directory = home.join("reverie/observations");
        private(&directory, 0o700);
        let state = directory.join("history");
        private(&state, 0o700);
        let config = directory.join("config.json");
        let text = format!(
            "{{\n  \"version\": 1,\n  \"mode\": \"user-observations\",\n  \"stateDirectory\": \"{}\",\n  \"intervalSeconds\": 300,\n  \"retentionDays\": 30,\n  \"rollupRetentionDays\": 400,\n  \"drives\": {{}},\n  \"gpuExecutable\": null\n}}\n",
            state.display()
        );
        fs::write(&config, text).unwrap();
        private(&config, 0o600);
        let marker = state.join(".reverie-user-observations.json");
        fs::write(
            &marker,
            b"{\"application\":\"reverie-user-observations\",\"version\":1}\n",
        )
        .unwrap();
        private(&marker, 0o600);
        Self {
            home,
            config,
            state,
        }
    }

    fn write(&self, name: &str, rows: &[Value]) -> PathBuf {
        let path = self.state.join(name);
        let text: String = rows.iter().map(|row| format!("{row}\n")).collect();
        fs::write(&path, text).unwrap();
        private(&path, 0o600);
        path
    }

    fn query(
        &self,
        start: i64,
        end: i64,
        resolution: &str,
        gpu: Option<&str>,
        now: i64,
    ) -> Result<Value, String> {
        let request = HistoryRequest {
            start,
            end,
            resolution: resolution.into(),
            gpu: gpu.map(String::from),
            now,
        };
        let owner = Owner::new(&self.home).unwrap();
        query(owner, &self.config, &request)
            .map(|bytes| serde_json::from_slice(&bytes).unwrap())
            .map_err(|refused| refused.0.to_owned())
    }
}

impl Drop for Home {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.home);
    }
}

fn row(t: i64, utilization: i64, identity: Option<&str>, index: i64) -> Value {
    json!({"v": 2, "t": t, "interval_s": 300, "cpu_pct": 20, "mem_pct": 30, "gpu_pct": utilization,
           "gpu": {"status": "ok", "devices": [{"uuid": identity,
               "identity_status": if identity.is_some() { "available" } else { "unavailable" },
               "index": index, "util_pct": utilization}]}})
}

fn rollup(name: &str) -> Value {
    let text = include_str!("fixtures/collector-rollups.txt");
    let line = text
        .lines()
        .find_map(|line| line.strip_prefix(&format!("{name} ")))
        .unwrap();
    serde_json::from_str(line).unwrap()
}

fn gpu_avg(point: &Value) -> Option<f64> {
    point["gpu_pct"]["avg"].as_f64()
}

#[test]
fn identity_survives_index_reorder_and_missing_values_stay_gaps() {
    let home = Home::new();
    home.write(
        "samples-2026-10-25.jsonl",
        &[
            row(T, 40, Some(GPU), 7),
            row(T + 300, 60, Some(GPU), 0),
            row(T + 900, 80, None, 0),
        ],
    );
    let result = home
        .query(T, T + 1200, "five-minute", Some(GPU), T + 1200)
        .unwrap();
    let points = result["points"].as_array().unwrap();
    assert_eq!(
        points.iter().map(gpu_avg).collect::<Vec<_>>(),
        [Some(40.0), Some(60.0), None, None]
    );
    let statuses: Vec<_> = points
        .iter()
        .map(|p| p["status"].as_str().unwrap())
        .collect();
    assert_eq!(statuses, ["observed", "observed", "missing", "partial"]);
    assert_eq!(result["deviceUUIDs"], json!([GPU]));
    assert_eq!(result["employeeAttribution"], Value::Null);
    assert_eq!(result["effectAuthority"], json!(false));
    assert!(
        !result
            .to_string()
            .contains(&home.home.display().to_string())
    );
}

#[test]
fn additive_rollup_preserves_device_identity_and_legacy_older_device_gap() {
    let home = Home::new();
    let first = rollup("additive");
    let mut older = first.as_object().unwrap().clone();
    older.retain(|key, _| !key.starts_with("gpu_") || key == "gpu_pct");
    older.insert("start".into(), json!(T + 3600));
    older.insert("end".into(), json!(T + 7200));
    home.write("rollup-hour-2026-10.jsonl", &[first, Value::Object(older)]);
    let result = home
        .query(T, T + 7200, "hour", Some(GPU), T + 86400)
        .unwrap();
    assert_eq!(gpu_avg(&result["points"][0]), Some(40.0));
    assert_eq!(result["points"][1]["gpu_pct"], Value::Null);
    assert_eq!(result["freshness"], json!("missing"));
}

#[test]
fn restart_read_does_not_repair_or_write_and_truncated_record_is_explicit() {
    let home = Home::new();
    let file = home.write("samples-2026-10-25.jsonl", &[row(T, 40, Some(GPU), 0)]);
    let mut bytes = fs::read(&file).unwrap();
    bytes.extend_from_slice(b"{\"t\":");
    fs::write(&file, &bytes).unwrap();
    let snapshot = || {
        let mut entries: Vec<_> = fs::read_dir(&home.state)
            .unwrap()
            .map(|entry| {
                let path = entry.unwrap().path();
                (path.clone(), fs::read(path).unwrap())
            })
            .collect();
        entries.sort();
        entries
    };
    let before = snapshot();
    for _ in 0..2 {
        let result = home
            .query(T, T + 300, "five-minute", None, T + 300)
            .unwrap();
        assert_eq!(result["malformedLines"], json!(1));
        assert_eq!(result["freshness"], json!("fresh"));
    }
    assert_eq!(before, snapshot());
    assert_eq!(
        home.query(T, T + 300, "auto", None, T + 3600).unwrap()["freshness"],
        json!("stale")
    );
}

#[test]
fn read_bounds_and_custody_refuse_links_writable_config_and_invalid_query() {
    let home = Home::new();
    let outside = home.home.join("outside");
    fs::write(&outside, "not history").unwrap();
    let link = home.state.join("samples-2026-10-25.jsonl");
    std::os::unix::fs::symlink(&outside, &link).unwrap();
    assert!(home.query(T, T + 300, "auto", None, T + 300).is_err());
    fs::remove_file(&link).unwrap();
    // Python also refuses a bool start; the native interface takes integers only.
    for (start, end, gpu) in [
        (T, T + 401 * 86400, None),
        (T, T + 300, Some("../../secret")),
    ] {
        assert!(
            home.query(start, end, "auto", gpu, T + 500 * 86400)
                .is_err()
        );
    }
    private(&home.config, 0o644);
    assert!(home.query(T, T + 300, "auto", None, T + 300).is_err());
}

#[test]
fn recorded_device_disappearance_in_rollup_remains_partial() {
    let home = Home::new();
    home.write("rollup-hour-2026-10.jsonl", &[rollup("disappearance")]);
    let point = home
        .query(T, T + 3600, "hour", Some(GPU), T + 7200)
        .unwrap()["points"][0]
        .clone();
    assert_eq!(point["gpu_pct"]["n"], json!(1));
    assert_eq!(point["deviceIdentityMissing"], json!(11));
    assert_eq!(point["status"], json!("partial"));
}

#[test]
fn standalone_path_free_cli_reads_only_the_owned_fixture() {
    let home = Home::new();
    home.write("samples-2026-10-25.jsonl", &[row(T, 40, Some(GPU), 0)]);
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_reverie-resource-history"))
        .env_clear()
        .env("HOME", &home.home)
        .env("LANG", "C.UTF-8")
        .env("PATH", "/unavailable")
        .args(["--config".as_ref(), home.config.as_os_str()])
        .args(["--start", &T.to_string(), "--end", &(T + 300).to_string()])
        .args(["--resolution", "five-minute", "--gpu", GPU])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(0), "{output:?}");
    let stdout = String::from_utf8(output.stdout).unwrap();
    let value: Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(gpu_avg(&value["points"][0]), Some(40.0));
    assert!(!stdout.contains(&home.home.display().to_string()));
}

/// Sparse files above the 8 MiB read bound: had either been read in full,
/// the query would refuse, so success proves it was not.
fn sparse(path: &Path, size: u64, tail: &[u8]) {
    let file = fs::File::create(path).unwrap();
    file.set_len(size).unwrap();
    drop(file);
    if !tail.is_empty() {
        use std::io::Write;
        fs::OpenOptions::new()
            .append(true)
            .open(path)
            .unwrap()
            .write_all(tail)
            .unwrap();
    }
    private(path, 0o600);
}

#[test]
fn unrelated_oversized_retained_files_are_not_opened_for_recent_query() {
    let home = Home::new();
    sparse(&home.state.join("samples-2026-10-24.jsonl"), 33 << 20, b"");
    home.write("samples-2026-10-25.jsonl", &[row(T, 40, Some(GPU), 0)]);
    let value = home
        .query(T, T + 300, "five-minute", Some(GPU), T + 300)
        .unwrap();
    assert_eq!(gpu_avg(&value["points"][0]), Some(40.0));
    assert_eq!(value["lastSampleAt"], json!(T));
    assert_eq!(value["freshness"], json!("fresh"));
}

#[test]
fn historical_device_inventory_and_bounded_latest_freshness_have_separate_scope() {
    let home = Home::new();
    let recent_gpu = "GPU-fedcba98-7654-3210-fedc-ba9876543210";
    home.write(
        "samples-2026-10-24.jsonl",
        &[row(T - 86400, 40, Some(GPU), 0)],
    );
    let tail = format!("\n{}\n", row(T, 40, Some(recent_gpu), 0));
    sparse(
        &home.state.join("samples-2026-10-25.jsonl"),
        9 << 20,
        tail.as_bytes(),
    );
    let value = home
        .query(
            T - 86400,
            T - 86400 + 300,
            "five-minute",
            Some(GPU),
            T + 300,
        )
        .unwrap();
    assert_eq!(value["deviceUUIDs"], json!([GPU]));
    assert_eq!(value["deviceUUIDsScope"], json!("queried-records"));
    assert_eq!(value["lastSampleAt"], json!(T));
    assert_eq!(value["freshness"], json!("fresh"));
    assert_eq!(value["freshnessReadComplete"], json!(false));
}

#[test]
fn complete_rollup_and_partial_raw_buckets_are_never_silently_mixed() {
    let home = Home::new();
    let first = rollup("complete");
    let mut beyond = first.clone();
    beyond["start"] = json!(T + 3600);
    beyond["end"] = json!(T + 7200);
    home.write("rollup-hour-2026-10.jsonl", &[first, beyond]);
    home.write(
        "samples-2026-10-25.jsonl",
        &[
            row(T + 60, 99, Some(GPU), 0),
            row(T + 3600, 10, Some(GPU), 0),
            row(T + 4200, 30, Some(GPU), 0),
        ],
    );
    let value = home
        .query(T, T + 4500, "hour", Some(GPU), T + 4500)
        .unwrap();
    let points = value["points"].as_array().unwrap();
    let observed: Vec<_> = points
        .iter()
        .map(|p| (gpu_avg(p), p["samples"].as_i64()))
        .collect();
    assert_eq!(observed, [(Some(40.0), Some(12)), (Some(20.0), Some(2))]);
    assert_eq!(points[1]["status"], json!("partial"));
}

#[test]
fn legacy_rollup_uses_recorded_raw_uuid_when_available_else_preserves_gap() {
    let home = Home::new();
    let mut legacy = rollup("legacy");
    legacy.as_object_mut().unwrap().remove("gpu_devices");
    home.write("rollup-hour-2026-10.jsonl", &[legacy]);
    let raw = home.write(
        "samples-2026-10-25.jsonl",
        &[row(T, 5, Some(GPU), 0), row(T + 300, 15, Some(GPU), 0)],
    );
    let value = home
        .query(T, T + 3600, "hour", Some(GPU), T + 3600)
        .unwrap();
    assert_eq!(gpu_avg(&value["points"][0]), Some(10.0));
    assert_eq!(value["points"][0]["gpu_pct"]["n"], json!(2));
    fs::remove_file(raw).unwrap();
    let value = home
        .query(T, T + 3600, "hour", Some(GPU), T + 3600)
        .unwrap();
    assert_eq!(value["points"][0]["gpu_pct"], Value::Null);
}

#[test]
fn public_custody_refuses_parent_traversal_to_a_private_sibling() {
    let home = Home::new();
    let sibling = home.home.join("reverie/secret.jsonl");
    fs::write(&sibling, b"{\"t\":1}\n").unwrap();
    private(&sibling, 0o600);
    // Rooted one level down, `observations/../secret.jsonl` is lexically
    // inside the owner home but resolves outside it, as Python rejects.
    let inner = Owner::new(&home.home.join("reverie/observations")).unwrap();
    let escaped = home.home.join("reverie/observations/../secret.jsonl");
    let refusal = "User observation paths must be real descendants of the owner home";
    assert_eq!(inner.ancestry(&escaped).unwrap_err().0, refusal);
    assert_eq!(inner.private_bytes(&escaped, 1024).unwrap_err().0, refusal);
    assert_eq!(
        inner.freshness_tail(&escaped).err().map(|e| e.0),
        Some(refusal)
    );
    assert!(inner.ancestry(Path::new("reverie/secret.jsonl")).is_err());
    // The same file through its real path, from the home that contains it.
    let outer = Owner::new(&home.home).unwrap();
    assert_eq!(outer.private_bytes(&sibling, 1024).unwrap(), b"{\"t\":1}\n");
    assert_eq!(outer.freshness_tail(&sibling).unwrap().data, b"{\"t\":1}\n");
}
