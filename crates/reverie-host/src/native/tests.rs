use super::*;
use crate::task_perf::allowed_metadata;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::sync::atomic::{AtomicU64, Ordering};
static NEXT: AtomicU64 = AtomicU64::new(0);
#[test]
fn reservation_close_uncertainty_preserves_actual_consumed_close_and_kernel_tag() {
    let tree = Tree::new();
    tree.write(b"owned bytes", 0o600);
    test_faults::set(None, true);
    let error = read_reservation(&tree.file(), 64).unwrap_err();
    assert_eq!(tree.descriptors(), 0);
    assert!(matches!(error, ObservationError::CloseUnconfirmed { .. }));
    assert_eq!(error.code(), "HOST_ARTIFACT_IO");
    let kernel = crate::reservation_kernel::ReservationKernelError::from(error);
    assert!(kernel.has_unconfirmed_close());
    assert_eq!(read_reservation(&tree.file(), 64).unwrap(), b"owned bytes");
    assert!(
        kernel.has_unconfirmed_close(),
        "a new read cannot clear the old error"
    );
}
#[test]
fn reservation_close_uncertainty_keeps_secondary_bound_failure_and_storage_tag() {
    let tree = Tree::new();
    tree.write(b"owned bytes", 0o600);
    test_faults::set(None, true);
    let error = read_reservation(&tree.file(), 0).unwrap_err();
    assert_eq!(tree.descriptors(), 0);
    assert!(error.has_unconfirmed_close());
    let ObservationError::Finalization { primary, secondary } = &error else {
        panic!("both original errors must survive")
    };
    assert_eq!(primary.code(), "RESERVATION_NATIVE_BOUND");
    assert!(matches!(
        &**secondary,
        ObservationError::CloseUnconfirmed { .. }
    ));
    let stored = crate::worker_storage::StorageError::from(error);
    assert!(
        matches!(stored, crate::worker_storage::StorageError::Finalization { secondary, .. }
        if matches!(*secondary, crate::worker_storage::StorageError::CloseUnconfirmed { .. }))
    );
}
#[test]
fn reservation_close_uncertainty_does_not_classify_known_io_or_schema_refusal() {
    let tree = Tree::new();
    let missing = read_reservation(&tree.file(), 64).unwrap_err();
    assert!(!missing.has_unconfirmed_close());
    tree.write(b"owned bytes", 0o600);
    let bounded = read_reservation(&tree.file(), 0).unwrap_err();
    assert!(!bounded.has_unconfirmed_close());
    let dual = finalized::<()>(Err(missing), Err(bounded)).unwrap_err();
    assert!(!dual.has_unconfirmed_close());
    assert_eq!(tree.descriptors(), 0);
}
#[test]
fn python_native_path_encoding_is_lossless_and_separate_from_path_policy() {
    use std::os::unix::ffi::OsStrExt;
    assert_eq!(
        python_path(&[47, 0x20ac, 0xdc80, 0xdcff])
            .unwrap()
            .as_os_str()
            .as_bytes(),
        b"/\xe2\x82\xac\x80\xff"
    );
    assert_eq!(python_path(&[0]).unwrap().as_os_str().as_bytes(), b"\0");
    for invalid in [0xd800, 0xdc7f, 0x110000] {
        assert_eq!(
            python_path(&[invalid]).unwrap_err().kind(),
            std::io::ErrorKind::InvalidInput
        );
    }
}
struct Tree {
    root: PathBuf,
}
impl Tree {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "reverie-nix-observation-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        Self { root }
    }
    fn file(&self) -> PathBuf {
        self.root.join("artifact.json")
    }
    fn write(&self, raw: &[u8], mode: u32) {
        if self.file().exists() {
            fs::set_permissions(self.file(), fs::Permissions::from_mode(0o600)).unwrap();
        }
        fs::write(self.file(), raw).unwrap();
        fs::set_permissions(self.file(), fs::Permissions::from_mode(mode)).unwrap();
    }
    fn read(&self, maximum: usize) -> Result<Vec<u8>> {
        observe(
            &canonical_in(&self.file(), &self.root)?,
            maximum,
            allowed_metadata,
        )
    }
    fn descriptors(&self) -> usize {
        fs::read_dir("/proc/self/fd")
            .unwrap()
            .flatten()
            .filter_map(|entry| fs::read_link(entry.path()).ok())
            .filter(|path| path.starts_with(&self.root))
            .count()
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        test_faults::set(None, false);
        fs::remove_dir_all(&self.root).unwrap();
    }
}

