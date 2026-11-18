use nix::unistd::{Gid, Uid, chown, getgid, getuid, mkdtemp};
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt, symlink},
    path::{Path, PathBuf},
    process::{Command, Output},
};

const OLD: &str = "20261101T020000Z-aaaaaa";
const NEW: &str = "20261102T020000Z-bbbbbb";

struct Fixture {
    root: PathBuf,
    state: PathBuf,
    out: PathBuf,
    uid: Uid,
    gid: Gid,
}

impl Fixture {
    fn new() -> Self {
        let root = mkdtemp(&std::env::temp_dir().join("reverie-prune-report-XXXXXX")).unwrap();
        let state = root.join("state");
        let out = root.join("reports");
        fs::create_dir_all(state.join("logs")).unwrap();
        fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();
        fs::create_dir(&out).unwrap();
        let (uid, gid) = if getuid().is_root() {
            let (uid, gid) = (Uid::from_raw(65_534), Gid::from_raw(65_534));
            fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
            chown(&out, Some(uid), Some(gid)).unwrap();
            (uid, gid)
        } else {
            (getuid(), getgid())
        };
        Self {
            root,
            state,
            out,
            uid,
            gid,
        }
    }

    fn summary(&self, run: &str) {
        let summary = json!({
            "run_id": run, "mode": "dry", "passes": ["high-water"], "exit": 0,
            "deleted_or_would_bytes": 300, "ceiling_bytes": 1_000_000_000, "ceiling_hit": false,
            "df_before": [{"path": "/private/mount", "total": 1000, "free": 200, "used_pct": 80.0}],
            "df_after": [{"path": "/private/mount", "total": 1000, "free": 500, "used_pct": 50.0}],
            "by_decision": {"DELETED": 2, "SKIP": 1},
            "by_laptop": {"laptop-one": {"DELETED": 100, "SKIP": 7}, "laptop-two": {"DELETED": 200}},
        });
        let logs = self.state.join("logs");
        fs::write(
            logs.join(format!("{run}.summary.json")),
            summary.to_string(),
        )
        .unwrap();
        fs::write(
            logs.join(format!("{run}.jsonl")),
            r#"{"host_path":"/private/detail","repo":"o/r"}"#,
        )
        .unwrap();
    }

    fn command(&self, out: &Path, uid: Uid) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_reverie-prune-report-export"));
        command
            .env_clear()
            .arg("--state")
            .arg(&self.state)
            .arg("--out")
            .arg(out)
            .arg("--uid")
            .arg(uid.as_raw().to_string())
            .arg("--gid")
            .arg(self.gid.as_raw().to_string());
        command
    }

    fn export(&self) -> Output {
        self.command(&self.out, self.uid).output().unwrap()
    }

    fn latest(&self) -> Value {
        serde_json::from_slice(&fs::read(self.out.join("latest.json")).unwrap()).unwrap()
    }

    fn names(&self) -> Vec<String> {
        let mut names: Vec<_> = fs::read_dir(&self.out)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        names
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn projects_only_the_newest_aggregate_and_publishes_as_the_report_user() {
    let fixture = Fixture::new();
    fixture.summary(OLD);
    fixture.summary(NEW);
    let output = fixture
        .command(&fixture.out, fixture.uid)
        .env("SERVICE_RESULT", "success")
        .env("EXIT_CODE", "exited")
        .env("EXIT_STATUS", "0")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        fixture.names(),
        [format!("{NEW}.json"), "latest.json".to_owned()]
    );
    let latest = fixture.latest();
    assert_eq!(latest["service_result"], "success");
    assert_eq!(latest["exit_status"], "0");
    assert_eq!(latest["run_id"], NEW);
    assert_eq!(latest["new_summary"], true);
    let summary = &latest["summary"];
    assert_eq!(
        *summary,
        serde_json::from_slice::<Value>(
            &fs::read(fixture.out.join(format!("{NEW}.json"))).unwrap()
        )
        .unwrap()
    );
    assert_eq!(summary["deleted_or_would_bytes"], 300);
    assert_eq!(summary["laptops"], 2);
    assert_eq!(
        summary["count_by_decision"],
        json!({"DELETED": 2, "SKIP": 1})
    );
    assert_eq!(
        summary["laptop_bytes_by_decision"],
        json!({"DELETED": 300, "SKIP": 7})
    );
    assert_eq!(
        summary["disk_before"],
        json!([{"total": 1000, "free": 200, "used_pct": 80.0}])
    );
    assert_eq!(summary["started_utc"], "2026-11-02T02:00:00Z");
    assert!(summary["duration_s"].as_u64().is_some());
    for name in fixture.names() {
        let path = fixture.out.join(name);
        let text = fs::read_to_string(&path).unwrap();
        for private in ["/private", "laptop-one", "laptop-two", "o/r"] {
            assert!(!text.contains(private));
        }
        let metadata = fs::metadata(path).unwrap();
        assert_eq!(metadata.mode() & 0o777, 0o644);
        assert_eq!(metadata.uid(), fixture.uid.as_raw());
        assert_eq!(metadata.gid(), fixture.gid.as_raw());
    }
}

