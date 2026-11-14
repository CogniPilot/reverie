//! Actual private files and consuming closes. Synthetic root is cfg(test) only;
//! it cannot construct a production fixed-HOME or employee capability.
use super::*;
use std::{
    fs,
    os::{
        fd::AsRawFd,
        unix::fs::{MetadataExt, PermissionsExt, symlink},
    },
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
const TOKEN: &[u8] = b"synthetic-credential";
struct Tree {
    path: PathBuf,
}
impl Tree {
    fn new() -> Self {
        let base = std::env::temp_dir();
        let metadata = fs::symlink_metadata(&base).unwrap();
        assert!(metadata.is_dir());
        assert_eq!(metadata.uid(), geteuid().as_raw());
        assert_eq!(metadata.permissions().mode() & 0o077, 0);
        let path = base.join(format!(
            "credential-fs-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        fs::create_dir(path.join("agent")).unwrap();
        fs::set_permissions(path.join("agent"), fs::Permissions::from_mode(0o700)).unwrap();
        Self { path }
    }
    fn home(&self) -> PathBuf {
        self.path.join("agent")
    }
    fn credentials(&self) -> PathBuf {
        self.home().join(DIRECTORY)
    }
    fn identity(&self) -> Home {
        let m = fs::metadata(self.home()).unwrap();
        Home {
            dev: m.dev(),
            ino: m.ino(),
        }
    }
    fn owner(&self) -> Owner {
        Owner::new(&self.path, Parent::Synthetic)
    }
    fn install(&self, token: &[u8]) -> Result<Home> {
        let mut owner = self.owner();
        let result = owner.execute(token, self.identity());
        owner.finish(result)
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.path).unwrap();
    }
}
#[test]
fn actual_install_is_private_and_same_bytes_can_only_earn_a_fresh_reader_close() {
    let tree = Tree::new();
    fs::write(tree.home().join("user-memory"), b"preserve").unwrap();
    assert_eq!(tree.install(TOKEN).unwrap(), tree.identity());
    let directory = tree.credentials();
    let file = directory.join(FINAL);
    let before = fs::metadata(&file).unwrap();
    assert_eq!(before.permissions().mode() & 0o7777, 0o600);
    assert_eq!(before.nlink(), 1);
    assert_eq!(
        fs::metadata(&directory).unwrap().permissions().mode() & 0o7777,
        0o700
    );
    assert!(!directory.join(PENDING).exists());
    assert_eq!(fs::read(&file).unwrap(), TOKEN);
    assert_eq!(tree.install(TOKEN).unwrap(), tree.identity());
    assert_eq!(fs::metadata(&file).unwrap().ino(), before.ino());
    assert!(tree.install(b"different").is_err());
    assert_eq!(fs::read(file).unwrap(), TOKEN);
    assert_eq!(
        fs::read(tree.home().join("user-memory")).unwrap(),
        b"preserve"
    );
}
#[test]
fn wrong_home_and_public_directory_refuse_before_credential_write() {
    let tree = Tree::new();
    let mut owner = tree.owner();
    let mut wrong = tree.identity();
    wrong.ino += 1;
    let result = owner.execute(TOKEN, wrong);
    assert!(owner.finish(result).is_err());
    assert!(!tree.credentials().exists());
    fs::create_dir(tree.credentials()).unwrap();
    fs::set_permissions(tree.credentials(), fs::Permissions::from_mode(0o755)).unwrap();
    assert!(tree.install(TOKEN).is_err());
    assert!(!tree.credentials().join(PENDING).exists());
}
#[test]
fn preexisting_pending_symlink_and_hardlinked_final_never_overwrite_user_data() {
    let tree = Tree::new();
    fs::create_dir(tree.credentials()).unwrap();
    fs::set_permissions(tree.credentials(), fs::Permissions::from_mode(0o700)).unwrap();
    let pending = tree.credentials().join(PENDING);
    fs::write(&pending, b"original-pending").unwrap();
    assert!(tree.install(TOKEN).is_err());
    assert_eq!(fs::read(&pending).unwrap(), b"original-pending");
    fs::remove_file(pending).unwrap();
    let data = tree.home().join("user");
    fs::write(&data, b"original-user-data").unwrap();
    let final_path = tree.credentials().join(FINAL);
    symlink(&data, &final_path).unwrap();
    assert!(tree.install(TOKEN).is_err());
    assert_eq!(fs::read(&data).unwrap(), b"original-user-data");
    fs::remove_file(&final_path).unwrap();
    fs::write(&data, TOKEN).unwrap();
    fs::set_permissions(&data, fs::Permissions::from_mode(0o600)).unwrap();
    fs::hard_link(&data, &final_path).unwrap();
    assert!(tree.install(TOKEN).is_err());
    assert_eq!(fs::metadata(&data).unwrap().nlink(), 2);
}
#[test]
fn actual_directory_replacement_and_symlink_swap_are_held_without_publishing_into_replacement() {
    for symbolic in [false, true] {
        let tree = Tree::new();
        let foreign = tree.home().join("foreign");
        fs::create_dir(&foreign).unwrap();
        fs::set_permissions(&foreign, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(foreign.join(FINAL), b"user-data").unwrap();
        let mut owner = tree.owner();
        owner.capture(tree.identity()).unwrap();
        assert!(owner.begin().unwrap());
        owner.write_pending(TOKEN).unwrap();
        fs::rename(tree.credentials(), tree.home().join("retained")).unwrap();
        if symbolic {
            symlink(&foreign, tree.credentials()).unwrap();
        } else {
            fs::create_dir(tree.credentials()).unwrap();
            fs::set_permissions(tree.credentials(), fs::Permissions::from_mode(0o700)).unwrap();
            fs::write(tree.credentials().join(FINAL), b"replacement-data").unwrap();
        }
        let result = owner.publish(TOKEN).map(|()| tree.identity());
        let error = owner.finish(result).unwrap_err();
        assert_eq!(error.phase, "directory-currency");
        assert_eq!(owner.close_calls, 4);
        assert_eq!(fs::read(foreign.join(FINAL)).unwrap(), b"user-data");
        assert_eq!(
            fs::read(tree.home().join("retained").join(PENDING)).unwrap(),
            TOKEN
        );
        if !symbolic {
            assert_eq!(
                fs::read(tree.credentials().join(FINAL)).unwrap(),
                b"replacement-data"
            );
        }
    }
}
#[test]
fn concurrent_target_creation_loses_atomic_no_replace_and_keeps_original_file() {
    let tree = Tree::new();
    let mut owner = tree.owner();
    owner.capture(tree.identity()).unwrap();
    owner.begin().unwrap();
    owner.write_pending(TOKEN).unwrap();
    let target = tree.credentials().join(FINAL);
    fs::write(&target, b"concurrent-user-data").unwrap();
    let inode = fs::metadata(&target).unwrap().ino();
    let result = owner.publish(TOKEN).map(|()| tree.identity());
    let error = owner.finish(result).unwrap_err();
    assert_eq!(error.phase, "no-replace-publication");
    assert_eq!(fs::read(&target).unwrap(), b"concurrent-user-data");
    assert_eq!(fs::metadata(target).unwrap().ino(), inode);
    assert_eq!(fs::read(tree.credentials().join(PENDING)).unwrap(), TOKEN);
}
#[test]
fn post_link_sync_fault_remains_held_and_never_replays_publication() {
    let tree = Tree::new();
    let mut owner = tree.owner();
    owner.capture(tree.identity()).unwrap();
    owner.begin().unwrap();
    owner.write_pending(TOKEN).unwrap();
    owner.lose_link_sync = true;
    let result = owner.publish(TOKEN).map(|()| tree.identity());
    let error = owner.finish(result).unwrap_err();
    assert_eq!(error.phase, "publication-sync-ack-unknown");
    let final_path = tree.credentials().join(FINAL);
    let pending = tree.credentials().join(PENDING);
    let original = fs::metadata(&final_path).unwrap();
    assert_eq!(original.nlink(), 2);
    assert_eq!(fs::metadata(&pending).unwrap().ino(), original.ino());
    assert!(tree.install(TOKEN).is_err());
    assert_eq!(fs::metadata(&final_path).unwrap().ino(), original.ino());
    assert_eq!(owner.publication_calls, 1);
    assert!(owner.publish(TOKEN).is_err());
    assert_eq!(owner.publication_calls, 1);
}
#[test]
fn first_refusal_and_actual_close_unknown_are_retained_and_descriptor_number_is_never_closed_twice()
{
    let tree = Tree::new();
    let mut owner = tree.owner();
    owner.capture(tree.identity()).unwrap();
    owner.begin().unwrap();
    owner.write_pending(TOKEN).unwrap();
    let credential_fd = owner.file.as_ref().unwrap().as_raw_fd();
    owner.lose_file_close = true;
    fs::rename(tree.credentials(), tree.home().join("retained")).unwrap();
    fs::create_dir(tree.credentials()).unwrap();
    let result = owner.publish(TOKEN).map(|()| tree.identity());
    let error = owner.finish(result).unwrap_err();
    assert_eq!(error.phase, "directory-currency");
    assert!(!error.cleanup.is_empty());
    assert_eq!(owner.close_calls, 4);
    let mut retained = Vec::new();
    loop {
        let f = File::open(tree.home().join("retained").join(PENDING)).unwrap();
        let number = f.as_raw_fd();
        retained.push(f);
        if number == credential_fd {
            break;
        }
        assert!(retained.len() < 16);
    }
    owner.close_components().unwrap();
    assert_eq!(owner.close_calls, 4);
    assert!(retained.last().unwrap().metadata().is_ok());
}
