use super::*;
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::PathBuf,
};
struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "autoenv-finalizers-{}-{}",
            std::process::id(),
            TEMP.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        Self(path)
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        FAIL_CREATOR_CLOSE.with(|failure| failure.set(false));
        fs::remove_dir_all(&self.0).unwrap();
    }
}
#[test]
fn refused_publication_and_actual_creator_close_failure_both_remain_visible() {
    let tree = Tree::new();
    let cache = tree.0.join("cache");
    fs::create_dir(&cache).unwrap();
    let sentinel = tree.0.join("sentinel");
    fs::write(&sentinel, b"unchanged").unwrap();
    symlink(&sentinel, cache.join("owned-key.env")).unwrap();
    FAIL_CREATOR_CLOSE.with(|failure| failure.set(true));
    let error = publish(&cache, "owned-key", b"A=x\0", b"{}").unwrap_err();
    let text = error.to_string();
    assert!(text.contains("unsafe"), "original refusal retained: {text}");
    assert!(
        text.contains("injected close failure"),
        "secondary close retained: {text}"
    );
    assert_eq!(fs::read(&sentinel).unwrap(), b"unchanged");
    assert_eq!(
        fs::read_dir(cache).unwrap().count(),
        1,
        "both private temporary leaves cleaned"
    );
}
#[test]
fn actual_close_failure_after_rename_never_acknowledges_success_or_replays_publication() {
    let tree = Tree::new();
    let cache = tree.0.join("cache");
    FAIL_CREATOR_CLOSE.with(|failure| failure.set(true));
    let error = publish(&cache, "owned-key", b"A=x\0", b"{}").unwrap_err();
    assert!(error.to_string().contains("unconfirmed"));
    assert_eq!(fs::read(cache.join("owned-key.env")).unwrap(), b"A=x\0");
    assert_eq!(fs::read(cache.join("owned-key.json")).unwrap(), b"{}");
    assert_eq!(fs::read_dir(cache).unwrap().count(), 2);
}