#[test]
fn purpose_policy_accepts_owner_writable_and_hardlinked_nix_data_without_profile_store_rules() {
    let tree = Tree::new();
    tree.write(b"fixed bytes", 0o600);
    assert_eq!(tree.read(65536).unwrap(), b"fixed bytes");
    fs::hard_link(tree.file(), tree.root.join("alias")).unwrap();
    assert_eq!(tree.read(65536).unwrap(), b"fixed bytes");
    assert_eq!(tree.descriptors(), 0);
    for mode in [0o620, 0o602, 0o666] {
        tree.write(b"protected", mode);
        assert!(tree.read(65536).is_err());
    }
}

#[test]
fn exact_empty_and_maximum_byte_bounds_are_kept_before_decoding() {
    let tree = Tree::new();
    for count in [0, 65536] {
        tree.write(&vec![b'x'; count], 0o444);
        assert_eq!(tree.read(65536).unwrap().len(), count);
    }
    tree.write(&vec![b'x'; 65537], 0o444);
    assert!(matches!(
        tree.read(65536),
        Err(ObservationError::Refused(ObservationFault::ArtifactBound))
    ));
    assert_eq!(tree.descriptors(), 0);
}

#[test]
fn noncanonical_symlink_directory_and_fifo_cannot_be_observed() {
    let tree = Tree::new();
    tree.write(b"owned target", 0o600);
    let link = tree.root.join("link");
    symlink(tree.file(), &link).unwrap();
    assert!(canonical_in(&link, &tree.root).is_err());
    assert!(observe(&link, 65536, allowed_metadata).is_err());
    assert!(observe(&tree.root, 65536, allowed_metadata).is_err());
    assert!(canonical_in(&tree.root.join("missing/../artifact.json"), &tree.root).is_err());
    let fifo = tree.root.join("fifo");
    let name = std::ffi::CString::new(fifo.as_os_str().as_encoded_bytes()).unwrap();
    // SAFETY: one owned fixture pathname is NUL terminated; no live path exists.
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    assert!(observe(&fifo, 65536, allowed_metadata).is_err());
    assert_eq!(tree.descriptors(), 0);
}

#[test]
fn file_edit_replacement_link_or_mode_drift_during_read_is_refused() {
    for operation in ["edit", "replace", "link", "mode"] {
        let tree = Tree::new();
        tree.write(b"original", 0o600);
        test_faults::set(
            Some(Box::new(move |path| {
                match operation {
                    "edit" => fs::write(path, b"modified").unwrap(),
                    "replace" => {
                        fs::rename(path, path.with_extension("saved")).unwrap();
                        fs::write(path, b"original").unwrap();
                    }
                    "link" => fs::hard_link(path, path.with_extension("alias")).unwrap(),
                    "mode" => fs::set_permissions(path, fs::Permissions::from_mode(0o640)).unwrap(),
                    _ => unreachable!(),
                }
                Ok(())
            })),
            false,
        );
        assert!(tree.read(65536).is_err(), "{operation}");
        assert_eq!(tree.descriptors(), 0);
    }
}

#[test]
fn read_refusal_and_close_failure_are_retained_and_no_descriptor_leaks() {
    let tree = Tree::new();
    tree.write(b"original", 0o600);
    test_faults::set(
        Some(Box::new(|path| {
            fs::write(path, b"changed!").unwrap();
            Ok(())
        })),
        true,
    );
    let error = tree.read(65536).unwrap_err();
    let ObservationError::Finalization { primary, secondary } = error else {
        panic!("lost finalizer")
    };
    assert_eq!(primary.code(), "HOST_ARTIFACT_CHANGED");
    assert_eq!(secondary.code(), "HOST_ARTIFACT_IO");
    assert_eq!(tree.descriptors(), 0);
    test_faults::set(None, true);
    assert!(tree.read(65536).is_err());
    assert_eq!(tree.descriptors(), 0);
}
