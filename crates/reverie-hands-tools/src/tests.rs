use super::*;
use serde_json::{Value, json};
use std::{
    env, fs,
    os::unix::fs::{PermissionsExt, symlink},
    time::{Duration, Instant},
};
use uuid::Builder;

struct Fixture {
    root: PathBuf,
    task: PathBuf,
    work: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let mut entropy = [0; 16];
        getrandom::getrandom(&mut entropy).unwrap();
        let root = env::temp_dir().canonicalize().unwrap().join(format!(
            "rv-hands-{}",
            Builder::from_random_bytes(entropy).into_uuid()
        ));
        fs::create_dir(&root).unwrap();
        let task = root.join("example");
        let work = task.join("work");
        fs::create_dir_all(&work).unwrap();
        let fixture = Self { root, task, work };
        fixture.manifest(json!({"version": 1, "task_id": "example"}));
        fixture
    }

    fn manifest(&self, value: Value) {
        fs::write(self.task.join("manifest.json"), value.to_string()).unwrap();
    }

    fn call(&self, tool: &str, args: Value) -> Value {
        self.raw(json!({"version": 1, "name": tool, "args": args}))
    }

    fn raw(&self, request: Value) -> Value {
        let task = task::Task::read(&self.root, &self.task).unwrap();
        let options = Options {
            root: self.root.clone(),
            task_dir: self.task.clone(),
            timeout_s: 3,
            max_output_bytes: 24_000,
            tool_path: Some(tool("ls").parent().unwrap().to_path_buf()),
            command_telemetry: false,
        };
        let settings = commands::Settings::new(&options).unwrap();
        let response = protocol::dispatch(&task, &settings, request.to_string().as_bytes())
            .unwrap_or_else(Reply::refused)
            .bounded(4000);
        serde_json::to_value(response).unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}

fn tool(name: &str) -> PathBuf {
    env::split_paths(&env::var_os("PATH").unwrap())
        .map(|directory| directory.join(name))
        .find(|path| path.is_file())
        .unwrap_or_else(|| panic!("required coreutils program {name}"))
}

fn output(reply: &Value) -> &str {
    assert_eq!(reply["ok"], true, "{reply}");
    reply["output"].as_str().unwrap()
}

#[test]
fn version_one_tools_read_list_search_edit_write_and_run_manifest_tests() {
    let fixture = Fixture::new();
    let write = fixture.call(
        "write_file",
        json!({"path": "src/program.txt", "content": "Word\r\nword\u{85}last\n"}),
    );
    assert_eq!(output(&write), "created src/program.txt (17 bytes)");
    let path = fixture.work.join("src/program.txt");
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    let read = fixture.call(
        "read_file",
        json!({"path": "src/program.txt", "offset": 2, "limit": 1}),
    );
    assert_eq!(
        output(&read),
        "     2\tword\n[showing lines 2-2 of 3; continue with offset=3]"
    );
    assert_eq!(read["truncated"], true);
    let list = fixture.call("list_files", json!({}));
    assert_eq!(output(&list), "src/\nsrc/program.txt");
    let found = fixture.call(
        "search_files",
        json!({"pattern": "(?<=^)[W]ord", "glob": "*.txt"}),
    );
    assert_eq!(output(&found), "src/program.txt:1:Word");
    let edited = fixture.call(
        "edit_file",
        json!({"path": "src/program.txt", "old": "last", "new": "after"}),
    );
    assert!(output(&edited).contains("1 replacement(s)"));
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o755
    );
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        "Word\r\nword\u{85}after\n"
    );
    fixture.manifest(json!({"version": 1, "task_id": "example", "test_argv": [tool("cat")]}));
    let test = fixture.call("run_tests", json!({"select": ["src/program.txt"]}));
    assert_eq!(test["exit_code"], 0);
    assert!(output(&test).contains("after"));
    assert_eq!(
        fixture.call("run_tests", json!({"select": ["--version"]}))["ok"],
        false
    );
}

#[test]
fn direct_task_identity_and_workspace_aliases_are_checked() {
    let fixture = Fixture::new();
    assert!(task::Task::read(&fixture.root, &fixture.task).is_ok());
    let alias = fixture.root.join("alias");
    symlink(&fixture.task, &alias).unwrap();
    assert!(task::Task::read(&fixture.root, &alias).is_err());
    fixture.manifest(json!({"version": 1, "task_id": "different"}));
    assert!(task::Task::read(&fixture.root, &fixture.task).is_err());
    fixture.manifest(json!({"version": 1, "task_id": "example"}));
    let manifest = fixture.task.join("manifest.json");
    fs::rename(&manifest, fixture.root.join("outside")).unwrap();
    symlink(fixture.root.join("outside"), &manifest).unwrap();
    assert!(task::Task::read(&fixture.root, &fixture.task).is_err());
}

