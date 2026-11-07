//! Actual candidate ELF in owned synthetic namespaces and public-client inputs.
//! PATH is a refusal witness only. Real journal caller qualification uses the
//! TypeScript API/auth/store test against the compile-bound candidate package.
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    path::PathBuf,
    process::{Command, Output, Stdio},
    sync::{
        OnceLock,
        atomic::{AtomicU64, Ordering},
    },
};
static NEXT: AtomicU64 = AtomicU64::new(0);
static FIXTURE: OnceLock<PathBuf> = OnceLock::new();
struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "memory-cli-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("config")).unwrap();
        fs::create_dir(root.join("bin")).unwrap();
        fs::write(root.join("config/instance.json"),r#"{"id":"synthetic","agent_name":"Agent","owner_name":"Owner","data_dir":"../state","persona":"Chosen persona"}"#).unwrap();
        Self(root.canonicalize().unwrap())
    }
    fn command(&self) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_reverie-memory"));
        command
            .env_clear()
            .env("HOME", &self.0)
            .env(
                "REVERIE_INSTANCE_CONFIG",
                self.0.join("config/instance.json"),
            )
            .env("REVERIE_EMBED_DIMS", "8")
            .env("PATH", self.0.join("bin"));
        command
    }
    fn journal(&self, mode: &str) {
        let binary = fixture();
        let modepath = self.0.join(mode);
        fs::hard_link(binary, &modepath).unwrap();
        std::os::unix::fs::symlink(modepath, self.0.join("bin/reverie")).unwrap();
    }
    fn run(&self, request: &Value) -> Output {
        run(self.command(), request)
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn fixture() -> &'static PathBuf {
    FIXTURE.get_or_init(|| {
        let root = std::env::temp_dir().join(format!("memory-cli-fixture-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        let source = root.join("child.rs");
        fs::write(
            &source,
            include_str!("../../reverie-host/tests/support/memory_journal_child.rs"),
        )
        .unwrap();
        let binary = root.join("normal");
        assert!(
            Command::new("rustc")
                .args(["--edition=2024", "-o"])
                .arg(&binary)
                .arg(&source)
                .status()
                .unwrap()
                .success()
        );
        binary
    })
}
fn run(mut command: Command, request: &Value) -> Output {
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(serde_json::to_string(request).unwrap().as_bytes())
        .unwrap();
    child.wait_with_output().unwrap()
}
fn success(output: Output) -> Value {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
fn failure(output: Output) -> String {
    assert!(!output.status.success());
    let value: Value = serde_json::from_slice(&output.stderr).unwrap();
    value["error"].as_str().unwrap().to_owned()
}
fn save_request() -> Value {
    json!({"action":"remember","private":true,"text":"A synthetic decision","room":"r","turn":"t","tag":"decision","quote":"exact words"})
}
#[test]
fn help_and_screen_do_not_load_an_instance_or_create_memory() {
    let tree = Tree::new();
    let output = tree
        .command()
        .env_remove("REVERIE_INSTANCE_CONFIG")
        .arg("--help")
        .output()
        .unwrap();
    assert!(output.status.success());
    let mut command = tree.command();
    command.arg("--instance").arg(tree.0.join("does-not-exist"));
    assert_eq!(
        success(run(
            command,
            &json!({"action":"screen","text":"A synthetic decision"})
        )),
        json!({"floor":""})
    );
    assert!(!tree.0.join("state").exists());
    assert!(
        failure(tree.run(&json!({"action":"screen","text":"ok","database":"untrusted"})))
            .contains("unsupported")
    );
}
#[test]
fn configured_rules_are_never_skipped_and_fixed_floors_precede_journal() {
    let tree = Tree::new();
    let mut command = tree.command();
    command.env(
        "REVERIE_OUTPUT_POLICY",
        r#"{"denied_patterns":["(?=forbidden)forbidden"]}"#,
    );
    assert_eq!(
        success(run(command, &json!({"action":"screen","text":"FORBIDDEN"}))),
        json!({"floor":"configured output policy"})
    );
    let mut request = save_request();
    request["text"] = json!("Contact Fictional Person at person@example.org");
    assert!(failure(tree.run(&request)).contains("hard floor"));
    assert!(!tree.0.join("state").exists());
}
#[test]
fn missing_source_or_session_never_dispatches_and_retains_copyable_command() {
    let tree = Tree::new();
    let request = save_request();
    assert!(failure(tree.run(&request)).contains("Nothing was saved"));
    let mut missing = request;
    missing.as_object_mut().unwrap().remove("quote");
    let error = failure(tree.run(&missing));
    assert!(error.contains("Nothing was saved"));
    assert!(error.contains("reverie agent journal save"));
    assert!(!tree.0.join("trace").exists());
    assert!(!tree.0.join("state").exists());
}
#[test]
fn missing_recall_is_not_initialized_and_explicit_startup_is_idempotent() {
    let tree = Tree::new();
    let recall = json!({"action":"recall","private":true,"query":"decision"});
    assert!(failure(tree.run(&recall)).contains("initialized"));
    assert!(!tree.0.join("state").exists());
    assert_eq!(
        success(tree.command().arg("--initialize").output().unwrap()),
        json!({"initialized":true})
    );
    let before = database_rows(&tree.0.join("state/memory.sqlite"));
    let profile = fs::read(tree.0.join("state/profile.md")).unwrap();
    assert_eq!(
        success(tree.command().arg("--initialize").output().unwrap()),
        json!({"initialized":true})
    );
    assert_eq!(database_rows(&tree.0.join("state/memory.sqlite")), before);
    assert_eq!(fs::read(tree.0.join("state/profile.md")).unwrap(), profile);
    assert!(success(tree.run(&recall)).is_array());
    let mut changed = tree.command();
    changed.env("REVERIE_EMBED_DIMS", "16");
    assert!(failure(run(changed, &recall)).contains("migration"));
    assert_eq!(database_rows(&tree.0.join("state/memory.sqlite")), before);
}
#[test]
fn actual_project_recall_without_a_session_stays_read_only_and_separate() {
    let tree = Tree::new();
    success(
        tree.command()
            .args(["--initialize", "--project", "project-one"])
            .output()
            .unwrap(),
    );
    assert!(!tree.0.join("state/memory.sqlite").exists());
    let database = tree.0.join("state/projects/project-one/memory.sqlite");
    let before = database_rows(&database);
    let reply = success(run(
        tree.command(),
        &json!({"action":"recall","project":"project-one","query":"decision"}),
    ));
    assert_eq!(reply, json!([]));
    assert_eq!(database_rows(&database), before);
    assert!(!tree.0.join("state/memory.sqlite").exists());
}
#[test]
fn path_frontends_never_select_the_journal_client() {
    let tree = Tree::new();
    tree.journal("normal");
    let mut command = tree.command();
    command
        .env("REVERIE_SESSION_ID", "synthetic-session")
        .env("REVERIE_API_URL", "http://127.0.0.1:0")
        .env("REVERIE_NO_AUTOSTART", "1")
        .env("REVERIE_MUX", "1")
        .env("OWNED_JOURNAL_TRACE", tree.0.join("trace"));
    let error = failure(run(command, &save_request()));
    assert!(!error.contains("synthetic-id"));
    assert!(!tree.0.join("trace").exists());
    assert!(!tree.0.join("state").exists());
}
fn database_rows(path: &std::path::Path) -> Vec<(String, Vec<Vec<rusqlite::types::Value>>)> {
    let database =
        rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .unwrap();
    let tables = database
        .prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .map(|row| row.unwrap())
        .collect::<Vec<_>>();
    let mut result = Vec::new();
    for table in tables {
        let sql = format!(
            "SELECT * FROM \"{}\" ORDER BY rowid",
            table.replace('"', "\"\"")
        );
        let mut query = database.prepare(&sql).unwrap();
        let count = query.column_count();
        let rows = query
            .query_map([], |row| {
                (0..count)
                    .map(|index| row.get(index))
                    .collect::<rusqlite::Result<Vec<rusqlite::types::Value>>>()
            })
            .unwrap()
            .map(|row| row.unwrap())
            .collect();
        result.push((table, rows));
    }
    database.close().unwrap();
    result
}
