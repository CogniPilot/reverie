use super::*;
use std::{
    io::Write,
    sync::atomic::{AtomicU64, Ordering},
};
struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "of-pin-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        Self(root)
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
#[test]
fn actual_filesystem_anchor_prevents_inode_reuse_after_listener_close() {
    let tree = Tree::new();
    let (listener, mut entry) = bind(&tree.0).unwrap();
    let identity = entry.identity.unwrap();
    drop(listener);
    fs::remove_file(&entry.path).unwrap();
    for _ in 0..64 {
        let foreign = UnixListener::bind(&entry.path).unwrap();
        let metadata = fs::symlink_metadata(&entry.path).unwrap();
        assert_ne!(
            [metadata.dev(), metadata.ino()],
            identity,
            "filesystem inode was reused while its anchor was held"
        );
        drop(foreign);
        fs::remove_file(&entry.path).unwrap();
    }
    let foreign = UnixListener::bind(&entry.path).unwrap();
    assert!(matches!(entry.remove(), Err(OfficeError::Unconfirmed)));
    assert!(entry.path.exists());
    drop(foreign);
    fs::remove_file(&entry.path).unwrap();
    fs::write(&entry.path, b"replacement remains after uncertain close").unwrap();
    assert!(matches!(entry.remove(), Err(OfficeError::Unconfirmed)));
    assert_eq!(
        fs::read(&entry.path).unwrap(),
        b"replacement remains after uncertain close"
    );
}
#[test]
fn actual_anchor_close_failure_is_fenced_and_never_retries_a_consumed_descriptor() {
    let tree = Tree::new();
    let (listener, mut entry) = bind(&tree.0).unwrap();
    crate::native::test_faults::set(None, true);
    assert!(matches!(entry.remove(), Err(OfficeError::Unconfirmed)));
    assert!(entry.anchor.is_none());
    assert!(!entry.path.exists());
    let mut unrelated = File::create(tree.0.join("unrelated")).unwrap();
    assert!(matches!(entry.remove(), Err(OfficeError::Unconfirmed)));
    unrelated
        .write_all(b"unrelated descriptor remains usable")
        .unwrap();
    drop(listener);
}
