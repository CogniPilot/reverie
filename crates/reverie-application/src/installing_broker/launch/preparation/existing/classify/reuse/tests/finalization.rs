//! Real accepted J, same employee lease and owned Rust provider/viewer. These
//! fixtures contact no host engine or running company.
use super::*;
mod recovered;
use std::{
    fs,
    path::PathBuf,
    process::{Child, Command},
    time::Duration,
};
struct Provider {
    child: Child,
    root: PathBuf,
}
impl Provider {
    fn new(tree: &Tree) -> Self {
        let child = Command::new(crate::test_process::engine_program())
            .arg("__reuse_provider_target")
            .current_dir(&tree.root)
            .spawn()
            .unwrap();
        let owner = Self {
            child,
            root: tree.root.clone(),
        };
        wait_file(&tree.root.join("provider-ready"));
        owner
    }
}
impl Drop for Provider {
    fn drop(&mut self) {
        fs::write(self.root.join("release-provider"), b"own fixture teardown").unwrap();
        assert!(self.child.wait().unwrap().success());
    }
}
fn wait_file(path: &std::path::Path) {
    let until = end();
    while !path.is_file() {
        assert!(Instant::now() < until);
        std::thread::sleep(Duration::from_millis(1));
    }
}
fn employee(tree: &Tree) {
    tree.write("company.json", &serde_json::to_vec(&serde_json::json!({"employees":[{"id":"11111111-2222-4333-8444-555555555555","owner":null,"sessionId":SID,"desiredRunning":true}]})).unwrap());
}
fn enable(tree: &Tree, pid: u32) {
    let mut rows: serde_json::Value =
        serde_json::from_slice(&fs::read(tree.root.join("inspect.out")).unwrap()).unwrap();
    rows[0]["Name"] = serde_json::json!(format!("/test-agent-{SID}"));
    rows[0]["State"] = serde_json::json!({"Running":true,"Pid":pid});
    tree.write("finalizer-live.json", &serde_json::to_vec(&rows).unwrap());
    rows[0]["State"] = serde_json::json!({"Running":false,"Pid":0});
    tree.write(
        "finalizer-stopped.json",
        &serde_json::to_vec(&rows).unwrap(),
    );
    tree.write(
        "finalizer-census.out",
        format!("{} test-agent-{SID}\n", "a".repeat(64)).as_bytes(),
    );
    tree.write("reuse-finalizer-control", b"fixed owning finalizer fixture");
}
fn receipt(owner: &ReusableWorkerLaunch<'_>) -> PathBuf {
    owner
        .inspected
        .observed
        .claimed
        .storage
        .as_ref()
        .unwrap()
        .paths()
        .home()
        .join(".reverie-launch/original.exit")
}
#[test]
fn eof_then_late_receipt_stops_actual_provider_before_viewer_reap_and_closes_real_hold_and_lease() {
    crate::test_process::owning_case!(eof_then_late_receipt_stops_actual_provider_before_viewer_reap_and_closes_real_hold_and_lease);
    let tree = Tree::new();
    let broker = broker(&tree);
    employee(&tree);
    let provider = Provider::new(&tree);
    let reuse = reusable(&tree, &broker);
    let exit = receipt(&reuse);
    let source = reuse.inspected.observed.current.configuration().clone();
    let viewing = reuse
        .prepare_viewer()
        .unwrap()
        .close_allocation()
        .unwrap()
        .start(end())
        .unwrap();
    wait_file(&tree.root.join("viewer-ready"));
    enable(&tree, provider.child.id());
    let (viewing, outcome) = viewing.relay().into_parts();
    assert!(matches!(
        outcome,
        Ok(reverie_host::worker_reports::ViewerRelayEnd::PeerClosed)
    ));
    fs::create_dir_all(exit.parent().unwrap()).unwrap();
    fs::write(exit, b"0").unwrap();
    let closed = viewing.finalize_for_worker().unwrap();
    assert!(closed.completed());
    assert!(!closed.storage_retained());
    assert!(closed.primary_error().is_none());
    assert!(tree.root.join("stop-before-viewer-reap").is_file());
    assert!(tree.root.join("provider-exited").is_file());
    reverie_host::worker_storage::StorageLease::acquire_migration(
        &source,
        &ProfileSessionId::parse(SID).unwrap(),
    )
    .unwrap()
    .close()
    .unwrap();
    broker.close_command_telemetry(end()).unwrap();
}
#[test]
fn eof_without_receipt_closes_handler_hold_but_keeps_actual_live_laptop_lease() {
    crate::test_process::owning_case!(
        eof_without_receipt_closes_handler_hold_but_keeps_actual_live_laptop_lease
    );
    let tree = Tree::new();
    let broker = broker(&tree);
    employee(&tree);
    let provider = Provider::new(&tree);
    let reuse = reusable(&tree, &broker);
    let source = reuse.inspected.observed.current.configuration().clone();
    let viewing = reuse
        .prepare_viewer()
        .unwrap()
        .close_allocation()
        .unwrap()
        .start(end())
        .unwrap();
    wait_file(&tree.root.join("viewer-ready"));
    enable(&tree, provider.child.id());
    let (viewing, outcome) = viewing.relay().into_parts();
    assert!(outcome.is_ok());
    let closed = viewing.finalize_for_worker().unwrap();
    assert!(!closed.completed());
    assert!(closed.storage_retained());
    assert!(!tree.root.join("stopped-provider").exists());
    assert!(
        reverie_host::worker_storage::StorageLease::acquire_migration(
            &source,
            &ProfileSessionId::parse(SID).unwrap()
        )
        .is_err()
    );
    broker.close_command_telemetry(end()).unwrap();
}
#[test]
fn completion_before_constructor_uses_same_held_record_without_fabricating_a_viewer() {
    crate::test_process::owning_case!(
        completion_before_constructor_uses_same_held_record_without_fabricating_a_viewer
    );
    let tree = Tree::new();
    let broker = broker(&tree);
    employee(&tree);
    let provider = Provider::new(&tree);
    let reuse = reusable(&tree, &broker);
    let exit = receipt(&reuse);
    let source = reuse.inspected.observed.current.configuration().clone();
    let owner = reuse.prepare_viewer().unwrap().close_allocation().unwrap();
    enable(&tree, provider.child.id());
    fs::create_dir_all(exit.parent().unwrap()).unwrap();
    fs::write(exit, b"0").unwrap();
    assert!(owner.finalize_for_worker().unwrap().completed());
    assert!(!tree.root.join("viewer-ready").exists());
    reverie_host::worker_storage::StorageLease::acquire_migration(
        &source,
        &ProfileSessionId::parse(SID).unwrap(),
    )
    .unwrap()
    .close()
    .unwrap();
    broker.close_command_telemetry(end()).unwrap();
}
#[test]
fn known_preconstructor_body_refusal_still_finishes_cleanup_and_reports_original_primary() {
    crate::test_process::owning_case!(
        known_preconstructor_body_refusal_still_finishes_cleanup_and_reports_original_primary
    );
    let tree = Tree::new();
    let broker = broker(&tree);
    employee(&tree);
    let provider = Provider::new(&tree);
    let reuse = reusable(&tree, &broker);
    let owner = reuse.prepare_viewer().unwrap().close_allocation().unwrap();
    enable(&tree, provider.child.id());
    let failure = owner
        .start(Instant::now() - Duration::from_millis(1))
        .err()
        .unwrap();
    let closed = (*failure).finalize_for_worker().unwrap();
    assert!(closed.primary_error().is_some());
    assert!(closed.storage_retained());
    assert!(!tree.root.join("viewer-ready").exists());
    broker.close_command_telemetry(end()).unwrap();
}
#[test]
fn failed_optional_inspect_and_live_census_retains_real_lease_and_hold_after_viewer_cleanup() {
    crate::test_process::owning_case!(
        failed_optional_inspect_and_live_census_retains_real_lease_and_hold_after_viewer_cleanup
    );
    let tree = Tree::new();
    let broker = broker(&tree);
    employee(&tree);
    let provider = Provider::new(&tree);
    let reuse = reusable(&tree, &broker);
    let exit = receipt(&reuse);
    let source = reuse.inspected.observed.current.configuration().clone();
    let viewing = reuse
        .prepare_viewer()
        .unwrap()
        .close_allocation()
        .unwrap()
        .start(end())
        .unwrap();
    wait_file(&tree.root.join("viewer-ready"));
    enable(&tree, provider.child.id());
    fs::create_dir_all(exit.parent().unwrap()).unwrap();
    fs::write(exit, b"0").unwrap();
    tree.write("finalizer-inspect-error", b"unknown optional inspect");
    let failure = viewing.finalize_for_worker().err().unwrap();
    assert!(failure.cleanup_error_count() > 0);
    assert!(!tree.root.join("stopped-provider").exists());
    assert!(
        reverie_host::worker_storage::StorageLease::acquire_migration(
            &source,
            &ProfileSessionId::parse(SID).unwrap()
        )
        .is_err()
    );
    assert!(broker.close_command_telemetry(end()).is_err());
    drop(failure);
}
#[test]
fn preexisting_same_identity_claim_cannot_release_box_during_real_finalizing_phase() {
    crate::test_process::owning_case!(
        preexisting_same_identity_claim_cannot_release_box_during_real_finalizing_phase
    );
    let tree = Tree::new();
    let broker = broker(&tree);
    employee(&tree);
    let provider = Provider::new(&tree);
    let reuse = reusable(&tree, &broker);
    let source = reuse.inspected.observed.current.configuration().clone();
    let sid = ProfileSessionId::parse(SID).unwrap();
    let alias = broker.claim_storage(&sid).unwrap();
    let owner = reuse.prepare_viewer().unwrap().close_allocation().unwrap();
    enable(&tree, provider.child.id());
    owner.retained.native.close(end()).unwrap();
    {
        let mut life = broker.installed.lifecycle().unwrap();
        life.finalize_active(owner.retained.scope.active.as_ref().unwrap())
            .unwrap();
    }
    let observation = owner.retained.native.observe_final_storage().unwrap();
    assert!(observation.is_live());
    let RetainedReuse { mut scope, native } = owner.retained;
    let returned = native
        .reclaim_final_storage(&observation)
        .unwrap_or_else(|failure| {
            let (_, error) = (*failure).into_parts();
            panic!("actual finalization reclaim: {error}")
        });
    let denied = alias.release(end()).err().unwrap();
    assert_eq!(denied.cause().code(), "WORKER_STORAGE_FINALIZATION_HELD");
    assert!(broker.claim_storage(&sid).is_err());
    assert!(reverie_host::worker_storage::StorageLease::acquire_migration(&source, &sid).is_err());
    assert!(
        returned
            .finish_storage(end())
            .unwrap_or_else(|_| panic!("same actual branded finalizer"))
    );
    scope.preparing.admitted.request.close(end()).unwrap();
    scope
        .active
        .as_mut()
        .unwrap()
        .release_handler_hold(end())
        .unwrap();
    drop(scope);
    broker.close_command_telemetry(end()).unwrap();
}

