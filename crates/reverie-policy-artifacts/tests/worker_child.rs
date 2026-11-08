//! Fixed build-only native child artifact producer acceptance.
use std::{fs, path::PathBuf, process::Command};

#[test]
#[ignore = "requires the declared immutable native worker child package"]
fn actual_native_program_manifest_is_exclusive_and_paired_root_is_verified() {
    let program = PathBuf::from(std::env::var_os("NIX_REVERIE_TEST_NATIVE_WORKER_CHILD").unwrap());
    let root = std::env::temp_dir().join(format!("worker-child-program-{}", std::process::id()));
    fs::create_dir(&root).unwrap();
    let manifest = root.join("program.json");
    let produce = || {
        Command::new(env!("CARGO_BIN_EXE_reverie-policy-artifacts"))
            .arg("worker-child-program")
            .arg("--program")
            .arg(&program)
            .arg("--output")
            .arg(&manifest)
            .output()
            .unwrap()
    };
    let first = produce();
    if !first.status.success() {
        fs::remove_dir(root).unwrap();
        panic!(
            "native child manifest missing: {}",
            String::from_utf8_lossy(&first.stderr)
        );
    }
    let original = fs::read(&manifest).unwrap();
    let repeated = produce();
    let verify = Command::new(env!("CARGO_BIN_EXE_reverie-policy-artifacts"))
        .arg("verify-worker-child-root")
        .arg("--program")
        .arg(&program)
        .arg("--manifest")
        .arg(&manifest)
        .output()
        .unwrap();
    let changed = fs::read(&manifest).unwrap();
    fs::remove_file(manifest).unwrap();
    fs::remove_dir(root).unwrap();
    assert!(!repeated.status.success());
    assert_eq!(original, changed);
    assert!(
        String::from_utf8(original)
            .unwrap()
            .contains("record-pane-exit-v1")
    );
    assert!(
        verify.status.success(),
        "{}",
        String::from_utf8_lossy(&verify.stderr)
    );
}
