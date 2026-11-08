//! Fixed build-only native child artifact producer acceptance.
use std::{
    fs,
    os::unix::fs::{DirBuilderExt, PermissionsExt},
    path::PathBuf,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

fn private_tree() -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "worker-child-program-{}-{nonce}",
        std::process::id()
    ));
    fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
    root
}

#[test]
#[ignore = "requires the declared immutable native worker child package"]
fn actual_native_program_manifest_is_exclusive_and_paired_root_is_verified() {
    let program = PathBuf::from(std::env::var_os("NIX_REVERIE_TEST_NATIVE_WORKER_CHILD").unwrap());
    let root = private_tree();
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
        panic!(
            "native child manifest missing: {}; retained {}",
            String::from_utf8_lossy(&first.stderr),
            root.display()
        );
    }
    let original = fs::read(&manifest).unwrap();
    let repeated = produce();
    fs::set_permissions(&manifest, fs::Permissions::from_mode(0o444)).unwrap();
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
