use super::*;
use std::{
    ffi::OsStr,
    os::unix::fs::{PermissionsExt, symlink},
    time::Duration,
};
pub(super) struct Fixture {
    pub(super) path: PathBuf,
    root: Option<File>,
    key: Key,
}
impl Fixture {
    pub(super) fn new() -> Self {
        let name = reverie_store::worker_storage::instruction_temporary_name().unwrap();
        let path = std::env::temp_dir().join(format!("cold-tree-{name}"));
        std::fs::create_dir(&path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let root = native::open_at(
            libc::AT_FDCWD,
            path.as_os_str(),
            libc::O_RDONLY | libc::O_DIRECTORY,
        )
        .unwrap();
        let metadata = root.metadata().unwrap();
        Self {
            path,
            root: Some(root),
            key: (metadata.dev(), metadata.ino()),
        }
    }
    fn root(&self) -> &File {
        self.root.as_ref().unwrap()
    }
    fn end(&self) -> Instant {
        Instant::now() + Duration::from_secs(10)
    }
    fn scan(&self) -> Result<tree::Tree> {
        tree::Tree::scan(self.root(), native::uid(), self.end())
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let named = std::fs::symlink_metadata(&self.path).unwrap();
        assert_eq!((named.dev(), named.ino()), self.key);
        native::close(self.root.take().unwrap()).unwrap();
        std::fs::remove_dir_all(&self.path).unwrap();
    }
}
#[test]
fn postorder_inventory_and_removal_preserve_outside_symlink_payload() {
    let fixture = Fixture::new();
    std::fs::create_dir(fixture.path.join("a")).unwrap();
    std::fs::write(fixture.path.join("a/bytes"), b"\0owned\xff").unwrap();
    symlink("/outside/not-followed", fixture.path.join("link")).unwrap();
    let tree = fixture.scan().unwrap();
    assert_eq!(tree.count(), 3);
    assert_eq!(tree.keys().len(), 4);
    assert_eq!(names(fixture.root(), 4096, fixture.end()).unwrap().len(), 2);
    assert_eq!(names(fixture.root(), 4096, fixture.end()).unwrap().len(), 2);
    tree.remove(fixture.root(), fixture.end()).unwrap();
    assert_eq!(std::fs::read_dir(&fixture.path).unwrap().count(), 0);
}
#[test]
fn preserved_markers_hardlinks_and_entry_byte_bounds_refuse_before_deletion() {
    for marker in [".keep", ".reverie-task.json", ".git", ".hg", ".svn"] {
        let fixture = Fixture::new();
        std::fs::create_dir(fixture.path.join("nested")).unwrap();
        std::fs::write(fixture.path.join("nested").join(marker), b"preserve").unwrap();
        assert!(matches!(
            fixture.scan(),
            Err(StorageError::Refused(StorageFault::ColdPreservation))
        ));
        assert_eq!(
            std::fs::read(fixture.path.join("nested").join(marker)).unwrap(),
            b"preserve"
        );
    }
    let fixture = Fixture::new();
    std::fs::write(fixture.path.join("one"), b"preserve").unwrap();
    std::fs::hard_link(fixture.path.join("one"), fixture.path.join("two")).unwrap();
    assert!(matches!(
        fixture.scan(),
        Err(StorageError::Refused(StorageFault::ColdTree))
    ));
    std::fs::remove_file(fixture.path.join("two")).unwrap();
    File::options()
        .write(true)
        .open(fixture.path.join("one"))
        .unwrap()
        .set_len(MAX_BYTES)
        .unwrap();
    assert_eq!(fixture.scan().unwrap().count(), 1);
    File::options()
        .write(true)
        .open(fixture.path.join("one"))
        .unwrap()
        .set_len(MAX_BYTES + 1)
        .unwrap();
    assert!(matches!(
        fixture.scan(),
        Err(StorageError::Refused(StorageFault::ColdBound))
    ));
    assert_eq!(
        std::fs::metadata(fixture.path.join("one")).unwrap().len(),
        MAX_BYTES + 1
    );
}

#[test]
fn complete_entry_limit_is_global_across_the_iterative_inventory() {
    let fixture = Fixture::new();
    for index in 0..MAX_ENTRIES {
        std::fs::write(fixture.path.join(format!("entry-{index}")), b"").unwrap();
    }
    assert_eq!(fixture.scan().unwrap().count(), MAX_ENTRIES);
    std::fs::write(fixture.path.join("one-over"), b"preserve").unwrap();
    assert!(fixture.scan().is_err());
    assert_eq!(
        std::fs::read(fixture.path.join("one-over")).unwrap(),
        b"preserve"
    );
    assert_eq!(
        std::fs::read_dir(&fixture.path).unwrap().count(),
        MAX_ENTRIES + 1
    );
}

#[test]
fn root_s_imode_requires_exact_private_mode_including_special_bits() {
    for mode in [0o1700, 0o2700, 0o4700] {
        let fixture = Fixture::new();
        std::fs::write(fixture.path.join("payload"), b"preserve").unwrap();
        std::fs::set_permissions(&fixture.path, std::fs::Permissions::from_mode(mode)).unwrap();
        assert!(matches!(
            fixture.scan(),
            Err(StorageError::Refused(StorageFault::ColdTree))
        ));
        assert_eq!(
            std::fs::read(fixture.path.join("payload")).unwrap(),
            b"preserve"
        );
    }
}
#[test]
fn iterative_deep_tree_keeps_root_offset_and_checks_every_ancestor() {
    let fixture = Fixture::new();
    let mut parent = native::open_at(
        fixture.root().as_raw_fd(),
        OsStr::new("."),
        libc::O_RDONLY | libc::O_DIRECTORY,
    )
    .unwrap();
    for _ in 0..192 {
        nix::sys::stat::mkdirat(&parent, "d", nix::sys::stat::Mode::S_IRWXU).unwrap();
        let child = native::open_at(
            parent.as_raw_fd(),
            OsStr::new("d"),
            libc::O_RDONLY | libc::O_DIRECTORY,
        )
        .unwrap();
        native::close(parent).unwrap();
        parent = child;
    }
    native::close(parent).unwrap();
    let tree = fixture.scan().unwrap();
    assert_eq!(tree.count(), 192);
    tree.remove(fixture.root(), fixture.end()).unwrap();
    assert!(names(fixture.root(), 0, fixture.end()).unwrap().is_empty());
}
#[test]
fn changed_entry_and_expired_deadline_never_get_unlinked() {
    let fixture = Fixture::new();
    let leaf = fixture.path.join("payload");
    std::fs::write(&leaf, b"before").unwrap();
    let tree = fixture.scan().unwrap();
    std::fs::write(&leaf, b"changed generation and size").unwrap();
    assert!(tree.remove(fixture.root(), fixture.end()).is_err());
    assert_eq!(
        std::fs::read(&leaf).unwrap(),
        b"changed generation and size"
    );
    let end = Instant::now() - Duration::from_secs(1);
    assert!(matches!(
        tree::Tree::scan(fixture.root(), native::uid(), end),
        Err(StorageError::Refused(StorageFault::ColdDeadline))
    ));
    assert!(tree.remove(fixture.root(), end).is_err());
}
#[test]
fn directory_names_follow_python_surrogateescape_order_and_exact_count_bound() {
    let fixture = Fixture::new();
    for name in [
        OsString::from_vec(vec![0xff]),
        OsString::from("\u{10000}"),
        OsString::from("a"),
    ] {
        std::fs::write(fixture.path.join(name), b"x").unwrap();
    }
    let selected = names(fixture.root(), 3, fixture.end()).unwrap();
    assert_eq!(
        selected,
        vec![
            OsString::from("a"),
            OsString::from_vec(vec![0xff]),
            OsString::from("\u{10000}")
        ]
    );
    assert!(names(fixture.root(), 2, fixture.end()).is_err());
    assert_eq!(names(fixture.root(), 3, fixture.end()).unwrap().len(), 3);
}

#[test]
fn exclusive_pending_publication_preserves_foreign_evidence_and_detects_changed_stamp() {
    let fixture = Fixture::new();
    let text = PosixPath::try_new(&native::python_text(&fixture.path)).unwrap();
    let directory = super::directories::Directory::open(text, native::uid()).unwrap();
    let name = OsStr::new("cold-tmp-cleanup.pending.json");
    let stamp = directory.publish(name, b"owned pending evidence").unwrap();
    assert!(directory.publish(name, b"must never replace").is_err());
    assert_eq!(
        std::fs::read(fixture.path.join(name)).unwrap(),
        b"owned pending evidence"
    );
    directory.named(name, &stamp).unwrap();
    std::fs::write(fixture.path.join(name), b"foreign changed generation").unwrap();
    assert!(directory.named(name, &stamp).is_err());
    directory.close().unwrap();
    assert_eq!(
        std::fs::read(fixture.path.join(name)).unwrap(),
        b"foreign changed generation"
    );
}
