use super::*;
use std::os::unix::fs::symlink;

#[test]
fn read_existing_creates_neither_directory_nor_files_and_missing_is_revision_zero() {
    let tree = Tree::new();
    assert!(ProfileStore::open(tree.root.join("absent")).is_err());
    let store = tree.open();
    let document = store.read_existing().unwrap();
    assert_eq!(document.revision().get(), 0);
    assert!(document.profiles().is_empty());
    assert_eq!(fs::read_dir(&tree.root).unwrap().count(), 0);
    store.snapshot().unwrap();
    assert_eq!(fs::read_dir(&tree.root).unwrap().count(), 1);
    assert!(tree.root.join("profiles.lock").exists());
}
#[test]
fn observation_preserves_missing_versus_present_empty_without_creating_a_lock() {
    use crate::profiles::ProfilePresence;
    let tree = Tree::new();
    let store = tree.open();
    let absent = store.observe_existing().unwrap();
    assert_eq!(absent.presence(), ProfilePresence::Missing);
    tree.write(&profiles_v1::encode(&ProfileDocument::empty()).unwrap());
    let present = store.observe_existing().unwrap();
    assert_eq!(present.presence(), ProfilePresence::Present);
    assert_eq!(absent.document(), present.document());
    assert!(!tree.root.join("profiles.lock").exists());
}
#[test]
fn persist_reopen_keeps_exact_canonical_schema_and_profile() {
    let tree = Tree::new();
    let store = tree.save();
    let document = store.snapshot().unwrap();
    let expected = profiles_v1::encode(&document).unwrap();
    assert_eq!(tree.raw(), expected);
    assert_eq!(document.revision().get(), 1);
    assert_eq!(
        document.profiles()[&ProfileEmployeeId::parse(E).unwrap()]
            .resources()
            .memory_mib(),
        38147
    );
    store.close().unwrap();
    let reopened = tree.open();
    assert_eq!(reopened.read_existing().unwrap(), document);
    assert_eq!(
        fs::metadata(tree.data()).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert!(tree.temporaries().is_empty());
}
#[test]
fn stale_store_version_and_previous_binding_make_zero_writes() {
    let tree = Tree::new();
    let store = tree.save();
    let before = tree.raw();
    for (revision, version, previous, code) in [
        (0, 1, Some(binding(E, A, B)), "STALE_STORE_REVISION"),
        (1, 0, Some(binding(E, A, B)), "STALE_PROFILE_VERSION"),
        (1, 1, None, "STALE_IDENTITY_BINDING"),
    ] {
        let change = intent(E, 8192, revision, version, previous);
        assert_eq!(assert_pre_refusal(store.put(&change)).code(), code);
        assert_eq!(tree.raw(), before);
    }
}
#[test]
fn another_employee_update_keeps_the_existing_profile_identical() {
    let tree = Tree::new();
    let store = tree.save();
    let first = store.snapshot().unwrap();
    let result = store.put(&intent(F, 8192, 1, 0, None)).unwrap();
    let employee = ProfileEmployeeId::parse(E).unwrap();
    assert_eq!(first.profiles()[&employee], result.profiles()[&employee]);
    assert_eq!(result.profiles().len(), 2);
    assert_eq!(result.revision().get(), 2);
}
#[test]
fn same_session_binding_and_immutable_returned_values_preserve_legacy_behavior() {
    let tree = Tree::new();
    let store = tree.open();
    let same = binding(E, A, A);
    let change = ProfilePutIntent::try_new(
        ProfileEmployeeId::parse(E).unwrap(),
        resources(4096),
        same.clone(),
        StoreRevision::ZERO,
        ObservedProfileVersion::try_new(0).unwrap(),
        None,
    )
    .unwrap();
    let result = store.put(&change).unwrap();
    assert_eq!(
        result.profiles()[&ProfileEmployeeId::parse(E).unwrap()].binding(),
        &same
    );
    let derived = result
        .apply(
            &ProfilePutIntent::try_new(
                ProfileEmployeeId::parse(E).unwrap(),
                resources(8192),
                same.clone(),
                StoreRevision::try_new(1).unwrap(),
                ObservedProfileVersion::try_new(1).unwrap(),
                Some(same),
            )
            .unwrap(),
        )
        .unwrap();
    assert_eq!(derived.revision().get(), 2);
    assert_eq!(store.read_existing().unwrap().revision().get(), 1);
}
#[test]
fn duplicate_oversized_nonfinite_and_wrong_types_are_refused_without_repair() {
    let tree = Tree::new();
    let store = tree.open();
    for raw in [
        b"{\"revision\":0,\"revision\":1}".to_vec(),
        vec![b'x'; 131073],
        b"{\"schema\":\"reverie-employee-resource-profiles-v1\",\"revision\":true,\"profiles\":{}}"
            .to_vec(),
        b"{\"schema\":\"reverie-employee-resource-profiles-v1\",\"revision\":NaN,\"profiles\":{}}"
            .to_vec(),
    ] {
        tree.write(&raw);
        assert!(store.read_existing().is_err());
        assert_eq!(tree.raw(), raw);
    }
}
#[test]
fn symlink_fifo_directory_bad_mode_and_hardlinked_data_are_refused() {
    let tree = Tree::new();
    let store = tree.open();
    symlink("/dev/null", tree.data()).unwrap();
    assert!(store.snapshot().is_err());
    fs::remove_file(tree.data()).unwrap();
    crate::private_fs::fifo(&tree.data());
    assert!(store.snapshot().is_err());
    fs::remove_file(tree.data()).unwrap();
    fs::create_dir(tree.data()).unwrap();
    assert!(store.snapshot().is_err());
    fs::remove_dir(tree.data()).unwrap();
    store.put(&new_intent()).unwrap();
    let before = tree.raw();
    fs::set_permissions(tree.data(), fs::Permissions::from_mode(0o644)).unwrap();
    assert!(store.snapshot().is_err());
    fs::set_permissions(tree.data(), fs::Permissions::from_mode(0o600)).unwrap();
    fs::hard_link(tree.data(), tree.root.join("alias")).unwrap();
    assert!(store.snapshot().is_err());
    assert_eq!(tree.raw(), before);
}
#[test]
fn unsafe_lock_files_are_never_recreated_or_repaired() {
    let tree = Tree::new();
    let store = tree.open();
    let lock = tree.root.join("profiles.lock");
    symlink("/dev/null", &lock).unwrap();
    assert!(store.snapshot().is_err());
    fs::remove_file(&lock).unwrap();
    crate::private_fs::fifo(&lock);
    assert!(store.snapshot().is_err());
    fs::remove_file(&lock).unwrap();
    store.snapshot().unwrap();
    fs::hard_link(&lock, tree.root.join("lock-alias")).unwrap();
    assert!(store.snapshot().is_err());
}
#[test]
fn a_readonly_observation_needs_no_writable_lock_and_never_touches_it() {
    let tree = Tree::new();
    let store = tree.save();
    let lock = tree.root.join("profiles.lock");
    fs::remove_file(&lock).unwrap();
    symlink("missing-foreign-lock", &lock).unwrap();
    let before = tree.raw();
    assert_eq!(store.read_existing().unwrap().revision().get(), 1);
    assert!(store.snapshot().is_err());
    assert_eq!(
        fs::read_link(lock).unwrap(),
        PathBuf::from("missing-foreign-lock")
    );
    assert_eq!(tree.raw(), before);
}
#[test]
fn a_rebound_directory_is_refused_before_any_write() {
    let tree = Tree::new();
    let store = tree.save();
    let moved = tree.root.with_extension("moved");
    fs::rename(&tree.root, &moved).unwrap();
    fs::create_dir(&tree.root).unwrap();
    fs::set_permissions(&tree.root, fs::Permissions::from_mode(0o700)).unwrap();
    let result = store.put(&next_intent());
    fs::remove_dir(&tree.root).unwrap();
    fs::rename(moved, &tree.root).unwrap();
    assert_pre_refusal(result);
    assert_eq!(store.snapshot().unwrap().revision().get(), 1);
}
#[test]
fn symlinked_ancestors_are_rejected_even_when_the_leaf_points_to_original_inode() {
    let tree = Tree::new();
    let parent = tree.root.join("parent");
    let leaf = parent.join("store");
    fs::create_dir(&parent).unwrap();
    fs::create_dir(&leaf).unwrap();
    fs::set_permissions(&leaf, fs::Permissions::from_mode(0o700)).unwrap();
    let store = ProfileStore::open(&leaf).unwrap();
    let moved = tree.root.join("moved");
    fs::rename(&parent, &moved).unwrap();
    symlink(&moved, &parent).unwrap();
    assert!(store.read_existing().is_err());
    fs::remove_file(parent).unwrap();
    fs::rename(moved, tree.root.join("parent")).unwrap();
}
#[test]
fn normal_and_failed_calls_do_not_leak_owned_descriptors() {
    let tree = Tree::new();
    assert_eq!(tree.fd_count(), 0);
    let store = tree.open();
    assert_eq!(tree.fd_count(), 1);
    store.put(&new_intent()).unwrap();
    for _ in 0..8 {
        store.snapshot().unwrap();
        assert_pre_refusal(store.put(&new_intent()));
    }
    assert_eq!(tree.fd_count(), 1);
    store.close().unwrap();
    assert_eq!(tree.fd_count(), 0);
}
