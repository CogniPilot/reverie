use super::*;
use std::{
    fs,
    os::unix::fs::{DirBuilderExt, PermissionsExt, symlink},
    sync::atomic::{AtomicU64, Ordering},
};
static SERIAL: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    path: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "reverie-plan-files-{}-{}",
            std::process::id(),
            SERIAL.fetch_add(1, Ordering::Relaxed)
        ));
        fs::DirBuilder::new().mode(0o700).create(&path).unwrap();
        Self { path }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.path).unwrap();
    }
}
#[test]
fn no_replace_publication_and_same_fd_readback() {
    let fixture = Fixture::new();
    let mut files = Files::new();
    let result = (|| {
        let root = files.root(&fixture.path, geteuid().as_raw(), true)?;
        let parent = files.child(root, "plans", true, true)?;
        let pending = files.child(parent, "pending", true, true)?;
        files.write_new(pending, "auth.json", b"{\"syntheticAccount\":\"B\"}")?;
        let before = files.identity(pending)?;
        files.publish_directory(parent, "pending", "generation", pending)?;
        need(files.identity(pending)? == before, "test-inode")?;
        need(
            files.read(pending, "auth.json", 128, true)? == b"{\"syntheticAccount\":\"B\"}",
            "test-bytes",
        )?;
        need(
            !files.absent(parent, "generation")? && files.absent(parent, "pending")?,
            "test-publication",
        )?;
        need(
            files
                .write_new(pending, "auth.json", b"overwrite forbidden")
                .is_err(),
            "test-overwrite",
        )?;
        Ok(())
    })();
    assert!(join(result, files.close_all()).is_ok());
    assert!(
        fs::read(fixture.path.join("plans/generation/auth.json"))
            .unwrap()
            .starts_with(b"{")
    );
}
#[test]
fn slash_dotdot_and_symlink_never_escape_held_roots() {
    let fixture = Fixture::new();
    let mut files = Files::new();
    let root = files.root(&fixture.path, geteuid().as_raw(), true).unwrap();
    let target = files.child(root, "target", true, true).unwrap();
    for name in ["../escape", "a/b", "/absolute", ".", "..", ""] {
        assert!(files.child(root, name, true, true).is_err());
        assert!(files.read(root, name, 16, false).is_err());
        assert!(files.write_new(root, name, b"forbidden").is_err());
        assert!(files.copy_file(root, target, name, &mut 100).is_err());
        assert!(
            files
                .publish_directory(root, name, "final", target)
                .is_err()
        );
        assert!(
            files
                .publish_directory(root, "pending", name, target)
                .is_err()
        );
    }
    symlink("elsewhere", fixture.path.join("link")).unwrap();
    assert!(files.child(root, "link", false, false).is_err());
    assert!(files.close_all().is_ok());
}
#[test]
fn replaced_path_revokes_retained_directory_and_does_not_write_replacement() {
    let fixture = Fixture::new();
    let mut files = Files::new();
    let root = files.root(&fixture.path, geteuid().as_raw(), true).unwrap();
    let child = files.child(root, "held", true, true).unwrap();
    fs::rename(fixture.path.join("held"), fixture.path.join("retained")).unwrap();
    fs::DirBuilder::new()
        .mode(0o700)
        .create(fixture.path.join("held"))
        .unwrap();
    assert!(files.write_new(child, "auth.json", b"never").is_err());
    assert!(!fixture.path.join("held/auth.json").exists());
    assert!(files.close_all().is_ok());
}
#[test]
fn actual_copy_is_bounded_and_closed_without_source_changes() {
    let fixture = Fixture::new();
    let mut files = Files::new();
    let result = (|| {
        let root = files.root(&fixture.path, geteuid().as_raw(), true)?;
        let source = files.child(root, "source", true, true)?;
        let target = files.child(root, "target", true, true)?;
        files.write_new(source, "thread.jsonl", b"synthetic history\n")?;
        let mut budget = 1024;
        let digest = files.copy_file(source, target, "thread.jsonl", &mut budget)?;
        need(
            digest == format!("{:x}", Sha256::digest(b"synthetic history\n")),
            "test-digest",
        )?;
        need(budget == 1024 - 18, "test-budget")?;
        need(
            files
                .copy_file(source, target, "thread.jsonl", &mut 0)
                .is_err(),
            "test-bound",
        )?;
        need(
            files.read(source, "thread.jsonl", 100, true)?
                == files.read(target, "thread.jsonl", 100, true)?,
            "test-copy",
        )?;
        Ok(())
    })();
    assert!(join(result, files.close_all()).is_ok());
}
#[test]
fn lost_close_ack_fails_after_consuming_every_actual_owned_fd() {
    let fixture = Fixture::new();
    let mut files = Files::new();
    let root = files.root(&fixture.path, geteuid().as_raw(), true).unwrap();
    let child = files.child(root, "held", true, true).unwrap();
    files.lose_close = Some(child);
    assert!(files.close_all().is_err());
    assert_eq!(files.close_calls, 2);
    assert!(files.held.iter().all(|entry| entry.file.is_none()));
    assert!(files.close_all().is_ok());
    assert_eq!(files.close_calls, 2);
}
#[test]
fn private_mode_and_fixed_context_links_checked() {
    let fixture = Fixture::new();
    let mut files = Files::new();
    let root = files.root(&fixture.path, geteuid().as_raw(), true).unwrap();
    let child = files.child(root, "context", true, true).unwrap();
    let target = fixture.path.join("context");
    files.link(root, "projects", &target).unwrap();
    files.link_matches(root, "projects", &target).unwrap();
    assert!(
        files
            .link_matches(root, "projects", Path::new("/wrong"))
            .is_err()
    );
    fs::set_permissions(&target, fs::Permissions::from_mode(0o777)).unwrap();
    assert!(files.current().is_err());
    assert!(files.close_all().is_ok());
    let _ = child;
}

#[test]
fn retained_read_and_sealed_inventory_fail_on_later_inplace_or_entry_mutation() {
    let fixture = Fixture::new();
    let mut files = Files::new();
    let root = files.root(&fixture.path, geteuid().as_raw(), true).unwrap();
    files
        .write_new(root, "auth.json", b"{\"original\":true}")
        .unwrap();
    assert_eq!(files.names(root).unwrap(), vec!["auth.json"]);
    files.seal_directory(root).unwrap();
    fs::write(fixture.path.join("auth.json"), b"{\"changed\":true}").unwrap();
    assert!(files.current().is_err());
    assert!(files.close_all().is_ok());
    let mut files = Files::new();
    let root = files.root(&fixture.path, geteuid().as_raw(), true).unwrap();
    files.names(root).unwrap();
    files.seal_directory(root).unwrap();
    fs::write(fixture.path.join("settings.json"), b"{}").unwrap();
    assert!(files.current().is_err());
    assert!(files.close_all().is_ok());
}
