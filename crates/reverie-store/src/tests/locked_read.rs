use super::*;
use crate::private_fs::CloseRole;

#[test]
fn staging_keeps_the_real_lock_until_checked_finalization() {
    let tree = Tree::new();
    let store = tree.save();
    let reader = store.locked_read().unwrap();
    let before = tree.raw();
    assert_eq!(reader.document().revision().get(), 1);
    let contender = tree.open();
    assert_eq!(
        contender.put(&next_intent()).unwrap_err().code(),
        "STORE_LOCK_BUSY"
    );
    assert_eq!(tree.raw(), before);
    reader.finish().unwrap();
    assert_eq!(contender.put(&next_intent()).unwrap().revision().get(), 2);
}

#[test]
fn abandoning_a_candidate_releases_the_lock_without_writing() {
    let tree = Tree::new();
    let store = tree.save();
    let before = tree.raw();
    let count = tree.fd_count();
    let reader = store.locked_read().unwrap();
    assert_eq!(tree.fd_count(), count + 2);
    drop(reader);
    assert_eq!(tree.fd_count(), count);
    assert_eq!(tree.raw(), before);
    store.put(&next_intent()).unwrap();
}

#[test]
fn changed_or_substituted_data_invalidates_the_derived_candidate() {
    for replacement in [false, true] {
        let tree = Tree::new();
        let store = tree.save();
        let reader = store.locked_read().unwrap();
        if replacement {
            fs::rename(tree.data(), tree.root.join("original.json")).unwrap();
            tree.write(&profiles_v1::encode(reader.document()).unwrap());
        } else {
            tree.write(b"changed by a noncooperating fixture writer");
        }
        assert_eq!(reader.finish().unwrap_err().code(), "STORE_CHANGED");
        assert_eq!(tree.fd_count(), 1);
    }
}

#[test]
fn the_original_data_inode_remains_pinned_through_application_projection() {
    use std::os::unix::fs::MetadataExt;
    let tree = Tree::new();
    let store = tree.save();
    let original = fs::metadata(tree.data()).unwrap();
    let reader = store.locked_read().unwrap();
    fs::remove_file(tree.data()).unwrap();
    let held = fs::read_dir("/proc/self/fd")
        .unwrap()
        .flatten()
        .filter_map(|entry| fs::metadata(entry.path()).ok())
        .any(|metadata| metadata.dev() == original.dev() && metadata.ino() == original.ino());
    assert!(held, "data identity must not become reusable while staging");
    assert!(reader.finish().is_err());
}

#[test]
fn missing_and_present_empty_remain_distinct_during_staging() {
    for initially_present in [false, true] {
        let tree = Tree::new();
        if initially_present {
            tree.write(&profiles_v1::encode(&ProfileDocument::empty()).unwrap());
        }
        let store = tree.open();
        let reader = store.locked_read().unwrap();
        assert_eq!(reader.document().revision().get(), 0);
        if initially_present {
            fs::remove_file(tree.data()).unwrap();
        } else {
            tree.write(&profiles_v1::encode(&ProfileDocument::empty()).unwrap());
        }
        assert_eq!(reader.finish().unwrap_err().code(), "STORE_CHANGED");
    }
}

#[test]
fn staging_custody_and_close_failures_are_both_retained() {
    let tree = Tree::new();
    let store = tree.save();
    let reader = store.locked_read().unwrap();
    tree.write(b"noncooperating writer");
    faults::STATE.with(|state| state.borrow_mut().close = Some(CloseRole::Lock));
    let error = reader.finish().unwrap_err();
    let StoreError::Finalization { primary, secondary } = error else {
        panic!("lost primary/finalizer failure: {error:?}");
    };
    assert_eq!(primary.code(), "STORE_CHANGED");
    assert_eq!(secondary.code(), "STORE_IO");
    assert_eq!(tree.fd_count(), 1);
}

#[test]
fn rebinding_the_store_directory_during_projection_refuses_acknowledgement() {
    let tree = Tree::new();
    let store = tree.save();
    let reader = store.locked_read().unwrap();
    let moved = tree.root.with_extension("moved");
    fs::rename(&tree.root, &moved).unwrap();
    fs::create_dir(&tree.root).unwrap();
    fs::set_permissions(&tree.root, fs::Permissions::from_mode(0o700)).unwrap();
    let error = reader.finish().unwrap_err();
    fs::remove_dir(&tree.root).unwrap();
    fs::rename(moved, &tree.root).unwrap();
    assert_eq!(error.code(), "STORE_DIRECTORY_REBOUND");
    assert_eq!(tree.fd_count(), 1);
}

#[test]
fn read_guard_does_not_acknowledge_a_close_or_lock_rebind_failure() {
    for close_role in [Some(CloseRole::Data), Some(CloseRole::Lock), None] {
        let tree = Tree::new();
        let store = tree.save();
        let reader = store.locked_read().unwrap();
        if close_role.is_none() {
            let lock = tree.root.join("profiles.lock");
            fs::rename(&lock, tree.root.join("original.lock")).unwrap();
            fs::write(&lock, b"").unwrap();
            fs::set_permissions(lock, fs::Permissions::from_mode(0o600)).unwrap();
        } else {
            faults::STATE.with(|state| state.borrow_mut().close = close_role);
        }
        let error = reader.finish().unwrap_err();
        assert_eq!(
            error.code(),
            if close_role.is_none() {
                "LOCK_REBOUND"
            } else {
                "STORE_IO"
            }
        );
        assert!(!error.is_uncertain());
        assert_eq!(tree.fd_count(), 1);
    }
}
