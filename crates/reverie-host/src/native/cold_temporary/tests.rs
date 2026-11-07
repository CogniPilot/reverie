use super::*;
use crate::native;
use std::{
    ffi::OsStr,
    os::{
        fd::AsRawFd,
        unix::fs::{MetadataExt, PermissionsExt},
    },
};
struct Fixture {
    path: std::path::PathBuf,
    parent: Option<File>,
    epoch: Option<File>,
}
impl Fixture {
    fn new() -> Self {
        let name = reverie_store::worker_storage::instruction_temporary_name().unwrap();
        let path = std::env::temp_dir().join(format!("cold-rename-{name}"));
        std::fs::create_dir(&path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        for name in ["tmp", "epoch"] {
            std::fs::create_dir(path.join(name)).unwrap();
        }
        let open = |path: &std::path::Path| {
            native::open_at(
                libc::AT_FDCWD,
                path.as_os_str(),
                libc::O_RDONLY | libc::O_DIRECTORY,
            )
            .unwrap()
        };
        let parent = open(&path);
        let epoch = open(&path.join("epoch"));
        std::fs::write(path.join("tmp/payload"), b"unchanged old bytes\0\xff").unwrap();
        Self {
            path,
            parent: Some(parent),
            epoch: Some(epoch),
        }
    }
    fn parent(&self) -> &File {
        self.parent.as_ref().unwrap()
    }
    fn epoch(&self) -> &File {
        self.epoch.as_ref().unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let held = self.parent().metadata().unwrap();
        let named = std::fs::symlink_metadata(&self.path).unwrap();
        assert_eq!((held.dev(), held.ino()), (named.dev(), named.ino()));
        native::close(self.epoch.take().unwrap()).unwrap();
        native::close(self.parent.take().unwrap()).unwrap();
        std::fs::remove_dir_all(&self.path).unwrap();
    }
}
#[test]
fn fixed_noreplace_moves_preserve_old_inode_payload_and_foreign_destination() {
    let fixture = Fixture::new();
    let original = std::fs::metadata(fixture.path.join("tmp")).unwrap();
    std::fs::create_dir(fixture.path.join("epoch/data")).unwrap();
    std::fs::write(fixture.path.join("epoch/data/foreign"), b"must remain").unwrap();
    assert_eq!(
        native::retire_cold_temporary(fixture.parent(), fixture.epoch())
            .unwrap_err()
            .raw_os_error(),
        Some(libc::EEXIST)
    );
    assert_eq!(
        std::fs::metadata(fixture.path.join("tmp")).unwrap().ino(),
        original.ino()
    );
    assert_eq!(
        std::fs::read(fixture.path.join("epoch/data/foreign")).unwrap(),
        b"must remain"
    );
}
#[test]
fn actual_two_fixed_moves_replace_namespace_without_deleting_old_tree() {
    let fixture = Fixture::new();
    let original = std::fs::metadata(fixture.path.join("tmp")).unwrap();
    let attempt = NativeOperationId::parse("11111111-2222-4333-8444-555555555555").unwrap();
    let stage = format!(".cold-fresh-{}", attempt.as_str());
    std::fs::create_dir(fixture.path.join(&stage)).unwrap();
    let fresh = native::open_at(
        fixture.parent().as_raw_fd(),
        OsStr::new(&stage),
        libc::O_RDONLY | libc::O_DIRECTORY,
    )
    .unwrap();
    let expected = fresh.metadata().unwrap();
    native::retire_cold_temporary(fixture.parent(), fixture.epoch()).unwrap();
    native::install_cold_temporary(fixture.parent(), &attempt).unwrap();
    let retired = std::fs::metadata(fixture.path.join("epoch/data")).unwrap();
    let actual = std::fs::metadata(fixture.path.join("tmp")).unwrap();
    assert_eq!(
        (retired.dev(), retired.ino()),
        (original.dev(), original.ino())
    );
    assert_eq!(
        (actual.dev(), actual.ino()),
        (expected.dev(), expected.ino())
    );
    assert_ne!((actual.dev(), actual.ino()), (retired.dev(), retired.ino()));
    assert_eq!(
        std::fs::read(fixture.path.join("epoch/data/payload")).unwrap(),
        b"unchanged old bytes\0\xff"
    );
    native::close(fresh).unwrap();
}
#[test]
fn fresh_install_refuses_foreign_tmp_and_preserves_both_existing_inodes() {
    let fixture = Fixture::new();
    let attempt = NativeOperationId::parse("11111111-2222-4333-8444-555555555555").unwrap();
    let stage = format!(".cold-fresh-{}", attempt.as_str());
    std::fs::create_dir(fixture.path.join(&stage)).unwrap();
    std::fs::write(fixture.path.join(&stage).join("fresh"), b"new owned bytes").unwrap();
    let old = std::fs::metadata(fixture.path.join("tmp")).unwrap();
    let fresh = std::fs::metadata(fixture.path.join(&stage)).unwrap();
    assert_eq!(
        native::install_cold_temporary(fixture.parent(), &attempt)
            .unwrap_err()
            .raw_os_error(),
        Some(libc::EEXIST)
    );
    let after_old = std::fs::metadata(fixture.path.join("tmp")).unwrap();
    let after_fresh = std::fs::metadata(fixture.path.join(&stage)).unwrap();
    assert_eq!((old.dev(), old.ino()), (after_old.dev(), after_old.ino()));
    assert_eq!(
        (fresh.dev(), fresh.ino()),
        (after_fresh.dev(), after_fresh.ino())
    );
    assert_eq!(
        std::fs::read(fixture.path.join("tmp/payload")).unwrap(),
        b"unchanged old bytes\0\xff"
    );
    assert_eq!(
        std::fs::read(fixture.path.join(&stage).join("fresh")).unwrap(),
        b"new owned bytes"
    );
}