#[test]
fn file_reads_and_edits_check_workspace_path_and_git_aliases() {
    let fixture = Fixture::new();
    fs::write(fixture.root.join("foreign"), "proof").unwrap();
    symlink(fixture.root.join("foreign"), fixture.work.join("outside")).unwrap();
    for path in ["../foreign", "/etc/passwd", "outside"] {
        assert_eq!(
            fixture.call("read_file", json!({"path": path}))["ok"],
            false
        );
    }
    fs::create_dir(fixture.work.join(".git")).unwrap();
    symlink(".git", fixture.work.join("metadata")).unwrap();
    assert_eq!(
        fixture.call(
            "write_file",
            json!({"path": "metadata/config", "content": "do not write"})
        )["ok"],
        false
    );
    assert!(!fixture.work.join(".git/config").exists());
    let listing = fixture.call("list_files", json!({}));
    assert!(output(&listing).contains("outside@"));
    let search = fixture.call("search_files", json!({"fixed": true, "pattern": "proof"}));
    assert!(output(&search).contains("[no matches]"));
    assert!(output(&search).contains("file(s) skipped"));
}

#[test]
fn command_start_exit_capture_truncation_and_deadline_keep_the_wire_contract() {
    let fixture = Fixture::new();
    let nonzero = fixture.call("run_command", json!({"argv": [tool("false")]}));
    assert_eq!(nonzero["exit_code"], 1);
    assert!(output(&nonzero).starts_with("exit_code: 1"));
    let missing = fixture.call(
        "run_command",
        json!({"argv": ["reverie-synthetic-unavailable-program"]}),
    );
    assert_eq!(missing["ok"], false);
    assert!(
        missing["error"]
            .as_str()
            .unwrap()
            .contains("could not start")
    );
    let truncated = fixture.raw(json!({"version": 1, "name": "run_command",
        "args": {"argv": [tool("seq"), "5000"]}, "max_output_chars": 500}));
    assert_eq!(truncated["truncated"], true);
    assert!(output(&truncated).contains("bytes omitted"));
    assert!(output(&truncated).chars().count() <= 500);
    let now = Instant::now();
    let timeout = fixture.call(
        "run_command",
        json!({"argv": [tool("sleep"), "15"], "timeout_s": 1}),
    );
    assert_eq!(timeout["ok"], false);
    assert_eq!(timeout["exit_code"], Value::Null);
    assert!(
        timeout["error"]
            .as_str()
            .unwrap()
            .contains("timed out after 1 s")
    );
    assert!(now.elapsed() < Duration::from_secs(5));
}

#[test]
fn rejects_invalid_requests_and_respects_escaped_json_budgets() {
    let fixture = Fixture::new();
    for request in [
        json!({"version": 2, "name": "list_files"}),
        json!({"version": 1, "name": "list_files", "observer": {}}),
        json!({"version": 1, "name": "list_files", "max_output_chars": 499}),
        json!({"version": 1, "name": "list_files", "args": {"depth": true}}),
        json!({"version": 1, "name": "write_file", "args": {"path": "out", "content": "😀".repeat(2001)}}),
    ] {
        assert_eq!(fixture.raw(request)["ok"], false);
    }
    assert!(!fixture.work.join("out").exists());
    let reply = Reply::text("\n😀".repeat(500), false).bounded(170);
    let bytes = serde_json::to_vec(&reply).unwrap();
    assert!(bytes.len() < 170);
    assert_eq!(serde_json::to_value(reply).unwrap()["truncated"], true);
}

#[test]
fn optional_office_and_command_environment_do_not_forward_ambient_credentials() {
    let fixture = Fixture::new();
    let reply = fixture.call("run_command", json!({"argv": [tool("env")]}));
    let report = output(&reply);
    assert!(report.contains(format!("HOME={}", fixture.work.display()).as_str()));
    assert!(!report.contains("REVERIE_API_KEY"));
    assert!(!report.contains("REVERIE_SESSION_ID"));
}
