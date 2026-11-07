use super::*;

#[test]
fn actual_legacy_receipt_keeps_empty_nul_parent_and_dangling_path_dispositions() {
    let tree = Tree::new();
    let runtime = runtime(&tree);
    let mut owner = runtime
        .resolve_storage(&selected(&tree), &session(B))
        .unwrap()
        .into_legacy()
        .unwrap();
    owner.prepare_storage().unwrap();
    owner.prepare_runtime_directory().unwrap();
    let launch = owner.paths().home().join(".reverie-launch");
    tree.mkdir(&launch);
    tree.write(&owner.paths().home().join("done"), b"0");
    symlink(tree.0.join("absent"), launch.join("dangling")).unwrap();
    for (exit, expected) in [
        ("", true),
        ("x\0y", false),
        ("../done", true),
        ("dangling", false),
    ] {
        tree.write(
            &tree.state().join(B).join("runtime.json"),
            &serde_json::to_vec(&json!({"exit":exit})).unwrap(),
        );
        assert_eq!(
            owner.observe_launch_receipt().unwrap().exists(),
            expected,
            "{exit:?}"
        );
    }
    assert!(
        !tree.state().join("storage-locks").exists(),
        "legacy read never mints a lease"
    );
    owner.close(end()).unwrap();
    runtime.close(end()).unwrap();
}

#[test]
fn runtime_read_close_failure_refuses_positive_data_and_preserves_both_actual_failures() {
    let tree = Tree::new();
    let runtime = runtime(&tree);
    let mut owner = runtime
        .resolve_storage(&selected(&tree), &session(B))
        .unwrap()
        .into_legacy()
        .unwrap();
    owner.prepare_storage().unwrap();
    owner.prepare_runtime_directory().unwrap();
    let leaf = tree.state().join(B).join("runtime.json");
    tree.write(&leaf, br#"{"exit":""}"#);
    native::test_faults::set(None, true);
    let one = owner.observe_launch_receipt().err().unwrap();
    native::test_faults::set(None, false);
    assert!(matches!(one, StorageOwnerError::Storage(_)));
    stdfs::remove_file(&leaf).unwrap();
    tree.mkdir(&leaf); // open succeeds; the actual read refuses EISDIR.
    native::test_faults::set(None, true);
    let both = owner.observe_launch_receipt().err().unwrap();
    native::test_faults::set(None, false);
    let StorageOwnerError::Finalized { primary, secondary } = both else {
        panic!("actual read+checked-close failures")
    };
    assert!(matches!(*primary, StorageOwnerError::Path(_)));
    assert_eq!(secondary.len(), 1);
    assert!(matches!(secondary[0], StorageOwnerError::Storage(_)));
    assert_eq!(owner.ownership_kind(), StorageOwnershipKind::UnleasedLegacy);
    owner.close(end()).unwrap();
    runtime.close(end()).unwrap();
}
