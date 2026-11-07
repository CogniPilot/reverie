use super::*;
use crate::worker_child::{
    ChildError,
    test_hooks::{self, Point},
};
use crate::{
    native,
    worker_child::{ChildCause, ChildCleanup, ChildPhase, RecordDisposition, receipt, record},
};
const VALID: &[u8] = br#"{"env":{},"cwd":"/project","command":"x"}"#;

#[test]
fn parse_then_consume_is_lazy_and_hardlinks_remain_supported() {
    let tree = Tree::new();
    let path = tree.record(VALID);
    let other = tree.root.join("other");
    fs::hard_link(&path, &other).unwrap();
    let record = record::consume(&path, &tree.root).unwrap();
    assert!(record.requested_environment().unwrap().is_empty());
    assert!(!path.exists());
    assert_eq!(fs::read(other).unwrap(), VALID);
    assert_eq!(descriptors(&path), 0);
    let path = tree.record(b"null");
    let parsed = record::consume(&path, &tree.root).unwrap();
    assert!(parsed.requested_environment().is_err());
    assert!(!path.exists());
}
#[test]
fn malformed_or_foreign_shape_never_unlinks_a_record() {
    let tree = Tree::new();
    for raw in [b"{".as_slice(), b"\xef\xbb\xbf{}", b"\xff{}"] {
        let path = tree.record(raw);
        let error = record::consume(&path, &tree.root).err().unwrap();
        assert_eq!(error.phase(), ChildPhase::Parse);
        assert_eq!(error.record_disposition(), RecordDisposition::Untouched);
        assert_eq!(fs::read(&path).unwrap(), raw);
        fs::remove_file(path).unwrap();
    }
    let target = tree.record(VALID);
    let alias = tree.root.join("alias.json");
    std::os::unix::fs::symlink(&target, &alias).unwrap();
    assert!(record::consume(&alias, &tree.root).is_err());
    assert!(target.exists());
    fs::remove_file(&alias).unwrap();
    fs::remove_file(&target).unwrap();
    fs::create_dir(&alias).unwrap();
    assert!(record::consume(&alias, &tree.root).is_err());
}
#[test]
fn writable_parent_is_an_explicit_narrow_hardening_and_keeps_data() {
    let tree = Tree::new();
    let path = tree.record(VALID);
    fs::set_permissions(&tree.root, fs::Permissions::from_mode(0o777)).unwrap();
    let error = record::consume(&path, &tree.root).err().unwrap();
    assert!(matches!(error.cause(), ChildCause::Custody));
    assert!(path.exists());
    fs::set_permissions(&tree.root, fs::Permissions::from_mode(0o755)).unwrap();
    record::consume(&path, &tree.root).unwrap();
}
#[test]
fn actual_foreign_owned_sticky_parent_refuses_without_consuming_the_owned_record() {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    let root = Path::new("/tmp");
    if fs::metadata(root).unwrap().uid() == native::uid() {
        return;
    }
    let tree = Tree::new();
    let path = root
        .join(tree.root.file_name().unwrap())
        .with_extension("json");
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
        .unwrap();
    std::io::Write::write_all(&mut file, VALID).unwrap();
    drop(file);
    let error = record::consume(&path, root).err().unwrap();
    let unchanged = fs::read(&path).unwrap() == VALID;
    fs::remove_file(&path).unwrap();
    assert!(matches!(error.cause(), ChildCause::Custody));
    assert_eq!(error.record_disposition(), RecordDisposition::Untouched);
    assert!(unchanged);
}
#[test]
fn checked_record_close_failure_preserves_primary_and_never_consumes() {
    let tree = Tree::new();
    let path = tree.record(b"{");
    native::test_faults::set(None, true);
    let error = record::consume(&path, &tree.root).err().unwrap();
    assert_eq!(error.record_disposition(), RecordDisposition::Untouched);
    assert!(!error.cleanup_faults().is_empty());
    assert!(path.exists());
    assert_eq!(descriptors(&path), 0);
    native::test_faults::set(None, false);
}
#[test]
fn exit_publication_is_exclusive_and_retains_foreign_entries() {
    let tree = Tree::new();
    let exit = tree.root.join("launch.exit");
    receipt::publish(&exit, &tree.root, 137).unwrap();
    assert_eq!(fs::read(&exit).unwrap(), b"137");
    let error = receipt::publish(&exit, &tree.root, 0).unwrap_err();
    assert!(
        !error
            .cleanup_faults()
            .contains(&ChildCleanup::ReceiptPublication)
    );
    assert_eq!(fs::read(&exit).unwrap(), b"137");
    assert!(!tree.root.join("launch.exit.tmp").exists());
    fs::remove_file(&exit).unwrap();
    let temporary = tree.root.join("launch.exit.tmp");
    fs::write(&temporary, b"foreign").unwrap();
    assert!(receipt::publish(&exit, &tree.root, 0).is_err());
    assert_eq!(fs::read(&temporary).unwrap(), b"foreign");
    assert!(!exit.exists());
}
#[test]
fn pinned_record_replacement_refuses_without_unlinking_foreign_bytes() {
    let tree = Tree::new();
    let path = tree.record(VALID);
    let changed = path.clone();
    let _hook = test_hooks::set(Box::new(move |point| {
        if point == Point::Read {
            fs::remove_file(&changed).unwrap();
            fs::write(&changed, b"foreign").unwrap();
        }
        Ok(())
    }));
    let error = record::consume(&path, &tree.root).err().unwrap();
    assert_eq!(error.record_disposition(), RecordDisposition::Untouched);
    assert_eq!(fs::read(&path).unwrap(), b"foreign");
}
#[test]
fn consume_acknowledgement_loss_and_post_unlink_close_remain_distinct() {
    let tree = Tree::new();
    let path = tree.record(VALID);
    let hook = test_hooks::set(Box::new(|point| {
        if point == Point::AfterUnlink {
            return Err(ChildError::new(
                ChildPhase::Consume,
                ChildCause::Io(std::io::Error::from_raw_os_error(libc::EIO)),
            ));
        }
        Ok(())
    }));
    let error = record::consume(&path, &tree.root).err().unwrap();
    assert_eq!(
        error.record_disposition(),
        RecordDisposition::UnlinkAttempted
    );
    assert!(!path.exists());
    drop(hook);
    let path = tree.record(VALID);
    let _hook = test_hooks::set(Box::new(|point| {
        if point == Point::BeforeUnlink {
            native::test_faults::set(None, true);
        }
        Ok(())
    }));
    let error = record::consume(&path, &tree.root).err().unwrap();
    assert_eq!(error.record_disposition(), RecordDisposition::Consumed);
    assert!(
        error
            .cleanup_faults()
            .contains(&ChildCleanup::RecordAnchorClose)
    );
    assert!(!path.exists());
}
#[test]
fn prepared_receipt_swap_edit_link_or_mode_drift_never_publishes_or_deletes_foreign_source() {
    for mode in 0..4 {
        let tree = Tree::new();
        let exit = tree.root.join("launch.exit");
        let temporary = tree.root.join("launch.exit.tmp");
        let changed = temporary.clone();
        let other = tree.root.join("other");
        let _hook = test_hooks::set(Box::new(move |point| {
            if point == Point::BeforePublish {
                change_source(mode, &changed, &other);
            }
            Ok(())
        }));
        let error = receipt::publish(&exit, &tree.root, 137).unwrap_err();
        assert!(!exit.exists());
        assert!(temporary.exists());
        assert!(
            error
                .cleanup_faults()
                .contains(&ChildCleanup::ReceiptTemporaryRetained)
        );
        if mode == 0 {
            assert_eq!(fs::read(&temporary).unwrap(), b"foreign");
        }
    }
}
#[test]
fn acknowledged_rename_followed_by_io_or_close_failure_is_uncertain_and_never_rolled_back() {
    for close in [false, true] {
        let tree = Tree::new();
        let exit = tree.root.join("launch.exit");
        let _hook = test_hooks::set(Box::new(move |point| {
            if point == Point::AfterPublish {
                return publication_fault(close);
            }
            Ok(())
        }));
        let error = receipt::publish(&exit, &tree.root, 137).unwrap_err();
        assert!(
            error
                .cleanup_faults()
                .contains(&ChildCleanup::ReceiptPublication)
        );
        assert_eq!(fs::read(&exit).unwrap(), b"137");
    }
}
fn change_source(mode: u8, path: &Path, other: &Path) {
    match mode {
        0 => {
            fs::remove_file(path).unwrap();
            fs::write(path, b"foreign").unwrap();
        }
        1 => fs::write(path, b"999").unwrap(),
        2 => fs::hard_link(path, other).unwrap(),
        _ => fs::set_permissions(path, fs::Permissions::from_mode(0o666)).unwrap(),
    }
}
fn publication_fault(close: bool) -> Result<(), ChildError> {
    if close {
        native::test_faults::set(None, true);
        Ok(())
    } else {
        Err(ChildError::new(
            ChildPhase::Receipt,
            ChildCause::Io(std::io::Error::from_raw_os_error(libc::EIO)),
        ))
    }
}
