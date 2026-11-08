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

#[test]
#[ignore = "requires the declared immutable actual v1 worker image provenance"]
fn actual_v1_base_derives_its_only_child_annex_without_rewriting_the_base() {
    use sha2::{Digest, Sha256};
    let base = PathBuf::from(std::env::var_os("NIX_REVERIE_TEST_WORKER_BASE_PROVENANCE").unwrap());
    let original = fs::read(&base).unwrap();
    let value: serde_json::Value = serde_json::from_slice(&original).unwrap();
    let root = private_tree();
    let output = root.join("annex.json");
    let produce = || {
        Command::new(env!("CARGO_BIN_EXE_reverie-policy-artifacts"))
            .args(["worker-child-image-annex", "--base-provenance"])
            .arg(&base)
            .arg("--output")
            .arg(&output)
            .output()
            .unwrap()
    };
    let first = produce();
    assert!(
        first.status.success(),
        "{}; retained {}",
        String::from_utf8_lossy(&first.stderr),
        root.display()
    );
    let annex: serde_json::Value = serde_json::from_slice(&fs::read(&output).unwrap()).unwrap();
    let repeated = produce();
    assert!(!repeated.status.success());
    assert_eq!(fs::read(&base).unwrap(), original);
    assert_eq!(annex["baseProvenance"]["sha256"], format!("{:x}", Sha256::digest(&original)));
    assert_eq!(annex["imageSpec"], value["imageSpec"]);
    assert_eq!(annex["archive"], value["archive"]);
    assert_eq!(annex["factory"], value["factory"]);
    assert_eq!(annex["archiveConfigSHA256"], value["archiveConfigSHA256"]);
    assert_eq!(annex["workerChild"]["manifest"]["path"], value["imageSpec"]["Config"]["Labels"]["org.reverie.worker.child-manifest"]);
    fs::remove_file(output).unwrap();
    fs::remove_dir(root).unwrap();
}
