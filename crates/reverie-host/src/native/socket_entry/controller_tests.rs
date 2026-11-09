//! Owned ordinary-UID socket controls only; no root/controller namespace or
//! positive service-v2 endpoint is fabricated by this fixture.
use super::*;
use std::os::{fd::OwnedFd, unix::net::UnixListener};
fn isolated(name: &str) -> bool {
    crate::test_process::isolate_case(&format!("native::socket_entry::controller_tests::{name}"))
}
struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("controller-pin-{}", std::process::id()));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o770)).unwrap();
        Self(path)
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
#[test]
fn nonroot_controller_pin_refuses_without_chmod_or_losing_original_socket() {
    if isolated("nonroot_controller_pin_refuses_without_chmod_or_losing_original_socket") {
        return;
    }
    assert!(crate::native::uid() > 0, "declared ordinary-UID fixture");
    let tree = Tree::new();
    let path = tree.0.join("controller.sock");
    let listener = UnixListener::bind(&path).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    let original = fs::symlink_metadata(&path).unwrap();
    let mut entry = SocketEntry::created(path.clone());
    entry.open_anchor().unwrap();
    assert!(
        entry
            .finish_controller_pin(nix::unistd::getgid().as_raw())
            .is_err()
    );
    let after = fs::symlink_metadata(&path).unwrap();
    assert_eq!([after.dev(), after.ino()], [original.dev(), original.ino()]);
    assert_eq!(after.mode() & 0o7777, 0o600);
    assert!(entry.test_has_anchor());
    entry.remove().unwrap();
    assert!(!path.exists());
    crate::native::close(File::from(OwnedFd::from(listener))).unwrap();
}
#[test]
fn existing_v1_socket_pin_still_uses_exact_private_mode() {
    if isolated("existing_v1_socket_pin_still_uses_exact_private_mode") {
        return;
    }
    let tree = Tree::new();
    let path = tree.0.join("legacy.sock");
    let listener = UnixListener::bind(&path).unwrap();
    let mut entry = SocketEntry::created(path.clone());
    entry.open_anchor().unwrap();
    entry.finish_pin().unwrap();
    assert_eq!(fs::symlink_metadata(&path).unwrap().mode() & 0o7777, 0o600);
    entry.remove().unwrap();
    crate::native::close(File::from(OwnedFd::from(listener))).unwrap();
}
