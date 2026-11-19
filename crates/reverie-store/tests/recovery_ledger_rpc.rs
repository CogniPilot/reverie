use serde_json::{Value, json};
use std::{
    fs::{self, DirBuilder},
    io::Write,
    os::unix::fs::DirBuilderExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicUsize, Ordering},
};

static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Root(PathBuf);

impl Root {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "reverie-recovery-rpc-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed),
        ));
        DirBuilder::new().mode(0o700).create(&root).unwrap();
        Self(root)
    }
}

impl Drop for Root {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn run(path: &Path, input: &[u8]) -> Value {
    let mut child = Command::new(env!("CARGO_BIN_EXE_reverie-recovery-ledger"))
        .arg(path)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(input).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn recovery_ledger_rpc_has_closed_bounded_input_and_constant_refusals() {
    let root = Root::new();
    let db = root.0.join("owned ledger");
    let unavailable = json!({"ok":false,"code":"LEDGER_UNAVAILABLE"});
    for raw in [
        br#"{"op":"restart","now":0,"extra":true}"#.as_slice(),
        br#"{"op":"restart","now":0,"now":1}"#,
        br#"{"op":"restart","op":"restart","now":0}"#,
        br#"{"op":"restart","now":1.0}"#,
        br#"{"op":"restart","now":false}"#,
        br#"{"op":"restart","now":NaN}"#,
        br#"{"op":"reserve","now":0,"key":"a","binding":{"employee_id":"a","employee_id":"b","goal_id":"g","goal_generation":1,"session_id":"s","session_generation":1,"transition_sequence":0}}"#,
    ] {
        assert_eq!(run(&db, raw), unavailable);
    }
    let mut exact = br#"{"op":"restart","now":0}"#.to_vec();
    exact.resize(8192, b' ');
    assert_eq!(run(&db, &exact), json!({"ok":true,"result":[]}));
    exact.push(b' ');
    assert_eq!(run(&db, &exact), unavailable);
    assert_eq!(
        run(
            &root.0.join("missing").join("ledger"),
            br#"{"op":"restart","now":1}"#
        ),
        unavailable,
    );
}
