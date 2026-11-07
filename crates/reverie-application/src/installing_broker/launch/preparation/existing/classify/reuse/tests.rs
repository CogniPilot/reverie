//! These are real J/classification/resource transfers. Teardown is explicitly
//! synthetic and does not stand in for a production stopped-laptop contract.
use super::super::super::super::tests::{end, finish_claimed};
use super::super::tests::{SID, broker, inspection};
use super::*;
use crate::reservation_gate::tests::Tree;

fn reusable<'a>(tree: &Tree, broker: &'a InstallingBroker) -> ReusableWorkerLaunch<'a> {
    let inspected = inspection(tree, broker, None, false);
    tree.write("pane.out", b"0\n");
    let ClassifiedWorkerLaunch::Reuse(reuse) = inspected.classify_existing().unwrap() else {
        panic!("actual live pane")
    };
    reuse
}
fn finish(restored: RestoredReuse<'_>) {
    let RestoredReuse { scope, returned } = restored;
    let claim = returned.fixture_claim();
    let broker = scope.preparing.broker();
    let claimed = ClaimedWorkerLaunch {
        preparing: scope.preparing,
        observed: scope.observed,
        storage: Some(claim),
        active: scope.active,
        lifecycle: broker.installed.lifecycle().unwrap(),
    };
    finish_claimed(claimed);
}
#[test]
fn actual_legacy_reuse_moves_same_scope_without_nix_office_and_restores_before_fixture_release() {
    crate::test_process::owning_case!(
        actual_legacy_reuse_moves_same_scope_without_nix_office_and_restores_before_fixture_release
    );
    let tree = Tree::new();
    let broker = broker(&tree);
    let reuse = reusable(&tree, &broker);
    let connection = reuse
        .inspected
        .observed
        .claimed
        .preparing
        .admitted
        .request
        .connection
        .clone();
    let prepared = reuse.prepare_viewer().unwrap();
    assert!(
        broker.installed.laptops.try_lock().is_err(),
        "actual original lifecycle still held"
    );
    let owner = prepared.close_allocation().unwrap();
    assert!(broker.installed.laptops.try_lock().is_ok());
    assert!(Arc::ptr_eq(
        &owner.retained.scope.preparing.admitted.request.connection,
        &connection
    ));
    let restored = owner.close_native_component(end()).unwrap();
    assert_eq!(restored.request().session().as_str(), SID);
    assert!(
        restored.scope.active.is_some(),
        "native restoration never removes active/Hold"
    );
    assert!(connection.assert_open(&broker.storage.runtime).is_ok());
    let trace = std::fs::read_to_string(tree.root.join("calls.txt")).unwrap();
    assert!(!trace.lines().any(|v| {
        ["create\0", "network\0", "start\0", "image\0"]
            .iter()
            .any(|prefix| v.starts_with(prefix))
    }));
    finish(restored);
    broker.close_command_telemetry(end()).unwrap();
}
#[test]
fn stopped_runtime_rejects_pure_retain_and_returns_original_classified_resource_and_scope() {
    crate::test_process::owning_case!(
        stopped_runtime_rejects_pure_retain_and_returns_original_classified_resource_and_scope
    );
    let tree = Tree::new();
    let broker = broker(&tree);
    let reuse = reusable(&tree, &broker);
    let connection = reuse
        .inspected
        .observed
        .claimed
        .preparing
        .admitted
        .request
        .connection
        .clone();
    broker.storage.runtime.request_stop();
    let failure = reuse.prepare_viewer().err().unwrap();
    assert!(failure.to_string().contains("WORKER_LAPTOP_STOPPED"));
    let FailureOwner::Classified(original) = failure.owner else {
        panic!("all original owners returned before dispatch")
    };
    assert!(original.receipt.is_some());
    assert!(original.inspected.previous.is_some());
    assert!(Arc::ptr_eq(
        &original
            .inspected
            .observed
            .claimed
            .preparing
            .admitted
            .request
            .connection,
        &connection
    ));
    assert!(original.inspected.observed.claimed.storage.is_some());
    finish_claimed(original.inspected.observed.claimed);
    broker.close_command_telemetry(end()).unwrap();
}