#[test]
fn malformed_receipt_relay_error_still_runs_actual_completed_cleanup_without_sending_x() {
    crate::test_process::owning_case!(
        malformed_receipt_relay_error_still_runs_actual_completed_cleanup_without_sending_x
    );
    use std::io::Read;
    for bytes in [b"not-an-integer".as_slice(), b"1\xff".as_slice()] {
        let tree = Tree::new();
        let broker = broker(&tree);
        employee(&tree);
        let provider = Provider::new(&tree);
        let (mut client, inspected) =
            super::super::super::tests::inspection_with_client(&tree, &broker, None, false);
        tree.write("pane.out", b"0\n");
        let ClassifiedWorkerLaunch::Reuse(reuse) = inspected.classify_existing().unwrap() else {
            panic!("actual reuse");
        };
        let exit = receipt(&reuse);
        let source = reuse.inspected.observed.current.configuration().clone();
        let viewing = reuse
            .prepare_viewer()
            .unwrap()
            .close_allocation()
            .unwrap()
            .start(end())
            .unwrap();
        wait_file(&tree.root.join("viewer-ready"));
        enable(&tree, provider.child.id());
        fs::create_dir_all(exit.parent().unwrap()).unwrap();
        fs::write(exit, bytes).unwrap();
        let (viewing, outcome) = viewing.relay().into_parts();
        assert!(outcome.is_err(), "actual malformed receipt must fail relay");
        client
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut raw = [0; 5];
        client.read_exact(&mut raw).unwrap();
        let header = reverie_core::worker_wire::WorkerFrameHeader::decode(raw);
        assert_eq!(header.kind(), b'E');
        let mut error = vec![0; header.payload_length() as usize];
        client.read_exact(&mut error).unwrap();
        let closed = viewing.finalize_for_worker().unwrap();
        assert!(closed.completed());
        assert!(!closed.storage_retained());
        assert_eq!(client.read(&mut raw).unwrap(), 0, "no X after relay error");
        assert!(tree.root.join("stop-before-viewer-reap").is_file());
        assert!(tree.root.join("provider-exited").is_file());
        reverie_host::worker_storage::StorageLease::acquire_migration(
            &source,
            &ProfileSessionId::parse(SID).unwrap(),
        )
        .unwrap()
        .close()
        .unwrap();
        broker.close_command_telemetry(end()).unwrap();
    }
}

