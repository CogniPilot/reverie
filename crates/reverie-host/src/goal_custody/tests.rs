//! Native private descriptors and consumed-close evidence. The installing
//! actor's separate controls use genuine G kernel records and whole projection.
use super::*;
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    sync::atomic::{AtomicUsize, Ordering},
};
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "goal-private-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        Self(path)
    }
    fn write(&self, name: &str, bytes: &[u8]) {
        let path = self.0.join(name);
        fs::write(&path, bytes).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
#[test]
fn private_batch_keeps_original_fd_but_rejects_replaced_name_and_new_optional_entry() {
    let tree = Tree::new();
    tree.write("original", b"{}");
    let mut files = PrivateBatch::new().unwrap();
    let (stamp, bytes) = files.read_json_file(&tree.0.join("original")).unwrap();
    assert_eq!(stamp.0[2], "2");
    assert_eq!(bytes, b"{}");
    files.check().unwrap();
    fs::rename(tree.0.join("original"), tree.0.join("saved")).unwrap();
    tree.write("original", b"{}");
    assert!(files.check().is_err());
    files.close().unwrap();
    let mut files = PrivateBatch::new().unwrap();
    assert!(
        files
            .inspect(&tree.0.join("optional"), false, true)
            .unwrap()
            .is_none()
    );
    tree.write("optional", b"");
    assert!(files.check().is_err());
    files.close().unwrap();
}
#[test]
fn private_batch_refuses_symlinks_group_access_and_sticky_close_uncertainty() {
    let tree = Tree::new();
    tree.write("data", b"{}");
    std::os::unix::fs::symlink("data", tree.0.join("alias")).unwrap();
    let mut files = PrivateBatch::new().unwrap();
    assert!(files.read_json_file(&tree.0.join("alias")).is_err());
    files.close().unwrap();
    fs::set_permissions(tree.0.join("data"), fs::Permissions::from_mode(0o640)).unwrap();
    let mut files = PrivateBatch::new().unwrap();
    assert!(files.read_json_file(&tree.0.join("data")).is_err());
    files.close().unwrap();
    tree.write("data", b"{}");
    let mut files = PrivateBatch::new().unwrap();
    files.read_json_file(&tree.0.join("data")).unwrap();
    assert!(has_tree_descriptor(&tree.0));
    native::test_faults::set(None, true);
    assert!(files.close().is_err());
    assert!(
        !has_tree_descriptor(&tree.0),
        "every owned descriptor was consumed despite first error"
    );
    assert!(
        files.close().is_err(),
        "empty handles are not a retry success"
    );
    native::test_faults::set(None, false);
}
fn has_tree_descriptor(root: &Path) -> bool {
    fs::read_dir("/proc/self/fd")
        .unwrap()
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| fs::read_link(entry.path()).ok())
        .any(|target| target.starts_with(root))
}
#[test]
fn first_private_configuration_identity_is_sticky_and_uses_full_generation() {
    let tree = Tree::new();
    tree.write("config", b"{}");
    let state = GoalCustodyState::new();
    let mut files = PrivateBatch::new().unwrap();
    let (original, _) = files.read_json_file(&tree.0.join("config")).unwrap();
    state.observe_identity(&original).unwrap();
    state.observe_identity(&original).unwrap();
    tree.write("config", b"{ }");
    let (changed, _) = files.read_json_file(&tree.0.join("config")).unwrap();
    assert!(state.observe_identity(&changed).is_err());
    files.close().unwrap();
}