#[test]
fn actual_employee_viewer_and_atomic_restore_keep_running_lease_active_and_same_accepted_connection()
 {
    crate::test_process::owning_case!(actual_employee_viewer_and_atomic_restore_keep_running_lease_active_and_same_accepted_connection);
    let tree = Tree::new();
    let broker = broker(&tree);
    tree.write("company.json", &serde_json::to_vec(&serde_json::json!({"employees":[{"id":"11111111-2222-4333-8444-555555555555","owner":null,"sessionId":SID,"desiredRunning":true}]})).unwrap());
    let reuse = reusable(&tree, &broker);
    let source = reuse.inspected.observed.current.configuration().clone();
    let sid = reuse.request().session().clone();
    let connection = reuse
        .inspected
        .observed
        .claimed
        .preparing
        .admitted
        .request
        .connection
        .clone();
    let prepared = reuse.prepare_viewer().unwrap();
    assert!(
        broker.claim_storage(&sid).is_err(),
        "actual registry owns Existing, never Direct during native lifetime"
    );
    assert!(reverie_host::worker_storage::StorageLease::acquire_migration(&source, &sid).is_err());
    let viewing = prepared.close_allocation().unwrap().start(end()).unwrap();
    let until = end();
    while !tree.root.join("viewer-ready").is_file() {
        assert!(Instant::now() < until, "owned fixed child setup");
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    let runtime = &broker.storage.runtime;
    runtime
        .write_laptop_viewer(&viewing.session, b"same-job")
        .unwrap();
    let mut output = Vec::new();
    while output.len() < 8 {
        assert!(Instant::now() < until, "owned PTY output");
        let mut bytes = [0; 32];
        match runtime.read_laptop_viewer(&viewing.session, &mut bytes) {
            Ok(n) => output.extend_from_slice(&bytes[..n]),
            Err(reverie_host::worker_laptop::LaptopError::Io(e))
                if e.kind() == std::io::ErrorKind::WouldBlock =>
            {
                std::thread::sleep(std::time::Duration::from_millis(1))
            }
            other => panic!("actual viewer read: {other:?}"),
        }
    }
    assert_eq!(output, b"same-job");
    // This is an explicit lower-component test, not an integrated EOF/receipt
    // finalizer. No synthetic completed receipt authorizes a stop here.
    let restored = viewing.close_native_component(end()).unwrap();
    assert!(restored.scope.active.is_some());
    assert!(Arc::ptr_eq(
        &restored.scope.preparing.admitted.request.connection,
        &connection
    ));
    assert!(connection.assert_open(runtime).is_ok());
    assert!(
        reverie_host::worker_storage::StorageLease::acquire_migration(&source, &sid).is_err(),
        "native cleanup+restore does not release the actual running lease"
    );
    assert!(
        runtime.settle_owned(end()).is_ok(),
        "resource now belongs to actual App Direct registry, not native inventory"
    );
    let trace = std::fs::read_to_string(tree.root.join("calls.txt")).unwrap();
    assert_eq!(
        trace
            .lines()
            .filter(|line| line.contains("attach-session"))
            .count(),
        1
    );
    assert!(!trace.lines().any(|line| {
        ["create\0", "network\0", "start\0", "stop\0", "rm\0"]
            .iter()
            .any(|prefix| line.starts_with(prefix))
    }));
    finish(restored);
    reverie_host::worker_storage::StorageLease::acquire_migration(&source, &sid)
        .unwrap()
        .close()
        .unwrap();
    broker.close_command_telemetry(end()).unwrap();
}

#[test]
fn actual_installed_gate_reuse_closes_common_allocation_before_native_constructor_but_keeps_employee_hold()
 {
    crate::test_process::owning_case!(actual_installed_gate_reuse_closes_common_allocation_before_native_constructor_but_keeps_employee_hold);
    let mut tree = Tree::new();
    let mut raw: serde_json::Value = serde_json::from_slice(&tree.raw).unwrap();
    raw["budgetMode"] = serde_json::json!("admission");
    raw["memoryMiB"] = serde_json::json!(512);
    tree.raw = serde_json::to_vec(&raw).unwrap();
    tree.write("worker.json", &tree.raw);
    tree.marker(&raw);
    tree.write("company.json", &serde_json::to_vec(&serde_json::json!({"employees":[{"id":"11111111-2222-4333-8444-555555555555","owner":null,"sessionId":SID,"desiredRunning":true}]})).unwrap());
    let broker = super::super::super::super::prefix_tests::configured::configured(&tree);
    let reuse = reusable(&tree, &broker);
    assert!(
        reuse
            .inspected
            .observed
            .claimed
            .preparing
            .admitted
            .admission
            .is_some()
    );
    let source = reuse.inspected.observed.current.configuration().clone();
    let config =
        reverie_contracts::reservation_engine::ReservationConfiguration::capture(source.clone());
    let prepared = reuse.prepare_viewer().unwrap();
    let busy = reverie_host::reservation_control::AdmissionLock::acquire(&config)
        .err()
        .unwrap();
    assert_eq!(busy.code(), "RESERVATION_ADMISSION_LOCK_BUSY");
    assert!(!tree.root.join("viewer-ready").exists());
    let released = prepared.close_allocation().unwrap();
    let mut common = reverie_host::reservation_control::AdmissionLock::acquire(&config).unwrap();
    common.close().unwrap();
    let sid = released
        .retained
        .scope
        .preparing
        .admitted
        .request()
        .session();
    assert!(reverie_host::worker_storage::StorageLease::acquire_migration(&source, sid).is_err());
    assert!(released.retained.scope.active.is_some());
    assert!(broker.installed.laptops.try_lock().is_ok());
    let restored = released.close_native_component(end()).unwrap();
    assert!(
        broker.close_command_telemetry(end()).is_err(),
        "actual logical Hold remains counted after allocation/native cleanup"
    );
    finish(restored);
    broker.close_command_telemetry(end()).unwrap();
}

#[test]
fn dropped_prepared_reuse_keeps_actual_employee_box_and_same_counted_hold_through_last_broker_drop()
{
    crate::test_process::owning_case!(dropped_prepared_reuse_keeps_actual_employee_box_and_same_counted_hold_through_last_broker_drop);
    let tree = Tree::new();
    let broker = broker(&tree);
    tree.write("company.json", &serde_json::to_vec(&serde_json::json!({"employees":[{"id":"11111111-2222-4333-8444-555555555555","owner":null,"sessionId":SID,"desiredRunning":true}]})).unwrap());
    let reuse = reusable(&tree, &broker);
    let source = reuse.inspected.observed.current.configuration().clone();
    let sid = reuse.request().session().clone();
    drop(reuse.prepare_viewer().unwrap());
    assert!(broker.installed.laptops.try_lock().is_ok());
    assert!(broker.claim_storage(&sid).is_err());
    assert!(reverie_host::worker_storage::StorageLease::acquire_migration(&source, &sid).is_err());
    assert!(
        broker.close_command_telemetry(end()).is_err(),
        "physical J close cannot settle the actual held lifecycle record"
    );
    drop(broker);
    assert!(
        reverie_host::worker_storage::StorageLease::acquire_migration(&source, &sid).is_err(),
        "last broker Drop quarantines the SAME native resource and held connection owners"
    );
    // Owning subprocess death ends this negative fixture. There is deliberately
    // no production release/stop claim or positive reacquisition assertion.
}
