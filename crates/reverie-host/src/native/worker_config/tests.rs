use super::*;
use crate::{ObservationError, ObservationFault};
use std::os::unix::fs::{PermissionsExt, symlink};
use std::{
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "rwvc-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let tree = Self(root);
        fs::write(tree.path(), b"{\"version\":1}").unwrap();
        fs::set_permissions(tree.path(), fs::Permissions::from_mode(0o600)).unwrap();
        tree
    }
    fn path(&self) -> PathBuf {
        self.0.join("config.json")
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        super::super::test_faults::set(None, false);
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn owner_file_preserves_hardlinks_and_symlinked_ancestors_but_refuses_leaf_alias() {
    let tree = Tree::new();
    let bytes = read_worker_config(&tree.path()).unwrap();
    let hard = tree.0.join("hard.json");
    fs::hard_link(tree.path(), &hard).unwrap();
    assert_eq!(read_worker_config(&hard).unwrap(), bytes);
    symlink(&tree.0, tree.0.join("ancestor")).unwrap();
    assert_eq!(
        read_worker_config(&tree.0.join("ancestor/config.json")).unwrap(),
        bytes
    );
    symlink(tree.path(), tree.0.join("alias.json")).unwrap();
    assert!(matches!(
        read_worker_config(&tree.0.join("alias.json")),
        Err(ObservationError::Refused(ObservationFault::ArtifactCustody))
    ));
    fs::set_permissions(tree.path(), fs::Permissions::from_mode(0o640)).unwrap();
    assert!(read_worker_config(&tree.path()).is_err());
    assert!(read_worker_config(&tree.0).is_err());
}
#[test]
fn owner_file_replacement_and_edit_after_read_refuse_without_rewriting_data() {
    let tree = Tree::new();
    let moved = tree.0.join("retained.json");
    let moved_hook = moved.clone();
    super::super::test_faults::set(
        Some(Box::new(move |path| {
            fs::rename(path, &moved_hook)?;
            fs::write(path, b"foreign")?;
            Ok(())
        })),
        false,
    );
    assert!(matches!(
        read_worker_config(&tree.path()),
        Err(ObservationError::Refused(ObservationFault::Changed))
    ));
    assert_eq!(fs::read(tree.path()).unwrap(), b"foreign");
    assert_eq!(fs::read(moved).unwrap(), b"{\"version\":1}");
    fs::set_permissions(tree.path(), fs::Permissions::from_mode(0o600)).unwrap();
    super::super::test_faults::set(
        Some(Box::new(|path| {
            fs::write(path, b"edited")?;
            Ok(())
        })),
        false,
    );
    assert!(matches!(
        read_worker_config(&tree.path()),
        Err(ObservationError::Refused(ObservationFault::Changed))
    ));
    assert_eq!(fs::read(tree.path()).unwrap(), b"edited");
}
#[test]
fn owner_read_and_close_failures_preserve_both_and_never_acknowledge_success() {
    let tree = Tree::new();
    super::super::test_faults::set(
        Some(Box::new(|_| {
            Err(std::io::Error::other("owned read fault").into())
        })),
        true,
    );
    let error = read_worker_config(&tree.path()).unwrap_err();
    assert!(
        matches!(error,ObservationError::Finalization{primary,secondary}
        if matches!(*primary,ObservationError::Io(_)) && matches!(*secondary,ObservationError::Io(_)))
    );
    super::super::test_faults::set(None, true);
    assert!(read_worker_config(&tree.path()).is_err());
    assert_eq!(
        read_worker_config(&tree.path()).unwrap(),
        b"{\"version\":1}"
    );
}
