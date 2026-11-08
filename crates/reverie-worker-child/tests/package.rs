//! Actual selected public package qualification, invoked by the thin xtask.
use std::{fs, path::PathBuf, process::Command};

#[test]
#[ignore = "requires actual Nix-selected workerChild and workerNativeChild artifacts"]
fn selected_public_runtime_child_is_native_and_supports_pane_exit() {
    let selected = PathBuf::from(
        std::env::var_os("NIX_REVERIE_TEST_SELECTED_WORKER_CHILD")
            .expect("use cargo xtask verify-worker-child-package"),
    );
    let native = PathBuf::from(
        std::env::var_os("NIX_REVERIE_TEST_NATIVE_WORKER_CHILD")
            .expect("use cargo xtask verify-worker-child-package"),
    );
    let selected = fs::canonicalize(selected).unwrap();
    let native = fs::canonicalize(native).unwrap();
    assert!(selected.starts_with("/nix/store") && native.starts_with("/nix/store"));
    assert_eq!(selected, native, "runtime selects a different worker child");
    assert!(fs::read(&selected).unwrap().starts_with(b"\x7fELF"));
    let help = Command::new(&selected).arg("--help").output().unwrap();
    assert!(help.status.success());
    assert!(
        String::from_utf8(help.stdout)
            .unwrap()
            .contains("--pane-exit")
    );
    let refusal = Command::new(selected)
        .args([
            "/not-a-private-launch/owned.json",
            "--pane-exit",
            "/not-a-private-launch/owned.exit",
        ])
        .output()
        .unwrap();
    assert_eq!(
        refusal.status.code(),
        Some(1),
        "pane-exit must parse before the fixed record-scope refusal"
    );
    assert!(
        String::from_utf8(refusal.stderr)
            .unwrap()
            .contains("record=Untouched")
    );
}
