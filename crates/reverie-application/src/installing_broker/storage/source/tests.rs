//! Real recovery registration/Office/employee lease. These isolate resource
//! fencing only; they mint no draft, native stop or API permission.
use super::*;
use crate::installing_broker::recovered::tests::Tree;
use reverie_host::worker_storage::StorageLease;
use std::{
    fs,
    io::Write,
    os::unix::net::UnixStream,
    sync::mpsc,
    time::{Duration, Instant},
};
const SID: &str = "11111111-2222-3333-4444-555555555555";
const NEXT_SID: &str = "22222222-2222-3333-4444-555555555555";
const EID: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
fn operation() -> JournalId {
    JournalId::parse("33333333-2222-4333-8444-555555555555").unwrap()
}
#[test]
fn supervision_keeps_the_actual_source_pending_without_borrowing_or_releasing_it() {
    crate::test_process::owning_case!(
        supervision_keeps_the_actual_source_pending_without_borrowing_or_releasing_it
    );
    let tree = employee_tree();
    let config = tree.broker.configuration().unwrap();
    let ordinary = tree.broker.claim_storage(&session()).unwrap();
    let (reference, office) = reference(&tree);
    let attached = reference
        .attach(config.configuration(), operation(), office)
        .unwrap();
    let source = attached.retained_source();
    drop(attached);
    let calls = fs::read(tree.root.join("calls.txt")).unwrap();
    let result = {
        let lifecycle = tree.broker.installed.lifecycle().unwrap();
        super::super::super::supervisor::should_stop(
            &tree.broker,
            &lifecycle.guard[0],
            config.configuration(),
        )
    };
    let ordinary_refused = ordinary.observe_launch_receipt().is_err();
    let unchanged = fs::read(tree.root.join("calls.txt")).unwrap() == calls;
    let held = StorageLease::acquire_launch(config.configuration(), &session()).is_err();
    let same = {
        let entries = tree.broker.storage.lock(None).unwrap();
        entries.iter().any(|entry| matches!(&entry.owner, EntryOwner::Source(actual) if Arc::ptr_eq(actual, &source.record)))
    };
    let registry = source.registry.upgrade().unwrap();
    source
        .restore_unclaimed(&mut registry.lock(None).unwrap())
        .unwrap();
    ordinary.release(end()).unwrap();
    assert!(
        result.is_ok_and(|observed| observed.is_none()),
        "actual supervision must return typed pending, not latch an unrelated source as a failed stop"
    );
    assert!(ordinary_refused && unchanged && held && same);
}
#[test]
fn actual_pending_phone_refuses_original_resource_close_before_consuming_employee_lease() {
    crate::test_process::owning_case!(
        actual_pending_phone_refuses_original_resource_close_before_consuming_employee_lease
    );
    let tree = employee_tree();
    let config = tree.broker.configuration().unwrap();
    let ordinary = tree.broker.claim_storage(&session()).unwrap();
    let (reference, office) = reference(&tree);
    let attached = reference
        .attach(config.configuration(), operation(), office.clone())
        .unwrap();
    let source = attached.source.clone();
    drop(attached);
    fs::create_dir(tree.root.join("company")).unwrap();
    fs::create_dir(tree.root.join("company/console")).unwrap();
    fs::write(
        tree.root.join("company/console/.env"),
        "REVERIE_USERNAME=fixture\nREVERIE_PASSWORD=synthetic-only\n",
    )
    .unwrap();
    fs::write(tree.root.join("server.out"), br#"[{"State":{"Running":true},"NetworkSettings":{"Networks":{"bridge":{"IPAddress":"127.0.0.1"}}}}]"#).unwrap();
    fs::write(tree.root.join("server.hold"), "hold actual owned query").unwrap();
    let mut connection =
        UnixStream::connect(tree.root.join("office").join(SID).join("office.sock")).unwrap();
    connection
        .write_all(b"GET /api/instances HTTP/1.1\r\nHost: guest\r\nContent-Length: 0\r\n\r\n")
        .unwrap();
    let limit = end();
    while !tree.root.join("server.started").exists() && Instant::now() < limit {
        std::thread::sleep(Duration::from_millis(2));
    }
    let entered = tree.root.join("server.started").exists();
    let refused = source.release_original_resource(Instant::now() + Duration::from_millis(50));
    let held = StorageLease::acquire_launch(config.configuration(), &session()).is_err();
    let direct = matches!(
        source.record.owner.lock().unwrap().as_ref(),
        Some(SourceOwned::Direct(_))
    );
    drop(connection);
    fs::write(tree.root.join("server.release"), "settle same actual query").unwrap();
    office._office.close(end()).unwrap();
    assert!(
        entered,
        "the actual query, not only HTTP submission, was held"
    );
    assert_eq!(
        refused.err().unwrap().code(),
        "RESOURCE_ORIGINAL_OFFICE_CLOSE_UNCONFIRMED"
    );
    assert!(
        held && direct,
        "phone uncertainty precedes any original lease consumption"
    );
    // Synthetic fixture only: no journal claim or source effect was created.
    // All actual phone/native work is now closed before restoring its SAME box.
    let registry = source.registry.upgrade().unwrap();
    source
        .restore_unclaimed(&mut registry.lock(None).unwrap())
        .unwrap();
    ordinary.release(end()).unwrap();
}
fn session() -> ProfileSessionId {
    ProfileSessionId::parse(SID).unwrap()
}
fn end() -> Instant {
    Instant::now() + Duration::from_secs(5)
}
#[test]
fn supervision_skips_retained_source_but_selects_the_freshly_recovered_old_direct_sibling() {
    crate::test_process::owning_case!(
        supervision_skips_retained_source_but_selects_the_freshly_recovered_old_direct_sibling
    );
    const SECOND: &str = "44444444-2222-4333-8444-555555555555";
    const SECOND_EID: &str = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
    let tree = Tree::new(&format!("test-agent-{SID}\ntest-agent-{SECOND}\n"));
    let second = ProfileSessionId::parse(SECOND).unwrap();
    let config = tree.broker.configuration().unwrap();
    let company = |second_sid: &str| {
        serde_json::to_vec(&serde_json::json!({"employees":[
            {"id":EID,"owner":null,"sessionId":SID,"desiredRunning":true},
            {"id":SECOND_EID,"owner":null,"sessionId":second_sid,"desiredRunning":true}
        ]}))
        .unwrap()
    };
    fs::write(tree.root.join("company.json"), company(SECOND)).unwrap();
    for sid in [session(), second.clone()] {
        let mut prior = StorageLease::acquire_launch(config.configuration(), &sid).unwrap();
        prior.prepare_storage().unwrap();
        prior.record_storage_binding().unwrap();
        prior.close().unwrap();
    }
    // Restart reconstruction sees the advanced canonical binding. The old
    // sibling is resolved through its original storage-owner lineage.
    fs::write(tree.root.join("company.json"), company(NEXT_SID)).unwrap();
    tree.broker.recover_laptops().unwrap();
    fs::create_dir_all(tree.root.join("state").join(SECOND)).unwrap();
    fs::write(
        tree.root.join("state").join(SECOND).join("runtime.json"),
        br#"{"exit":"not-completed"}"#,
    )
    .unwrap();
    let ordinary = tree.broker.claim_storage(&session()).unwrap();
    let (reference, office) = reference(&tree);
    let attached = reference
        .attach(config.configuration(), operation(), office)
        .unwrap();
    let source = attached.retained_source();
    drop(attached);
    let before = fs::read(tree.root.join("calls.txt")).unwrap();
    let identities = {
        let entries = tree.broker.storage.lock(None).unwrap();
        entries
            .iter()
            .map(|entry| Arc::as_ptr(&entry.identity))
            .collect::<Vec<_>>()
    };
    let selected =
        super::super::super::supervisor::select_candidate(&tree.broker, config.configuration());
    let after = fs::read(tree.root.join("calls.txt")).unwrap();
    let conserved = {
        let entries = tree.broker.storage.lock(None).unwrap();
        entries
            .iter()
            .map(|entry| Arc::as_ptr(&entry.identity))
            .collect::<Vec<_>>()
            == identities
            && matches!(&entries[0].owner, EntryOwner::Source(actual) if Arc::ptr_eq(actual, &source.record))
            && matches!(&entries[1].owner, EntryOwner::Direct(_))
    };
    let lifecycle_conserved = tree.broker.installed.lifecycle().unwrap().guard.len() == 2;
    source
        .restore_unclaimed(&mut tree.broker.storage.lock(None).unwrap())
        .unwrap();
    ordinary.release(end()).unwrap();
    let recovered = tree.broker.installed.lifecycle().unwrap().guard.remove(1);
    let LaptopOwner::Recovered(old) = recovered.owner else {
        panic!("actual recovered old sibling")
    };
    old.office.close_for_stopped_source(end()).unwrap();
    old.storage.release(end()).unwrap();
    assert!(
        selected.is_ok_and(|candidate| candidate.is_some_and(|(sid, _)| sid == second)),
        "retained neighbor must not hide the eligible original old Direct owner"
    );
    assert!(
        before == after && conserved && lifecycle_conserved,
        "selection must not stop or release either genuine seat"
    );
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
