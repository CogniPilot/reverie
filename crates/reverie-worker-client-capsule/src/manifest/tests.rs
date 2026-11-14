use super::*;
use std::{
    os::unix::fs::{PermissionsExt, symlink},
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "worker-client-capsule-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("bin")).unwrap();
        for name in [
            "bin/node",
            "bin/reverie",
            "bin/reverie.mjs",
            "claude-hooks.json",
        ] {
            fs::write(root.join(name), b"controlled artifact DATA, never executed").unwrap();
        }
        fs::set_permissions(root.join("bin/node"), fs::Permissions::from_mode(0o755)).unwrap();
        fs::set_permissions(root.join("bin/reverie"), fs::Permissions::from_mode(0o755)).unwrap();
        Self(root)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
#[test]
fn inventory_is_canonical_sorted_and_maps_final_readonly_modes() {
    let tree = Fixture::new();
    write(&tree.0).unwrap();
    let bytes = fs::read(tree.0.join("manifest.json")).unwrap();
    let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value["version"], 1);
    assert_eq!(value["purpose"], "reverie-worker-client-v1");
    assert_eq!(value["files"][0]["path"], "bin/node");
    assert_eq!(value["files"][0]["mode"], 0o555);
    assert_eq!(value["files"][1]["mode"], 0o555);
    assert_eq!(value["files"][2]["mode"], 0o444);
    assert!(
        !value["files"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["path"] == "manifest.json")
    );
    assert!(
        std::str::from_utf8(&bytes)
            .unwrap()
            .starts_with("{\"version\":1,\"purpose\":")
    );
}
#[test]
fn foreign_symlink_is_refused_without_reading_its_target() {
    let tree = Fixture::new();
    symlink("/does-not-exist", tree.0.join("foreign")).unwrap();
    assert!(write(&tree.0).is_err());
    assert!(!tree.0.join("manifest.json").exists());
}
#[test]
fn missing_runtime_and_oversize_file_refuse_manifest_publication() {
    let tree = Fixture::new();
    fs::remove_file(tree.0.join("bin/node")).unwrap();
    assert!(write(&tree.0).is_err());
    fs::write(tree.0.join("bin/node"), b"DATA").unwrap();
    fs::OpenOptions::new()
        .write(true)
        .open(tree.0.join("bin/node"))
        .unwrap()
        .set_len(MAX_FILE_BYTES + 1)
        .unwrap();
    assert!(write(&tree.0).is_err());
    assert!(!tree.0.join("manifest.json").exists());
}
