use crate::support::TestDir;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn fixture(root: &TestDir) -> PathBuf {
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/cargo_child.rs");
    let executable = root
        .path()
        .join(format!("cargo-child{}", std::env::consts::EXE_SUFFIX));
    let output = Command::new("rustc")
        .arg("--edition=2024")
        .arg(source)
        .arg("-o")
        .arg(&executable)
        .output()
        .expect("compile owned Rust fixture child");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    executable
}

fn run(root: &TestDir, program: &Path, verb: &str, fail: &str, signal: bool) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_xtask"));
    command
        .arg(verb)
        .env("CARGO", program)
        .env("XTASK_FIXTURE_TRACE", root.path().join("trace"))
        .env("XTASK_FIXTURE_FAIL", fail);
    if signal {
        command.env("XTASK_FIXTURE_SIGNAL", "1");
    }
    command.output().expect("run owned xtask fixture")
}

#[test]
fn check_and_verify_use_the_same_explicit_commands() {
    for verb in ["check", "verify"] {
        let root = TestDir::new();
        let executable = fixture(&root);
        let output = run(&root, &executable, verb, "", false);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            fs::read_to_string(root.path().join("trace")).expect("owned command trace"),
            "fmt --all --check\nclippy --locked --workspace --all-targets --all-features -- -D warnings\ntest --locked --workspace --all-targets --all-features\n"
        );
    }
}

#[test]
fn child_failure_stops_verification_and_returns_nonzero() {
    for (fail, count) in [("fmt", 1), ("clippy", 2), ("test", 3)] {
        let root = TestDir::new();
        let executable = fixture(&root);
        let output = run(&root, &executable, "verify", fail, false);
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("failed"));
        assert_eq!(
            fs::read_to_string(root.path().join("trace"))
                .expect("owned trace")
                .lines()
                .count(),
            count
        );
    }
}

#[cfg(unix)]
#[test]
fn a_signalled_child_is_not_reported_as_success() {
    let root = TestDir::new();
    let executable = fixture(&root);
    let output = run(&root, &executable, "verify", "fmt", true);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("signal"));
    assert_eq!(
        fs::read_to_string(root.path().join("trace"))
            .expect("owned trace")
            .lines()
            .count(),
        1
    );
}

#[test]
fn unknown_arguments_or_missing_tools_fail() {
    let root = TestDir::new();
    let absent = root.path().join("absent-cargo");
    assert!(!run(&root, &absent, "unknown", "", false).status.success());
    assert!(!run(&root, &absent, "verify", "", false).status.success());
    assert!(!root.path().join("trace").exists());
}

#[test]
fn portable_verification_selects_only_portable_components() {
    let root = TestDir::new();
    let executable = fixture(&root);
    let output = run(&root, &executable, "verify-portable", "", false);
    assert!(output.status.success());
    assert_eq!(
        fs::read_to_string(root.path().join("trace")).expect("owned command trace"),
        "fmt --all --check\nclippy --locked -p reverie-core -p reverie-contracts -p xtask --all-targets --all-features -- -D warnings\ntest --locked -p reverie-core -p reverie-contracts -p xtask --all-targets --all-features\n"
    );
}
