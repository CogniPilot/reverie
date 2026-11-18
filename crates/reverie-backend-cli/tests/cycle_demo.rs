use nix::unistd::mkdtemp;
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        Self(mkdtemp(&std::env::temp_dir().join("reverie-cycle-demo-XXXXXX")).unwrap())
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn demo(path: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_reverie-cycle-demo"));
    command.arg("--directory").arg(path).args([
        "--api-base",
        "http://127.0.0.1:8080/v1",
        "--model",
        "fixture",
    ]);
    command
}

fn read(path: &Path) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

#[test]
fn keeps_the_trial_layout_and_cli_receipt() {
    let fixture = Fixture::new();
    let output = demo(&fixture.0).output().unwrap();
    assert!(output.status.success(), "{:?}", output.stderr);
    let policy_path = fixture.0.join("daily-cycle.json");
    let receipt: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        receipt,
        json!({"policy": policy_path, "next": "reverie-cycle --policy POLICY once"})
    );
    assert_eq!(fs::metadata(&policy_path).unwrap().mode() & 0o777, 0o600);
    let policy = read(&policy_path);
    assert_eq!(policy["models"]["local"]["model"], "fixture");
    assert_eq!(
        policy["tasks"][0]["verification"],
        json!([["node", "verify.mjs"]])
    );
    assert!(fixture.0.join("project/verify.mjs").is_file());
    for name in ["cto", "math"] {
        let path = fixture.0.join("instances").join(format!("{name}.json"));
        assert_eq!(policy["agents"][name]["instance"], json!(path));
        assert_eq!(read(&path)["data_dir"], format!("../memory/{name}"));
        assert_eq!(fs::metadata(path).unwrap().mode() & 0o777, 0o600);
    }
}

#[test]
fn refuses_a_second_publisher_and_preserves_occupied_directories() {
    let fixture = Fixture::new();
    let root = fixture.0.join("concurrent");
    let publish = || {
        demo(&root)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap()
    };
    let mut left = publish();
    let outcomes = [publish().wait().unwrap(), left.wait().unwrap()];
    assert_eq!(outcomes.iter().filter(|result| result.success()).count(), 1);
    let published = fs::read(root.join("daily-cycle.json")).unwrap();
    let member = root.join("private-existing.txt");
    fs::write(&member, b"retained").unwrap();
    assert!(!demo(&root).output().unwrap().status.success());
    assert_eq!(fs::read(member).unwrap(), b"retained");
    assert_eq!(fs::read(root.join("daily-cycle.json")).unwrap(), published);
}
