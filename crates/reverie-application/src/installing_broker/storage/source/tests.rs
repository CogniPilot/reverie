//! Real recovery registration/Office/employee lease. These isolate resource
//! fencing only; they mint no draft, native stop or API permission.
use super::*;
use crate::installing_broker::recovered::tests::Tree;
use reverie_host::worker_storage::StorageLease;
use std::{
    fs,
    sync::mpsc,
    time::{Duration, Instant},
};
const SID: &str = "11111111-2222-3333-4444-555555555555";
const NEXT_SID: &str = "22222222-2222-3333-4444-555555555555";
const EID: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
fn operation() -> JournalId {
    JournalId::parse("33333333-2222-4333-8444-555555555555").unwrap()
}
fn session() -> ProfileSessionId {
    ProfileSessionId::parse(SID).unwrap()
}
fn end() -> Instant {
    Instant::now() + Duration::from_secs(5)
}
fn employee_tree() -> Tree {
    let tree = Tree::new(&format!("test-agent-{SID}\n"));
    fs::write(tree.root.join("company.json"), serde_json::to_vec(&serde_json::json!({"employees":[{"id":EID,"owner":null,"sessionId":SID,"desiredRunning":true}]})).unwrap()).unwrap();
    let config = tree.broker.configuration().unwrap();
    let mut prior = StorageLease::acquire_launch(config.configuration(), &session()).unwrap();
    prior.prepare_storage().unwrap();
    prior.record_storage_binding().unwrap();
    prior.close().unwrap();
    tree.broker.recover_laptops().unwrap();
    tree
}
fn reference(
    tree: &Tree,
) -> (
    SourceReference,
    Arc<crate::installing_broker::recovered::RecoveredOffice>,
) {
    let life = tree.broker.installed.lifecycle().unwrap();
    let LaptopOwner::Recovered(owner) = &life.guard[0].owner else {
        panic!("actual recovered owner")
    };
    (
        owner.storage.original_source_reference().unwrap(),
        owner.office.clone(),
    )
}
#[test]
fn actual_source_fence_keeps_original_lease_and_refuses_ordinary_release_after_guard_exit() {
    crate::test_process::owning_case!(
        actual_source_fence_keeps_original_lease_and_refuses_ordinary_release_after_guard_exit
    );
    let tree = employee_tree();
    let config = tree.broker.configuration().unwrap();
    let ordinary = tree.broker.claim_storage(&session()).unwrap();
    let (reference, office) = reference(&tree);
    let attached = reference
        .attach(config.configuration(), operation(), office)
        .unwrap();
    let source = RegisteredSource {
        registry: attached.source.registry.clone(),
        record: attached.source.record.clone(),
    };
    let (started, observed) = mpsc::sync_channel(1);
    let worker = std::thread::spawn(move || {
        started.send(()).unwrap();
        ordinary.release(end())
    });
    observed.recv_timeout(Duration::from_secs(5)).unwrap();
    let held_before = StorageLease::acquire_launch(config.configuration(), &session()).is_err();
    drop(attached); // Still Source, not an implicit release or rollback.
    let failed = worker
        .join()
        .unwrap()
        .expect_err("actual ordinary release refused");
    let (ordinary, error) = failed.into_parts();
    let held_after = StorageLease::acquire_launch(config.configuration(), &session()).is_err();
    assert!(held_before && held_after);
    assert_eq!(error.code(), "WORKER_ORIGINAL_SOURCE_RETAINED");
    // Test fixture only: no journal claim/effect occurred, so restore its SAME
    // box after assertions, then consume that exact ordinary resource handle.
    let registry = source.registry.upgrade().unwrap();
    source
        .restore_unclaimed(&mut registry.lock(None).unwrap())
        .unwrap();
    ordinary.release(end()).unwrap();
    StorageLease::acquire_launch(config.configuration(), &session())
        .unwrap()
        .close()
        .unwrap();
}
#[test]
fn actual_source_reference_refuses_same_path_reacquisition_aba_without_moving_new_owner() {
    crate::test_process::owning_case!(
        actual_source_reference_refuses_same_path_reacquisition_aba_without_moving_new_owner
    );
    let tree = employee_tree();
    let config = tree.broker.configuration().unwrap();
    let (reference, office) = reference(&tree);
    let first = tree.broker.claim_storage(&session()).unwrap();
    let paths = first.paths().clone();
    first.release(end()).unwrap();
    let second = tree.broker.claim_storage(&session()).unwrap();
    assert_eq!(second.paths(), &paths);
    let error = reference
        .attach(config.configuration(), operation(), office)
        .err()
        .expect("old acquisition must refuse");
    assert_eq!(error.code(), "RESOURCE_ORIGINAL_SOURCE_CHANGED");
    assert!(StorageLease::acquire_launch(config.configuration(), &session()).is_err());
    second.release(end()).unwrap();
    StorageLease::acquire_launch(config.configuration(), &session())
        .unwrap()
        .close()
        .unwrap();
}
#[test]
fn actual_source_fence_keeps_prepublication_lease_after_binding_moves_to_new_session() {
    crate::test_process::owning_case!(
        actual_source_fence_keeps_prepublication_lease_after_binding_moves_to_new_session
    );
    let tree = employee_tree();
    let config = tree.broker.configuration().unwrap();
    let old_company = fs::read(tree.root.join("company.json")).unwrap();
    let ordinary = tree.broker.claim_storage(&session()).unwrap();
    let (reference, office) = reference(&tree);
    let attached = reference
        .attach(config.configuration(), operation(), office)
        .unwrap();
    fs::write(tree.root.join("company.json"), serde_json::to_vec(&serde_json::json!({"employees":[{"id":EID,"owner":null,"sessionId":NEXT_SID,"desiredRunning":true}]})).unwrap()).unwrap();
    let next = ProfileSessionId::parse(NEXT_SID).unwrap();
    assert!(StorageLease::acquire_launch(config.configuration(), &next).is_err());
    assert_eq!(attached.source.record.paths.session(), &session());
    // Synthetic unclaimed fixture teardown; actual publication/stop cannot use
    // this restoration path after a durable claim may have been written.
    fs::write(tree.root.join("company.json"), old_company).unwrap();
    attached.restore_unclaimed().unwrap();
    ordinary.release(end()).unwrap();
}