#[test]
fn failed_runs_publish_latest_without_overwriting_a_previous_summary() {
    let fixture = Fixture::new();
    fs::remove_dir(fixture.state.join("logs")).unwrap();
    assert!(fixture.export().status.success());
    assert_eq!(fixture.latest()["run_id"], Value::Null);
    assert_eq!(fixture.latest()["summary"], Value::Null);
    fs::create_dir(fixture.state.join("logs")).unwrap();
    fixture.summary(NEW);
    assert!(fixture.export().status.success());
    let history = fixture.out.join(format!("{NEW}.json"));
    let before = fs::read(&history).unwrap();
    let output = fixture
        .command(&fixture.out, fixture.uid)
        .env("SERVICE_RESULT", "exit-code")
        .env("EXIT_STATUS", "2")
        .output()
        .unwrap();
    assert!(output.status.success());
    let latest = fixture.latest();
    assert_eq!(latest["service_result"], "exit-code");
    assert_eq!(latest["exit_status"], "2");
    assert_eq!(latest["run_id"], NEW);
    assert_eq!(latest["new_summary"], false);
    assert_eq!(latest["summary"], Value::Null);
    assert_eq!(fs::read(history).unwrap(), before);
}

#[test]
fn retention_only_trims_recognized_history_past_sixty() {
    let fixture = Fixture::new();
    for day in 1..=30 {
        for hour in [1, 2] {
            let name = format!("202610{day:02}T0{hour}0000Z-fixture.json");
            fs::write(fixture.out.join(name), "{}").unwrap();
        }
    }
    fs::write(fixture.out.join("notes.json"), "{}").unwrap();
    fixture.summary(NEW);
    assert!(fixture.export().status.success());
    let history: Vec<_> = fixture
        .names()
        .into_iter()
        .filter(|name| name.starts_with("2026"))
        .collect();
    assert_eq!(history.len(), 60);
    assert_eq!(history[0], "20261001T020000Z-fixture.json");
    assert_eq!(history[59], format!("{NEW}.json"));
    assert!(fixture.out.join("notes.json").is_file());
}

#[test]
fn refuses_symlinked_directories_and_summaries_and_replaces_the_latest_symlink() {
    let fixture = Fixture::new();
    let victim = fixture.root.join("victim.json");
    fs::write(&victim, "{\"private\":true}").unwrap();
    let summary = fixture
        .state
        .join("logs")
        .join(format!("{NEW}.summary.json"));
    symlink(&victim, &summary).unwrap();
    assert!(!fixture.export().status.success());
    assert!(fixture.names().is_empty());
    fs::remove_file(summary).unwrap();
    fixture.summary(NEW);
    let alias = fixture.root.join("alias");
    symlink(&fixture.root, &alias).unwrap();
    assert!(
        !fixture
            .command(&alias.join("reports"), fixture.uid)
            .status()
            .unwrap()
            .success()
    );
    assert!(fixture.names().is_empty());
    symlink(&victim, fixture.out.join("latest.json")).unwrap();
    assert!(fixture.export().status.success());
    assert_eq!(fs::read_to_string(victim).unwrap(), "{\"private\":true}");
    assert!(!fixture.out.join("latest.json").is_symlink());
}

#[test]
fn credentials_refusals_and_malformed_aggregates_do_not_write() {
    let fixture = Fixture::new();
    fixture.summary(NEW);
    let root = fixture
        .command(&fixture.out, Uid::from_raw(0))
        .output()
        .unwrap();
    assert_eq!(root.status.code(), Some(2));
    if !getuid().is_root() {
        let other = Uid::from_raw(fixture.uid.as_raw() + 1);
        assert_eq!(
            fixture
                .command(&fixture.out, other)
                .output()
                .unwrap()
                .status
                .code(),
            Some(1)
        );
    }
    let summary = fixture
        .state
        .join("logs")
        .join(format!("{NEW}.summary.json"));
    fs::write(summary, r#"{"by_decision":{"SKIP":"/private/value"}}"#).unwrap();
    assert_eq!(fixture.export().status.code(), Some(1));
    assert!(fixture.names().is_empty());
}
