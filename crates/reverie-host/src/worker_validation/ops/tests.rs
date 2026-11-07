use super::*;
use crate::{ObservationError, ObservationFault};
use std::os::unix::fs::{PermissionsExt, symlink};
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let root = PathBuf::from(std::env::var_os("HOME").expect("owned test home")).join(format!(
            ".reverie-ops-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        Self(root)
    }
    fn file(&self, name: &str, bytes: &[u8]) -> MetadataText {
        let path = self.0.join(name);
        fs::write(&path, bytes).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        MetadataText::from_scalar_text(path.to_str().unwrap())
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        native::test_faults::set(None, false);
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn ops_private_reads_enforce_actual_ancestors_links_modes_and_exact_byte_bound() {
    let tree = Tree::new();
    let path = tree.file("config.json", &vec![b' '; 65_536]);
    assert_eq!(read(&path).unwrap().len(), 65_536);
    let oversized = tree.file("oversized.json", &vec![b' '; 65_537]);
    assert!(read(&oversized).is_err());
    let native_path = native::python_path(path.codepoints()).unwrap();
    fs::hard_link(&native_path, tree.0.join("hard.json")).unwrap();
    assert!(read(&path).is_err());
    fs::remove_file(tree.0.join("hard.json")).unwrap();
    symlink(&native_path, tree.0.join("alias.json")).unwrap();
    assert!(
        read(&MetadataText::from_scalar_text(
            tree.0.join("alias.json").to_str().unwrap()
        ))
        .is_err()
    );
    symlink(&tree.0, tree.0.join("ancestor")).unwrap();
    assert!(
        read(&MetadataText::from_scalar_text(
            tree.0.join("ancestor/config.json").to_str().unwrap()
        ))
        .is_err()
    );
    fs::set_permissions(&native_path, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(read(&path).is_err());
    fs::set_permissions(&native_path, fs::Permissions::from_mode(0o600)).unwrap();
    fs::set_permissions(&tree.0, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(read(&path).is_err());
    fs::set_permissions(&tree.0, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(read(&path).is_ok());
}
#[test]
fn ops_read_replacement_and_leaf_close_failures_preserve_both_causes() {
    let tree = Tree::new();
    let path = tree.file("config.json", b"{}");
    let moved = tree.0.join("old.json");
    native::test_faults::set(
        Some(Box::new(move |path| {
            fs::rename(path, &moved)?;
            fs::write(path, b"foreign")?;
            native::test_faults::set(None, true);
            Ok(())
        })),
        false,
    );
    let error = read(&path).unwrap_err();
    assert!(
        matches!(error,WorkerValidationHostError::Observation(ObservationError::Finalization{primary,secondary})
        if matches!(*primary,ObservationError::Refused(ObservationFault::Changed))
        && matches!(*secondary,ObservationError::Io(_)))
    );
    assert_eq!(fs::read(tree.0.join("config.json")).unwrap(), b"foreign");
    assert_eq!(fs::read(tree.0.join("old.json")).unwrap(), b"{}");
}