#[test]
fn bounded_finalizer_refuses_contended_lifecycle_without_waiting_for_its_later_release() {
    crate::test_process::owning_case!(
        bounded_finalizer_refuses_contended_lifecycle_without_waiting_for_its_later_release
    );
    let tree = Tree::new();
    let broker = broker(&tree);
    employee(&tree);
    let provider = Provider::new(&tree);
    let reuse = reusable(&tree, &broker);
    let source = reuse.inspected.observed.current.configuration().clone();
    let owner = reuse.prepare_viewer().unwrap().close_allocation().unwrap();
    enable(&tree, provider.child.id());
    let installed = broker.installed.clone();
    let (ready, acquired) = std::sync::mpsc::sync_channel(1);
    let (release, resume) = std::sync::mpsc::sync_channel(1);
    let (result, released_by_caller) = std::thread::scope(|scope| {
        let holder = scope.spawn(move || {
            let _lifecycle = installed.lifecycle().unwrap();
            ready.send(()).unwrap();
            // A real old blocking implementation eventually returns, so a
            // failed discriminator cannot leave an owned test thread hanging.
            resume.recv_timeout(Duration::from_secs(5)).is_ok()
        });
        acquired.recv_timeout(Duration::from_secs(5)).unwrap();
        let result = owner.finalize(Instant::now() + Duration::from_millis(50));
        let _sent = release.send(());
        (result, holder.join().unwrap())
    });
    assert!(
        released_by_caller,
        "finalizer must return before the owned lock's fallback release"
    );
    let failure = result.expect_err("actual component lifecycle ceiling must refuse");
    assert!(failure.cleanup_error_count() > 0);
    assert!(
        reverie_host::worker_storage::StorageLease::acquire_migration(
            &source,
            &ProfileSessionId::parse(SID).unwrap(),
        )
        .is_err()
    );
    assert!(broker.close_command_telemetry(end()).is_err());
    drop(failure);
}
