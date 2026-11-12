//! Original registry allocation identity, never ownership transfer or a stop
//! certificate. The actual lease/Box stays with its original registry entry.
use super::*;

fn company(tree: &Tree) -> reverie_contracts::storage_identity::Metadata {
    reverie_contracts::storage_identity::decode_metadata(
        &fs::read(tree.0.join("company.json")).unwrap(),
    )
    .unwrap()
}

#[test]
fn snapshot_keeps_original_registry_identity_and_original_box_without_native_work() {
    crate::test_process::owning_case!(
        snapshot_keeps_original_registry_identity_and_original_box_without_native_work
    );
    let tree = Tree::new();
    let registry = tree.registry();
    let claim = registry.claim(&tree.source(), &sid(SID)).unwrap();
    let calls_before = tree.calls();
    let (identity, allocation) = {
        let entries = registry.entries.lock().unwrap();
        let EntryOwner::Direct(owner) = &entries[0].owner else {
            panic!("actual Direct lease")
        };
        (
            Arc::clone(&entries[0].identity),
            std::ptr::from_ref(owner.as_ref()),
        )
    };
    let metadata = company(&tree);
    let snapshot = registry.capture_fleet_preview(&metadata).unwrap();
    let known = snapshot.assert_current(&registry, &metadata);
    let foreign = tree.registry();
    let refused = snapshot.assert_current(&foreign, &metadata);
    let unchanged = {
        let entries = registry.entries.lock().unwrap();
        let EntryOwner::Direct(owner) = &entries[0].owner else {
            panic!("original Direct lease")
        };
        Arc::ptr_eq(&identity, &entries[0].identity)
            && std::ptr::from_ref(owner.as_ref()) == allocation
            && entries[0].paths == *claim.paths()
            && tree.calls() == calls_before
    };
    drop(snapshot);
    claim.release(end()).unwrap();
    registry.runtime.close(end()).unwrap();
    foreign.runtime.close(end()).unwrap();
    known.unwrap();
    assert!(refused.is_err() && unchanged);
}

#[test]
fn equal_captured_data_from_a_new_real_registry_cannot_adopt_the_original_snapshot() {
    crate::test_process::owning_case!(
        equal_captured_data_from_a_new_real_registry_cannot_adopt_the_original_snapshot
    );
    let tree = Tree::new();
    let original = tree.registry();
    let first = original.claim(&tree.source(), &sid(SID)).unwrap();
    let metadata = company(&tree);
    let snapshot = original.capture_fleet_preview(&metadata).unwrap();
    first.release(end()).unwrap();
    let foreign = tree.registry();
    let replacement = foreign.claim(&tree.source(), &sid(SID)).unwrap();
    let calls_before = tree.calls();
    let foreign_snapshot = foreign.capture_fleet_preview(&metadata).unwrap();
    let equal_data = snapshot.rows() == foreign_snapshot.rows();
    let refused = snapshot.assert_current(&foreign, &metadata);
    drop(foreign_snapshot);
    drop(snapshot);
    replacement.release(end()).unwrap();
    original.runtime.close(end()).unwrap();
    foreign.runtime.close(end()).unwrap();
    assert!(equal_data && refused.is_err());
    assert_eq!(tree.calls(), calls_before);
}

#[test]
fn equal_paths_after_entry_identity_replacement_do_not_refresh_existing_snapshot() {
    crate::test_process::owning_case!(
        equal_paths_after_entry_identity_replacement_do_not_refresh_existing_snapshot
    );
    let tree = Tree::new();
    let registry = tree.registry();
    let claim = registry.claim(&tree.source(), &sid(SID)).unwrap();
    let calls_before = tree.calls();
    let metadata = company(&tree);
    let snapshot = registry.capture_fleet_preview(&metadata).unwrap();
    let original = {
        let mut entries = registry.entries.lock().unwrap();
        std::mem::replace(&mut entries[0].identity, Arc::new(()))
    };
    let refused = snapshot.assert_current(&registry, &metadata);
    registry.entries.lock().unwrap()[0].identity = original;
    let same_original = snapshot.assert_current(&registry, &metadata);
    let no_calls = tree.calls() == calls_before;
    drop(snapshot);
    claim.release(end()).unwrap();
    registry.runtime.close(end()).unwrap();
    same_original.unwrap();
    assert!(refused.is_err() && no_calls);
}

#[test]
fn readonly_storage_capture_refuses_busy_registry_and_unconfirmed_writer() {
    crate::test_process::owning_case!(
        readonly_storage_capture_refuses_busy_registry_and_unconfirmed_writer
    );
    let tree = Tree::new();
    let registry = tree.registry();
    let claim = registry.claim(&tree.source(), &sid(SID)).unwrap();
    let calls_before = tree.calls();
    let metadata = company(&tree);
    let mut entries = registry.entries.lock().unwrap();
    let busy = registry.capture_fleet_preview(&metadata).err().unwrap();
    entries[0].writer_checked = false;
    drop(entries);
    let unconfirmed = registry.capture_fleet_preview(&metadata).err().unwrap();
    registry.entries.lock().unwrap()[0].writer_checked = true;
    let no_calls = tree.calls() == calls_before;
    claim.release(end()).unwrap();
    registry.runtime.close(end()).unwrap();
    assert!(no_calls);
    assert_eq!(busy.code(), "FLEET_PREVIEW_STORAGE_UNAVAILABLE");
    assert_eq!(unconfirmed.code(), "WORKER_STORAGE_CLEANUP_UNCONFIRMED");
}
